import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import { uuidv7 } from '@queuebridge/contracts';
import {
  apiQueueSetup,
  apiSignup,
  expectNoA11yViolations,
  hasHorizontalOverflow,
} from './helpers.js';
import { makeStaff } from './offline-helpers.js';
import { en } from '../src/landing/locales/en.js';
import { WEB_SECURITY_HEADERS } from '../src/pwa/securityHeaders.js';
/**
 * M7.2 public landing page and onboarding (design §14.1, §14.4–§14.7; REQ-F15.3–F15.7; Group
 * 15.1–15.7) against the real built app (`vite preview`, production security headers) and API.
 * Expected copy is read from the English resource bundle, so these tests also prove the page
 * renders through the localization layer.
 */
const CSRF = { 'X-QB-CSRF': '1' };
const WIDTHS = [320, 375, 768, 1280, 1440] as const;
const HERO = en.hero.title;
const story = en.story.stages;

async function landing(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(HERO);
  await expect(page.getByTestId('channels-loading')).toHaveCount(0);
}
async function context(
  browser: Browser,
  opts: {
    reducedMotion?: 'reduce' | 'no-preference';
    colorScheme?: 'light' | 'dark';
    prefs?: Record<string, unknown>;
  } = {},
): Promise<Page> {
  const ctx = await browser.newContext({
    serviceWorkers: 'block',
    reducedMotion: opts.reducedMotion ?? 'no-preference',
    colorScheme: opts.colorScheme ?? 'light',
  });
  if (opts.prefs) {
    await ctx.addInitScript(
      (p) => localStorage.setItem('qb.a11y.v1', JSON.stringify(p)),
      opts.prefs,
    );
  }
  return ctx.newPage();
}
/** Collect CSP violations reported by the page (the policy is enforced by the preview server). */
async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp ?? []);
}

test.describe('M7.2 hero and navigation', () => {
  test('headline, supporting line, logo and the three calls to action', async ({ page }) => {
    await landing(page);
    const hero = page.locator('.hero');
    await expect(hero.getByText(en.hero.lead)).toBeVisible();
    await expect(hero.getByRole('img', { name: 'QueueBridge' })).toBeVisible();
    await hero.getByRole('link', { name: en.hero.primary }).click();
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your organization');
    await landing(page);
    await page.locator('.hero').getByRole('link', { name: en.hero.secondary }).click();
    await expect(page).toHaveURL(/\/login$/);
    await landing(page);
    await page.locator('.hero').getByRole('link', { name: en.hero.tertiary }).click();
    await expect(page).toHaveURL(/#how-visitors-join$/);
    await expect(page.getByTestId('join-howto')).toBeInViewport();
    for (const s of en.join.steps) await expect(page.getByTestId('join-howto')).toContainText(s);
  });

  test('signed in: the hero continues to the right place, without the sign-up actions', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    await landing(page);
    const hero = page.locator('.hero');
    await expect(hero.getByRole('link', { name: en.hero.continue })).toHaveAttribute(
      'href',
      '/admin',
    );
    await expect(hero.getByRole('link', { name: en.hero.primary })).toHaveCount(0);
    const counter = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    await counter.page.goto('/');
    await expect(
      counter.page.locator('.hero').getByRole('link', { name: en.hero.staffConsole }),
    ).toHaveAttribute('href', '/staff');
    await expect(counter.page.getByTestId('onboarding-not-admin')).toBeVisible();
    await counter.ctx.close();
  });
});

test.describe('M7.2 saved tickets on this device (preserved)', () => {
  test('a ticket joined here is listed and opens without sign-in; no credential in the markup', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await context(browser);
    await v.goto(s.joinPath);
    await v.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(v.getByTestId('ticket-code')).toBeVisible();
    const code = (await v.getByTestId('ticket-code').innerText()).trim();
    const saved = await v.evaluate(() => localStorage.getItem('qb.tickets.v1') ?? '');
    const token = (JSON.parse(saved || '[]') as { token: string }[])[0]?.token ?? '';
    expect(token.length).toBeGreaterThan(20);
    await v.goto('/');
    const mine = v.getByTestId('my-tickets');
    await expect(mine.getByRole('heading', { name: en.savedTickets.heading })).toBeVisible();
    await expect(mine.getByRole('link', { name: new RegExp(`^${code} — `) })).toBeVisible();
    expect(await v.content()).not.toContain(token);
    await mine.getByRole('link', { name: new RegExp(`^${code} — `) }).click();
    await expect(v.getByTestId('ticket-code')).toHaveText(code);
    await v.context().close();
  });
  test('with no saved ticket the section is absent', async ({ page }) => {
    await landing(page);
    await expect(page.getByTestId('my-tickets')).toHaveCount(0);
  });
});

test.describe('M7.2 continuity story', () => {
  test('every stage is shown as text; it plays; Pause stops it; Play resumes; controls are keyboard operable', async ({
    browser,
  }) => {
    const p = await context(browser);
    await p.clock.install();
    await landing(p);
    const list = p.getByTestId('story-stages');
    await expect(list).toHaveAttribute('data-mode', 'animated');
    await expect(list.getByTestId('story-stage')).toHaveCount(6);
    for (const s of story) {
      await expect(list).toContainText(s.title);
      await expect(list).toContainText(s.caption);
    }
    const current = list.locator('[aria-current="step"]');
    for (let i = 0; i < 6; i++) {
      await expect(current).toContainText(story[i]!.title);
      await expect(p.getByTestId('story-position')).toHaveText(`Stage ${i + 1} of 6`);
      await expect(
        p.getByRole('img', { name: `Illustration for stage ${i + 1}: ${story[i]!.title}` }),
      ).toBeVisible();
      await p.clock.runFor(5000);
    }
    await expect(current).toContainText(story[0]!.title); // loops
    // Pause by keyboard
    const toggle = p.getByTestId('story-toggle');
    await expect(toggle).toHaveText(en.story.pause);
    await toggle.focus();
    await p.keyboard.press('Enter');
    await expect(toggle).toHaveText(en.story.resume);
    await p.clock.runFor(20_000);
    await expect(current).toContainText(story[0]!.title);
    await p.keyboard.press('Enter');
    await expect(toggle).toHaveText(en.story.pause);
    await p.clock.runFor(5000);
    await expect(current).toContainText(story[1]!.title);
    // Next pauses and is announced once, politely
    await p.getByRole('button', { name: en.story.next }).click();
    await expect(current).toContainText(story[2]!.title);
    await expect(toggle).toHaveText(en.story.resume);
    await expect(p.getByTestId('story-announce')).toHaveText(`Stage 3 of 6: ${story[2]!.title}`);
    await expect(p.getByTestId('story-announce')).toHaveAttribute('role', 'status');
    // jump to a stage from the list
    await list.getByRole('button', { name: story[5]!.title }).click();
    await expect(current).toContainText(story[5]!.title);
    await p.context().close();
  });

  for (const how of ['system', 'device'] as const) {
    test(`reduced motion (${how} setting): a static equivalent with all six stages and no autoplay`, async ({
      browser,
    }) => {
      const p = await context(
        browser,
        how === 'system' ? { reducedMotion: 'reduce' } : { prefs: { motion: 'reduce' } },
      );
      await landing(p);
      const list = p.getByTestId('story-stages');
      await expect(list).toHaveAttribute('data-mode', 'static');
      await expect(list.getByTestId('story-stage')).toHaveCount(6);
      await expect(p.locator('svg.story-scene')).toHaveCount(6);
      for (const s of story) await expect(list).toContainText(s.caption);
      await expect(p.getByTestId('story-toggle')).toHaveCount(0);
      await expect(p.getByTestId('story-static-note')).toHaveText(en.story.staticNote);
      // nothing animates anywhere on the page
      const moving = await p.evaluate(
        () =>
          [...document.querySelectorAll('*')].filter((e) => {
            const cs = getComputedStyle(e);
            return cs.animationName !== 'none' || parseFloat(cs.transitionDuration) > 0;
          }).length,
      );
      expect(moving).toBe(0);
      await expectNoA11yViolations(p);
      await p.context().close();
    });
  }
});

test.describe('M7.2 sections and truthfulness', () => {
  test('audiences, capabilities and footer content are present; no invented claims', async ({
    page,
  }) => {
    await landing(page);
    for (const a of en.audiences.items) {
      await expect(
        page.getByTestId('audiences').getByRole('heading', { name: a.title }),
      ).toBeVisible();
    }
    for (const c of en.capabilities.items) {
      await expect(
        page.getByTestId('capabilities').getByRole('heading', { name: c.title }),
      ).toBeVisible();
    }
    const footer = page.getByTestId('landing-footer');
    await expect(footer).toContainText(en.footer.privacy);
    await expect(footer).toContainText(en.footer.accessibility);
    await expect(footer).toContainText('MIT License');
    await expect(footer.getByRole('link', { name: en.footer.repository })).toHaveAttribute(
      'href',
      'https://github.com/Ajayfrizzy/queuebridge',
    );
    const text = await page.locator('main').innerText();
    expect(text).not.toMatch(
      /conflict[- ]free|guaranteed|always online|tamper[- ]?proof|WCAG[^.]*certified(?! )|\b\d{2,}\s?%|testimonial/i,
    );
  });
});

test.describe('M7.2 channel status from the capability manifest', () => {
  test('the real deployment: web and QR live, SMS and USSD sandbox (labelled test-only)', async ({
    page,
  }) => {
    const res = await page.request.get('/api/v1/que/capabilities');
    const m = (await res.json()) as {
      capabilities: Record<string, { status: string; availability: string }>;
    };
    await landing(page);
    const join = page.getByTestId('channel-visitor_join');
    expect(m.capabilities['visitor_join']).toMatchObject({
      status: 'live',
      availability: 'available',
    });
    await expect(join).toHaveAttribute('data-status', 'live');
    await expect(join.getByTestId('channel-status')).toHaveText(`✓ ${en.channels.status.live}`);
    for (const id of ['sms_turn_alerts', 'ussd'] as const) {
      expect(m.capabilities[id]?.status).toBe('sandbox');
      const card = page.getByTestId(`channel-${id}`);
      await expect(card).toHaveAttribute('data-status', 'sandbox');
      await expect(card).toHaveAttribute('data-usable', 'false');
      await expect(card.getByTestId('channel-status')).not.toContainText('Live');
      await expect(card.getByTestId('channel-explain')).toHaveText(
        m.capabilities[id]?.availability === 'available'
          ? en.channels.explain.sandbox
          : en.channels.explain.sandboxNotSetUp,
      );
    }
  });

  test('a change in the manifest changes the page; a missing manifest fails closed', async ({
    page,
  }) => {
    const rewrite =
      (caps: Record<string, unknown>) =>
      async (route: Route): Promise<void> => {
        const res = await route.fetch();
        const body = (await res.json()) as { capabilities: Record<string, unknown> };
        Object.assign(body.capabilities, caps);
        await route.fulfill({ response: res, json: body });
      };
    await page.route(
      '**/api/v1/que/capabilities',
      rewrite({
        sms_turn_alerts: { status: 'live', availability: 'available', since: 'M6' },
        ussd: {
          status: 'planned',
          availability: 'unavailable',
          unavailableReason: 'not_implemented',
        },
        visitor_join: {
          status: 'live',
          availability: 'unavailable',
          unavailableReason: 'switched_off',
          since: 'M2',
          note: 'Online joining is switched off here.',
        },
      }),
    );
    await landing(page);
    await expect(page.getByTestId('channel-sms_turn_alerts')).toHaveAttribute(
      'data-status',
      'live',
    );
    await expect(
      page.getByTestId('channel-sms_turn_alerts').getByTestId('channel-status'),
    ).toHaveText(`✓ ${en.channels.status.live}`);
    await expect(page.getByTestId('channel-ussd').getByTestId('channel-status')).toHaveText(
      `○ ${en.channels.status.planned}`,
    );
    await expect(page.getByTestId('channel-visitor_join')).toHaveAttribute(
      'data-status',
      'switchedOff',
    );
    await expect(
      page.getByTestId('channel-visitor_join').getByTestId('channel-explain'),
    ).toHaveText(en.channels.explain.switchedOff);
    await page.unroute('**/api/v1/que/capabilities');
    // unavailable manifest: nothing is shown as available
    await page.route('**/api/v1/que/capabilities', (r) => r.abort());
    await landing(page);
    await expect(page.getByTestId('channels-unavailable')).toHaveText(en.channels.unavailableAll);
    for (const id of ['visitor_join', 'sms_turn_alerts', 'ussd']) {
      await expect(page.getByTestId(`channel-${id}`)).toHaveAttribute('data-usable', 'false');
      await expect(page.getByTestId(`channel-${id}`)).toHaveAttribute('data-status', 'unknown');
    }
    // a malformed manifest is treated the same way
    await page.unroute('**/api/v1/que/capabilities');
    await page.route('**/api/v1/que/capabilities', (r) =>
      r.fulfill({ json: { version: 1, capabilities: { ussd: { status: 'live' } } } }),
    );
    await landing(page);
    await expect(page.getByTestId('channel-ussd')).toHaveAttribute('data-status', 'unknown');
  });
});

test.describe('M7.2 get-started checklist (F10)', () => {
  test('signed out: seven steps, a clear start, no private data and no deep links', async ({
    page,
  }) => {
    await landing(page);
    const steps = page.getByTestId('onboarding-step');
    await expect(steps).toHaveCount(7);
    for (const [i, s] of en.onboarding.steps.entries())
      await expect(steps.nth(i)).toContainText(s.title);
    await expect(
      steps.nth(0).getByRole('link', { name: en.onboarding.steps[0]!.title }),
    ).toHaveAttribute('href', '/signup');
    await expect(page.getByTestId('onboarding').getByRole('link')).toHaveCount(2); // sign up + sign in
    await expect(page.getByTestId('onboarding-state')).toHaveCount(0);
  });

  test('signed-in administrator: steps follow readiness and link to the real screens', async ({
    page,
  }) => {
    const org = await apiSignup(page.request);
    await landing(page);
    await expect(page.getByTestId('onboarding-no-facility')).toBeVisible();
    const steps = page.getByTestId('onboarding-step');
    await expect(steps.nth(0)).toHaveAttribute('data-state', 'done');
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'todo');
    // a facility with a service but no counter
    const f = await page.request.post('/api/v1/facilities', {
      headers: CSRF,
      data: {
        name: 'Landing Clinic',
        slug: `landing-${uuidv7().slice(-8)}`,
        timezone: 'Africa/Lagos',
      },
    });
    expect(f.status()).toBe(201);
    const fid = ((await f.json()) as { facility: { id: string } }).facility.id;
    await page.request.post(`/api/v1/facilities/${fid}/services`, {
      headers: CSRF,
      data: { name: 'General' },
    });
    await landing(page);
    await expect(page.getByTestId('onboarding-for')).toContainText('Landing Clinic');
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'done');
    await expect(steps.nth(2)).toHaveAttribute('data-state', 'done');
    await expect(steps.nth(3)).toHaveAttribute('data-state', 'todo');
    const hrefs = await page
      .getByTestId('onboarding-steps')
      .getByRole('link')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs).toEqual([
      '/admin',
      `/admin/facilities/${fid}/services`,
      `/admin/facilities/${fid}/counters`,
      `/admin/facilities/${fid}/staff`,
      `/admin/facilities/${fid}`,
      `/staff/facilities/${fid}`,
    ]);
    // every link opens a real screen for this administrator
    for (const h of hrefs) {
      await page.goto(h ?? '/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText(/does not exist|not have access/i)).toHaveCount(0);
    }
    expect(org.slug).toBeTruthy();
  });
});

test.describe('M7.2 architecture, privacy and security', () => {
  test('the landing page is its own chunk; visitor and staff routes never download it', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const seen = (p: Page): string[] => {
      const urls: string[] = [];
      p.on('request', (r) => urls.push(new URL(r.url()).pathname));
      return urls;
    };
    const v = await context(browser);
    const vUrls = seen(v);
    await v.goto(s.joinPath);
    await v.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(v.getByTestId('ticket-code')).toBeVisible();
    await v.goto('/recover');
    await expect(v.getByRole('heading', { level: 1 })).toBeVisible();
    await v.goto(s.displayPath);
    await expect(v.getByRole('heading', { level: 1 })).toBeVisible();
    expect(vUrls.filter((u) => u.includes('LandingPage-'))).toEqual([]);
    const staffUrls = seen(page);
    await page.goto(`/staff/queues/${s.queueId ?? ''}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goto('/admin');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(staffUrls.filter((u) => u.includes('LandingPage-'))).toEqual([]);
    // and the landing route does load it
    const l = await context(browser);
    const lUrls = seen(l);
    await landing(l);
    expect(lUrls.some((u) => /\/assets\/LandingPage-.*\.js$/.test(u))).toBe(true);
    await v.context().close();
    await l.context().close();
  });

  test('no request leaves the origin, no CSP violation, and the production headers are served', async ({
    browser,
    baseURL,
  }) => {
    const p = await context(browser);
    const csp = await watchCsp(p);
    const origin = new URL(baseURL ?? 'http://localhost').origin;
    const foreign: string[] = [];
    p.on('request', (r) => {
      const u = r.url();
      if (u.startsWith('data:') || u.startsWith('blob:')) return;
      if (new URL(u).origin !== origin) foreign.push(u);
    });
    const res = await p.goto('/');
    await expect(p.getByRole('heading', { level: 1 })).toHaveText(HERO);
    await p.waitForLoadState('networkidle');
    // play through the story and open the join section
    await p.getByRole('button', { name: en.story.next }).click();
    await p.getByRole('link', { name: en.hero.tertiary }).click();
    expect(foreign).toEqual([]);
    expect(await csp()).toEqual([]);
    const headers = res?.headers() ?? {};
    for (const [name, value] of Object.entries(WEB_SECURITY_HEADERS)) {
      expect(headers[name.toLowerCase()], name).toBe(value);
    }
    await p.context().close();
  });

  test('the app works under the CSP on the visitor, staff and board screens (no violation)', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    await page.request.post(`/api/v1/queues/${s.queueId ?? ''}/walk-ins`, {
      headers: CSRF,
      data: { operation_id: uuidv7() },
    });
    const v = await context(browser);
    const vCsp = await watchCsp(v);
    await v.goto(s.joinPath);
    await v.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(v.getByTestId('ticket-code')).toBeVisible();
    await v.goto(s.displayPath);
    await expect(v.getByTestId('now-calling')).toBeVisible();
    expect(await vCsp()).toEqual([]);
    const staffCsp = await watchCsp(page);
    await page.goto(`/staff/queues/${s.queueId ?? ''}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goto(`/admin/facilities/${s.facility.id}`);
    await expect(page.getByTestId('join-qr')).toBeVisible();
    expect(await staffCsp()).toEqual([]);
    await v.context().close();
  });
});

test.describe('M7.2 accessibility and responsive layout', () => {
  const THEMES = [
    { name: 'light', colorScheme: 'light' as const, prefs: undefined },
    { name: 'dark', colorScheme: 'dark' as const, prefs: undefined },
    { name: 'high contrast', colorScheme: 'light' as const, prefs: { contrast: 'high' } },
    {
      name: 'high contrast (dark system)',
      colorScheme: 'dark' as const,
      prefs: { contrast: 'high' },
    },
    { name: 'large text', colorScheme: 'light' as const, prefs: { textSize: 'xlarge' } },
  ];
  for (const theme of THEMES) {
    test(`${theme.name}: axe-clean with no page overflow at 320–1440 px`, async ({ browser }) => {
      test.setTimeout(120_000);
      const p = await context(browser, {
        colorScheme: theme.colorScheme,
        ...(theme.prefs ? { prefs: theme.prefs } : {}),
      });
      for (const width of WIDTHS) {
        await p.setViewportSize({ width, height: 900 });
        await landing(p);
        expect(await hasHorizontalOverflow(p), `overflow at ${width}px`).toBe(false);
        await expectNoA11yViolations(p);
      }
      if (theme.prefs?.textSize === 'xlarge') {
        expect(await p.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
          '24px',
        );
      }
      await p.context().close();
    });
  }

  test('keyboard: skip link, headings in order, every control reachable with a visible focus', async ({
    page,
  }) => {
    await landing(page);
    const levels = await page
      .locator('main h1, main h2, main h3')
      .evaluateAll((hs) => hs.map((h) => Number(h.tagName[1])));
    expect(levels[0]).toBe(1);
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]! - levels[i - 1]!, `heading ${i}`).toBeLessThanOrEqual(1);
    }
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Enter');
    const reached = new Set<string>();
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        return {
          name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
          outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2,
          inMain: Boolean(el.closest('main')),
        };
      });
      if (!info?.inMain) continue;
      expect(info.outline, `focus visible on "${info.name}"`).toBe(true);
      reached.add(info.name);
    }
    for (const name of [
      en.hero.primary,
      en.hero.secondary,
      en.hero.tertiary,
      en.story.pause,
      en.story.next,
    ]) {
      expect(
        [...reached].some((r) => r.includes(name)),
        name,
      ).toBe(true);
    }
  });
});

test.describe('M7.2 theme selection (Light, Dark, System)', () => {
  const bg = (p: Page): Promise<string> =>
    p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const LIGHT_BG = 'rgb(248, 250, 252)';
  const DARK_BG = 'rgb(11, 22, 37)';
  async function choose(
    p: Page,
    label: 'Light' | 'Dark' | 'Follow my device setting',
  ): Promise<void> {
    await p.getByTestId('open-display-settings').first().click();
    await p.getByLabel('Theme').selectOption({ label });
    await p.getByRole('button', { name: 'Done' }).click();
  }

  test('an explicit choice beats the system setting both ways, persists across reloads and routes, and System follows the OS', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    // the operating system is dark; the person chooses Light
    const p = await context(browser, { colorScheme: 'dark' });
    await landing(p);
    expect(await bg(p)).toBe(DARK_BG); // System by default
    await choose(p, 'Light');
    await expect(p.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await bg(p)).toBe(LIGHT_BG);
    await p.reload();
    await expect(p.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await bg(p)).toBe(LIGHT_BG);
    for (const path of [s.joinPath, '/recover', s.displayPath, '/login']) {
      await p.goto(path);
      await expect(p.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await bg(p), path).toBe(LIGHT_BG);
    }
    // back to System: follows the dark OS again, and a change of the OS setting is followed live
    await choose(p, 'Follow my device setting');
    expect(await bg(p)).toBe(DARK_BG);
    await p.emulateMedia({ colorScheme: 'light' });
    expect(await bg(p)).toBe(LIGHT_BG);
    await p.context().close();
    // a light OS with Dark chosen, on staff and administration screens too
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await choose(page, 'Dark');
    for (const path of [
      '/',
      `/staff/queues/${s.queueId ?? ''}`,
      `/admin/facilities/${s.facility.id}`,
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await bg(page), path).toBe(DARK_BG);
      await expectNoA11yViolations(page);
    }
    expect(
      JSON.parse((await page.evaluate(() => localStorage.getItem('qb.a11y.v1'))) ?? '{}').theme,
    ).toBe('dark');
  });

  test('high contrast combines with the chosen theme (light and dark high-contrast sets)', async ({
    browser,
  }) => {
    const p = await context(browser, {
      colorScheme: 'dark',
      prefs: { contrast: 'high', theme: 'light' },
    });
    await landing(p);
    expect(await bg(p)).toBe('rgb(255, 255, 255)');
    await expectNoA11yViolations(p);
    await choose(p, 'Dark');
    expect(await bg(p)).toBe('rgb(0, 0, 0)');
    await expect(p.locator('html')).toHaveAttribute('data-contrast', 'high');
    await expectNoA11yViolations(p);
    await p.context().close();
  });
});

test.describe('M7.2 workflow simulation', () => {
  /** Which labelled parts of the drawing are visible at a stage (opacity settled) */
  async function visible(p: Page): Promise<string[]> {
    await p.waitForTimeout(700); // the crossfade is 420 ms
    return p.locator('svg.sim').evaluate((svg) =>
      [...svg.querySelectorAll('text')]
        .filter((t) => {
          let el: Element | null = t;
          while (el && el !== svg) {
            if (parseFloat(getComputedStyle(el).opacity) < 0.5) return false;
            el = el.parentElement;
          }
          return true;
        })
        .map((t) => (t.textContent ?? '').trim()),
    );
  }
  test('the same ticket, console and connection change state through the six stages; offline work is never shown as confirmed and the conflict stays', async ({
    browser,
  }) => {
    const p = await context(browser);
    await landing(p);
    await p.getByTestId('story-toggle').click(); // paused: the person steps through
    const sim = p.locator('svg.sim');
    const go = async (n: number): Promise<string[]> => {
      await p
        .getByTestId('story-stages')
        .getByRole('button', { name: story[n - 1]!.title })
        .click();
      await expect(sim).toHaveAttribute('data-stage', String(n));
      return visible(p);
    };
    const s = en.story.sim;
    let v = await go(1);
    expect(v).toEqual(expect.arrayContaining(['G014', s.joined, `✓ ${s.confirmed}`, s.online]));
    v = await go(2);
    expect(v).toEqual(expect.arrayContaining([s.ahead, s.range, s.online]));
    v = await go(3);
    expect(v).toEqual(expect.arrayContaining([s.offline, s.notUpdating, s.captureOnly]));
    expect(v).not.toContain(s.localOnly);
    v = await go(4);
    expect(v.filter((x) => x === s.localOnly)).toHaveLength(2);
    expect(v).toEqual(expect.arrayContaining([s.offline, s.notUpdating]));
    expect(v).not.toContain(`✓ ${s.synced}`);
    expect(v).not.toContain(s.yourTurn);
    v = await go(5);
    expect(v).toEqual(
      expect.arrayContaining([s.syncing, `✓ ${s.synced}`, `! ${s.review}`, s.checking]),
    );
    expect(v).not.toContain(s.localOnly);
    v = await go(6);
    expect(v).toEqual(
      expect.arrayContaining([s.online, s.yourTurn, s.counter, `✓ ${s.called}`, `! ${s.review}`]),
    );
    // paused: nothing that repeats keeps moving (sync packets, the stage clock)
    await go(5);
    const looping = await p.evaluate(
      () =>
        [...document.querySelectorAll('svg.sim *, .story-progress-bar')]
          .map((e) => getComputedStyle(e))
          .filter(
            (cs) =>
              cs.animationName !== 'none' &&
              cs.animationPlayState === 'running' &&
              cs.animationIterationCount === 'infinite',
          ).length,
    );
    expect(looping).toBe(0);
    await expect(p.locator('.story-progress')).toHaveAttribute('data-running', 'false');
    // playing again, they run
    await p.getByTestId('story-toggle').click();
    await expect(sim).toHaveAttribute('data-playing', 'true');
    await p.context().close();
  });
});
