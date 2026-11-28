import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'node:util';

import {
    MIN_COLUMN_GUTTER_LINE_COUNT,
    OCR_MAX_REPEATED_RATIO,
    OCR_MAX_CORRUPTED_LINE_RATIO,
    OCR_MAX_LOW_CONFIDENCE_RATIO,
    OCR_MAX_SHORT_TOKEN_RATIO,
    OCR_MAX_SYMBOL_HEAVY_RATIO,
    OCR_LOW_CONFIDENCE_THRESHOLD,
    OCR_MIN_ALNUM_RATIO,
    OCR_MIN_CHARS,
    OCR_MIN_MEAN_CONFIDENCE,
    OCR_MIN_WORDLIKE_RATIO,
    OCR_MIN_WORDS,
} from '../config/constants.mjs';
import { unionBBoxes } from '../model/geometry.mjs';
import { buildTextBlocks } from './text.mjs';

const runCommand = promisify(execFile);
export const OCR_TIMEOUT_MS = 30_000;
const OSD_TIMEOUT_MS = 3_000;
const OCR_WIDE_GUTTER_RATIO = 0.15;
const OCR_MIN_NUMERIC_CONFIDENCE = 90;
let tesseractAvailableCache;
let installedLanguages;
const UNSPACED_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const NUMERIC_TOKEN = /^[-+−]?\p{Nd}+(?:[.,]\p{Nd}+)*[%‰]?$/u;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

export function detectTesseract() {
    if (typeof tesseractAvailableCache === 'boolean') {
        return tesseractAvailableCache;
    }
    try {
        const probe = spawnSync('tesseract', ['--version'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 5000,
        });
        tesseractAvailableCache = probe.status === 0;
    } catch {
        tesseractAvailableCache = false;
    }
    return tesseractAvailableCache;
}

export function missingTesseractLanguages(languages) {
    if (!installedLanguages) {
        const probe = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        const listed = probe.status === 0 ? probe.stdout.split(/\r?\n/).filter(line => /^[a-z][a-z0-9_]{1,31}$/.test(line)) : [];
        installedLanguages = new Set(listed);
    }
    return languages.split('+').filter(language => !installedLanguages.has(language));
}

export function ocrTextLooksGood(text, allowNumbers = false) {
    const trimmed = (text ?? '').normalize('NFKC').trim();
    if (!trimmed) {
        return { ok: false, reason: 'OCR output was empty' };
    }
    const chars = [...trimmed].length;
    const tokensOf = line => UNSPACED_CJK.test(line)
        ? [...wordSegmenter.segment(line)].filter(item => item.isWordLike || /[^\p{P}\s]/u.test(item.segment)).map(item => item.segment)
        : line.split(/\s+/).filter(Boolean);
    const isWord = token => (allowNumbers && NUMERIC_TOKEN.test(token))
        || (/^[\p{L}\p{M}'’\-]+$/u.test(token)
            && (UNSPACED_CJK.test(token) || (token.match(/\p{L}/gu)?.length ?? 0) >= 3));
    const tokens = tokensOf(trimmed);
    const words = tokens.length;
    const alnum = (trimmed.match(/[\p{L}\p{N}\p{M}]/gu) ?? []).length;
    const alnumRatio = chars ? alnum / chars : 0;
    const repeatedRuns = (trimmed.match(/(.)\1{4,}/gu) ?? []).join('').length;
    const repeatedRatio = chars ? repeatedRuns / chars : 0;
    const wordlikeTokens = tokens.filter(isWord).length;
    const symbolHeavyTokens = tokens.filter(token => {
        const alnumCount = (token.match(/[\p{L}\p{N}\p{M}]/gu) ?? []).length;
        const symbolCount = [...token].length - alnumCount;
        return symbolCount > alnumCount;
    }).length;
    const shortTokens = tokens.filter(token => !UNSPACED_CJK.test(token) && /^\p{L}{1,2}$/u.test(token)).length;
    const lines = trimmed.split('\n').map(line => line.trim()).filter(Boolean);
    const corruptedLines = lines.filter(line => {
        const lineTokens = tokensOf(line);
        if (!lineTokens.length) {
            return false;
        }
        const lineWordlike = lineTokens.filter(isWord).length;
        const weirdClusters = (line.match(/[^\p{L}\p{N}\p{M}\s]{3,}/gu) ?? []).length;
        return (lineWordlike / lineTokens.length) < 0.35 || weirdClusters > 0;
    }).length;
    const wordlikeRatio = words ? wordlikeTokens / words : 0;
    const symbolHeavyRatio = words ? symbolHeavyTokens / words : 0;
    const shortTokenRatio = words ? shortTokens / words : 0;
    const corruptedLineRatio = lines.length ? corruptedLines / lines.length : 0;
    if (words < OCR_MIN_WORDS || chars < OCR_MIN_CHARS) {
        return { ok: false, reason: 'OCR output too short' };
    }
    if (alnumRatio < OCR_MIN_ALNUM_RATIO) {
        return { ok: false, reason: 'OCR output had too little readable text' };
    }
    if (repeatedRatio > OCR_MAX_REPEATED_RATIO) {
        return { ok: false, reason: 'OCR output looked repetitive or corrupted' };
    }
    if (wordlikeRatio < OCR_MIN_WORDLIKE_RATIO) {
        return { ok: false, reason: 'OCR output did not contain enough usable words' };
    }
    if (symbolHeavyRatio > OCR_MAX_SYMBOL_HEAVY_RATIO) {
        return { ok: false, reason: 'OCR output was too symbol-heavy to trust' };
    }
    if (words >= 10 && shortTokenRatio > OCR_MAX_SHORT_TOKEN_RATIO) {
        return { ok: false, reason: 'OCR output had too many broken short tokens' };
    }
    if (corruptedLineRatio > OCR_MAX_CORRUPTED_LINE_RATIO) {
        return { ok: false, reason: 'OCR output contained too many corrupted lines' };
    }
    return { ok: true, reason: null };
}

export function ocrConfidenceStats(words) {
    const confidences = (words || []).filter(word => word?.level === 5
        && String(word.text || '').normalize('NFKC').trim()
        && Number.isFinite(word.confidence)
        && word.confidence >= 0 && word.confidence <= 100)
        .map(word => word.confidence);
    if (!confidences.length) return { ok: false, sampleCount: 0, mean: null, lowConfidenceRatio: null, diagnostics: [], reason: 'OCR output had no valid word confidence samples' };
    const mean = confidences.reduce((sum, confidence) => sum + confidence, 0) / confidences.length;
    const lowConfidenceRatio = confidences.filter(confidence => confidence < OCR_LOW_CONFIDENCE_THRESHOLD).length / confidences.length;
    const diagnostics = confidences.length <= 2 ? [{ code: 'ocr_low_sample_count', sampleCount: confidences.length }] : [];
    const ok = mean >= OCR_MIN_MEAN_CONFIDENCE && lowConfidenceRatio <= OCR_MAX_LOW_CONFIDENCE_RATIO;
    return {
        ok,
        sampleCount: confidences.length,
        mean,
        lowConfidenceRatio,
        diagnostics,
        reason: ok ? null : mean < OCR_MIN_MEAN_CONFIDENCE ? 'OCR word confidence was too low' : 'OCR output contained too many low-confidence words',
    };
}

function parseTsv(value, geometry, mode) {
    const rows = value.replace(/\r\n/g, '\n').split('\n').slice(1).map(line => line.split('\t')).filter(columns => columns.length >= 12 && columns[0] === '5' && columns[11]?.trim());
    const xScale = geometry?.pageWidth && geometry?.pixelWidth ? geometry.pageWidth / geometry.pixelWidth : 1;
    const yScale = geometry?.pageHeight && geometry?.pixelHeight ? geometry.pageHeight / geometry.pixelHeight : 1;
    const xOffset = geometry?.x || 0;
    const yOffset = geometry?.y || 0;
    const words = rows.map((columns, sourceIndex) => ({
        level: Number(columns[0]),
        text: columns[11].trim(),
        block: columns[2],
        paragraph: columns[3],
        line: columns[4],
        confidence: Number(columns[10]),
        sourceIndex,
        bbox: {
            x: xOffset + Number(columns[6]) * xScale,
            y: yOffset + Number(columns[7]) * yScale,
            width: Number(columns[8]) * xScale,
            height: Number(columns[9]) * yScale,
        },
    }));
    const grouped = new Map();
    for (const word of words) {
        const key = `${word.block}:${word.paragraph}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(word);
    }
    const ocrSource = geometry?.ocrSource || { scope: 'page', figureId: null, regionId: geometry?.regionId || null, bbox: null };
    const gutter = mode === '3' && geometry?.pageWidth ? geometry.pageWidth * OCR_WIDE_GUTTER_RATIO : Infinity;
    let linesCrossingGutter = 0;
    const blocks = [...grouped.values()].map(group => {
        const lines = new Map();
        for (const word of group) {
            if (!lines.has(word.line)) lines.set(word.line, []);
            lines.get(word.line).push(word);
        }
        const text = [...lines.values()].map(line => {
            line.sort((a, b) => a.bbox.x - b.bbox.x || a.sourceIndex - b.sourceIndex);
            if (line.some((word, index) => index >= 2 && index < line.length - 1
                && word.bbox.x - line[index - 1].bbox.x - line[index - 1].bbox.width >= gutter)) {
                linesCrossingGutter += 1;
            }
            return line.map(word => word.text).join(' ');
        }).join('\n');
        return {
            text,
            role: 'ocr',
            bbox: unionBBoxes(group.map(word => word.bbox), geometry?.pageWidth, geometry?.pageHeight),
            spans: group,
            sourceIndex: Math.min(...group.map(word => word.sourceIndex)),
            textSource: 'ocr',
            ocrSource,
        };
    });
    if (linesCrossingGutter > 0 && linesCrossingGutter >= MIN_COLUMN_GUTTER_LINE_COUNT) {
        const items = words.map(word => {
            const { bbox, text } = word;
            return { word, str: text, bbox, x: bbox.x, yTop: bbox.y, w: bbox.width, h: bbox.height };
        });
        const layout = buildTextBlocks(items, { width: geometry.pageWidth, height: geometry.pageHeight });
        if (!layout.warnings.length && layout.blocks.reduce((count, block) => count + block.spans.length, 0) === words.length) {
            const ordered = layout.blocks.map(({ text, bbox, sourceIndex, spans }) => ({
                text, bbox, sourceIndex, role: 'ocr', spans: spans.map(span => span.word), textSource: 'ocr', ocrSource,
            }));
            return { words, blocks: ordered, text: ordered.map(block => block.text).join('\n\n') };
        }
    }
    return { words, blocks, text: blocks.map(block => block.text).join('\n\n') };
}

async function readOcr(inputPath, geometry, languages, mode, timeout) {
    const args = [inputPath, 'stdout', '-l', languages, '--psm', mode, '-c', 'tessedit_create_tsv=1'];
    if (geometry?.dpi) args.push('--dpi', String(geometry.dpi));
    const { stdout } = await runCommand('tesseract', args, {
        windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
    });
    const { words, blocks, text } = parseTsv(stdout, geometry, mode);
    const cleaned = text.trim();
    const allowNumbers = words.every(word => !NUMERIC_TOKEN.test(word.text.normalize('NFKC'))
        || word.confidence >= OCR_MIN_NUMERIC_CONFIDENCE);
    const quality = ocrTextLooksGood(cleaned, allowNumbers);
    const confidence = ocrConfidenceStats(words);
    return { ok: quality.ok && confidence.ok, text: cleaned, blocks, words,
        reason: quality.ok ? confidence.reason : quality.reason, diagnostics: confidence.diagnostics, confidence };
}

async function retryRotatedOcr(inputPath, pngBytes, geometry, languages, mode, deadline) {
    const timeLeft = deadline - Date.now();
    if (timeLeft <= OSD_TIMEOUT_MS) return null;
    const { stdout } = await runCommand('tesseract', [inputPath, 'stdout', '-l', 'osd', '--psm', '0', '-c', 'min_characters_to_try=20'], {
        windowsHide: true, timeout: OSD_TIMEOUT_MS, encoding: 'utf8',
    });
    const rotation = Number(/^Rotate:\s*(90|180|270)\s*$/m.exec(stdout)?.[1]);
    const confidence = Number(/^Orientation confidence:\s*([\d.]+)/m.exec(stdout)?.[1]);
    if (!rotation || !(confidence > 0)) return null;

    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(pngBytes);
    const swapsAxes = rotation !== 180;
    const canvas = createCanvas(swapsAxes ? image.height : image.width, swapsAxes ? image.width : image.height);
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rotation * Math.PI / 180);
    ctx.drawImage(image, -image.width / 2, -image.height / 2);
    const rotatedPath = path.join(path.dirname(inputPath), 'rotated.png');
    await fs.promises.writeFile(rotatedPath, await canvas.encode('png'));
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const result = await readOcr(rotatedPath, { regionId: geometry?.regionId, ocrSource: geometry?.ocrSource, dpi: geometry?.dpi }, languages, mode, remaining);
    if (!result.ok) return null;

    // Map boxes back to the original image only after ordering words in upright space.
    const scaleX = (geometry?.pageWidth || image.width) / image.width;
    const scaleY = (geometry?.pageHeight || image.height) / image.height;
    for (const item of [...result.words, ...result.blocks]) {
        if (!item.bbox) continue;
        const { x, y, width, height } = item.bbox;
        const left = rotation === 90 ? y : image.width - (rotation === 180 ? x + width : y + height);
        const top = rotation === 270 ? x : image.height - (rotation === 180 ? y + height : x + width);
        item.bbox = {
            x: (geometry?.x || 0) + left * scaleX,
            y: (geometry?.y || 0) + top * scaleY,
            width: (swapsAxes ? height : width) * scaleX,
            height: (swapsAxes ? width : height) * scaleY,
        };
    }
    return result;
}

export async function runTesseractOcr(pngBytes, pageNum, geometry = null, languages = 'eng', deadline = Date.now() + OCR_TIMEOUT_MS) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-decompiler-ocr-'));
    const inputPath = path.join(tempDir, `page-${pageNum}.png`);
    try {
        fs.writeFileSync(inputPath, pngBytes);
        const fullPage = geometry?.ocrSource?.scope !== 'image';
        const mode = fullPage ? '3' : '6';
        const timeLeft = deadline - Date.now();
        if (timeLeft <= 0) return { ok: false, text: '', reason: 'OCR process timed out' };
        const result = await readOcr(inputPath, geometry, languages, mode, timeLeft);
        if (result.ok) return result;
        const rotated = await retryRotatedOcr(inputPath, pngBytes, geometry, languages, mode, deadline).catch(() => null);
        if (rotated) return rotated;
        const remaining = deadline - Date.now();
        if (fullPage && remaining > 0) {
            const uniform = await readOcr(inputPath, geometry, languages, '6', remaining).catch(() => null);
            if (uniform?.ok) return uniform;
        }
        return result;
    } catch {
        return { ok: false, text: '', reason: 'OCR process failed' };
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
        }
    }
}
