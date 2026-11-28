import { unionBBoxes } from '../model/geometry.mjs';
import { OCR_MIN_MEAN_CONFIDENCE } from '../config/constants.mjs';

const MAX_RULES = 64;
const MIN_RULE_LENGTH = 0.075;
const ENDPOINT_TOLERANCE = 3;
const MAX_RULE_THICKNESS = 5;
const MIN_WORD_OVERLAP = 0.8;
const MIN_CELL_PIXELS = 8;
const NUMERIC_CELL = /^(?:[+−-]?\(?\p{Nd}+(?:[.,]\p{Nd}+)*[.,]?(?:[%‰]|\))?|N[/.]?M\.?|N\/A|[—–-])$/iu;
const MIN_FINANCIAL_ROWS = 4;
const FINANCIAL_COLUMN_TOLERANCE = 5;

function hasUncertainNumber(words) {
    return words.some(word => /\p{Nd}/u.test(word.text) && word.confidence < OCR_MIN_MEAN_CONFIDENCE);
}

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
        rows: cells.map(row => row.map(cell => cell.text)), cells, lowConfidence: hasUncertainNumber(used) } };
}

function makeCell(words) {
    return { text: words.map(word => word.text).join(' '), bbox: unionBBoxes(words.map(word => word.bbox)) };
}

function parseFinancialLine(words) {
    const boundary = words.findLastIndex(word => !NUMERIC_CELL.test(word.text));
    if (boundary < 0 || words.length - boundary - 1 < 3) return null;
    const label = words.slice(0, boundary + 1);
    if (!label.some(word => /\p{L}/u.test(word.text))) return null;
    const values = words.slice(boundary + 1);
    if (values.filter(word => /\p{Nd}/u.test(word.text)).length < 3) return null;
    if (values[0].bbox.x - label.at(-1).bbox.x - label.at(-1).bbox.width < 12) return null;
    return { words, cells: [label, ...values.map(word => [word])], y: words[0].bbox.y,
        labelX: words[0].bbox.x, right: values.map(({ bbox }) => bbox.x + bbox.width) };
}

function financialHeader(line, row) {
    if (!line || line.length !== row.cells.length || row.y - line[0].bbox.y > 24 || !/\p{L}/u.test(line[0].text)) return null;
    if (Math.abs(line[0].bbox.x - row.labelX) > FINANCIAL_COLUMN_TOLERANCE) return null;
    for (let column = 1; column < line.length; column++) {
        const { x, width } = line[column].bbox;
        const center = x + width / 2;
        const right = row.right[column - 1];
        const left = column === 1 ? row.cells[1][0].bbox.x - 20 : row.right[column - 2] + FINANCIAL_COLUMN_TOLERANCE;
        if (center < left || center > right + FINANCIAL_COLUMN_TOLERANCE) return null;
    }
    return line.map(word => [word]);
}

function alignFinancialLine(words, anchor) {
    const cutoff = anchor.cells[1][0].bbox.x - 20;
    const label = words.filter(word => word.bbox.x + word.bbox.width < cutoff);
    if (!label.length || !label.some(word => /\p{L}/u.test(word.text))) return null;
    if (Math.abs(label[0].bbox.x - anchor.labelX) > FINANCIAL_COLUMN_TOLERANCE) return null;
    const values = anchor.right.map(() => []);
    const boundaries = anchor.right.slice(0, -1).map((right, index) => (right + anchor.right[index + 1]) / 2);
    for (const word of words.slice(label.length)) {
        const right = word.bbox.x + word.bbox.width;
        const index = boundaries.findIndex(boundary => right < boundary);
        values[index < 0 ? values.length - 1 : index].push(word);
    }
    if (values.some((cell, index) => !cell.length || Math.abs(cell.at(-1).bbox.x + cell.at(-1).bbox.width - anchor.right[index]) > FINANCIAL_COLUMN_TOLERANCE)) return null;
    if (values.filter(cell => cell.some(word => /\p{Nd}/u.test(word.text) && NUMERIC_CELL.test(word.text))).length < 3) return null;
    return { words, cells: [label, ...values], y: label[0].bbox.y };
}

function readFinancialTables(lines) {
    lines.forEach(line => line.sort((a, b) => a.bbox.x - b.bbox.x));
    lines.sort((a, b) => a[0].bbox.y - b[0].bbox.y);
    const parsed = lines.map(parseFinancialLine);
    const found = [];
    for (let start = 0; start < parsed.length; start++) {
        const row = parsed[start];
        if (!row) continue;
        const aligned = [row];
        let ambiguousRows = 0;
        let end = start + 1;
        for (; end < parsed.length; end++) {
            const current = parsed[end];
            const exactColumns = current && current.right.length === row.right.length
                && Math.abs(current.labelX - row.labelX) <= FINANCIAL_COLUMN_TOLERANCE
                && current.right.every((right, index) => Math.abs(right - row.right[index]) <= FINANCIAL_COLUMN_TOLERANCE);
            const next = exactColumns ? current : alignFinancialLine(lines[end], row);
            if (!next || next.y - aligned.at(-1).y > 27 || next.y - aligned.at(-1).y < 3) break;
            if (!exactColumns) ambiguousRows += 1;
            aligned.push(next);
        }
        if (aligned.length < MIN_FINANCIAL_ROWS || aligned.length - ambiguousRows < MIN_FINANCIAL_ROWS - 1) continue;
        const body = aligned.map(item => item.cells);
        const header = financialHeader(lines[start - 1], row);
        const continuation = lines[end];
        const last = aligned.at(-1);
        if (continuation && !parsed[end] && continuation[0].block === last.words[0].block && continuation[0].paragraph === last.words[0].paragraph
            && continuation[0].bbox.y - last.y <= 10 && Math.abs(continuation[0].bbox.x - last.labelX) <= FINANCIAL_COLUMN_TOLERANCE
            && continuation.at(-1).bbox.x + continuation.at(-1).bbox.width < last.cells[1][0].bbox.x - 12) body.at(-1)[0].push(...continuation);
        const all = header ? [header, ...body] : body;
        const cells = all.map(line => line.map(makeCell));
        const bbox = unionBBoxes(cells.flat().map(cell => cell.bbox));
        const used = all.flat(2);
        if (bbox) found.push({ used, table: { bbox, rows: cells.map(line => line.map(cell => cell.text)), cells,
            headerRows: Number(Boolean(header)), lowConfidence: ambiguousRows > 0 || hasUncertainNumber(used) } });
        start = end - 1;
    }
    return found;
}

function groupByRowCenter(words) {
    const center = ({ bbox }) => bbox.y + bbox.height / 2;
    const rows = [];
    for (const word of words.sort((a, b) => center(a) - center(b))) {
        const row = rows.at(-1);
        if (row && center(word) - center(row[0]) <= 4) row.push(word);
        else rows.push([word]);
    }
    return rows;
}

export function extractScannedTables(canvas, geometry, ocr, allowFinancialLayout = false) {
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
    if (allowFinancialLayout) {
        const remaining = () => ocr.words.filter(word => word.bbox && !used.has(word));
        const lines = [...Map.groupBy(remaining(), word => `${word.block}:${word.paragraph}:${word.line}`).values()];
        for (const read of [() => readFinancialTables(lines), () => readFinancialTables(groupByRowCenter(remaining()))]) {
            for (const result of read()) {
                if (tables.some(table => {
                    const { x, y, width, height } = result.table.bbox;
                    const box = table.bbox;
                    return x < box.x + box.width && x + width > box.x && y < box.y + box.height && y + height > box.y;
                })) continue;
                tables.push(result.table);
                result.used.forEach(word => used.add(word));
            }
        }
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
