import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {syncAutostartEntry} from './src/core/autostart.js';
import {getStrings, resolveLanguage} from './src/core/i18n.js';
import {TundraMediaController} from './src/core/mediaController.js';
import {TundraDesktopWidget} from './src/ui/desktopWidget.js';
import {MediaPlayerCard} from './src/ui/playerCard.js';
import {drawPillVisualizer} from './src/ui/waveform.js';

const DEFAULT_MARQUEE_WIDTH = 220;
const EQ_ANIM_INTERVAL_MS = 100;

class SoundPillIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(controller, settings, openPreferencesCallback = null) {
        super(0.5, 'SoundPill (by TundraLab)');
        this.add_style_class_name('soundpill-button');
        this._setIndicatorVisible(false);

        this._destroyed = false;
        this._controller = controller;
        this._settings = settings;
        this._openPreferences = openPreferencesCallback;

        this._marqueeMaxWidth = settings.get_int('marquee-max-width');
        this._showWhenIdle = settings.get_boolean('show-when-idle');
        this._showLyricsInPill = settings.get_boolean('show-lyrics-in-pill');
        this._enableVinylSpin = settings.get_boolean('enable-vinyl-spin');
        this._enablePillEq = settings.get_boolean('enable-pill-eq');
        this._pillEqStyle = settings.get_string('pill-eq-style') || 'bars';
        this._enableGlass = settings.get_boolean('enable-glassmorphism');
        this._strings = getStrings(resolveLanguage(settings));

        this._vinylSpinning = false;
        this._lastArtUri = undefined;
        this._currentPillText = '';
        this._showingLyric = false;
        this._accentPalette = controller.getAccentPalette();
        this._marqueeGen = 0;
        this._marqueeTimerId = 0;
        this._eqTimerId = 0;
        this._animPhase = 0;

        this._buildPillUi();
        this._buildPopupMenuUi();

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            this._onSettingChanged(key);
        });

        this.menu.connectObject('open-state-changed', (_menu, isOpen) => {
            if (this._destroyed)
                return;
            if (isOpen)
                this._controller.refreshPosition();
            this._updatePillBorderStyle();
            this._card.setActiveView(isOpen);
        }, this);

        this._controllerListener = {
            onMediaChanged: () => this._syncPill(),
            onArtChanged: () => this._syncArt(),
            onLyricsChanged: () => this._updatePillText(),
            onPositionChanged: payload => {
                if (payload?.lyricChanged)
                    this._updatePillText();
            },
            onAccentChanged: () => this._applyAccentPalette(),
        };
        this._controller.addListener(this._controllerListener);

        this._applyGlassStyle();
        this._applyAccentPalette();
        this._syncPill();
        this._syncArt();
    }

    _buildPillUi() {
        this._pillBox = new St.BoxLayout({
            style_class: 'tundra-pill-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pillBox.layout_manager.spacing = 8;
        this.add_child(this._pillBox);

        // Spinning vinyl cover (22x22)
        this._vinylActor = new St.Widget({
            style_class: 'tundra-pill-vinyl',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._vinylActor.set_pivot_point(0.5, 0.5);

        this._vinylFallbackIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 12,
            style_class: 'tundra-pill-vinyl-fallback',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._vinylActor.add_child(this._vinylFallbackIcon);

        this._vinylSpindle = new St.Widget({
            style_class: 'tundra-pill-vinyl-spindle',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._vinylActor.add_child(this._vinylSpindle);
        this._pillBox.add_child(this._vinylActor);

        // Horizontal marquee label
        this._marqueeInner = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pillLabel = new St.Label({
            style_class: 'tundra-pill-label',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pillLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._pillLabel.clutter_text.single_line_mode = true;
        this._marqueeInner.add_child(this._pillLabel);

        this._marqueeScroll = new St.ScrollView({
            style_class: 'tundra-marquee-scroll',
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            enable_mouse_scrolling: false,
            y_align: Clutter.ActorAlign.CENTER,
            child: this._marqueeInner,
        });
        this._applyMarqueeWidth();
        this._pillBox.add_child(this._marqueeScroll);

        // Mini equalizer visualizer
        this._pillEqCanvas = new St.DrawingArea({
            style_class: 'tundra-pill-eq-canvas',
            width: 28,
            height: 16,
            y_align: Clutter.ActorAlign.CENTER,
            visible: this._enablePillEq,
        });
        this._pillEqCanvas.connect('repaint', () => {
            if (this._destroyed)
                return;
            const {player} = this._controller.getState();
            const isPlaying = player?.playbackStatus === 'Playing';
            drawPillVisualizer(this._pillEqCanvas, {
                style: this._pillEqStyle,
                phase: this._animPhase,
                isPlaying: Boolean(player) && isPlaying,
                palette: this._accentPalette,
            });
        });
        this._pillBox.add_child(this._pillEqCanvas);
    }

    _buildPopupMenuUi() {
        const menuItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'tundra-menu-item',
        });

        this._card = new MediaPlayerCard({
            controller: this._controller,
            settings: this._settings,
            variant: 'menu',
            onOpenPreferences: () => {
                this.menu.close();
                this._openPreferences?.();
            },
            onCloseMenu: () => {
                this.menu.close();
            },
        });

        menuItem.add_child(this._card.actor);
        this.menu.addMenuItem(menuItem);
    }

    _applyMarqueeWidth() {
        const width = this._marqueeMaxWidth || DEFAULT_MARQUEE_WIDTH;
        this._marqueeScroll.set_style(`max-width: ${width}px;`);
    }

    _applyGlassStyle() {
        if (!this.menu?.actor)
            return;
        if (this._enableGlass)
            this.menu.actor.add_style_class_name('tundra-glass-popup');
        else
            this.menu.actor.remove_style_class_name('tundra-glass-popup');
    }

    _updatePillBorderStyle() {
        if (!this._pillBox)
            return;
        const p = this._accentPalette;
        if (this.menu?.isOpen && p)
            this._pillBox.set_style(`border-color: ${p.lightRgba(0.55)};`);
        else
            this._pillBox.set_style(null);
    }

    _updatePillLabelColor() {
        if (!this._pillLabel)
            return;
        const p = this._accentPalette;
        if (this._showingLyric && p)
            this._pillLabel.set_style(`color: ${p.lightHex};`);
        else
            this._pillLabel.set_style(null);
    }

    _applyAccentPalette() {
        if (this._destroyed)
            return;
        this._accentPalette = this._controller.getAccentPalette();
        this._updatePillBorderStyle();
        this._updatePillLabelColor();
        this._pillEqCanvas?.queue_repaint();
    }

    _onSettingChanged(key) {
        if (this._destroyed)
            return;

        const {player} = this._controller.getState();
        const isPlaying = player?.playbackStatus === 'Playing';

        switch (key) {
        case 'marquee-max-width':
            this._marqueeMaxWidth = this._settings.get_int('marquee-max-width');
            this._applyMarqueeWidth();
            if (this._currentPillText)
                this._setPillMarqueeText(this._currentPillText);
            break;
        case 'show-when-idle':
            this._showWhenIdle = this._settings.get_boolean('show-when-idle');
            this._syncPill();
            break;
        case 'show-lyrics-in-pill':
            this._showLyricsInPill = this._settings.get_boolean('show-lyrics-in-pill');
            this._updatePillText();
            break;
        case 'enable-vinyl-spin':
            this._enableVinylSpin = this._settings.get_boolean('enable-vinyl-spin');
            if (player && isPlaying && this._enableVinylSpin)
                this._startVinylSpin();
            else
                this._pauseVinylSpin();
            break;
        case 'enable-pill-eq':
            this._enablePillEq = this._settings.get_boolean('enable-pill-eq');
            this._pillEqCanvas.visible = Boolean(player) && this._enablePillEq;
            if (player && isPlaying && this._enablePillEq)
                this._startEqAnimation();
            else
                this._stopEqAnimation();
            break;
        case 'pill-eq-style':
            this._pillEqStyle = this._settings.get_string('pill-eq-style') || 'bars';
            this._pillEqCanvas?.queue_repaint();
            break;
        case 'enable-glassmorphism':
            this._enableGlass = this._settings.get_boolean('enable-glassmorphism');
            this._applyGlassStyle();
            break;
        case 'language':
            this._strings = getStrings(resolveLanguage(this._settings));
            this._syncPill();
            break;
        }
    }

    _setIndicatorVisible(visible) {
        const wasVisible = this.visible;
        this.visible = visible;
        if (this.container && this.container !== this)
            this.container.visible = visible;
        if (visible && !wasVisible) {
            this._pillBox?.queue_relayout();
            this.queue_relayout();
        }
    }

    _syncPill() {
        if (this._destroyed)
            return;

        const {player} = this._controller.getState();
        if (!player) {
            this._pauseVinylSpin();
            this._stopEqAnimation();
            this._pillEqCanvas.visible = false;

            if (this._showWhenIdle) {
                this._setIndicatorVisible(true);
                this._showingLyric = false;
                this._pillLabel.remove_style_class_name('tundra-pill-label-lyric');
                this._updatePillLabelColor();
                const noMediaText = this._strings.pill.noMedia;
                if (this._currentPillText !== noMediaText) {
                    this._currentPillText = noMediaText;
                    this._setPillMarqueeText(noMediaText);
                }
            } else {
                this._setIndicatorVisible(false);
                if (this.menu.isOpen)
                    this.menu.close();
                this._stopMarquee();
                this._currentPillText = '';
            }
            return;
        }

        this._setIndicatorVisible(true);
        const isPlaying = player.playbackStatus === 'Playing';

        if (isPlaying && this._enableVinylSpin)
            this._startVinylSpin();
        else
            this._pauseVinylSpin();

        this._pillEqCanvas.visible = this._enablePillEq;
        if (isPlaying && this._enablePillEq)
            this._startEqAnimation();
        else
            this._stopEqAnimation();

        this._updatePillText();
    }

    _syncArt() {
        if (this._destroyed)
            return;

        const {artUri} = this._controller.getState();
        if (artUri === this._lastArtUri)
            return;
        this._lastArtUri = artUri;

        if (artUri) {
            const safeUri = artUri.replace(/"/g, '\\"');
            this._vinylActor.set_style(`background-image: url("${safeUri}");`);
            this._vinylFallbackIcon.visible = false;
            this._vinylSpindle.visible = true;
        } else {
            this._vinylActor.set_style(null);
            this._vinylFallbackIcon.visible = true;
            this._vinylSpindle.visible = false;
        }
    }

    _updatePillText() {
        if (this._destroyed)
            return;

        const {player, lyricsData, activeLyricIndex} = this._controller.getState();
        if (!player)
            return;

        const {title, artist} = player.metadata;
        let displayText = '';
        let showingLyric = false;

        if (this._showLyricsInPill &&
            lyricsData.syncedLines.length > 0 &&
            activeLyricIndex >= 0) {
            const lyricLine = lyricsData.syncedLines[activeLyricIndex]?.text;
            if (lyricLine) {
                displayText = lyricLine;
                showingLyric = true;
            }
        }

        if (!displayText) {
            if (title && artist)
                displayText = `${title} • ${artist}`;
            else
                displayText = title || artist || player.identity || this._strings.pill.playing;
        }

        this._showingLyric = showingLyric;
        if (showingLyric)
            this._pillLabel.add_style_class_name('tundra-pill-label-lyric');
        else
            this._pillLabel.remove_style_class_name('tundra-pill-label-lyric');
        this._updatePillLabelColor();

        if (displayText === this._currentPillText)
            return;

        this._currentPillText = displayText;
        this._setPillMarqueeText(displayText);
    }

    _getMarqueeHAdjustment() {
        return this._marqueeScroll?.hadjustment
            || this._marqueeScroll?.hscroll?.adjustment
            || this._marqueeScroll?.get_hscroll_bar?.()?.adjustment
            || this._marqueeInner?.hadjustment
            || null;
    }

    _stopMarquee() {
        this._marqueeGen++;
        if (this._marqueeTimerId) {
            GLib.Source.remove(this._marqueeTimerId);
            this._marqueeTimerId = 0;
        }
        const adj = this._getMarqueeHAdjustment();
        if (adj) {
            adj.remove_transition('value');
            adj.value = 0;
        }
    }

    _setPillMarqueeText(text) {
        this._stopMarquee();
        this._pillLabel.set_text(text);
        try {
            this._pillLabel.ensure_style();
        } catch (_e) {
            // Not attached to stage yet
        }

        const maxWidth = this._marqueeMaxWidth || DEFAULT_MARQUEE_WIDTH;
        const [, natWidth] = this._pillLabel.get_preferred_width(-1);
        const clampedWidth = Math.max(24, Math.min(Math.ceil(natWidth) + 2, maxWidth));
        this._marqueeScroll.set_width(clampedWidth);

        const overflow = Math.ceil(natWidth) - maxWidth;
        if (overflow <= 2)
            return;

        const gen = this._marqueeGen;
        const scrollEnd = overflow + 6;
        const durationMs = Math.max(1800, Math.round(scrollEnd * 30));

        const scheduleScrollTo = (targetValue, delayMs) => {
            if (this._destroyed || gen !== this._marqueeGen)
                return;
            this._marqueeTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                this._marqueeTimerId = 0;
                if (this._destroyed || gen !== this._marqueeGen)
                    return GLib.SOURCE_REMOVE;

                const adj = this._getMarqueeHAdjustment();
                if (!adj || typeof adj.ease !== 'function')
                    return GLib.SOURCE_REMOVE;

                adj.ease(targetValue, {
                    duration: durationMs,
                    mode: Clutter.AnimationMode.LINEAR,
                    onComplete: () => {
                        if (this._destroyed || gen !== this._marqueeGen)
                            return;
                        const nextTarget = targetValue === 0 ? scrollEnd : 0;
                        scheduleScrollTo(nextTarget, 1300);
                    },
                });
                return GLib.SOURCE_REMOVE;
            });
        };

        scheduleScrollTo(scrollEnd, 1400);
    }

    _startVinylSpin() {
        if (this._vinylSpinning || this._destroyed || !this._vinylActor)
            return;

        this._vinylSpinning = true;
        this._vinylActor.remove_transition('vinyl-coast');
        this._vinylActor.remove_transition('vinyl-spin');

        const startAngle = ((this._vinylActor.rotation_angle_z % 360) + 360) % 360;
        const transition = new Clutter.PropertyTransition({
            property_name: 'rotation-angle-z',
            duration: 4800,
            progress_mode: Clutter.AnimationMode.LINEAR,
            repeat_count: -1,
            remove_on_complete: false,
        });
        transition.set_from(startAngle);
        transition.set_to(startAngle + 360);
        this._vinylActor.add_transition('vinyl-spin', transition);
    }

    _pauseVinylSpin() {
        if (!this._vinylSpinning)
            return;

        this._vinylSpinning = false;
        if (!this._vinylActor)
            return;

        const currentAngle = ((this._vinylActor.rotation_angle_z % 360) + 360) % 360;
        this._vinylActor.remove_transition('vinyl-spin');
        this._vinylActor.remove_transition('vinyl-coast');
        this._vinylActor.rotation_angle_z = currentAngle;

        const coast = new Clutter.PropertyTransition({
            property_name: 'rotation-angle-z',
            duration: 320,
            progress_mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            remove_on_complete: true,
        });
        coast.set_from(currentAngle);
        coast.set_to(currentAngle + 10);
        this._vinylActor.add_transition('vinyl-coast', coast);
    }

    _startEqAnimation() {
        this._pillEqCanvas?.queue_repaint();
        if (this._eqTimerId)
            return;

        const tick = () => {
            if (this._destroyed) {
                this._eqTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._animPhase += 0.42;
            this._pillEqCanvas?.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        };

        tick();
        this._eqTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EQ_ANIM_INTERVAL_MS, tick);
    }

    _stopEqAnimation() {
        if (this._eqTimerId) {
            GLib.Source.remove(this._eqTimerId);
            this._eqTimerId = 0;
        }
        this._pillEqCanvas?.queue_repaint();
    }

    _onDestroy() {
        this._destroyed = true;

        if (this._settings && this._settingsChangedId) {
            try {
                this._settings.disconnect(this._settingsChangedId);
            } catch (_e) {
                // Settings object may already be disposed
            }
            this._settingsChangedId = 0;
        }
        if (this._controller && this._controllerListener) {
            this._controller.removeListener(this._controllerListener);
            this._controllerListener = null;
        }

        this._stopMarquee();
        this._stopEqAnimation();

        if (this._vinylActor) {
            try {
                this._vinylActor.remove_all_transitions();
            } catch (_e) {
                // Actor may already be disposed
            }
        }

        try {
            this._card?.destroy();
        } catch (_e) {
            // Card actor may already be disposed by parent menu
        }
        this._card = null;
        this._vinylActor = null;
        this._pillEqCanvas = null;
        this._settings = null;
        this._controller = null;
        this._openPreferences = null;

        super._onDestroy();
    }
}

export default class SoundPillExtension extends Extension {
    _openPreferencesSafely() {
        try {
            Promise.resolve(this.openPreferences()).catch(() => {});
        } catch (_e) {
            // Ignore when preferences dialog is already open
        }
    }

    enable() {
        this._settings = this.getSettings();
        this._settingsSignalIds = [];

        syncAutostartEntry(this._settings.get_boolean('autostart-enabled'));

        this._controller = new TundraMediaController(this._settings);

        this._settingsSignalIds.push(
            this._settings.connect('changed::panel-position', () => {
                this._mountIndicator();
            })
        );
        this._settingsSignalIds.push(
            this._settings.connect('changed::autostart-enabled', () => {
                syncAutostartEntry(this._settings.get_boolean('autostart-enabled'));
            })
        );
        this._settingsSignalIds.push(
            this._settings.connect('changed::desktop-widget-enabled', () => {
                this._syncDesktopWidget();
            })
        );

        this._mountIndicator();
        this._syncDesktopWidget();
    }

    _mountIndicator() {
        if (this._indicator) {
            try {
                this._indicator.destroy();
            } catch (_e) {
                // Ignore if already disposed
            }
            this._indicator = null;
        }

        if (Main.panel.statusArea.soundpill) {
            try {
                Main.panel.statusArea.soundpill.destroy();
            } catch (_e) {
                delete Main.panel.statusArea.soundpill;
            }
        }

        const box = this._settings.get_string('panel-position') || 'center';
        let pos = 0;

        if (box === 'center') {
            pos = 1;
            const dateMenu = Main.panel.statusArea.dateMenu;
            if (dateMenu?.container) {
                const centerChildren = Main.panel._centerBox.get_children();
                const dateIdx = centerChildren.indexOf(dateMenu.container);
                if (dateIdx !== -1)
                    pos = dateIdx + 1;
            }
        } else if (box === 'left') {
            pos = Main.panel._leftBox?.get_n_children() ?? 0;
        }

        this._indicator = new SoundPillIndicator(
            this._controller,
            this._settings,
            () => this._openPreferencesSafely()
        );
        Main.panel.addToStatusArea('soundpill', this._indicator, pos, box);
    }

    _syncDesktopWidget() {
        const enabled = this._settings.get_boolean('desktop-widget-enabled');
        if (enabled && !this._desktopWidget) {
            this._desktopWidget = new TundraDesktopWidget(
                this._controller,
                this._settings,
                () => this._openPreferencesSafely()
            );
        } else if (!enabled && this._desktopWidget) {
            this._desktopWidget.destroy();
            this._desktopWidget = null;
        }
    }

    disable() {
        if (this._settings && this._settingsSignalIds) {
            for (const id of this._settingsSignalIds) {
                try {
                    this._settings.disconnect(id);
                } catch (_e) {
                    // Settings object may already be disposed
                }
            }
            this._settingsSignalIds = [];
        }

        if (this._desktopWidget) {
            try {
                this._desktopWidget.destroy();
            } catch (_e) {
                // Ignore widget teardown errors on shell lock/disable
            }
            this._desktopWidget = null;
        }

        if (this._indicator) {
            try {
                this._indicator.destroy();
            } catch (_e) {
                // Ignore indicator teardown errors on shell lock/disable
            }
            this._indicator = null;
        }

        if (this._controller) {
            try {
                this._controller.destroy();
            } catch (_e) {
                // Ignore controller teardown errors on shell lock/disable
            }
            this._controller = null;
        }

        this._settings = null;
    }
}
