import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A11Y_KEY,
  DEFAULT_PREFS,
  applyPrefs,
  applyStoredPrefs,
  clearPrefs,
  cuesFor,
  loadPrefs,
  parsePrefs,
  savePrefs,
} from './a11yPrefs.js';

describe('device-local accessibility preferences (11.A4)', () => {
  beforeEach(() => {
    localStorage.clear();
    clearPrefs();
    document.documentElement.removeAttribute('data-contrast');
  });
  afterEach(() => vi.restoreAllMocks());

  it('defaults: follow the system, normal size, sound OFF, vibration on, not quiet', () => {
    expect(loadPrefs()).toEqual({
      theme: 'system',
      contrast: 'system',
      textSize: 'normal',
      motion: 'system',
      quiet: false,
      sound: false,
      vibration: true,
    });
  });

  it('round-trips and applies as data attributes before any rendering', () => {
    savePrefs({
      ...DEFAULT_PREFS,
      theme: 'light',
      contrast: 'high',
      textSize: 'xlarge',
      motion: 'reduce',
      quiet: true,
    });
    const applied = applyStoredPrefs();
    expect(applied.contrast).toBe('high');
    const root = document.documentElement;
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.getAttribute('data-contrast')).toBe('high');
    expect(root.getAttribute('data-text-size')).toBe('xlarge');
    expect(root.getAttribute('data-motion')).toBe('reduce');
    expect(root.getAttribute('data-quiet')).toBe('true');
  });

  it('corrupted or hostile stored values fall back field by field, never throw', () => {
    localStorage.setItem(A11Y_KEY, '{not json');
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    expect(
      parsePrefs({ contrast: 'neon', textSize: 'large', motion: 7, quiet: 'yes', sound: true }),
    ).toEqual({ ...DEFAULT_PREFS, textSize: 'large', sound: true });
    expect(parsePrefs({ theme: 'sepia' }).theme).toBe('system');
    expect(parsePrefs({ theme: 'dark' }).theme).toBe('dark');
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('high')).toEqual(DEFAULT_PREFS);
  });

  it('holds no personal data: only the seven display and alert fields are stored', () => {
    savePrefs({ ...DEFAULT_PREFS, contrast: 'high' });
    const stored = JSON.parse(localStorage.getItem(A11Y_KEY) ?? '{}') as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(
      ['contrast', 'motion', 'quiet', 'sound', 'textSize', 'theme', 'vibration'].sort(),
    );
  });

  it('a device that cannot store them still applies them for this page session', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(savePrefs({ ...DEFAULT_PREFS, textSize: 'large' })).toBe(false);
    expect(loadPrefs().textSize).toBe('large');
  });

  it('reset removes the stored copy', () => {
    savePrefs({ ...DEFAULT_PREFS, contrast: 'high' });
    clearPrefs();
    expect(localStorage.getItem(A11Y_KEY)).toBeNull();
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('applyPrefs touches only data attributes', () => {
    const el = document.createElement('div');
    applyPrefs({ ...DEFAULT_PREFS, quiet: true }, el);
    expect(el.getAttributeNames().sort()).toEqual(
      ['data-contrast', 'data-motion', 'data-quiet', 'data-text-size', 'data-theme'].sort(),
    );
  });
});

describe('which alert cues may run (11.A7; shared with M5.4)', () => {
  const both = { sound: true, vibration: true };
  it('the visual alert is always on', () => {
    for (const quiet of [true, false]) {
      expect(cuesFor({ ...DEFAULT_PREFS, quiet }, { sound: false, vibration: false }).visual).toBe(
        true,
      );
    }
  });
  it('sound is off by default even where supported', () => {
    expect(cuesFor(DEFAULT_PREFS, both)).toEqual({ visual: true, sound: false, vibration: true });
  });
  it('quiet mode silences every non-visual cue, whatever else is chosen', () => {
    expect(cuesFor({ ...DEFAULT_PREFS, quiet: true, sound: true, vibration: true }, both)).toEqual({
      visual: true,
      sound: false,
      vibration: false,
    });
  });
  it('an unsupported cue never runs, even when chosen', () => {
    expect(
      cuesFor(
        { ...DEFAULT_PREFS, sound: true, vibration: true },
        { sound: false, vibration: false },
      ),
    ).toEqual({ visual: true, sound: false, vibration: false });
  });
});
