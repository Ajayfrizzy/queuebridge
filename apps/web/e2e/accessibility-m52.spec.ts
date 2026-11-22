import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { uuidv7 } from '@queuebridge/contracts';
import {
  apiQueueSetup,
  expectNoA11yViolations,
  hasHorizontalOverflow,
  type QueueSetup,
} from './helpers.js';
import { goOffline, makeStaff } from './offline-helpers.js';

/**
 * M5.2 accessibility (testing steering Group 11: 11.A1–11.A9). Automated checks plus keyboard-only
 * journeys against the real stack. They do NOT establish WCAG conformance: screen-reader, real
 * device and expert review remain manual (docs/testing/M5-evidence.md).
 */
const CSRF = { 'X-QB-CSRF': '1' };
const PREFS_KEY = 'qb.a11y.v1';
type Setup = QueueSetup & { queueId: string | null };

interface PrefsInit {
  contrast?: 'system' | 'high';
  textSize?: 'normal' | 'large' | 'xlarge';
  motion?: 'system' | 'reduce';
  quiet?: boolean;
  sound?: boolean;
  vibration?: boolean;
}

/** A visitor device, optionally with stored preferences and stubbed vibration/audio. */
async function visitorContext(
  browser: Browser,
  opts: {
    prefs?: PrefsInit;
    vibration?: 'stub' | 'unsupported' | 'native';
    audio?: 'stub' | 'native';
  } = {},
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.addInitScript(
    ({ key, prefs, vibration, audio }) => {
      const w = window as unknown as Record<string, unknown>;
      // Seed once: later in-page changes must survive reloads
      if (prefs && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(prefs));
      w['__vib'] = [] as unknown[];
      if (vibration === 'stub') {
        Object.defineProperty(Navigator.prototype, 'vibrate', {
          configurable: true,
          value: (p: unknown): boolean => {
            (w['__vib'] as unknown[]).push(p);
            return true;
          },
        });
      } else if (vibration === 'unsupported') {
        delete (Navigator.prototype as unknown as Record<string, unknown>)['vibrate'];
      }
      w['__audio'] = { contexts: 0, started: 0, stopped: 0 };
      if (audio === 'stub') {
        const counters = w['__audio'] as { contexts: number; started: number; stopped: number };
        const param = {
          value: 0,
          setValueAtTime: (): void => undefined,
          exponentialRampToValueAtTime: (): void => undefined,
        };
        w['AudioContext'] = class {
          public currentTime = 0;
          public destination = {};
          public constructor() {
            counters.contexts += 1;
          }
          public createOscillator(): unknown {
            const node: Record<string, unknown> = {
              type: 'sine',
              frequency: { value: 0 },
              connect: (n: unknown) => n,
              start: (): void => {
                counters.started += 1;
              },
              stop: (): void => {
                counters.stopped += 1;
              },
              onended: null,
            };
            return node;
          }
          public createGain(): unknown {
            return { gain: param, connect: (n: unknown) => n };
          }
          public close(): Promise<void> {
            return Promise.resolve();
          }
        };
      }
      // Record the display attributes at the moment the app first renders anything
      const root = (): HTMLElement | null => document.getElementById('root');
      const record = (): void => {
        const r = root();
        if (r && r.childNodes.length > 0 && !w['__first']) {
          const h = document.documentElement;
          w['__first'] = {
            contrast: h.getAttribute('data-contrast'),
            text: h.getAttribute('data-text-size'),
            motion: h.getAttribute('data-motion'),
          };
        }
      };
      new MutationObserver(record).observe(document, { childList: true, subtree: true });
    },
    {
      key: PREFS_KEY,
      prefs: opts.prefs
        ? {
            contrast: 'system',
            textSize: 'normal',
            motion: 'system',
            quiet: false,
            sound: false,
            vibration: true,
            ...opts.prefs,
          }
        : null,
      vibration: opts.vibration ?? 'native',
      audio: opts.audio ?? 'native',
    },
  );
  return { ctx, page: await ctx.newPage() };
}

async function joinAsVisitor(page: Page, s: Setup): Promise<string> {
  await page.goto(s.joinPath);
  await page.getByRole('button', { name: /Get a ticket/ }).click();
  await expect(page.getByTestId('ticket-code')).toBeVisible();
  return (await page.getByTestId('ticket-code').innerText()).trim();
}

async function command(page: Page, queueId: string, body: Record<string, unknown>): Promise<void> {
  const r = await page.request.post(`/api/v1/queues/${queueId}/commands`, {
    headers: CSRF,
    data: { operation_id: uuidv7(), ...body },
  });
  expect(r.status(), await r.text()).toBe(200);
}

async function walkIns(page: Page, queueId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const r = await page.request.post(`/api/v1/queues/${queueId}/walk-ins`, {
      headers: CSRF,
      data: { operation_id: uuidv7() },
    });
    expect(r.status()).toBe(201);
  }
}

async function ticketIdOf(page: Page, queueId: string, code: string): Promise<string> {
  const r = await page.request.get(`/api/v1/queues/${queueId}`);
  const t = (
    (await r.json()) as { queue: { tickets: { id: string; public_code: string }[] } }
  ).queue.tickets.find((x) => x.public_code === code);
  return t?.id ?? '';
}

/** WCAG relative-luminance contrast ratio of two CSS `rgb(...)` strings. */
function ratio(a: string, b: string): number {
  const lum = (css: string): number => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
    const c = [m?.[1], m?.[2], m?.[3]].map((v) => {
      const x = Number(v) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('open-display-settings').first().click();
  await expect(page.getByTestId('display-settings')).toBeVisible();
}

// ---------------------------------------------------------------------------------------------
// 11.A4 / 11.A5 / 11.A6 — preferences
// ---------------------------------------------------------------------------------------------

test.describe('11.A4 display preferences (device-local)', () => {
  test('stored preferences are applied before the first render', async ({ browser }) => {
    const v = await visitorContext(browser, {
      prefs: { contrast: 'high', textSize: 'xlarge', motion: 'reduce' },
    });
    await v.page.goto('/');
    await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(
      await v.page.evaluate(() => (window as unknown as Record<string, unknown>)['__first']),
    ).toEqual({
      contrast: 'high',
      text: 'xlarge',
      motion: 'reduce',
    });
    expect(await v.page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
      '24px',
    );
    await v.ctx.close();
  });

  test('changes apply at once, persist across reloads, reset to defaults, and send nothing anywhere', async ({
    browser,
  }) => {
    const v = await visitorContext(browser);
    const calls: string[] = [];
    v.page.on('request', (r) => {
      if (r.url().includes('/api/')) calls.push(`${r.method()} ${r.url()}`);
    });
    await v.page.goto('/');
    await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
    await v.page.waitForLoadState('networkidle');
    const before = calls.length;
    await openSettings(v.page);
    await v.page.getByLabel('Contrast').selectOption('high');
    await v.page.getByLabel('Text size').selectOption('large');
    await v.page.getByLabel('Motion').selectOption('reduce');
    const html = v.page.locator('html');
    await expect(html).toHaveAttribute('data-contrast', 'high');
    await expect(html).toHaveAttribute('data-text-size', 'large');
    await expect(html).toHaveAttribute('data-motion', 'reduce');
    // stored on the device, seven fields (M7.2 adds the theme), nothing personal
    const stored = JSON.parse(
      (await v.page.evaluate((k) => localStorage.getItem(k), PREFS_KEY)) ?? '{}',
    );
    expect(Object.keys(stored).sort()).toEqual([
      'contrast',
      'motion',
      'quiet',
      'sound',
      'textSize',
      'theme', // M7.2
      'vibration',
    ]);
    // no request was made by changing them
    expect(calls.length).toBe(before);
    await v.page.getByRole('button', { name: 'Done' }).click();
    await v.page.reload();
    await expect(v.page.locator('html')).toHaveAttribute('data-contrast', 'high');
    await expect(v.page.locator('html')).toHaveAttribute('data-text-size', 'large');
    // reset
    await openSettings(v.page);
    await v.page.getByTestId('reset-prefs').click();
    await expect(v.page.getByTestId('settings-status')).toContainText('reset to defaults');
    await expect(v.page.locator('html')).toHaveAttribute('data-contrast', 'system');
    await expect(v.page.locator('html')).toHaveAttribute('data-text-size', 'normal');
    expect(await v.page.evaluate((k) => localStorage.getItem(k), PREFS_KEY)).toBeNull();
    await v.ctx.close();
  });

  test('they can be changed and still apply with no network at all', async ({ browser }) => {
    const v = await visitorContext(browser);
    await v.page.goto('/');
    await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
    await v.ctx.setOffline(true);
    await openSettings(v.page);
    await v.page.getByLabel('Text size').selectOption('xlarge');
    await expect(v.page.locator('html')).toHaveAttribute('data-text-size', 'xlarge');
    await v.page.keyboard.press('Escape');
    await expect(v.page.getByTestId('display-settings')).toHaveCount(0);
    expect(await v.page.evaluate((k) => localStorage.getItem(k), PREFS_KEY)).toContain('xlarge');
    await v.ctx.setOffline(false);
    await v.ctx.close();
  });

  test('another open tab follows a change made in this one', async ({ browser }) => {
    const v = await visitorContext(browser);
    await v.page.goto('/');
    const other = await v.ctx.newPage();
    await other.goto('/');
    await openSettings(v.page);
    await v.page.getByLabel('Contrast').selectOption('high');
    await expect(other.locator('html')).toHaveAttribute('data-contrast', 'high');
    await v.ctx.close();
  });
});

test.describe('11.A5 contrast and reflow', () => {
  test('high contrast gives text at least 7:1 and a visible strong border', async ({ browser }) => {
    const v = await visitorContext(browser, { prefs: { contrast: 'high' } });
    await v.page.goto('/');
    await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
    const { fg, bg, muted, border } = await v.page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      const root = getComputedStyle(document.documentElement);
      return {
        fg: cs.color,
        bg: cs.backgroundColor,
        muted: root.getPropertyValue('--muted').trim(),
        border: root.getPropertyValue('--border').trim(),
      };
    });
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(7);
    expect(muted).toBe('#000000');
    expect(border).toBe('#000000');
    await v.ctx.close();
  });

  for (const contrast of ['system', 'high'] as const) {
    test(`@responsive axe is clean on every visitor route and the settings panel (${contrast} contrast)`, async ({
      page,
      browser,
    }) => {
      const s = await apiQueueSetup(page.request);
      const v = await visitorContext(browser, { prefs: { contrast } });
      for (const path of [s.joinPath, '/recover', `/recover/${s.org.slug}/${s.facility.slug}`]) {
        await v.page.goto(path);
        await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
        await expectNoA11yViolations(v.page);
      }
      await joinAsVisitor(v.page, s);
      await expect(v.page.getByTestId('recovery-key-panel')).toBeVisible();
      await expectNoA11yViolations(v.page);
      await v.page.getByRole('button', { name: 'I have saved my key' }).click();
      await expectNoA11yViolations(v.page);
      await openSettings(v.page);
      await v.page.getByTestId('test-alert').click();
      await expect(v.page.getByTestId('test-alert-banner')).toBeVisible();
      await expectNoA11yViolations(v.page);
      expect(await hasHorizontalOverflow(v.page)).toBe(false);
      await v.ctx.close();
    });
  }

  test('@responsive extra-large text reflows: no horizontal scrolling on visitor routes and the panel', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitorContext(browser, { prefs: { textSize: 'xlarge', contrast: 'high' } });
    await v.page.goto(s.joinPath);
    await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await hasHorizontalOverflow(v.page)).toBe(false);
    await joinAsVisitor(v.page, s);
    expect(await hasHorizontalOverflow(v.page)).toBe(false);
    await v.page.getByRole('button', { name: 'I have saved my key' }).click();
    expect(await hasHorizontalOverflow(v.page)).toBe(false);
    await v.page.goto('/recover');
    expect(await hasHorizontalOverflow(v.page)).toBe(false);
    await openSettings(v.page);
    expect(await hasHorizontalOverflow(v.page)).toBe(false);
    // the dialog's own controls stay reachable: the panel scrolls inside itself, Done is reachable
    await v.page.getByRole('button', { name: 'Done' }).scrollIntoViewIfNeeded();
    await expect(v.page.getByRole('button', { name: 'Done' })).toBeVisible();
    await v.ctx.close();
  });
});

test.describe('11.A6 reduced motion', () => {
  async function probe(page: Page): Promise<{ transition: string; animation: string }> {
    // M7.2: added through the CSSOM (a constructed stylesheet), because the production CSP served
    // by the preview forbids inline <style>; the cascade, including the app's !important
    // reduced-motion rules, is the same
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(
        '@keyframes qbprobe { from { opacity: 0 } to { opacity: 1 } } #qb-probe { transition: color 1s; animation: qbprobe 1s; }',
      );
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    return page.evaluate(() => {
      const el = document.createElement('div');
      el.id = 'qb-probe';
      document.body.append(el);
      const cs = getComputedStyle(el);
      const r = { transition: cs.transitionDuration, animation: cs.animationName };
      el.remove();
      return r;
    });
  }

  test('control: with no setting, animation and transitions are possible', async ({ browser }) => {
    const v = await visitorContext(browser);
    await v.page.goto('/');
    await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
    const p = await probe(v.page);
    expect(p.transition).toBe('1s');
    expect(p.animation).toBe('qbprobe');
    await v.ctx.close();
  });

  test('the operating-system setting removes them', async ({ browser }) => {
    const v = await visitorContext(browser);
    await v.page.emulateMedia({ reducedMotion: 'reduce' });
    await v.page.goto('/');
    await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
    const p = await probe(v.page);
    expect(p.transition).toBe('0s');
    expect(p.animation).toBe('none');
    await v.ctx.close();
  });

  test('the in-app setting removes them even when the system allows motion', async ({
    browser,
  }) => {
    const v = await visitorContext(browser, { prefs: { motion: 'reduce' } });
    await v.page.emulateMedia({ reducedMotion: 'no-preference' });
    await v.page.goto('/');
    await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
    const p = await probe(v.page);
    expect(p.transition).toBe('0s');
    expect(p.animation).toBe('none');
    expect(
      await v.page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
    ).toBe('auto');
    await v.ctx.close();
  });

  test('no information is carried by motion alone, nothing flashes: the app declares no animation', async ({
    request,
  }) => {
    // The shipped stylesheet has no @keyframes and no transitions outside the reduced-motion
    // override, so nothing can flash (3 per second limit) and nothing relies on movement.
    const html = await (await request.get('/')).text();
    const href = /href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1] ?? '';
    const css = await (await request.get(href)).text();
    expect(css).not.toMatch(/@keyframes/);
    const transitions = css.match(/transition\s*:[^;}]+/g) ?? [];
    expect(transitions.filter((t) => !/none/.test(t))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 11.A7 — vibration and sound preferences (ready for M5.4; no delivery here)
// ---------------------------------------------------------------------------------------------

test.describe('11.A7 vibration and sound preferences', () => {
  test('defaults: sound OFF, vibration on where supported, quiet off; hints explain', async ({
    browser,
  }) => {
    const v = await visitorContext(browser, { vibration: 'stub', audio: 'stub' });
    await v.page.goto('/');
    await openSettings(v.page);
    await expect(v.page.getByLabel('Play a short sound')).not.toBeChecked();
    await expect(v.page.getByLabel('Vibrate')).toBeChecked();
    await expect(v.page.getByLabel('Quiet mode: visual alerts only')).not.toBeChecked();
    await expect(v.page.getByTestId('vibration-hint')).toContainText(
      'Only while this page is open',
    );
    await v.ctx.close();
  });

  test('unsupported controls are disabled with a reason, never silently dead', async ({
    browser,
  }) => {
    const v = await visitorContext(browser, { vibration: 'unsupported' });
    await v.page.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>)['AudioContext'];
      delete (window as unknown as Record<string, unknown>)['webkitAudioContext'];
    });
    await v.page.goto('/');
    await openSettings(v.page);
    await expect(v.page.getByLabel('Vibrate')).toBeDisabled();
    await expect(v.page.getByTestId('vibration-hint')).toHaveText(
      'This device or browser does not support vibration.',
    );
    await expect(v.page.getByLabel('Play a short sound')).toBeDisabled();
    await expect(v.page.getByTestId('sound-hint')).toContainText('cannot play alert sounds');
    // the explanation is programmatically associated with the control
    await expect(v.page.getByLabel('Vibrate')).toHaveAccessibleDescription(
      /does not support vibration/,
    );
    await expectNoA11yViolations(v.page);
    await v.ctx.close();
  });

  test('quiet mode switches both non-visual cues off and disables their controls', async ({
    browser,
  }) => {
    const v = await visitorContext(browser, {
      vibration: 'stub',
      audio: 'stub',
      prefs: { sound: true, vibration: true },
    });
    await v.page.goto('/');
    await openSettings(v.page);
    await expect(v.page.getByLabel('Play a short sound')).toBeChecked();
    await v.page.getByLabel('Quiet mode: visual alerts only').check();
    await expect(v.page.getByLabel('Play a short sound')).toBeDisabled();
    await expect(v.page.getByLabel('Vibrate')).toBeDisabled();
    await expect(v.page.getByLabel('Vibrate')).not.toBeChecked();
    await expect(v.page.getByTestId('sound-hint')).toContainText('quiet mode');
    await expect(v.page.locator('html')).toHaveAttribute('data-quiet', 'true');
    await v.ctx.close();
  });

  test('"Test alert" runs only the enabled cues, once, and is labelled as a test', async ({
    browser,
  }) => {
    const v = await visitorContext(browser, { vibration: 'stub', audio: 'stub' });
    await v.page.goto('/');
    await openSettings(v.page);
    const counts = (): Promise<{ vib: number; ctx: number; started: number; stopped: number }> =>
      v.page.evaluate(() => {
        const w = window as unknown as {
          __vib: unknown[];
          __audio: { contexts: number; started: number; stopped: number };
        };
        return {
          vib: w.__vib.length,
          ctx: w.__audio.contexts,
          started: w.__audio.started,
          stopped: w.__audio.stopped,
        };
      });
    // default: vibration only (sound is off)
    await v.page.getByTestId('test-alert').click();
    await expect(v.page.getByTestId('test-alert-banner')).toContainText('Test.');
    await expect(v.page.getByTestId('test-alert-banner')).toContainText('the device vibrated');
    await expect(v.page.getByTestId('settings-status')).toContainText('Test alert');
    expect(await counts()).toEqual({ vib: 1, ctx: 0, started: 0, stopped: 0 });
    // sound on: one short tone that is started and stopped once (never loops)
    await v.page.getByLabel('Play a short sound').check();
    await v.page.getByTestId('test-alert').click();
    await expect(v.page.getByTestId('test-alert-banner')).toContainText('a short sound played');
    expect(await counts()).toEqual({ vib: 2, ctx: 1, started: 1, stopped: 1 });
    // quiet: the banner still says what happened, and nothing non-visual runs
    await v.page.getByLabel('Quiet mode: visual alerts only').check();
    await v.page.getByTestId('test-alert').click();
    await expect(v.page.getByTestId('test-alert-banner')).toContainText('quiet mode is on');
    expect(await counts()).toEqual({ vib: 2, ctx: 1, started: 1, stopped: 1 });
    await v.ctx.close();
  });

  test('a real call vibrates once by default and never in quiet mode; the visual alert always shows', async ({
    page,
    browser,
  }) => {
    for (const quiet of [false, true]) {
      const s = await apiQueueSetup(page.request);
      const v = await visitorContext(browser, { vibration: 'stub', prefs: { quiet } });
      const code = await joinAsVisitor(v.page, s);
      await v.page.getByRole('button', { name: 'I have saved my key' }).click();
      await command(page, s.queueId ?? '', { action: 'ticket.call_next', counter_id: s.counterId });
      await expect(v.page.getByTestId('ticket-state')).toHaveText('Called');
      await expect(v.page.getByTestId('turn-alert')).toContainText(/your turn/i);
      await expect(v.page.getByTestId('status-message')).toContainText('Counter 1');
      const vib = await v.page.evaluate(
        () => (window as unknown as { __vib: unknown[] }).__vib.length,
      );
      expect(vib, `quiet=${quiet}`).toBe(quiet ? 0 : 1);
      expect(code).toMatch(/^[A-Z]\d{3}$/);
      await v.ctx.close();
    }
  });

  test('the settings contain no promise of background alerts or delivery', async ({ browser }) => {
    const v = await visitorContext(browser);
    await v.page.goto('/');
    await openSettings(v.page);
    const text = (await v.page.getByTestId('display-settings').innerText()).toLowerCase();
    expect(text).toContain('never promised when it is closed');
    expect(text).not.toMatch(/guarantee|will always|delivered|push|sms/);
    await v.ctx.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 11.A3 — announcement policy
// ---------------------------------------------------------------------------------------------

test.describe('11.A3 announcement policy', () => {
  test('live regions exist at page load, before any message', async ({ browser }) => {
    const v = await visitorContext(browser);
    await v.page.goto('/');
    await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
    const polite = v.page.getByTestId('status');
    const assertive = v.page.getByTestId('status-assertive');
    await expect(polite).toHaveAttribute('aria-live', 'polite');
    await expect(assertive).toHaveAttribute('aria-live', 'assertive');
    await expect(polite).toHaveText('');
    await expect(assertive).toHaveText('');
    await v.ctx.close();
  });

  test('the called alert is assertive and spoken once; position changes are rate-limited to one per 15 s', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    await walkIns(page, s.queueId ?? '', 4);
    const v = await visitorContext(browser);
    const code = await joinAsVisitor(v.page, s); // fifth in line
    await v.page.getByRole('button', { name: 'I have saved my key' }).click();
    await expect(v.page.getByTestId('ticket-position')).toContainText('5 in line');
    await v.page.evaluate(() => {
      const w = window as unknown as { __polite: string[]; __alerts: string[] };
      w.__polite = [];
      w.__alerts = [];
      const watch = (id: string, sink: string[]): void => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) throw new Error(`missing region ${id}`);
        new MutationObserver(() => {
          const t = (el.textContent ?? '').trim();
          if (t) sink.push(t);
        }).observe(el, { childList: true, characterData: true, subtree: true });
      };
      watch('status', w.__polite);
      watch('turn-alert', w.__alerts);
    });
    // three tickets ahead are served, quickly, one after another (each moves the visitor up)
    const q = s.queueId ?? '';
    for (let i = 0; i < 3; i++) {
      await command(page, q, { action: 'ticket.call_next', counter_id: s.counterId });
      const id = (await (await page.request.get(`/api/v1/queues/${q}`)).json()) as {
        queue: { tickets: { id: string; state: string }[] };
      };
      const called = id.queue.tickets.find((t) => t.state === 'called');
      await command(page, q, { action: 'ticket.serve', ticket_id: called?.id });
      await command(page, q, { action: 'ticket.complete', ticket_id: called?.id });
    }
    await expect(v.page.getByTestId('ticket-position')).toContainText('2 in line');
    const positionsSaid = async (): Promise<string[]> =>
      (await v.page.evaluate(() => (window as unknown as { __polite: string[] }).__polite)).filter(
        (t) => /^You are (now number|next)/.test(t),
      );
    // messages are spaced in their region: wait for the first one, then make sure no more follow
    await expect.poll(async () => (await positionsSaid()).length).toBeGreaterThan(0);
    await v.page.waitForTimeout(1000); // negative assertion: nothing else may arrive
    const positions = await positionsSaid();
    // one announcement for a burst of three changes inside 15 s; the others were skipped, not queued
    expect(positions).toHaveLength(1);
    expect(new Set(positions).size).toBe(1);
    // the last ticket ahead is served too, so the visitor is next
    await command(page, q, { action: 'ticket.call_next', counter_id: s.counterId });
    const last = (await (await page.request.get(`/api/v1/queues/${q}`)).json()) as {
      queue: { tickets: { id: string; state: string }[] };
    };
    const lastId = last.queue.tickets.find((t) => t.state === 'called')?.id;
    await command(page, q, { action: 'ticket.serve', ticket_id: lastId });
    await command(page, q, { action: 'ticket.complete', ticket_id: lastId });
    await expect(v.page.getByTestId('ticket-position')).toContainText('1 in line');
    // now the visitor is called: assertive alert, exactly once, naming the counter
    await command(page, q, { action: 'ticket.call_next', counter_id: s.counterId });
    await expect(v.page.getByTestId('ticket-state')).toHaveText('Called');
    await expect(v.page.getByTestId('turn-alert')).toContainText('Counter 1');
    await v.page.waitForTimeout(500); // let any duplicate render settle (negative assertion)
    const alerts = await v.page.evaluate(
      () => (window as unknown as { __alerts: string[] }).__alerts,
    );
    expect(alerts).toHaveLength(1);
    expect(await v.page.getByTestId('turn-alert').getAttribute('role')).toBe('alert');
    expect(code).toMatch(/^[A-Z]\d{3}$/);
    await v.ctx.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 11.A1 / 11.A2 — keyboard-only journeys, focus, targets
// ---------------------------------------------------------------------------------------------

async function tabTo(
  page: Page,
  matches: (el: Element | null) => boolean,
  max = 60,
): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const handle = await page.evaluateHandle(() => document.activeElement);
    const ok = await handle.evaluate(matches);
    if (ok) return;
  }
  throw new Error('focus never reached the expected control');
}

test.describe('11.A1 / 11.A2 keyboard-only journeys and focus', () => {
  test('join → ticket → display settings → recover, with no pointer at all', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitorContext(browser);
    await v.page.goto(s.joinPath);
    await expect(v.page.getByRole('heading', { level: 1 })).toHaveText('Queue Clinic');

    // register: Tab to the join button and press Enter
    await tabTo(v.page, (el) => /Get a ticket/.test(el?.textContent ?? ''));
    await v.page.keyboard.press('Enter');
    await expect(v.page.getByTestId('ticket-code')).toBeVisible();
    // route change: focus is on the new page's heading and the title follows it
    await expect(v.page.locator('#main h1')).toBeFocused();
    await expect(v.page).toHaveTitle(/^Ticket G001 — QueueBridge$/);
    // the polite region did not ALSO read the title: it is heard once, from the focused heading
    await expect(v.page.getByTestId('status')).not.toContainText('QueueBridge');

    // the recovery key panel is reachable and operable by keyboard
    await tabTo(v.page, (el) => /I have saved my key/.test(el?.textContent ?? ''));
    await v.page.keyboard.press('Enter');
    await expect(v.page.getByTestId('recovery-key-panel')).toHaveCount(0);

    // display and alerts: open with Space, move through, close with Escape, focus returns
    await tabTo(v.page, (el) => /Display and alerts/.test(el?.textContent ?? ''));
    const opener = await v.page.evaluateHandle(() => document.activeElement);
    await v.page.keyboard.press('Space');
    await expect(v.page.getByTestId('display-settings')).toBeVisible();
    await v.page.keyboard.press('Tab');
    await v.page.keyboard.press('Escape');
    await expect(v.page.getByTestId('display-settings')).toHaveCount(0);
    expect(await opener.evaluate((el) => el === document.activeElement)).toBe(true);

    // recover: from the join page, by link, with Enter
    await v.page.goto(s.joinPath);
    await expect(v.page.getByRole('heading', { level: 1 })).toHaveText('Queue Clinic');
    await tabTo(v.page, (el) => /Lost your ticket/.test(el?.textContent ?? ''));
    await v.page.keyboard.press('Enter');
    await expect(v.page.locator('#main h1')).toBeFocused();
    await expect(v.page.locator('#main h1')).toHaveText('Get your ticket back');
    await expect(v.page).toHaveTitle('Get your ticket back — QueueBridge');
    await v.ctx.close();
  });

  test('a missed visitor can return to the queue with the keyboard alone (rejoin)', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const q = s.queueId ?? '';
    const patch = await page.request.patch(
      `/api/v1/facilities/${s.facility.id}/services/${s.serviceId}`,
      { headers: CSRF, data: { policy: { rejoin_policy: 'self_resume' } } },
    );
    expect(patch.status()).toBe(200);
    const v = await visitorContext(browser);
    const code = await joinAsVisitor(v.page, s);
    await v.page.getByRole('button', { name: 'I have saved my key' }).click();
    await command(page, q, { action: 'ticket.call_next', counter_id: s.counterId });
    await command(page, q, { action: 'ticket.miss', ticket_id: await ticketIdOf(page, q, code) });
    await expect(v.page.getByTestId('ticket-state')).toHaveText('Missed');
    await tabTo(v.page, (el) => /return me to the queue/.test(el?.textContent ?? ''));
    await v.page.keyboard.press('Enter');
    await expect(v.page.getByTestId('ticket-state')).toHaveText('Waiting');
    await expect(v.page.getByTestId('recovery-note')).toContainText('back in the queue');
    await v.ctx.close();
  });

  test('the settings dialog: focus moves in, is contained, Escape closes, focus returns', async ({
    browser,
  }) => {
    const v = await visitorContext(browser);
    await v.page.goto('/');
    await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
    const opener = v.page.getByTestId('open-display-settings').first();
    await opener.focus();
    await v.page.keyboard.press('Enter');
    const dialog = v.page.getByTestId('display-settings');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    // labelled, modal
    await expect(dialog).toHaveAccessibleName('Display and alerts');
    // contained both ways: 30 Tab and 30 Shift+Tab presses never leave the dialog
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let i = 0; i < 30; i++) {
        await v.page.keyboard.press(key);
        expect(
          await dialog.evaluate((d) => d.contains(document.activeElement)),
          `${key} #${i}`,
        ).toBe(true);
      }
    }
    await v.page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    // the Close button works too, and also returns focus
    await v.page.keyboard.press('Enter');
    await v.page.getByRole('button', { name: /^Close/ }).click();
    await expect(opener).toBeFocused();
    await v.ctx.close();
  });

  test('a call while the settings dialog is open closes it, so the alert is never hidden behind it', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitorContext(browser);
    await joinAsVisitor(v.page, s);
    await v.page.getByRole('button', { name: 'I have saved my key' }).click();
    await openSettings(v.page);
    await command(page, s.queueId ?? '', { action: 'ticket.call_next', counter_id: s.counterId });
    await expect(v.page.getByTestId('display-settings')).toHaveCount(0);
    await expect(v.page.getByTestId('ticket-state')).toHaveText('Called');
    await expect(v.page.getByTestId('turn-alert')).toContainText('Counter 1');
    // the rest of the page is no longer inert: the alert region is in the accessibility tree
    expect(await v.page.evaluate(() => document.querySelector('dialog[open]'))).toBeNull();
    await expect(v.page.getByRole('alert').filter({ hasText: 'Counter 1' })).toHaveCount(1);
    await v.ctx.close();
  });

  test('the same control is on the ticket page and works from there', async ({ page, browser }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitorContext(browser);
    await joinAsVisitor(v.page, s);
    const onPage = v.page.locator('#main').getByTestId('open-display-settings');
    await onPage.focus();
    await v.page.keyboard.press('Enter');
    await expect(v.page.getByTestId('display-settings')).toBeVisible();
    await v.page.keyboard.press('Escape');
    await expect(onPage).toBeFocused();
    await v.ctx.close();
  });

  test('focus stays put when the page loads its data, unless the person has not moved yet', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitorContext(browser);
    await v.page.goto(s.joinPath);
    await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
    // the person moves focus to the settings button before the next page finishes loading
    await v.page.getByRole('link', { name: /Lost your ticket/ }).click();
    await expect(v.page.locator('#main h1')).toBeFocused();
    await v.page.getByLabel('Organization').focus();
    await v.page.waitForTimeout(300);
    await expect(v.page.getByLabel('Organization')).toBeFocused(); // never yanked back to the heading
    await v.ctx.close();
  });

  test('@responsive focus is visible, and every control is at least 24 px (primary actions 44 px)', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitorContext(browser);
    const check = async (label: string): Promise<void> => {
      const small = await v.page.evaluate(() => {
        const out: string[] = [];
        const sel = 'button, select, input:not([type="hidden"]), summary, .nav-list a, .brand';
        for (const el of document.querySelectorAll<HTMLElement>(sel)) {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden') continue;
          if (el.closest('.visually-hidden')) continue;
          if (r.width < 24 || r.height < 24) {
            out.push(
              `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`,
            );
          }
        }
        return out;
      });
      expect(small, `targets under 24 px on ${label}`).toEqual([]);
    };
    await v.page.goto(s.joinPath);
    await expect(v.page.getByRole('button', { name: /Get a ticket/ })).toBeVisible();
    await check('join');
    const primary = await v.page.getByRole('button', { name: /Get a ticket/ }).boundingBox();
    expect(primary?.height ?? 0).toBeGreaterThanOrEqual(44);
    await v.page.goto('/recover');
    await check('recover');
    await openSettings(v.page);
    await check('settings');
    await v.page.keyboard.press('Escape');
    await joinAsVisitor(v.page, s);
    await check('ticket');
    // keyboard focus indicator: thick outline, not removed
    await v.page.keyboard.press('Tab');
    await v.page.keyboard.press('Tab');
    const outline = await v.page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement as Element);
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(2);
    // fixed notifications cannot hide the focused control (scroll padding)
    expect(
      await v.page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom),
      ),
    ).toBeGreaterThanOrEqual(64);
    await v.ctx.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 11.A8 — offline accessibility
// ---------------------------------------------------------------------------------------------

test.describe('11.A8 offline accessibility', () => {
  test('the recover page says a connection is needed, in text, and stays operable by keyboard', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitorContext(browser);
    await v.page.goto(`/recover/${s.org.slug}/${s.facility.slug}`);
    await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
    await v.ctx.setOffline(true);
    const note = v.page.getByTestId('recover-offline');
    await expect(note).toContainText('needs a connection');
    await expect(note).toHaveAttribute('role', 'status');
    await expectNoA11yViolations(v.page);
    // keyboard still reaches and fills the form; submit is disabled with the reason in text
    await v.page.getByLabel('Ticket code').focus();
    await v.page.keyboard.type('A001');
    await v.page.keyboard.press('Tab');
    await v.page.keyboard.type('0'.repeat(32));
    await expect(v.page.getByRole('button', { name: 'Recover my ticket' })).toBeDisabled();
    // preferences still open and work offline
    await openSettings(v.page);
    await expect(v.page.getByLabel('Contrast')).toBeEnabled();
    await v.ctx.setOffline(false);
    await v.ctx.close();
  });

  test('the stored ticket is shown from the last copy, labelled with when it was confirmed', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitorContext(browser);
    const code = await joinAsVisitor(v.page, s);
    await v.page.getByRole('button', { name: 'I have saved my key' }).click();
    await expect(v.page.getByTestId('ticket-offline-copy')).toHaveCount(0);
    // the server becomes unreachable (the app shell is already in the browser)
    await v.page.route('**/api/v1/**', (r) => r.abort('connectionfailed'));
    await v.page.reload();
    const note = v.page.getByTestId('ticket-offline-copy');
    await expect(note).toContainText('You are offline');
    await expect(note).toContainText('may be out of date');
    await expect(note).toHaveAttribute('role', 'status');
    await expect(v.page.getByTestId('ticket-code')).toHaveText(code);
    await expect(v.page.getByTestId('ticket-state')).toHaveText('Waiting');
    // never the misleading "no access" screen
    await expect(v.page.getByTestId('ticket-unavailable')).toHaveCount(0);
    await expectNoA11yViolations(v.page);
    expect(await hasHorizontalOverflow(v.page)).toBe(false);
    // keyboard still works
    await tabTo(v.page, (el) => /Display and alerts/.test(el?.textContent ?? ''));
    await v.page.keyboard.press('Enter');
    await expect(v.page.getByTestId('display-settings')).toBeVisible();
    await v.ctx.close();
  });

  test('after access is withdrawn, the stored copy is removed and never shown, online or offline', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const q = s.queueId ?? '';
    const v = await visitorContext(browser);
    const code = await joinAsVisitor(v.page, s);
    await v.page.getByRole('button', { name: 'I have saved my key' }).click();
    await expect(v.page.getByTestId('ticket-state')).toHaveText('Waiting');
    expect(await v.page.evaluate(() => localStorage.getItem('qb.ticketView.v1'))).toContain(code);
    // staff end access on every device of this ticket
    const ticketId = await ticketIdOf(page, q, code);
    const revoke = await page.request.post(
      `/api/v1/queues/${q}/tickets/${ticketId}/recovery/revoke-all`,
      { headers: CSRF, data: { reason_code: 'lost_device' } },
    );
    expect(revoke.status()).toBe(200);
    await v.page.reload();
    await expect(v.page.getByTestId('ticket-unavailable')).toBeVisible();
    // the stored copy was removed when the server refused
    expect(await v.page.evaluate(() => localStorage.getItem('qb.ticketView.v1'))).not.toContain(
      code,
    );
    // even with the server unreachable it is not shown again
    await v.page.route('**/api/v1/**', (r) => r.abort('connectionfailed'));
    await v.page.reload();
    await expect(v.page.getByTestId('ticket-offline-copy')).toHaveCount(0);
    await expect(v.page.getByTestId('ticket-code')).toHaveCount(0);
    await v.ctx.close();
  });

  test('a refusal is never masked by the offline copy: a forgotten or unknown ticket still says so', async ({
    browser,
  }) => {
    const v = await visitorContext(browser);
    await v.page.goto('/ticket/Z999');
    await expect(v.page.getByTestId('ticket-unavailable')).toBeVisible();
    await expect(v.page.getByTestId('ticket-offline-copy')).toHaveCount(0);
    await v.ctx.close();
  });

  test('staff offline: connectivity and sync-state changes are announced in text, the outbox is operable and axe-clean', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    const p = staff.page;
    await p.goto(`/staff/queues/${s.queueId}`);
    await expect(p.getByTestId('connection-state')).toContainText('Online');
    await expect(p.locator('[data-device-ready="true"]')).toHaveCount(1, { timeout: 15_000 });
    // the observer sees every polite announcement, whatever the clean-up timing
    await p.evaluate(() => {
      const w = window as unknown as { __said: string[] };
      w.__said = [];
      const el = document.querySelector('[data-testid="status"]');
      new MutationObserver(() => {
        const t = (el?.textContent ?? '').trim();
        if (t) w.__said.push(t);
      }).observe(el as Node, { childList: true, characterData: true, subtree: true });
    });
    await goOffline(staff.ctx, p);
    await expect(p.getByTestId('connection-state')).toContainText('Offline');
    // words, not colour: the bar carries a text label and a symbol
    await expect(p.getByTestId('connectivity-bar')).toContainText('Offline');
    await p.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await expect(p.getByTestId('outbox-panel')).toBeVisible();
    await expect(p.getByTestId('outbox-row').getByTestId('sync-state-indicator')).toContainText(
      'Local',
    );
    await expect(p.getByTestId('offline-capture')).toContainText(
      'Ticket recovery is not available until then',
    );
    await expectNoA11yViolations(p);
    // the outbox panel is a labelled region with a heading
    await expect(p.getByRole('region', { name: 'Actions on this device' })).toBeVisible();
    await staff.ctx.setOffline(false);
    await expect(p.getByTestId('connection-state')).toContainText('Online', { timeout: 15_000 });
    await expect(p.getByTestId('unsynced-count')).toHaveCount(0, { timeout: 20_000 });
    const saidNow = (): Promise<string[]> =>
      p.evaluate(() => (window as unknown as { __said: string[] }).__said);
    // announcements are written a moment after the state changes: wait for them, never sleep
    await expect
      .poll(async () => (await saidNow()).includes('No unsent actions remain on this device.'))
      .toBe(true);
    const said = await saidNow();
    expect(said.filter((t) => t.startsWith('You are offline'))).toHaveLength(1);
    expect(said.filter((t) => t.startsWith('Back online'))).toHaveLength(1);
    expect(said.filter((t) => t === 'No unsent actions remain on this device.')).toHaveLength(1);
    await staff.ctx.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 11.A9 — responsive and orientation
// ---------------------------------------------------------------------------------------------

test.describe('11.A9 responsive and orientation', () => {
  test('the web manifest does not lock the orientation, and the viewport allows zoom', async ({
    request,
  }) => {
    const html = await (await request.get('/')).text();
    const viewport = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(viewport).toContain('width=device-width');
    expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/);
    const manifest = (await (await request.get('/manifest.webmanifest')).json()) as Record<
      string,
      unknown
    >;
    expect(manifest['display']).toBe('standalone');
    expect('orientation' in manifest).toBe(false);
  });

  test('@responsive every visitor route and the panel fit the screen (portrait and landscape)', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitorContext(browser);
    const size = page.viewportSize() ?? { width: 1280, height: 720 };
    for (const vp of [size, { width: size.height, height: size.width }]) {
      await v.page.setViewportSize(vp);
      for (const path of [
        s.joinPath,
        '/recover',
        `/recover/${s.org.slug}/${s.facility.slug}`,
        `/ticket/G999`,
      ]) {
        await v.page.goto(path);
        await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
        expect(await hasHorizontalOverflow(v.page), `${path} at ${vp.width}×${vp.height}`).toBe(
          false,
        );
      }
      await openSettings(v.page);
      expect(await hasHorizontalOverflow(v.page)).toBe(false);
      await expectNoA11yViolations(v.page);
    }
    await v.ctx.close();
  });
});
