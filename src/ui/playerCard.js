import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {getStrings, resolveLanguage} from '../core/i18n.js';
import {formatMicroseconds} from '../core/mediaController.js';
import {drawCardWaveform} from './waveform.js';

const WAVE_ANIM_INTERVAL_MS = 90;

export class MediaPlayerCard {
    constructor({
        controller,
        settings,
        variant = 'menu',
        onOpenPreferences = null,
        onCloseMenu = null,
    }) {
        this._controller = controller;
        this._settings = settings;
        this._variant = variant;
        this._onOpenPreferences = onOpenPreferences;
        this._onCloseMenu = onCloseMenu;
        this._destroyed = false;

        this._isActiveView = variant === 'desktop';
        this._actorDestroyed = false;
        this._waveTimerId = 0;
        this._pendingScrollId = 0;
        this._scrollLaterId = 0;
        this._scrollTweenId = 0;
        this._lyricsMappedId = 0;
        this._wavePhase = 0;
        this._lastPosUs = 0;
        this._lastLengthUs = 0;
        this._lastRatio = 0;
        this._isScrubbing = false;
        this._scrubGrab = null;
        this._scrubFraction = 0;
        this._scrubLengthUs = 0;
        this._lastLyricsSig = '';
        this._lastArtUri = undefined;
        this._lastActiveLyricIndex = -2;
        this._lyricLineLabels = [];
        this._plainScrollableIndices = [];
        this._isPlainLyricsMode = false;

        this._enableMenuWaves = settings.get_boolean('enable-menu-waves');
        this._waveformStyle = settings.get_string('waveform-style') || 'classic';
        this._enableWaveSeek = settings.get_boolean('enable-wave-seek');
        this._enableGlass = settings.get_boolean('enable-glassmorphism');
        this._desktopWidgetEnabled = settings.get_boolean('desktop-widget-enabled');
        this._desktopShowLyrics = settings.get_boolean('desktop-widget-show-lyrics');
        this._menuShowLyrics = settings.get_boolean('menu-show-lyrics');
        this._accentPalette = controller.getAccentPalette();
        this._strings = getStrings(resolveLanguage(settings));

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: variant === 'desktop'
                ? 'tundra-card tundra-desktop-card'
                : 'tundra-card tundra-menu-card',
        });
        this.actor.layout_manager.spacing = 12;
        this.actor.connect('destroy', () => {
            this._actorDestroyed = true;
        });

        this._buildHeader();
        this._buildWaveform();
        this._buildControls();
        this._buildLyricsPanel();

        this._settingsId = this._settings.connect('changed', (_s, key) => {
            this._onSettingChanged(key);
        });

        this._controllerListener = {
            onMediaChanged: () => this.syncAll(),
            onArtChanged: () => this._syncArt(),
            onLyricsChanged: () => this._syncLyrics(),
            onPositionChanged: payload => this._syncPosition(payload),
            onAccentChanged: () => this._applyAccentPalette(),
        };
        this._controller.addListener(this._controllerListener);

        this._applyGlassStyle();
        this._applySectionVisibility();
        this._applyAccentPalette();
        this.syncAll();
    }

    _buildHeader() {
        const headerBox = new St.BoxLayout({
            style_class: 'tundra-card-header',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.layout_manager.spacing = 14;

        this._coverActor = new St.Widget({
            style_class: 'tundra-card-cover',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._coverFallback = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 36,
            style_class: 'tundra-card-cover-fallback',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._coverActor.add_child(this._coverFallback);

        this._coverBtn = new St.Button({
            style_class: 'tundra-card-cover-btn',
            child: this._coverActor,
            reactive: true,
            track_hover: true,
            can_focus: true,
            button_mask: St.ButtonMask.PRIMARY ?? St.ButtonMask.ONE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._attachHoverScale(this._coverBtn, 1.04);
        this._coverBtn.connect('clicked', () => {
            if (this._destroyed)
                return;
            const activated = this._controller.activateActivePlayer();
            if (activated && this._variant === 'menu')
                this._onCloseMenu?.();
        });
        headerBox.add_child(this._coverBtn);

        const metaCol = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'tundra-card-meta',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        metaCol.layout_manager.spacing = 5;

        const topRow = new St.BoxLayout({
            style_class: 'tundra-card-top-row',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._sourceLabel = new St.Label({
            style_class: 'tundra-card-source',
            text: '',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._sourceLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        topRow.add_child(this._sourceLabel);

        if (this._variant === 'menu') {
            this._pinDesktopBtn = this._createIconButton(
                'view-pin-symbolic',
                'tundra-ghost-icon-btn',
                13,
                () => {
                    const next = !this._settings.get_boolean('desktop-widget-enabled');
                    this._settings.set_boolean('desktop-widget-enabled', next);
                }
            );
            this._pinDesktopBtn.connect('notify::hover', () => this._updatePinButtonStyle());
            this._updatePinButtonStyle();
            topRow.add_child(this._pinDesktopBtn);

            this._prefsBtn = this._createIconButton(
                'preferences-system-symbolic',
                'tundra-ghost-icon-btn',
                13,
                () => {
                    this._onOpenPreferences?.();
                }
            );
            topRow.add_child(this._prefsBtn);
        }

        metaCol.add_child(topRow);

        this._titleLabel = new St.Label({
            style_class: 'tundra-card-title',
            text: '',
        });
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        metaCol.add_child(this._titleLabel);

        this._artistLabel = new St.Label({
            style_class: 'tundra-card-artist',
            text: '',
        });
        this._artistLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        metaCol.add_child(this._artistLabel);

        headerBox.add_child(metaCol);
        this.actor.add_child(headerBox);
    }

    _buildWaveform() {
        this._waveContainer = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'tundra-wave-section',
        });
        this._waveContainer.layout_manager.spacing = 6;

        this._waveBox = new St.BoxLayout({
            style_class: 'tundra-wave-box',
            reactive: true,
            track_hover: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._waveCanvas = new St.DrawingArea({
            style_class: 'tundra-wave-canvas',
            x_expand: true,
            y_expand: true,
        });
        this._waveCanvas.connect('repaint', () => {
            if (this._destroyed)
                return;
            const {player} = this._controller.getState();
            const isPlaying = player?.playbackStatus === 'Playing';
            drawCardWaveform(this._waveCanvas, {
                style: this._waveformStyle,
                ratio: this._lastRatio,
                phase: this._wavePhase,
                animate: this._enableMenuWaves && this._isActiveView && isPlaying,
                hasDuration: this._lastLengthUs > 0,
                palette: this._accentPalette,
            });
        });
        this._waveBox.add_child(this._waveCanvas);
        this._updateWaveSeekVisual();

        this._waveBox.connect('button-press-event', (_actor, event) => {
            if (this._destroyed || !this._enableWaveSeek || event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;

            const {lengthUs} = this._controller.getState();
            if (lengthUs <= 0)
                return Clutter.EVENT_PROPAGATE;

            const [stageX] = event.get_coords();
            const fraction = this._fractionFromStageX(stageX);
            if (fraction === null)
                return Clutter.EVENT_PROPAGATE;

            this._isScrubbing = true;
            this._scrubLengthUs = lengthUs;
            this._scrubFraction = fraction;
            this._scrubGrab = global.stage.grab(this._waveBox);
            this._elapsedLabel.add_style_class_name('tundra-time-label-scrubbing');

            const previewUs = Math.round(fraction * lengthUs);
            this._elapsedLabel.set_text(formatMicroseconds(previewUs));
            this._updateWaveProgress(previewUs, lengthUs);
            return Clutter.EVENT_STOP;
        });

        this._waveBox.connect('motion-event', (_actor, event) => {
            if (!this._isScrubbing || this._destroyed)
                return Clutter.EVENT_PROPAGATE;

            const [stageX] = event.get_coords();
            const fraction = this._fractionFromStageX(stageX);
            if (fraction !== null) {
                this._scrubFraction = fraction;
                const previewUs = Math.round(fraction * this._scrubLengthUs);
                this._elapsedLabel.set_text(formatMicroseconds(previewUs));
                this._updateWaveProgress(previewUs, this._scrubLengthUs);
            }
            return Clutter.EVENT_STOP;
        });

        this._waveBox.connect('button-release-event', (_actor, event) => {
            if (!this._isScrubbing)
                return Clutter.EVENT_PROPAGATE;

            if (event.get_button() !== 1)
                return Clutter.EVENT_STOP;

            const [stageX] = event.get_coords();
            const finalFraction = this._fractionFromStageX(stageX) ?? this._scrubFraction;
            this._endScrub();
            this._controller.seekToFraction(finalFraction);
            return Clutter.EVENT_STOP;
        });

        this._waveBox.connect('scroll-event', (_actor, event) => {
            if (this._destroyed || !this._enableWaveSeek)
                return Clutter.EVENT_PROPAGATE;

            const {lengthUs} = this._controller.getState();
            if (lengthUs <= 0)
                return Clutter.EVENT_PROPAGATE;

            const dir = event.get_scroll_direction();
            let deltaSec = 0;
            if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.RIGHT) {
                deltaSec = 5;
            } else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.LEFT) {
                deltaSec = -5;
            } else if (dir === Clutter.ScrollDirection.SMOOTH) {
                const [dx, dy] = event.get_scroll_delta();
                if (Math.abs(dy) >= Math.abs(dx) && Math.abs(dy) > 0.05)
                    deltaSec = dy < 0 ? 5 : -5;
                else if (Math.abs(dx) > 0.05)
                    deltaSec = dx > 0 ? 5 : -5;
            }

            if (deltaSec !== 0) {
                this._controller.seekByOffsetSeconds(deltaSec);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._waveContainer.add_child(this._waveBox);

        const timeRow = new St.BoxLayout({
            style_class: 'tundra-time-row',
            x_expand: true,
        });

        this._elapsedLabel = new St.Label({
            style_class: 'tundra-time-label',
            text: '0:00',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        timeRow.add_child(this._elapsedLabel);

        this._durationLabel = new St.Label({
            style_class: 'tundra-time-label',
            text: '0:00',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        timeRow.add_child(this._durationLabel);

        this._waveContainer.add_child(timeRow);
        this.actor.add_child(this._waveContainer);
    }

    _fractionFromStageX(stageX) {
        const target = this._waveCanvas || this._waveBox;
        const [boxX] = target.get_transformed_position();
        const pad = this._waveformStyle === 'pill-slider' ? 7 : 2;
        const innerWidth = target.width - pad * 2;
        if (innerWidth <= 0)
            return null;
        return Math.max(0, Math.min(1, (stageX - boxX - pad) / innerWidth));
    }

    _endScrub() {
        this._isScrubbing = false;
        if (this._scrubGrab) {
            this._scrubGrab.dismiss();
            this._scrubGrab = null;
        }
        this._elapsedLabel?.remove_style_class_name('tundra-time-label-scrubbing');
    }

    _updateWaveSeekVisual() {
        if (!this._waveBox)
            return;
        if (this._enableWaveSeek)
            this._waveBox.add_style_class_name('tundra-wave-box-seekable');
        else
            this._waveBox.remove_style_class_name('tundra-wave-box-seekable');
    }

    _rebuildWaveformVisuals() {
        this._waveCanvas?.queue_repaint();
        this._updateWaveAnimation();
    }

    _buildControls() {
        const controlsBox = new St.BoxLayout({
            style_class: 'tundra-controls-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._prevBtn = this._createIconButton(
            'media-skip-backward-symbolic',
            'tundra-control-btn',
            16,
            () => this._controller.callPlayerMethod('Previous')
        );
        controlsBox.add_child(this._prevBtn);

        this._playPauseIcon = new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            icon_size: 22,
        });
        this._playPauseBtn = new St.Button({
            style_class: 'tundra-play-btn',
            child: this._playPauseIcon,
            reactive: true,
            track_hover: true,
            can_focus: true,
            button_mask: St.ButtonMask.PRIMARY ?? St.ButtonMask.ONE,
        });
        this._attachHoverScale(this._playPauseBtn, 1.07);
        this._playPauseBtn.connect('notify::hover', () => this._updatePlayButtonStyle());
        this._playPauseBtn.connect('clicked', () => {
            this._controller.callPlayerMethod('PlayPause');
        });
        controlsBox.add_child(this._playPauseBtn);

        this._nextBtn = this._createIconButton(
            'media-skip-forward-symbolic',
            'tundra-control-btn',
            16,
            () => this._controller.callPlayerMethod('Next')
        );
        controlsBox.add_child(this._nextBtn);

        this._lyricsToggleBtn = this._createIconButton(
            'media-view-subtitles-symbolic',
            'tundra-control-btn',
            16,
            () => {
                const key = this._variant === 'desktop'
                    ? 'desktop-widget-show-lyrics'
                    : 'menu-show-lyrics';
                const current = this._settings.get_boolean(key);
                this._settings.set_boolean(key, !current);
            }
        );
        this._lyricsToggleBtn.connect('notify::hover', () => this._updateLyricsToggleStyle());
        this._updateLyricsToggleStyle();
        controlsBox.add_child(this._lyricsToggleBtn);

        this.actor.add_child(controlsBox);
    }

    _buildLyricsPanel() {
        this._lyricsPanel = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'tundra-lyrics-panel',
        });

        this._lyricsContent = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'tundra-lyrics-content',
            x_expand: true,
        });
        this._lyricsContent.layout_manager.spacing = 6;

        this._lyricsScroll = new St.ScrollView({
            style_class: this._variant === 'desktop'
                ? 'tundra-lyrics-scroll tundra-lyrics-scroll-compact'
                : 'tundra-lyrics-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            enable_mouse_scrolling: true,
            x_expand: true,
            child: this._lyricsContent,
        });
        this._lyricsMappedId = this._lyricsScroll.connect('notify::mapped', () => {
            if (!this._destroyed && this._lyricsScroll.mapped && this._isActiveView && this._isLyricsPanelVisible())
                this.scrollActiveLyricIntoView(false);
        });
        this._lyricsPanel.add_child(this._lyricsScroll);
        this.actor.add_child(this._lyricsPanel);
    }

    _createIconButton(iconName, styleClass, iconSize, onClick) {
        const icon = new St.Icon({
            icon_name: iconName,
            icon_size: iconSize,
        });
        const btn = new St.Button({
            style_class: styleClass,
            child: icon,
            reactive: true,
            track_hover: true,
            can_focus: true,
            button_mask: St.ButtonMask.PRIMARY ?? St.ButtonMask.ONE,
        });
        this._attachHoverScale(btn, 1.08);
        btn.connect('clicked', onClick);
        return btn;
    }

    _attachHoverScale(btn, hoverScale) {
        btn.set_pivot_point(0.5, 0.5);
        btn.connect('enter-event', () => {
            if (!btn.reactive)
                return Clutter.EVENT_PROPAGATE;
            btn.ease({
                scale_x: hoverScale,
                scale_y: hoverScale,
                duration: 140,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return Clutter.EVENT_PROPAGATE;
        });
        btn.connect('leave-event', () => {
            btn.ease({
                scale_x: 1.0,
                scale_y: 1.0,
                duration: 160,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _setButtonEnabled(btn, enabled) {
        btn.reactive = enabled;
        btn.can_focus = enabled;
        if (enabled) {
            btn.remove_style_class_name('tundra-control-btn-disabled');
        } else {
            btn.add_style_class_name('tundra-control-btn-disabled');
            btn.scale_x = 1.0;
            btn.scale_y = 1.0;
        }
    }

    _isLyricsPanelVisible() {
        return this._variant === 'desktop' ? this._desktopShowLyrics : this._menuShowLyrics;
    }

    _updatePlayButtonStyle() {
        const p = this._accentPalette;
        if (!p || !this._playPauseBtn)
            return;

        if (this._playPauseBtn.hover && this._playPauseBtn.reactive) {
            this._playPauseBtn.set_style(
                `background-color: ${p.rgba(0.44)}; ` +
                `border-color: ${p.lighterRgba(0.94)}; ` +
                `box-shadow: 0 6px 22px ${p.rgba(0.42)};`
            );
        } else {
            this._playPauseBtn.set_style(
                `background-color: ${p.rgba(0.28)}; ` +
                `border-color: ${p.lightRgba(0.75)}; ` +
                `box-shadow: 0 4px 16px ${p.rgba(0.28)};`
            );
        }
    }

    _updateLyricsToggleStyle() {
        if (!this._lyricsToggleBtn)
            return;

        const active = this._isLyricsPanelVisible();
        const p = this._accentPalette;
        if (active) {
            this._lyricsToggleBtn.add_style_class_name('tundra-toggle-active');
            if (p) {
                const bgAlpha = this._lyricsToggleBtn.hover ? 0.34 : 0.22;
                this._lyricsToggleBtn.set_style(
                    `background-color: ${p.rgba(bgAlpha)}; ` +
                    `border-color: ${p.lightRgba(0.58)}; ` +
                    `color: ${p.lightHex};`
                );
            }
        } else {
            this._lyricsToggleBtn.remove_style_class_name('tundra-toggle-active');
            this._lyricsToggleBtn.set_style(null);
        }
    }

    _updatePinButtonStyle() {
        if (!this._pinDesktopBtn)
            return;

        const p = this._accentPalette;
        if (this._desktopWidgetEnabled) {
            this._pinDesktopBtn.add_style_class_name('tundra-ghost-icon-btn-active');
            if (p) {
                const bgAlpha = this._pinDesktopBtn.hover ? 0.38 : 0.26;
                const textColor = this._pinDesktopBtn.hover ? '#ffffff' : p.lighterHex;
                this._pinDesktopBtn.set_style(
                    `background-color: ${p.rgba(bgAlpha)}; ` +
                    `border-color: ${p.lightRgba(0.65)}; ` +
                    `color: ${textColor};`
                );
            }
        } else {
            this._pinDesktopBtn.remove_style_class_name('tundra-ghost-icon-btn-active');
            this._pinDesktopBtn.set_style(null);
        }
    }

    _applyAccentPalette() {
        if (this._destroyed)
            return;

        this._accentPalette = this._controller.getAccentPalette();
        this._updatePlayButtonStyle();
        this._updateLyricsToggleStyle();
        this._updatePinButtonStyle();
        this._updateWaveProgress(this._lastPosUs, this._lastLengthUs);
        if (this._lyricLineLabels.length > 0)
            this._highlightActiveLyric(this._lastActiveLyricIndex, false);
    }

    _applyGlassStyle() {
        if (this._enableGlass)
            this.actor.add_style_class_name('tundra-glass-card');
        else
            this.actor.remove_style_class_name('tundra-glass-card');
    }

    _applySectionVisibility() {
        this._waveBox.visible = true;
        this._lyricsPanel.visible = this._isLyricsPanelVisible();
    }

    _onSettingChanged(key) {
        if (this._destroyed)
            return;

        switch (key) {
        case 'enable-menu-waves':
            this._enableMenuWaves = this._settings.get_boolean('enable-menu-waves');
            this._updateWaveAnimation();
            break;
        case 'waveform-style':
            this._waveformStyle = this._settings.get_string('waveform-style') || 'classic';
            this._rebuildWaveformVisuals();
            break;
        case 'enable-wave-seek':
            this._enableWaveSeek = this._settings.get_boolean('enable-wave-seek');
            if (!this._enableWaveSeek && this._isScrubbing)
                this._endScrub();
            this._updateWaveSeekVisual();
            break;
        case 'enable-glassmorphism':
            this._enableGlass = this._settings.get_boolean('enable-glassmorphism');
            this._applyGlassStyle();
            this._highlightActiveLyric(this._lastActiveLyricIndex, false);
            break;
        case 'desktop-widget-enabled':
            this._desktopWidgetEnabled = this._settings.get_boolean('desktop-widget-enabled');
            this._updatePinButtonStyle();
            break;
        case 'desktop-widget-show-lyrics':
            this._desktopShowLyrics = this._settings.get_boolean('desktop-widget-show-lyrics');
            this._applySectionVisibility();
            this._updateLyricsToggleStyle();
            if (this._isLyricsPanelVisible())
                this.scrollActiveLyricIntoView(false);
            break;
        case 'menu-show-lyrics':
            this._menuShowLyrics = this._settings.get_boolean('menu-show-lyrics');
            this._applySectionVisibility();
            this._updateLyricsToggleStyle();
            if (this._isLyricsPanelVisible())
                this.scrollActiveLyricIntoView(false);
            break;
        case 'language':
            this._strings = getStrings(resolveLanguage(this._settings));
            this.syncAll();
            break;
        }
    }

    setActiveView(active) {
        this._isActiveView = active;
        this._updateWaveAnimation();
        if (active && this._isLyricsPanelVisible())
            this.scrollActiveLyricIntoView(false);
    }

    syncAll() {
        if (this._destroyed)
            return;

        const {player, posUs, lengthUs} = this._controller.getState();
        const t = this._strings.card;

        if (!player) {
            this._sourceLabel.set_text('Tundra Media');
            this._titleLabel.set_text(t.noMediaPlaying);
            this._artistLabel.set_text(t.openPlayerHint);
            this._playPauseIcon.icon_name = 'media-playback-start-symbolic';
            if (this._coverBtn) {
                this._coverBtn.reactive = false;
                this._coverBtn.can_focus = false;
            }
            this._setButtonEnabled(this._prevBtn, false);
            this._setButtonEnabled(this._playPauseBtn, false);
            this._setButtonEnabled(this._nextBtn, false);
            this._updatePlayButtonStyle();
            this._elapsedLabel.set_text('0:00');
            this._durationLabel.set_text('0:00');
            this._updateWaveProgress(0, 0);
        } else {
            const {title, artist} = player.metadata;
            const isPlaying = player.playbackStatus === 'Playing';

            if (this._coverBtn) {
                this._coverBtn.reactive = true;
                this._coverBtn.can_focus = true;
            }
            this._sourceLabel.set_text(player.identity || t.mediaPlayer);
            this._titleLabel.set_text(title || t.untitled);
            this._artistLabel.set_text(artist || t.unknownArtist);
            this._playPauseIcon.icon_name = isPlaying
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic';

            this._setButtonEnabled(this._prevBtn, player.canGoPrevious);
            this._setButtonEnabled(this._playPauseBtn, player.canPlay || player.canPause);
            this._setButtonEnabled(this._nextBtn, player.canGoNext);
            this._updatePlayButtonStyle();

            this._syncPosition({
                posUs,
                lengthUs,
                activeLyricIndex: this._controller.getState().activeLyricIndex,
                lyricChanged: false,
            });
        }

        this._syncArt();
        this._syncLyrics();
        this._updateWaveAnimation();
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
            this._coverActor.set_style(`background-image: url("${safeUri}");`);
            this._coverFallback.visible = false;
        } else {
            this._coverActor.set_style(null);
            this._coverFallback.visible = true;
        }
    }

    _estimatePlainLyricIndex(posUs, lengthUs) {
        if (!this._isPlainLyricsMode || this._plainScrollableIndices.length === 0 || lengthUs <= 0)
            return -1;
        const ratio = Math.max(0, Math.min(1, posUs / lengthUs));
        const norm = Math.max(0, Math.min(1, (ratio - 0.04) / 0.92));
        const posInList = Math.min(
            this._plainScrollableIndices.length - 1,
            Math.floor(norm * this._plainScrollableIndices.length)
        );
        return this._plainScrollableIndices[posInList];
    }

    _syncLyrics() {
        if (this._destroyed)
            return;

        const {
            player,
            posUs,
            lengthUs,
            lyricsData,
            lyricsLoading,
            lyricsFetchEnabled,
            activeLyricIndex,
        } = this._controller.getState();

        const t = this._strings.card;
        let statusText = '';
        if (!player)
            statusText = t.waitingPlayback;
        else if (!lyricsFetchEnabled)
            statusText = t.lyricsDisabled;
        else if (lyricsLoading)
            statusText = t.lyricsLoading;
        else if (!lyricsData.found)
            statusText = t.lyricsUnavailable;
        else if (lyricsData.instrumental && lyricsData.syncedLines.length === 0 && lyricsData.plainLines.length === 0)
            statusText = t.instrumental;

        const sig = statusText
            ? `status:${statusText}`
            : `lines:${lyricsData.syncedLines.length}:${lyricsData.plainLines.length}:${lyricsData.syncedLines[0]?.text || lyricsData.plainLines[0] || ''}`;

        if (sig !== this._lastLyricsSig) {
            this._lastLyricsSig = sig;
            this._lastActiveLyricIndex = -2;
            this._rebuildLyricsContent(statusText, lyricsData);
        }

        const effectiveIdx = lyricsData.syncedLines.length > 0
            ? activeLyricIndex
            : this._estimatePlainLyricIndex(posUs, lengthUs);

        if (this._lyricLineLabels.length > 0 && effectiveIdx !== this._lastActiveLyricIndex) {
            this._lastActiveLyricIndex = effectiveIdx;
            this._highlightActiveLyric(effectiveIdx, true);
        }
    }

    _rebuildLyricsContent(statusText, lyricsData) {
        for (const lbl of this._lyricLineLabels)
            lbl.remove_all_transitions();

        this._lyricsContent.destroy_all_children();
        this._lyricLineLabels = [];
        this._plainScrollableIndices = [];
        this._isPlainLyricsMode = false;

        if (statusText) {
            this._lyricsScroll.vscrollbar_policy = St.PolicyType.NEVER;
            this._lyricsScroll.add_style_class_name('tundra-lyrics-scroll-status');
            this._lyricsContent.set_style('padding: 4px 10px;');
            this._lyricsContent.add_child(new St.Label({
                style_class: 'tundra-lyrics-status',
                text: statusText,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        this._lyricsScroll.vscrollbar_policy = St.PolicyType.AUTOMATIC;
        this._lyricsScroll.remove_style_class_name('tundra-lyrics-scroll-status');
        this._lyricsContent.set_style(null);

        if (lyricsData.syncedLines.length > 0) {
            for (const line of lyricsData.syncedLines) {
                const label = new St.Label({
                    style_class: 'tundra-lyric-line',
                    text: line.text || '♪',
                    x_expand: true,
                });
                label.clutter_text.line_wrap = true;
                label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                this._lyricLineLabels.push(label);
                this._lyricsContent.add_child(label);
            }
            return;
        }

        this._isPlainLyricsMode = lyricsData.plainLines.length > 0;
        for (let i = 0; i < lyricsData.plainLines.length; i++) {
            const lineText = lyricsData.plainLines[i];
            const label = new St.Label({
                style_class: 'tundra-lyric-line tundra-lyric-line-plain',
                text: lineText || ' ',
                x_expand: true,
            });
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            this._lyricLineLabels.push(label);
            if (lineText.trim().length > 0)
                this._plainScrollableIndices.push(i);
            this._lyricsContent.add_child(label);
        }
    }

    _syncPosition(payload) {
        if (this._destroyed || !payload)
            return;

        const {posUs, lengthUs, activeLyricIndex, lyricChanged} = payload;
        if (!this._isScrubbing) {
            this._lastPosUs = posUs;
            this._lastLengthUs = lengthUs;
            this._elapsedLabel.set_text(formatMicroseconds(posUs));
            this._durationLabel.set_text(lengthUs > 0 ? formatMicroseconds(lengthUs) : '--:--');
            this._updateWaveProgress(posUs, lengthUs);
        }

        const effectiveIdx = this._isPlainLyricsMode
            ? this._estimatePlainLyricIndex(posUs, lengthUs)
            : activeLyricIndex;

        if ((lyricChanged && !this._isPlainLyricsMode) || effectiveIdx !== this._lastActiveLyricIndex) {
            this._lastActiveLyricIndex = effectiveIdx;
            this._highlightActiveLyric(effectiveIdx, true);
        }
    }

    _updateWaveProgress(posUs, lengthUs) {
        this._lastPosUs = posUs;
        this._lastLengthUs = lengthUs;
        const ratio = lengthUs > 0 ? Math.max(0, Math.min(1, posUs / lengthUs)) : 0;
        this._lastRatio = ratio;
        this._waveCanvas?.queue_repaint();
    }

    _updateWaveAnimation() {
        if (this._waveformStyle === 'pill-slider') {
            this._stopWaveAnimation();
            this._waveCanvas?.queue_repaint();
            return;
        }

        const {player} = this._controller.getState();
        const isPlaying = player?.playbackStatus === 'Playing';

        if (this._enableMenuWaves && this._isActiveView && isPlaying)
            this._startWaveAnimation();
        else
            this._stopWaveAnimation();
    }

    _startWaveAnimation() {
        if (this._waveformStyle === 'pill-slider' || this._waveTimerId)
            return;

        const tick = () => {
            if (this._destroyed || !this._isActiveView || this._waveformStyle === 'pill-slider') {
                this._waveTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._wavePhase += 0.28;
            this._waveCanvas?.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        };

        tick();
        this._waveTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WAVE_ANIM_INTERVAL_MS, tick);
    }

    _stopWaveAnimation() {
        if (this._waveTimerId) {
            GLib.Source.remove(this._waveTimerId);
            this._waveTimerId = 0;
        }
        this._waveCanvas?.queue_repaint();
    }

    _applyBlurToLine(lbl, blurRadius) {
        if (blurRadius <= 0 || !this._enableGlass) {
            if (lbl._tundraBlur) {
                lbl.remove_effect(lbl._tundraBlur);
                lbl._tundraBlur = null;
            }
            return;
        }

        if (!lbl._tundraBlur) {
            lbl._tundraBlur = new Shell.BlurEffect({
                mode: Shell.BlurMode.ACTOR,
                radius: blurRadius,
                brightness: 1.0,
            });
            lbl.add_effect(lbl._tundraBlur);
        } else if (lbl._tundraBlur.radius !== blurRadius) {
            lbl._tundraBlur.radius = blurRadius;
        }
    }

    _highlightActiveLyric(activeIdx, animateScroll) {
        if (this._lyricLineLabels.length === 0)
            return;

        const p = this._accentPalette;

        for (let i = 0; i < this._lyricLineLabels.length; i++) {
            const lbl = this._lyricLineLabels[i];
            lbl.remove_style_class_name('tundra-lyric-line-active');
            lbl.remove_style_class_name('tundra-lyric-line-near');
            lbl.remove_style_class_name('tundra-lyric-line-past');

            if (activeIdx < 0) {
                lbl.set_style(null);
                this._applyBlurToLine(lbl, 0);
                lbl.ease({
                    opacity: 185,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                continue;
            }

            const dist = Math.abs(i - activeIdx);
            if (dist === 0) {
                lbl.add_style_class_name('tundra-lyric-line-active');
                if (p) {
                    lbl.set_style(
                        'background-gradient-direction: horizontal; ' +
                        `background-gradient-start: ${p.rgba(0.28)}; ` +
                        `background-gradient-end: ${p.rgba(0.06)}; ` +
                        `border: 1px solid ${p.lightRgba(0.42)};`
                    );
                }
                this._applyBlurToLine(lbl, 0);
                lbl.ease({
                    opacity: 255,
                    duration: 240,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else if (dist === 1) {
                lbl.set_style(null);
                lbl.add_style_class_name('tundra-lyric-line-near');
                if (i < activeIdx)
                    lbl.add_style_class_name('tundra-lyric-line-past');
                this._applyBlurToLine(lbl, 0);
                lbl.ease({
                    opacity: 210,
                    duration: 240,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else if (dist === 2) {
                lbl.set_style(null);
                if (i < activeIdx)
                    lbl.add_style_class_name('tundra-lyric-line-past');
                this._applyBlurToLine(lbl, 1);
                lbl.ease({
                    opacity: 155,
                    duration: 240,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                lbl.set_style(null);
                if (i < activeIdx)
                    lbl.add_style_class_name('tundra-lyric-line-past');
                this._applyBlurToLine(lbl, 2);
                lbl.ease({
                    opacity: 115,
                    duration: 240,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        }

        if (this._isActiveView && this._isLyricsPanelVisible())
            this.scrollActiveLyricIntoView(animateScroll);
    }

    _getLyricsVAdjustment() {
        return this._lyricsScroll?.vadjustment
            || this._lyricsScroll?.get_vadjustment?.()
            || this._lyricsScroll?.vscroll?.adjustment
            || this._lyricsScroll?.get_vscroll_bar?.()?.adjustment
            || this._lyricsContent?.vadjustment
            || null;
    }

    _cancelPendingScroll() {
        if (this._pendingScrollId) {
            GLib.Source.remove(this._pendingScrollId);
            this._pendingScrollId = 0;
        }
        if (this._scrollLaterId) {
            if (this._scrollLaterFromCompositor)
                global.compositor?.get_laters?.()?.remove(this._scrollLaterId);
            else
                GLib.Source.remove(this._scrollLaterId);
            this._scrollLaterId = 0;
            this._scrollLaterFromCompositor = false;
        }
    }

    _cancelScrollTween() {
        if (this._scrollTweenId) {
            GLib.Source.remove(this._scrollTweenId);
            this._scrollTweenId = 0;
        }
    }

    scrollActiveLyricIntoView(animate = true) {
        this._cancelPendingScroll();

        if (this._destroyed || !this._isActiveView || !this._isLyricsPanelVisible())
            return;
        if (this._lastActiveLyricIndex < 0 || this._lastActiveLyricIndex >= this._lyricLineLabels.length)
            return;

        const scheduleAfterLayout = () => {
            if (this._destroyed || !this._isActiveView || !this._isLyricsPanelVisible())
                return;
            this._performLyricScroll(animate, 15);
        };

        const laters = global.compositor?.get_laters?.();
        if (laters) {
            this._scrollLaterFromCompositor = true;
            this._scrollLaterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._scrollLaterId = 0;
                this._scrollLaterFromCompositor = false;
                scheduleAfterLayout();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._scrollLaterFromCompositor = false;
            this._scrollLaterId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._scrollLaterId = 0;
                scheduleAfterLayout();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _performLyricScroll(animate, retriesLeft = 0) {
        if (this._destroyed || !this._isActiveView || !this._isLyricsPanelVisible())
            return;
        if (this._lastActiveLyricIndex < 0 || this._lastActiveLyricIndex >= this._lyricLineLabels.length)
            return;

        const target = this._lyricLineLabels[this._lastActiveLyricIndex];
        const vadj = this._getLyricsVAdjustment();

        if (!this._lyricsScroll?.mapped || !target?.mapped || target.height <= 0 || !vadj) {
            if (retriesLeft > 0) {
                this._pendingScrollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
                    this._pendingScrollId = 0;
                    this._performLyricScroll(animate, retriesLeft - 1);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }

        const [currentVal, _lower, upper, _step, _page, pageSize] = vadj.get_values();
        const viewportHeight = pageSize > 0 ? pageSize : this._lyricsScroll.height;
        if (upper <= viewportHeight || viewportHeight <= 0) {
            if (retriesLeft > 0) {
                this._pendingScrollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
                    this._pendingScrollId = 0;
                    this._performLyricScroll(animate, retriesLeft - 1);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }

        const box = target.get_allocation_box();
        let y1 = box.y1;
        let y2 = box.y2;
        let parent = target.get_parent();
        while (parent && parent !== this._lyricsScroll) {
            const pbox = parent.get_allocation_box();
            y1 += pbox.y1;
            y2 += pbox.y1;
            parent = parent.get_parent();
        }

        if (y2 <= y1) {
            ensureActorVisibleInScrollView(this._lyricsScroll, target);
            return;
        }

        const targetCenter = (y1 + y2) / 2;
        const maxScroll = Math.max(0, upper - viewportHeight);
        const destY = Math.max(0, Math.min(maxScroll, targetCenter - viewportHeight / 2));

        this._animateScrollTo(vadj, currentVal, destY, animate);
    }

    _animateScrollTo(vadj, startVal, destY, animate) {
        this._cancelScrollTween();
        vadj.remove_transition?.('value');

        if (!animate || Math.abs(destY - startVal) < 1) {
            vadj.value = destY;
            return;
        }

        const durationUs = 280_000;
        const startUs = GLib.get_monotonic_time();

        this._scrollTweenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (this._destroyed || !this._lyricsScroll?.mapped) {
                this._scrollTweenId = 0;
                return GLib.SOURCE_REMOVE;
            }
            try {
                const elapsedUs = GLib.get_monotonic_time() - startUs;
                const progress = Math.min(1, Math.max(0, elapsedUs / durationUs));
                const eased = 1 - Math.pow(1 - progress, 3);
                vadj.value = startVal + (destY - startVal) * eased;

                if (progress >= 1) {
                    this._scrollTweenId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            } catch (_e) {
                this._scrollTweenId = 0;
                return GLib.SOURCE_REMOVE;
            }
        });
    }

    destroy() {
        this._destroyed = true;
        this._endScrub();
        this._stopWaveAnimation();
        this._cancelPendingScroll();
        this._cancelScrollTween();

        if (!this._actorDestroyed && this._lyricsScroll && this._lyricsMappedId) {
            try {
                this._lyricsScroll.disconnect(this._lyricsMappedId);
            } catch (_e) {
                // Scroll actor may already be disposed
            }
            this._lyricsMappedId = 0;
        }

        if (this._settings && this._settingsId) {
            try {
                this._settings.disconnect(this._settingsId);
            } catch (_e) {
                // Settings may already be disposed
            }
            this._settingsId = 0;
        }
        if (this._controller && this._controllerListener) {
            this._controller.removeListener(this._controllerListener);
            this._controllerListener = null;
        }

        if (!this._actorDestroyed) {
            for (const lbl of this._lyricLineLabels) {
                try {
                    lbl.remove_all_transitions();
                    this._applyBlurToLine(lbl, 0);
                } catch (_e) {
                    // Label may already be disposed
                }
            }
        }

        this._lyricLineLabels = [];
        this._plainScrollableIndices = [];
        this._waveCanvas = null;
        this._onOpenPreferences = null;
        this._onCloseMenu = null;
        this._settings = null;
        this._controller = null;

        if (!this._actorDestroyed && this.actor) {
            this._actorDestroyed = true;
            try {
                this.actor.destroy();
            } catch (_e) {
                // Actor already destroyed by parent container
            }
        }
    }
}
