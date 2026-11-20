import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const EXTENSION_UUID = 'soundpill@tundralab.com.br';
const AUTOSTART_FILENAME = 'soundpill-autostart.desktop';
const LEGACY_AUTOSTART_FILENAME = 'tundra-media-pill-autostart.desktop';

const DESKTOP_ENTRY_CONTENT = `[Desktop Entry]
Type=Application
Version=1.0
Name=SoundPill (by TundraLab)
Comment=Garante a ativação automática da extensão SoundPill (by TundraLab) ao iniciar o Linux
Exec=sh -c "sleep 2 && gsettings set org.gnome.shell disable-user-extensions false && gnome-extensions enable ${EXTENSION_UUID}"
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
X-TundraLab-Vendor=TundraLab
`;

export function getAutostartFilePath() {
    return GLib.build_filenamev([
        GLib.get_user_config_dir(),
        'autostart',
        AUTOSTART_FILENAME,
    ]);
}

// Create or remove the session autostart desktop entry
export function syncAutostartEntry(enabled) {
    const filePath = getAutostartFilePath();
    const file = Gio.File.new_for_path(filePath);
    const legacyFile = Gio.File.new_for_path(GLib.build_filenamev([
        GLib.get_user_config_dir(),
        'autostart',
        LEGACY_AUTOSTART_FILENAME,
    ]));

    try {
        if (legacyFile.query_exists(null))
            legacyFile.delete(null);

        if (enabled) {
            const dirPath = GLib.path_get_dirname(filePath);
            GLib.mkdir_with_parents(dirPath, 0o755);

            if (file.query_exists(null)) {
                const [ok, raw] = GLib.file_get_contents(filePath);
                if (ok) {
                    const current = new TextDecoder('utf-8').decode(raw);
                    if (current === DESKTOP_ENTRY_CONTENT)
                        return true;
                }
            }

            GLib.file_set_contents(filePath, DESKTOP_ENTRY_CONTENT);
            return true;
        }

        if (file.query_exists(null))
            file.delete(null);
        return true;
    } catch (e) {
        console.error('[SoundPill] Falha ao atualizar autostart:', e);
        return false;
    }
}

// Remove cached cover images from the local cache directory
export function clearCoverCache() {
    const cacheDir = GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        'soundpill',
    ]);
    const dirFile = Gio.File.new_for_path(cacheDir);
    if (!dirFile.query_exists(null))
        return 0;

    let removed = 0;
    try {
        const enumerator = dirFile.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const child = dirFile.get_child(info.get_name());
            if (child.delete(null))
                removed++;
        }
        enumerator.close(null);
    } catch (e) {
        console.error('[SoundPill] Falha ao limpar cache de capas:', e);
    }
    return removed;
}
