import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ACCENT_PRESETS, getPresetByHex, hexToRgb, normalizeHex} from './src/ui/accentColor.js';
import {clearCoverCache, syncAutostartEntry} from './src/core/autostart.js';
import {getStrings, resolveLanguage} from './src/core/i18n.js';

const LANGUAGE_KEYS = ['auto', 'pt', 'en'];
const PANEL_POSITION_KEYS = ['left', 'center', 'right'];
const WIDGET_LAYER_KEYS = ['desktop', 'floating'];
const WAVEFORM_STYLE_KEYS = [
    'classic',
    'mirror',
    'equalizer',
    'dots',
    'pill-slider',
    'blocks',
    'sine-wave',
    'pulse-ribbon',
    'heartbeat',
    'dual-rail',
];
const PILL_EQ_STYLE_KEYS = [
    'bars',
    'mirror',
    'equalizer',
    'sine',
    'dots',
    'blocks',
    'pulse',
];

const ALL_SETTINGS_KEYS = [
    'language',
    'panel-position',
    'marquee-max-width',
    'show-when-idle',
    'show-lyrics-in-pill',
    'enable-lyrics-fetch',
    'enable-album-art',
    'enable-vinyl-spin',
    'enable-pill-eq',
    'pill-eq-style',
    'enable-menu-waves',
    'waveform-style',
    'enable-wave-seek',
    'enable-glassmorphism',
    'accent-color',
    'accent-from-music',
    'menu-show-lyrics',
    'desktop-widget-enabled',
    'desktop-widget-layer',
    'desktop-widget-locked',
    'desktop-widget-show-lyrics',
    'desktop-widget-x',
    'desktop-widget-y',
    'autostart-enabled',
];

function createSwitchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({
        title,
        subtitle,
    });
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function mapOptions(keys, labelMap) {
    return keys.map(key => ({
        key,
        label: labelMap[key] || key,
    }));
}

function bindComboRow(settings, key, items, row) {
    const syncFromSettings = () => {
        const current = settings.get_string(key);
        const idx = items.findIndex(item => item.key === current);
        const targetIdx = idx >= 0 ? idx : 0;
        if (row.selected !== targetIdx)
            row.selected = targetIdx;
    };
    syncFromSettings();

    row.connect('notify::selected', () => {
        const item = items[row.selected];
        if (item && settings.get_string(key) !== item.key)
            settings.set_string(key, item.key);
    });

    return syncFromSettings;
}

function isLightSwatch(hex) {
    const {r, g, b} = hexToRgb(hex);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.58;
}

function createAccentCssProvider() {
    const lines = [
        `.tundra-swatch-btn {
            min-width: 34px;
            min-height: 34px;
            padding: 0;
            border-radius: 9999px;
            border: 2px solid rgba(255, 255, 255, 0.18);
            box-shadow: none;
            transition: transform 120ms ease, border-color 120ms ease;
        }`,
        `.tundra-swatch-btn:hover {
            transform: scale(1.08);
            border-color: rgba(255, 255, 255, 0.55);
        }`,
        `.tundra-swatch-btn.tundra-swatch-selected {
            border: 2px solid #ffffff;
            outline: 2px solid rgba(255, 255, 255, 0.35);
        }`,
        `.tundra-swatch-btn.tundra-swatch-adaptive {
            opacity: 0.55;
        }`,
        `.tundra-swatch-icon-light {
            color: #ffffff;
        }`,
        `.tundra-swatch-icon-dark {
            color: #10141c;
        }`,
    ];

    for (const preset of ACCENT_PRESETS) {
        lines.push(`.tundra-swatch-${preset.id} {
            background-color: ${preset.hex};
            background-image: none;
        }`);
    }

    const provider = new Gtk.CssProvider();
    provider.load_from_string(lines.join('\n'));
    return provider;
}

export default class TundraMediaPillPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(580, 740);

        const display = Gdk.Display.get_default();
        const accentCssProvider = createAccentCssProvider();
        if (display) {
            Gtk.StyleContext.add_provider_for_display(
                display,
                accentCssProvider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            );
        }

        let settingsPage = null;
        let aboutPage = null;
        let pageChangedId = 0;
        let rebuildIdleId = 0;
        let windowDestroyed = false;

        const clearPages = () => {
            if (pageChangedId) {
                settings.disconnect(pageChangedId);
                pageChangedId = 0;
            }
            if (settingsPage) {
                window.remove(settingsPage);
                settingsPage = null;
            }
            if (aboutPage) {
                window.remove(aboutPage);
                aboutPage = null;
            }
        };

        const buildPages = (restoreAboutTab = false) => {
            if (windowDestroyed)
                return;

            clearPages();

            const lang = resolveLanguage(settings);
            const t = getStrings(lang).prefs;
            window.set_title(t.windowTitle);

            const built = this._buildSettingsPage(window, settings, t);
            settingsPage = built.page;
            pageChangedId = built.settingsChangedId;
            aboutPage = this._buildAboutPage(window, t);

            window.add(settingsPage);
            window.add(aboutPage);
            window.set_visible_page(restoreAboutTab ? aboutPage : settingsPage);
        };

        const langSignalId = settings.connect('changed::language', () => {
            if (windowDestroyed || rebuildIdleId)
                return;
            const onAbout = window.get_visible_page?.() === aboutPage;
            rebuildIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                rebuildIdleId = 0;
                buildPages(onAbout);
                return GLib.SOURCE_REMOVE;
            });
        });

        buildPages(false);

        window.connect('destroy', () => {
            windowDestroyed = true;
            if (rebuildIdleId) {
                GLib.Source.remove(rebuildIdleId);
                rebuildIdleId = 0;
            }
            if (langSignalId)
                settings.disconnect(langSignalId);
            if (pageChangedId) {
                settings.disconnect(pageChangedId);
                pageChangedId = 0;
            }
            if (display && accentCssProvider)
                Gtk.StyleContext.remove_provider_for_display(display, accentCssProvider);
        });
    }

    _buildSettingsPage(window, settings, t) {
        const page = new Adw.PreferencesPage({
            title: t.settingsTab,
            icon_name: 'preferences-system-symbolic',
        });

        // Group 0: Language
        const languageGroup = new Adw.PreferencesGroup({
            title: t.languageGroupTitle,
            description: t.languageGroupDesc,
        });

        const languageOptions = mapOptions(LANGUAGE_KEYS, t.languageOptions);
        const languageRow = new Adw.ComboRow({
            title: t.languageTitle,
            subtitle: t.languageSubtitle,
            model: new Gtk.StringList({
                strings: languageOptions.map(o => o.label),
            }),
        });
        const syncLanguage = bindComboRow(settings, 'language', languageOptions, languageRow);
        languageGroup.add(languageRow);
        page.add(languageGroup);

        // Group 1: Appearance and top bar
        const layoutGroup = new Adw.PreferencesGroup({
            title: t.layoutGroupTitle,
            description: t.layoutGroupDesc,
        });

        const panelPositions = mapOptions(PANEL_POSITION_KEYS, t.panelPositions);
        const positionRow = new Adw.ComboRow({
            title: t.panelPosTitle,
            subtitle: t.panelPosSubtitle,
            model: new Gtk.StringList({
                strings: panelPositions.map(p => p.label),
            }),
        });
        const syncPosition = bindComboRow(settings, 'panel-position', panelPositions, positionRow);
        layoutGroup.add(positionRow);

        layoutGroup.add(createSwitchRow(
            settings,
            'enable-glassmorphism',
            t.glassTitle,
            t.glassSubtitle
        ));

        layoutGroup.add(createSwitchRow(
            settings,
            'show-when-idle',
            t.showIdleTitle,
            t.showIdleSubtitle
        ));

        const widthRow = new Adw.SpinRow({
            title: t.marqueeWidthTitle,
            subtitle: t.marqueeWidthSubtitle,
            adjustment: new Gtk.Adjustment({
                lower: 120,
                upper: 420,
                step_increment: 10,
                page_increment: 20,
                value: settings.get_int('marquee-max-width'),
            }),
        });
        settings.bind('marquee-max-width', widthRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        layoutGroup.add(widthRow);

        page.add(layoutGroup);

        // Group 2: Accent color
        const accentGroup = new Adw.PreferencesGroup({
            title: t.accentGroupTitle,
            description: t.accentGroupDesc,
        });

        accentGroup.add(createSwitchRow(
            settings,
            'accent-from-music',
            t.accentFromMusicTitle,
            t.accentFromMusicSubtitle
        ));

        const paletteContainer = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 14,
            margin_end: 14,
        });

        const paletteHeader = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });
        const paletteTitle = new Gtk.Label({
            label: t.paletteTitle,
            xalign: 0,
            hexpand: true,
        });
        paletteTitle.add_css_class('heading');

        const paletteStatus = new Gtk.Label({
            label: '',
            xalign: 1,
        });
        paletteStatus.add_css_class('dim-label');
        paletteStatus.add_css_class('caption');

        paletteHeader.append(paletteTitle);
        paletteHeader.append(paletteStatus);
        paletteContainer.append(paletteHeader);

        const swatchesBox = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            max_children_per_line: 7,
            min_children_per_line: 4,
            row_spacing: 10,
            column_spacing: 10,
            homogeneous: true,
        });

        const swatchButtons = [];
        for (const preset of ACCENT_PRESETS) {
            const localizedName = t.accentNames[preset.id] || preset.name;
            const checkIcon = new Gtk.Image({
                icon_name: 'object-select-symbolic',
                pixel_size: 16,
                visible: false,
            });
            checkIcon.add_css_class(
                isLightSwatch(preset.hex) ? 'tundra-swatch-icon-dark' : 'tundra-swatch-icon-light'
            );

            const btn = new Gtk.Button({
                child: checkIcon,
                tooltip_text: localizedName,
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
            });
            btn.add_css_class('circular');
            btn.add_css_class('tundra-swatch-btn');
            btn.add_css_class(`tundra-swatch-${preset.id}`);

            btn.connect('clicked', () => {
                settings.set_string('accent-color', preset.hex);
                if (settings.get_boolean('accent-from-music'))
                    settings.set_boolean('accent-from-music', false);
            });

            swatchButtons.push({preset, btn, checkIcon});
            swatchesBox.append(btn);
        }

        paletteContainer.append(swatchesBox);

        const paletteRow = new Adw.PreferencesRow({
            activatable: false,
            child: paletteContainer,
        });
        accentGroup.add(paletteRow);

        const syncAccentUi = () => {
            const currentHex = normalizeHex(settings.get_string('accent-color'));
            const fromMusic = settings.get_boolean('accent-from-music');
            const activePreset = getPresetByHex(currentHex);
            const presetName = activePreset
                ? (t.accentNames[activePreset.id] || activePreset.name)
                : currentHex;

            paletteStatus.label = fromMusic
                ? `${t.paletteAutoPrefix} ${presetName}`
                : presetName;

            for (const {preset, btn, checkIcon} of swatchButtons) {
                const isSelected = preset.hex.toUpperCase() === currentHex;
                checkIcon.visible = isSelected;
                if (isSelected)
                    btn.add_css_class('tundra-swatch-selected');
                else
                    btn.remove_css_class('tundra-swatch-selected');

                if (fromMusic)
                    btn.add_css_class('tundra-swatch-adaptive');
                else
                    btn.remove_css_class('tundra-swatch-adaptive');
            }
        };
        syncAccentUi();

        page.add(accentGroup);

        // Group 3: Desktop widget
        const desktopGroup = new Adw.PreferencesGroup({
            title: t.desktopGroupTitle,
            description: t.desktopGroupDesc,
        });

        desktopGroup.add(createSwitchRow(
            settings,
            'desktop-widget-enabled',
            t.desktopEnableTitle,
            t.desktopEnableSubtitle
        ));

        const widgetLayers = mapOptions(WIDGET_LAYER_KEYS, t.widgetLayers);
        const layerRow = new Adw.ComboRow({
            title: t.desktopLayerTitle,
            subtitle: t.desktopLayerSubtitle,
            model: new Gtk.StringList({
                strings: widgetLayers.map(l => l.label),
            }),
        });
        const syncLayer = bindComboRow(settings, 'desktop-widget-layer', widgetLayers, layerRow);
        desktopGroup.add(layerRow);

        desktopGroup.add(createSwitchRow(
            settings,
            'desktop-widget-show-lyrics',
            t.desktopLyricsTitle,
            t.desktopLyricsSubtitle
        ));

        desktopGroup.add(createSwitchRow(
            settings,
            'desktop-widget-locked',
            t.desktopLockTitle,
            t.desktopLockSubtitle
        ));

        const resetPosBtn = new Gtk.Button({
            label: t.resetPosBtn,
            valign: Gtk.Align.CENTER,
        });
        resetPosBtn.add_css_class('flat');

        const resetPosRow = new Adw.ActionRow({
            title: t.resetPosTitle,
            subtitle: t.resetPosSubtitle,
            activatable_widget: resetPosBtn,
        });
        resetPosRow.add_suffix(resetPosBtn);

        resetPosBtn.connect('clicked', () => {
            settings.reset('desktop-widget-x');
            settings.reset('desktop-widget-y');
            window.add_toast(new Adw.Toast({title: t.resetPosToast}));
        });
        desktopGroup.add(resetPosRow);

        page.add(desktopGroup);

        // Group 4: Animations and waveform
        const animGroup = new Adw.PreferencesGroup({
            title: t.animGroupTitle,
            description: t.animGroupDesc,
        });

        animGroup.add(createSwitchRow(
            settings,
            'enable-vinyl-spin',
            t.vinylSpinTitle,
            t.vinylSpinSubtitle
        ));

        animGroup.add(createSwitchRow(
            settings,
            'enable-pill-eq',
            t.pillEqTitle,
            t.pillEqSubtitle
        ));

        const pillEqOptions = mapOptions(PILL_EQ_STYLE_KEYS, t.pillEqStyles);
        const pillEqStyleRow = new Adw.ComboRow({
            title: t.pillEqStyleTitle,
            subtitle: t.pillEqStyleSubtitle,
            model: new Gtk.StringList({
                strings: pillEqOptions.map(s => s.label),
            }),
        });
        const syncPillEqStyle = bindComboRow(settings, 'pill-eq-style', pillEqOptions, pillEqStyleRow);
        animGroup.add(pillEqStyleRow);

        const waveformOptions = mapOptions(WAVEFORM_STYLE_KEYS, t.waveformStyles);
        const waveStyleRow = new Adw.ComboRow({
            title: t.waveStyleTitle,
            subtitle: t.waveStyleSubtitle,
            model: new Gtk.StringList({
                strings: waveformOptions.map(w => w.label),
            }),
        });
        const syncWaveStyle = bindComboRow(settings, 'waveform-style', waveformOptions, waveStyleRow);
        animGroup.add(waveStyleRow);

        animGroup.add(createSwitchRow(
            settings,
            'enable-menu-waves',
            t.menuWavesTitle,
            t.menuWavesSubtitle
        ));

        animGroup.add(createSwitchRow(
            settings,
            'enable-wave-seek',
            t.waveSeekTitle,
            t.waveSeekSubtitle
        ));

        page.add(animGroup);

        // Group 5: Lyrics and album art
        const mediaGroup = new Adw.PreferencesGroup({
            title: t.mediaGroupTitle,
            description: t.mediaGroupDesc,
        });

        mediaGroup.add(createSwitchRow(
            settings,
            'show-lyrics-in-pill',
            t.lyricsInPillTitle,
            t.lyricsInPillSubtitle
        ));

        mediaGroup.add(createSwitchRow(
            settings,
            'menu-show-lyrics',
            t.menuLyricsTitle,
            t.menuLyricsSubtitle
        ));

        mediaGroup.add(createSwitchRow(
            settings,
            'enable-lyrics-fetch',
            t.lyricsFetchTitle,
            t.lyricsFetchSubtitle
        ));

        mediaGroup.add(createSwitchRow(
            settings,
            'enable-album-art',
            t.albumArtTitle,
            t.albumArtSubtitle
        ));

        const clearCacheBtn = new Gtk.Button({
            label: t.clearCacheBtn,
            valign: Gtk.Align.CENTER,
        });
        clearCacheBtn.add_css_class('flat');

        const clearCacheRow = new Adw.ActionRow({
            title: t.clearCacheTitle,
            subtitle: t.clearCacheSubtitle,
            activatable_widget: clearCacheBtn,
        });
        clearCacheRow.add_suffix(clearCacheBtn);

        clearCacheBtn.connect('clicked', () => {
            const count = clearCoverCache();
            const message = count > 0
                ? t.clearCacheToastSome(count)
                : t.clearCacheToastEmpty;
            window.add_toast(new Adw.Toast({title: message}));
        });
        mediaGroup.add(clearCacheRow);

        page.add(mediaGroup);

        // Group 6: System and startup
        const systemGroup = new Adw.PreferencesGroup({
            title: t.systemGroupTitle,
            description: t.systemGroupDesc,
        });

        systemGroup.add(createSwitchRow(
            settings,
            'autostart-enabled',
            t.autostartTitle,
            t.autostartSubtitle
        ));

        const resetBtn = new Gtk.Button({
            label: t.resetAllBtn,
            valign: Gtk.Align.CENTER,
        });
        resetBtn.add_css_class('destructive-action');

        const resetRow = new Adw.ActionRow({
            title: t.resetAllTitle,
            subtitle: t.resetAllSubtitle,
            activatable_widget: resetBtn,
        });
        resetRow.add_suffix(resetBtn);

        resetBtn.connect('clicked', () => {
            for (const key of ALL_SETTINGS_KEYS)
                settings.reset(key);
            syncAutostartEntry(settings.get_boolean('autostart-enabled'));
            window.add_toast(new Adw.Toast({title: t.resetAllToast}));
        });
        systemGroup.add(resetRow);

        page.add(systemGroup);

        const settingsChangedId = settings.connect('changed', (_s, key) => {
            if (key === 'language')
                syncLanguage();
            else if (key === 'panel-position')
                syncPosition();
            else if (key === 'desktop-widget-layer')
                syncLayer();
            else if (key === 'waveform-style')
                syncWaveStyle();
            else if (key === 'pill-eq-style')
                syncPillEqStyle();
            else if (key === 'accent-color' || key === 'accent-from-music')
                syncAccentUi();
            else if (key === 'autostart-enabled')
                syncAutostartEntry(settings.get_boolean('autostart-enabled'));
        });

        return {page, settingsChangedId};
    }

    _buildAboutPage(window, t) {
        const aboutPage = new Adw.PreferencesPage({
            title: t.aboutTab,
            icon_name: 'help-about-symbolic',
        });

        const versionStr = this.metadata['version-name'] || String(this.metadata.version ?? '3.2.5');

        // Header card
        const heroGroup = new Adw.PreferencesGroup();
        const heroBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            halign: Gtk.Align.CENTER,
            margin_top: 18,
            margin_bottom: 18,
            margin_start: 16,
            margin_end: 16,
        });

        const iconPath = GLib.build_filenamev([this.path, 'icons', 'tundra-media-pill.svg']);
        const appIcon = Gio.File.new_for_path(iconPath).query_exists(null)
            ? new Gtk.Image({file: iconPath, pixel_size: 84})
            : new Gtk.Image({icon_name: 'media-optical-cd-audio-symbolic', pixel_size: 56});
        heroBox.append(appIcon);

        const appTitle = new Gtk.Label({
            label: this.metadata.name || 'Tundra Media Pill',
        });
        appTitle.add_css_class('title-1');
        heroBox.append(appTitle);

        const versionLabel = new Gtk.Label({
            label: `v${versionStr}`,
        });
        versionLabel.add_css_class('dim-label');
        heroBox.append(versionLabel);

        const appDesc = new Gtk.Label({
            label: t.aboutDesc,
            wrap: true,
            justify: Gtk.Justification.CENTER,
            max_width_chars: 46,
            margin_top: 4,
        });
        appDesc.add_css_class('body');
        heroBox.append(appDesc);

        const heroRow = new Adw.PreferencesRow({
            activatable: false,
            child: heroBox,
        });
        heroGroup.add(heroRow);
        aboutPage.add(heroGroup);

        // Project info
        const infoGroup = new Adw.PreferencesGroup({
            title: t.aboutProjectGroup,
        });

        const addInfoRow = (title, value) => {
            const valLabel = new Gtk.Label({
                label: value,
                valign: Gtk.Align.CENTER,
                selectable: true,
            });
            valLabel.add_css_class('dim-label');
            const row = new Adw.ActionRow({title});
            row.add_suffix(valLabel);
            infoGroup.add(row);
        };

        const shells = Array.isArray(this.metadata['shell-version'])
            ? this.metadata['shell-version'].join(', ')
            : '47, 48, 49, 50, 51';

        addInfoRow(t.aboutAuthorLabel, 'Gustavo Henrique (@GustaHerin)');
        addInfoRow(t.aboutOrgLabel, 'TundraLab');
        addInfoRow(t.aboutVersionLabel, `v${versionStr}`);
        addInfoRow(t.aboutShellLabel, shells);
        addInfoRow(t.aboutUuidLabel, this.metadata.uuid || 'tundra-media-pill@tundralab.com.br');
        addInfoRow(t.aboutLicenseLabel, t.aboutLicenseValue);
        aboutPage.add(infoGroup);

        // Links
        const linksGroup = new Adw.PreferencesGroup({
            title: t.aboutLinksGroup,
        });

        const addLinkRow = (title, subtitle, uri) => {
            const row = new Adw.ActionRow({
                title,
                subtitle,
                activatable: true,
            });
            row.add_suffix(new Gtk.Image({
                icon_name: 'adw-external-link-symbolic',
                valign: Gtk.Align.CENTER,
            }));
            row.connect('activated', () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(uri, null);
                } catch (_e) {
                    window.add_toast(new Adw.Toast({title: `Link: ${uri}`}));
                }
            });
            linksGroup.add(row);
        };

        addLinkRow(
            t.aboutSiteTitle,
            this.metadata.url || 'https://tundralab.com.br',
            this.metadata.url || 'https://tundralab.com.br'
        );
        addLinkRow(
            t.aboutGhOrgTitle,
            'https://github.com/TundraLab/Tundra-Media-Pill',
            'https://github.com/TundraLab/Tundra-Media-Pill'
        );
        addLinkRow(
            t.aboutGhAuthorTitle,
            'https://github.com/GustaHerin',
            'https://github.com/GustaHerin'
        );
        addLinkRow(
            'LRCLIB',
            'https://lrclib.net',
            'https://lrclib.net'
        );
        aboutPage.add(linksGroup);

        // Changelog from v1.0.0 to v3.2.5
        const changelogGroup = new Adw.PreferencesGroup({
            title: t.aboutChangelogGroup,
        });

        for (const release of t.releases) {
            const row = new Adw.ActionRow({
                title: release.version,
                subtitle: release.notes,
                subtitle_lines: 4,
            });
            changelogGroup.add(row);
        }
        aboutPage.add(changelogGroup);

        return aboutPage;
    }
}
