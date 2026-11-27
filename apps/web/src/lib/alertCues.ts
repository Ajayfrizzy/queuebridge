import { cuesFor, detectCueSupport, type A11yPrefs } from './a11yPrefs.js';

/**
 * The non-visual cues of an alert. Only called from a user gesture or, in M5.4, from a
 * server-confirmed turn alert, and only for the cues {@link cuesFor} allows.
 *
 *  - The tone is short (about a third of a second), plays ONCE and never loops.
 *  - The vibration is a single short pulse, under one second, foreground only (the page must be
 *    visible; browsers ignore it otherwise).
 * Neither can fail the caller: unsupported or blocked cues are skipped and reported.
 */
export const TONE_MS = 350;
export const VIBRATION_PATTERN: readonly number[] = [200, 100, 200];

type AudioCtor = new () => AudioContext;

export function playTone(): boolean {
  try {
    const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return false;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    // Fade in and out so the tone never clicks; never above a moderate level
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + TONE_MS / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + TONE_MS / 1000);
    osc.onended = (): void => void ctx.close().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export function vibrate(): boolean {
  try {
    return typeof navigator.vibrate === 'function' && navigator.vibrate([...VIBRATION_PATTERN]);
  } catch {
    return false;
  }
}

export interface TestAlertResult {
  /** Plain-language account of what ran, for the banner and the screen-reader announcement */
  summary: string;
  sound: boolean;
  vibration: boolean;
}

/** "Test alert": runs only the cues that are enabled, supported and not silenced. */
export function runTestAlert(prefs: A11yPrefs): TestAlertResult {
  const cues = cuesFor(prefs, detectCueSupport());
  const sound = cues.sound ? playTone() : false;
  const vibration = cues.vibration ? vibrate() : false;
  const parts = ['Test alert: the visual alert is shown'];
  if (sound) parts.push('a short sound played');
  if (vibration) parts.push('the device vibrated');
  if (!sound && !vibration) {
    parts.push(
      prefs.quiet
        ? 'quiet mode is on, so no sound or vibration was used'
        : 'no sound or vibration is switched on',
    );
  }
  return { summary: `${parts.join(', ')}.`, sound, vibration };
}
