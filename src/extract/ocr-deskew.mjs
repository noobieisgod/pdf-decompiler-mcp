import { multiplyTransform, transformUnitRect } from '../model/geometry.mjs';
import { createCanvas, fillCanvasWhite } from '../pdf/canvas.mjs';
import { runTesseractOcr } from './ocr.mjs';
import { extractScannedTables, retryRuledGrid } from './ocr-tables.mjs';

const MAX_SKEW_DEGREES = 8;
const MIN_ALIGNMENT_GAIN = 1.4;
const RADIANS_PER_DEGREE = Math.PI / 180;

function scanSkew(canvas) {
    const { width, height } = canvas;
    const step = Math.ceil(Math.max(width, height) / 400);
    const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const ink = [];
    const marginX = Math.floor(width * 0.08);
    const marginY = Math.floor(height * 0.08);
    for (let y = marginY; y < height - marginY; y += step) {
        for (let x = marginX; x < width - marginX; x += step) {
            const offset = (y * width + x) * 4;
            if (pixels[offset] + pixels[offset + 1] + pixels[offset + 2] < 345) ink.push(x - width / 2, y);
        }
    }
    if (ink.length < 160 || ink.length * step ** 2 > width * height / 2) return 0;

    // Text rows concentrate dark pixels when projected along the correct baseline.
    const pad = Math.ceil(width * Math.tan(MAX_SKEW_DEGREES * RADIANS_PER_DEGREE) / (2 * step)) + 1;
    const rows = new Uint32Array(Math.ceil(height / step) + 2 * pad + 1);
    const score = degrees => {
        rows.fill(0);
        const slope = Math.tan(degrees * RADIANS_PER_DEGREE);
        for (let i = 0; i < ink.length; i += 2) {
            rows[Math.round((ink[i + 1] - slope * ink[i]) / step) + pad]++;
        }
        return rows.reduce((sum, count) => sum + count * count, 0);
    };
    const upright = score(0);
    let best = upright;
    let angle = 0;
    for (let candidate = -MAX_SKEW_DEGREES; candidate <= MAX_SKEW_DEGREES; candidate++) {
        const alignment = score(candidate);
        if (alignment > best) {
            best = alignment;
            angle = candidate;
        }
    }
    return Math.abs(angle) >= 2 && Math.abs(angle) < MAX_SKEW_DEGREES && best >= upright * MIN_ALIGNMENT_GAIN
        ? angle * RADIANS_PER_DEGREE : 0;
}

export async function runDeskewedOcr(source, pageNum, geometry, languages, deadline, gridRetry = null) {
    const angle = scanSkew(source);
    if (!angle) return null;

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const width = cos * source.width + Math.abs(sin) * source.height;
    const height = cos * source.height + Math.abs(sin) * source.width;
    const limit = Math.max(source.width, source.height);
    const scale = limit / Math.max(width, height);
    const canvas = createCanvas(Math.min(limit, Math.ceil(width * scale)), Math.min(limit, Math.ceil(height * scale)));
    const ctx = fillCanvasWhite(canvas);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(scale, scale);
    ctx.rotate(-angle);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
    const now = Date.now();
    const candidateDeadline = now + Math.floor((deadline - now) / 2);
    const upright = { pixelWidth: canvas.width, pixelHeight: canvas.height, pageWidth: canvas.width, pageHeight: canvas.height };
    const result = await runTesseractOcr(await canvas.encode('png'), pageNum, upright, languages, candidateDeadline);
    if (!result.ok) return null;

    const sx = geometry.pageWidth / source.width;
    const sy = geometry.pageHeight / source.height;
    const inverse = [cos / scale, sin / scale, -sin / scale, cos / scale, 0, 0];
    inverse[4] = source.width / 2 - (inverse[0] * canvas.width + inverse[2] * canvas.height) / 2;
    inverse[5] = source.height / 2 - (inverse[1] * canvas.width + inverse[3] * canvas.height) / 2;
    const originalBounds = ({ x, y, width, height }) => {
        const box = transformUnitRect(multiplyTransform(inverse, [width, 0, 0, height, x, y]));
        const left = Math.max(0, box.x);
        const top = Math.max(0, box.y);
        const right = Math.min(source.width, box.x + box.width);
        const bottom = Math.min(source.height, box.y + box.height);
        return right > left && bottom > top
            ? { x: left * sx, y: top * sy, width: (right - left) * sx, height: (bottom - top) * sy } : null;
    };
    let extracted = result;
    if (!result.correctedRotation) {
        const refined = gridRetry ? await retryRuledGrid(canvas, upright, result, {
            ...gridRetry,
            renderCrop: async clip => {
                const sourceClip = originalBounds(clip);
                if (!sourceClip) return null;
                const crop = await gridRetry.renderCrop(sourceClip);
                const zoom = Math.min(gridRetry.scale * Math.min(sx, sy) / scale, gridRetry.maxDimension / Math.max(clip.width, clip.height));
                const rectified = createCanvas(Math.ceil(clip.width * zoom), Math.ceil(clip.height * zoom));
                const target = fillCanvasWhite(rectified);
                target.scale(zoom, zoom);
                target.translate(canvas.width / 2 - clip.x, canvas.height / 2 - clip.y);
                target.scale(scale, scale);
                target.rotate(-angle);
                target.drawImage(crop, sourceClip.x / sx - source.width / 2, sourceClip.y / sy - source.height / 2,
                    sourceClip.width / sx, sourceClip.height / sy);
                return rectified;
            },
        }).catch(() => null) : null;
        extracted = extractScannedTables(canvas, upright, result, refined);
    }
    const tables = extracted.tables ?? [];
    for (const item of [...extracted.words, ...extracted.blocks, ...tables, ...tables.flatMap(table => table.cells.flat())]) {
        if (item.bbox) item.bbox = originalBounds(item.bbox);
    }
    return extracted;
}
