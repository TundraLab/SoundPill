import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {buildAccentPalette, normalizeHex, rgbToHex} from '../ui/accentColor.js';
import {LyricsClient, findActiveLineIndex} from './lyrics.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_ROOT_IFACE = 'org.mpris.MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

const POSITION_TICK_MS = 200;
const POSITION_RESYNC_MS = 2500;
const MPRIS_RECONCILE_SEC = 3;

export function formatMicroseconds(us) {
    if (!Number.isFinite(us) || us < 0)
        return '0:00';
    const totalSec = Math.floor(us / 1_000_000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;

    if (max === min)
        return {h: 0, s: 0, l};

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === rn)
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn)
        h = (bn - rn) / d + 2;
    else
        h = (rn - gn) / d + 4;

    return {h: h / 6, s, l};
}

function hueToRgb(p, q, t) {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
}

function hslToRgb(h, s, l) {
    if (s === 0) {
        const v = Math.round(l * 255);
        return {r: v, g: v, b: v};
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
        r: Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
        g: Math.round(hueToRgb(p, q, h) * 255),
        b: Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
    };
}

export function extractAccentFromImageUri(artUri) {
    if (!artUri)
        return null;

    try {
        const file = Gio.File.new_for_uri(artUri);
        const path = file.get_path();
        if (!path)
            return null;

        const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 32, 32, false);
        if (!pixbuf)
            return null;

        const pixels = pixbuf.get_pixels();
        const width = pixbuf.get_width();
        const height = pixbuf.get_height();
        const rowstride = pixbuf.get_rowstride();
        const nChannels = pixbuf.get_n_channels();
        const hasAlpha = pixbuf.get_has_alpha();

        const HUE_BINS = 24;
        const bins = Array.from({length: HUE_BINS}, () => ({weight: 0, r: 0, g: 0, b: 0}));
        let totalWeight = 0;
        let fallbackR = 0;
        let fallbackG = 0;
        let fallbackB = 0;
        let fallbackCount = 0;

        for (let y = 0; y < height; y++) {
            const rowStart = y * rowstride;
            for (let x = 0; x < width; x++) {
                const idx = rowStart + x * nChannels;
                const a = hasAlpha ? pixels[idx + 3] : 255;
                if (a < 128)
                    continue;

                const r = pixels[idx];
                const g = pixels[idx + 1];
                const b = pixels[idx + 2];
                fallbackR += r;
                fallbackG += g;
                fallbackB += b;
                fallbackCount++;

                const {h, s, l} = rgbToHsl(r, g, b);
                if (l < 0.08 || l > 0.92 || s < 0.14)
                    continue;

                const lightnessScore = Math.max(0.1, 1 - Math.abs(l - 0.52) * 1.8);
                const weight = s * lightnessScore;
                const binIdx = Math.min(HUE_BINS - 1, Math.floor(h * HUE_BINS));
                bins[binIdx].weight += weight;
                bins[binIdx].r += r * weight;
                bins[binIdx].g += g * weight;
                bins[binIdx].b += b * weight;
                totalWeight += weight;
            }
        }

        if (totalWeight <= 0) {
            if (fallbackCount === 0)
                return null;
            // Monochrome covers get a clean cool slate tint for contrast on dark glass
            return '#CBD5E1';
        }

        let bestBin = bins[0];
        for (const bin of bins) {
            if (bin.weight > bestBin.weight)
                bestBin = bin;
        }

        const avgR = bestBin.r / bestBin.weight;
        const avgG = bestBin.g / bestBin.weight;
        const avgB = bestBin.b / bestBin.weight;
        const hsl = rgbToHsl(avgR, avgG, avgB);

        // Keep adaptive accent bright and vivid enough on dark glass surfaces
        const tunedS = Math.max(0.52, Math.min(0.95, hsl.s));
        const tunedL = Math.max(0.58, Math.min(0.72, hsl.l));
        const tuned = hslToRgb(hsl.h, tunedS, tunedL);
        return rgbToHex(tuned.r, tuned.g, tuned.b);
    } catch (_e) {
        return null;
    }
}

function unpackVariant(value) {
    if (value instanceof GLib.Variant)
        return value.deep_unpack();
    return value;
}

function parseMetadata(rawMetadata) {
    const meta = unpackVariant(rawMetadata) || {};
    const titleRaw = unpackVariant(meta['xesam:title']);
    const artistRaw = unpackVariant(meta['xesam:artist']);
    const albumRaw = unpackVariant(meta['xesam:album']);
    const artUrlRaw = unpackVariant(meta['mpris:artUrl']);
    const lengthRaw = unpackVariant(meta['mpris:length']);
    const trackIdRaw = unpackVariant(meta['mpris:trackid']);

    let artist = '';
    if (Array.isArray(artistRaw))
        artist = artistRaw.filter(Boolean).join(', ');
    else if (typeof artistRaw === 'string')
        artist = artistRaw;

    const title = typeof titleRaw === 'string' ? titleRaw.trim() : '';
    const album = typeof albumRaw === 'string' ? albumRaw.trim() : '';
    const artUrl = typeof artUrlRaw === 'string' ? artUrlRaw.trim() : '';
    const lengthNum = lengthRaw !== undefined && lengthRaw !== null ? Number(lengthRaw) : 0;
    const lengthUs = Number.isFinite(lengthNum) && lengthNum > 0 ? lengthNum : 0;
    const trackId = typeof trackIdRaw === 'string' ? trackIdRaw : '';

    return {
        title,
        artist: artist.trim(),
        album,
        artUrl,
        lengthUs,
        trackId,
    };
}

class AlbumArtLoader {
    constructor() {
        this._session = new Soup.Session({
            timeout: 10,
            user_agent: 'SoundPill/1.0 (https://tundralab.com.br)',
        });
        this._cacheDir = GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            'soundpill',
        ]);
        GLib.mkdir_with_parents(this._cacheDir, 0o755);
        this._urlCache = new Map();
        this._activeCancellable = null;
        this._destroyed = false;
    }

    _cancelActive() {
        if (this._activeCancellable) {
            this._activeCancellable.cancel();
            this._activeCancellable = null;
        }
    }

    // Resolve mpris:artUrl (file://, http(s)://, or data:) to a local file:// URI
    async resolve(artUrl) {
        this._cancelActive();

        if (this._destroyed || !artUrl)
            return null;

        if (artUrl.startsWith('file://')) {
            const file = Gio.File.new_for_uri(artUrl);
            return file.query_exists(null) ? artUrl : null;
        }

        if (this._urlCache.has(artUrl)) {
            const cachedUri = this._urlCache.get(artUrl);
            if (!cachedUri)
                return null;
            const file = Gio.File.new_for_uri(cachedUri);
            if (file.query_exists(null))
                return cachedUri;
            this._urlCache.delete(artUrl);
        }

        const hash = GLib.compute_checksum_for_string(
            GLib.ChecksumType.SHA256,
            artUrl,
            -1
        ).slice(0, 20);
        const localPath = GLib.build_filenamev([this._cacheDir, `cover-${hash}.img`]);
        const localFile = Gio.File.new_for_path(localPath);
        const localUri = localFile.get_uri();

        if (localFile.query_exists(null)) {
            this._urlCache.set(artUrl, localUri);
            return localUri;
        }

        if (artUrl.startsWith('data:image/')) {
            try {
                const commaIdx = artUrl.indexOf(',');
                if (commaIdx === -1)
                    return null;
                const b64 = artUrl.slice(commaIdx + 1);
                const bytes = GLib.base64_decode(b64);
                GLib.file_set_contents(localPath, bytes);
                this._urlCache.set(artUrl, localUri);
                return localUri;
            } catch (_e) {
                return null;
            }
        }

        if (!artUrl.startsWith('http://') && !artUrl.startsWith('https://'))
            return null;

        const cancellable = new Gio.Cancellable();
        this._activeCancellable = cancellable;

        try {
            const bytes = await new Promise((resolve, reject) => {
                const msg = Soup.Message.new('GET', artUrl);
                this._session.send_and_read_async(
                    msg,
                    GLib.PRIORITY_DEFAULT,
                    cancellable,
                    (session, res) => {
                        try {
                            const data = session.send_and_read_finish(res);
                            const status = msg.get_status();
                            if (status < 200 || status >= 300) {
                                reject(new Error(`HTTP ${status}`));
                                return;
                            }
                            resolve(data);
                        } catch (err) {
                            reject(err);
                        }
                    }
                );
            });

            if (this._destroyed || cancellable.is_cancelled())
                return null;

            const rawData = bytes.get_data();
            if (!rawData || rawData.length === 0)
                return null;

            GLib.file_set_contents(localPath, rawData);
            this._urlCache.set(artUrl, localUri);
            return localUri;
        } catch (_e) {
            return null;
        } finally {
            if (this._activeCancellable === cancellable)
                this._activeCancellable = null;
        }
    }

    destroy() {
        this._destroyed = true;
        this._cancelActive();
        this._urlCache.clear();
        this._session.abort();
    }
}

class MprisMonitor {
    constructor(onChangeCallback, onPositionRefreshedCallback = null) {
        this._onChange = onChangeCallback;
        this._onPositionRefreshed = onPositionRefreshedCallback;
        this._players = new Map();
        this._activeBusName = null;
        this._cancellable = new Gio.Cancellable();
        this._nameOwnerSignalId = 0;
        this._sleepSignalId = 0;
        this._sleepResyncTimerId = 0;
        this._trackResyncTimerId = 0;
        this._reconcileTimerId = 0;
        this._destroyed = false;

        this._initWatcher();
    }

    _initWatcher() {
        this._nameOwnerSignalId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                if (this._destroyed)
                    return;
                const [name, _oldOwner, newOwner] = params.deep_unpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;

                // Recreate proxies when an existing bus name swaps owners
                if (this._players.has(name))
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            }
        );

        try {
            this._sleepSignalId = Gio.DBus.system.signal_subscribe(
                'org.freedesktop.login1',
                'org.freedesktop.login1.Manager',
                'PrepareForSleep',
                '/org/freedesktop/login1',
                null,
                Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _signal, params) => {
                    if (this._destroyed)
                        return;
                    const [goingToSleep] = params.deep_unpack();
                    if (!goingToSleep)
                        this._scheduleResumeReconcile();
                }
            );
        } catch (_e) {
            this._sleepSignalId = 0;
        }

        this._reconcileMprisNames();
        this._reconcileTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            MPRIS_RECONCILE_SEC,
            () => {
                if (this._destroyed) {
                    this._reconcileTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._reconcileMprisNames();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _scheduleResumeReconcile() {
        if (this._destroyed)
            return;
        if (this._sleepResyncTimerId) {
            GLib.Source.remove(this._sleepResyncTimerId);
            this._sleepResyncTimerId = 0;
        }
        this._sleepResyncTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            this._sleepResyncTimerId = 0;
            if (!this._destroyed)
                this._reconcileMprisNames();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reconcileMprisNames() {
        if (this._destroyed)
            return;

        Gio.DBus.session.call(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'ListNames',
            null,
            new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE,
            -1,
            this._cancellable,
            (conn, res) => {
                if (this._destroyed)
                    return;
                try {
                    const reply = conn.call_finish(res);
                    const [names] = reply.deep_unpack();
                    const activeMpris = new Set();

                    for (const name of names) {
                        if (!name.startsWith(MPRIS_PREFIX))
                            continue;
                        activeMpris.add(name);
                        if (!this._players.has(name)) {
                            this._addPlayer(name);
                        } else {
                            const entry = this._players.get(name);
                            if (entry?.playerProxy && !this._isDisplayable(entry))
                                this._refreshPlayerAll(entry);
                        }
                    }

                    for (const trackedName of [...this._players.keys()]) {
                        if (!activeMpris.has(trackedName))
                            this._removePlayer(trackedName);
                    }
                } catch (_e) {
                    // Ignore transient D-Bus lookup errors or cancellation on disable
                }
            }
        );
    }

    _refreshPlayerAll(entry) {
        if (this._destroyed || !entry?.busName || entry.cancellable.is_cancelled())
            return;

        Gio.DBus.session.call(
            entry.busName,
            MPRIS_PATH,
            'org.freedesktop.DBus.Properties',
            'GetAll',
            new GLib.Variant('(s)', [MPRIS_PLAYER_IFACE]),
            new GLib.VariantType('(a{sv})'),
            Gio.DBusCallFlags.NONE,
            -1,
            entry.cancellable,
            (conn, res) => {
                if (this._destroyed || entry.cancellable.is_cancelled())
                    return;
                try {
                    const reply = conn.call_finish(res);
                    const [props] = reply.deep_unpack();
                    const prevStatus = entry.playbackStatus;
                    const prevTitle = entry.metadata?.title || '';
                    const prevArtist = entry.metadata?.artist || '';

                    const status = unpackVariant(props.PlaybackStatus);
                    if (typeof status === 'string')
                        entry.playbackStatus = status;

                    if (props.Metadata)
                        entry.metadata = parseMetadata(props.Metadata);

                    const rate = unpackVariant(props.Rate);
                    if (typeof rate === 'number' && rate > 0)
                        entry.rate = rate;

                    const canNext = unpackVariant(props.CanGoNext);
                    if (typeof canNext === 'boolean')
                        entry.canGoNext = canNext;

                    const canPrev = unpackVariant(props.CanGoPrevious);
                    if (typeof canPrev === 'boolean')
                        entry.canGoPrevious = canPrev;

                    const canPlay = unpackVariant(props.CanPlay);
                    if (typeof canPlay === 'boolean')
                        entry.canPlay = canPlay;

                    const canPause = unpackVariant(props.CanPause);
                    if (typeof canPause === 'boolean')
                        entry.canPause = canPause;

                    const canSeek = unpackVariant(props.CanSeek);
                    if (typeof canSeek === 'boolean')
                        entry.canSeek = canSeek;

                    const trackChanged =
                        entry.metadata.title !== prevTitle ||
                        entry.metadata.artist !== prevArtist;
                    const becameDisplayable =
                        entry.playbackStatus !== prevStatus ||
                        trackChanged ||
                        this._isDisplayable(entry);

                    if (becameDisplayable) {
                        entry.lastUpdatedUs = GLib.get_monotonic_time();
                        if (trackChanged) {
                            entry.lastPositionUs = 0;
                            entry.lastPositionTimestampUs = entry.lastUpdatedUs;
                            this.refreshPosition(entry.busName);
                        }
                        this._selectBestPlayer();
                        this._emitChange(trackChanged);
                    }
                } catch (_e) {
                    // Ignore players that reject GetAll while initializing
                }
            }
        );
    }

    async _addPlayer(busName) {
        if (this._destroyed || this._players.has(busName))
            return;

        const entry = {
            busName,
            rootProxy: null,
            playerProxy: null,
            identity: busName.slice(MPRIS_PREFIX.length).split('.')[0],
            desktopEntry: '',
            canRaise: false,
            playbackStatus: 'Stopped',
            metadata: parseMetadata(null),
            canGoNext: true,
            canGoPrevious: true,
            canPlay: true,
            canPause: true,
            canSeek: true,
            rate: 1.0,
            lastPositionUs: 0,
            lastPositionTimestampUs: GLib.get_monotonic_time(),
            lastUpdatedUs: GLib.get_monotonic_time(),
            signalIds: [],
            cancellable: new Gio.Cancellable(),
        };
        this._players.set(busName, entry);

        try {
            const [rootProxy, playerProxy] = await Promise.all([
                this._createProxy(busName, MPRIS_ROOT_IFACE, entry.cancellable),
                this._createProxy(busName, MPRIS_PLAYER_IFACE, entry.cancellable),
            ]);

            if (this._destroyed || entry.cancellable.is_cancelled() || !this._players.has(busName))
                return;

            entry.rootProxy = rootProxy;
            entry.playerProxy = playerProxy;

            this._readRootProperties(entry);
            this._readPlayerProperties(entry);

            const rootPropId = rootProxy.connect('g-properties-changed', () => {
                if (this._destroyed)
                    return;
                this._readRootProperties(entry);
                this._emitChange(false);
            });
            entry.signalIds.push({proxy: rootProxy, id: rootPropId});

            const playerPropId = playerProxy.connect('g-properties-changed', (_proxy, changed) => {
                if (this._destroyed)
                    return;
                const keys = changed ? Object.keys(changed.deep_unpack()) : [];
                const prevTitle = entry.metadata?.title || '';
                const prevArtist = entry.metadata?.artist || '';
                const statusChanged = keys.includes('PlaybackStatus');
                const metaChanged = keys.includes('Metadata');

                this._readPlayerProperties(entry);
                entry.lastUpdatedUs = GLib.get_monotonic_time();

                const trackIdentityChanged = metaChanged && (
                    entry.metadata.title !== prevTitle ||
                    entry.metadata.artist !== prevArtist
                );

                if (trackIdentityChanged) {
                    entry.lastPositionUs = 0;
                    entry.lastPositionTimestampUs = GLib.get_monotonic_time();
                    this.refreshPosition(entry.busName);
                    this._scheduleTrackResync(entry.busName);
                } else if (statusChanged) {
                    this.refreshPosition(entry.busName);
                }

                this._selectBestPlayer();
                this._emitChange(trackIdentityChanged);
            });
            entry.signalIds.push({proxy: playerProxy, id: playerPropId});

            const seekId = playerProxy.connect('g-signal', (_proxy, _sender, signalName, params) => {
                if (this._destroyed || signalName !== 'Seeked')
                    return;
                const [posUs] = params.deep_unpack();
                entry.lastPositionUs = Math.max(0, Number(posUs) || 0);
                entry.lastPositionTimestampUs = GLib.get_monotonic_time();
                if (entry.busName === this._activeBusName) {
                    this._emitChange(false);
                    this._onPositionRefreshed?.();
                }
            });
            entry.signalIds.push({proxy: playerProxy, id: seekId});

            const ownerId = playerProxy.connect('notify::g-name-owner', proxy => {
                if (this._destroyed)
                    return;
                if (!proxy.g_name_owner)
                    this._removePlayer(busName);
            });
            entry.signalIds.push({proxy: playerProxy, id: ownerId});

            await this.refreshPosition(busName);
            if (!this._destroyed && !entry.cancellable.is_cancelled() && !this._isDisplayable(entry))
                this._refreshPlayerAll(entry);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`[SoundPill] Falha ao conectar player MPRIS ${busName}:`, e);
            if (this._players.get(busName) === entry)
                this._removePlayer(busName);
            return;
        }

        if (this._destroyed || entry.cancellable.is_cancelled() || !this._players.has(busName))
            return;

        this._selectBestPlayer();
        this._emitChange(true);
    }

    _createProxy(busName, ifaceName, cancellable) {
        return new Promise((resolve, reject) => {
            Gio.DBusProxy.new_for_bus(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                busName,
                MPRIS_PATH,
                ifaceName,
                cancellable,
                (_src, res) => {
                    try {
                        resolve(Gio.DBusProxy.new_for_bus_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    _readRootProperties(entry) {
        if (!entry.rootProxy)
            return;
        const identity = unpackVariant(entry.rootProxy.get_cached_property('Identity'));
        if (typeof identity === 'string' && identity.trim())
            entry.identity = identity.trim();

        const desktopEntry = unpackVariant(entry.rootProxy.get_cached_property('DesktopEntry'));
        if (typeof desktopEntry === 'string')
            entry.desktopEntry = desktopEntry.trim();

        const canRaise = unpackVariant(entry.rootProxy.get_cached_property('CanRaise'));
        if (typeof canRaise === 'boolean')
            entry.canRaise = canRaise;
    }

    _readPlayerProperties(entry) {
        if (!entry.playerProxy)
            return;

        const status = unpackVariant(entry.playerProxy.get_cached_property('PlaybackStatus'));
        if (typeof status === 'string')
            entry.playbackStatus = status;

        const meta = entry.playerProxy.get_cached_property('Metadata');
        if (meta)
            entry.metadata = parseMetadata(meta);

        const rate = unpackVariant(entry.playerProxy.get_cached_property('Rate'));
        if (typeof rate === 'number' && rate > 0)
            entry.rate = rate;

        const canNext = unpackVariant(entry.playerProxy.get_cached_property('CanGoNext'));
        if (typeof canNext === 'boolean')
            entry.canGoNext = canNext;

        const canPrev = unpackVariant(entry.playerProxy.get_cached_property('CanGoPrevious'));
        if (typeof canPrev === 'boolean')
            entry.canGoPrevious = canPrev;

        const canPlay = unpackVariant(entry.playerProxy.get_cached_property('CanPlay'));
        if (typeof canPlay === 'boolean')
            entry.canPlay = canPlay;

        const canPause = unpackVariant(entry.playerProxy.get_cached_property('CanPause'));
        if (typeof canPause === 'boolean')
            entry.canPause = canPause;

        const canSeek = unpackVariant(entry.playerProxy.get_cached_property('CanSeek'));
        if (typeof canSeek === 'boolean')
            entry.canSeek = canSeek;
    }

    _scheduleTrackResync(busName) {
        if (this._trackResyncTimerId) {
            GLib.Source.remove(this._trackResyncTimerId);
            this._trackResyncTimerId = 0;
        }
        this._trackResyncTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 450, () => {
            this._trackResyncTimerId = 0;
            if (!this._destroyed && busName)
                this.refreshPosition(busName);
            return GLib.SOURCE_REMOVE;
        });
    }

    async refreshPosition(busName = this._activeBusName) {
        if (this._destroyed || !busName)
            return;
        const entry = this._players.get(busName);
        if (!entry || !entry.playerProxy)
            return;

        try {
            const reply = await new Promise((resolve, reject) => {
                Gio.DBus.session.call(
                    busName,
                    MPRIS_PATH,
                    'org.freedesktop.DBus.Properties',
                    'Get',
                    new GLib.Variant('(ss)', [MPRIS_PLAYER_IFACE, 'Position']),
                    new GLib.VariantType('(v)'),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    entry.cancellable,
                    (conn, res) => {
                        try {
                            resolve(conn.call_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            if (this._destroyed || entry.cancellable.is_cancelled())
                return;

            const [variantVal] = reply.deep_unpack();
            const posUs = Number(unpackVariant(variantVal));
            if (Number.isFinite(posUs)) {
                entry.lastPositionUs = Math.max(0, posUs);
                entry.lastPositionTimestampUs = GLib.get_monotonic_time();
                if (busName === this._activeBusName)
                    this._onPositionRefreshed?.();
            }
        } catch (_e) {
            // Some players do not expose Position while idle
        }
    }

    _removePlayer(busName) {
        const entry = this._players.get(busName);
        if (!entry)
            return;

        entry.cancellable.cancel();
        for (const item of entry.signalIds) {
            if (item.proxy && item.id) {
                try {
                    item.proxy.disconnect(item.id);
                } catch (_e) {
                    // Proxy may already be disposed
                }
            }
        }
        entry.signalIds = [];
        this._players.delete(busName);

        if (this._activeBusName === busName)
            this._activeBusName = null;

        this._selectBestPlayer();
        this._emitChange(true);
    }

    _isDisplayable(entry) {
        if (!entry || !entry.playerProxy)
            return false;
        const hasTitle = Boolean(entry.metadata?.title);
        return entry.playbackStatus === 'Playing' ||
            entry.playbackStatus === 'Paused' ||
            hasTitle;
    }

    _selectBestPlayer() {
        const candidates = [...this._players.values()].filter(e => this._isDisplayable(e));
        if (candidates.length === 0) {
            this._activeBusName = null;
            return;
        }

        const current = this._activeBusName ? this._players.get(this._activeBusName) : null;
        if (current && this._isDisplayable(current) && current.playbackStatus === 'Playing')
            return;

        const playing = candidates.filter(c => c.playbackStatus === 'Playing');
        const pool = playing.length > 0 ? playing : candidates;
        pool.sort((a, b) => b.lastUpdatedUs - a.lastUpdatedUs);
        this._activeBusName = pool[0].busName;
    }

    getActivePlayer() {
        if (!this._activeBusName)
            return null;
        return this._players.get(this._activeBusName) || null;
    }

    getEstimatedPositionUs() {
        const player = this.getActivePlayer();
        if (!player)
            return 0;

        if (player.playbackStatus !== 'Playing')
            return player.lastPositionUs;

        const elapsedUs = Math.max(0, GLib.get_monotonic_time() - player.lastPositionTimestampUs);
        const estimated = player.lastPositionUs + elapsedUs * (player.rate || 1.0);
        if (player.metadata.lengthUs > 0)
            return Math.min(estimated, player.metadata.lengthUs);
        return estimated;
    }

    callPlayerMethod(methodName) {
        const player = this.getActivePlayer();
        if (!player?.playerProxy)
            return;

        player.playerProxy.call(
            methodName,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (proxy, res) => {
                try {
                    proxy.call_finish(res);
                } catch (_e) {
                    // Ignore transient D-Bus method errors
                }
            }
        );
    }

    _callSeekOffset(player, offsetUs) {
        if (!player?.playerProxy || !Number.isFinite(offsetUs))
            return;

        player.playerProxy.call(
            'Seek',
            new GLib.Variant('(x)', [Math.round(offsetUs)]),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (proxy, res) => {
                try {
                    proxy.call_finish(res);
                    this.refreshPosition(player.busName);
                } catch (_e) {
                    // Ignore if player rejects Seek
                }
            }
        );
    }

    seekToPositionUs(targetUs) {
        const player = this.getActivePlayer();
        if (!player?.playerProxy || !player.canSeek)
            return false;

        const lengthUs = player.metadata.lengthUs;
        if (lengthUs <= 0)
            return false;

        const prevPosUs = this.getEstimatedPositionUs();
        const clampedUs = Math.round(Math.max(0, Math.min(lengthUs, targetUs)));
        const deltaUs = clampedUs - prevPosUs;

        player.lastPositionUs = clampedUs;
        player.lastPositionTimestampUs = GLib.get_monotonic_time();

        const trackId = player.metadata.trackId;
        if (trackId?.startsWith('/')) {
            player.playerProxy.call(
                'SetPosition',
                new GLib.Variant('(ox)', [trackId, clampedUs]),
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (proxy, res) => {
                    try {
                        proxy.call_finish(res);
                        this.refreshPosition(player.busName);
                    } catch (_e) {
                        // Fall back to relative Seek for players that reject SetPosition
                        this._callSeekOffset(player, deltaUs);
                    }
                }
            );
        } else {
            this._callSeekOffset(player, deltaUs);
        }
        return true;
    }

    seekToFraction(fraction) {
        const player = this.getActivePlayer();
        if (!player?.playerProxy || !player.canSeek)
            return false;

        const lengthUs = player.metadata.lengthUs;
        if (lengthUs <= 0)
            return false;

        const clamped = Math.max(0, Math.min(1, fraction));
        return this.seekToPositionUs(clamped * lengthUs);
    }

    seekByOffsetUs(offsetUs) {
        const player = this.getActivePlayer();
        if (!player?.playerProxy || !player.canSeek)
            return false;

        const lengthUs = player.metadata.lengthUs;
        if (lengthUs <= 0)
            return false;

        const currentUs = this.getEstimatedPositionUs();
        return this.seekToPositionUs(currentUs + offsetUs);
    }

    _scoreAppMatch(app, desktopEntry, busPlayer, identity) {
        const appId = (app.get_id() || '').toLowerCase().replace(/\.desktop$/, '');
        const appName = (app.get_name() || '').toLowerCase();
        if (desktopEntry && appId === desktopEntry)
            return 100;
        if (busPlayer && appId === busPlayer)
            return 85;
        if (desktopEntry && (appId.endsWith(`.${desktopEntry}`) || desktopEntry.endsWith(`.${appId}`)))
            return 80;
        if (busPlayer && appId.endsWith(`.${busPlayer}`))
            return 75;
        if (identity && appName === identity)
            return 70;
        if (desktopEntry && (appId.includes(desktopEntry) || appName.includes(desktopEntry)))
            return 60;
        if (busPlayer && (appId.includes(busPlayer) || appName.includes(busPlayer)))
            return 55;
        if (identity && (appName.includes(identity) || identity.includes(appName)))
            return 50;
        return 0;
    }

    _windowMatchesPlayer(win, desktopEntry, busPlayer, identity) {
        const wmClass = (win.get_wm_class() || '').toLowerCase();
        const wmInstance = (win.get_wm_class_instance() || '').toLowerCase();
        const gtkAppId = (win.get_gtk_application_id?.() || '').toLowerCase().replace(/\.desktop$/, '');
        const tokens = [desktopEntry, busPlayer, identity].filter(t => t && t.length >= 2);
        return tokens.some(tok =>
            wmClass.includes(tok) ||
            wmInstance.includes(tok) ||
            gtkAppId.includes(tok)
        );
    }

    activateActivePlayer() {
        const player = this.getActivePlayer();
        if (!player)
            return false;

        const busPlayer = player.busName.slice(MPRIS_PREFIX.length).split('.')[0].toLowerCase();
        const desktopEntry = (player.desktopEntry || '').trim().toLowerCase().replace(/\.desktop$/, '');
        const identity = (player.identity || '').trim().toLowerCase();
        const trackTitle = (player.metadata?.title || '').trim().toLowerCase();

        const runningApps = Shell.AppSystem.get_default().get_running();
        const scoredApps = runningApps
            .map(app => ({
                app,
                score: this._scoreAppMatch(app, desktopEntry, busPlayer, identity),
            }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score);

        let candidateWindows = [];
        for (const item of scoredApps) {
            for (const win of item.app.get_windows()) {
                if (win.window_type !== Meta.WindowType.DESKTOP)
                    candidateWindows.push(win);
            }
        }

        if (candidateWindows.length === 0) {
            const allWindows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
            candidateWindows = allWindows.filter(win =>
                this._windowMatchesPlayer(win, desktopEntry, busPlayer, identity)
            );
        }

        if (candidateWindows.length > 0) {
            let targetWin = null;
            if (trackTitle.length >= 3) {
                targetWin = candidateWindows.find(win =>
                    (win.get_title() || '').toLowerCase().includes(trackTitle)
                );
            }
            if (!targetWin)
                targetWin = candidateWindows[0];

            Main.activateWindow(targetWin);
            return true;
        }

        if (player.canRaise && player.rootProxy) {
            player.rootProxy.call(
                'Raise',
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (proxy, res) => {
                    try {
                        proxy.call_finish(res);
                    } catch (_e) {
                        // Ignore Raise errors on players that reject background activation
                    }
                }
            );
            return true;
        }

        if (scoredApps.length > 0) {
            scoredApps[0].app.activate();
            return true;
        }

        return false;
    }

    _emitChange(trackOrPlayerChanged) {
        if (!this._destroyed)
            this._onChange(trackOrPlayerChanged);
    }

    destroy() {
        this._destroyed = true;
        if (this._trackResyncTimerId) {
            GLib.Source.remove(this._trackResyncTimerId);
            this._trackResyncTimerId = 0;
        }
        if (this._sleepResyncTimerId) {
            GLib.Source.remove(this._sleepResyncTimerId);
            this._sleepResyncTimerId = 0;
        }
        if (this._reconcileTimerId) {
            GLib.Source.remove(this._reconcileTimerId);
            this._reconcileTimerId = 0;
        }
        this._cancellable.cancel();
        if (this._nameOwnerSignalId) {
            try {
                Gio.DBus.session.signal_unsubscribe(this._nameOwnerSignalId);
            } catch (_e) {
                // Ignore if bus already closed
            }
            this._nameOwnerSignalId = 0;
        }
        if (this._sleepSignalId) {
            try {
                Gio.DBus.system.signal_unsubscribe(this._sleepSignalId);
            } catch (_e) {
                // Ignore if bus already closed
            }
            this._sleepSignalId = 0;
        }

        for (const entry of this._players.values()) {
            entry.cancellable.cancel();
            for (const item of entry.signalIds) {
                if (item.proxy && item.id) {
                    try {
                        item.proxy.disconnect(item.id);
                    } catch (_e) {
                        // Proxy may already be disposed
                    }
                }
            }
            entry.signalIds = [];
        }
        this._players.clear();
        this._activeBusName = null;
    }
}

export class TundraMediaController {
    constructor(settings) {
        this._settings = settings;
        this._destroyed = false;
        this._listeners = new Set();

        this._enableLyricsFetch = settings.get_boolean('enable-lyrics-fetch');
        this._enableAlbumArt = settings.get_boolean('enable-album-art');
        this._accentFromMusic = settings.get_boolean('accent-from-music');
        this._presetAccentColor = normalizeHex(settings.get_string('accent-color'));
        this._extractedAccentHex = null;
        this._currentAccentHex = this._presetAccentColor;
        this._currentAccentPalette = buildAccentPalette(this._currentAccentHex);
        this._accentCache = new Map();

        this._currentArtUrl = '';
        this._currentArtUri = null;
        this._currentTrackKey = '';
        this._lyricsData = {
            syncedLines: [],
            plainLines: [],
            instrumental: false,
            found: false,
        };
        this._lyricsLoading = false;
        this._activeLyricIndex = -1;
        this._lyricsCancellable = null;
        this._positionTickId = 0;
        this._positionResyncId = 0;

        this._lyricsClient = new LyricsClient();
        this._artLoader = new AlbumArtLoader();
        this._mpris = new MprisMonitor(
            trackChanged => {
                this._syncFromMpris(trackChanged);
            },
            () => {
                this._emitPositionUpdate();
            }
        );

        this._settingsId = this._settings.connect('changed', (_s, key) => {
            if (this._destroyed)
                return;

            if (key === 'enable-lyrics-fetch') {
                this._enableLyricsFetch = this._settings.get_boolean('enable-lyrics-fetch');
                const player = this._mpris.getActivePlayer();
                if (player) {
                    const durationSec = (player.metadata.lengthUs || 0) / 1_000_000;
                    this._fetchLyricsForTrack(player.metadata.artist, player.metadata.title, durationSec);
                } else {
                    this._notify('lyrics');
                }
            } else if (key === 'enable-album-art') {
                this._enableAlbumArt = this._settings.get_boolean('enable-album-art');
                const player = this._mpris.getActivePlayer();
                if (player && this._enableAlbumArt) {
                    this._loadAlbumArt(this._currentArtUrl);
                } else {
                    this._currentArtUri = null;
                    this._extractedAccentHex = null;
                    this._notify('art');
                    this._refreshEffectiveAccent();
                }
            } else if (key === 'accent-color') {
                this._presetAccentColor = normalizeHex(this._settings.get_string('accent-color'));
                this._refreshEffectiveAccent();
            } else if (key === 'accent-from-music') {
                this._accentFromMusic = this._settings.get_boolean('accent-from-music');
                if (this._accentFromMusic && this._currentArtUri)
                    this._extractedAccentHex = this._resolveAccentForUri(this._currentArtUri);
                this._refreshEffectiveAccent();
            }
        });
    }

    _resolveAccentForUri(artUri) {
        if (!artUri)
            return null;
        if (this._accentCache.has(artUri))
            return this._accentCache.get(artUri);

        const extracted = extractAccentFromImageUri(artUri);
        if (this._accentCache.size >= 64) {
            const oldestKey = this._accentCache.keys().next().value;
            if (oldestKey !== undefined)
                this._accentCache.delete(oldestKey);
        }
        this._accentCache.set(artUri, extracted);
        return extracted;
    }

    _refreshEffectiveAccent() {
        const nextHex = this._accentFromMusic && this._extractedAccentHex
            ? this._extractedAccentHex
            : this._presetAccentColor;
        if (nextHex === this._currentAccentHex)
            return;

        this._currentAccentHex = nextHex;
        this._currentAccentPalette = buildAccentPalette(nextHex);
        this._notify('accent');
    }

    getAccentPalette() {
        return this._currentAccentPalette;
    }

    addListener(listener) {
        this._listeners.add(listener);
    }

    removeListener(listener) {
        this._listeners.delete(listener);
    }

    _notify(eventType, payload = null) {
        if (this._destroyed)
            return;
        for (const listener of this._listeners) {
            if (eventType === 'media')
                listener.onMediaChanged?.();
            else if (eventType === 'art')
                listener.onArtChanged?.();
            else if (eventType === 'lyrics')
                listener.onLyricsChanged?.();
            else if (eventType === 'position')
                listener.onPositionChanged?.(payload);
            else if (eventType === 'accent')
                listener.onAccentChanged?.();
        }
    }

    getState() {
        const player = this._mpris.getActivePlayer();
        const posUs = this._mpris.getEstimatedPositionUs();
        const lengthUs = player?.metadata?.lengthUs || 0;
        return {
            player,
            posUs,
            lengthUs,
            artUri: this._currentArtUri,
            accentHex: this._currentAccentHex,
            accentPalette: this._currentAccentPalette,
            lyricsData: this._lyricsData,
            lyricsLoading: this._lyricsLoading,
            lyricsFetchEnabled: this._enableLyricsFetch,
            activeLyricIndex: this._activeLyricIndex,
        };
    }

    refreshPosition() {
        return this._mpris.refreshPosition();
    }

    callPlayerMethod(methodName) {
        this._mpris.callPlayerMethod(methodName);
    }

    activateActivePlayer() {
        return this._mpris.activateActivePlayer();
    }

    seekToFraction(fraction) {
        if (!this._mpris.seekToFraction(fraction))
            return;
        this._emitPositionUpdate();
    }

    seekByOffsetSeconds(deltaSec) {
        if (!this._mpris.seekByOffsetUs(deltaSec * 1_000_000))
            return;
        this._emitPositionUpdate();
    }

    _syncFromMpris(trackChanged) {
        if (this._destroyed)
            return;

        const player = this._mpris.getActivePlayer();
        if (!player) {
            if (this._lyricsCancellable) {
                this._lyricsCancellable.cancel();
                this._lyricsCancellable = null;
            }
            this._stopPositionTimers();
            this._currentTrackKey = '';
            this._currentArtUrl = '';
            this._currentArtUri = null;
            this._extractedAccentHex = null;
            this._activeLyricIndex = -1;
            this._lyricsLoading = false;
            this._lyricsData = {
                syncedLines: [],
                plainLines: [],
                instrumental: false,
                found: false,
            };
            this._notify('media');
            this._refreshEffectiveAccent();
            return;
        }

        const isPlaying = player.playbackStatus === 'Playing';
        if (isPlaying)
            this._startPositionTimers();
        else
            this._stopPositionTimers();

        const {title, artist, artUrl} = player.metadata;
        if (artUrl !== this._currentArtUrl) {
            this._currentArtUrl = artUrl;
            if (this._enableAlbumArt) {
                this._loadAlbumArt(artUrl);
            } else {
                this._currentArtUri = null;
                this._extractedAccentHex = null;
                this._notify('art');
                this._refreshEffectiveAccent();
            }
        }

        const trackKey = `${artist}::${title}`;
        const durationSec = (player.metadata.lengthUs || 0) / 1_000_000;
        if (trackKey !== this._currentTrackKey || (trackChanged && !this._lyricsData.found && !this._lyricsLoading)) {
            this._currentTrackKey = trackKey;
            this._activeLyricIndex = -1;
            this._fetchLyricsForTrack(artist, title, durationSec);
        }

        this._updateActiveLyricIndex();
        this._notify('media');
    }

    async _loadAlbumArt(artUrl) {
        this._currentArtUri = null;
        this._extractedAccentHex = null;
        this._notify('art');
        this._refreshEffectiveAccent();
        if (!artUrl)
            return;

        const localUri = await this._artLoader.resolve(artUrl);
        if (this._destroyed || this._currentArtUrl !== artUrl || !this._enableAlbumArt)
            return;

        this._currentArtUri = localUri;
        if (this._accentFromMusic && localUri)
            this._extractedAccentHex = this._resolveAccentForUri(localUri);
        this._notify('art');
        this._refreshEffectiveAccent();
    }

    async _fetchLyricsForTrack(artist, title, durationSec = 0) {
        if (this._lyricsCancellable) {
            this._lyricsCancellable.cancel();
            this._lyricsCancellable = null;
        }

        this._lyricsData = {
            syncedLines: [],
            plainLines: [],
            instrumental: false,
            found: false,
        };
        this._activeLyricIndex = -1;

        if (!this._enableLyricsFetch || !title) {
            this._lyricsLoading = false;
            this._notify('lyrics');
            return;
        }

        const cancellable = new Gio.Cancellable();
        this._lyricsCancellable = cancellable;
        this._lyricsLoading = true;
        this._notify('lyrics');

        const expectedKey = `${artist}::${title}`;
        const result = await this._lyricsClient.getLyrics(artist, title, durationSec, cancellable);

        if (this._destroyed || cancellable.is_cancelled() || this._currentTrackKey !== expectedKey)
            return;

        this._lyricsLoading = false;
        this._lyricsData = result;
        this._updateActiveLyricIndex();
        this._notify('lyrics');
    }

    _updateActiveLyricIndex() {
        const {syncedLines} = this._lyricsData;
        if (syncedLines.length === 0) {
            const changed = this._activeLyricIndex !== -1;
            this._activeLyricIndex = -1;
            return changed;
        }

        const posUs = this._mpris.getEstimatedPositionUs();
        const newIdx = findActiveLineIndex(syncedLines, posUs);
        const changed = newIdx !== this._activeLyricIndex;
        this._activeLyricIndex = newIdx;
        return changed;
    }

    _emitPositionUpdate() {
        const player = this._mpris.getActivePlayer();
        if (!player)
            return;
        const posUs = this._mpris.getEstimatedPositionUs();
        const lengthUs = player.metadata.lengthUs || 0;
        const lyricChanged = this._updateActiveLyricIndex();
        this._notify('position', {
            posUs,
            lengthUs,
            activeLyricIndex: this._activeLyricIndex,
            lyricChanged,
        });
    }

    _startPositionTimers() {
        if (!this._positionTickId) {
            this._positionTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POSITION_TICK_MS, () => {
                if (this._destroyed) {
                    this._positionTickId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._emitPositionUpdate();
                return GLib.SOURCE_CONTINUE;
            });
        }

        if (!this._positionResyncId) {
            this._positionResyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POSITION_RESYNC_MS, () => {
                if (this._destroyed) {
                    this._positionResyncId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._mpris.refreshPosition();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _stopPositionTimers() {
        if (this._positionTickId) {
            GLib.Source.remove(this._positionTickId);
            this._positionTickId = 0;
        }
        if (this._positionResyncId) {
            GLib.Source.remove(this._positionResyncId);
            this._positionResyncId = 0;
        }
    }

    destroy() {
        this._destroyed = true;
        if (this._settings && this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        if (this._lyricsCancellable) {
            this._lyricsCancellable.cancel();
            this._lyricsCancellable = null;
        }
        this._stopPositionTimers();
        this._listeners.clear();
        this._accentCache.clear();
        this._mpris?.destroy();
        this._lyricsClient?.destroy();
        this._artLoader?.destroy();
        this._settings = null;
    }
}
