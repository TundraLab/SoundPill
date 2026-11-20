#!/usr/bin/env bash
set -euo pipefail

UUID="soundpill@tundralab.com.br"
LEGACY_UUID="tundra-media-pill@tundralab.com.br"
REPO_ARCHIVE_URL="https://github.com/TundraLab/SoundPill/archive/refs/heads/main.tar.gz"
REPO_GIT_URL="https://github.com/TundraLab/SoundPill.git"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions"
TARGET_DIR="${EXT_DIR}/${UUID}"
LEGACY_TARGET_DIR="${EXT_DIR}/${LEGACY_UUID}"
AUTOSTART_DIR="${HOME}/.config/autostart"
AUTOSTART_FILE="${AUTOSTART_DIR}/soundpill-autostart.desktop"
LEGACY_AUTOSTART_FILE="${AUTOSTART_DIR}/tundra-media-pill-autostart.desktop"
TMP_DIR=""

cleanup() {
    if [[ -n "${TMP_DIR}" && -d "${TMP_DIR}" ]]; then
        rm -rf "${TMP_DIR}"
    fi
}
trap cleanup EXIT

remove_legacy_install() {
    if command -v gnome-extensions >/dev/null 2>&1; then
        gnome-extensions disable "${LEGACY_UUID}" >/dev/null 2>&1 || true
    fi
    rm -rf "${LEGACY_TARGET_DIR}"
    rm -f "${LEGACY_AUTOSTART_FILE}"
}

uninstall_extension() {
    if command -v gnome-extensions >/dev/null 2>&1; then
        gnome-extensions disable "${UUID}" >/dev/null 2>&1 || true
    fi
    rm -rf "${TARGET_DIR}"
    rm -f "${AUTOSTART_FILE}"
    remove_legacy_install
    echo "SoundPill (by TundraLab) removido de ${TARGET_DIR} e do autostart."
    exit 0
}

has_typelib() {
    local name="$1"
    local dirs=(
        "/usr/lib64/girepository-1.0"
        "/usr/lib/girepository-1.0"
        "/usr/local/lib64/girepository-1.0"
        "/usr/local/lib/girepository-1.0"
    )

    if [[ -n "${GI_TYPELIB_PATH:-}" ]]; then
        local IFS=":"
        for dir in ${GI_TYPELIB_PATH}; do
            [[ -f "${dir}/${name}" ]] && return 0
        done
    fi

    for dir in "${dirs[@]}" /usr/lib/*/girepository-1.0; do
        [[ -f "${dir}/${name}" ]] && return 0
    done

    return 1
}

detect_pkg_manager() {
    if command -v apt-get >/dev/null 2>&1; then
        echo "apt"
    elif command -v dnf >/dev/null 2>&1; then
        echo "dnf"
    elif command -v pacman >/dev/null 2>&1; then
        echo "pacman"
    elif command -v zypper >/dev/null 2>&1; then
        echo "zypper"
    else
        echo "unknown"
    fi
}

print_install_cmd() {
    local pm="$1"
    case "${pm}" in
        apt)
            echo "sudo apt update && sudo apt install -y curl git tar libglib2.0-bin gir1.2-soup-3.0 gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-gdkpixbuf-2.0 gnome-shell-extension-prefs"
            ;;
        dnf)
            echo "sudo dnf install -y curl git tar glib2-devel libsoup3 gtk4 libadwaita gdk-pixbuf2 gnome-extensions-app"
            ;;
        pacman)
            echo "sudo pacman -S --needed curl git tar glib2 libsoup3 gtk4 libadwaita gdk-pixbuf2 gnome-shell"
            ;;
        zypper)
            echo "sudo zypper install -y curl git tar glib2-tools typelib-1_0-Soup-3_0 typelib-1_0-Gtk-4_0 typelib-1_0-Adw-1 typelib-1_0-GdkPixbuf-2_0"
            ;;
        *)
            echo "Instale pela sua distribuição: curl, tar, glib-compile-schemas, libsoup 3.0, GTK4, Libadwaita, GdkPixbuf 2.0 e gnome-shell."
            ;;
    esac
}

install_system_deps() {
    local pm="$1"
    case "${pm}" in
        apt)
            sudo apt-get update
            sudo apt-get install -y curl git tar libglib2.0-bin gir1.2-soup-3.0 gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-gdkpixbuf-2.0 gnome-shell-extension-prefs
            ;;
        dnf)
            sudo dnf install -y curl git tar glib2-devel libsoup3 gtk4 libadwaita gdk-pixbuf2 gnome-extensions-app
            ;;
        pacman)
            sudo pacman -S --needed --noconfirm curl git tar glib2 libsoup3 gtk4 libadwaita gdk-pixbuf2 gnome-shell
            ;;
        zypper)
            sudo zypper --non-interactive install curl git tar glib2-tools typelib-1_0-Soup-3_0 typelib-1_0-Gtk-4_0 typelib-1_0-Adw-1 typelib-1_0-GdkPixbuf-2_0
            ;;
        *)
            return 1
            ;;
    esac
}

collect_missing_deps() {
    local need_download="$1"
    MISSING_DEPS=()

    command -v glib-compile-schemas >/dev/null 2>&1 || MISSING_DEPS+=("glib-compile-schemas")
    command -v gsettings >/dev/null 2>&1 || MISSING_DEPS+=("gsettings")
    command -v gnome-shell >/dev/null 2>&1 || MISSING_DEPS+=("gnome-shell")

    if [[ "${need_download}" == "1" ]]; then
        if ! { (command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1) || (command -v wget >/dev/null 2>&1 && command -v tar >/dev/null 2>&1) || command -v git >/dev/null 2>&1; }; then
            MISSING_DEPS+=("curl+tar (ou git)")
        fi
    fi

    has_typelib "Soup-3.0.typelib" || MISSING_DEPS+=("Soup-3.0 (libsoup 3)")
    has_typelib "Gtk-4.0.typelib" || MISSING_DEPS+=("Gtk-4.0 (GTK4)")
    has_typelib "Adw-1.typelib" || MISSING_DEPS+=("Adw-1 (Libadwaita)")
    has_typelib "GdkPixbuf-2.0.typelib" || MISSING_DEPS+=("GdkPixbuf-2.0")
}

MODE="auto"
AUTO_YES="0"
for arg in "$@"; do
    case "${arg}" in
        --copy) MODE="copy" ;;
        --symlink) MODE="symlink" ;;
        --yes|-y) AUTO_YES="1" ;;
        --uninstall) uninstall_extension ;;
        *)
            echo "Uso: $0 [--copy | --symlink | --yes | --uninstall]"
            exit 1
            ;;
    esac
done

SOURCE_PATH="${BASH_SOURCE[0]:-}"
CANDIDATE_DIR=""
if [[ -n "${SOURCE_PATH}" && -f "${SOURCE_PATH}" ]]; then
    CANDIDATE_DIR="$(cd "$(dirname "${SOURCE_PATH}")" && pwd)"
fi

NEED_DOWNLOAD="1"
if [[ -n "${CANDIDATE_DIR}" && -f "${CANDIDATE_DIR}/metadata.json" ]]; then
    NEED_DOWNLOAD="0"
fi

MISSING_DEPS=()
collect_missing_deps "${NEED_DOWNLOAD}"

if [[ "${#MISSING_DEPS[@]}" -gt 0 ]]; then
    PM="$(detect_pkg_manager)"
    INSTALL_CMD="$(print_install_cmd "${PM}")"

    echo "Dependências ausentes detectadas: ${MISSING_DEPS[*]}"
    echo ""
    echo "Comando recomendado para o seu sistema:"
    echo "  ${INSTALL_CMD}"
    echo ""

    SHOULD_INSTALL="0"
    if [[ "${AUTO_YES}" == "1" ]]; then
        SHOULD_INSTALL="1"
    elif [[ -r /dev/tty && -w /dev/tty && "${PM}" != "unknown" ]]; then
        # Read from /dev/tty so piped curl | bash execution stays interactive.
        printf "Deseja instalar essas dependências agora via sudo? [S/n] " > /dev/tty
        read -r REPLY < /dev/tty || REPLY="n"
        if [[ -z "${REPLY}" || "${REPLY}" =~ ^[sSyY]$ ]]; then
            SHOULD_INSTALL="1"
        fi
    fi

    if [[ "${SHOULD_INSTALL}" == "1" && "${PM}" != "unknown" ]]; then
        echo "Instalando dependências do sistema..."
        if [[ -r /dev/tty && -w /dev/tty ]]; then
            install_system_deps "${PM}" < /dev/tty
        else
            install_system_deps "${PM}"
        fi
        collect_missing_deps "${NEED_DOWNLOAD}"
    fi

    if [[ "${#MISSING_DEPS[@]}" -gt 0 ]]; then
        echo "Erro: dependências ainda ausentes: ${MISSING_DEPS[*]}"
        echo "Execute o comando abaixo e rode o instalador novamente:"
        echo "  ${INSTALL_CMD}"
        exit 1
    fi
fi

if [[ "${NEED_DOWNLOAD}" == "0" ]]; then
    SRC_DIR="${CANDIDATE_DIR}"
    if [[ "${MODE}" == "auto" ]]; then
        MODE="symlink"
    fi
else
    MODE="copy"
    TMP_DIR="$(mktemp -d)"
    echo "Baixando SoundPill (by TundraLab)..."
    if command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
        curl -fsSL "${REPO_ARCHIVE_URL}" | tar -xz -C "${TMP_DIR}"
        SRC_DIR="$(find "${TMP_DIR}" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
    elif command -v wget >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
        wget -qO- "${REPO_ARCHIVE_URL}" | tar -xz -C "${TMP_DIR}"
        SRC_DIR="$(find "${TMP_DIR}" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
    elif command -v git >/dev/null 2>&1; then
        git clone --depth 1 "${REPO_GIT_URL}" "${TMP_DIR}/repo"
        SRC_DIR="${TMP_DIR}/repo"
    else
        echo "Erro: é necessário ter 'curl' + 'tar' (ou 'wget' / 'git') instalados."
        exit 1
    fi

    if [[ -z "${SRC_DIR}" || ! -f "${SRC_DIR}/metadata.json" ]]; then
        echo "Erro: falha ao obter os arquivos do SoundPill (by TundraLab)."
        exit 1
    fi
fi

remove_legacy_install

echo "Compilando esquemas GSettings..."
glib-compile-schemas --strict "${SRC_DIR}/schemas"

mkdir -p "${EXT_DIR}"
if [[ -L "${TARGET_DIR}" || -e "${TARGET_DIR}" ]]; then
    rm -rf "${TARGET_DIR}"
fi

if [[ "${MODE}" == "copy" ]]; then
    mkdir -p "${TARGET_DIR}/schemas"
    cp "${SRC_DIR}/metadata.json" "${TARGET_DIR}/"
    cp "${SRC_DIR}/extension.js" "${TARGET_DIR}/"
    cp "${SRC_DIR}/prefs.js" "${TARGET_DIR}/"
    cp "${SRC_DIR}/stylesheet.css" "${TARGET_DIR}/"
    cp "${SRC_DIR}/LICENSE" "${TARGET_DIR}/"
    cp -r "${SRC_DIR}/src" "${TARGET_DIR}/"
    cp -r "${SRC_DIR}/icons" "${TARGET_DIR}/"
    cp "${SRC_DIR}/schemas/"*.xml "${TARGET_DIR}/schemas/"
    cp "${SRC_DIR}/schemas/gschemas.compiled" "${TARGET_DIR}/schemas/"
    echo "Arquivos instalados em ${TARGET_DIR}"
else
    ln -s "${SRC_DIR}" "${TARGET_DIR}"
    echo "Link simbólico criado em ${TARGET_DIR} -> ${SRC_DIR}"
fi

mkdir -p "${AUTOSTART_DIR}"
cat > "${AUTOSTART_FILE}" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=SoundPill (by TundraLab)
Comment=Garante a ativação automática da extensão SoundPill (by TundraLab) ao iniciar o Linux
Exec=sh -c "sleep 2 && gsettings set org.gnome.shell disable-user-extensions false && gnome-extensions enable ${UUID}"
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
X-TundraLab-Vendor=TundraLab
EOF

if command -v gsettings >/dev/null 2>&1; then
    gsettings set org.gnome.shell disable-user-extensions false || true
    CURRENT_EXTS="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || true)"
    if [[ -n "${CURRENT_EXTS}" && "${CURRENT_EXTS}" != *"${UUID}"* ]]; then
        if [[ "${CURRENT_EXTS}" == "@as []" || "${CURRENT_EXTS}" == "[]" ]]; then
            gsettings set org.gnome.shell enabled-extensions "['${UUID}']" >/dev/null 2>&1 || true
        else
            UPDATED_EXTS="${CURRENT_EXTS%\]}, '${UUID}']"
            gsettings set org.gnome.shell enabled-extensions "${UPDATED_EXTS}" >/dev/null 2>&1 || true
        fi
    fi
fi

if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable "${UUID}" >/dev/null 2>&1 || true
fi

echo "Instalação concluída!"
echo "Se você estiver no Wayland, encerre a sessão e faça login novamente para recarregar o GNOME Shell."
echo "No X11, pressione Alt+F2, digite 'r' e pressione Enter."
