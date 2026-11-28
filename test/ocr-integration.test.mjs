import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { openMupdfDocument, renderMupdfPageToCanvas } from '../src/backend/mupdf-runtime.mjs';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { loadConfig } from '../src/config/runtime.mjs';
import { missingTesseractLanguages, ocrTextLooksGood } from '../src/extract/ocr.mjs';
import { extractionFingerprint } from '../src/model/canonical.mjs';
import { createCanvas, fillCanvasWhite } from '../src/pdf/canvas.mjs';
import { buildGermanScan, buildRasterScan, buildRotatedScan } from './fixtures/generate-fixtures.mjs';
import { temporaryConfig } from './helpers.mjs';

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
    const document = openMupdfDocument(await fs.readFile(new URL('../evaluation/pdfs/Heavy Test One.pdf', import.meta.url)));
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
