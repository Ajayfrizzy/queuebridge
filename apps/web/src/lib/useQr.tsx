import type * as encoder from './qr.js';
import { useEffect, useState, type ReactElement } from 'react';
import type { QrMatrix } from './qr.js';

const loadEncoder = (): Promise<typeof encoder> => import('./qr.js');

export function useQr(
  text: string | null,
  load = loadEncoder,
): {
  matrix: QrMatrix | null;
  feedback: ReactElement | null;
} {
  const [result, setResult] = useState<{ text: string; matrix: QrMatrix | null } | null>(null);
  useEffect(() => {
    let active = true;
    setResult(null);
    if (text) {
      void load()
        .then(({ buildQr }) => buildQr(text))
        .then(
          (matrix) => {
            if (active) setResult({ text, matrix });
          },
          () => {
            if (active) setResult({ text, matrix: null });
          },
        );
    }
    return () => {
      active = false;
    };
  }, [text, load]);
  const current = result?.text === text ? result : null;
  const feedback =
    !text || current?.matrix ? null : current ? (
      <p role="alert">QR code unavailable.</p>
    ) : (
      <p role="status">Preparing QR code…</p>
    );
  return { matrix: current?.matrix ?? null, feedback };
}
