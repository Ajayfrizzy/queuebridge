import postgres from 'postgres';
import { expect, test } from '@playwright/test';
import { apiFacility, apiSignup, expectNoA11yViolations, uid } from './helpers.js';

const CSRF = { 'X-QB-CSRF': '1' };

test.describe('logout is only shown as complete after the server confirms it', () => {
  test('network failure: user stays signed in, gets an accessible error with retry, and the session still works', async ({
    page,
  }) => {
    await apiSignup(page.request);
    await apiFacility(page.request, 'Shared Device Clinic');
    await page.goto('/admin');
    await expect(page.getByTestId('whoami')).toBeVisible();

    await page.route('**/api/v1/auth/logout', (route) => route.abort('connectionrefused'));
    await page.getByRole('button', { name: 'Sign out' }).click();

    const alert = page.getByTestId('logout-error');
    await expect(alert).toBeVisible();
    await expect(alert).toBeFocused();
    await expect(alert).toContainText('still signed in');
    await expect(alert).toContainText('could not reach the server');
    // Nothing pretends to be signed out
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId('whoami')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Shared Device Clinic' })).toBeVisible();
    await expectNoA11yViolations(page);
    // The server session is genuinely still valid (this is exactly why the UI must not lie)
    await page.reload();
    await expect(page.getByTestId('whoami')).toBeVisible();
  });

  test('server error (500) is also a failure; retry succeeds once the server confirms', async ({
    page,
  }) => {
    await apiSignup(page.request);
    await page.goto('/admin');
    let calls = 0;
    await page.route('**/api/v1/auth/logout', (route) => {
      calls += 1;
      if (calls === 1)
        return route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: '{"title":"Internal server error","status":500}',
        });
      return route.continue();
    });
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByTestId('logout-error')).toContainText(
      'server could not end your session',
    );
    await expect(page.getByTestId('whoami')).toBeVisible();

    await page.getByRole('button', { name: 'Retry sign out' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('logout-error')).toHaveCount(0);
    await expect(
      page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Sign in' }),
    ).toBeVisible();
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
    expect(calls).toBe(2);
  });

  test('the notice can be dismissed without signing out', async ({ page }) => {
    await apiSignup(page.request);
    await page.goto('/admin');
    await page.route('**/api/v1/auth/logout', (route) => route.abort('failed'));
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('logout-error')).toHaveCount(0);
    await expect(page.getByTestId('whoami')).toBeVisible();
  });

  test('when the server says there is no session (401) the user is genuinely signed out', async ({
    page,
  }) => {
    await apiSignup(page.request);
    await page.goto('/admin');
    await page.route('**/api/v1/auth/logout', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: '{"title":"Authentication required","status":401}',
      }),
    );
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('logout-error')).toHaveCount(0);
    await expect(page.getByTestId('session-ended')).toHaveCount(0);
    await expect(
      page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Sign in' }),
    ).toBeVisible();
  });

  test('a normal sign out still works and destroys the server session', async ({ page }) => {
    await apiSignup(page.request);
    await page.goto('/admin');
    const cookie =
      (await page.context().cookies()).find((c) => c.name === 'qb_session')?.value ?? '';
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/$/);
    const replay = await page.request.get('/api/v1/auth/me', {
      headers: { Cookie: `qb_session=${cookie}` },
    });
    expect(replay.status()).toBe(401);
  });
});

test.describe('expired invitations can be replaced from the UI', () => {
  test('re-inviting after expiry succeeds and the old invitation moves to history', async ({
    page,
  }) => {
    const dbUrl = process.env['TEST_DATABASE_URL'];
    expect(dbUrl, 'TEST_DATABASE_URL is required to age an invitation').toBeTruthy();
    await apiSignup(page.request);
    const fac = await apiFacility(page.request, 'Invite Clinic');
    const email = `${uid('exp')}@example.test`;

    await page.goto(`/admin/facilities/${fac.id}/staff`);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Create invitation' }).click();
    await expect(page.getByTestId('invite-result')).toBeVisible();
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Create invitation' }).click();
    await expect(page.getByTestId('error-summary')).toContainText('pending invitation'); // still deduplicated

    const sql = postgres(dbUrl ?? '', { max: 1, onnotice: () => undefined });
    try {
      await sql`UPDATE staff_invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE email = ${email}`;
    } finally {
      await sql.end();
    }

    await page.reload();
    await expect(page.getByTestId('no-pending')).toBeVisible();
    await expect(page.getByTestId('invitation-history')).toContainText('expired');

    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Create invitation' }).click();
    await expect(page.getByTestId('invite-result')).toBeVisible();
    await expect(page.getByTestId('error-summary')).toHaveCount(0);
    await expect(page.getByTestId('pending-invitations')).toContainText(email);
    await expect(page.getByTestId('invitation-history')).toContainText('revoked');
  });
});

test.describe('out-of-order responses never show stale data', () => {
  test('a slow older counters response cannot undo a newer change', async ({ page }) => {
    await apiSignup(page.request);
    const fac = await apiFacility(page.request, 'Race Clinic');
    const mk = async (path: string, name: string): Promise<string> => {
      const r = await page.request.post(`/api/v1/facilities/${fac.id}/${path}`, {
        headers: CSRF,
        data: { name },
      });
      const b = (await r.json()) as Record<string, { id: string }>;
      return (b['service'] ?? b['counter'])?.id ?? '';
    };
    await mk('services', 'Alpha Service');
    await mk('services', 'Beta Service');
    await mk('counters', 'Only Counter');

    await page.goto(`/admin/facilities/${fac.id}/counters`);
    await expect(page.getByTestId('counter-item')).toHaveCount(1);

    // Hold back the FIRST post-change counters list (a stale snapshot) until the second change finished
    let counterGets = 0;
    let staleDelivered = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(`**/api/v1/facilities/${fac.id}/counters`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      counterGets += 1;
      if (counterGets === 1) {
        const stale = await route.fetch(); // snapshot taken NOW (only Alpha assigned)
        await gate;
        await route.fulfill({ response: stale });
        staleDelivered = true;
        return undefined;
      }
      return route.continue();
    });

    const card = page.getByTestId('counter-item');
    const first = page.waitForResponse(
      (r) => r.url().includes('/counter_service_capabilities') && r.request().method() === 'POST',
    );
    await card.getByRole('checkbox', { name: 'Alpha Service' }).check();
    await first;
    await card.getByRole('checkbox', { name: 'Beta Service' }).check();
    await expect(page.getByTestId('toast')).toContainText('Only Counter now serves Beta Service.');
    await expect.poll(() => counterGets).toBeGreaterThanOrEqual(2);

    release(); // the stale response now arrives LAST
    await expect.poll(() => staleDelivered).toBe(true);
    // let the page consume the delivered response and render (two animation frames)
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    await expect(card.getByRole('checkbox', { name: 'Alpha Service' })).toBeChecked();
    await expect(card.getByRole('checkbox', { name: 'Beta Service' })).toBeChecked();
    await page.reload();
    await expect(card.getByRole('checkbox', { name: 'Beta Service' })).toBeChecked();
  });
});
