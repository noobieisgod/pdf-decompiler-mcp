export let createCanvas = null;
try {
    const canvasModule = await import('@napi-rs/canvas');
    createCanvas = canvasModule.createCanvas ?? canvasModule.default?.createCanvas ?? null;
    if (canvasModule.DOMMatrix) {
        globalThis.DOMMatrix = canvasModule.DOMMatrix;
    }
    if (canvasModule.Path2D) {
        globalThis.Path2D = canvasModule.Path2D;
    }
    if (canvasModule.ImageData) {
        globalThis.ImageData = canvasModule.ImageData;
    }
    if (canvasModule.Image) {
        globalThis.Image = canvasModule.Image;
    }
    globalThis.createImageBitmap = async function createImageBitmapCompat(source) {
        const width = source?.width ?? source?.naturalWidth ?? 1;
        const height = source?.height ?? source?.naturalHeight ?? 1;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        try {
            if (source instanceof globalThis.ImageData) {
                ctx.putImageData(source, 0, 0);
            } else {
                const raw = source?.data ?? source?.rgba;
                if (raw && raw.length > 0) {
                    const bytes = raw instanceof Uint8ClampedArray ? raw : new Uint8ClampedArray(raw.buffer ?? raw);
                    ctx.putImageData(new globalThis.ImageData(bytes, width, height), 0, 0);
                }
            }
        } catch {
        }
        return canvas;
    };
} catch {
}

export function fillCanvasWhite(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    return ctx;
}

export function scaleCanvas(canvas, maxImageDim) {
    if (!maxImageDim || Math.max(canvas.width, canvas.height) <= maxImageDim) {
        return canvas;
    }
    const scale = maxImageDim / Math.max(canvas.width, canvas.height);
    const width = Math.max(1, Math.round(canvas.width * scale));
    const height = Math.max(1, Math.round(canvas.height * scale));
    const scaled = createCanvas(width, height);
    fillCanvasWhite(scaled);
    scaled.getContext('2d').drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, width, height);
    return scaled;
}
