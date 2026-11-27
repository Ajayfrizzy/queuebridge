import { describe, expect, it } from 'vitest';
import {
  BRAND,
  CONTRAST_PAIRS,
  THEMES,
  TYPE,
  contrastRatio,
  tokensToCss,
  type ThemeName,
} from './tokens.js';

describe('design tokens (M7.1)', () => {
  it('keeps the approved brand anchors', () => {
    expect(BRAND).toEqual({ navy: '#102a43', blue: '#2563eb', teal: '#0d9488' });
    expect(THEMES.light.brandNavy).toBe(BRAND.navy);
    expect(THEMES.light.primary).toBe(BRAND.blue);
    expect(THEMES.light.accent).toBe(BRAND.teal);
  });

  it('every theme defines every role as #rrggbb', () => {
    const roles = Object.keys(THEMES.light).sort();
    for (const [name, theme] of Object.entries(THEMES)) {
      expect(Object.keys(theme).sort(), name).toEqual(roles);
      for (const [role, v] of Object.entries(theme))
        expect(v, `${name}.${role}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it.each(Object.keys(THEMES) as ThemeName[])(
    '%s: every drawn pair meets its WCAG minimum',
    (name) => {
      const t = THEMES[name];
      const failures = CONTRAST_PAIRS.filter(
        ([fg, bg, min]) => contrastRatio(t[fg], t[bg]) < min,
      ).map(
        ([fg, bg, min]) => `${fg} on ${bg}: ${contrastRatio(t[fg], t[bg]).toFixed(2)} < ${min}`,
      );
      expect(failures).toEqual([]);
    },
  );

  it('high contrast reaches 7:1 for text and keeps black/white borders', () => {
    for (const name of ['highContrast', 'highContrastDark'] as const) {
      const t = THEMES[name];
      expect(contrastRatio(t.text, t.bg)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(t.textMuted, t.bg)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(t.link, t.bg)).toBeGreaterThanOrEqual(7);
      expect([t.border, t.borderStrong]).toEqual(
        name === 'highContrast' ? ['#000000', '#000000'] : ['#ffffff', '#ffffff'],
      );
    }
  });

  it('status colours stay distinct from the brand accent (a warning never looks like success)', () => {
    for (const t of Object.values(THEMES)) {
      expect(new Set([t.success, t.warning, t.danger]).size).toBe(3);
    }
  });

  it('the logo backing on navy (on-brand-navy) stays white in every theme', () => {
    // The supplied logo artwork has a light ground; the landing hero relies on this token
    for (const t of Object.values(THEMES)) expect(t.onBrandNavy).toBe('#ffffff');
  });

  it('contrast helper matches known values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('the type scale follows the approved hierarchy (rem, so large text scales it)', () => {
    expect(TYPE.pageTitleDesktop).toBe('1.875rem'); // 30 px
    expect(TYPE.pageTitle).toBe('1.625rem'); // 26 px
    expect(TYPE.sectionDesktop).toBe('1.375rem'); // 22 px
    expect(TYPE.section).toBe('1.25rem'); // 20 px
    expect(TYPE.card).toBe('1.125rem'); // 18 px
    expect(TYPE.body).toBe('1rem');
    expect(TYPE.meta).toBe('0.875rem');
    expect(TYPE.familySans).not.toMatch(/url\(|https?:/);
  });

  it('the CSS output covers every theme, reduced motion and text size, with no network URL', () => {
    const css = tokensToCss();
    expect(css).toContain("html[data-contrast='high']");
    // M7.2: explicit theme beats the system setting, in both directions
    expect(css).toContain("html[data-theme='dark'] {");
    expect(css).toContain("html:not([data-theme='light'])");
    expect(css).toContain("html[data-contrast='high'][data-theme='dark']");
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain('prefers-contrast: more');
    expect(css).toContain("html[data-motion='reduce']");
    expect(css).toContain("html[data-text-size='xlarge']");
    expect(css).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  });
});
