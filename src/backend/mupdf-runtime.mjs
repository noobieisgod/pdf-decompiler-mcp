import mupdf from 'mupdf';
import { createCanvas } from '../pdf/canvas.mjs';

function rgbPixmapToCanvas(pixmap) {
    if (!createCanvas) {
        throw new Error('Canvas unavailable; install @napi-rs/canvas-win32-x64-msvc@0.1.97');
    }
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const pixels = pixmap.getPixels();
    const channels = pixmap.getNumberOfComponents();
    const alpha = pixmap.getAlpha();
    const stride = pixmap.getStride();
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const src = (y * stride) + (x * channels);
            const dst = ((y * width) + x) * 4;
            rgba[dst] = pixels[src] ?? 255;
            rgba[dst + 1] = pixels[src + 1] ?? rgba[dst];
            rgba[dst + 2] = pixels[src + 2] ?? rgba[dst];
            rgba[dst + 3] = alpha ? (pixels[src + channels - 1] ?? 255) : 255;
        }
    }
    ctx.putImageData(new globalThis.ImageData(rgba, width, height), 0, 0);
    return canvas;
}

export function openMupdfDocument(pdfBytes) {
    return mupdf.Document.openDocument(pdfBytes, 'application/pdf');
}

export function renderMupdfPageToCanvas(mupdfDoc, pageNum, viewport = null, clip = null) {
    const page = mupdfDoc.loadPage(pageNum - 1);
    try {
        const [x0, y0, x1, y1] = page.getBounds();
        const baseWidth = Math.max(1, x1 - x0);
        const baseHeight = Math.max(1, y1 - y0);
        const viewportWidth = viewport?.width ?? baseWidth;
        const viewportHeight = viewport?.height ?? baseHeight;
        const scaleX = viewportWidth / baseWidth;
        const scaleY = viewportHeight / baseHeight;
        const scale = Number.isFinite(scaleX) && Number.isFinite(scaleY)
            ? Math.max(0.01, (scaleX + scaleY) / 2)
            : 1;
        const matrix = mupdf.Matrix.scale(scale, scale);
        if (clip) {
            const { x, y, width, height } = clip;
            const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, Math.ceil(width * scale), Math.ceil(height * scale)], false);
            try {
                pixmap.clear(255);
                const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
                try {
                    page.run(device, [scale, 0, 0, scale, -(x + x0) * scale, -(y + y0) * scale]);
                    device.close();
                } finally {
                    device.destroy();
                }
                return rgbPixmapToCanvas(pixmap);
            } finally {
                pixmap.destroy();
            }
        }
        const pixmap = page.toPixmap(
            matrix,
            mupdf.ColorSpace.DeviceRGB,
            false,
            true,
        );
        try {
            return rgbPixmapToCanvas(pixmap);
        } finally {
            pixmap.destroy();
        }
    } finally {
        page.destroy();
    }
}
