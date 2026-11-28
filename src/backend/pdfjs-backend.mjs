import { fileURLToPath } from 'node:url';
import { getDocMetadata, getDocOutline, loadPageData } from '../pdf/page-data.mjs';
import {
    createCanvas,
    getDocument,
    LocalStandardFontDataFactory,
    NodeCanvasFactory,
    VerbosityLevel,
} from '../pdf/pdfjs-runtime.mjs';

const CMAP_DIRECTORY = `${fileURLToPath(new URL('../../node_modules/pdfjs-dist/cmaps', import.meta.url))}/`;

export async function openPdfjsDocumentBackend(pdfBytes) {
    const uint8 = new Uint8Array(pdfBytes);
    const pdfjsDoc = await getDocument({
        data: uint8,
        StandardFontDataFactory: LocalStandardFontDataFactory,
        cMapUrl: CMAP_DIRECTORY,
        canvasFactory: createCanvas ? new NodeCanvasFactory() : undefined,
        disableWorker: true,
        enableXfa: false,
        verbosity: VerbosityLevel.ERRORS,
        useWorkerFetch: false,
        isEvalSupported: false,
    }).promise;

    return {
        name: 'pdfjs',
        capabilities: {
            metadata: true,
            outline: true,
            text: true,
            links: true,
            imagePlacements: true,
            directImageObjects: true,
            structTree: true,
            pageRaster: true,
        },
        getTotalPages() {
            return pdfjsDoc.numPages;
        },
        async getMetadata() {
            return getDocMetadata(pdfjsDoc);
        },
        async getOutline() {
            return getDocOutline(pdfjsDoc);
        },
        async loadPageData(pageNum) {
            return loadPageData(pdfjsDoc, pageNum);
        },
        async destroy() {
            await pdfjsDoc.destroy();
        },
    };
}
