import { readSync } from 'node:fs';

export function readPdfFromStdin(length) {
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < bytes.length) {
        const bytesRead = readSync(0, bytes, offset, bytes.length - offset, null);
        if (!bytesRead) throw new Error('The PDF input was truncated during transfer');
        offset += bytesRead;
    }
    return bytes;
}
