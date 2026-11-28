import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createCanvas } from './canvas.mjs';

if (typeof globalThis.DOMMatrix === 'undefined') {
    await import('../../pdfjs-polyfill.mjs');
}

const pdfjsUrl = import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs');
const pdfjs = await import(pdfjsUrl);
const { getDocument, VerbosityLevel, OPS, GlobalWorkerOptions, AnnotationMode } = pdfjs;

try {
    if (GlobalWorkerOptions && !GlobalWorkerOptions.workerSrc) {
        GlobalWorkerOptions.workerSrc = new URL('pdf.worker.mjs', pdfjsUrl).href;
    }
} catch {
}

const LOCAL_FONT_DIR = fileURLToPath(new URL('../../standard_fonts/', pdfjsUrl));
export const PDFJS_CMAP_DIRECTORY = `${fileURLToPath(new URL('../../cmaps', pdfjsUrl))}/`;

export class LocalStandardFontDataFactory {
    async fetch({ filename }) {
        return fs.readFileSync(path.join(LOCAL_FONT_DIR, filename));
    }
}

export class NodeCanvasFactory {
    create(width, height) {
        const canvas = createCanvas(width, height);
        const context = canvas.getContext('2d');
        return { canvas, context };
    }

    reset(holder, width, height) {
        holder.canvas.width = width;
        holder.canvas.height = height;
    }

    destroy(holder) {
        holder.canvas.width = 0;
        holder.canvas.height = 0;
    }
}

export {
    AnnotationMode,
    getDocument,
    OPS,
    VerbosityLevel,
};
