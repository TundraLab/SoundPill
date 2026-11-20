export const DEFAULT_ACCENT_HEX = '#5EB5FF';

export const ACCENT_PRESETS = [
    {id: 'azul-tundra', name: 'Azul Tundra', hex: '#5EB5FF'},
    {id: 'ciano-gelado', name: 'Ciano Gelado', hex: '#22D3EE'},
    {id: 'menta-neon', name: 'Menta Neon', hex: '#34D399'},
    {id: 'verde-esmeralda', name: 'Verde Esmeralda', hex: '#1ED760'},
    {id: 'lima-eletrico', name: 'Lima Elétrico', hex: '#A3E635'},
    {id: 'ambar-dourado', name: 'Âmbar Dourado', hex: '#FBBF24'},
    {id: 'laranja-sunset', name: 'Laranja Sunset', hex: '#FB923C'},
    {id: 'coral-vibrante', name: 'Coral Vibrante', hex: '#FF6B6B'},
    {id: 'carmim', name: 'Carmim', hex: '#F43F5E'},
    {id: 'rosa-neon', name: 'Rosa Neon', hex: '#F472B6'},
    {id: 'magenta', name: 'Magenta', hex: '#E879F9'},
    {id: 'roxo-ametista', name: 'Roxo Ametista', hex: '#A78BFA'},
    {id: 'indigo-neon', name: 'Índigo Néon', hex: '#818CF8'},
];

export function normalizeHex(hex) {
    if (typeof hex !== 'string')
        return DEFAULT_ACCENT_HEX;
    const clean = hex.trim().toUpperCase();
    return /^#[0-9A-F]{6}$/.test(clean) ? clean : DEFAULT_ACCENT_HEX;
}

export function hexToRgb(hex) {
    const clean = normalizeHex(hex).slice(1);
    return {
        r: Number.parseInt(clean.slice(0, 2), 16),
        g: Number.parseInt(clean.slice(2, 4), 16),
        b: Number.parseInt(clean.slice(4, 6), 16),
    };
}

export function rgbToHex(r, g, b) {
    const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
    return '#' + [clamp(r), clamp(g), clamp(b)]
        .map(v => v.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
}

function mixWithWhite(rgb, factor) {
    return {
        r: Math.round(rgb.r + (255 - rgb.r) * factor),
        g: Math.round(rgb.g + (255 - rgb.g) * factor),
        b: Math.round(rgb.b + (255 - rgb.b) * factor),
    };
}

function toRgba(rgb, alpha) {
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

export function getPresetByHex(hex) {
    const target = normalizeHex(hex);
    return ACCENT_PRESETS.find(p => p.hex.toUpperCase() === target) || null;
}

export function buildAccentPalette(hex) {
    const baseHex = normalizeHex(hex);
    const base = hexToRgb(baseHex);
    const light = mixWithWhite(base, 0.38);
    const lighter = mixWithWhite(base, 0.62);

    return {
        baseHex,
        lightHex: rgbToHex(light.r, light.g, light.b),
        lighterHex: rgbToHex(lighter.r, lighter.g, lighter.b),
        base,
        light,
        lighter,
        rgba: alpha => toRgba(base, alpha),
        lightRgba: alpha => toRgba(light, alpha),
        lighterRgba: alpha => toRgba(lighter, alpha),
    };
}
