import { normalizeBBox, unionBBoxes } from '../model/geometry.mjs';

const PATH_JOIN_GAP = 5;
const LABEL_GAP = 16;
const CROP_PADDING = 5;
const MAX_PATHS = 128;
export const MAX_VECTOR_REGIONS = 4;

function touches(a, b, gap) {
    return a.x - gap < b.x + b.width && a.x + a.width + gap > b.x
        && a.y - gap < b.y + b.height && a.y + a.height + gap > b.y;
}

function overlapsContent(region, other) {
    if (!other || !touches(region, other, 0)) return false;
    const width = Math.min(region.x + region.width, other.x + other.width) - Math.max(region.x, other.x);
    const height = Math.min(region.y + region.height, other.y + other.height) - Math.max(region.y, other.y);
    return width * height >= 0.5 * Math.min(region.width * region.height, other.width * other.height);
}

function padRegion(box, width, height) {
    const x = Math.max(0, box.x - CROP_PADDING);
    const y = Math.max(0, box.y - CROP_PADDING);
    return normalizeBBox({
        x, y,
        width: Math.min(width, box.x + box.width + CROP_PADDING) - x,
        height: Math.min(height, box.y + box.height + CROP_PADDING) - y,
    }, width, height);
}

function fractionRegion(rule, blocks, width, height) {
    const middle = rule.y + rule.height / 2;
    const nearby = blocks.filter(block => block.bbox && block.text.length <= 48 && touches(rule, block.bbox, 64));
    const relation = nearby.find(({ bbox, text }) => /[=≈≤≥≠]/u.test(text) && middle >= bbox.y - 3 && middle <= bbox.y + bbox.height + 3);
    if (!relation) return null;
    const operands = nearby.filter(({ bbox }) => bbox.x >= rule.x - 3 && bbox.x + bbox.width <= rule.x + rule.width + 3);
    const offset = ({ bbox }) => bbox.y + bbox.height / 2 - middle;
    const above = operands.find(block => offset(block) < -3 && offset(block) >= -25);
    const below = operands.find(block => offset(block) > 3 && offset(block) <= 25);
    if (!above || !below) return null;
    let region = unionBBoxes([rule, relation.bbox, above.bbox, below.bbox], width, height);
    const inline = nearby.filter(({ bbox }) => bbox.width <= 120 && bbox.y >= region.y - 4 && bbox.y + bbox.height <= region.y + region.height + 4)
        .sort((a, b) => a.bbox.x - b.bbox.x);
    for (const { bbox } of inline) {
        if (touches(region, bbox, 18)) region = unionBBoxes([region, bbox], width, height);
    }
    return region;
}

function usablePaths(signal) {
    if (signal.uncertain || signal.vectorBounds.length > MAX_PATHS) return [];
    return signal.vectorBounds.filter(box => box.precision === 'approximate');
}

export function findFractionRegions(signal, viewport, items, existingRegions) {
    const { width, height } = viewport;
    const paths = usablePaths(signal).filter(rule => rule.height <= 2 && rule.width >= 10 && rule.width <= 80);
    if (!paths.length) return [];
    const blocks = items.filter(item => item.bbox).map(item => ({ bbox: item.bbox, text: item.str }));
    const crops = [];
    for (const rule of paths) {
        if ([...existingRegions, ...crops].some(box => overlapsContent(rule, box))) continue;
        const fraction = fractionRegion(rule, blocks, width, height);
        if (!fraction) continue;
        const bbox = padRegion(fraction, width, height);
        if (bbox) crops.push(bbox);
        if (crops.length === MAX_VECTOR_REGIONS) break;
    }
    return crops;
}

export function findVectorRegions(signal, viewport, nativeBlocks, existingRegions, limit) {
    const { width, height } = viewport;
    const paths = usablePaths(signal);
    if (paths.length < 3 || limit <= 0) return [];
    const seen = new Set();
    const candidates = [];
    for (const seed of paths) {
        if (seen.has(seed)) continue;
        seen.add(seed);
        const component = [seed];
        for (const current of component) {
            for (const neighbor of paths) {
                if (seen.has(neighbor) || !touches(current, neighbor, PATH_JOIN_GAP)) continue;
                seen.add(neighbor);
                component.push(neighbor);
            }
        }
        if (component.length < 3 || !component.some(path => path.width >= 15 && path.height >= 15)) continue;
        const box = unionBBoxes(component, width, height);
        if (!box || box.width < 64 || box.height < 48 || box.width * box.height > width * height * 0.65) continue;
        if (existingRegions.some(existing => overlapsContent(box, existing))) continue;

        // Close labels belong in the crop. Leave the original text blocks available for search.
        const labels = nativeBlocks.filter(block => block.bbox && block.text.length <= 60 && block.bbox.width <= box.width * 0.5
            && touches(box, block.bbox, LABEL_GAP));
        const combined = unionBBoxes([box, ...labels.map(block => block.bbox)], width, height);
        const bbox = padRegion(combined, width, height);
        if (bbox) candidates.push(bbox);
    }
    return candidates.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, limit)
        .sort((a, b) => a.y - b.y || a.x - b.x);
}
