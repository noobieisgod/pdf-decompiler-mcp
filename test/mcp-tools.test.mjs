import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { createServer } from '../src/server/create-server.mjs';
import { buildSyntheticPdf } from './fixtures/generate-fixtures.mjs';
import { temporaryConfig } from './helpers.mjs';

const TOOL_NAMES = ['pdf_open', 'pdf_document_info', 'pdf_search', 'pdf_search_documents', 'pdf_get_pages', 'pdf_get_element', 'pdf_render_page', 'pdf_close'];

async function connected(t) {
    const { root, config } = await temporaryConfig(null, { cacheMode: 'persistent' });
    let manager;
    let server;
    let client;
    t.after(async () => {
        try {
            await client?.close();
            await server?.close();
            await manager?.close();
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
    const source = path.join(root, 'workflow.pdf');
    await fs.writeFile(source, buildSyntheticPdf({ pages: ['Composable MCP workflow evidence'], link: true }));
    manager = new DocumentManager(config);
    await manager.init();
    server = createServer(manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'pdf-decompiler-tests', version: '1.0.0' });
    await client.connect(clientTransport);
    return { client, source };
}

test('all tools expose input and output schemas and complete the workflow', async t => {
    const { client, source } = await connected(t);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name), TOOL_NAMES);
    assert.ok(tools.every(tool => tool.inputSchema?.type === 'object' && tool.outputSchema?.type === 'object'));
    assert.ok(!tools.some(tool => tool.name === 'extract_pdf_content'));

    const open = await client.callTool({ name: 'pdf_open', arguments: { source } });
    assert.equal(open.isError, undefined);
    assert.equal(open.structuredContent.operation, 'pdf_open');
    const reference = { documentId: open.structuredContent.documentId, extractionFingerprint: open.structuredContent.extractionFingerprint };
    const info = await client.callTool({ name: 'pdf_document_info', arguments: reference });
    assert.equal(info.structuredContent.data.cache.mode, 'persistent');
    const search = await client.callTool({ name: 'pdf_search', arguments: { ...reference, query: 'workflow', strategy: 'full_text' } });
    assert.ok(search.structuredContent.data.results.length);
    const pages = await client.callTool({ name: 'pdf_get_pages', arguments: { ...reference, pages: [1], mode: 'fidelity' } });
    const element = pages.structuredContent.data.elements[0];
    assert.equal(element.citation.extractionFingerprint, reference.extractionFingerprint);
    const one = await client.callTool({ name: 'pdf_get_element', arguments: { ...reference, elementId: element.id } });
    assert.equal(one.structuredContent.data.element.id, element.id);

    const linked = await client.callTool({ name: 'pdf_render_page', arguments: { ...reference, page: 1, maxDimension: 256, imageDelivery: 'auto' } });
    const resource = linked.content.find(item => item.type === 'resource_link');
    assert.ok(resource.uri.includes(reference.extractionFingerprint));
    assert.ok(linked.content[0].text.includes(resource.uri));
    assert.ok((await client.readResource({ uri: resource.uri })).contents[0].blob);
    const inline = await client.callTool({ name: 'pdf_render_page', arguments: { ...reference, page: 1, maxDimension: 128, imageDelivery: 'inline' } });
    assert.ok(inline.content.some(item => item.type === 'image'));
    const closed = await client.callTool({ name: 'pdf_close', arguments: reference });
    assert.equal(closed.structuredContent.data.closed, true);
    assert.ok((await client.readResource({ uri: resource.uri })).contents[0].blob);
    const afterClose = await client.callTool({ name: 'pdf_search', arguments: { ...reference, query: 'workflow' } });
    assert.equal(afterClose.isError, true);
    assert.equal(afterClose.structuredContent.data.error.code, 'closed_document');
});

test('multi-document search keeps exact citations and resumable budgets across PDFs', async t => {
    const { client, source } = await connected(t);
    const primaryPath = path.join(path.dirname(source), 'primary.pdf');
    await fs.writeFile(primaryPath, buildSyntheticPdf({ pages: ['Comprehensive workflow workflow workflow evidence', 'Unprocessed appendix'] }));
    const call = (name, args) => client.callTool({ name, arguments: args });
    const primary = (await call('pdf_open', { source: primaryPath, pages: [{ start: 1, end: 1 }] })).structuredContent.data;
    const secondary = (await call('pdf_open', { source })).structuredContent.data;
    const reference = ({ documentId, extractionFingerprint }) => ({ documentId, extractionFingerprint });
    const documents = [reference(secondary), reference(primary)];
    const args = { documents, query: 'workflow', strategy: 'phrase', budget: { pages: 1 } };
    const first = (await call('pdf_search_documents', args)).structuredContent;
    assert.equal(first.data.results.length, 1);
    assert.equal(first.data.results[0].citation.documentId, primary.documentId);
    assert.equal(first.data.documents.find(document => document.documentId === primary.documentId).unprocessedPages, 1);
    assert.equal(first.completion.requestedScopeComplete, false);
    assert.ok(first.nextCursor);
    const next = (await call('pdf_search_documents', { ...args, documents: [...documents].reverse(), cursor: first.nextCursor })).structuredContent;
    assert.equal(next.data.results.length, 1);
    assert.equal(next.data.results[0].page, first.data.results[0].page);
    assert.deepEqual(reference(next.data.results[0].citation), reference(secondary));
    assert.equal(next.nextCursor, null);

    const repeated = await call('pdf_search_documents', { ...args, documents: [documents[0], documents[0]] });
    assert.equal(repeated.structuredContent.data.error.code, 'invalid_input');
    const expanded = await call('pdf_open', { ...reference(primary), sourceId: primary.sourceId, pages: [{ start: 2, end: 2 }] });
    assert.equal(expanded.structuredContent.completion.documentComplete, true);
    const stale = await call('pdf_search_documents', { ...args, cursor: first.nextCursor });
    assert.equal(stale.structuredContent.data.error.code, 'changed_cursor_arguments');
    await call('pdf_close', { ...reference(secondary), sourceId: secondary.sourceId });
    const closed = await call('pdf_search_documents', args);
    assert.equal(closed.structuredContent.data.error.code, 'closed_document');
});

test('tool errors are structured and sanitized', async t => {
    const { client } = await connected(t);
    const result = await client.callTool({ name: 'pdf_open', arguments: { source: 'missing.pdf' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.data.error.code, 'source_not_found');
    assert.ok(!JSON.stringify(result).includes('node:internal'));
});
