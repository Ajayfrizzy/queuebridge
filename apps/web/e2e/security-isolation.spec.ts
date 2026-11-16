import { expect, test } from '@playwright/test';
import { PASSWORD, apiFacility, apiSignup, uid, uiLogin } from './helpers.js';

test.describe('authentication boundaries', () => {
  test('anonymous visitors are redirected away from administration', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/admin/facilities/018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b/staff');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('wrong password shows a focused, uniform error and no session', async ({ page }) => {
    const org = await apiSignup(page.request);
    await page.context().clearCookies();
    await uiLogin(page, org.slug, org.email, 'definitely-wrong-password');
    const summary = page.getByTestId('error-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toBeFocused();
    await expect(summary).toContainText('organization, email or password is incorrect');
    await expect(page).toHaveURL(/\/login$/);

    // Unknown account gives the identical message (no account enumeration)
    await uiLogin(page, org.slug, `nobody-${uid('x')}@example.test`);
    await expect(page.getByTestId('error-summary')).toContainText(
      'organization, email or password is incorrect',
    );
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
  });

  test('session cookie is HttpOnly + SameSite=Strict and invisible to page scripts', async ({
    page,
  }) => {
    await apiSignup(page.request);
    await page.goto('/admin');
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'qb_session');
    expect(session).toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Strict');
    expect(await page.evaluate(() => document.cookie)).not.toContain('qb_session');
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toMatch(/token|session/i);
  });

  test('sign out ends the server session; the back button does not resurrect data', async ({
    page,
  }) => {
    const org = await apiSignup(page.request);
    await apiFacility(page.request, 'Private Clinic');
    await page.context().clearCookies();
    await uiLogin(page, org.slug, org.email);
    await expect(page.getByRole('link', { name: 'Private Clinic' })).toBeVisible();
    const cookiesBefore = await page.context().cookies();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('Private Clinic')).toHaveCount(0);
    // Replaying the pre-logout cookie fails: the session was destroyed server-side
    const old = cookiesBefore.find((c) => c.name === 'qb_session');
    const replay = await page.request.get('/api/v1/auth/me', {
      headers: { Cookie: `qb_session=${old?.value ?? ''}` },
    });
    expect(replay.status()).toBe(401);
  });

  // M5.0 regression. On a slow device React can fold the sign-out navigation, the route guard's
  // redirect and an immediate Back into ONE render whose final location equals the first. The
  // guard used to be a one-shot <Navigate>, so it never fired again and a signed-out user was left
  // on a blank protected URL. CPU throttling makes that coalescing likely: before the fix this
  // test failed in roughly three of four cycles (31 of 40 single-cycle runs at 20x).
  test('signing out and pressing Back on a slow device never leaves a blank protected page', async ({
    page,
  }) => {
    const org = await apiSignup(page.request);
    await apiFacility(page.request, 'Private Clinic');
    for (let cycle = 1; cycle <= 4; cycle++) {
      await page.context().clearCookies();
      await uiLogin(page, org.slug, org.email);
      await expect(page.getByRole('link', { name: 'Private Clinic' })).toBeVisible();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page, `cycle ${cycle}: lands on home`).toHaveURL(/\/$/);
      await page.goBack();
      await expect(page, `cycle ${cycle}: Back to /admin bounces to sign-in`).toHaveURL(/\/login$/);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText('Private Clinic')).toHaveCount(0);
      await cdp.detach();
    }
    // The server session really ended each time
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
  });

  test('session survives a page reload', async ({ page }) => {
    await apiSignup(page.request);
    await page.goto('/admin');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Administration');
  });

  test('cross-site style API writes without the CSRF header are refused', async ({ page }) => {
    await apiSignup(page.request);
    const res = await page.request.post('/api/v1/facilities', {
      data: { name: 'No Header', slug: uid('nh') },
    });
    expect(res.status()).toBe(403);
  });
});

test.describe('cross-organization isolation (browser)', () => {
  test("organization B's admin cannot open or modify organization A's facility", async ({
    browser,
  }) => {
    // Organization A with a facility and a service
    const ctxA = await browser.newContext({ serviceWorkers: 'block' });
    const pageA = await ctxA.newPage();
    await pageA.goto('/');
    await apiSignup(pageA.request, 'Org A');
    const facA = await apiFacility(pageA.request, 'Alpha Clinic');
    const svc = await pageA.request.post(`/api/v1/facilities/${facA.id}/services`, {
      headers: { 'X-QB-CSRF': '1' },
      data: { name: 'Alpha Service' },
    });
    const serviceA = ((await svc.json()) as { service: { id: string } }).service.id;

    // Organization B
    const ctxB = await browser.newContext({ serviceWorkers: 'block' });
    const pageB = await ctxB.newPage();
    await pageB.goto('/');
    await apiSignup(pageB.request, 'Org B');
    await apiFacility(pageB.request, 'Beta Clinic');

    await pageB.goto(`/admin/facilities/${facA.id}`);
    await expect(pageB.getByRole('heading', { level: 1 })).toHaveText('Facility not found');
    await expect(pageB.getByText('Alpha Clinic')).toHaveCount(0);

    for (const path of ['services', 'counters', 'staff']) {
      await pageB.goto(`/admin/facilities/${facA.id}/${path}`);
      await expect(pageB.getByRole('heading', { level: 1 })).toHaveText('Facility not found');
    }

    // Direct API access with B's valid session to A's resources: same 404 as a made-up id
    const csrf = { 'X-QB-CSRF': '1' };
    const real = await pageB.request.patch(`/api/v1/facilities/${facA.id}/services/${serviceA}`, {
      headers: csrf,
      data: { name: 'Hijacked' },
    });
    const fake = await pageB.request.patch(
      '/api/v1/facilities/018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b/services/018d1a2b-3c4d-7e5f-8a9b-1c2d3e4f5a6b',
      { headers: csrf, data: { name: 'Hijacked' } },
    );
    expect(real.status()).toBe(404);
    expect(fake.status()).toBe(404);
    const after = await pageA.request.get(`/api/v1/facilities/${facA.id}/services`);
    const names = ((await after.json()) as { services: { name: string }[] }).services.map(
      (s) => s.name,
    );
    expect(names).toEqual(['Alpha Service']);

    // B's own dashboard only lists B's facility
    await pageB.goto('/admin');
    await expect(pageB.getByRole('link', { name: 'Beta Clinic' })).toBeVisible();
    await expect(pageB.getByRole('link', { name: 'Alpha Clinic' })).toHaveCount(0);
    await ctxA.close();
    await ctxB.close();
  });

  test('an unprivileged invitee cannot create facilities from the UI or the API', async ({
    page,
    browser,
  }) => {
    const org = await apiSignup(page.request);
    const fac = await apiFacility(page.request);
    const inv = await page.request.post(`/api/v1/facilities/${fac.id}/invitations`, {
      headers: { 'X-QB-CSRF': '1' },
      data: { email: 'aud@example.test', role: 'auditor' },
    });
    const { accept_url } = (await inv.json()) as { accept_url: string };
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const p = await ctx.newPage();
    await p.goto(accept_url);
    await p.getByLabel('Your name').fill('Audrey Auditor');
    await p.getByLabel('Password').fill(PASSWORD);
    await p.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('Administration');
    await expect(p.getByRole('button', { name: 'Create facility' })).toHaveCount(0);
    const res = await p.request.post('/api/v1/facilities', {
      headers: { 'X-QB-CSRF': '1' },
      data: { name: 'Sneaky', slug: uid('sneaky') },
    });
    expect(res.status()).toBe(403);
    void org;
    await ctx.close();
  });
});
