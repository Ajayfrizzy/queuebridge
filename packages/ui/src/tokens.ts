/**
 * QueueBridge design tokens (M7.1; design §14, ADR-014, docs/design/QUEUEBRIDGE-DESIGN-SYSTEM.md).
 *
 * The single typed source for colour roles, type scale, spacing, radii, elevation and motion.
 * `tokensToCss()` renders them as semantic CSS custom properties (`--qb-*`); the web app keeps
 * the generated file `apps/web/src/tokens.css` and a test fails if it drifts from this source.
 *
 * Colour anchors approved by the product owner: navy #102A43, blue #2563EB, teal #0D9488. They
 * are anchors, not automatically safe pairs: every foreground/background pair a screen uses is
 * listed in `CONTRAST_PAIRS` and measured (WCAG 2.2 AA: 4.5:1 text, 3:1 large text and UI parts).
 */

export const BRAND = {
  navy: '#102a43',
  blue: '#2563eb',
  teal: '#0d9488',
} as const;

/** Semantic colour roles. Every theme defines every role. */
export interface ColorRoles {
  /** Page canvas */
  bg: string;
  /** Cards, panels, inputs */
  surface: string;
  /** Raised surfaces (dialogs, the Ask Que panel) */
  surfaceRaised: string;
  /** Muted fills (stats, table headers, chips) */
  surfaceMuted: string;
  text: string;
  textMuted: string;
  /** Decorative separators and card outlines (never the only cue) */
  border: string;
  /** Control boundaries (inputs, checkboxes): at least 3:1 against surface */
  borderStrong: string;
  divider: string;
  brandNavy: string;
  /** Text and icons on the navy brand surface (sidebar, display board) */
  onBrandNavy: string;
  onBrandNavyMuted: string;
  primary: string;
  primaryHover: string;
  onPrimary: string;
  /** Links and primary-coloured text on surfaces */
  link: string;
  /** Continuity accent (decorative fills and rules) */
  accent: string;
  /** Accent used as text */
  accentText: string;
  success: string;
  successBg: string;
  warning: string;
  warningBg: string;
  danger: string;
  dangerBg: string;
  onDanger: string;
  info: string;
  infoBg: string;
  focus: string;
  /** Called-state turn banner */
  calledBorder: string;
  calledBg: string;
}

export type ThemeName = 'light' | 'dark' | 'highContrast' | 'highContrastDark';

export const THEMES: Readonly<Record<ThemeName, ColorRoles>> = {
  light: {
    bg: '#f8fafc',
    surface: '#ffffff',
    surfaceRaised: '#ffffff',
    surfaceMuted: '#f1f5f9',
    text: '#172033',
    textMuted: '#475569',
    border: '#cbd5e1',
    borderStrong: '#64748b',
    divider: '#e2e8f0',
    brandNavy: BRAND.navy,
    onBrandNavy: '#ffffff',
    onBrandNavyMuted: '#cbd5e1',
    primary: BRAND.blue,
    primaryHover: '#1d4ed8',
    onPrimary: '#ffffff',
    link: '#1d4ed8',
    accent: BRAND.teal,
    accentText: '#0f766e',
    success: '#15803d',
    successBg: '#f0fdf4',
    warning: '#b45309',
    warningBg: '#fffbeb',
    danger: '#b91c1c',
    dangerBg: '#fef2f2',
    onDanger: '#ffffff',
    info: '#0369a1',
    infoBg: '#f0f9ff',
    focus: '#1d4ed8',
    calledBorder: '#15803d',
    calledBg: '#f0fdf4',
  },
  dark: {
    bg: '#0b1625',
    surface: '#102236',
    surfaceRaised: '#15304b',
    surfaceMuted: '#0f2a43',
    text: '#e6edf5',
    textMuted: '#b4c2d3',
    border: '#2c4a68',
    borderStrong: '#8aa0b8',
    divider: '#1f3a55',
    brandNavy: '#0a1c2e',
    onBrandNavy: '#ffffff',
    onBrandNavyMuted: '#b4c2d3',
    primary: '#60a5fa',
    primaryHover: '#93c5fd',
    onPrimary: '#0b1625',
    link: '#93c5fd',
    accent: '#2dd4bf',
    accentText: '#5eead4',
    success: '#4ade80',
    successBg: '#0d2b1c',
    warning: '#fbbf24',
    warningBg: '#2e2208',
    danger: '#fca5a5',
    dangerBg: '#3a1414',
    onDanger: '#0b1625',
    info: '#7dd3fc',
    infoBg: '#0c2a40',
    focus: '#fbbf24',
    calledBorder: '#4ade80',
    calledBg: '#0d2b1c',
  },
  highContrast: {
    bg: '#ffffff',
    surface: '#ffffff',
    surfaceRaised: '#ffffff',
    surfaceMuted: '#ffffff',
    text: '#000000',
    textMuted: '#000000',
    border: '#000000',
    borderStrong: '#000000',
    divider: '#000000',
    brandNavy: '#000000',
    onBrandNavy: '#ffffff',
    onBrandNavyMuted: '#ffffff',
    primary: '#00008b',
    primaryHover: '#000060',
    onPrimary: '#ffffff',
    link: '#00008b',
    accent: '#004d4d',
    accentText: '#004d4d',
    success: '#004d2e',
    successBg: '#ffffff',
    warning: '#6b2e00',
    warningBg: '#ffffff',
    danger: '#8b0000',
    dangerBg: '#ffffff',
    onDanger: '#ffffff',
    info: '#003f6b',
    infoBg: '#ffffff',
    focus: '#000000',
    calledBorder: '#000000',
    calledBg: '#ffffff',
  },
  highContrastDark: {
    bg: '#000000',
    surface: '#000000',
    surfaceRaised: '#000000',
    surfaceMuted: '#000000',
    text: '#ffffff',
    textMuted: '#ffffff',
    border: '#ffffff',
    borderStrong: '#ffffff',
    divider: '#ffffff',
    brandNavy: '#000000',
    onBrandNavy: '#ffffff',
    onBrandNavyMuted: '#ffffff',
    primary: '#9ec5ff',
    primaryHover: '#c7ddff',
    onPrimary: '#000000',
    link: '#9ec5ff',
    accent: '#7fffd4',
    accentText: '#7fffd4',
    success: '#7ee2b8',
    successBg: '#000000',
    warning: '#ffd166',
    warningBg: '#000000',
    danger: '#ffb4b4',
    dangerBg: '#000000',
    onDanger: '#000000',
    info: '#9ad8ff',
    infoBg: '#000000',
    focus: '#ffff00',
    calledBorder: '#ffffff',
    calledBg: '#000000',
  },
};

/** 4 px base spacing scale (rem, so it follows the large-text setting). */
export const SPACE = {
  '0': '0',
  '1': '0.25rem',
  '2': '0.5rem',
  '3': '0.75rem',
  '4': '1rem',
  '5': '1.5rem',
  '6': '2rem',
  '7': '3rem',
} as const;

export const RADIUS = {
  sm: '0.375rem',
  md: '0.625rem',
  lg: '0.75rem',
  xl: '1rem',
  pill: '999px',
} as const;

/** Type scale (rem; 1rem = 16 px at the default text size). */
export const TYPE = {
  familySans:
    "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  familyMono: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  /** Page title: 26 px mobile, 30 px desktop */
  pageTitle: '1.625rem',
  pageTitleDesktop: '1.875rem',
  /** Section heading: 20 px mobile, 22 px desktop */
  section: '1.25rem',
  sectionDesktop: '1.375rem',
  card: '1.125rem',
  body: '1rem',
  meta: '0.875rem',
  /** Visitor ticket identifier: 40–72 px with the viewport */
  ticket: 'clamp(2.5rem, 9vw + 1rem, 4.5rem)',
  /** Staff console current ticket */
  ticketConsole: 'clamp(2.5rem, 5vw + 1rem, 3.5rem)',
  /** Public board identifiers: read from a distance */
  boardCode: 'clamp(2.5rem, 6vw + 1rem, 7rem)',
  boardCounter: 'clamp(1.5rem, 3vw + 0.75rem, 3.5rem)',
  lineHeight: '1.5',
  lineHeightTight: '1.2',
} as const;

/** Large-text multipliers applied to the root size by the existing display preference. */
export const TEXT_SIZE_SCALE = { normal: '100%', large: '125%', xlarge: '150%' } as const;

export const SHADOW = {
  sm: '0 1px 2px rgb(15 23 42 / 0.06)',
  md: '0 1px 3px rgb(15 23 42 / 0.08), 0 4px 12px rgb(15 23 42 / 0.06)',
  lg: '0 8px 28px rgb(15 23 42 / 0.18)',
} as const;

/** Motion: short feedback and panel timings; all become 0 under reduced motion. */
export const MOTION = {
  fast: '140ms',
  panel: '200ms',
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

/** Layout sizes */
export const LAYOUT = {
  /** Minimum target for core visitor and operational controls */
  control: '2.75rem',
  controlLarge: '3.25rem',
  sidebar: '15rem',
  sidebarCollapsed: '4.5rem',
  container: '80rem',
  readable: '42rem',
} as const;

/**
 * Pairs a screen actually draws, per theme (foreground, background, minimum ratio). Measured in
 * `tokens.test.ts`; rendered screens are additionally checked by axe in Playwright.
 */
export const CONTRAST_PAIRS: ReadonlyArray<
  readonly [fg: keyof ColorRoles, bg: keyof ColorRoles, min: number]
> = [
  ['text', 'bg', 4.5],
  ['text', 'surface', 4.5],
  ['text', 'surfaceMuted', 4.5],
  ['text', 'surfaceRaised', 4.5],
  ['textMuted', 'bg', 4.5],
  ['textMuted', 'surface', 4.5],
  ['textMuted', 'surfaceMuted', 4.5],
  ['link', 'bg', 4.5],
  ['link', 'surface', 4.5],
  ['link', 'surfaceMuted', 4.5],
  ['onPrimary', 'primary', 4.5],
  ['onPrimary', 'primaryHover', 4.5],
  ['primary', 'surface', 4.5],
  ['onBrandNavy', 'brandNavy', 4.5],
  ['onBrandNavyMuted', 'brandNavy', 4.5],
  ['accentText', 'surface', 4.5],
  ['success', 'surface', 4.5],
  ['success', 'successBg', 4.5],
  ['warning', 'surface', 4.5],
  ['warning', 'warningBg', 4.5],
  ['danger', 'surface', 4.5],
  ['danger', 'dangerBg', 4.5],
  ['onDanger', 'danger', 4.5],
  ['info', 'surface', 4.5],
  ['info', 'infoBg', 4.5],
  ['text', 'successBg', 4.5],
  ['text', 'warningBg', 4.5],
  ['text', 'dangerBg', 4.5],
  ['text', 'infoBg', 4.5],
  ['text', 'calledBg', 4.5],
  // UI components and focus indicators: 3:1
  ['borderStrong', 'surface', 3],
  ['borderStrong', 'bg', 3],
  ['focus', 'bg', 3],
  ['focus', 'surface', 3],
  ['calledBorder', 'calledBg', 3],
  ['primary', 'bg', 3],
  ['accent', 'surface', 3],
];

// ---------------------------------------------------------------------------------------------

/** WCAG 2.x relative luminance of `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m?.[1]) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
}

/** WCAG contrast ratio of two `#rrggbb` colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The select chevron, drawn in the theme's text colour (data URI; no network request). */
function selectArrow(color: string): string {
  const stroke = encodeURIComponent(color);
  return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 6l4.5 4.5L12.5 6' fill='none' stroke='${stroke}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;
}

function colorBlock(roles: ColorRoles, indent: string, scheme: 'light' | 'dark'): string {
  const lines = (Object.keys(roles) as (keyof ColorRoles)[]).map(
    (k) => `${indent}--qb-color-${kebab(k)}: ${roles[k]};`,
  );
  lines.push(`${indent}--qb-select-arrow: ${selectArrow(roles.text)};`);
  lines.push(`${indent}color-scheme: ${scheme};`);
  return lines.join('\n');
}

/**
 * Render every token as CSS custom properties. Theme selection (M7.2 adds the explicit theme):
 *
 * - Light or dark: the device preference `html[data-theme='light'|'dark']` wins; with `system`
 *   (or no attribute) `prefers-color-scheme` decides.
 * - High contrast: the explicit device preference `html[data-contrast='high']`, or the operating
 *   system's `prefers-contrast: more` while the preference is `system`; it uses the light or the
 *   dark high-contrast set according to the theme rule above.
 * - Forced-colours mode is left to the browser.
 *
 * Rules of equal specificity are ordered so that later ones win; more specific combinations
 * (theme + contrast) carry more attribute selectors.
 */
export function tokensToCss(): string {
  const scalar: string[] = [];
  for (const [k, v] of Object.entries(BRAND)) scalar.push(`  --qb-brand-${kebab(k)}: ${v};`);
  for (const [k, v] of Object.entries(SPACE)) scalar.push(`  --qb-space-${k}: ${v};`);
  for (const [k, v] of Object.entries(RADIUS)) scalar.push(`  --qb-radius-${k}: ${v};`);
  for (const [k, v] of Object.entries(TYPE)) scalar.push(`  --qb-font-${kebab(k)}: ${v};`);
  for (const [k, v] of Object.entries(SHADOW)) scalar.push(`  --qb-shadow-${k}: ${v};`);
  scalar.push(`  --qb-duration-fast: ${MOTION.fast};`);
  scalar.push(`  --qb-duration-panel: ${MOTION.panel};`);
  scalar.push(`  --qb-easing: ${MOTION.easing};`);
  for (const [k, v] of Object.entries(LAYOUT)) scalar.push(`  --qb-size-${kebab(k)}: ${v};`);
  const out = [
    '/* GENERATED from packages/ui/src/tokens.ts by `pnpm --filter @queuebridge/ui tokens:css`.',
    '   Do not edit by hand: apps/web/src/tokens.test.ts fails if this file drifts. */',
    ':root {',
    ...scalar,
    colorBlock(THEMES.light, '  ', 'light'),
    '}',
    // dark: the system, unless the person chose light; or the person chose dark
    '@media (prefers-color-scheme: dark) {',
    "  html:not([data-theme='light']) {",
    colorBlock(THEMES.dark, '    ', 'dark'),
    '  }',
    '}',
    "html[data-theme='dark'] {",
    colorBlock(THEMES.dark, '  ', 'dark'),
    '}',
    // high contrast from the operating system (device preference left at `system`)
    '@media (prefers-contrast: more) {',
    "  html:not([data-contrast='high']) {",
    colorBlock(THEMES.highContrast, '    ', 'light'),
    '  }',
    "  html[data-theme='dark']:not([data-contrast='high']) {",
    colorBlock(THEMES.highContrastDark, '    ', 'dark'),
    '  }',
    '}',
    '@media (prefers-contrast: more) and (prefers-color-scheme: dark) {',
    "  html:not([data-theme='light']):not([data-contrast='high']) {",
    colorBlock(THEMES.highContrastDark, '    ', 'dark'),
    '  }',
    '}',
    // high contrast chosen on the device
    "html[data-contrast='high'] {",
    colorBlock(THEMES.highContrast, '  ', 'light'),
    '}',
    "html[data-contrast='high'][data-theme='dark'] {",
    colorBlock(THEMES.highContrastDark, '  ', 'dark'),
    '}',
    '@media (prefers-color-scheme: dark) {',
    "  html[data-contrast='high']:not([data-theme='light']) {",
    colorBlock(THEMES.highContrastDark, '    ', 'dark'),
    '  }',
    '}',
    "html[data-text-size='large'] {",
    `  font-size: ${TEXT_SIZE_SCALE.large};`,
    '}',
    "html[data-text-size='xlarge'] {",
    `  font-size: ${TEXT_SIZE_SCALE.xlarge};`,
    '}',
    '@media (prefers-reduced-motion: reduce) {',
    '  :root {',
    '    --qb-duration-fast: 0ms;',
    '    --qb-duration-panel: 0ms;',
    '  }',
    '}',
    "html[data-motion='reduce'] {",
    '  --qb-duration-fast: 0ms;',
    '  --qb-duration-panel: 0ms;',
    '}',
    '',
  ];
  return out.join('\n');
}
