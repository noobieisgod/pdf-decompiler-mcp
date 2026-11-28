import { unionBBoxes } from '../model/geometry.mjs';

const MAX_RULES = 64;
const MIN_RULE_LENGTH = 0.075;
const ENDPOINT_TOLERANCE = 3;
const MAX_RULE_THICKNESS = 5;
const MIN_WORD_OVERLAP = 0.8;
const MIN_CELL_PIXELS = 8;

function scanRules(along, across, isDark) {
    const rules = [];
    let previous = [];
    for (let axis = 0; axis < along; axis++) {
        const current = [];
        let start = 0;
        for (let point = 0; point <= across; point++) {
            if (point < across && isDark(axis, point)) continue;
            if (point - start >= across * MIN_RULE_LENGTH) {
                const neighbor = previous.find(rule => Math.abs(rule.start - start) <= 2 && Math.abs(rule.end - point) <= 2);
                const rule = neighbor ?? { first: axis, last: axis, start, end: point };
                if (!neighbor) rules.push(rule);
                rule.last = axis;
                current.push(rule);
            }
            start = point + 1;
        }
        previous = current;
        if (rules.length > MAX_RULES) return [];
    }
    return rules.filter(rule => rule.last - rule.first < MAX_RULE_THICKNESS)
        .map(rule => ({ axis: (rule.first + rule.last) / 2, start: rule.start, end: rule.end }));
}

function hasIntersection(horizontal, vertical) {
    return horizontal.axis >= vertical.start - ENDPOINT_TOLERANCE && horizontal.axis <= vertical.end + ENDPOINT_TOLERANCE
        && vertical.axis >= horizontal.start - ENDPOINT_TOLERANCE && vertical.axis <= horizontal.end + ENDPOINT_TOLERANCE;
}

function findGrids(canvas) {
    const { width, height } = canvas;
    const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const dark = (x, y) => {
        const offset = (y * width + x) * 4;
        return pixels[offset] + pixels[offset + 1] + pixels[offset + 2] < 384;
    };
    const horizontal = scanRules(height, width, (y, x) => dark(x, y));
    if (horizontal.length < 3) return [];
    const vertical = scanRules(width, height, dark);
    if (vertical.length < 3) return [];
    const supports = horizontal.map(rule => vertical.filter(candidate => hasIntersection(rule, candidate)));
    const candidates = [];
    for (let top = 0; top < horizontal.length - 2; top++) {
        for (let bottom = top + 2; bottom < horizontal.length; bottom++) {
            const columns = supports[top].filter(rule => hasIntersection(horizontal[bottom], rule));
            if (columns.length < 3 || columns.some((rule, index) => index && rule.axis - columns[index - 1].axis < MIN_CELL_PIXELS)) continue;
            const rows = horizontal.slice(top, bottom + 1).filter(rule => columns.every(column => hasIntersection(rule, column)));
            if (rows.length >= 3 && rows.every((rule, index) => !index || rule.axis - rows[index - 1].axis >= MIN_CELL_PIXELS)) {
                candidates.push({ rows: rows.map(rule => rule.axis), columns: columns.map(rule => rule.axis) });
            }
        }
    }
    return candidates.sort((a, b) => b.rows.length * b.columns.length - a.rows.length * a.columns.length
        || a.rows[0] - b.rows[0] || a.columns[0] - b.columns[0]);
}

function readGrid({ rows, columns }, words, scaleX, scaleY) {
    const left = columns[0];
    const top = rows[0];
    const right = columns.at(-1);
    const bottom = rows.at(-1);
    const cellWords = Array.from({ length: rows.length - 1 }, () => Array.from({ length: columns.length - 1 }, () => []));
    const used = [];
    for (const word of words) {
        if (!word.bbox) continue;
        const { x, y, width, height } = word.bbox;
        const cx = (x + width / 2) * scaleX;
        const cy = (y + height / 2) * scaleY;
        if (cx <= left || cx >= right || cy <= top || cy >= bottom) continue;
        const row = rows.findIndex(line => line > cy) - 1;
        const column = columns.findIndex(line => line > cx) - 1;
        const overlapX = Math.min(columns[column + 1], (x + width) * scaleX) - Math.max(columns[column], x * scaleX);
        const overlapY = Math.min(rows[row + 1], (y + height) * scaleY) - Math.max(rows[row], y * scaleY);
        if (overlapX < width * scaleX * MIN_WORD_OVERLAP || overlapY < height * scaleY * MIN_WORD_OVERLAP) return null;
        cellWords[row][column].push(word);
        used.push(word);
    }
    const populatedRows = cellWords.filter(row => row.some(cell => cell.length));
    const populatedColumns = columns.slice(1).filter((_, index) => cellWords.some(row => row[index].length));
    const occupied = cellWords.flat().filter(cell => cell.length).length;
    if (populatedRows.length < 2 || populatedColumns.length < 2 || occupied * 2 < cellWords.length * cellWords[0].length) return null;
    const cells = cellWords.map((row, rowIndex) => row.map((cell, columnIndex) => ({
        text: cell.sort((a, b) => a.sourceIndex - b.sourceIndex).map(word => word.text).join(' '),
        bbox: {
            x: columns[columnIndex] / scaleX,
            y: rows[rowIndex] / scaleY,
            width: (columns[columnIndex + 1] - columns[columnIndex]) / scaleX,
            height: (rows[rowIndex + 1] - rows[rowIndex]) / scaleY,
        },
    })));
    return { used, table: { bbox: { x: left / scaleX, y: top / scaleY, width: (right - left) / scaleX, height: (bottom - top) / scaleY },
        rows: cells.map(row => row.map(cell => cell.text)), cells } };
}

export function extractScannedTables(canvas, geometry, ocr) {
    const used = new Set();
    const tables = [];
    const accepted = [];
    for (const grid of findGrids(canvas)) {
        if (accepted.some(other => grid.columns[0] < other.columns.at(-1) && grid.columns.at(-1) > other.columns[0]
            && grid.rows[0] < other.rows.at(-1) && grid.rows.at(-1) > other.rows[0])) continue;
        const result = readGrid(grid, ocr.words, canvas.width / geometry.pageWidth, canvas.height / geometry.pageHeight);
        if (!result) continue;
        accepted.push(grid);
        tables.push(result.table);
        result.used.forEach(word => used.add(word));
    }
    if (!tables.length) return ocr;
    const blocks = ocr.blocks.flatMap(block => {
        const spans = block.spans.filter(word => !used.has(word));
        if (spans.length === block.spans.length) return [block];
        if (!spans.length) return [];
        const lines = Map.groupBy(spans, word => `${word.block}:${word.paragraph}:${word.line}`);
        const text = [...lines.values()].map(line => line.sort((a, b) => a.bbox.x - b.bbox.x).map(word => word.text).join(' ')).join('\n');
        return [{ ...block, spans, text, bbox: unionBBoxes(spans.map(word => word.bbox), geometry.pageWidth, geometry.pageHeight) }];
    });
    return { ...ocr, blocks, tables: tables.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x) };
}
