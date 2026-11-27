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

export { qrPath, QUIET_ZONE, qrSvgDocument } from './qrSvg.js';
