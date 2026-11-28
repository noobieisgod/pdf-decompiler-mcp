import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pkg from '../../package.json' with { type: 'json' };
import { CacheManager } from '../cache/cache-manager.mjs';
import { fingerprint, sha256 } from '../core/crypto.mjs';
import { PdfDecompilerError } from '../core/errors.mjs';
import { missingTesseractLanguages } from '../extract/ocr.mjs';
import { buildCanonicalModel, extractionFingerprint, indexModel, mergeCanonicalModels, modelView } from '../model/canonical.mjs';
import { BM25_INDEX_VERSION, BM25_SEARCH_REVISION, buildBm25, searchBm25, searchBm25AcrossDocuments } from '../search/bm25.mjs';
import { MARKDOWN_FORMAT_VERSION, MARKDOWN_SERIALIZER_REVISION, serializeElementMarkdown, serializePagedMarkdown } from '../markdown/serializer.mjs';
import { getFullMarkdownExport, markdownResourceUri } from '../markdown/export.mjs';
import { buildSemanticIndex, createEmbedder, reciprocalRankFusion, searchSemantic } from '../search/semantic.mjs';
import { loadPdfSource } from '../security/source.mjs';
import { applyFairPageBudget, applyResultBudget, HARD_BUDGET, normalizePageOrder, resolveBudget } from './budget.mjs';
import { CursorCodec } from './cursor.mjs';
import { selectTable } from './table-selection.mjs';
import { runExtractionSubprocess, runRenderSubprocess } from './subprocess.mjs';
import { timingMark } from './timing.mjs';

const dependencyFingerprint = fingerprint({
    node: process.versions.node.split('.')[0],
    dependencies: pkg.dependencies,
    optionalDependencies: pkg.optionalDependencies,
});

function stateKey(documentId, generation) {
    return `${documentId}:${generation}`;
}

function completeDocument(model) {
    return model.processedPages === model.totalPages && !model.partial;
}

function textCoverage(model, pages) {
    const scope = pages ? new Set(pages) : null;
    const requested = scope ? model.pages.filter(page => scope.has(page.number)) : model.pages;
    return {
        unprocessedPages: (scope?.size ?? model.totalPages) - requested.length,
        uncertainPages: requested.filter(page => page.extractionMode === 'error' || page.ocr.rejectedRegions > 0
            || (!page.visualSignals.hasText && !page.ocr.accepted && page.visualType !== 'none')).length,
    };
}

function searchSelectionBudget(args, budget) {
    return {
        ...budget,
        responseBytes: Math.floor(Math.min(budget.responseBytes, args._wireResponseBytes ?? budget.responseBytes) * 0.65),
        estimatedTokens: Math.floor(Math.min(budget.estimatedTokens, args._wireEstimatedTokens ?? budget.estimatedTokens) * 0.65),
    };
}

function requestedPagesComplete(model, pages) {
    const processed = new Set(model.pages.map(page => page.number));
    return pages.every(page => processed.has(page));
}

function dedupe(values) {
    return [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
}

function pageIntervals(pages) {
    const sorted = [...new Set(pages)].sort((a, b) => a - b);
    const ranges = [];
    for (const page of sorted) {
        const last = ranges.at(-1);
        if (last && page === last[1] + 1) last[1] = page;
        else ranges.push([page, page]);
    }
    return ranges.map(([start, end]) => ({ start, end }));
}

function pageRanges(pages) {
    return pageIntervals(pages).map(({ start, end }) => start === end ? String(start) : `${start}-${end}`).join(',');
}

function summarizePageWarnings(pages) {
    const groups = new Map();
    for (const page of pages) for (const warning of page.warnings || []) {
        const { page: _page, ...base } = warning;
        const key = JSON.stringify(base);
        if (!groups.has(key)) groups.set(key, { base, pages: [] });
        groups.get(key).pages.push(page.number);
    }
    return [...groups.values()].map(group => group.pages.length === 1
        ? { ...group.base, page: group.pages[0] }
        : { ...group.base, message: `${group.base.message ? `${group.base.message} ` : ''}Affected pages: ${pageRanges(group.pages)}.` });
}

function compactTable(table) {
    const rows = table.rows.slice(0, 6).map(row => row.slice(0, 8));
    return {
        ...table,
        rows,
        cells: table.cells.filter(cell => cell.row <= 6 && cell.column <= 8),
        text: rows.map(row => row.join(' | ')).join('\n'),
        preview: { rowStart: 1, rowEnd: rows.length, columnStart: 1, columnEnd: Math.max(0, ...rows.map(row => row.length)), partial: table.totalRows > rows.length || table.totalColumns > 8 },
    };
}

function buildBm25Safely(model, debug = false) {
    try {
        return buildBm25(model);
    } catch (error) {
        const diagnosticId = randomUUID();
        if (debug) console.error(`[pdf-index:${diagnosticId}]`, error?.stack || error);
        throw new PdfDecompilerError('INDEX_BUILD_FAILED', 'The extracted document could not be indexed.', { stage: 'bm25', retryable: true, diagnosticId });
    }
}

function missingPageIntervals(totalPages, processedPages) {
    const present = new Set(processedPages);
    const intervals = [];
    let start = null;
    for (let page = 1; page <= totalPages + 1; page += 1) {
        if (page <= totalPages && !present.has(page)) {
            start ??= page;
        } else if (start !== null) {
            intervals.push({ start, end: page - 1 });
            start = null;
        }
    }
    return intervals;
}

function openScopePages(intervals, totalPages) {
    if (!intervals?.length) return Array.from({ length: totalPages }, (_, index) => index + 1);
    const pages = new Set();
    for (const interval of intervals) {
        const start = interval.start ?? 1;
        const end = interval.end ?? totalPages;
        for (let page = start; page <= Math.min(end, totalPages); page += 1) pages.add(page);
    }
    return [...pages];
}

export class DocumentManager {
    constructor(config, options = {}) {
        this.config = config;
        this.cache = options.cache || new CacheManager(config);
        this.embedderFactory = options.embedderFactory || createEmbedder;
        this.injectedEmbedder = options.embedder || null;
        this.states = new Map();
        this.currentGeneration = new Map();
        this.closedStates = new Set();
        this.closedHandles = new Map();
        this.openLocks = new Map();
        this.closing = false;
    }

    async init() {
        await this.cache.init();
        const keyring = this.cache.cursorKeyring();
        this.cursors = new CursorCodec({ ...keyring, ttlMs: this.config.cursorTtlMs });
        return this;
    }

    generationForCurrentConfig(config = this.config) {
        return extractionFingerprint(config, dependencyFingerprint);
    }

    async bm25ForSearch(state) {
        if (state.bm25Promise) return state.bm25Promise;
        const { model, persisted } = state;
        const { documentId, extractionFingerprint } = model;
        const pending = (async () => {
            const cached = persisted && await this.cache.loadBm25Index(documentId, extractionFingerprint);
            if (cached) return cached;
            const bm25 = buildBm25Safely(model, this.config.debug);
            if (persisted) await this.cache.saveBm25Index(documentId, extractionFingerprint, bm25);
            return bm25;
        })();
        state.bm25Promise = pending;
        try {
            return await pending;
        } catch (error) {
            if (state.bm25Promise === pending) state.bm25Promise = null;
            throw error;
        }
    }

    async activate(model, pdfBytes, { persisted = false, semantic = null, extractionConfig = this.config } = {}) {
        const key = stateKey(model.documentId, model.extractionFingerprint);
        const existing = this.states.get(key);
        if (existing) return existing;
        const diskBacked = !model.partial && this.config.cache.mode !== 'none';
        if (diskBacked && !persisted) await this.cache.saveGeneration(model, pdfBytes);
        const leaseId = diskBacked ? await this.cache.acquireLease(model.documentId, model.extractionFingerprint) : null;
        const state = {
            model,
            pdfBytes,
            bm25Promise: null,
            semantic,
            embedder: null,
            indexes: indexModel(model),
            derivedAssets: new Map(),
            leaseId,
            handles: new Map(),
            operationCount: 0,
            operationWaiters: [],
            closing: false,
            persisted: diskBacked,
            extractionConfig,
        };
        this.states.set(key, state);
        this.closedStates.delete(key);
        this.currentGeneration.set(model.documentId, model.extractionFingerprint);
        return state;
    }

    sourceDescriptor(loaded, sourceLabel) {
        const supplied = typeof sourceLabel === 'string' ? sourceLabel.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128) : '';
        const sourceKind = loaded.sourceUrl ? 'https' : 'local';
        const basename = loaded.sourcePath ? path.basename(loaded.sourcePath) : null;
        const host = loaded.sourceUrl ? new URL(loaded.sourceUrl).host : null;
        return {
            sourceId: randomUUID(),
            sourceKind,
            sourceLabel: supplied || basename || host || 'PDF source',
            basename,
            host,
            callerProvidedLabel: Boolean(supplied),
        };
    }

    addSourceHandle(state, descriptor) {
        state.handles.set(descriptor.sourceId, descriptor);
        this.closedHandles.delete(descriptor.sourceId);
        this.closedStates.delete(stateKey(state.model.documentId, state.model.extractionFingerprint));
        return descriptor;
    }

    async withOpenLock(key, operation) {
        if (this.closing) throw new PdfDecompilerError('closed_document', 'The document manager is closing.');
        const previous = this.openLocks.get(key);
        let release;
        const current = new Promise(resolve => { release = resolve; });
        this.openLocks.set(key, current);
        try {
            await previous;
            return await operation();
        } finally {
            release();
            if (this.openLocks.get(key) === current) this.openLocks.delete(key);
        }
    }

    async open(args) {
        if (args.cursor) return this.continueOpen(args);
        if (args.source === undefined && args.sourceId) return this.openFromHandle(args);
        const extractionConfig = { ...this.config, ocrPolicy: args.ocrPolicy || this.config.ocrPolicy };
        if (extractionConfig.ocrPolicy !== 'off' && extractionConfig.ocrLanguages && extractionConfig.ocrLanguages !== 'eng') {
            const missing = missingTesseractLanguages(extractionConfig.ocrLanguages);
            if (missing.length) {
                throw new PdfDecompilerError('ocr_language_unavailable', `Install the requested Tesseract language data: ${missing.join(', ')}.`);
            }
        }
        const loaded = await loadPdfSource(args.source, this.config);
        const descriptor = this.sourceDescriptor(loaded, args.sourceLabel);
        const documentId = `doc_${sha256(loaded.bytes)}`;
        const generation = this.generationForCurrentConfig(extractionConfig);
        const key = stateKey(documentId, generation);
        return this.withOpenLock(key, () => this.openLoaded(args, loaded, descriptor, extractionConfig, documentId, generation));
    }

    async openLoaded(args, loaded, descriptor, extractionConfig, documentId, generation) {
        const key = stateKey(documentId, generation);
        const active = this.states.get(key);
        if (active) {
            if (active.closing) throw new PdfDecompilerError('closed_document', 'The document generation is closing.');
            if (args.refresh) throw new PdfDecompilerError('active_generation', 'Close the active extraction generation before refreshing it.');
            const scope = await this.openActiveScope(active, args);
            this.addSourceHandle(active, descriptor);
            return this.openResult(active, descriptor, scope);
        }
        if (!args.refresh && this.config.cache.mode === 'persistent') {
            const cached = await this.cache.loadGeneration(documentId, generation, { loadBm25: false });
            if (cached) {
                const state = await this.activate(cached.model, cached.pdfBytes, { persisted: true, semantic: cached.semantic, extractionConfig });
                this.addSourceHandle(state, descriptor);
                return this.openResult(state, descriptor, { cacheHit: true, requestedPages: openScopePages(args.pages, state.model.totalPages) });
            }
        }
        if (args.refresh && this.config.cache.mode === 'persistent' && await this.cache.generationExists(documentId, generation)) {
            await this.cache.deleteGeneration(documentId, generation, { reason: 'deleted' });
        }
        const extracted = await runExtractionSubprocess(loaded.bytes, extractionConfig, { pages: args.pages, maxImageDim: args.maxImageDimension });
        const extractedPages = extracted.result.pages.map(page => page.page);
        const missing = missingPageIntervals(extracted.result.totalPages, extractedPages);
        if (!extracted.result.partial && missing.length) {
            extracted.result.partial = {
                timedOut: false,
                selectionIncomplete: true,
                nextPage: missing[0].start,
                processedPages: extractedPages.length,
                remainingPages: extracted.result.totalPages - extractedPages.length,
            };
        }
        const model = buildCanonicalModel(loaded.bytes, extracted.result, extractionConfig, dependencyFingerprint);
        const state = await this.activate(model, loaded.bytes, { extractionConfig });
        this.addSourceHandle(state, descriptor);
        state.diagnostics = extracted.diagnostics;
        return this.openResult(state, descriptor, { cacheHit: false, requestedPages: openScopePages(args.pages, state.model.totalPages) });
    }

    async openFromHandle(args) {
        if (!args.documentId || !args.extractionFingerprint || !args.pages) {
            throw new PdfDecompilerError('invalid_open_context', 'Opening selected pages by handle requires documentId, extractionFingerprint, sourceId, and pages.');
        }
        const key = stateKey(args.documentId, args.extractionFingerprint);
        return this.withOpenLock(key, async () => {
            const state = this.states.get(key);
            const descriptor = state?.handles.get(args.sourceId);
            if (!descriptor || state.closing) throw new PdfDecompilerError('SOURCE_HANDLE_UNKNOWN', 'The source handle is unavailable.');
            if (args.refresh) throw new PdfDecompilerError('active_generation', 'Close the active extraction generation before refreshing it.');
            if (args.sourceLabel !== undefined || (args.ocrPolicy && args.ocrPolicy !== state.extractionConfig.ocrPolicy)) {
                throw new PdfDecompilerError('invalid_open_context', 'A source handle uses its existing source label and OCR policy.');
            }
            const scope = await this.openActiveScope(state, args);
            return this.openResult(state, descriptor, scope);
        });
    }

    async openActiveScope(state, { pages, maxImageDimension }) {
        const requestedPages = openScopePages(pages, state.model.totalPages);
        if (!pages) return { cacheHit: true, requestedPages };
        const processed = new Set(state.model.pages.map(page => page.number));
        const missing = requestedPages.filter(page => !processed.has(page));
        if (missing.length) await this.extendOpen(state, pageIntervals(missing), maxImageDimension);
        return { cacheHit: missing.length === 0, requestedPages };
    }

    openResult(state, descriptor, { cacheHit, requestedPages = [] }) {
        const nextCursor = state.model.partial?.nextPage
            ? this.cursors.encode({
                documentId: state.model.documentId,
                extractionFingerprint: state.model.extractionFingerprint,
                operation: 'pdf_open',
                argumentsValue: { documentId: state.model.documentId, extractionFingerprint: state.model.extractionFingerprint, sourceId: descriptor.sourceId },
                position: state.model.partial.nextPage,
            }) : null;
        return {
            documentId: state.model.documentId,
            extractionFingerprint: state.model.extractionFingerprint,
            totalPages: state.model.totalPages,
            processedPages: state.model.processedPages,
            nextCursor,
            cacheHit,
            sourceId: descriptor.sourceId,
            sourceDescriptor: descriptor,
            cache: this.cache.status(state.model),
            diagnostics: state.diagnostics || null,
            warnings: summarizePageWarnings(state.model.pages),
            completion: {
                documentComplete: completeDocument(state.model),
                requestedScopeComplete: requestedPagesComplete(state.model, requestedPages),
                resultComplete: true,
            },
        };
    }

    async continueOpen(args) {
        if (!args.documentId || !args.extractionFingerprint || !args.sourceId) throw new PdfDecompilerError('invalid_cursor_context', 'Continuation requires documentId, extractionFingerprint, and sourceId.');
        return this.withOpenLock(stateKey(args.documentId, args.extractionFingerprint), () => this.continueOpenLocked(args));
    }

    async continueOpenLocked(args) {
        const state = await this.requireState(args.documentId, args.extractionFingerprint);
        const descriptor = state.handles.get(args.sourceId);
        if (!descriptor) throw new PdfDecompilerError('SOURCE_HANDLE_UNKNOWN', 'The source handle is unavailable.');
        const nextPage = this.cursors.decode(args.cursor, {
            documentId: args.documentId,
            extractionFingerprint: args.extractionFingerprint,
            operation: 'pdf_open',
            argumentsValue: { documentId: args.documentId, extractionFingerprint: args.extractionFingerprint, sourceId: args.sourceId },
        });
        if (nextPage !== state.model.partial?.nextPage) throw new PdfDecompilerError('stale_cursor', 'The decomposition cursor no longer matches document state.');
        const pages = missingPageIntervals(state.model.totalPages, state.model.pages.map(page => page.number));
        await this.extendOpen(state, pages, args.maxImageDimension);
        return this.openResult(state, descriptor, { cacheHit: false, requestedPages: openScopePages(pages, state.model.totalPages) });
    }

    async extendOpen(state, pages, maxImageDim) {
        const extracted = await runExtractionSubprocess(state.pdfBytes, state.extractionConfig, { pages, maxImageDim });
        const incoming = buildCanonicalModel(state.pdfBytes, extracted.result, state.extractionConfig, dependencyFingerprint);
        const model = mergeCanonicalModels(state.model, incoming);
        const missing = missingPageIntervals(model.totalPages, model.pages.map(page => page.number));
        model.partial = missing.length
            ? {
                ...model.partial,
                timedOut: Boolean(model.partial?.timedOut),
                selectionIncomplete: true,
                nextPage: missing[0].start,
                processedPages: model.pages.length,
                remainingPages: model.totalPages - model.pages.length,
            }
            : null;
        const indexes = indexModel(model);
        if (!model.partial && !state.persisted && this.config.cache.mode !== 'none') {
            await this.cache.saveGeneration(model, state.pdfBytes);
            state.leaseId = await this.cache.acquireLease(model.documentId, model.extractionFingerprint);
            state.persisted = true;
        }
        Object.assign(state, { model, bm25Promise: null, indexes, semantic: null, diagnostics: extracted.diagnostics });
    }

    async requireState(documentId, generation = null) {
        const selectedGeneration = generation || this.currentGeneration.get(documentId);
        if (!selectedGeneration) throw new PdfDecompilerError('closed_document', 'The document is not open.');
        if (this.closedStates.has(stateKey(documentId, selectedGeneration))) throw new PdfDecompilerError('closed_document', 'The document is closed. Open it again before using document tools.');
        const state = this.states.get(stateKey(documentId, selectedGeneration));
        if (state) {
            if (state.closing) throw new PdfDecompilerError('closed_document', 'The document generation is closing.');
            return state;
        }
        if (this.config.cache.mode !== 'persistent') throw new PdfDecompilerError('expired_process_state', 'The process-local document state has expired.');
        const cached = await this.cache.loadGeneration(documentId, selectedGeneration, { loadBm25: false });
        if (!cached) throw new PdfDecompilerError('cache_generation_missing', 'The extraction generation is unavailable.');
        return this.activate(cached.model, cached.pdfBytes, { persisted: true, semantic: cached.semantic });
    }

    async withOperation(documentId, generation, callback) {
        const state = await this.requireState(documentId, generation);
        return this.withOperations([state], () => callback(state));
    }

    async withOperations(states, callback) {
        for (const state of states) state.operationCount += 1;
        try {
            return await callback();
        } finally {
            for (const state of states) {
                state.operationCount -= 1;
                if (state.operationCount === 0) state.operationWaiters.splice(0).forEach(resolve => resolve());
            }
        }
    }

    async waitForOperations(state) {
        if (state.operationCount === 0) return;
        await new Promise(resolve => state.operationWaiters.push(resolve));
    }

    async documentInfo(args) {
        return this.withOperation(args.documentId, args.extractionFingerprint, async state => {
        const counts = Object.fromEntries(['block', 'table', 'figure', 'annotation', 'link'].map(type => [type, state.model.elements.filter(item => item.type === type).length]));
        const { elements: _elements, assets: _assets, warnings, ...document } = modelView(state.model);
        const markdownUri = markdownResourceUri(state.model);
        const serializerFingerprint = markdownUri.split('/').at(-2);
        const cachedMarkdown = completeDocument(state.model) ? await this.cache.loadDerivedMarkdown(state.model.documentId, state.model.extractionFingerprint, serializerFingerprint) : null;
        const tableRows = state.model.elements.filter(element => element.type === 'table').reduce((sum, table) => sum + table.totalRows, 0);
        const tableCells = state.model.elements.filter(element => element.type === 'table').reduce((sum, table) => sum + table.cells.length, 0);
        const exportWithinLimits = state.model.elements.length <= this.config.markdown.maxElements
            && tableRows <= this.config.markdown.maxTableRows && tableCells <= this.config.markdown.maxTableCells;
        return {
            ...document,
            counts,
            activeSources: [...state.handles.values()],
            cache: { ...this.cache.status(state.model), activeLeases: await this.cache.activeLeases(state.model.documentId, state.model.extractionFingerprint) },
            resourceLifetime: this.config.cache.mode === 'persistent' ? 'until_generation_deleted_or_evicted' : this.config.cache.mode === 'ephemeral' ? 'owning_process_and_document_lifetime' : 'active_document_lifetime',
            exports: {
                markdown: {
                    status: cachedMarkdown ? 'ready' : !completeDocument(state.model) ? 'partial_generation' : exportWithinLimits ? 'generatable' : 'unavailable_limit',
                    resourceUri: completeDocument(state.model) && exportWithinLimits ? markdownUri : null,
                },
            },
            warnings: summarizePageWarnings(state.model.pages),
            completion: { documentComplete: completeDocument(state.model), requestedScopeComplete: true, resultComplete: true },
        };
        });
    }

    async search(args) {
        return this.withOperation(args.documentId, args.extractionFingerprint, async state => {
        const model = state.model;
        const strategy = args.strategy || 'full_text';
        const granularity = args.granularity || 'element';
        if (granularity === 'page' && strategy !== 'full_text' && strategy !== 'phrase') {
            throw new PdfDecompilerError('invalid_input', 'Page granularity supports full-text and phrase search.');
        }
        const options = { pages: args.pages, elementTypes: args.elementTypes, phrase: strategy === 'phrase', granularity };
        const warnings = [];
        const bm25Results = searchBm25(await this.bm25ForSearch(state), args.query, options);
        let results = bm25Results;
        if (strategy === 'semantic' || strategy === 'hybrid') {
            if (!this.config.semantic.enabled) {
                warnings.push({ code: 'semantic_disabled', message: 'Semantic retrieval is disabled; BM25 results were returned.' });
            } else {
                try {
                    state.embedder ||= await this.embedderFactory(this.config, path.join(this.cache.root, 'models'), this.injectedEmbedder);
                    const semantic = (state.model === model ? state.semantic : null) || await buildSemanticIndex(model, state.embedder);
                    if (state.model === model && state.semantic !== semantic) {
                        state.semantic = semantic;
                        if (state.persisted) await this.cache.saveSemanticIndex(model.documentId, model.extractionFingerprint, semantic);
                    }
                    const semanticResults = await searchSemantic(semantic, args.query, state.embedder, options);
                    results = strategy === 'semantic' ? semanticResults : reciprocalRankFusion([bm25Results, semanticResults], 60);
                } catch {
                    warnings.push({ code: 'semantic_unavailable', message: 'Semantic retrieval failed; BM25 results were returned.' });
                    results = bm25Results;
                }
            }
        }
        const cursorArguments = { queryDigest: fingerprint(String(args.query).normalize('NFKC')), bm25Version: BM25_INDEX_VERSION, searchRevision: BM25_SEARCH_REVISION, strategy, ...(granularity === 'page' ? { granularity } : {}), pages: args.pages || null, elementTypes: args.elementTypes || null, budget: args.budget || null, ...(model.partial ? { processedPages: model.processedPages } : {}) };
        const start = args.cursor ? this.cursors.decode(args.cursor, {
            documentId: state.model.documentId,
            extractionFingerprint: state.model.extractionFingerprint,
            operation: 'pdf_search',
            argumentsValue: cursorArguments,
        }) : 0;
        const requestedBudget = resolveBudget(args.budget);
        const bounded = applyResultBudget(results, searchSelectionBudget(args, requestedBudget), start);
        const nextCursor = bounded.nextOffset === null ? null : this.cursors.encode({ documentId: state.model.documentId, extractionFingerprint: state.model.extractionFingerprint, operation: 'pdf_search', argumentsValue: cursorArguments, position: bounded.nextOffset });
        const { unprocessedPages, uncertainPages } = textCoverage(model, args.pages);
        if (!results.length && (unprocessedPages || uncertainPages)) {
            warnings.push({ code: 'search_text_coverage_incomplete', message: 'Some requested pages were unprocessed or may contain unread text. Inspect page status before treating zero results as absence.' });
        }
        return {
            query: args.query,
            strategy,
            ...(granularity === 'page' ? { granularity } : {}),
            results: bounded.items,
            textCoverage: { unprocessedPages, uncertainPages },
            citations: dedupe(bounded.items.flatMap(result => result.citations || [result.citation])),
            warnings,
            omissions: bounded.omissions,
            budget: { configured: requestedBudget, usage: bounded.usage, estimators: { text: 'utf8_bytes_divided_by_4' } },
            nextCursor,
            completion: { documentComplete: completeDocument(model), requestedScopeComplete: unprocessedPages === 0, resultComplete: nextCursor === null },
        };
        });
    }

    async searchDocuments(args) {
        if (this.closing) throw new PdfDecompilerError('closed_document', 'The document manager is closing.');
        const keys = [...new Set(args.documents.map(({ documentId, extractionFingerprint }) => stateKey(documentId, extractionFingerprint)))].sort();
        if (keys.length < 2) throw new PdfDecompilerError('invalid_input', 'Select at least two distinct open PDF generations.');
        const states = keys.map(key => {
            const state = this.states.get(key);
            if (!state?.handles.size || state.closing) {
                throw new PdfDecompilerError('closed_document', 'Every document in the search must have an active source handle.');
            }
            return state;
        });
        return this.withOperations(states, async () => {
            const models = states.map(state => state.model);
            const strategy = args.strategy || 'full_text';
            const budget = resolveBudget(args.budget);
            const cursor = {
                documentId: null,
                extractionFingerprint: null,
                operation: 'pdf_search_documents',
                argumentsValue: {
                    queryDigest: fingerprint(args.query.normalize('NFKC')), bm25Version: BM25_INDEX_VERSION, searchRevision: BM25_SEARCH_REVISION, strategy, budget,
                    scope: models.map((model, index) => [keys[index], model.partial ? model.pages.map(page => page.number) : null]),
                    elementTypes: args.elementTypes || null,
                },
            };
            const start = args.cursor ? this.cursors.decode(args.cursor, cursor) : 0;
            // Hold each document lease through its index load. Load sequentially to bound I/O.
            const indexes = [];
            for (const state of states) {
                indexes.push(await this.bm25ForSearch(state));
            }
            if (states.some((state, index) => state.model !== models[index])) {
                throw new PdfDecompilerError('changed_search_scope', 'A document changed during search. Start the search again.');
            }
            const results = searchBm25AcrossDocuments(indexes, args.query, { phrase: strategy === 'phrase', elementTypes: args.elementTypes });
            const identity = ({ citation }) => stateKey(citation.documentId, citation.extractionFingerprint);
            const bounded = applyResultBudget(results, searchSelectionBudget(args, budget), start, {
                pageKey: item => `${identity(item)}:${item.page}`,
                omissionId: item => `${identity(item)}:${item.id}`,
            });
            if (bounded.nextOffset === start) {
                throw new PdfDecompilerError('response_budget_exceeded', 'The next search result exceeds the budget. Use a larger budget and restart the search.');
            }
            const documents = models.map(({ documentId, extractionFingerprint, ...model }) => ({
                documentId, extractionFingerprint, ...textCoverage(model),
            }));
            const nextCursor = bounded.nextOffset === null ? null : this.cursors.encode({ ...cursor, position: bounded.nextOffset });
            const documentComplete = models.every(completeDocument);
            return {
                query: args.query, strategy, documents, results: bounded.items,
                citations: dedupe(bounded.items.flatMap(result => result.citations || [result.citation])),
                warnings: documents.some(document => document.unprocessedPages || document.uncertainPages)
                    ? [{ code: 'search_text_coverage_incomplete', message: 'Some pages were unprocessed or may contain unread text. Check each document’s coverage.' }] : [],
                omissions: bounded.omissions,
                budget: { configured: budget, usage: bounded.usage, estimators: { text: 'utf8_bytes_divided_by_4' } },
                nextCursor,
                completion: { documentComplete, requestedScopeComplete: documentComplete, resultComplete: nextCursor === null },
            };
        });
    }

    async getPages(args) {
        return this.withOperation(args.documentId, args.extractionFingerprint, async state => {
        const restored = args.cursor ? this.cursors.decode(args.cursor, {
            documentId: state.model.documentId,
            extractionFingerprint: state.model.extractionFingerprint,
            operation: 'pdf_get_pages',
            restoreArguments: true,
        }) : null;
        const restoredArguments = restored?.argumentsValue;
        const pageInput = args.pages || (!args.pageRanges ? restoredArguments?.pages : null);
        if ((pageInput || []).some(page => page > state.model.totalPages)) throw new PdfDecompilerError('page_unavailable', 'A requested page exceeds the document page count.');
        const requestedPages = normalizePageOrder(pageInput, args.pageRanges, state.model.totalPages, state.model.pages.map(page => page.number));
        if (requestedPages.length > HARD_BUDGET.pages) throw new PdfDecompilerError('budget_exhausted', 'The requested page scope exceeds the hard page limit.');
        const requested = new Set(requestedPages);
        const mode = args.mode || restoredArguments?.mode || 'balanced';
        const outputFormat = args.outputFormat || restoredArguments?.outputFormat || 'structured';
        const tableDetail = args.tableDetail || restoredArguments?.tableDetail || (outputFormat === 'markdown' ? 'compact' : 'full');
        const compactCitations = (args.citationDetail || restoredArguments?.citationDetail) === 'compact';
        if (compactCitations && outputFormat !== 'markdown') throw new PdfDecompilerError('invalid_input', 'Compact citations require Markdown output.');
        const includeElementTypes = args.includeElementTypes || restoredArguments?.includeElementTypes;
        const excludeElementTypes = args.excludeElementTypes || restoredArguments?.excludeElementTypes;
        const requestedBudget = args.budget || restoredArguments?.requestedBudget;
        const resolvedBudget = resolveBudget(requestedBudget);
        const cursorArguments = {
            pages: requestedPages,
            mode,
            outputFormat,
            tableDetail,
            ...(compactCitations ? { citationDetail: 'compact' } : {}),
            includeElementTypes: includeElementTypes || null,
            excludeElementTypes: excludeElementTypes || null,
            requestedBudget: resolvedBudget,
            hardBudgetFingerprint: fingerprint(HARD_BUDGET),
            canonicalFormatVersion: state.model.canonicalFormatVersion,
            extractionRevision: state.model.extractionRevision,
            ...(state.model.partial ? { processedPages: state.model.processedPages } : {}),
            markdownFormatVersion: outputFormat === 'markdown' ? MARKDOWN_FORMAT_VERSION : null,
            markdownSerializerRevision: outputFormat === 'markdown' ? MARKDOWN_SERIALIZER_REVISION : null,
        };
        if (restoredArguments && fingerprint(restoredArguments) !== fingerprint(cursorArguments)) throw new PdfDecompilerError('changed_cursor_arguments', 'The cursor arguments have changed.');
        const position = restored?.position || { offsets: requestedPages.map(() => 0), pageIndex: 0 };
        const include = new Set(includeElementTypes);
        const exclude = new Set(excludeElementTypes);
        const pageItems = requestedPages.map(page => {
            const ids = state.indexes.pages.get(page)?.elementIds ?? [];
            const items = ids.map(id => state.indexes.elements.get(id)).filter(element => element
                && !exclude.has(element.type) && (element.type !== 'figure' || include.has('figure')
                    || mode === 'fidelity' || (mode === 'balanced' && element.caption)));
            return { page, items };
        });
        const wireResponseBytes = Math.min(resolvedBudget.responseBytes, args._wireResponseBytes ?? resolvedBudget.responseBytes);
        const preCapBudget = {
            ...resolvedBudget,
            responseBytes: Math.floor(wireResponseBytes * 0.65),
            estimatedTokens: Math.min(resolvedBudget.estimatedTokens, Math.floor((args._wireEstimatedTokens ?? resolvedBudget.estimatedTokens) * 0.65)),
        };
        const bounded = applyFairPageBudget(pageItems, preCapBudget, position, element => {
            const value = element.type === 'table' && tableDetail === 'compact' ? compactTable(element) : element;
            const fragment = outputFormat === 'markdown' ? serializeElementMarkdown(value, { tableDetail }) : null;
            const encoded = outputFormat === 'markdown' ? fragment : JSON.stringify(value);
            const { pageId, elementId, bbox } = value.citation;
            const citation = compactCitations ? { pageId, elementId, bbox } : value.citation;
            return {
                value: { element: value, citation },
                encoded,
                bytes: Math.ceil(Buffer.byteLength(encoded) * 1.15) + Buffer.byteLength(JSON.stringify(citation)) + 256,
                counts: {
                    textBlocks: value.type === 'block' ? 1 : 0,
                    tables: value.type === 'table' ? 1 : 0,
                    figures: value.type === 'figure' ? 1 : 0,
                },
            };
        });
        const selected = bounded.items.map(item => item.element);
        const selectedIds = new Set(selected.map(element => element.id));
        const relationshipOmissions = selected.filter(element => element.type === 'block' && element.ocrSource?.scope === 'image'
            && element.ocrSource.figureId && !selectedIds.has(element.ocrSource.figureId))
            .map(element => ({ id: element.ocrSource.figureId, reason: 'associated_figure_omitted' }));
        const nextCursor = bounded.nextPosition === null ? null : this.cursors.encode({
            documentId: state.model.documentId,
            extractionFingerprint: state.model.extractionFingerprint,
            operation: 'pdf_get_pages',
            argumentsValue: cursorArguments,
            position: bounded.nextPosition,
            restorableArguments: cursorArguments,
        });
        const resourceUris = dedupe([
            ...(completeDocument(state.model) ? [markdownResourceUri(state.model)] : []),
            ...selected.filter(element => element.type === 'figure').map(element => element.asset.uri),
        ]);
        const data = outputFormat === 'markdown' ? {
            outputFormat,
            markdownFormatVersion: MARKDOWN_FORMAT_VERSION,
            pages: requestedPages,
            markdown: serializePagedMarkdown(selected, requestedPages, { tableDetail }),
            resourceUris,
            ...(compactCitations ? { citationRefs: bounded.items.map(item => item.citation) } : {}),
        } : {
            outputFormat,
            mode,
            pages: requestedPages,
            elements: selected,
        };
        return {
            ...data,
            citations: compactCitations ? [] : selected.map(item => item.citation),
            warnings: summarizePageWarnings(state.model.pages.filter(page => requested.has(page.number))),
            omissions: dedupe([...bounded.omissions, ...relationshipOmissions]),
            budget: { configured: resolvedBudget, usage: bounded.usage, estimators: { text: 'utf8_bytes_divided_by_4', response: 'bounded_fragment_preflight_then_exact_wire_serialization' } },
            nextCursor,
            completion: {
                documentComplete: completeDocument(state.model),
                requestedScopeComplete: requestedPagesComplete(state.model, requestedPages),
                resultComplete: nextCursor === null,
            },
        };
        });
    }

    async getElement(args) {
        if (!args.extractionFingerprint) throw new PdfDecompilerError('missing_extraction_fingerprint', 'pdf_get_element requires extractionFingerprint.');
        const current = this.currentGeneration.get(args.documentId);
        if (current && current !== args.extractionFingerprint && !this.states.has(stateKey(args.documentId, args.extractionFingerprint))) {
            throw new PdfDecompilerError('stale_reference', 'The element reference belongs to a different extraction generation.');
        }
        try {
            return await this.withOperation(args.documentId, args.extractionFingerprint, async state => {
                const element = state.indexes.elements.get(args.elementId);
                if (!element) throw new PdfDecompilerError('stale_reference', 'The element does not exist in the requested extraction generation.');
                if (element.type !== 'table') {
                    if (args.tableSelection) throw new PdfDecompilerError('TABLE_SELECTION_NOT_APPLICABLE', 'tableSelection is valid only for table elements.');
                    if (args.cursor) throw new PdfDecompilerError('changed_cursor_arguments', 'This element does not use a continuation cursor.');
                    return {
                        element,
                        tableSelection: null,
                        citations: [element.citation],
                        completion: { documentComplete: completeDocument(state.model), requestedScopeComplete: true, resultComplete: true },
                    };
                }
                const resolvedBudget = resolveBudget(args.budget);
                const cursorArguments = {
                    elementId: args.elementId,
                    tableSelection: args.tableSelection || null,
                    requestedBudget: args.budget || null,
                    hardBudgetFingerprint: fingerprint(HARD_BUDGET),
                };
                const cursorPosition = args.cursor ? this.cursors.decode(args.cursor, {
                    documentId: state.model.documentId,
                    extractionFingerprint: state.model.extractionFingerprint,
                    operation: 'pdf_get_element',
                    argumentsValue: cursorArguments,
                }) : { offset: 0 };
                const boundedBudget = {
                    ...resolvedBudget,
                    responseBytes: Math.floor(Math.min(resolvedBudget.responseBytes, args._wireResponseBytes ?? resolvedBudget.responseBytes) * 0.65),
                    estimatedTokens: Math.floor(Math.min(resolvedBudget.estimatedTokens, args._wireEstimatedTokens ?? resolvedBudget.estimatedTokens) * 0.65),
                };
                const selected = selectTable(element, args.tableSelection || {}, boundedBudget, cursorPosition.offset || 0);
                const nextCursor = selected.nextOffset === null ? null : this.cursors.encode({
                    documentId: state.model.documentId,
                    extractionFingerprint: state.model.extractionFingerprint,
                    operation: 'pdf_get_element',
                    argumentsValue: cursorArguments,
                    position: { offset: selected.nextOffset },
                });
                return {
                    element: selected.element,
                    tableSelection: selected.tableSelection,
                    citations: [element.citation],
                    omissions: selected.omissions,
                    budget: { ...selected.budget, configured: resolvedBudget },
                    nextCursor,
                    completion: { documentComplete: completeDocument(state.model), requestedScopeComplete: true, resultComplete: nextCursor === null },
                };
            });
        } catch (error) {
            if (['cache_generation_missing', 'expired_process_state', 'stale_extraction_fingerprint'].includes(error.code)) {
                throw new PdfDecompilerError('stale_reference', 'The element reference belongs to an unavailable extraction generation.');
            }
            throw error;
        }
    }

    async renderPage(args) {
        return this.withOperation(args.documentId, args.extractionFingerprint, async state => {
        const bbox = Array.isArray(args.bbox) ? { x: args.bbox[0], y: args.bbox[1], width: args.bbox[2], height: args.bbox[3] } : args.bbox || null;
        const pageRecord = state.indexes.pages.get(args.page);
        if (!pageRecord) throw new PdfDecompilerError('page_unavailable', 'The page has not been decomposed or does not exist.');
        const budget = resolveBudget(args.budget);
        if (budget.renderedPages < 1) throw new PdfDecompilerError('budget_exhausted', 'The rendered-page budget is zero.');
        const format = args.format === 'jpeg' ? 'jpeg'
            : args.format === 'png' ? 'png'
                : bbox && pageRecord.contentClass === 'visual' ? 'jpeg' : 'png';
        const maxDimension = Math.min(args.maxDimension || budget.imageDimension, budget.imageDimension, 4096);
        if (maxDimension < 64) throw new PdfDecompilerError('budget_exhausted', 'The image-dimension budget is below the minimum render size.');
        const renderKey = fingerprint({ page: args.page, bbox, format, maxDimension });
        const id = `render:${args.page}:${renderKey.slice(0, 24)}`;
        let asset = state.derivedAssets.get(id);
        if (!asset) {
            const rendered = await runRenderSubprocess(state.pdfBytes, this.config, { page: args.page, bbox, format, maxDimension });
            asset = {
                id,
                kind: 'page-render',
                documentId: state.model.documentId,
                extractionFingerprint: state.model.extractionFingerprint,
                mimeType: rendered.mimeType,
                width: rendered.width,
                height: rendered.height,
                data: rendered.data,
                sha256: sha256(Buffer.from(rendered.data, 'base64')),
                uri: `pdf-decompiler://document/${state.model.documentId}/${state.model.extractionFingerprint}/asset/${encodeURIComponent(id)}`,
                enforcement: rendered.enforcement,
                budget: {
                    configured: budget,
                    usage: {
                        renderedPages: 1,
                        imageDimension: Math.max(rendered.width, rendered.height),
                        encodedImageBytes: Buffer.byteLength(rendered.data, 'base64'),
                        estimatedImageTokens: Math.ceil((rendered.width * rendered.height) / 750),
                    },
                    estimators: { image: 'generic_pixels_divided_by_750_advisory' },
                },
            };
            state.derivedAssets.set(id, asset);
            if (this.config.cache.mode === 'persistent') await this.cache.saveDerivedAsset(asset);
        }
        return { ...asset, completion: { documentComplete: completeDocument(state.model), requestedScopeComplete: true, resultComplete: true } };
        });
    }

    async readResource(uri) {
        const generationMatch = /^pdf-decompiler:\/\/document\/(doc_[a-f0-9]{64})\/([a-f0-9]{64})\/(asset|canonical)\/(.+)$/.exec(uri);
        const markdownMatch = /^pdf-decompiler:\/\/document\/(doc_[a-f0-9]{64})\/([a-f0-9]{64})\/markdown\/(\d+)\/([a-f0-9]{64})\/full\.md$/.exec(uri);
        if (!generationMatch && !markdownMatch) throw new PdfDecompilerError('invalid_resource_uri', 'The resource URI is invalid.');
        const documentId = (generationMatch || markdownMatch)[1];
        const generation = (generationMatch || markdownMatch)[2];
        const kind = markdownMatch ? 'markdown' : generationMatch[3];
        const id = generationMatch ? decodeURIComponent(generationMatch[4]) : markdownMatch[4];
        if (markdownMatch && Number(markdownMatch[3]) !== MARKDOWN_FORMAT_VERSION) throw new PdfDecompilerError('stale_markdown_resource', 'The Markdown format version is unavailable.');
        let state = this.states.get(stateKey(documentId, generation));
        const activeState = state || null;
        let temporaryLease = null;
        if (activeState) {
            if (activeState.closing) throw new PdfDecompilerError('closed_document', 'The document generation is closing.');
            activeState.operationCount += 1;
        }
        if (!state) {
            const reason = await this.cache.unavailableReason(documentId, generation);
            if (this.config.cache.mode !== 'persistent') {
                const current = this.currentGeneration.get(documentId);
                const code = reason === 'closed' ? 'closed_document'
                    : reason === 'deleted' ? 'deleted_generation'
                        : current && current !== generation ? 'stale_extraction_fingerprint' : 'process_local_resource_expired';
                throw new PdfDecompilerError(code, 'The process-local resource is no longer available.');
            }
            if (!(await this.cache.generationExists(documentId, generation))) {
                const codes = { evicted: 'evicted_generation', deleted: 'deleted_generation', corrupt: 'corrupt_generation' };
                const current = this.currentGeneration.get(documentId);
                throw new PdfDecompilerError(codes[reason] || (current && current !== generation ? 'stale_extraction_fingerprint' : 'cache_generation_missing'), 'The extraction generation is unavailable.');
            }
            temporaryLease = await this.cache.acquireLease(documentId, generation);
            const cached = await this.cache.loadGeneration(documentId, generation, { loadBm25: false });
            if (!cached) {
                await this.cache.releaseLease(temporaryLease);
                throw new PdfDecompilerError('cache_generation_missing', 'The extraction generation is unavailable.');
            }
            state = { model: cached.model, pdfBytes: cached.pdfBytes, indexes: indexModel(cached.model), derivedAssets: new Map() };
        }
        try {
            if (kind === 'markdown') {
                if (!completeDocument(state.model)) throw new PdfDecompilerError('MARKDOWN_SERIALIZATION_FAILED', 'A complete Markdown export requires a complete canonical document. Use paged Markdown retrieval with cursors.');
                const exported = await getFullMarkdownExport(state.model, this.cache, this.config, id);
                return { mimeType: 'text/markdown', text: exported.text };
            }
            if (kind === 'canonical') return { mimeType: 'application/json', text: JSON.stringify(modelView(state.model), null, 2) };
            let asset = state.derivedAssets.get(id) || state.indexes.assets.get(id);
            if ((!asset || !asset.data) && this.config.cache.mode === 'persistent') asset = await this.cache.loadDerivedAsset(documentId, generation, id) || asset;
            if (asset?.deferredRender && !asset.data) {
                const rendered = await runRenderSubprocess(state.pdfBytes, this.config, asset.deferredRender);
                asset = {
                    ...asset,
                    data: rendered.data,
                    mimeType: rendered.mimeType,
                    width: rendered.width,
                    height: rendered.height,
                    sha256: sha256(Buffer.from(rendered.data, 'base64')),
                };
                state.derivedAssets.set(id, asset);
                if (this.config.cache.mode === 'persistent') await this.cache.saveDerivedAsset(asset);
            }
            if (!asset?.data) throw new PdfDecompilerError('missing_asset', 'The requested asset is unavailable.');
            return { mimeType: asset.mimeType, blob: asset.data };
        } finally {
            if (activeState) {
                activeState.operationCount -= 1;
                if (activeState.operationCount === 0) activeState.operationWaiters.splice(0).forEach(resolve => resolve());
            }
            if (temporaryLease) await this.cache.releaseLease(temporaryLease);
        }
    }

    async closeDocument(args) {
        const key = stateKey(args.documentId, args.extractionFingerprint);
        return this.withOpenLock(key, () => this.closeDocumentLocked(args, key));
    }

    async closeDocumentLocked(args, key) {
        timingMark('document_lookup');
        const state = this.states.get(key);
        if (!state) {
            if (args.sourceId && this.closedHandles.has(args.sourceId)) throw new PdfDecompilerError('SOURCE_HANDLE_ALREADY_CLOSED', 'The source handle is already closed.');
            if (args.sourceId) throw new PdfDecompilerError('SOURCE_HANDLE_UNKNOWN', 'The source handle is unavailable.');
            throw new PdfDecompilerError('closed_document', 'The document is not open.');
        }
        let sourceId = args.sourceId;
        if (!sourceId) {
            if (state.handles.size !== 1) throw new PdfDecompilerError('SOURCE_HANDLE_REQUIRED', 'sourceId is required when multiple source handles are active.');
            sourceId = state.handles.keys().next().value;
        }
        if (!state.handles.has(sourceId)) {
            if (this.closedHandles.has(sourceId)) throw new PdfDecompilerError('SOURCE_HANDLE_ALREADY_CLOSED', 'The source handle is already closed.');
            throw new PdfDecompilerError('SOURCE_HANDLE_UNKNOWN', 'The source handle is unavailable.');
        }
        if (args.deleteCache && (state.handles.size > 1 || state.operationCount > 0)) {
            throw new PdfDecompilerError('CACHE_GENERATION_IN_USE', 'The extraction generation has active source handles or operations.');
        }
        state.handles.delete(sourceId);
        timingMark('handle_release');
        this.closedHandles.set(sourceId, Date.now());
        while (this.closedHandles.size > 1024) this.closedHandles.delete(this.closedHandles.keys().next().value);
        if (state.handles.size > 0) return { closed: true, sourceId, remainingHandles: state.handles.size, cacheDeleted: false, deletionVerified: true, completion: { documentComplete: completeDocument(state.model), requestedScopeComplete: true, resultComplete: true } };
        state.closing = true;
        await this.waitForOperations(state);
        if (state.leaseId) await this.cache.releaseLease(state.leaseId);
        timingMark('lease_release');
        this.states.delete(key);
        this.closedStates.add(key);
        if (this.currentGeneration.get(state.model.documentId) === state.model.extractionFingerprint) this.currentGeneration.delete(state.model.documentId);
        let deletion = { deleted: false, verified: true };
        if (args.deleteCache) deletion = await this.cache.deleteGeneration(state.model.documentId, state.model.extractionFingerprint, { ignoreMissing: true, reason: 'deleted' });
        else await this.cache.cleanupDocumentState(state.model.documentId, state.model.extractionFingerprint);
        timingMark(args.deleteCache ? 'cache_deletion' : 'resource_cleanup');
        return { closed: true, sourceId, remainingHandles: 0, cacheDeleted: deletion.deleted, deletionVerified: deletion.verified, completion: { documentComplete: completeDocument(state.model), requestedScopeComplete: true, resultComplete: true } };
    }

    async close() {
        this.closing = true;
        await Promise.all(this.openLocks.values());
        for (const state of this.states.values()) {
            state.closing = true;
            state.handles.clear();
            await this.waitForOperations(state);
            if (state.leaseId) await this.cache.releaseLease(state.leaseId);
        }
        this.states.clear();
        this.currentGeneration.clear();
        await this.cache.close();
    }
}
