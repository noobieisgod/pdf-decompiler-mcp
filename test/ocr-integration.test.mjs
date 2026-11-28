import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { GlobalFonts } from '@napi-rs/canvas';
import { openMupdfDocument, renderMupdfPageToCanvas } from '../src/backend/mupdf-runtime.mjs';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { loadConfig } from '../src/config/runtime.mjs';
import { missingTesseractLanguages, ocrTextLooksGood, runTesseractOcr } from '../src/extract/ocr.mjs';
import { extractScannedTables, retryRuledGrid } from '../src/extract/ocr-tables.mjs';
import { extractionFingerprint } from '../src/model/canonical.mjs';
import { createCanvas, fillCanvasWhite } from '../src/pdf/canvas.mjs';
import { buildGermanScan, buildRasterScan, buildRotatedScan } from './fixtures/generate-fixtures.mjs';
import { temporaryConfig } from './helpers.mjs';

async function openAnnualReport(t) {
    try {
        return openMupdfDocument(await fs.readFile(new URL('../evaluation/pdfs/Heavy Test One.pdf', import.meta.url)));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        t.skip('Local annual report unavailable');
        return null;
    }
}

test('OCR language selection is validated and part of the extraction generation', () => {
    const english = loadConfig({ ocrLanguages: 'eng', ocrPolicy: 'auto' });
    const german = { ...english, ocrLanguages: 'deu+eng' };
    assert.equal(loadConfig({ ocrLanguages: german.ocrLanguages }).ocrLanguages, 'deu+eng');
    for (const value of ['', '../deu', 'eng -l deu']) assert.throws(() => loadConfig({ ocrLanguages: value }), /language codes/);
    assert.notEqual(extractionFingerprint(english, 'deps'), extractionFingerprint(german, 'deps'));
    assert.equal(extractionFingerprint({ ...english, ocrPolicy: 'off' }, 'deps'), extractionFingerprint({ ...german, ocrPolicy: 'off' }, 'deps'));
});

test('OCR text validation accepts Unicode letters and unspaced Japanese', () => {
    assert.equal(ocrTextLooksGood('Größe und Übersicht der Öffnungszeiten am Samstag').ok, true);
    assert.equal(ocrTextLooksGood('この資料は半導体製造の工程と輸出管理について説明します').ok, true);
    assert.equal(ocrTextLooksGood('@@@@@@ ### $$$$ === ... //////').ok, false);
});

test('single-line OCR returns a signed decimal for cell confirmation', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async () => {
    const canvas = createCanvas(360, 96);
    const context = fillCanvasWhite(canvas);
    GlobalFonts.registerFromPath(path.resolve('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'), 'CellTestSans');
    context.fillStyle = 'black';
    context.font = '48px CellTestSans';
    context.fillText('-1,240.85', 31, 66);
    const result = await runTesseractOcr(await canvas.encode('png'), 1, { singleLine: true });
    assert.deepEqual(result.words.map(word => word.text), ['-1,240.85']);
    assert.equal(result.ok, false);
});

test('a requested missing OCR pack returns an actionable error', async t => {
    const root = path.resolve('test/fixtures/generated');
    const manager = await new DocumentManager(loadConfig({ cacheMode: 'none', allowRoots: [root], ocrLanguages: 'qqq_missing' })).init();
    t.after(() => manager.close());
    const source = path.join(root, 'multi-column.pdf');
    await assert.rejects(manager.open({ source, ocrPolicy: 'auto' }), { code: 'ocr_language_unavailable' });
    assert.equal((await manager.open({ source, ocrPolicy: 'off' })).completion.documentComplete, true);
});

test('German OCR preserves umlauts and yields searchable citations', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async t => {
    if (missingTesseractLanguages('deu').length) return t.skip('German Tesseract data unavailable');
    const { root, config } = await temporaryConfig(t, { ocrPolicy: 'required', ocrLanguages: 'deu' });
    const source = path.join(root, 'german-scan.pdf');
    await fs.writeFile(source, buildGermanScan());
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source });
    const { elements } = await manager.getPages({ ...opened, mode: 'text' });
    const text = elements.filter(element => element.textSource === 'ocr').map(element => element.text).join(' ');
    assert.match(text, /Größe und Übersicht/);
    assert.match(text, /Straße mit süßen Äpfeln/);
    assert.match(text, /Öffnungszeiten am Samstag/);
    const [hit] = (await manager.search({ ...opened, query: 'Öffnungszeiten', strategy: 'phrase' })).results;
    assert.ok(hit.citation.bbox?.width > 0);
});

test('OCR recovers sideways and upside-down scans with citations in original coordinates', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async t => {
    if (missingTesseractLanguages('osd').length) return t.skip('Tesseract orientation data unavailable');
    const { root, config } = await temporaryConfig(t, { ocrPolicy: 'required' });
    const source = path.join(root, 'rotated-scan.pdf');
    const bytes = buildRotatedScan();
    await fs.writeFile(source, bytes);
    const document = openMupdfDocument(bytes);
    t.after(() => document.destroy());
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source });
    const { elements } = await manager.getPages({ ...opened, mode: 'text' });
    for (const page of [1, 2, 3]) {
        const raster = renderMupdfPageToCanvas(document, page);
        const blocks = elements.filter(element => element.textSource === 'ocr' && element.page === page);
        const text = blocks.map(block => block.text).join(' ');
        assert.match(text, /OCR SUCCESS TEXT/, `page ${page}`);
        assert.match(text, /DETERMINISTIC EVIDENCE/, `page ${page}`);
        for (const block of blocks) {
            assert.deepEqual(block.citation.bbox, block.bbox);
            const { x, y, width, height } = block.bbox;
            assert.ok(x >= 0 && y >= 0 && x + width <= raster.width && y + height <= raster.height);
            assert.equal(height > width, page !== 2, `page ${page}`);
            const pixels = raster.getContext('2d').getImageData(Math.floor(x), Math.floor(y), Math.ceil(width), Math.ceil(height)).data;
            assert.ok(pixels.some((channel, index) => index % 4 === 0 && channel < 128), `page ${page} citation covers visible text`);
        }
    }
    const search = await manager.search({ ...opened, query: 'DETERMINISTIC EVIDENCE', strategy: 'phrase', granularity: 'page' });
    assert.deepEqual(new Set(search.results.map(hit => hit.page)), new Set([1, 2, 3]));
});

test('full-page OCR reads scanned columns separately and cites their text', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async t => {
    const { root, config } = await temporaryConfig(t, { ocrPolicy: 'required' });
    const document = openMupdfDocument(await fs.readFile(new URL('./fixtures/generated/multi-column.pdf', import.meta.url)));
    t.after(() => document.destroy());
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    for (const height of [792, 1300]) {
        const raster = renderMupdfPageToCanvas(document, 1, { width: height * 612 / 792, height });
        const source = path.join(root, `scanned-columns-${height}.pdf`);
        await fs.writeFile(source, buildRasterScan(raster));
        const opened = await manager.open({ source });
        const { elements } = await manager.getPages({ ...opened, mode: 'text' });
        assert.equal(elements.some(element => element.type === 'table'), false);
        const blocks = elements.filter(element => element.textSource === 'ocr');
        const text = blocks.map(block => block.text).join('\n');
        assert.match(text, /LAYOUT HEADING[\s\S]+Left column alpha[\s\S]+Left column theta[\s\S]+Right column one[\s\S]+Right column eight[\s\S]+Spanning footer/);
        const [left] = (await manager.search({ ...opened, query: 'Left column theta', strategy: 'phrase' })).results;
        const [right] = (await manager.search({ ...opened, query: 'Right column one', strategy: 'phrase' })).results;
        assert.ok(left.citation.bbox.x + left.citation.bbox.width < raster.width / 2);
        assert.ok(right.citation.bbox.x > raster.width / 2);
    }
});

test('OCR straightens skewed scans and cites the text on the original page', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async t => {
    const { root, config } = await temporaryConfig(t, { ocrPolicy: 'required' });
    const document = openMupdfDocument(await fs.readFile(new URL('./fixtures/generated/scan-readable.pdf', import.meta.url)));
    t.after(() => document.destroy());
    const original = renderMupdfPageToCanvas(document, 1, { width: 900, height: 1165 });
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    for (const degrees of [-7, 7]) {
        const { width, height } = original;
        const raster = createCanvas(width, height);
        const ctx = fillCanvasWhite(raster);
        ctx.translate(width / 2, height / 2);
        ctx.rotate(degrees * Math.PI / 180);
        ctx.drawImage(original, -width / 2, -height / 2);
        const source = path.join(root, `skewed-${degrees}.pdf`);
        await fs.writeFile(source, buildRasterScan(raster));
        const opened = await manager.open({ source });
        const { elements } = await manager.getPages({ ...opened, mode: 'text' });
        assert.match(elements.filter(element => element.textSource === 'ocr').map(element => element.text).join(' '), /OCR SUCCESS TEXT/);
        const [hit] = (await manager.search({ ...opened, query: 'DETERMINISTIC EVIDENCE', strategy: 'phrase' })).results;
        const box = hit.citation.bbox;
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
        const { data } = ctx.getImageData(0, 0, width, height);
        let ink = 0;
        let covered = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (data[(y * width + x) * 4] >= 128) continue;
                ink++;
                if (x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height) covered++;
            }
        }
        assert.ok(ink > 0 && covered / ink > 0.45, `page at ${degrees}° citation covers visible text`);
    }
});

test('OCR recovers ruled table cells and cites a matching cell on a scanned financial page', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async t => {
    const { root, config } = await temporaryConfig(t, { ocrPolicy: 'required' });
    const document = openMupdfDocument(await fs.readFile(new URL('./fixtures/generated/tables-bordered.pdf', import.meta.url)));
    t.after(() => document.destroy());
    const raster = renderMupdfPageToCanvas(document, 1, { width: Math.round(1600 * 612 / 792), height: 1600 });
    const source = path.join(root, 'scanned-financial-page.pdf');
    await fs.writeFile(source, buildRasterScan(raster, { width: 612, height: 792 }));
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source });
    const { elements } = await manager.getPages({ ...opened, mode: 'text' });
    const [table] = elements.filter(element => element.type === 'table');
    assert.deepEqual(table.rows.map(row => row.slice(1)), [['Revenue', 'Cost'], ['100', '80'], ['120', '90']]);
    assert.equal(table.rows[0][0], 'Quarter');
    assert.ok(table.cells.every(cell => cell.bbox?.width > 0));
    assert.equal(elements.some(element => element.textSource === 'ocr' && /\b120\b/.test(element.text)), false);
    const [hit] = (await manager.search({ ...opened, query: '120', strategy: 'phrase' })).results;
    assert.equal(hit.citation.elementId, table.id);
    assert.deepEqual(hit.citation.bbox, table.cells.find(cell => cell.text === '120').bbox);
    const [combined] = (await manager.search({ ...opened, query: '120 90', strategy: 'phrase' })).results;
    assert.deepEqual(combined.citation.bbox, table.bbox);
});

test('OCR retries small scanned pages at a higher resolution and keeps page coordinates', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async t => {
    const { root, config } = await temporaryConfig(t, { ocrPolicy: 'required' });
    const document = openMupdfDocument(await fs.readFile(new URL('./fixtures/generated/tables-bordered.pdf', import.meta.url)));
    t.after(() => document.destroy());
    const raster = renderMupdfPageToCanvas(document, 1, { width: 1836, height: 2376 });
    const source = path.join(root, 'small-scanned-financial-page.pdf');
    const height = 600;
    const width = height * 612 / 792;
    await fs.writeFile(source, buildRasterScan(raster, { width, height }));
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source });
    const [hit] = (await manager.search({ ...opened, query: '120', strategy: 'phrase' })).results;
    assert.match(hit.snippet, /120(?: \|)? 90/);
    const box = hit.citation.bbox;
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
});

test('OCR retries a dense full-size scan at the default higher resolution', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async t => {
    const { root, config } = await temporaryConfig(t, { ocrPolicy: 'required' });
    const document = await openAnnualReport(t);
    if (!document) return;
    t.after(() => document.destroy());
    const page = document.loadPage(2);
    const [x0, y0, x1, y1] = page.getBounds();
    page.destroy();
    const width = x1 - x0;
    const height = y1 - y0;
    const scale = 2400 / Math.max(width, height);
    const raster = renderMupdfPageToCanvas(document, 3, { width: width * scale, height: height * scale });
    const source = path.join(root, 'dense-scanned-report.pdf');
    await fs.writeFile(source, buildRasterScan(raster, { width, height }));
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source });
    const [hit] = (await manager.search({ ...opened, query: 'Corporate Governance', strategy: 'phrase' })).results;
    const box = hit.citation.bbox;
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
});

test('OCR splits a scanned financial spread and cites the exact reported amounts', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async t => {
    const { root, config } = await temporaryConfig(t, { ocrPolicy: 'required' });
    const document = await openAnnualReport(t);
    if (!document) return;
    t.after(() => document.destroy());
    const page = document.loadPage(63);
    const [x0, y0, x1, y1] = page.getBounds();
    const native = page.toStructuredText();
    const reference = JSON.parse(native.asJSON()).blocks.flatMap(block => block.lines || []);
    native.destroy();
    page.destroy();
    const width = Math.round(x1 - x0);
    const height = Math.round(y1 - y0);
    const raster = renderMupdfPageToCanvas(document, 64, { width: Math.round(3000 * (x1 - x0) / (y1 - y0)), height: 3000 });
    const source = path.join(root, 'financial-spread.pdf');
    await fs.writeFile(source, buildRasterScan(raster, { width, height }));
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source });
    const { elements, nextCursor } = await manager.getPages({ ...opened, mode: 'text', budget: { estimatedTokens: 32_000 } });
    assert.equal(nextCursor, null);
    const tables = elements.filter(element => element.type === 'table');
    assert.deepEqual(tables.map(table => [table.totalRows, table.totalColumns]), [[15, 5], [13, 5]]);
    assert.ok(tables[0].bbox.x + tables[0].bbox.width < width / 2 && tables[1].bbox.x > width / 2);
    assert.ok(elements.filter(element => element.bbox && element.bbox.x + element.bbox.width < width / 2)
        .every(element => element.readingOrder < tables[1].readingOrder));
    const consolidated = tables[0].rows.find(row => row[0] === 'Net Income');
    assert.deepEqual(consolidated, ['Net Income', '1,172,431,759', '837,767,517', '334,664,242', '40%']);
    for (const query of consolidated.slice(1, 3)) {
        const [hit] = (await manager.search({ ...opened, query, strategy: 'phrase' })).results;
        assert.equal(hit.citation.elementId, tables[0].id);
        const box = hit.citation.bbox;
        assert.deepEqual(box, tables[0].cells.find(cell => cell.text === query).bbox);
        const expected = reference.find(line => line.text.trim() === query).bbox;
        const overlapWidth = Math.min(box.x + box.width, expected.x + expected.w) - Math.max(box.x, expected.x);
        const overlapHeight = Math.min(box.y + box.height, expected.y + expected.h) - Math.max(box.y, expected.y);
        assert.ok(overlapWidth > 0 && overlapHeight > 0 && overlapWidth * overlapHeight >= expected.w * expected.h * 0.6);
    }
});

test('OCR reads the left half of a synthetic raster spread before the right', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async t => {
    const { root, config } = await temporaryConfig(t, { ocrPolicy: 'required' });
    const document = openMupdfDocument(await fs.readFile(new URL('./fixtures/generated/multi-column.pdf', import.meta.url)));
    t.after(() => document.destroy());
    const slice = renderMupdfPageToCanvas(document, 1, { width: 1224, height: 1584 });
    const raster = createCanvas(slice.width * 2, slice.height);
    const ctx = fillCanvasWhite(raster);
    ctx.drawImage(slice, 0, 0);
    ctx.drawImage(slice, slice.width, 0);
    const source = path.join(root, 'two-page-scan.pdf');
    await fs.writeFile(source, buildRasterScan(raster, { width: 1224, height: 792 }));
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source });
    const { elements } = await manager.getPages({ ...opened, mode: 'text' });
    assert.equal(elements.some(element => element.type === 'table'), false);
    const left = elements.filter(element => element.bbox?.x < 612);
    const right = elements.filter(element => element.bbox?.x > 612);
    assert.match(left.map(element => element.text).join(' '), /LAYOUT HEADING/);
    assert.match(right.map(element => element.text).join(' '), /LAYOUT HEADING/);
    assert.ok(left.at(-1).readingOrder < right[0].readingOrder);
});

test('financial rows stay structured when OCR splits their columns into separate blocks', () => {
    const canvas = createCanvas(420, 250);
    fillCanvasWhite(canvas);
    const rows = [['Item', 'Plan', 'Actual', 'Delta'], ['Alpha', '1420', '2100', '6100'], ['Beta', '1431', '2137', '6183'],
        ['Gamma', '1442', '2174', '6266'], ['Delta', '1453', '2211', '6349']];
    const words = rows.flatMap((row, line) => row.map((text, column) => ({
        text, line, block: column, paragraph: 1, sourceIndex: column * rows.length + line,
        confidence: line === 2 && column === 3 ? 54 : 96, bbox: { x: 20 + column * 90, y: 20 + line * 17, width: 34, height: 11 },
    })));
    const blocks = [...Map.groupBy(words, word => word.block).values()].map(spans => ({ spans }));
    const [table] = extractScannedTables(canvas, { pageWidth: canvas.width, pageHeight: canvas.height }, { ok: true, words, blocks }).tables;
    assert.deepEqual(table.rows, rows);
    assert.deepEqual(table.cells[2][3].bbox, words[11].bbox);
    assert.equal(table.lowConfidence, true);
});

test('an OCR number split into two words stays in its original table column', () => {
    const canvas = createCanvas(420, 250);
    fillCanvasWhite(canvas);
    const rows = [['Item', 'Plan', 'Actual', 'Delta'], ['Alpha', '1420', '2100', '6100'], ['Beta', '1431', '21,37 000', '6183'],
        ['Gamma', '1442', '2174', '6266'], ['Delta', '1453', '2211', '6349']];
    const words = rows.flatMap((row, line) => row.flatMap((text, column) => text.split(' ').map((word, fragment, items) => ({
        text: word, line, block: 1, paragraph: 1, confidence: 96,
        bbox: { x: 20 + column * 90 + fragment * 17, y: 20 + line * 17, width: 34 / items.length, height: 11 },
    })))).map((word, sourceIndex) => ({ ...word, sourceIndex }));
    const blocks = [{ spans: words }];
    const { tables, blocks: remaining } = extractScannedTables(canvas, { pageWidth: canvas.width, pageHeight: canvas.height }, { ok: true, words, blocks });
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0].rows, rows);
    assert.equal(tables[0].lowConfidence, true);
    assert.deepEqual(remaining, []);
});

test('well-aligned numeric OCR can pass the prose gate with a complete header', () => {
    const canvas = createCanvas(500, 300);
    fillCanvasWhite(canvas);
    const rows = [['Meter zone', 'Inbound total', 'Outbound total', 'Net rate'],
        ['Central sector', '1,200.8', '910.7', '+14.5%'], ['Western', '875.2', '902.4', '-9.70%'],
        ['Airport', '340.3', '317.0', '+5.5%'], ['Harbor', '503.9', '614.5', '-12.0%']];
    const words = rows.flatMap((row, line) => row.flatMap((cell, column) => cell.split(' ').map((text, part) => ({
        text, block: 1, paragraph: 1, line, confidence: 96,
        bbox: { x: 30 + column * 112 + (line && column ? 44 - text.length * 5 : part * 34)
                + (line === 2 && column === 0 ? 8 : 0) + (line === 0 && column === 3 ? 8 : 0),
            y: 20 + line * 33, width: text.length * 5, height: 10 },
    })))).map((word, sourceIndex) => ({ ...word, sourceIndex }));
    const geometry = { pageWidth: canvas.width, pageHeight: canvas.height };
    const input = { ok: false, confidence: { ok: true }, words, blocks: [{ spans: words }], text: rows.map(row => row.join(' ')).join('\n') };
    assert.equal(ocrTextLooksGood(input.text).ok, false);
    const result = extractScannedTables(canvas, geometry, input);
    assert.equal(result.ok, true);
    assert.equal(result.tables[0].headerRows, 1);
    assert.deepEqual(result.tables[0].rows, rows);
    assert.deepEqual(result.tables[0].cells[2][3].bbox, words.find(word => word.text === '-9.70%').bbox);
    assert.deepEqual(result.blocks, []);

    const noHeader = { ...input, words: words.filter(word => word.line !== 0) };
    assert.equal(extractScannedTables(canvas, geometry, noHeader), noHeader);
    const lowConfidence = { ...input, confidence: { ok: false } };
    assert.equal(extractScannedTables(canvas, geometry, lowConfidence), lowConfidence);
});

test('faint rules restore a numeric table without retrying reliable cell text', async () => {
    const canvas = createCanvas(420, 250);
    const context = fillCanvasWhite(canvas);
    const rows = [['Plant', 'Flow', 'Target'], ['East', '140.5', '148.0'], ['West', '183.0', '171.5'], ['North', '155.5', '158.0']];
    context.strokeStyle = '#c0c0c0';
    context.beginPath();
    for (let x = 20.5; x <= 350.5; x += 110) {
        context.moveTo(x, 30.5);
        context.lineTo(x, 190.5);
    }
    for (let y = 30.5; y <= 190.5; y += 40) {
        context.moveTo(20.5, y);
        context.lineTo(350.5, y);
    }
    context.stroke();
    const words = rows.flatMap((row, line) => row.map((text, column) => ({ text, confidence: 96,
        sourceIndex: line * row.length + column, bbox: { x: 40 + column * 110, y: 40 + line * 40, width: 32, height: 12 } })));
    const geometry = { pageWidth: canvas.width, pageHeight: canvas.height };
    const refined = await retryRuledGrid(canvas, geometry, { words }, { renderCrop: () => assert.fail('OCR text is already reliable') });
    assert.deepEqual(refined.table.rows, rows);
    assert.deepEqual(refined.table.cells[2][2].bbox, { x: 240, y: 110, width: 110, height: 40 });
});

test('automatic OCR recovers cited raster text alongside native text on sparse mixed pages', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async t => {
    const root = path.resolve('test/fixtures/generated');
    const manager = await new DocumentManager(loadConfig({ cacheMode: 'none', allowRoots: [root], extractionTimeoutMs: 50_000 })).init();
    t.after(() => manager.close());
    for (const file of ['image-ocr.pdf', 'multiple-image-ocr.pdf', 'mixed-text-raster.pdf']) {
        const opened = await manager.open({ source: path.join(root, file), ocrPolicy: 'auto' });
        const result = await manager.getPages({ ...opened, pages: [1], mode: 'text' });
        const ocrBlocks = result.elements.filter(element => element.type === 'block' && element.textSource === 'ocr');
        assert.ok(result.elements.some(element => element.type === 'block' && element.textSource === 'native'), file);
        if (file === 'mixed-text-raster.pdf') {
            assert.equal(ocrBlocks.length, 0);
        } else {
            assert.match(ocrBlocks.map(block => block.text).join(' '), /OCR SUCCESS TEXT/i, file);
            assert.ok(ocrBlocks.every(block => block.ocrSource?.figureId && block.citation.bbox), file);
            const search = await manager.search({ ...opened, query: 'DETERMINISTIC EVIDENCE' });
            assert.ok(search.results.some(hit => hit.citation.elementId === ocrBlocks[0].id), file);
        }
        await manager.closeDocument(opened);
    }
});

test('required OCR policy is exercised when Tesseract integration is enabled', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async t => {
    const root = path.resolve('test/fixtures/generated');
    const config = loadConfig({ cacheMode: 'none', allowRoots: [root], ocrPolicy: 'required', extractionTimeoutMs: 50_000 });
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source: path.join(root, 'scan-readable.pdf'), ocrPolicy: 'required' });
    const state = await manager.requireState(opened.documentId, opened.extractionFingerprint);
    assert.equal(state.model.pages[0].ocr.accepted, true);
    assert.equal(state.model.pages[0].ocr.status, 'accepted');
    assert.equal(state.model.pages[0].ocr.attemptedRegions, state.model.pages[0].ocr.acceptedRegions + state.model.pages[0].ocr.rejectedRegions);
    const blocks = state.model.elements.filter(element => element.type === 'block' && element.textSource === 'ocr');
    assert.ok(blocks.length > 0);
    assert.match(blocks.map(block => block.text).join(' '), /OCR SUCCESS TEXT/i);
    assert.ok(blocks.every(block => block.bbox && block.bbox.width > 0 && block.bbox.height > 0));
    assert.ok(blocks.every(block => block.citation.bbox));
    assert.ok(blocks.every(block => block.extractionMethod === 'ocr'));
});

test('required OCR links image-region text to its canonical figure without duplicating native text', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async t => {
    const root = path.resolve('test/fixtures/generated');
    const config = loadConfig({ cacheMode: 'none', allowRoots: [root], ocrPolicy: 'required', extractionTimeoutMs: 50_000 });
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    for (const name of ['image-ocr.pdf', 'multiple-image-ocr.pdf']) {
        const opened = await manager.open({ source: path.join(root, name), ocrPolicy: 'required' });
        const state = await manager.requireState(opened.documentId, opened.extractionFingerprint);
        const ocrBlocks = state.model.elements.filter(element => element.type === 'block' && element.textSource === 'ocr' && element.ocrSource?.scope === 'image');
        assert.ok(ocrBlocks.length > 0, name);
        assert.equal(state.model.pages[0].ocr.attemptedRegions, state.model.pages[0].ocr.acceptedRegions + state.model.pages[0].ocr.rejectedRegions);
        assert.ok(['accepted', 'partial'].includes(state.model.pages[0].ocr.status));
        assert.ok(ocrBlocks.every(block => block.extractionMethod === 'ocr'));
        assert.ok(ocrBlocks.every(block => state.indexes.elements.get(block.ocrSource.figureId)?.type === 'figure'));
        assert.ok(ocrBlocks.every(block => block.bbox && block.ocrSource.bbox));
        const markdown = await manager.getPages({ ...opened, pages: [1], outputFormat: 'markdown', mode: 'fidelity' });
        for (const block of ocrBlocks) {
            const figure = state.indexes.elements.get(block.ocrSource.figureId);
            assert.ok(markdown.markdown.indexOf(figure.asset.uri) < markdown.markdown.indexOf(`element=${block.id}`));
            assert.equal(markdown.markdown.split(`element=${block.id}`).length - 1, 1);
        }
        if (name === 'image-ocr.pdf') {
            const first = await manager.getPages({ ...opened, pages: [1], outputFormat: 'markdown', mode: 'fidelity', budget: { responseBytes: 2200, estimatedTokens: 2000 } });
            const second = await manager.getPages({ ...opened, pages: [1], outputFormat: 'markdown', mode: 'fidelity', budget: { responseBytes: 2200, estimatedTokens: 2000 }, cursor: first.nextCursor });
            const figure = state.indexes.elements.get(ocrBlocks[0].ocrSource.figureId);
            assert.match(first.markdown, new RegExp(`element=${figure.id}`));
            assert.doesNotMatch(first.markdown, new RegExp(`element=${ocrBlocks[0].id}`));
            assert.match(second.markdown, new RegExp(`element=${ocrBlocks[0].id}`));
            assert.ok(second.omissions.some(omission => omission.id === figure.id && omission.reason === 'associated_figure_omitted'));
            assert.equal(second.nextCursor, null);
        }
        await manager.closeDocument(opened);
    }
});
