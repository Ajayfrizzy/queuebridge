import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { buildQr, QUIET_ZONE, qrPath, qrSvgDocument } from './qr.js';

/** Rasterize the matrix (with quiet zone) into RGBA so a real QR decoder can read it back. */
function rasterize(text: string, scale = 6): { data: Uint8ClampedArray; width: number } {
  const m = buildQr(text);
  const width = (m.size + QUIET_ZONE * 2) * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.modules[y]?.[x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (x + QUIET_ZONE) * scale + dx;
          const py = (y + QUIET_ZONE) * scale + dy;
          const i = (py * width + px) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width };
}

describe('facility QR code', () => {
  it('decodes back to exactly the join link (real decoder round-trip)', () => {
    const url = 'http://localhost:5173/join/acme-health/main-clinic';
    const { data, width } = rasterize(url);
    const decoded = jsQR(data, width, width);
    expect(decoded?.data).toBe(url);
  });

  it('round-trips a long https URL too', () => {
    const url =
      'https://queues.example.org/join/a-very-long-organization-slug/a-very-long-facility-slug-name';
    const { data, width } = rasterize(url, 5);
    expect(jsQR(data, width, width)?.data).toBe(url);
  });

  it('produces a square matrix and a non-empty path', () => {
    const m = buildQr('hello');
    expect(m.modules).toHaveLength(m.size);
    expect(m.modules.every((r) => r.length === m.size)).toBe(true);
    expect(qrPath(m).startsWith('M')).toBe(true);
  });

  it('escapes the title in the downloadable SVG', () => {
    const svg = qrSvgDocument(buildQr('x'), '<script>alert(1)</script>');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&#60;script&#62;');
  });
});
