import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MediaPlayerCard} from './playerCard.js';

const DEFAULT_WIDGET_WIDTH = 368;
const DEFAULT_MARGIN_RIGHT = 36;
const DEFAULT_MARGIN_TOP = 72;

export class TundraDesktopWidget {
    constructor(controller, settings, onOpenPreferences) {
        this._controller = controller;
        this._settings = settings;
        this._onOpenPreferences = onOpenPreferences;
        this._destroyed = false;

        this._layer = settings.get_string('desktop-widget-layer') || 'desktop';
        this._locked = settings.get_boolean('desktop-widget-locked');
        this._enableGlass = settings.get_boolean('enable-glassmorphism');
        this._accentPalette = controller.getAccentPalette();

        this._dragging = false;
        this._dragCandidate = false;
        this._dragGrab = null;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._dragOffsetX = 0;
        this._dragOffsetY = 0;
        this._restacking = false;
        this._restackIdleId = 0;

        this._layerSignalIds = [];
        this._overviewSignalIds = [];
        this._windowActorSignals = new Map();

        this._buildUi();
        this._applyBlur();
        this._applyAccentPalette();
        this._mountToLayer();
        this._applySavedPosition();

        this._controllerListener = {
            onAccentChanged: () => this._applyAccentPalette(),
        };
        this._controller.addListener(this._controllerListener);

        this._settingsId = this._settings.connect('changed', (_s, key) => {
            this._onSettingChanged(key);
        });

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => {
            if (!this._destroyed)
                this._applySavedPosition();
        });
    }

    _buildUi() {
        this._container = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'tundra-desktop-widget',
            reactive: true,
            track_hover: true,
        });
        this._container.layout_manager.spacing = 6;

        // Top handle for dragging, settings, locking, or closing the widget
        const topHandle = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'tundra-desktop-handle',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const leftSpacer = new St.Widget({
            width: 96,
            x_expand: true,
        });
        topHandle.add_child(leftSpacer);

        this._gripPill = new St.Widget({
            style_class: 'tundra-desktop-grip',
            y_align: Clutter.ActorAlign.CENTER,
        });
        topHandle.add_child(this._gripPill);

        const rightBox = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._actionsBox = new St.BoxLayout({
            style_class: 'tundra-desktop-actions',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._actionsBox.layout_manager.spacing = 6;

        this._prefsBtn = this._createHandleButton(
            'preferences-system-symbolic',
            'tundra-ghost-icon-btn',
            () => this._onOpenPreferences?.()
        );
        this._actionsBox.add_child(this._prefsBtn);

        this._lockIcon = new St.Icon({
            icon_name: this._locked ? 'changes-prevent-symbolic' : 'changes-allow-symbolic',
            icon_size: 14,
            reactive: false,
        });
        this._lockBtn = new St.Button({
            style_class: this._locked
                ? 'tundra-ghost-icon-btn tundra-ghost-icon-btn-active'
                : 'tundra-ghost-icon-btn',
            child: this._lockIcon,
            reactive: true,
            track_hover: true,
            can_focus: true,
            button_mask: St.ButtonMask.PRIMARY ?? St.ButtonMask.ONE,
        });
        this._attachHandleHover(this._lockBtn);
        this._lockBtn.connect('notify::hover', () => this._updateLockButtonStyle());
        this._lockBtn.connect('clicked', () => {
            const nextLocked = !this._settings.get_boolean('desktop-widget-locked');
            this._settings.set_boolean('desktop-widget-locked', nextLocked);
        });
        this._actionsBox.add_child(this._lockBtn);

        this._closeBtn = this._createHandleButton(
            'window-close-symbolic',
            'tundra-ghost-icon-btn',
            () => this._settings.set_boolean('desktop-widget-enabled', false)
        );
        this._actionsBox.add_child(this._closeBtn);

        rightBox.add_child(this._actionsBox);
        topHandle.add_child(rightBox);
        this._container.add_child(topHandle);

        this._card = new MediaPlayerCard({
            controller: this._controller,
            settings: this._settings,
            variant: 'desktop',
            onOpenPreferences: this._onOpenPreferences,
        });
        this._container.add_child(this._card.actor);

        this._container.connect('notify::hover', () => this._updateWidgetAccentChrome());
        this._container.connect('button-press-event', (_actor, event) => {
            return this._onButtonPress(event);
        });
        this._container.connect('motion-event', (_actor, event) => {
            return this._onMotion(event);
        });
        this._container.connect('button-release-event', (_actor, event) => {
            return this._onButtonRelease(event);
        });
    }

    _createHandleButton(iconName, styleClass, onClick) {
        const btn = new St.Button({
            style_class: styleClass,
            child: new St.Icon({
                icon_name: iconName,
                icon_size: 14,
                reactive: false,
            }),
            reactive: true,
            track_hover: true,
            can_focus: true,
            button_mask: St.ButtonMask.PRIMARY ?? St.ButtonMask.ONE,
        });
        this._attachHandleHover(btn);
        btn.connect('clicked', onClick);
        return btn;
    }

    _attachHandleHover(btn) {
        btn.set_pivot_point(0.5, 0.5);
        btn.connect('enter-event', () => {
            btn.ease({
                scale_x: 1.08,
                scale_y: 1.08,
                duration: 130,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return Clutter.EVENT_PROPAGATE;
        });
        btn.connect('leave-event', () => {
            btn.ease({
                scale_x: 1.0,
                scale_y: 1.0,
                duration: 140,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _isInteractiveSubtarget(actor, stageX, stageY) {
        if (this._actionsBox) {
            const [ax, ay] = this._actionsBox.get_transformed_position();
            const [aw, ah] = this._actionsBox.get_transformed_size();
            if (aw > 0 && ah > 0 &&
                stageX >= ax - 4 && stageX <= ax + aw + 4 &&
                stageY >= ay - 4 && stageY <= ay + ah + 4)
                return true;
        }

        let cur = actor;
        while (cur && cur !== this._container) {
            if (cur instanceof St.Button ||
                cur === this._actionsBox ||
                cur === this._card?._coverBtn ||
                cur === this._card?._waveBox ||
                cur === this._card?._lyricsScroll)
                return true;
            cur = cur.get_parent();
        }
        return false;
    }

    _onButtonPress(event) {
        if (this._destroyed || this._locked || event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;

        const [stageX, stageY] = event.get_coords();
        if (this._isInteractiveSubtarget(event.get_source(), stageX, stageY))
            return Clutter.EVENT_PROPAGATE;

        this._dragCandidate = true;
        this._dragStartX = stageX;
        this._dragStartY = stageY;
        this._dragOffsetX = stageX - this._container.x;
        this._dragOffsetY = stageY - this._container.y;
        return Clutter.EVENT_PROPAGATE;
    }

    _onMotion(event) {
        if (this._destroyed)
            return Clutter.EVENT_PROPAGATE;

        if (this._dragCandidate && !this._dragging) {
            const [stageX, stageY] = event.get_coords();
            const dx = stageX - this._dragStartX;
            const dy = stageY - this._dragStartY;
            if (Math.hypot(dx, dy) < 4)
                return Clutter.EVENT_PROPAGATE;

            this._dragCandidate = false;
            this._dragging = true;
            this._dragGrab = global.stage.grab(this._container);
            this._container.add_style_class_name('tundra-desktop-widget-dragging');
            this._updateWidgetAccentChrome();
        }

        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;

        const [stageX, stageY] = event.get_coords();
        const clamped = this._clampPosition(
            stageX - this._dragOffsetX,
            stageY - this._dragOffsetY
        );
        this._container.set_position(clamped.x, clamped.y);
        return Clutter.EVENT_STOP;
    }

    _onButtonRelease(event) {
        if (this._dragCandidate && !this._dragging) {
            this._dragCandidate = false;
            return Clutter.EVENT_PROPAGATE;
        }

        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;

        if (event.get_button() !== 1)
            return Clutter.EVENT_STOP;

        this._endDrag();
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        this._dragCandidate = false;
        this._dragging = false;
        if (this._dragGrab) {
            this._dragGrab.dismiss();
            this._dragGrab = null;
        }
        this._container.remove_style_class_name('tundra-desktop-widget-dragging');
        this._updateWidgetAccentChrome();

        if (!this._destroyed && this._settings) {
            this._settings.set_int('desktop-widget-x', Math.round(this._container.x));
            this._settings.set_int('desktop-widget-y', Math.round(this._container.y));
        }
    }

    _clampPosition(x, y) {
        const w = this._container.width > 0 ? this._container.width : DEFAULT_WIDGET_WIDTH;
        const h = this._container.height > 0 ? this._container.height : 320;
        const maxX = Math.max(12, global.screen_width - w - 12);
        const maxY = Math.max(40, global.screen_height - h - 12);
        return {
            x: Math.round(Math.max(12, Math.min(maxX, x))),
            y: Math.round(Math.max(40, Math.min(maxY, y))),
        };
    }

    _applySavedPosition() {
        const savedX = this._settings.get_int('desktop-widget-x');
        const savedY = this._settings.get_int('desktop-widget-y');

        if (savedX >= 0 && savedY >= 0) {
            const clamped = this._clampPosition(savedX, savedY);
            this._container.set_position(clamped.x, clamped.y);
            return;
        }

        const monitor = Main.layoutManager.primaryMonitor || Main.layoutManager.monitors[0];
        if (!monitor) {
            this._container.set_position(48, DEFAULT_MARGIN_TOP);
            return;
        }

        const w = this._container.width > 0 ? this._container.width : DEFAULT_WIDGET_WIDTH;
        const defaultX = monitor.x + monitor.width - w - DEFAULT_MARGIN_RIGHT;
        const defaultY = monitor.y + DEFAULT_MARGIN_TOP;
        const clamped = this._clampPosition(defaultX, defaultY);
        this._container.set_position(clamped.x, clamped.y);
    }

    _applyBlur() {
        // Keep glass styling in CSS so St clips rounded corners cleanly without rectangular blur bleed
        if (this._enableGlass)
            this._container.add_style_class_name('tundra-glass-widget');
        else
            this._container.remove_style_class_name('tundra-glass-widget');
    }

    _trackWindowActor(actor) {
        if (!actor || actor === this._container || this._windowActorSignals.has(actor))
            return;

        const signals = [];
        const visId = actor.connect('notify::visible', () => this._scheduleRestack());
        signals.push({obj: actor, id: visId});

        const mw = actor.meta_window;
        if (mw) {
            signals.push({
                obj: mw,
                id: mw.connect('notify::window-type', () => this._scheduleRestack()),
            });
            signals.push({
                obj: mw,
                id: mw.connect('notify::title', () => this._scheduleRestack()),
            });
            signals.push({
                obj: mw,
                id: mw.connect('notify::minimized', () => this._scheduleRestack()),
            });
        }

        this._windowActorSignals.set(actor, signals);
    }

    _untrackWindowActor(actor) {
        const signals = this._windowActorSignals.get(actor);
        if (!signals)
            return;
        for (const item of signals) {
            if (item.obj && item.id)
                item.obj.disconnect(item.id);
        }
        this._windowActorSignals.delete(actor);
    }

    _isDesktopAnchorActor(actor) {
        if (!actor)
            return false;
        if (actor === Main.layoutManager._backgroundGroup)
            return true;
        const mw = actor.meta_window;
        if (!mw)
            return false;
        if (mw.window_type === Meta.WindowType.DESKTOP)
            return true;
        const title = mw.get_title?.() || '';
        return title.startsWith('Desktop Icons ');
    }

    _isVisibleNormalWindow(actor) {
        const mw = actor?.meta_window;
        if (!mw || this._isDesktopAnchorActor(actor))
            return false;
        if (!actor.visible || mw.minimized)
            return false;
        if (typeof mw.showing_on_its_workspace === 'function' && !mw.showing_on_its_workspace())
            return false;
        return true;
    }

    _mountToLayer() {
        this._unmountFromLayer();

        if (this._layer === 'floating') {
            Main.layoutManager.addChrome(this._container, {
                affectsStruts: false,
                trackFullscreen: true,
            });
        } else {
            global.window_group.add_child(this._container);
            for (const child of global.window_group.get_children())
                this._trackWindowActor(child);
            this._restackInWindowGroup();

            this._layerSignalIds.push({
                obj: global.display,
                id: global.display.connect('restacked', () => this._scheduleRestack()),
            });
            this._layerSignalIds.push({
                obj: global.display,
                id: global.display.connect('notify::focus-window', () => this._scheduleRestack()),
            });
            this._layerSignalIds.push({
                obj: global.window_group,
                id: global.window_group.connect('child-added', (_grp, child) => {
                    this._trackWindowActor(child);
                    this._scheduleRestack();
                }),
            });
            this._layerSignalIds.push({
                obj: global.window_group,
                id: global.window_group.connect('child-removed', (_grp, child) => {
                    this._untrackWindowActor(child);
                    this._scheduleRestack();
                }),
            });
            if (global.window_manager) {
                for (const sig of ['map', 'minimize', 'unminimize', 'switch-workspace']) {
                    this._layerSignalIds.push({
                        obj: global.window_manager,
                        id: global.window_manager.connect(sig, () => this._scheduleRestack()),
                    });
                }
            }
            if (global.workspace_manager) {
                this._layerSignalIds.push({
                    obj: global.workspace_manager,
                    id: global.workspace_manager.connect('active-workspace-changed', () => this._scheduleRestack()),
                });
            }
        }

        this._overviewSignalIds.push(
            Main.overview.connect('showing', () => {
                if (!this._destroyed)
                    this._container.visible = false;
            })
        );
        this._overviewSignalIds.push(
            Main.overview.connect('hiding', () => {
                if (!this._destroyed) {
                    this._container.visible = true;
                    if (this._layer === 'desktop')
                        this._scheduleRestack();
                }
            })
        );
        this._container.visible = !Main.overview.visible;
    }

    _scheduleRestack() {
        if (this._destroyed || this._restacking || this._restackIdleId)
            return;
        this._restackIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._restackIdleId = 0;
            if (!this._destroyed && this._layer === 'desktop')
                this._restackInWindowGroup();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Keep widget above wallpaper and DING, below all visible normal windows
    _restackInWindowGroup() {
        if (this._destroyed || this._restacking || this._container.get_parent() !== global.window_group)
            return;

        this._restacking = true;
        try {
            let desktopAnchor = Main.layoutManager._backgroundGroup || null;
            let firstWindow = null;

            for (const child of global.window_group.get_children()) {
                if (child === this._container)
                    continue;
                if (this._isDesktopAnchorActor(child)) {
                    desktopAnchor = child;
                    firstWindow = null;
                    continue;
                }
                if (!firstWindow && this._isVisibleNormalWindow(child))
                    firstWindow = child;
            }

            if (firstWindow && firstWindow.get_parent() === global.window_group)
                global.window_group.set_child_below_sibling(this._container, firstWindow);
            else if (desktopAnchor && desktopAnchor.get_parent() === global.window_group)
                global.window_group.set_child_above_sibling(this._container, desktopAnchor);
            else
                global.window_group.set_child_above_sibling(this._container, null);
        } finally {
            this._restacking = false;
        }
    }

    _unmountFromLayer() {
        if (this._restackIdleId) {
            GLib.Source.remove(this._restackIdleId);
            this._restackIdleId = 0;
        }

        for (const actor of [...this._windowActorSignals.keys()])
            this._untrackWindowActor(actor);

        for (const item of this._layerSignalIds) {
            if (item.obj && item.id)
                item.obj.disconnect(item.id);
        }
        this._layerSignalIds = [];

        for (const id of this._overviewSignalIds)
            Main.overview.disconnect(id);
        this._overviewSignalIds = [];

        const parent = this._container.get_parent();
        if (!parent)
            return;

        if (parent === Main.layoutManager.uiGroup)
            Main.layoutManager.removeChrome(this._container);
        else
            parent.remove_child(this._container);
    }

    _applyAccentPalette() {
        if (this._destroyed)
            return;

        this._accentPalette = this._controller.getAccentPalette();
        this._updateLockButtonStyle();
        this._updateWidgetAccentChrome();
    }

    _updateLockButtonStyle() {
        if (!this._lockBtn)
            return;

        const p = this._accentPalette;
        if (this._locked) {
            this._lockBtn.add_style_class_name('tundra-ghost-icon-btn-active');
            if (p) {
                const bgAlpha = this._lockBtn.hover ? 0.38 : 0.26;
                const textColor = this._lockBtn.hover ? '#ffffff' : p.lighterHex;
                this._lockBtn.set_style(
                    `background-color: ${p.rgba(bgAlpha)}; ` +
                    `border-color: ${p.lightRgba(0.65)}; ` +
                    `color: ${textColor};`
                );
            }
        } else {
            this._lockBtn.remove_style_class_name('tundra-ghost-icon-btn-active');
            this._lockBtn.set_style(null);
        }
    }

    _updateWidgetAccentChrome() {
        if (!this._container || !this._gripPill)
            return;

        const p = this._accentPalette;
        if (!p) {
            this._container.set_style(null);
            this._gripPill.set_style(null);
            return;
        }

        if (this._dragging) {
            this._container.set_style(`border-color: ${p.lightRgba(0.65)};`);
            this._gripPill.set_style(`background-color: ${p.lightRgba(0.68)};`);
        } else if (this._container.hover) {
            this._container.set_style(`border-color: ${p.lightRgba(0.32)};`);
            this._gripPill.set_style(`background-color: ${p.lightRgba(0.58)};`);
        } else {
            this._container.set_style(null);
            this._gripPill.set_style(null);
        }
    }

    _onSettingChanged(key) {
        if (this._destroyed)
            return;

        switch (key) {
        case 'desktop-widget-layer':
            this._layer = this._settings.get_string('desktop-widget-layer') || 'desktop';
            this._mountToLayer();
            this._applySavedPosition();
            break;
        case 'desktop-widget-locked':
            this._locked = this._settings.get_boolean('desktop-widget-locked');
            this._lockIcon.icon_name = this._locked
                ? 'changes-prevent-symbolic'
                : 'changes-allow-symbolic';
            if (this._locked && this._dragging)
                this._endDrag();
            this._updateLockButtonStyle();
            break;
        case 'enable-glassmorphism':
            this._enableGlass = this._settings.get_boolean('enable-glassmorphism');
            this._applyBlur();
            break;
        case 'desktop-widget-x':
        case 'desktop-widget-y':
            if (!this._dragging)
                this._applySavedPosition();
            break;
        }
    }

    destroy() {
        this._destroyed = true;
        if (this._dragging)
            this._endDrag();

        if (this._controller && this._controllerListener) {
            this._controller.removeListener(this._controllerListener);
            this._controllerListener = null;
        }
        if (this._settings && this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }

        this._unmountFromLayer();

        this._card?.destroy();
        this._card = null;

        this._container?.destroy();
        this._container = null;
        this._settings = null;
        this._controller = null;
    }
}
