import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const LRCLIB_GET_URL = 'https://lrclib.net/api/get';
const LRCLIB_SEARCH_URL = 'https://lrclib.net/api/search';
const MAX_CACHE_ENTRIES = 100;

function parseFractionToMillis(frac) {
    if (!frac)
        return 0;
    if (frac.length === 1)
        return Number.parseInt(frac, 10) * 100;
    if (frac.length === 2)
        return Number.parseInt(frac, 10) * 10;
    return Number.parseInt(frac.slice(0, 3), 10);
}

// Parse LRC lyrics ([mm:ss.xx] or [hh:mm:ss.xx]) into a list sorted by timestamp in microseconds
export function parseLrc(syncedLyrics) {
    if (!syncedLyrics || typeof syncedLyrics !== 'string')
        return [];

    const lines = [];
    let offsetMs = 0;
    const rawLines = syncedLyrics.split(/\r?\n/);

    for (const rawLine of rawLines) {
        const offsetMatch = rawLine.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
        if (offsetMatch) {
            offsetMs = Number.parseInt(offsetMatch[1], 10) || 0;
            continue;
        }

        // Skip LRC metadata headers ([ar:...], [ti:...], etc.)
        if (/^\[[a-zA-Z]{2,}:[^\]]*\]$/.test(rawLine.trim()))
            continue;

        const tagRegex = /\[\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.:,](\d{1,3}))?\s*\]/g;
        const timestamps = [];
        let lastIndex = 0;
        let match;

        while ((match = tagRegex.exec(rawLine)) !== null) {
            const hours = match[1] !== undefined ? Number.parseInt(match[1], 10) : 0;
            const minutes = Number.parseInt(match[2], 10);
            const seconds = Number.parseInt(match[3], 10);
            const millis = parseFractionToMillis(match[4]);
            const totalMs = Math.max(
                0,
                ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis + offsetMs
            );
            timestamps.push(totalMs * 1000);
            lastIndex = tagRegex.lastIndex;
        }

        if (timestamps.length === 0)
            continue;

        const text = rawLine
            .slice(lastIndex)
            .replace(/<\s*(?:\d{1,2}:)?\d{1,3}:\d{2}(?:[.:,]\d{1,3})?\s*>/g, '')
            .trim();
        for (const timeUs of timestamps)
            lines.push({timeUs, text});
    }

    lines.sort((a, b) => a.timeUs - b.timeUs);
    return lines;
}

// Binary search for the active lyric line at the current position (in us)
export function findActiveLineIndex(lines, positionUs) {
    if (!lines || lines.length === 0 || positionUs < lines[0].timeUs)
        return -1;

    let low = 0;
    let high = lines.length - 1;
    let best = -1;

    while (low <= high) {
        const mid = (low + high) >> 1;
        if (lines[mid].timeUs <= positionUs) {
            best = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return best;
}

// Strip common video/stream suffixes to improve fallback matching
function sanitizeTrackQuery(artist, title) {
    let cleanTitle = (title || '')
        .replace(/\s*[\(\[]\s*(?:official\s*(?:music\s*)?(?:video|audio|lyric(?:s)?)|hd|4k|lyrics?|audio|mv|visualizer|live)[^\)\]]*[\)\]]/gi, '')
        .replace(/\s*-\s*(?:topic|official.*|lyrics?)$/gi, '')
        .trim();

    let cleanArtist = (artist || '')
        .replace(/\s*-\s*topic$/i, '')
        .split(/[,;&]|\s+(?:feat\.?|ft\.?|x)\s+/i)[0]
        .trim();

    // Split "Artist - Title" when browsers omit the artist metadata field
    if (!cleanArtist && cleanTitle.includes(' - ')) {
        const parts = cleanTitle.split(' - ');
        if (parts.length >= 2) {
            cleanArtist = parts[0].trim();
            cleanTitle = parts.slice(1).join(' - ').trim();
        }
    }

    return {artist: cleanArtist, title: cleanTitle};
}

export class LyricsClient {
    constructor() {
        this._session = new Soup.Session({
            timeout: 10,
            user_agent: 'SoundPill/1.0 (https://tundralab.com.br)',
        });
        this._cache = new Map();
        this._inflight = new Map();
        this._activeCancellables = new Set();
        this._destroyed = false;
    }

    _makeCacheKey(artist, title) {
        return `${(artist || '').trim().toLowerCase()}::${(title || '').trim().toLowerCase()}`;
    }

    _setCache(key, value) {
        if (this._cache.size >= MAX_CACHE_ENTRIES) {
            const oldestKey = this._cache.keys().next().value;
            if (oldestKey !== undefined)
                this._cache.delete(oldestKey);
        }
        this._cache.set(key, value);
    }

    _sendGetJson(url, cancellable) {
        return new Promise((resolve, reject) => {
            if (this._destroyed) {
                reject(new Error('LyricsClient destroyed'));
                return;
            }

            const msg = Soup.Message.new('GET', url);
            this._session.send_and_read_async(
                msg,
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (session, res) => {
                    try {
                        const bytes = session.send_and_read_finish(res);
                        const status = msg.get_status();
                        if (status === Soup.Status.NOT_FOUND) {
                            resolve(null);
                            return;
                        }
                        if (status < 200 || status >= 300) {
                            reject(new Error(`HTTP ${status}`));
                            return;
                        }
                        const raw = new TextDecoder('utf-8').decode(bytes.get_data());
                        resolve(JSON.parse(raw));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    async _queryLrcLib(artist, title, durationSec, cancellable) {
        if (!artist || !title)
            return null;

        const params = {
            artist_name: artist,
            track_name: title,
        };
        if (durationSec > 0)
            params.duration = String(Math.round(durationSec));

        const query = Soup.form_encode_hash(params);
        return this._sendGetJson(`${LRCLIB_GET_URL}?${query}`, cancellable);
    }

    async _searchLrcLib(artist, title, durationSec, cancellable) {
        if (!title)
            return null;

        const params = artist
            ? {artist_name: artist, track_name: title}
            : {q: title};
        const query = Soup.form_encode_hash(params);
        const results = await this._sendGetJson(`${LRCLIB_SEARCH_URL}?${query}`, cancellable);
        if (!Array.isArray(results) || results.length === 0)
            return null;

        const synced = results.filter(item => Boolean(item?.syncedLyrics?.trim()));
        const pool = synced.length > 0 ? synced : results;
        if (durationSec > 0) {
            pool.sort((a, b) => {
                const da = Number.isFinite(a?.duration) ? Math.abs(a.duration - durationSec) : 9999;
                const db = Number.isFinite(b?.duration) ? Math.abs(b.duration - durationSec) : 9999;
                return da - db;
            });
        }
        return pool[0] || null;
    }

    // Fetch and cache track lyrics in memory
    async getLyrics(artist, title, durationSec = 0, externalCancellable = null) {
        const emptyResult = {
            syncedLines: [],
            plainLines: [],
            instrumental: false,
            found: false,
        };

        if (this._destroyed || !title)
            return emptyResult;

        const key = this._makeCacheKey(artist, title);
        if (this._cache.has(key))
            return this._cache.get(key);

        if (this._inflight.has(key))
            return this._inflight.get(key);

        const cancellable = new Gio.Cancellable();
        this._activeCancellables.add(cancellable);

        let extSignalId = 0;
        if (externalCancellable) {
            if (externalCancellable.is_cancelled()) {
                this._activeCancellables.delete(cancellable);
                return emptyResult;
            }
            extSignalId = externalCancellable.connect(() => cancellable.cancel());
        }

        const promise = (async () => {
            try {
                let data = null;
                const rawArtist = (artist || '').trim();
                const rawTitle = title.trim();

                if (rawArtist && rawTitle)
                    data = await this._queryLrcLib(rawArtist, rawTitle, durationSec, cancellable);

                // Retry with cleaned artist/title if exact lookup missed or has no synced timestamps
                if ((!data || !data.syncedLyrics?.trim()) && !cancellable.is_cancelled()) {
                    const cleaned = sanitizeTrackQuery(artist, title);
                    const same = cleaned.artist.toLowerCase() === rawArtist.toLowerCase() &&
                        cleaned.title.toLowerCase() === rawTitle.toLowerCase();
                    if (!same && cleaned.artist && cleaned.title) {
                        const cleanHit = await this._queryLrcLib(
                            cleaned.artist,
                            cleaned.title,
                            durationSec,
                            cancellable
                        );
                        if (cleanHit?.syncedLyrics?.trim() || !data)
                            data = cleanHit;
                    }

                    // Search LRCLIB catalog for a synced entry when /api/get only has plain lyrics or misses
                    if ((!data || !data.syncedLyrics?.trim()) && !cancellable.is_cancelled()) {
                        const searchArtist = cleaned.artist || rawArtist;
                        const searchTitle = cleaned.title || rawTitle;
                        const searchHit = await this._searchLrcLib(
                            searchArtist,
                            searchTitle,
                            durationSec,
                            cancellable
                        );
                        if (searchHit?.syncedLyrics?.trim() || !data)
                            data = searchHit;
                    }
                }

                if (this._destroyed || cancellable.is_cancelled())
                    return emptyResult;

                if (!data) {
                    this._setCache(key, emptyResult);
                    return emptyResult;
                }

                const syncedLines = parseLrc(data.syncedLyrics || '');
                const plainLines = data.plainLyrics
                    ? data.plainLyrics.split(/\r?\n/).map(l => l.trimEnd())
                    : [];

                const result = {
                    syncedLines,
                    plainLines,
                    instrumental: Boolean(data.instrumental),
                    found: syncedLines.length > 0 || plainLines.length > 0 || Boolean(data.instrumental),
                };

                this._setCache(key, result);
                return result;
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return emptyResult;

                // Do not cache transient network errors
                return emptyResult;
            } finally {
                if (externalCancellable && extSignalId)
                    externalCancellable.disconnect(extSignalId);
                this._activeCancellables.delete(cancellable);
                this._inflight.delete(key);
            }
        })();

        this._inflight.set(key, promise);
        return promise;
    }

    destroy() {
        this._destroyed = true;
        for (const c of this._activeCancellables)
            c.cancel();
        this._activeCancellables.clear();
        this._inflight.clear();
        this._cache.clear();
        this._session.abort();
    }
}
