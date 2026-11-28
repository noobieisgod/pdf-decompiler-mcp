import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCanonicalModel } from '../src/model/canonical.mjs';
import { BM25_INDEX_VERSION, buildBm25, searchBm25, tokenize } from '../src/search/bm25.mjs';
import { rawDocument } from './helpers.mjs';

const config = { extractorVersion: '3.0.0', maxPages: 5000, ocrPolicy: 'auto' };
const model = buildCanonicalModel(Buffer.from('%PDF-alpha'), rawDocument(), config, 'deps');

test('BM25 is deterministic, Unicode normalized, positioned, and indexes metadata and outlines', () => {
    assert.deepEqual(tokenize('ＲＥＶＥＮＵＥ café'), ['revenue', 'café']);
    assert.deepEqual(tokenize('Q3年度 レポート'), ['q3', '年', '度', 'レ', 'ポ', 'ー', 'ト']);
    const index = buildBm25(model);
    assert.deepEqual(index, buildBm25(model));
    assert.ok(index.documents.every(document => Object.keys(document.positions).length));
    assert.equal(searchBm25(index, 'Revenue Overview')[0].type, 'outline');
    assert.equal(searchBm25(index, 'Synthetic Alpha')[0].type, 'metadata');
    assert.ok(searchBm25(index, 'deterministic').every(result => result.citation.extractionFingerprint === model.extractionFingerprint));
});

test('BM25 indexes prototype-named tokens without object prototype collisions', () => {
    const constructorModel = buildCanonicalModel(Buffer.from('%PDF-constructor'), {
        ...rawDocument(1),
        pages: [{ ...rawDocument(1).pages[0], text: 'constructor prototype toString', textBlocks: [{ text: 'constructor prototype toString', role: 'text', bbox: { x: 10, y: 10, width: 200, height: 20 } }] }],
    }, config, 'deps');
    const index = buildBm25(constructorModel);
    assert.equal(index.version, BM25_INDEX_VERSION);
    assert.ok(searchBm25(index, 'constructor')[0].snippet.includes('constructor'));
    const persisted = JSON.parse(JSON.stringify(index));
    assert.deepEqual(searchBm25(persisted, 'constructor prototype'), searchBm25(index, 'constructor prototype'));
    assert.deepEqual(searchBm25(persisted, 'hasOwnProperty'), []);
    assert.ok(persisted.documents.every(document => !('tokens' in document) && !('contextText' in document)));
});

test('BM25 snippets include neighboring values and adjacent hits are grouped without repeated page fragments', () => {
    const raw = rawDocument(1);
    raw.pages[0].tables = [];
    raw.pages[0].textBlocks = [
        { text: 'Net Income', role: 'text', bbox: { x: 10, y: 10, width: 100, height: 10 } },
        { text: 'NT$1,173.27 billion', role: 'text', bbox: { x: 120, y: 10, width: 150, height: 10 } },
        { text: 'Net Income attributable', role: 'text', bbox: { x: 10, y: 30, width: 170, height: 10 } },
    ];
    const local = buildCanonicalModel(Buffer.from('%PDF-search-context'), raw, config, 'deps');
    const results = searchBm25(buildBm25(local), 'Net Income');
    assert.ok(results[0].snippet.includes('NT$1,173.27 billion'));
    assert.equal(new Set(results.map(result => `${result.page}:${result.snippet}`)).size, results.length);
    assert.ok(results.every(result => result.contributingElementIds.length >= 1));
});

test('phrase search requires the normalized token sequence, including repeated words', () => {
    const raw = rawDocument(1);
    raw.pages[0].tables = [];
    raw.pages[0].textBlocks = [
        { text: 'Income net net', role: 'text', bbox: { x: 10, y: 10, width: 100, height: 10 } },
        { text: 'Net income', role: 'text', bbox: { x: 10, y: 30, width: 100, height: 10 } },
        { text: 'Opening note. '.repeat(80) + 'Ｎｅｔ net income rises.', role: 'text', bbox: { x: 10, y: 50, width: 100, height: 10 } },
    ];
    const index = buildBm25(buildCanonicalModel(Buffer.from('%PDF-search-phrase'), raw, config, 'deps'));
    const expected = index.documents.find(document => document.text.includes('income rises'));
    const [hit, ...other] = searchBm25(index, 'net net income', { phrase: true });
    assert.deepEqual(other, []);
    assert.deepEqual(hit.contributingElementIds, [expected.id]);
    assert.match(hit.snippet, /Net net income rises\./);
    assert.throws(() => searchBm25(index, 'net '.repeat(65), { phrase: true }), { code: 'invalid_input' });
});

test('page search ranks repeated exact evidence and returns one cited match per page', () => {
    const raw = rawDocument(2);
    const block = (text, y) => ({ text, role: 'text', bbox: { x: 10, y, width: 160, height: 10 } });
    raw.pages[0].tables = [];
    raw.pages[1].tables = [];
    raw.pages[0].textBlocks = [block('Net income', 10)];
    raw.pages[1].textBlocks = [
        block('Income improved after reporting', 10),
        block('Net income increased', 40),
        block('Net income by region', 80),
    ];
    const index = buildBm25(buildCanonicalModel(Buffer.from('%PDF-search-pages'), raw, config, 'deps'));
    const hits = searchBm25(index, 'net income', { granularity: 'page' });
    assert.deepEqual(hits.map(hit => hit.page), [2, 1]);
    assert.match(hits[0].snippet, /Net income/);
    assert.equal(hits[0].citation.pageId, 'page:2');
    assert.deepEqual(searchBm25(index, 'net income', { granularity: 'page', pages: [1] }).map(hit => hit.page), [1]);
});

test('the page excerpt shows the cited match even if an earlier neighbor contains the query', () => {
    const raw = rawDocument(1);
    const block = (text, y) => ({ text, role: 'text', bbox: { x: 10, y, width: 180, height: 10 } });
    raw.pages[0].tables = [];
    raw.pages[0].textBlocks = [
        block('Budget sidebar. ' + 'sidebar '.repeat(80), 10),
        block('budget budget budget budget actual matching result', 30),
        block('The recommended allocation is $120.', 50),
    ];
    const index = buildBm25(buildCanonicalModel(Buffer.from('%PDF-cited-excerpt'), raw, config, 'deps'));
    const [hit] = searchBm25(index, 'budget', { granularity: 'page' });
    assert.equal(hit.citation.elementId, 'block:1:2');
    assert.match(hit.snippet, /actual matching result/);
    assert.match(hit.snippet, /recommended allocation is \$120/);
    assert.ok(hit.snippet.length <= 500);
});

test('excerpt offsets use whole tokens and handle Unicode case expansion', () => {
    const raw = rawDocument(1);
    raw.pages[0].tables = [];
    raw.pages[0].textBlocks[0].text = 'Internetwork. ' + 'İ '.repeat(600) + ' Net profit increased. ' + 'closing '.repeat(50);
    const index = buildBm25(buildCanonicalModel(Buffer.from('%PDF-unicode-excerpt'), raw, config, 'deps'));
    for (const phrase of [false, true]) {
        const [hit] = searchBm25(index, 'net', { phrase, snippetChars: 80 });
        assert.match(hit.snippet, /Net profit increased/);
        assert.ok(hit.snippet.length <= 80);
    }
});

test('phrase search finds consecutive Chinese and Japanese characters within sentences', () => {
    const raw = rawDocument(2);
    const sentences = ['公司營運包括先進製程與資訊安全。', '当社の半導体輸出規制と製造業の状況'];
    raw.pages.forEach((page, index) => {
        page.tables = [];
        page.textBlocks = [{ text: sentences[index], role: 'text', bbox: { x: 10, y: 10, width: 300, height: 16 } }];
    });
    const model = buildCanonicalModel(Buffer.from('%PDF-phrase-cjk'), raw, config, 'deps');
    const index = JSON.parse(JSON.stringify(buildBm25(model)));
    for (const [query, page] of [['先進製程', 1], ['半導体輸出', 2], ['資訊安全', 1]]) {
        const results = searchBm25(index, query, { phrase: true, granularity: 'page' });
        assert.deepEqual(results.map(result => result.page), [page]);
        assert.ok(results[0].snippet.includes(query));
        assert.equal(results[0].citation.pageId, `page:${page}`);
    }
    assert.deepEqual(searchBm25(index, '安全資訊', { phrase: true }), []);
});
