#!/usr/bin/env bash
set -euo pipefail

UUID="tundra-media-pill@tundralab.com.br"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions"
TARGET_DIR="${EXT_DIR}/${UUID}"
AUTOSTART_DIR="${HOME}/.config/autostart"
AUTOSTART_FILE="${AUTOSTART_DIR}/tundra-media-pill-autostart.desktop"

uninstall_extension() {
    if command -v gnome-extensions >/dev/null 2>&1; then
        gnome-extensions disable "${UUID}" >/dev/null 2>&1 || true
    fi
    rm -rf "${TARGET_DIR}"
    rm -f "${AUTOSTART_FILE}"
    echo "Tundra Media Pill removido de ${TARGET_DIR} e do autostart."
    exit 0
}

MODE="symlink"
for arg in "$@"; do
    case "${arg}" in
        --copy) MODE="copy" ;;
        --uninstall) uninstall_extension ;;
        *)
            echo "Uso: $0 [--copy | --uninstall]"
            exit 1
            ;;
    esac
done

if ! command -v glib-compile-schemas >/dev/null 2>&1; then
    echo "Erro: 'glib-compile-schemas' não encontrado. Instale o pacote glib2-devel / libglib2.0-bin."
    exit 1
fi

echo "Compilando esquemas GSettings..."
glib-compile-schemas --strict "${SCRIPT_DIR}/schemas"

mkdir -p "${EXT_DIR}"
if [[ -L "${TARGET_DIR}" || -e "${TARGET_DIR}" ]]; then
    rm -rf "${TARGET_DIR}"
fi

if [[ "${MODE}" == "copy" ]]; then
    mkdir -p "${TARGET_DIR}/schemas"
    cp "${SCRIPT_DIR}/metadata.json" "${TARGET_DIR}/"
    cp "${SCRIPT_DIR}/extension.js" "${TARGET_DIR}/"
    cp "${SCRIPT_DIR}/prefs.js" "${TARGET_DIR}/"
    cp "${SCRIPT_DIR}/mediaController.js" "${TARGET_DIR}/"
    cp "${SCRIPT_DIR}/playerCard.js" "${TARGET_DIR}/"
    cp "${SCRIPT_DIR}/desktopWidget.js" "${TARGET_DIR}/"
    cp "${SCRIPT_DIR}/waveform.js" "${TARGET_DIR}/"
    cp "${SCRIPT_DIR}/lyrics.js" "${TARGET_DIR}/"
    cp "${SCRIPT_DIR}/accentColor.js" "${TARGET_DIR}/"
    cp "${SCRIPT_DIR}/autostart.js" "${TARGET_DIR}/"
    cp "${SCRIPT_DIR}/i18n.js" "${TARGET_DIR}/"
    cp "${SCRIPT_DIR}/stylesheet.css" "${TARGET_DIR}/"
    cp "${SCRIPT_DIR}/LICENSE" "${TARGET_DIR}/"
    cp -r "${SCRIPT_DIR}/icons" "${TARGET_DIR}/"
    cp "${SCRIPT_DIR}/schemas/"*.xml "${TARGET_DIR}/schemas/"
    cp "${SCRIPT_DIR}/schemas/gschemas.compiled" "${TARGET_DIR}/schemas/"
    echo "Arquivos copiados para ${TARGET_DIR}"
else
    ln -s "${SCRIPT_DIR}" "${TARGET_DIR}"
    echo "Link simbólico criado em ${TARGET_DIR} -> ${SCRIPT_DIR}"
fi

mkdir -p "${AUTOSTART_DIR}"
cat > "${AUTOSTART_FILE}" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Tundra Media Pill
Comment=Garante a ativação automática da extensão Tundra Media Pill ao iniciar o Linux
Exec=sh -c "sleep 2 && gsettings set org.gnome.shell disable-user-extensions false && gnome-extensions enable ${UUID}"
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
X-TundraLab-Vendor=TundraLab
EOF

if command -v gsettings >/dev/null 2>&1; then
    gsettings set org.gnome.shell disable-user-extensions false || true
fi

if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable "${UUID}" || true
fi

echo "Instalação concluída!"
echo "Se você estiver no Wayland, encerre a sessão e faça login novamente para recarregar o GNOME Shell."
echo "No X11, pressione Alt+F2, digite 'r' e pressione Enter."
