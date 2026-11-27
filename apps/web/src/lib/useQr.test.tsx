// @vitest-environment jsdom
import type * as encoder from './qr.js';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { useQr } from './useQr.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it.each([true, false])(
  'keeps text available during QR loading and reports completion (success=%s)',
  async (success) => {
    type Encoder = typeof encoder;
    let finish!: (encoder: Encoder) => void;
    let fail!: (e: Error) => void;
    const pending = new Promise<Encoder>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const load = (): Promise<Encoder> => pending;
    function Panel(): ReactElement {
      const { matrix, feedback } = useQr('fixture', load);
      return (
        <>
          <span>Recovery text</span>
          {feedback}
          {matrix && <span>QR ready</span>}
        </>
      );
    }
    const element = document.createElement('div');
    const root = createRoot(element);
    try {
      await act(async () => root.render(<Panel />));
      expect(element.textContent).toContain('Recovery text');
      expect(element.querySelector('[role=status]')?.textContent).toContain('Preparing');
      await act(async () => {
        if (success) finish(await import('./qr.js'));
        else fail(new Error('offline'));
      });
      expect(element.textContent).toContain('Recovery text');
      if (success) expect(element.textContent).toContain('QR ready');
      else expect(element.querySelector('[role=alert]')?.textContent).toContain('unavailable');
    } finally {
      act(() => root.unmount());
    }
  },
);
