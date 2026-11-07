import QRCode from 'qrcode';

export interface QrMatrix {
  size: number;
  /** modules[y][x] is true for a dark module */
  modules: boolean[][];
}

/** Encode text as a QR matrix (error correction M). Pure and synchronous. */
export function buildQr(text: string): QrMatrix {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const modules: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) row.push(qr.modules.get(x, y) === 1);
    modules.push(row);
  }
  return { size, modules };
}

/** SVG path data drawing every dark module as a 1×1 square (quiet zone excluded). */
export function qrPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (matrix.modules[y]?.[x]) parts.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  return parts.join('');
}

export const QUIET_ZONE = 4;

/** Standalone SVG document for download/printing. `title` is XML-escaped. */
export function qrSvgDocument(matrix: QrMatrix, title: string): string {
  const total = matrix.size + QUIET_ZONE * 2;
  const safeTitle = title.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="512" height="512" role="img">` +
    `<title>${safeTitle}</title><rect width="${total}" height="${total}" fill="#fff"/>` +
    `<path transform="translate(${QUIET_ZONE} ${QUIET_ZONE})" fill="#000" d="${qrPath(matrix)}"/></svg>`
  );
}
