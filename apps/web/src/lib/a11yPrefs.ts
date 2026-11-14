/**
 * Device-local display and alert preferences (REQ-F7.10, REQ-F7.15; design §16.2).
 *
 * Stored ONLY in this browser (`localStorage`, key `qb.a11y.v1`). They contain no personal data,
 * are never sent to the server and never enter the offline outbox. They work offline because they
 * need nothing but the device. Unknown or corrupted stored values fall back to the defaults
 * field by field; a storage failure (private mode, quota) never breaks the app: the preferences
 * then last for the page session.
 */
export const A11Y_KEY = 'qb.a11y.v1';

export const CONTRAST = ['system', 'high'] as const;
export const TEXT_SIZE = ['normal', 'large', 'xlarge'] as const;
export const MOTION = ['system', 'reduce'] as const;

export type Contrast = (typeof CONTRAST)[number];
export type TextSize = (typeof TEXT_SIZE)[number];
export type Motion = (typeof MOTION)[number];

export interface A11yPrefs {
  /** `system` follows `prefers-contrast`; `high` always uses the high-contrast palette */
  contrast: Contrast;
  /** Root text size: 100 % / 125 % / 150 % */
  textSize: TextSize;
  /** `system` follows `prefers-reduced-motion`; `reduce` always removes animation */
  motion: Motion;
  /** Visual-only alerts: switches every non-visual cue off, whatever the two flags below say */
  quiet: boolean;
  /** Short tone when a turn alert plays (M5.4). OFF by default */
  sound: boolean;
  /** Short vibration when a turn alert plays in the foreground (M5.4), where supported */
  vibration: boolean;
}

export const DEFAULT_PREFS: Readonly<A11yPrefs> = Object.freeze({
  contrast: 'system',
  textSize: 'normal',
  motion: 'system',
  quiet: false,
  sound: false,
  vibration: true,
});

const pick = <T extends string>(allowed: readonly T[], v: unknown, fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** Validate unknown stored data into a complete preferences object (never throws). */
export function parsePrefs(raw: unknown): A11yPrefs {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    contrast: pick(CONTRAST, o['contrast'], DEFAULT_PREFS.contrast),
    textSize: pick(TEXT_SIZE, o['textSize'], DEFAULT_PREFS.textSize),
    motion: pick(MOTION, o['motion'], DEFAULT_PREFS.motion),
    quiet: bool(o['quiet'], DEFAULT_PREFS.quiet),
    sound: bool(o['sound'], DEFAULT_PREFS.sound),
    vibration: bool(o['vibration'], DEFAULT_PREFS.vibration),
  };
}

/** In-page copy for the case where storage cannot be written. */
let volatile: A11yPrefs | null = null;

export function loadPrefs(): A11yPrefs {
  try {
    const raw = window.localStorage.getItem(A11Y_KEY);
    if (raw === null) return volatile ?? { ...DEFAULT_PREFS };
    return parsePrefs(JSON.parse(raw));
  } catch {
    return volatile ?? { ...DEFAULT_PREFS };
  }
}

/** Persist; returns false when the device could not store them (they still apply this session). */
export function savePrefs(prefs: A11yPrefs): boolean {
  volatile = prefs;
  try {
    window.localStorage.setItem(A11Y_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

/** Remove the stored copy entirely (Reset to defaults). */
export function clearPrefs(): void {
  volatile = null;
  try {
    window.localStorage.removeItem(A11Y_KEY);
  } catch {
    // nothing stored, nothing to clear
  }
}

/** Express the preferences as `data-*` attributes on `<html>` (the CSS reads only these). */
export function applyPrefs(prefs: A11yPrefs, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-contrast', prefs.contrast);
  root.setAttribute('data-text-size', prefs.textSize);
  root.setAttribute('data-motion', prefs.motion);
  root.setAttribute('data-quiet', prefs.quiet ? 'true' : 'false');
}

/** Called before React renders, so the first paint already has the person's settings. */
export function applyStoredPrefs(): A11yPrefs {
  const prefs = loadPrefs();
  applyPrefs(prefs);
  return prefs;
}

/** What this device can do. Controls the device cannot honour are shown disabled, with a reason. */
export interface CueSupport {
  vibration: boolean;
  sound: boolean;
}
export function detectCueSupport(): CueSupport {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const w =
    typeof window === 'undefined' ? undefined : (window as unknown as Record<string, unknown>);
  return {
    vibration: Boolean(nav && 'vibrate' in nav && typeof nav.vibrate === 'function'),
    sound: Boolean(w && (w['AudioContext'] ?? w['webkitAudioContext'])),
  };
}

/**
 * Which cues may run for an alert. The visual banner and its screen-reader text are ALWAYS on
 * (they are the reliable channel, REQ-F14); sound and vibration are extras that the person
 * chose, that the device supports, and that quiet mode has not silenced. Shared with the M5.4
 * turn alerts so the rule exists in exactly one place.
 */
export interface Cues {
  visual: true;
  sound: boolean;
  vibration: boolean;
}
export function cuesFor(prefs: A11yPrefs, support: CueSupport): Cues {
  const loud = !prefs.quiet;
  return {
    visual: true,
    sound: loud && prefs.sound && support.sound,
    vibration: loud && prefs.vibration && support.vibration,
  };
}
