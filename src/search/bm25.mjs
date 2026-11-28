import { PdfDecompilerError } from '../core/errors.mjs';

const TOKEN_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]|[[\p{L}\p{N}]--[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]]+/gv;
const MAX_PHRASE_TOKENS = 64;
export const BM25_INDEX_VERSION = 4;
export const BM25_SEARCH_REVISION = 2;

export function tokenize(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase('und').match(TOKEN_PATTERN) || [];
}

function searchable(element) {
    if (element.type === 'table') return element.text || '';
    if (element.type === 'figure') return element.caption || '';
    return element.text || '';
}

export function buildBm25(model) {
    const metadataText = Object.entries(model.metadata || {}).map(([key, value]) => `${key}: ${value}`).join('\n');
    const supplemental = [
        metadataText && {
            id: 'metadata:document',
            page: 1,
            type: 'metadata',
            readingOrder: -2,
            text: metadataText,
            citation: { documentId: model.documentId, extractionFingerprint: model.extractionFingerprint, pageId: 'page:1', elementId: 'metadata:document', bbox: null },
        },
        ...(model.outline || []).map((entry, index) => ({
            id: `outline:${index + 1}`,
            page: Number(entry.page || 1),
            type: 'outline',
            readingOrder: -1,
            text: entry.title || '',
            citation: { documentId: model.documentId, extractionFingerprint: model.extractionFingerprint, pageId: `page:${Number(entry.page || 1)}`, elementId: `outline:${index + 1}`, bbox: null },
        })),
    ].filter(Boolean);
    const canonicalElements = [...model.elements].sort((a, b) => a.page - b.page || a.readingOrder - b.readingOrder || a.id.localeCompare(b.id));
    const canonicalIds = new Set(canonicalElements.map(element => element.id));
    const sourceElements = [...canonicalElements, ...supplemental];
    const documents = [];
    const indexedOffsets = new Map();
    const documentFrequency = new Map();
    let tokenCount = 0;
    for (const [offset, element] of sourceElements.entries()) {
        const text = searchable(element);
        const tokens = tokenize(text);
        if (!tokens.length) continue;
        const positions = Object.create(null);
        tokens.forEach((token, index) => (positions[token] ||= []).push(index));
        for (const token of Object.keys(positions)) {
            documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
        }
        indexedOffsets.set(offset, documents.length);
        documents.push({ id: element.id, page: element.page, type: element.type, readingOrder: element.readingOrder,
            text, citation: element.citation, length: tokens.length, positions });
        tokenCount += tokens.length;
    }
    for (const [offset, index] of indexedOffsets) {
        const element = sourceElements[offset];
        if (!canonicalIds.has(element.id)) continue;
        const context = [offset - 1, offset, offset + 1].flatMap(neighbor => {
            const candidate = sourceElements[neighbor];
            if (candidate?.page !== element.page || !canonicalIds.has(candidate.id)) return [];
            if (indexedOffsets.has(neighbor)) return [indexedOffsets.get(neighbor)];
            const text = searchable(candidate);
            return text ? [text] : [];
        });
        if (context.length > 1) documents[index].context = context;
    }
    return {
        version: BM25_INDEX_VERSION,
        averageLength: tokenCount / Math.max(1, documents.length),
        documentFrequency: Object.fromEntries([...documentFrequency.entries()].sort(([a], [b]) => a.localeCompare(b))),
        documents,
    };
}

function hasPosition(positions, target) {
    let start = 0;
    let end = positions.length;
    while (start < end) {
        const middle = (start + end) >>> 1;
        if (positions[middle] < target) start = middle + 1;
        else end = middle;
    }
    return positions[start] === target;
}

function excerpt(index, document, matchedTerms, phraseStart, limit) {
    const text = phraseStart === null ? document.text : document.text.normalize('NFKC');
    if (text.length <= limit) {
        if (phraseStart !== null || !document.context || text.length === limit) return text;
        const center = document.context.findIndex(item => typeof item === 'number' && index.documents[item] === document);
        if (center < 0) return text;
        const neighbor = item => typeof item === 'number' ? index.documents[item].text : item;
        const before = document.context.slice(0, center).map(neighbor).join('\n');
        const after = document.context.slice(center + 1).map(neighbor).join('\n');
        const leading = Math.min(Math.floor(limit / 3), Math.max(0, limit - text.length - 1));
        const prefix = before && leading ? before.slice(-leading) + '\n' : '';
        const trailing = limit - prefix.length - text.length - 1;
        return prefix + text + (after && trailing > 0 ? '\n' + after.slice(0, trailing) : '');
    }

    const position = phraseStart ?? matchedTerms.reduce((first, token) => Math.min(first, document.positions[token][0]), Infinity);
    const display = text.normalize('NFKC');
    const lower = display.toLocaleLowerCase('und');
    let tokenPosition = 0;
    for (const match of lower.matchAll(TOKEN_PATTERN)) {
        if (tokenPosition++ !== position) continue;
        let offset = match.index;
        if (lower.length !== display.length) {
            // Case folding can expand characters before the match.
            let start = 0;
            let end = display.length;
            while (start < end) {
                const middle = (start + end) >>> 1;
                if (display.slice(0, middle).toLocaleLowerCase('und').length < offset) start = middle + 1;
                else end = middle;
            }
            offset = start;
        }
        const start = Math.max(0, Math.min(display.length - limit, offset - Math.floor(limit / 3)));
        return display.slice(start, start + limit);
    }
    return display.slice(0, limit);
}

export function searchBm25(index, query, options = {}) {
    const phraseTokens = tokenize(query);
    if (options.phrase && phraseTokens.length > MAX_PHRASE_TOKENS) {
        throw new PdfDecompilerError('invalid_input', `Phrase search supports up to ${MAX_PHRASE_TOKENS} tokens.`);
    }
    const queryTokens = [...new Set(phraseTokens)];
    if (!queryTokens.length) return [];
    const k1 = 1.2;
    const b = 0.75;
    const { total = index.documents.length, averageLength: meanLength = index.averageLength, documentFrequency = index.documentFrequency } = options.statistics || {};
    const averageLength = Math.max(1, meanLength);
    const queryWeights = queryTokens.map(token => {
        const df = Object.hasOwn(documentFrequency, token) ? documentFrequency[token] : 0;
        return [token, Math.log(1 + ((total - df + 0.5) / (df + 0.5)))];
    });
    const pageSet = options.pages ? new Set(options.pages) : null;
    const typeSet = options.elementTypes ? new Set(options.elementTypes) : null;
    const matches = [];
    const pageMatches = options.granularity === 'page' ? new Map() : null;
    for (const document of index.documents) {
        if (pageSet && !pageSet.has(document.page)) continue;
        if (typeSet && !typeSet.has(document.type)) continue;
        let score = 0;
        const matchedTerms = [];
        for (const [token, idf] of queryWeights) {
            if (!Object.hasOwn(document.positions, token)) continue;
            const frequency = document.positions[token].length;
            matchedTerms.push(token);
            const denominator = frequency + k1 * (1 - b + b * document.length / averageLength);
            score += idf * ((frequency * (k1 + 1)) / denominator);
        }
        if (score > 0) {
            let phraseStart = null;
            let occurrences = 0;
            if ((options.phrase || (pageMatches && phraseTokens.length > 1 && phraseTokens.length <= MAX_PHRASE_TOKENS))
                && matchedTerms.length === queryTokens.length) {
                for (const start of document.positions[phraseTokens[0]]) {
                    if (!phraseTokens.every((token, offset) => offset === 0 || hasPosition(document.positions[token], start + offset))) continue;
                    phraseStart ??= start;
                    occurrences += 1;
                    if (!pageMatches) break;
                }
            }
            if (options.phrase && !occurrences) continue;
            const match = {
                id: document.id,
                page: document.page,
                type: document.type,
                readingOrder: document.readingOrder,
                score,
                matchedTerms,
                snippet: excerpt(index, document, matchedTerms, phraseStart, options.snippetChars || 500),
                citation: document.citation,
                citations: [document.citation],
                contributingElementIds: [document.id],
            };
            if (pageMatches) {
                const pageMatch = pageMatches.get(document.page) || { occurrences: 0, terms: new Set(), bestMatch: null, bestIsExact: false };
                pageMatch.occurrences += occurrences;
                matchedTerms.forEach(term => pageMatch.terms.add(term));
                const isExact = occurrences > 0;
                if (!pageMatch.bestMatch || (isExact && !pageMatch.bestIsExact) || (isExact === pageMatch.bestIsExact && score > pageMatch.bestMatch.score)) {
                    pageMatch.bestMatch = match;
                    pageMatch.bestIsExact = isExact;
                }
                pageMatches.set(document.page, pageMatch);
            } else {
                matches.push(match);
            }
        }
    }
    if (pageMatches) {
        return [...pageMatches.values()]
            .sort((a, b) => b.occurrences - a.occurrences || b.terms.size - a.terms.size
                || b.bestMatch.score - a.bestMatch.score || a.bestMatch.page - b.bestMatch.page)
            .map(page => page.bestMatch);
    }
    const grouped = [];
    for (const match of matches.sort((a, b) => a.page - b.page || a.readingOrder - b.readingOrder || a.id.localeCompare(b.id))) {
        const previous = grouped.at(-1);
        if (previous && previous.page === match.page && previous.type !== 'metadata' && previous.type !== 'outline'
            && match.type !== 'metadata' && match.type !== 'outline' && match.readingOrder <= previous.lastReadingOrder + 1) {
            previous.score = Math.max(previous.score, match.score) + Math.min(previous.score, match.score) * 0.1;
            previous.matchedTerms = [...new Set([...previous.matchedTerms, ...match.matchedTerms])];
            previous.contributingElementIds.push(match.id);
            previous.citations.push(match.citation);
            previous.lastReadingOrder = match.readingOrder;
            if (!previous.snippet.includes(match.snippet)) previous.snippet = `${previous.snippet}\n${match.snippet}`.slice(0, options.snippetChars || 500);
        } else {
            grouped.push({ ...match, lastReadingOrder: match.readingOrder });
        }
    }
    const ranked = grouped.map(({ lastReadingOrder, ...result }) => result).sort((a, b) => b.score - a.score || a.page - b.page || a.readingOrder - b.readingOrder || a.id.localeCompare(b.id));
    const seen = new Set();
    return ranked.filter(result => {
        const key = `${result.page}:${result.snippet.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('und')}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function searchBm25AcrossDocuments(indexes, query, options = {}) {
    const tokens = [...new Set(tokenize(query))];
    let total = 0;
    let lengths = 0;
    const documentFrequency = Object.create(null);
    for (const index of indexes) {
        total += index.documents.length;
        lengths += index.averageLength * index.documents.length;
        for (const token of tokens) {
            if (Object.hasOwn(index.documentFrequency, token)) {
                documentFrequency[token] = (documentFrequency[token] || 0) + index.documentFrequency[token];
            }
        }
    }
    const statistics = { total, averageLength: lengths / Math.max(1, total), documentFrequency };
    // Indexes arrive in canonical document order. Stable sort keeps tied results in that order.
    return indexes.flatMap(index => searchBm25(index, query, { ...options, statistics })).sort((a, b) => b.score - a.score);
}
