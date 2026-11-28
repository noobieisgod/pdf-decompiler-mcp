import { runTesseractOcr } from './ocr.mjs';
import { extractScannedTables } from './ocr-tables.mjs';

const MIN_SPREAD_ASPECT = 1.35;
const GUTTER_BINS = 40;

function findSpreadGutter(canvas) {
    const { width, height } = canvas;
    if (width / height < MIN_SPREAD_ASPECT) return null;
    const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const ink = Array.from({ length: GUTTER_BINS }, (_, bin) => {
        let dark = 0;
        let count = 0;
        for (let x = Math.floor(width * bin / GUTTER_BINS); x < Math.floor(width * (bin + 1) / GUTTER_BINS); x += 2) {
            for (let y = 0; y < height; y += 2) {
                const offset = (y * width + x) * 4;
                if (pixels[offset] + pixels[offset + 1] + pixels[offset + 2] < 510) dark++;
                count++;
            }
        }
        return count ? dark / count : 0;
    });
    const middle = GUTTER_BINS / 2;
    const sideHasText = bins => {
        const occupied = bins.flatMap((value, index) => value >= 0.01 && value <= 0.3 ? [index] : []);
        return occupied.length >= 6 && occupied.at(-1) - occupied[0] >= 8;
    };
    if (!sideHasText(ink.slice(0, middle - 2)) || !sideHasText(ink.slice(middle + 2))) return null;
    for (const split of [middle, middle - 1, middle + 1]) {
        if (ink[split - 1] <= 0.003 && ink[split] <= 0.003) return split / GUTTER_BINS;
    }
    return null;
}

export async function recognizeScannedSpread(canvas, viewport, render, dimension, pageNum, languages, deadline) {
    const gutter = findSpreadGutter(canvas);
    if (!gutter) return null;
    const split = viewport.width * gutter;
    const { height } = viewport;
    const parts = [{ x: 0, y: 0, width: split, height }, { x: split, y: 0, width: viewport.width - split, height }];
    const blocks = [];
    const tables = [];
    const diagnostics = [];
    const text = [];
    const now = Date.now();
    const spreadDeadline = now + Math.floor((deadline - now) * 0.65);
    for (const part of parts) {
        if (Date.now() >= spreadDeadline) return null;
        const scale = dimension / Math.max(part.width, part.height);
        const raster = await render(scale, part);
        const geometry = { pageWidth: part.width, pageHeight: part.height, pixelWidth: raster.width, pixelHeight: raster.height,
            dpi: Math.round(scale * 72) };
        const readTables = result => extractScannedTables(raster, geometry, result);
        const result = await runTesseractOcr(await raster.encode('png'), pageNum, geometry, languages, spreadDeadline, readTables);
        if (!result.ok || result.correctedRotation) return null;
        const extracted = result.tables ? result : readTables(result);
        for (const block of extracted.blocks) {
            if (block.bbox) block.bbox.x += part.x;
            blocks.push(block);
        }
        for (const table of extracted.tables || []) {
            table.bbox.x += part.x;
            for (const cell of table.cells.flat()) cell.bbox.x += part.x;
            tables.push(table);
        }
        diagnostics.push(...result.diagnostics);
        text.push(result.text);
    }
    return { ok: true, blocks, tables, diagnostics, text: text.join('\n\n'), spreadBoundary: split };
}
