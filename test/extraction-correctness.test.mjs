import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config/runtime.mjs';
import { extractPageContent } from '../src/extract/document.mjs';
import { anchorLinkAnnotations } from '../src/extract/links.mjs';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { FigureElementSchema, LinkElementSchema, ParserErrorCodeSchema } from '../src/server/schemas.mjs';
import { buildCjkPdf, buildRightAlignedTablePdf, buildSyntheticPdf, buildVectorChartPdf } from './fixtures/generate-fixtures.mjs';
import { temporaryConfig } from './helpers.mjs';

const fixtureRoot = path.resolve('test/fixtures/generated');

test('bundled character maps decode Chinese and Japanese composite-font text offline', async () => {
    const result = await extractPageContent(buildCjkPdf(), undefined, 1200, { ocrPolicy: 'off' });
    assert.match(result.pages[0].text, /先進製程與資訊安全/u);
    assert.match(result.pages[1].text, /半導体輸出規制/u);
    assert.ok(result.pages.every(page => page.textBlocks.some(block => block.bbox?.width > 0)));
});

test('vertical Japanese columns read top to bottom and right to left with cited geometry', async t => {
    const { root, config } = await temporaryConfig(t, { ocrPolicy: 'off' });
    const source = path.join(root, 'vertical-japanese.pdf');
    const bytes = buildCjkPdf({ vertical: true });
    await fs.writeFile(source, bytes);
    const raw = await extractPageContent(bytes, undefined, 1200, { ocrPolicy: 'off' });
    assert.equal(raw.pages[0].text, '右から読む日本語\n縦書きの文章');

    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const { documentId, extractionFingerprint } = await manager.open({ source });
    const reference = { documentId, extractionFingerprint };
    const result = await manager.getPages({ ...reference, mode: 'text' });
    assert.deepEqual(result.elements.map(element => element.text), ['右から読む日本語', '縦書きの文章']);
    const [right, left] = result.elements;
    assert.ok(right.bbox.x > left.bbox.x && right.bbox.height > right.bbox.width);
    assert.deepEqual(right.citation.bbox, right.bbox);
    const search = await manager.search({ ...reference, query: '読む日本', strategy: 'phrase' });
    assert.equal(search.results[0].citation.elementId, right.id);
});

test('reusing the header pass produces the same extraction as loading each page again', async () => {
    const bytes = buildSyntheticPdf({ pages: ['First body', 'Second body'], link: true });
    const options = { ocrPolicy: 'off' };
    const reused = await extractPageContent(bytes, undefined, 1200, options);
    const reloaded = await extractPageContent(bytes, undefined, 1200, { ...options, maxDecompressedBytes: 12_000 });
    assert.equal(reused.pages.length, 2);
    assert.deepEqual(reused, reloaded);
});

async function managerFor(t) {
    const manager = await new DocumentManager(loadConfig({ cacheMode: 'none', allowRoots: [fixtureRoot], ocrPolicy: 'off', extractionTimeoutMs: 50_000 })).init();
    t.after(() => manager.close());
    return manager;
}

async function modelFor(manager, name) {
    const opened = await manager.open({ source: path.join(fixtureRoot, name), ocrPolicy: 'off' });
    const state = await manager.requireState(opened.documentId, opened.extractionFingerprint);
    return { opened, state, model: state.model };
}

test('text retrieval distinguishes an OCR-disabled scan from a blank page', async t => {
    const manager = await managerFor(t);
    const scan = await modelFor(manager, 'scan-readable.pdf');
    const scanned = await manager.getPages({ ...scan.opened, pages: [1], mode: 'text', outputFormat: 'markdown' });
    assert.equal(scanned.markdown, '');
    assert.deepEqual(scanned.warnings, [{
        code: 'page_warning',
        message: 'No native text was extracted from this image-only page. OCR is disabled by policy. Use pdf_render_page to inspect the page visually.',
        page: 1,
    }]);
    const scanSearch = await manager.search({ ...scan.opened, query: 'missing words', strategy: 'phrase' });
    assert.deepEqual(scanSearch.textCoverage, { unprocessedPages: 0, uncertainPages: 1 });
    assert.ok(scanSearch.warnings.some(warning => warning.code === 'search_text_coverage_incomplete'));
    const blank = await modelFor(manager, 'blank.pdf');
    const empty = await manager.getPages({ ...blank.opened, pages: [1], mode: 'text', outputFormat: 'markdown' });
    assert.equal(empty.markdown, '');
    assert.deepEqual(empty.warnings, [{ code: 'page_warning', message: 'Blank page', page: 1 }]);
    const blankSearch = await manager.search({ ...blank.opened, query: 'missing words', strategy: 'phrase' });
    assert.deepEqual(blankSearch.textCoverage, { unprocessedPages: 0, uncertainPages: 0 });
    assert.deepEqual(blankSearch.warnings, []);
});

function assertValidBbox(bbox, page) {
    assert.ok(bbox);
    assert.ok(bbox.width > 0 && bbox.height > 0);
    assert.ok(bbox.x >= 0 && bbox.y >= 0);
    assert.ok(bbox.x + bbox.width <= page.width + 0.001);
    assert.ok(bbox.y + bbox.height <= page.height + 0.001);
}

test('real extraction preserves text and rotated displayed-page geometry', async t => {
    const manager = await managerFor(t);
    for (const name of ['text-layout.pdf', 'rotated.pdf']) {
        const { opened, state, model } = await modelFor(manager, name);
        for (const block of model.elements.filter(element => element.type === 'block')) {
            const page = state.indexes.pages.get(block.page);
            assertValidBbox(block.bbox, page);
            assert.deepEqual(block.citation.bbox, block.bbox);
        }
        if (name === 'rotated.pdf') assert.deepEqual(model.pages.map(page => page.rotation), [90, 270]);
        await manager.closeDocument(opened);
    }
});

test('real links retain typed text, geometry, and structured destinations', async t => {
    const manager = await managerFor(t);
    const { opened, state, model } = await modelFor(manager, 'links.pdf');
    const links = model.elements.filter(element => element.type === 'link');
    assert.equal(links.length, 4);
    assert.ok(links.every(link => link.text === null || typeof link.text === 'string'));
    assert.ok(links.every(link => LinkElementSchema.safeParse(link).success));
    assert.equal(links.find(link => link.destination?.kind === 'named').destination.name, 'ChapterTwo');
    const explicit = links.find(link => link.destination?.kind === 'explicit').destination;
    assert.equal(explicit.page, 2);
    assert.ok(Number.isFinite(explicit.x) && Number.isFinite(explicit.y));
    assert.ok(links.some(link => link.url && link.text === null));
    links.forEach(link => assertValidBbox(link.bbox, state.indexes.pages.get(link.page)));
    await manager.closeDocument(opened);
});

test('geometry fallback anchors are bounded, deterministic, and exclude unrelated spans', () => {
    const spans = [
        { str: 'First', bbox: { x: 10, y: 10, width: 30, height: 10 }, x: 10, yTop: 10, w: 30, h: 10 },
        { str: 'anchor', bbox: { x: 44, y: 10, width: 40, height: 10 }, x: 44, yTop: 10, w: 40, h: 10 },
        { str: 'Unrelated', bbox: { x: 200, y: 10, width: 60, height: 10 }, x: 200, yTop: 10, w: 60, h: 10 },
    ];
    const result = anchorLinkAnnotations(spans, [{ bbox: { x: 9, y: 9, width: 80, height: 12 }, url: 'https://example.com', destination: null, sourceId: 'one', subtype: 'Link', sourceIndex: 0 }]);
    assert.equal(result.links[0].text, 'First anchor');
    assert.ok(!result.links[0].text.includes('Unrelated'));
});

test('real adjacent, overlapping, and multiline links retain bounded visible anchors', async t => {
    const manager = await managerFor(t);
    const { opened, model } = await modelFor(manager, 'links-overlap.pdf');
    const links = model.elements.filter(element => element.type === 'link');
    assert.deepEqual(links.slice(0, 2).map(link => link.text), ['Adjacent one', 'Adjacent two']);
    assert.equal(links.find(link => link.url.endsWith('/multiline')).text, 'Multiline anchor first Multiline anchor second');
    const large = links.find(link => link.url.endsWith('/large'));
    assert.ok(!large.text.includes('Nearby unrelated text'));
    assert.ok(links.every(link => LinkElementSchema.safeParse(link).success));
    await manager.closeDocument(opened);
});

test('real annotations preserve subtype, contents, metadata, and geometry', async t => {
    const manager = await managerFor(t);
    const { opened, state, model } = await modelFor(manager, 'annotations.pdf');
    const annotations = model.elements.filter(element => element.type === 'annotation');
    assert.ok(annotations.length >= 4);
    assert.ok(new Set(annotations.map(value => value.subtype)).has('Highlight'));
    assert.ok(new Set(annotations.map(value => value.subtype)).has('FreeText'));
    assert.ok(annotations.some(value => value.text === 'Review note' && value.author === 'Alice'));
    assert.ok(annotations.some(value => value.modifiedAt?.startsWith('2025-01-03')));
    assert.ok(annotations.some(value => value.text === 'Reply note' && value.replyToSourceId));
    annotations.forEach(annotation => assertValidBbox(annotation.bbox, state.indexes.pages.get(annotation.page)));
    await manager.closeDocument(opened);
});

test('spatial tables are detected end to end and negative controls remain text', async t => {
    const manager = await managerFor(t);
    for (const name of ['tables-bordered.pdf', 'tables-borderless.pdf']) {
        const { opened, state, model } = await modelFor(manager, name);
        const table = model.elements.find(element => element.type === 'table');
        assert.ok(table);
        assert.equal(table.cells.length, 9);
        assert.ok(table.cells.every(cell => cell.bbox));
        assertValidBbox(table.bbox, state.indexes.pages.get(1));
        await manager.closeDocument(opened);
    }
    const negative = await modelFor(manager, 'table-negative-controls.pdf');
    assert.equal(negative.model.elements.some(element => element.type === 'table'), false);
    await manager.closeDocument(negative.opened);
});

test('raster and vector pages produce figures while clipping-only pages remain blank', async t => {
    const manager = await managerFor(t);
    for (const [name, visualType] of [['raster-photograph.pdf', 'raster'], ['vector-diagram.pdf', 'vector']]) {
        const { opened, state, model } = await modelFor(manager, name);
        assert.equal(model.pages[0].visualType, visualType);
        const figure = model.elements.find(element => element.type === 'figure');
        assert.ok(figure);
        assertValidBbox(figure.bbox, state.indexes.pages.get(1));
        const resource = await manager.readResource(figure.asset.uri);
        assert.ok(resource.blob);
        await manager.closeDocument(opened);
    }
    const clipping = await modelFor(manager, 'vector-clipping.pdf');
    assert.equal(clipping.model.pages[0].contentClass, 'blank');
    assert.equal(clipping.model.elements.length, 0);
    await manager.closeDocument(clipping.opened);
});

test('vector approximation remains bounded and mixed content survives uncertain analysis', async t => {
    const manager = await managerFor(t);
    const transformed = await modelFor(manager, 'vector-transformed.pdf');
    assert.equal(transformed.model.pages[0].visualType, 'vector');
    assert.equal(transformed.model.pages[0].visualSignals.vectorCoverage.precision, 'approximate');
    await manager.closeDocument(transformed.opened);

    const uncertain = await modelFor(manager, 'vector-unsupported.pdf');
    assert.equal(uncertain.model.pages[0].visualType, 'unknown');
    assert.equal(uncertain.model.pages[0].visualSignals.vectorCoverage.precision, 'unknown');
    assert.ok(uncertain.model.pages[0].warnings.some(warning => warning.code === 'visual_unknown'));
    assert.ok(uncertain.model.elements.some(element => element.type === 'figure' && element.figureKind === 'page_visual'));
    await manager.closeDocument(uncertain.opened);

    for (const [name, expected] of [['mixed-text-vector.pdf', 'block'], ['mixed-raster-vector.pdf', 'figure'], ['mixed-text-raster.pdf', 'figure']]) {
        const sample = await modelFor(manager, name);
        assert.ok(sample.model.elements.some(element => element.type === expected));
        await manager.closeDocument(sample.opened);
    }
});

test('vector chart and fraction evidence is cropped lazily while native text and tables stay searchable', async t => {
    const { root, config } = await temporaryConfig(t, { ocrPolicy: 'off' });
    const source = path.join(root, 'vector-chart.pdf');
    await fs.writeFile(source, buildVectorChartPdf());
    const tablePath = path.join(root, 'table.pdf');
    await fs.copyFile(path.join(fixtureRoot, 'tables-bordered.pdf'), tablePath);
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source });
    for (const mode of ['text', 'balanced']) {
        const { elements } = await manager.getPages({ ...opened, mode });
        assert.ok(elements.some(element => element.text === '30 m'));
        assert.equal(elements.some(element => element.type === 'figure'), false);
    }
    const { elements } = await manager.getPages({ ...opened, mode: 'fidelity' });
    const figures = elements.filter(element => element.type === 'figure');
    assert.equal(figures.length, 2);
    const [fraction, figure] = figures.map(value => FigureElementSchema.parse(value));
    assert.equal(fraction.figureKind, 'vector_region');
    assert.ok(fraction.bbox.x <= 75 && fraction.bbox.x + fraction.bbox.width >= 190);
    assert.ok(fraction.bbox.y <= 97 && fraction.bbox.y + fraction.bbox.height >= 148);
    assert.ok((await manager.readResource(fraction.asset.uri)).blob);
    assert.equal(figure.figureKind, 'vector_region');
    assert.equal(figure.asset.sha256, null);
    assert.deepEqual(figure.citation.bbox, figure.asset.deferredRender.bbox);
    const { x, y, width, height } = figure.bbox;
    assert.ok(x <= 55 && y <= 260 && y > 200 && x + width >= 460 && y + height >= 512);
    const resource = await manager.readResource(figure.asset.uri);
    const crop = Buffer.from(resource.blob, 'base64');
    assert.equal(resource.mimeType, 'image/png');
    assert.equal(crop.readUInt32BE(16), Math.ceil(width));
    assert.equal(crop.readUInt32BE(20), Math.ceil(height));
    const rendered = await manager.renderPage({ ...opened, page: 1, bbox: figure.bbox, format: 'png' });
    assert.equal((await manager.readResource(rendered.uri)).blob, resource.blob);
    const search = await manager.search({ ...opened, query: '30 m', strategy: 'phrase' });
    assert.ok(search.results.some(hit => hit.type === 'block'));
    const nativeTable = await manager.open({ source: tablePath });
    const table = await manager.getPages({ ...nativeTable, mode: 'fidelity' });
    assert.ok(table.elements.some(element => element.type === 'table'));
    assert.equal(table.elements.some(element => element.type === 'figure'), false);
});

test('independently positioned columns retain column-major deterministic order', async t => {
    const manager = await managerFor(t);
    const first = await modelFor(manager, 'multi-column.pdf');
    const texts = first.model.elements.filter(element => element.type === 'block').map(element => element.text);
    assert.equal(texts[0], 'LAYOUT HEADING');
    assert.ok(texts.findIndex(text => text.startsWith('Right column')) > texts.findLastIndex(text => text.startsWith('Left column')));
    assert.ok(texts.at(-1).startsWith('Spanning footer'));
    const firstOrder = first.model.elements.map(element => element.id);
    await manager.closeDocument(first.opened);
    const second = await modelFor(manager, 'multi-column.pdf');
    assert.deepEqual(second.model.elements.map(element => element.id), firstOrder);
    await manager.closeDocument(second.opened);
});

test('native numeric columns follow their aligned edges and retain detached headers', async t => {
    const { root, config } = await temporaryConfig(t, { ocrPolicy: 'off' });
    const source = path.join(root, 'power-reserves.pdf');
    const expected = [['Territory', 'Allocation', 'Available', 'Balance'],
        ['South', '18,763,272.5', '13.25', '-76.5%'], ['East', '831.2', '4,370,894.25', '16.3%'],
        ['North', '16,772.8', '837.6', '-1.4%'], ['West', '4.7', '2,217.72', '0.1%']];
    await fs.writeFile(source, buildRightAlignedTablePdf(expected));
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source });
    const { elements } = await manager.getPages({ ...opened, mode: 'text' });
    const [table] = elements.filter(element => element.type === 'table');
    assert.deepEqual(table.rows, expected);
    assert.ok(table.cells.every(cell => cell.bbox?.width > 0));
    assert.ok(table.readingOrder < elements.find(element => element.text?.includes('auditor')).readingOrder);
    const [hit] = (await manager.search({ ...opened, query: '18,763,272.5', strategy: 'phrase' })).results;
    assert.deepEqual(hit.citation.bbox, table.cells.find(cell => cell.text === expected[1][1]).bbox);
});

test('semantic headings, nested lists, ordered starts, and code blocks survive real extraction into Markdown', async t => {
    const manager = await managerFor(t);
    const sample = await modelFor(manager, 'semantic-blocks.pdf');
    const blocks = sample.model.elements.filter(element => element.type === 'block');
    assert.deepEqual(blocks.filter(block => block.role === 'heading').map(block => block.headingLevel), [1, 2]);
    assert.deepEqual(blocks.filter(block => block.role === 'list').map(block => [block.listKind, block.listLevel, block.listStart, block.listContinuation]), [
        ['ordered', 0, 1, false], ['unordered', 1, null, false], ['ordered', 0, 4, false], ['ordered', 0, 4, true],
    ]);
    const continued = blocks.filter(block => block.role === 'list').slice(-2);
    assert.equal(continued[0].listItemId, continued[1].listItemId);
    assert.ok(blocks.some(block => block.role === 'code'));
    const markdown = await manager.getPages({ ...sample.opened, pages: [1], outputFormat: 'markdown', tableDetail: 'full' });
    assert.match(markdown.markdown, /^<!-- pdf-decompiler page=1 -->/);
    assert.match(markdown.markdown, /# PRIMARY HEADING/);
    assert.match(markdown.markdown, /    - Nested unordered item/);
    assert.match(markdown.markdown, /4\. Ordered restart item/);
    assert.match(markdown.markdown, /    Continuation paragraph for ordered item/);
    assert.match(markdown.markdown, /```/);
    await manager.closeDocument(sample.opened);
});

test('public parser code schema rejects arbitrary backend strings', () => {
    assert.equal(ParserErrorCodeSchema.safeParse('PDF_INVALID_XREF').success, true);
    assert.equal(ParserErrorCodeSchema.safeParse('backend said bad xref').success, false);
});
