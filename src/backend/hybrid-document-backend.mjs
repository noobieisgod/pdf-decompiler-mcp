import { openPdfjsDocumentBackend } from './pdfjs-backend.mjs';
import { getMupdfDocMetadata, getMupdfDocOutline } from './mupdf-page-data.mjs';
import { openMupdfDocument, renderMupdfPageToCanvas } from './mupdf-runtime.mjs';

export async function openHybridDocumentBackend(pdfBytes) {
    const [pdfjsBackend, mupdfDoc] = await Promise.all([
        openPdfjsDocumentBackend(pdfBytes),
        Promise.resolve(openMupdfDocument(pdfBytes)),
    ]);
    return {
        name: 'hybrid',
        capabilities: {
            ...pdfjsBackend.capabilities,
            metadataBackend: 'mupdf',
            outlineBackend: 'mupdf',
            pageRasterBackend: 'mupdf',
        },
        getTotalPages() {
            return mupdfDoc.countPages();
        },
        async getMetadata() {
            return getMupdfDocMetadata(mupdfDoc) ?? pdfjsBackend.getMetadata();
        },
        async getOutline() {
            return getMupdfDocOutline(mupdfDoc) ?? pdfjsBackend.getOutline();
        },
        async loadPageData(pageNum) {
            const pageData = await pdfjsBackend.loadPageData(pageNum);
            let rasterPromise = null;
            return {
                ...pageData,
                renderPageCanvas: async (scale = 1) => {
                    if (scale !== 1) {
                        const { width, height } = pageData.viewport;
                        return renderMupdfPageToCanvas(mupdfDoc, pageNum, { width: width * scale, height: height * scale });
                    }
                    if (!rasterPromise) {
                        rasterPromise = Promise.resolve(renderMupdfPageToCanvas(mupdfDoc, pageNum, pageData.viewport));
                    }
                    return rasterPromise;
                },
                pageRasterBackend: 'mupdf',
            };
        },
        async destroy() {
            await pdfjsBackend.destroy();
            mupdfDoc.destroy?.();
        },
    };
}
