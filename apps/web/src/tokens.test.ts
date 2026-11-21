import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tokensToCss } from '@queuebridge/ui';

/**
 * M7.1: the token source in packages/ui is authoritative. The stylesheet the app loads is the
 * generated `tokens.css`, and the hand-written `styles.css` uses only semantic `--qb-*`
 * properties: no page re-declares raw colours.
 */
const read = (f: string): string => readFileSync(new URL(f, import.meta.url), 'utf8');

describe('design tokens in the web app', () => {
  it('tokens.css is exactly the generated output (run `pnpm --filter @queuebridge/ui tokens:css`)', () => {
    expect(read('./tokens.css')).toBe(tokensToCss());
  });

  it('styles.css contains no raw colour values outside the documented exceptions', () => {
    const css = read('./styles.css')
      // comments may mention colours
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // Allowed: translucent black/white scrims and overlays (theme-neutral), and #fff for the QR
    // code and the logo tile, which stay dark-on-white for scanners and the supplied artwork.
    const raw =
      css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\((?!\s*(?:0 0 0|255 255 255) \/)[^)]*\)/g) ?? [];
    expect(raw.filter((c) => c.toLowerCase() !== '#fff')).toEqual([]);
  });

  it('the app loads the tokens before its own styles', () => {
    const main = read('./main.tsx');
    expect(main.indexOf('./tokens.css')).toBeGreaterThan(-1);
    expect(main.indexOf('./tokens.css')).toBeLessThan(main.indexOf('./styles.css'));
  });
});
