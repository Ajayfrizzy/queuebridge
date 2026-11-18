import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  apiFacility,
  apiQueueSetup,
  apiSignup,
  expectNoA11yViolations,
  hasHorizontalOverflow,
} from './helpers.js';
import { makeStaff } from './offline-helpers.js';

const CSRF = { 'X-QB-CSRF': '1' };

/**
 * MQ.3 — the accessible Ask Que interface against the real stack (design §11.9; REQ-F13.1,
 * F13.3.3, F13.8; Group 13.1, 13.3, 13.4, 13.6, 13.10). Content: the MQ.2 initial delivery
 * articles (two public, two restricted).
 */

const trigger = (p: Page): Locator => p.getByTestId('ask-que');
const panel = (p: Page): Locator => p.getByTestId('que-panel');
const search = (p: Page): Locator => panel(p).getByLabel('Search help');
const articleButtons = (p: Page): Locator => panel(p).locator('.que-article-link');

async function openQue(p: Page): Promise<void> {
  await trigger(p).click();
  await expect(panel(p)).toBeVisible();
  await expect(panel(p).getByTestId('que-results')).toBeVisible();
}

const norm = (t: string): string => t.replace(/\s+/g, ' ').trim();

async function titles(p: Page): Promise<string[]> {
  return (await articleButtons(p).allInnerTexts()).map(norm);
}

/** Every button in the panel is a help control; nothing can operate the queue. */
async function expectReadOnlyControls(p: Page): Promise<void> {
  const names = (await panel(p).getByRole('button').allTextContents()).map(norm);
  const articles = new Set(await titles(p));
  for (const n of names) {
    expect(
      ['Close Ask Que help', 'Close', 'Back to results', 'Try again'].includes(n) ||
        articles.has(n),
      `unexpected control in Ask Que: "${n}"`,
    ).toBe(true);
  }
  await expect(
    panel(p).locator('form[action], input[type="submit"], select, textarea'),
  ).toHaveCount(0);
}

test.describe('MQ.3 presentation and keyboard (desktop panel, mobile sheet)', () => {
  test('@responsive the Ask Que button is on every screen; panel or sheet opens, is accessible and closes with Escape', async ({
    page,
  }) => {
    const org = await apiSignup(page.request);
    const fac = await apiFacility(page.request, 'Que Clinic');
    for (const path of ['/', '/recover', `/join/${org.slug}/${fac.slug}`, '/login']) {
      await page.goto(path);
      await expect(trigger(page)).toBeVisible();
    }
    await page.goto('/recover');
    const mobile = (page.viewportSize()?.width ?? 1280) <= 640;
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute('data-mode', mobile ? 'sheet' : 'panel');
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    // Focus moves into the panel, to the labelled search field
    await expect(search(page)).toBeFocused();
    await expect(panel(page).getByRole('heading', { name: 'Ask Que' })).toBeVisible();
    await expect(panel(page).getByRole('search')).toBeVisible();
    await expectNoA11yViolations(page);
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await expectReadOnlyControls(page);

    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('@responsive the mobile sheet keeps keyboard focus inside and its Close button returns focus', async ({
    page,
  }) => {
    test.skip((page.viewportSize()?.width ?? 1280) > 640, 'sheet behaviour applies to phones');
    await page.goto('/recover');
    await openQue(page);
    await expect(panel(page)).toHaveAttribute('data-mode', 'sheet');
    // Tab many times: focus never leaves the sheet
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await panel(page).evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    expect(await panel(page).evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await panel(page).getByRole('button', { name: 'Close Ask Que help' }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });

  test('the desktop panel is non-modal: the page stays usable and the button toggles it closed', async ({
    page,
  }) => {
    test.skip((page.viewportSize()?.width ?? 1280) <= 640, 'desktop behaviour');
    await page.goto('/recover');
    await openQue(page);
    await expect(panel(page)).toHaveAttribute('data-mode', 'panel');
    // The page behind is not inert: its controls remain reachable
    await page.getByRole('link', { name: 'Sign in' }).first().focus();
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeFocused();
    await trigger(page).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });
});

test.describe('MQ.3 focus and keyboard edge cases', () => {
  test('a failed panel load returns focus to the button, and the next open recovers', async ({
    page,
  }) => {
    await page.goto('/recover');
    await page.route('**/assets/QuePanel-*.js', (r) => r.abort());
    await trigger(page).click();
    const unavailable = page.getByTestId('que-unavailable');
    await expect(unavailable).toContainText('Help could not be opened');
    await unavailable.getByRole('button', { name: 'Close' }).click();
    await expect(unavailable).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    // The chunk is reachable again: the next open loads it (a fresh import, not the failed one)
    await page.unroute('**/assets/QuePanel-*.js');
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    await expect(search(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger(page)).toBeFocused();
  });

  test('keyboard only: search, open an article, go back, close', async ({ page }) => {
    await page.goto('/recover');
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(search(page)).toBeFocused();
    await page.keyboard.type('recovery key');
    await expect(panel(page).getByRole('heading', { name: 'Results' })).toBeVisible();
    // Tab moves from the search field to the first result; Enter opens it
    await page.keyboard.press('Tab');
    await expect(articleButtons(page).first()).toBeFocused();
    const first = norm(await articleButtons(page).first().innerText());
    await page.keyboard.press('Enter');
    const article = panel(page).getByTestId('que-article');
    await expect(article.getByRole('heading', { level: 3, name: first })).toBeFocused();
    // Tab reaches "Back to results" (after any body links); Enter returns to the search field
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      if (
        await article
          .getByRole('button', { name: 'Back to results' })
          .evaluate((b) => b === document.activeElement)
      )
        break;
    }
    await expect(article.getByRole('button', { name: 'Back to results' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(search(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });

  test('desktop: with the panel open, Sign out stays visible, uncovered and usable', async ({
    browser,
    page,
  }) => {
    test.skip((page.viewportSize()?.width ?? 1280) <= 640, 'desktop behaviour');
    await apiSignup(page.request);
    const fac = await apiFacility(page.request);
    const staff = await makeStaff(browser, page.request, fac.id, 'supervisor');
    const p = staff.page;
    await p.goto('/staff');
    await openQue(p);
    const signOut = p.getByRole('button', { name: 'Sign out' });
    await expect(signOut).toBeVisible();
    // Nothing covers the button: the element at its centre is the button itself
    const covered = await signOut.evaluate((b) => {
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !(top === b || b.contains(top));
    });
    expect(covered).toBe(false);
    await signOut.focus();
    await expect(signOut).toBeFocused();
    await p.keyboard.press('Enter');
    await expect(
      p.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Sign in' }),
    ).toBeVisible();
    await staff.ctx.close();
  });
});

test.describe('MQ.3 deterministic help for visitors', () => {
  test('screen context, search, article view, live announcement and safe links', async ({
    page,
  }) => {
    await page.goto('/recover');
    await openQue(page);
    await expect(panel(page).getByRole('heading', { name: 'On this screen' })).toBeVisible();
    expect(await titles(page)).toEqual([
      'Recovering your ticket on another phone',
      'Getting help from staff without your recovery key',
    ]);
    await expect(panel(page).getByTestId('que-source')).toHaveText('Built-in help');
    await expect(panel(page).getByTestId('que-version')).toHaveText(/^Help version \d+$/);
    await expect(panel(page).getByTestId('que-access')).toHaveCount(0); // visitors: public help only

    await search(page).fill('lost recovery key');
    await expect(panel(page).getByRole('heading', { name: 'Results' })).toBeVisible();
    await expect(panel(page).getByTestId('que-live')).toHaveText(/help articles? found\./);
    await articleButtons(page)
      .filter({ hasText: 'Recovering your ticket on another phone' })
      .click();
    const article = panel(page).getByTestId('que-article');
    await expect(article.getByRole('heading', { level: 3 })).toBeFocused();
    await expect(article.getByRole('listitem').first()).toBeVisible();
    // The body link to ticket recovery is permitted for anyone; nothing else is linked
    await expect(article.getByRole('link', { name: 'ticket recovery' })).toHaveAttribute(
      'href',
      '/recover',
    );
    await article.getByRole('button', { name: 'Back to results' }).click();
    await expect(search(page)).toBeFocused();
    await expectReadOnlyControls(page);
  });

  test('empty results say so and point to staff', async ({ page }) => {
    await page.goto('/');
    await openQue(page);
    await search(page).fill('zzqx unrelated words');
    await expect(panel(page).getByTestId('que-lead')).toContainText(
      'No help article matched your question.',
    );
    await expect(panel(page).getByTestId('que-lead')).toContainText('ask a member of staff');
    await expect(panel(page).getByTestId('que-live')).toHaveText(
      'No help article matched. Try other words, or ask a member of staff.',
    );
  });

  test('D4 and role isolation: visitors never see staff help or the verification questions', async ({
    page,
  }) => {
    await page.goto('/recover');
    await openQue(page);
    for (const q of [
      'verification questions',
      'correct service join time',
      'sync committed needs review',
      'staff',
    ]) {
      await search(page).fill(q);
      await expect(panel(page).getByTestId('que-lead')).toBeVisible();
      for (const t of await titles(page)) {
        expect([
          'Recovering your ticket on another phone',
          'Getting help from staff without your recovery key',
        ]).toContain(t);
      }
    }
    expect((await panel(page).innerText()).toLowerCase()).not.toContain('correct service');
  });

  test('loading failure shows a retry; retry recovers', async ({ page }) => {
    await page.route('**/api/v1/que/kb/public', (r) => r.abort());
    await page.route('**/assets/visitor-*.json', (r) => r.abort());
    await page.goto('/');
    await trigger(page).click();
    const failed = panel(page).getByTestId('que-failed');
    await expect(failed).toContainText('Built-in help could not be loaded');
    await page.unroute('**/api/v1/que/kb/public');
    await page.unroute('**/assets/visitor-*.json');
    await failed.getByRole('button', { name: 'Try again' }).click();
    await expect(panel(page).getByTestId('que-failed')).toHaveCount(0);
    await expect(panel(page).getByTestId('que-results')).toBeVisible();
  });

  test('the built-in copy is used when the server copy is unavailable', async ({ page }) => {
    await page.route('**/api/v1/que/kb/public', (r) => r.abort());
    await page.goto('/recover');
    await openQue(page);
    await expect(panel(page).getByTestId('que-source')).toHaveText(
      'Built-in help (saved with this app)',
    );
    expect(await titles(page)).toHaveLength(2);
  });

  test('the /supervisor placeholder gets no screen help and is never linked', async ({ page }) => {
    await page.goto('/supervisor/anything');
    await openQue(page);
    await expect(panel(page).getByTestId('que-lead')).toContainText(
      'No help is listed for this screen yet',
    );
    await search(page).fill('recovery staff sync');
    await expect(panel(page).locator('a[href^="/supervisor"]')).toHaveCount(0);
  });
});

test.describe('MQ.3 capability messaging (decision D1)', () => {
  test('a capability that is not set up is never offered; an unavailable manifest fails closed', async ({
    page,
  }) => {
    await page.route('**/api/v1/que/capabilities', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { capabilities: Record<string, unknown> };
      body.capabilities['staff_assisted_recovery'] = {
        status: 'live',
        availability: 'unavailable',
        unavailableReason: 'switched_off',
      };
      await route.fulfill({ response: res, json: body });
    });
    await page.goto('/recover');
    await openQue(page);
    expect(await titles(page)).toEqual(['Recovering your ticket on another phone']);
    await search(page).fill('ask staff no key help');
    await expect(panel(page).getByTestId('que-notices')).toContainText(
      'Staff-assisted ticket recovery: not set up here.',
    );
    expect(await titles(page)).not.toContain('Getting help from staff without your recovery key');

    // No manifest at all: every capability-dependent article is withheld
    await page.unroute('**/api/v1/que/capabilities');
    await page.route('**/api/v1/que/capabilities', (r) =>
      r.fulfill({ status: 503, json: { title: 'down' } }),
    );
    await page.reload();
    await openQue(page);
    expect(await titles(page)).toEqual([]);
    await search(page).fill('recover key');
    await expect(panel(page).getByTestId('que-notices')).toContainText('not available here');
  });
});

test.describe('MQ.3 staff help: roles, links and invalidation', () => {
  test('counter staff: restricted help on the console, permitted links only, required role named', async ({
    browser,
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    const p = staff.page;
    const que: string[] = [];
    p.on('request', (r) => {
      if (r.url().includes('/api/v1/que')) que.push(r.method());
    });
    await p.goto(`/staff/queues/${s.queueId}`);
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('General Consultation');
    await openQue(p);
    await expect(panel(p).getByTestId('que-access')).toHaveText(
      'Includes staff help for your roles.',
    );
    expect(await titles(p)).toEqual(
      expect.arrayContaining([
        'What the sync states mean',
        'Helping a visitor who has no recovery key',
      ]),
    );
    await search(p).fill('sync states');
    // The console is linked (facility known from the screen); connectivity needs other roles
    await expect(
      panel(p).getByTestId('que-links').getByRole('link', { name: 'Queue console' }),
    ).toHaveAttribute('href', `/staff/queues/${s.queueId}`);
    await expect(panel(p).locator(`a[href*="/connectivity"]`)).toHaveCount(0);
    await expect(panel(p).getByTestId('que-notices')).toContainText(
      'Opening connectivity and recovery needs one of these roles: Supervisor, Facility administrator, Auditor (read-only), Organization administrator.',
    );
    // Pressing Enter in the search sends nothing
    await search(p).press('Enter');
    await expectReadOnlyControls(p);
    expect(new Set(que)).toEqual(new Set(['GET']));
    await staff.ctx.close();
  });

  test('supervisor: a permitted link navigates and the desktop panel follows the new screen', async ({
    browser,
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'supervisor');
    const p = staff.page;
    await p.goto(`/staff/queues/${s.queueId}`);
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('General Consultation');
    await openQue(p);
    await search(p).fill('sync states');
    await panel(p).getByRole('link', { name: 'Connectivity and recovery' }).click();
    await expect(p).toHaveURL(new RegExp(`/staff/facilities/${s.facility.id}/connectivity$`));
    await expect(panel(p)).toBeVisible();
    await search(p).fill('');
    await expect(panel(p).getByRole('heading', { name: 'On this screen' })).toBeVisible();
    expect(await titles(p)).toContain('What the sync states mean');
    await staff.ctx.close();
  });

  test('an open panel follows revalidation: "checking" first, then staff help, without reopening', async ({
    browser,
    page,
  }) => {
    await apiSignup(page.request);
    const fac = await apiFacility(page.request);
    const staff = await makeStaff(browser, page.request, fac.id, 'staff_counter');
    const p = staff.page;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    await p.route(/\/api\/v1\/que\/kb(\?.*)?$/, async (route) => {
      await held;
      await route.continue();
    });
    await p.goto('/staff');
    await openQue(p);
    await expect(panel(p).getByTestId('que-access')).toHaveText('Checking your staff help…');
    await search(p).fill('sync states');
    expect(await titles(p)).not.toContain('What the sync states mean');
    release();
    await expect(panel(p).getByTestId('que-access')).toHaveText(
      'Includes staff help for your roles.',
    );
    await expect.poll(() => titles(p)).toContain('What the sync states mean');
    await staff.ctx.close();
  });

  test('auditors never get the staff-assisted recovery procedure', async ({ browser, page }) => {
    await apiSignup(page.request);
    const fac = await apiFacility(page.request);
    const staff = await makeStaff(browser, page.request, fac.id, 'auditor');
    await staff.page.goto('/staff');
    await openQue(staff.page);
    await expect(panel(staff.page).getByTestId('que-access')).toHaveText(
      'Includes staff help for your roles.',
    );
    await search(staff.page).fill('verification recovery no key');
    expect(await titles(staff.page)).not.toContain('Helping a visitor who has no recovery key');
    await staff.ctx.close();
  });

  test('sign-out, deactivation (401) and a role change update what Que shows', async ({
    browser,
    page,
  }) => {
    await apiSignup(page.request);
    const fac = await apiFacility(page.request);
    const staff = await makeStaff(browser, page.request, fac.id, 'auditor');
    const p = staff.page;
    await p.goto('/staff');
    await openQue(p);
    await search(p).fill('verification recovery no key');
    expect(await titles(p)).not.toContain('Helping a visitor who has no recovery key');
    await panel(p).getByRole('button', { name: 'Close Ask Que help' }).click();

    // Role change: granted reception → the procedure appears after the next confirmed session
    const grant = await page.request.post(
      `/api/v1/facilities/${fac.id}/staff/${staff.userId}/roles`,
      {
        headers: CSRF,
        data: { role: 'staff_reception' },
      },
    );
    expect([200, 201]).toContain(grant.status());
    await p.reload();
    await openQue(p);
    await search(p).fill('verification recovery no key');
    await expect.poll(() => titles(p)).toContain('Helping a visitor who has no recovery key');
    await panel(p).getByRole('button', { name: 'Close Ask Que help' }).click();

    // Sign-out: only public help remains
    await p.getByRole('button', { name: 'Sign out' }).click();
    await expect(
      p.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Sign in' }),
    ).toBeVisible();
    await openQue(p);
    await expect(panel(p).getByTestId('que-access')).toHaveCount(0);
    await search(p).fill('sync states verification');
    expect(await titles(p)).not.toContain('What the sync states mean');
    expect(await titles(p)).not.toContain('Helping a visitor who has no recovery key');
    await staff.ctx.close();
  });

  test('a deactivated account (401) falls back to public help', async ({ browser, page }) => {
    await apiSignup(page.request);
    const fac = await apiFacility(page.request);
    const staff = await makeStaff(browser, page.request, fac.id, 'staff_counter');
    const p = staff.page;
    await p.goto('/staff');
    await openQue(p);
    await expect(panel(p).getByTestId('que-access')).toHaveText(
      'Includes staff help for your roles.',
    );
    await panel(p).getByRole('button', { name: 'Close Ask Que help' }).click();
    const r = await page.request.patch(`/api/v1/staff/${staff.userId}`, {
      headers: CSRF,
      data: { status: 'inactive' },
    });
    expect(r.status()).toBe(200);
    await p.reload();
    await openQue(p);
    await expect(panel(p).getByTestId('que-access')).toHaveCount(0);
    await search(p).fill('sync states');
    expect(await titles(p)).not.toContain('What the sync states mean');
    await staff.ctx.close();
  });
});

test.describe('MQ.3 offline', () => {
  test('@pwa staff help works offline with an Offline badge and returns to normal on reconnect', async ({
    browser,
    page,
  }) => {
    await apiSignup(page.request);
    const fac = await apiFacility(page.request);
    const staff = await makeStaff(browser, page.request, fac.id, 'staff_counter', {
      serviceWorkers: 'allow',
    });
    const p = staff.page;
    await p.goto('/staff');
    await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await p.reload();
    await expect
      .poll(() => p.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    // Online once: the restricted bundle is cached for this user
    await openQue(p);
    await expect(panel(p).getByTestId('que-access')).toHaveText(
      'Includes staff help for your roles.',
    );
    await panel(p).getByRole('button', { name: 'Close Ask Que help' }).click();

    await staff.ctx.setOffline(true);
    await p.reload();
    await expect(p.getByTestId('connection-state')).toContainText('Offline');
    await openQue(p);
    await expect(panel(p).getByTestId('que-offline')).toHaveText('Offline');
    await expect(panel(p).getByTestId('que-offline-note')).toBeVisible();
    await search(p).fill('sync states');
    expect(await titles(p)).toContain('What the sync states mean');
    await search(p).fill('recover key');
    expect(await titles(p)).toContain('Recovering your ticket on another phone');
    await panel(p).getByRole('button', { name: 'Close Ask Que help' }).click();

    await staff.ctx.setOffline(false);
    await expect(p.getByTestId('connection-state')).not.toContainText('Offline', {
      timeout: 20_000,
    });
    await openQue(p);
    await expect(panel(p).getByTestId('que-offline')).toHaveCount(0);
    await staff.ctx.close();
  });

  test('@pwa a visitor who never opened Que still has help offline (warmed up while online)', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ serviceWorkers: 'allow' });
    const p = await ctx.newPage();
    await p.goto('/recover');
    await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await p.reload();
    await expect
      .poll(() => p.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    // The one-off warm-up has stored the public bundle and the manifest in the SW caches
    await expect
      .poll(() =>
        p.evaluate(
          async () => (await caches.has('que-capabilities')) && (await caches.has('que-public-kb')),
        ),
      )
      .toBe(true);
    await ctx.setOffline(true);
    await p.reload();
    await openQue(p);
    await expect(panel(p).getByTestId('que-offline')).toHaveText('Offline');
    expect(await titles(p)).toEqual([
      'Recovering your ticket on another phone',
      'Getting help from staff without your recovery key',
    ]);
    await ctx.close();
  });

  test('@pwa offline with no manifest ever fetched: capability-dependent help is withheld (fail closed)', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ serviceWorkers: 'allow' });
    const p = await ctx.newPage();
    await ctx.route('**/api/v1/que/capabilities', (r) => r.abort());
    await p.goto('/recover');
    await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await p.reload();
    await expect
      .poll(() => p.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    await ctx.setOffline(true);
    await p.reload();
    await openQue(p);
    expect(await titles(p)).toEqual([]);
    await search(p).fill('recover key');
    await expect(panel(p).getByTestId('que-notices')).toContainText('not available here');
    await ctx.close();
  });
});
