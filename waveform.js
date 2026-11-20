const CARD_PROFILE_A = [
    0.34, 0.52, 0.72, 0.48, 0.84, 0.94, 0.62, 0.44, 0.78, 0.96,
    0.68, 0.42, 0.58, 0.88, 0.92, 0.70, 0.46, 0.74, 0.90, 0.64,
    0.40, 0.66, 0.86, 0.58, 0.38, 0.62, 0.82, 0.95, 0.66, 0.48,
    0.72, 0.88, 0.60, 0.44, 0.68, 0.50,
];

const CARD_PROFILE_B = [
    0.26, 0.44, 0.68, 0.92, 0.50, 0.74, 0.96, 0.56, 0.34, 0.80,
    0.98, 0.62, 0.40, 0.86, 0.54, 0.30, 0.72, 0.94, 0.76, 0.46,
    0.64, 0.90, 0.96, 0.52, 0.36, 0.78, 0.88, 0.48, 0.28, 0.66,
    0.84, 0.54, 0.38, 0.74, 0.52, 0.32,
];

function sampleProfile(profile, index, total) {
    if (total <= 1)
        return profile[0];
    const pos = (index / (total - 1)) * (profile.length - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(profile.length - 1, i0 + 1);
    const t = pos - i0;
    return profile[i0] * (1 - t) + profile[i1] * t;
}

function getPaletteRgb(palette) {
    const base = palette?.base || {r: 94, g: 181, b: 255};
    const light = palette?.light || {r: 155, g: 209, b: 255};
    const lighter = palette?.lighter || {r: 205, g: 234, b: 255};
    return {
        base: [base.r / 255, base.g / 255, base.b / 255],
        light: [light.r / 255, light.g / 255, light.b / 255],
        lighter: [lighter.r / 255, lighter.g / 255, lighter.b / 255],
    };
}

function roundedRect(cr, x, y, w, h, r) {
    if (w <= 0 || h <= 0)
        return;
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    if (radius <= 0.1) {
        cr.rectangle(x, y, w, h);
        return;
    }
    cr.newSubPath();
    cr.arc(x + w - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + w - radius, y + h - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + h - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, (3 * Math.PI) / 2);
    cr.closePath();
}

function barEnergy(profile, index, count, phase, animate, scale = 0.16) {
    const base = sampleProfile(profile, index, count);
    if (!animate)
        return Math.max(0.2, Math.min(0.95, base * 0.84));
    const wave = Math.sin(phase + index * 0.48) * scale;
    const harmonic = Math.cos(phase * 0.65 - index * 0.27) * (scale * 0.45);
    return Math.max(0.2, Math.min(1.0, base + wave + harmonic));
}

function drawClassicBars(cr, w, h, state, colors) {
    const count = 34;
    const padX = 2;
    const availW = Math.max(10, w - padX * 2);
    const barW = Math.max(2.5, Math.min(4.5, (availW / count) * 0.54));
    const step = (availW - barW) / (count - 1);
    const maxH = h - 4;
    const midY = h / 2;
    const activeIdx = state.hasDuration ? Math.min(count - 1, Math.floor(state.ratio * count)) : -1;

    for (let i = 0; i < count; i++) {
        let level = barEnergy(CARD_PROFILE_A, i, count, state.phase, state.animate);
        if (i === activeIdx)
            level = Math.min(1.0, level + 0.12);
        const bh = Math.max(4, level * maxH);
        const x = padX + i * step;
        const y = midY - bh / 2;

        if (activeIdx >= 0 && i < activeIdx)
            cr.setSourceRGBA(...colors.base, 0.95);
        else if (activeIdx >= 0 && i === activeIdx)
            cr.setSourceRGBA(...colors.lighter, 1.0);
        else
            cr.setSourceRGBA(1, 1, 1, 0.24);

        roundedRect(cr, x, y, barW, bh, barW / 2);
        cr.fill();
    }
}

function drawMirrorWave(cr, w, h, state, colors) {
    const count = 42;
    const padX = 2;
    const availW = Math.max(10, w - padX * 2);
    const barW = Math.max(2, Math.min(3.5, (availW / count) * 0.58));
    const step = (availW - barW) / (count - 1);
    const splitY = Math.round(h * 0.62);
    const topMax = Math.max(4, splitY - 3);
    const botMax = Math.max(3, h - splitY - 3);
    const playX = padX + state.ratio * availW;
    const activeIdx = state.hasDuration ? Math.min(count - 1, Math.floor(state.ratio * count)) : -1;

    // Subtle center horizon line
    if (state.hasDuration && state.ratio > 0) {
        cr.setSourceRGBA(...colors.light, 0.55);
        cr.rectangle(padX, splitY - 0.5, Math.max(0, playX - padX), 1);
        cr.fill();
    }
    cr.setSourceRGBA(1, 1, 1, 0.14);
    cr.rectangle(Math.max(padX, playX), splitY - 0.5, Math.max(0, w - padX - playX), 1);
    cr.fill();

    for (let i = 0; i < count; i++) {
        let level = barEnergy(CARD_PROFILE_B, i, count, state.phase, state.animate, 0.18);
        if (i === activeIdx)
            level = Math.min(1.0, level + 0.14);

        const x = padX + i * step;
        const upH = Math.max(3, level * topMax);
        const downH = Math.max(2, level * botMax * 0.9);
        const played = activeIdx >= 0 && i < activeIdx;
        const isHead = activeIdx >= 0 && i === activeIdx;

        // Upper spike
        if (isHead)
            cr.setSourceRGBA(...colors.lighter, 1.0);
        else if (played)
            cr.setSourceRGBA(...colors.base, 0.96);
        else
            cr.setSourceRGBA(1, 1, 1, 0.28);

        roundedRect(cr, x, splitY - 1.5 - upH, barW, upH, barW / 2);
        cr.fill();

        // Lower reflection
        if (isHead)
            cr.setSourceRGBA(...colors.light, 0.52);
        else if (played)
            cr.setSourceRGBA(...colors.base, 0.36);
        else
            cr.setSourceRGBA(1, 1, 1, 0.11);

        roundedRect(cr, x, splitY + 1.5, barW, downH, barW / 2);
        cr.fill();
    }
}

function drawSegmentedEqualizer(cr, w, h, state, colors) {
    const cols = 20;
    const rows = 5;
    const padX = 2;
    const padY = 2;
    const availW = Math.max(10, w - padX * 2);
    const availH = Math.max(10, h - padY * 2);
    const gapX = 3;
    const colW = (availW - gapX * (cols - 1)) / cols;
    const gapY = 2;
    const segH = (availH - gapY * (rows - 1)) / rows;
    const activeCol = state.hasDuration ? Math.min(cols - 1, Math.floor(state.ratio * cols)) : -1;

    for (let c = 0; c < cols; c++) {
        const level = barEnergy(CARD_PROFILE_A, c, cols, state.phase, state.animate, 0.22);
        const litRows = Math.max(1, Math.min(rows, Math.round(level * rows)));
        const x = padX + c * (colW + gapX);
        const isPlayed = activeCol >= 0 && c < activeCol;
        const isHead = activeCol >= 0 && c === activeCol;

        for (let r = 0; r < rows; r++) {
            const y = padY + availH - (r + 1) * segH - r * gapY;
            if (r < litRows) {
                const isPeak = r === litRows - 1;
                if (isHead)
                    cr.setSourceRGBA(...colors.lighter, isPeak ? 1.0 : 0.88);
                else if (isPlayed)
                    cr.setSourceRGBA(...(isPeak ? colors.light : colors.base), isPeak ? 1.0 : 0.85);
                else
                    cr.setSourceRGBA(1, 1, 1, isPeak ? 0.38 : 0.20);
            } else {
                cr.setSourceRGBA(1, 1, 1, 0.05);
            }
            roundedRect(cr, x, y, colW, segH, 1.5);
            cr.fill();
        }
    }
}

function drawDotsWave(cr, w, h, state, colors) {
    const count = 24;
    const padX = 6;
    const availW = Math.max(10, w - padX * 2);
    const step = availW / (count - 1);
    const midY = h / 2;
    const amp = Math.max(4, h * 0.30);
    const activeIdx = state.hasDuration ? Math.min(count - 1, Math.floor(state.ratio * count)) : -1;

    // Subtle connecting guideline
    cr.save();
    cr.setLineWidth(1.2);
    cr.setSourceRGBA(1, 1, 1, 0.10);
    for (let i = 0; i < count; i++) {
        const x = padX + i * step;
        const wave = Math.sin(i * 0.58 + (state.animate ? state.phase * 0.9 : 0.6));
        const y = midY + wave * amp;
        if (i === 0)
            cr.moveTo(x, y);
        else
            cr.lineTo(x, y);
    }
    cr.stroke();
    cr.restore();

    for (let i = 0; i < count; i++) {
        const x = padX + i * step;
        const wave = Math.sin(i * 0.58 + (state.animate ? state.phase * 0.9 : 0.6));
        const energy = barEnergy(CARD_PROFILE_A, i, count, state.phase, state.animate, 0.14);
        const y = midY + wave * amp;
        const isPlayed = activeIdx >= 0 && i < activeIdx;
        const isHead = activeIdx >= 0 && i === activeIdx;
        const radius = isHead ? 4.3 : 2.3 + energy * 1.4;

        if (isHead) {
            cr.setSourceRGBA(...colors.light, 0.32);
            cr.arc(x, y, radius + 3.0, 0, Math.PI * 2);
            cr.fill();
            cr.setSourceRGBA(...colors.lighter, 1.0);
        } else if (isPlayed) {
            cr.setSourceRGBA(...colors.base, 0.95);
        } else {
            cr.setSourceRGBA(1, 1, 1, 0.28);
        }

        cr.arc(x, y, radius, 0, Math.PI * 2);
        cr.fill();
    }
}

function drawPillSlider(cr, w, h, state, colors) {
    const padX = 7;
    const trackW = Math.max(10, w - padX * 2);
    const trackH = 6;
    const trackY = (h - trackH) / 2;
    const ratio = state.hasDuration ? state.ratio : 0;
    const fillW = Math.round(trackW * ratio);
    const thumbX = padX + fillW;
    const thumbY = h / 2;

    // Background track
    cr.setSourceRGBA(1, 1, 1, 0.2);
    roundedRect(cr, padX, trackY, trackW, trackH, trackH / 2);
    cr.fill();

    // Accent fill
    if (fillW > 0) {
        cr.setSourceRGBA(...colors.base, 0.96);
        roundedRect(cr, padX, trackY, Math.max(trackH, fillW), trackH, trackH / 2);
        cr.fill();
    }

    // Soft glow around thumb
    cr.setSourceRGBA(...colors.base, 0.26);
    cr.arc(thumbX, thumbY, 10, 0, Math.PI * 2);
    cr.fill();

    // Crisp thumb
    cr.setSourceRGBA(1, 1, 1, 1);
    cr.arc(thumbX, thumbY, 6, 0, Math.PI * 2);
    cr.fill();
    cr.setLineWidth(2);
    cr.setSourceRGBA(...colors.base, 1);
    cr.arc(thumbX, thumbY, 6, 0, Math.PI * 2);
    cr.stroke();
}

function drawPixelBlocks(cr, w, h, state, colors) {
    const cols = 16;
    const rows = 4;
    const padX = 2;
    const padY = 2;
    const availW = Math.max(10, w - padX * 2);
    const availH = Math.max(10, h - padY * 2);
    const gap = 3;
    const cellW = (availW - gap * (cols - 1)) / cols;
    const cellH = (availH - gap * (rows - 1)) / rows;
    const activeCol = state.hasDuration ? Math.min(cols - 1, Math.floor(state.ratio * cols)) : -1;

    for (let c = 0; c < cols; c++) {
        const energy = barEnergy(CARD_PROFILE_B, c, cols, state.phase * 1.1, state.animate, 0.24);
        const lit = Math.max(1, Math.min(rows, Math.round(energy * rows)));
        const x = padX + c * (cellW + gap);
        const isPlayed = activeCol >= 0 && c < activeCol;
        const isHead = activeCol >= 0 && c === activeCol;

        for (let r = 0; r < rows; r++) {
            const y = padY + availH - (r + 1) * cellH - r * gap;
            if (r < lit) {
                const alpha = 0.55 + (r / rows) * 0.45;
                if (isHead)
                    cr.setSourceRGBA(...colors.lighter, 1.0);
                else if (isPlayed)
                    cr.setSourceRGBA(...colors.base, alpha);
                else
                    cr.setSourceRGBA(1, 1, 1, 0.16 + (r / rows) * 0.14);
            } else {
                cr.setSourceRGBA(1, 1, 1, 0.045);
            }
            roundedRect(cr, x, y, cellW, cellH, 2);
            cr.fill();
        }
    }
}

function evalOscilloscopeY(t, midY, amp, phase, animate) {
    const p = animate ? phase : 0.7;
    const carrier = Math.sin(t * Math.PI * 5.0 - p * 1.4);
    const mod = 0.55 + 0.45 * Math.sin(t * Math.PI * 2.0 + p * 0.5);
    const ripple = 0.28 * Math.cos(t * Math.PI * 9.0 + p * 1.9);
    const envelope = Math.sin(t * Math.PI);
    return midY + (carrier * mod + ripple) * amp * (0.35 + 0.65 * envelope);
}

function drawSineWave(cr, w, h, state, colors) {
    const padX = 4;
    const availW = Math.max(10, w - padX * 2);
    const midY = h / 2;
    const amp = Math.max(4, h * 0.34);
    const ratio = state.hasDuration ? state.ratio : 0;
    const playX = padX + ratio * availW;
    const steps = 72;

    const buildPath = (startX, endX) => {
        const span = Math.max(1, endX - startX);
        const count = Math.max(8, Math.round((span / availW) * steps));
        for (let i = 0; i <= count; i++) {
            const x = startX + (i / count) * span;
            const t = (x - padX) / availW;
            const y = evalOscilloscopeY(t, midY, amp, state.phase, state.animate);
            if (i === 0)
                cr.moveTo(x, y);
            else
                cr.lineTo(x, y);
        }
    };

    // Unplayed ghost curve
    if (playX < w - padX) {
        cr.save();
        buildPath(playX, w - padX);
        cr.setLineWidth(1.6);
        cr.setLineCap(1);
        cr.setLineJoin(1);
        cr.setSourceRGBA(1, 1, 1, 0.28);
        cr.stroke();
        cr.restore();
    }

    // Played glowing curve and translucent fill
    if (ratio > 0.005) {
        cr.save();
        buildPath(padX, playX);
        cr.lineTo(playX, midY);
        cr.lineTo(padX, midY);
        cr.closePath();
        cr.setSourceRGBA(...colors.base, 0.18);
        cr.fill();

        buildPath(padX, playX);
        cr.setLineWidth(2.6);
        cr.setLineCap(1);
        cr.setLineJoin(1);
        cr.setSourceRGBA(...colors.light, 0.98);
        cr.stroke();
        cr.restore();
    }

    // Playhead dot on the curve
    if (state.hasDuration) {
        const headY = evalOscilloscopeY(ratio, midY, amp, state.phase, state.animate);
        cr.setSourceRGBA(...colors.base, 0.35);
        cr.arc(playX, headY, 6.5, 0, Math.PI * 2);
        cr.fill();
        cr.setSourceRGBA(...colors.lighter, 1.0);
        cr.arc(playX, headY, 3.4, 0, Math.PI * 2);
        cr.fill();
    }
}

function evalEnvelope(t, phase, animate) {
    const idx = t * (CARD_PROFILE_A.length - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(CARD_PROFILE_A.length - 1, i0 + 1);
    const frac = idx - i0;
    const base = CARD_PROFILE_A[i0] * (1 - frac) + CARD_PROFILE_A[i1] * frac;
    const motion = animate ? Math.sin(phase * 1.1 + t * 14) * 0.14 : 0;
    return Math.max(0.18, Math.min(1.0, base + motion));
}

function drawPulseRibbon(cr, w, h, state, colors) {
    const padX = 2;
    const availW = Math.max(10, w - padX * 2);
    const midY = h / 2;
    const maxHalf = Math.max(4, h * 0.42);
    const ratio = state.hasDuration ? state.ratio : 0;
    const playX = padX + ratio * availW;
    const steps = 60;

    const traceRibbon = () => {
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = padX + t * availW;
            const half = evalEnvelope(t, state.phase, state.animate) * maxHalf;
            if (i === 0)
                cr.moveTo(x, midY - half);
            else
                cr.lineTo(x, midY - half);
        }
        for (let i = steps; i >= 0; i--) {
            const t = i / steps;
            const x = padX + t * availW;
            const half = evalEnvelope(t, state.phase, state.animate) * maxHalf;
            cr.lineTo(x, midY + half);
        }
        cr.closePath();
    };

    // Unplayed ribbon
    cr.save();
    cr.rectangle(playX, 0, w - playX, h);
    cr.clip();
    traceRibbon();
    cr.setSourceRGBA(1, 1, 1, 0.19);
    cr.fill();
    cr.restore();

    // Played ribbon
    if (ratio > 0) {
        cr.save();
        cr.rectangle(0, 0, playX, h);
        cr.clip();
        traceRibbon();
        cr.setSourceRGBA(...colors.base, 0.88);
        cr.fill();
        cr.restore();
    }

    // Crisp laser playhead
    if (state.hasDuration) {
        cr.setSourceRGBA(...colors.lighter, 0.98);
        roundedRect(cr, Math.max(padX, playX - 1), 1, 2, h - 2, 1);
        cr.fill();
    }
}

function evalHeartbeatY(i, count, midY, amp, phase, animate) {
    if (i === 0 || i === count)
        return midY;
    const base = sampleProfile(CARD_PROFILE_B, i, count + 1);
    const motion = animate ? Math.sin(phase * 1.2 + i * 0.9) * 0.14 : 0;
    const mag = Math.max(0.15, Math.min(1.0, base + motion));
    const sign = i % 2 === 0 ? -1 : 1;
    return midY + sign * mag * amp;
}

function drawHeartbeat(cr, w, h, state, colors) {
    const padX = 4;
    const availW = Math.max(10, w - padX * 2);
    const midY = h / 2;
    const amp = Math.max(4, h * 0.40);
    const ratio = state.hasDuration ? state.ratio : 0;
    const playX = padX + ratio * availW;
    const segs = 38;

    const traceLine = () => {
        for (let i = 0; i <= segs; i++) {
            const x = padX + (i / segs) * availW;
            const y = evalHeartbeatY(i, segs, midY, amp, state.phase, state.animate);
            if (i === 0)
                cr.moveTo(x, y);
            else
                cr.lineTo(x, y);
        }
    };

    // Unplayed trace
    cr.save();
    cr.rectangle(playX, 0, w - playX, h);
    cr.clip();
    traceLine();
    cr.setLineWidth(1.6);
    cr.setLineJoin(1);
    cr.setSourceRGBA(1, 1, 1, 0.25);
    cr.stroke();
    cr.restore();

    // Played trace
    if (ratio > 0) {
        cr.save();
        cr.rectangle(0, 0, playX, h);
        cr.clip();
        traceLine();
        cr.setLineWidth(2.2);
        cr.setLineJoin(1);
        cr.setSourceRGBA(...colors.light, 0.98);
        cr.stroke();
        cr.restore();
    }

    if (state.hasDuration) {
        const posSeg = ratio * segs;
        const i0 = Math.floor(posSeg);
        const i1 = Math.min(segs, i0 + 1);
        const f = posSeg - i0;
        const y0 = evalHeartbeatY(i0, segs, midY, amp, state.phase, state.animate);
        const y1 = evalHeartbeatY(i1, segs, midY, amp, state.phase, state.animate);
        const headY = y0 * (1 - f) + y1 * f;

        cr.setSourceRGBA(...colors.base, 0.36);
        cr.arc(playX, headY, 6, 0, Math.PI * 2);
        cr.fill();
        cr.setSourceRGBA(...colors.lighter, 1.0);
        cr.arc(playX, headY, 3, 0, Math.PI * 2);
        cr.fill();
    }
}

function drawDualRail(cr, w, h, state, colors) {
    const count = 28;
    const padX = 2;
    const availW = Math.max(10, w - padX * 2);
    const barW = Math.max(2.5, Math.min(4.5, (availW / count) * 0.56));
    const step = (availW - barW) / (count - 1);
    const midY = h / 2;
    const chanMax = Math.max(3, midY - 4);
    const playX = padX + (state.hasDuration ? state.ratio * availW : 0);
    const activeIdx = state.hasDuration ? Math.min(count - 1, Math.floor(state.ratio * count)) : -1;

    // Central progress rail
    cr.setSourceRGBA(1, 1, 1, 0.16);
    roundedRect(cr, padX, midY - 1, availW, 2, 1);
    cr.fill();
    if (state.hasDuration && playX > padX) {
        cr.setSourceRGBA(...colors.light, 0.95);
        roundedRect(cr, padX, midY - 1, Math.max(2, playX - padX), 2, 1);
        cr.fill();
    }

    // Upper (L) & lower (R) counter-phased bars
    for (let i = 0; i < count; i++) {
        const x = padX + i * step;
        const leftLvl = barEnergy(CARD_PROFILE_A, i, count, state.phase, state.animate, 0.2);
        const rightLvl = barEnergy(CARD_PROFILE_B, count - 1 - i, count, state.phase + 1.4, state.animate, 0.2);
        const leftH = Math.max(2.5, leftLvl * chanMax);
        const rightH = Math.max(2.5, rightLvl * chanMax);
        const played = activeIdx >= 0 && i < activeIdx;
        const isHead = activeIdx >= 0 && i === activeIdx;

        if (isHead)
            cr.setSourceRGBA(...colors.lighter, 1.0);
        else if (played)
            cr.setSourceRGBA(...colors.base, 0.92);
        else
            cr.setSourceRGBA(1, 1, 1, 0.22);

        roundedRect(cr, x, midY - 2.5 - leftH, barW, leftH, barW / 2);
        cr.fill();

        if (isHead)
            cr.setSourceRGBA(...colors.lighter, 0.95);
        else if (played)
            cr.setSourceRGBA(...colors.light, 0.72);
        else
            cr.setSourceRGBA(1, 1, 1, 0.16);

        roundedRect(cr, x, midY + 2.5, barW, rightH, barW / 2);
        cr.fill();
    }
}

export function drawCardWaveform(area, state) {
    const [width, height] = area.get_surface_size();
    if (width <= 0 || height <= 0)
        return;

    const colors = getPaletteRgb(state.palette);
    const cr = area.get_context();
    try {
        switch (state.style) {
        case 'mirror':
            drawMirrorWave(cr, width, height, state, colors);
            break;
        case 'equalizer':
            drawSegmentedEqualizer(cr, width, height, state, colors);
            break;
        case 'dots':
            drawDotsWave(cr, width, height, state, colors);
            break;
        case 'pill-slider':
            drawPillSlider(cr, width, height, state, colors);
            break;
        case 'blocks':
            drawPixelBlocks(cr, width, height, state, colors);
            break;
        case 'sine-wave':
            drawSineWave(cr, width, height, state, colors);
            break;
        case 'pulse-ribbon':
            drawPulseRibbon(cr, width, height, state, colors);
            break;
        case 'heartbeat':
            drawHeartbeat(cr, width, height, state, colors);
            break;
        case 'dual-rail':
            drawDualRail(cr, width, height, state, colors);
            break;
        case 'classic':
        default:
            drawClassicBars(cr, width, height, state, colors);
            break;
        }
    } finally {
        cr.$dispose();
    }
}

function pillBarLevel(i, phase, isPlaying) {
    if (!isPlaying)
        return [0.28, 0.45, 0.35, 0.55, 0.38, 0.25][i % 6];
    const wave = Math.sin(phase + i * 1.15) * 0.34 + 0.56;
    const mod = Math.cos(phase * 0.7 - i * 0.6) * 0.14;
    return Math.max(0.22, Math.min(1.0, wave + mod));
}

function setPillColor(cr, isPlaying, alt, colors, alpha = 1.0) {
    if (!isPlaying)
        cr.setSourceRGBA(1, 1, 1, 0.36 * alpha);
    else if (alt)
        cr.setSourceRGBA(...colors.light, alpha);
    else
        cr.setSourceRGBA(...colors.base, alpha);
}

export function drawPillVisualizer(area, state) {
    const [width, height] = area.get_surface_size();
    if (width <= 0 || height <= 0)
        return;

    const colors = getPaletteRgb(state.palette);
    const {style, phase, isPlaying} = state;
    const cr = area.get_context();

    try {
        const midY = height / 2;

        if (style === 'mirror') {
            const count = 7;
            const barW = 2;
            const step = (width - barW) / (count - 1);
            const splitY = Math.round(height * 0.6);

            setPillColor(cr, isPlaying, true, colors, 0.35);
            cr.rectangle(0, splitY - 0.5, width, 1);
            cr.fill();

            for (let i = 0; i < count; i++) {
                const lvl = pillBarLevel(i, phase, isPlaying);
                const upH = Math.max(2, lvl * (splitY - 1.5));
                const dnH = Math.max(1.5, lvl * (height - splitY - 1.5));
                const x = i * step;

                setPillColor(cr, isPlaying, i % 2 === 1, colors, 0.96);
                roundedRect(cr, x, splitY - 1 - upH, barW, upH, 1);
                cr.fill();

                setPillColor(cr, isPlaying, i % 2 === 1, colors, 0.45);
                roundedRect(cr, x, splitY + 1, barW, dnH, 1);
                cr.fill();
            }
        } else if (style === 'equalizer') {
            const cols = 5;
            const rows = 4;
            const gapX = 2;
            const gapY = 1.5;
            const colW = (width - gapX * (cols - 1)) / cols;
            const segH = (height - 2 - gapY * (rows - 1)) / rows;

            for (let c = 0; c < cols; c++) {
                const lvl = pillBarLevel(c, phase * 1.1, isPlaying);
                const lit = Math.max(1, Math.min(rows, Math.round(lvl * rows)));
                const x = c * (colW + gapX);
                for (let r = 0; r < lit; r++) {
                    const y = height - 1 - (r + 1) * segH - r * gapY;
                    setPillColor(cr, isPlaying, r === lit - 1, colors, 0.72 + (r / rows) * 0.28);
                    roundedRect(cr, x, y, colW, segH, 0.8);
                    cr.fill();
                }
            }
        } else if (style === 'sine') {
            const amp = isPlaying ? height * 0.34 : height * 0.14;
            const p = isPlaying ? phase * 1.3 : 0.4;
            const steps = 24;
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const x = 1 + t * (width - 2);
                const env = Math.sin(t * Math.PI);
                const y = midY + Math.sin(t * Math.PI * 3.2 - p) * amp * (0.4 + 0.6 * env);
                if (i === 0)
                    cr.moveTo(x, y);
                else
                    cr.lineTo(x, y);
            }
            cr.setLineWidth(2);
            cr.setLineCap(1);
            cr.setLineJoin(1);
            setPillColor(cr, isPlaying, true, colors, 0.98);
            cr.stroke();
        } else if (style === 'dots') {
            const count = 5;
            const padX = 2.5;
            const step = (width - padX * 2) / (count - 1);
            for (let i = 0; i < count; i++) {
                const x = padX + i * step;
                const offset = isPlaying
                    ? Math.sin(phase * 1.15 + i * 1.1) * (height * 0.28)
                    : 0;
                const r = isPlaying ? 1.8 + 0.6 * Math.abs(Math.cos(phase + i)) : 1.7;
                setPillColor(cr, isPlaying, i % 2 === 1, colors, 0.96);
                cr.arc(x, midY + offset, r, 0, Math.PI * 2);
                cr.fill();
            }
        } else if (style === 'blocks') {
            const cols = 4;
            const rows = 3;
            const gap = 2;
            const cw = (width - gap * (cols - 1)) / cols;
            const ch = (height - 2 - gap * (rows - 1)) / rows;
            for (let c = 0; c < cols; c++) {
                const lvl = pillBarLevel(c, phase * 1.15, isPlaying);
                const lit = Math.max(1, Math.min(rows, Math.round(lvl * rows)));
                const x = c * (cw + gap);
                for (let r = 0; r < rows; r++) {
                    const y = height - 1 - (r + 1) * ch - r * gap;
                    if (r < lit) {
                        setPillColor(cr, isPlaying, r === lit - 1, colors, 0.95);
                    } else {
                        cr.setSourceRGBA(1, 1, 1, 0.08);
                    }
                    roundedRect(cr, x, y, cw, ch, 1);
                    cr.fill();
                }
            }
        } else if (style === 'pulse') {
            const pts = 11;
            const amp = isPlaying ? height * 0.38 : height * 0.14;
            for (let i = 0; i <= pts; i++) {
                const t = i / pts;
                const x = 1 + t * (width - 2);
                let y = midY;
                if (i > 0 && i < pts) {
                    const lvl = pillBarLevel(i, phase * 1.2, isPlaying);
                    const sign = i % 2 === 0 ? -1 : 1;
                    y = midY + sign * lvl * amp;
                }
                if (i === 0)
                    cr.moveTo(x, y);
                else
                    cr.lineTo(x, y);
            }
            cr.setLineWidth(1.8);
            cr.setLineJoin(1);
            cr.setLineCap(1);
            setPillColor(cr, isPlaying, true, colors, 0.96);
            cr.stroke();
        } else {
            // Classic pill bars (6 centered rounded pills)
            const count = 6;
            const barW = 2;
            const step = (width - barW) / (count - 1);
            const maxH = height - 2;
            for (let i = 0; i < count; i++) {
                const lvl = pillBarLevel(i, phase, isPlaying);
                const bh = Math.max(3, lvl * maxH);
                const x = i * step;
                const y = midY - bh / 2;
                setPillColor(cr, isPlaying, i % 2 === 1, colors, 0.96);
                roundedRect(cr, x, y, barW, bh, 1);
                cr.fill();
            }
        }
    } finally {
        cr.$dispose();
    }
}
