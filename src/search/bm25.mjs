import { PdfDecompilerError } from '../core/errors.mjs';

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const MAX_PHRASE_TOKENS = 64;
export const BM25_INDEX_VERSION = 3;

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

export function searchBm25(index, query, options = {}) {
    const phraseTokens = tokenize(query);
    if (options.phrase && phraseTokens.length > MAX_PHRASE_TOKENS) {
        throw new PdfDecompilerError('invalid_input', `Phrase search supports up to ${MAX_PHRASE_TOKENS} words.`);
    }
    const queryTokens = [...new Set(phraseTokens)];
    if (!queryTokens.length) return [];
    const k1 = 1.2;
    const b = 0.75;
    const total = index.documents.length;
    const averageLength = Math.max(1, index.averageLength);
    const queryWeights = queryTokens.map(token => {
        const df = Object.hasOwn(index.documentFrequency, token) ? index.documentFrequency[token] : 0;
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
            const snippetChars = options.snippetChars || 500;
            const snippetSource = phraseStart !== null ? document.text.normalize('NFKC')
                : document.context?.map(item => typeof item === 'number' ? index.documents[item].text : item).join('\n') || document.text;
            const normalizedText = snippetSource.normalize('NFKC').toLocaleLowerCase('und');
            let firstMatch = 0;
            if (phraseStart === null) {
                firstMatch = queryTokens.map(token => normalizedText.indexOf(token)).filter(position => position >= 0).sort((a, b) => a - b)[0] ?? 0;
            } else {
                let tokenPosition = 0;
                for (const match of normalizedText.matchAll(TOKEN_PATTERN)) {
                    if (tokenPosition === phraseStart) {
                        firstMatch = match.index;
                        break;
                    }
                    tokenPosition += 1;
                }
            }
            const start = Math.max(0, firstMatch - Math.floor(snippetChars / 3));
            const match = {
                id: document.id,
                page: document.page,
                type: document.type,
                readingOrder: document.readingOrder,
                score,
                matchedTerms,
                snippet: snippetSource.slice(start, start + snippetChars),
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
