import { expect, test, type Page } from '@playwright/test';
import { apiFacility, apiSignup, PASSWORD, uid } from './helpers.js';
import { makeStaff } from './offline-helpers.js';

const CSRF = { 'X-QB-CSRF': '1' };

/**
 * MQ.2 — Ask Que knowledge-base delivery and offline support in a real browser against the real
 * stack (design §11.5; decision D2). The articles are the committed initial delivery content.
 */

interface StoredBundle {
  userId: string;
  roleDigest: string;
  audiences: string[];
  articles: { id: string; audiences: string[] }[];
  receivedAtLocalMs: number;
  highWaterLocalMs: number;
}

/** Restricted Ask Que records in IndexedDB (never creates the database itself). */
async function queRecords(page: Page): Promise<StoredBundle[]> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === 'queuebridge-que')) return [];
    return new Promise<StoredBundle[]>((resolve) => {
      const open = indexedDB.open('queuebridge-que');
      open.onerror = (): void => resolve([]);
      open.onsuccess = (): void => {
        const db = open.result;
        if (!db.objectStoreNames.contains('restricted')) {
          db.close();
          resolve([]);
          return;
        }
        const req = db.transaction('restricted').objectStore('restricted').getAll();
        req.onsuccess = (): void => {
          db.close();
          resolve(req.result as StoredBundle[]);
        };
        req.onerror = (): void => {
          db.close();
          resolve([]);
        };
      };
    });
  });
}

const ids = (r: StoredBundle | undefined): string[] => (r?.articles ?? []).map((a) => a.id).sort();

async function waitForRecord(page: Page, userId: string): Promise<StoredBundle> {
  await expect.poll(async () => (await queRecords(page)).map((r) => r.userId)).toEqual([userId]);
  return (await queRecords(page))[0]!;
}

async function controlledBySw(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}

async function cacheKeys(page: Page, cacheName: string): Promise<string[]> {
  return page.evaluate(async (name) => {
    if (!(await caches.has(name))) return [];
    return (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
  }, cacheName);
}

test.describe('MQ.2 restricted help: per-user cache and invalidation', () => {
  test('caches only the server bundle for this user, with no tenant data and no SW copy', async ({
    browser,
    page,
  }) => {
    const org = await apiSignup(page.request, 'Que Org');
    const fac = await apiFacility(page.request, 'Que Clinic');
    const staff = await makeStaff(browser, page.request, fac.id, 'staff_counter');
    const que: string[] = [];
    staff.page.on('request', (r) => {
      if (r.url().includes('/api/v1/que/')) que.push(r.method());
    });
    await staff.page.goto('/staff');
    const rec = await waitForRecord(staff.page, staff.userId);
    expect(rec.audiences).toEqual(['counter']);
    expect(ids(rec)).toEqual(['staff.recovery.assist', 'staff.sync.states']);
    expect(rec.roleDigest).toMatch(/^[0-9a-f]{64}$/);
    for (const a of rec.articles) expect(a.audiences).not.toContain('visitor');
    const raw = JSON.stringify(rec);
    for (const v of [staff.email, org.email, org.slug, fac.slug, fac.id, 'Que Clinic', 'Que Org']) {
      expect(raw).not.toContain(v);
    }
    // Read-only: Ask Que only ever issues GET requests
    expect(que.length).toBeGreaterThan(0);
    expect(new Set(que)).toEqual(new Set(['GET']));
    await staff.ctx.close();
  });

  test('confirmed sign-out deletes restricted help', async ({ browser, page }) => {
    await apiSignup(page.request);
    const fac = await apiFacility(page.request);
    const staff = await makeStaff(browser, page.request, fac.id, 'supervisor');
    await staff.page.goto('/staff');
    await waitForRecord(staff.page, staff.userId);
    await staff.page.getByRole('button', { name: 'Sign out' }).click();
    await expect(
      staff.page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link', { name: 'Sign in' }),
    ).toBeVisible();
    await expect.poll(() => queRecords(staff.page)).toEqual([]);
    await staff.ctx.close();
  });

  test('a deactivated account (401) loses its restricted help at the next contact', async ({
    browser,
    page,
  }) => {
    await apiSignup(page.request);
    const fac = await apiFacility(page.request);
    const staff = await makeStaff(browser, page.request, fac.id, 'staff_reception');
    await staff.page.goto('/staff');
    await waitForRecord(staff.page, staff.userId);
    const r = await page.request.patch(`/api/v1/staff/${staff.userId}`, {
      headers: CSRF,
      data: { status: 'inactive' },
    });
    expect(r.status()).toBe(200);
    await staff.page.reload();
    await expect.poll(() => queRecords(staff.page)).toEqual([]);
    await staff.ctx.close();
  });

  test('a role change replaces the bundle under a new server fingerprint', async ({
    browser,
    page,
  }) => {
    await apiSignup(page.request);
    const fac = await apiFacility(page.request);
    const staff = await makeStaff(browser, page.request, fac.id, 'auditor');
    await staff.page.goto('/staff');
    const before = await waitForRecord(staff.page, staff.userId);
    expect(ids(before)).toEqual(['staff.sync.states']);

    const grant = await page.request.post(
      `/api/v1/facilities/${fac.id}/staff/${staff.userId}/roles`,
      {
        headers: CSRF,
        data: { role: 'staff_reception' },
      },
    );
    expect([200, 201]).toContain(grant.status());
    await staff.page.reload();
    await expect
      .poll(async () => ids((await queRecords(staff.page))[0]))
      .toEqual(['staff.recovery.assist', 'staff.sync.states']);
    const granted = (await queRecords(staff.page))[0]!;
    expect(granted.roleDigest).not.toBe(before.roleDigest);

    const revoke = await page.request.delete(
      `/api/v1/facilities/${fac.id}/staff/${staff.userId}/roles/staff_reception`,
      { headers: CSRF },
    );
    expect([200, 204]).toContain(revoke.status());
    await staff.page.reload();
    await expect
      .poll(async () => ids((await queRecords(staff.page))[0]))
      .toEqual(['staff.sync.states']);
    expect((await queRecords(staff.page))[0]!.roleDigest).toBe(before.roleDigest);
    await staff.ctx.close();
  });

  test('a different user signing in on the same browser removes the previous user’s help', async ({
    browser,
    page,
  }) => {
    await apiSignup(page.request);
    const fac = await apiFacility(page.request);
    const first = await makeStaff(browser, page.request, fac.id, 'staff_counter');
    await first.page.goto('/staff');
    await waitForRecord(first.page, first.userId);
    // A second person accepts an invitation in the SAME browser (the session cookie is replaced)
    const email = `second-${uid('u')}@example.test`;
    const inv = await page.request.post(`/api/v1/facilities/${fac.id}/invitations`, {
      headers: CSRF,
      data: { email, role: 'supervisor' },
    });
    const { token } = (await inv.json()) as { token: string };
    const acc = await first.page.request.post('/api/v1/invitations/accept', {
      headers: CSRF,
      data: { token, display_name: 'Second person', password: PASSWORD },
    });
    expect(acc.status()).toBe(201);
    const { user } = (await acc.json()) as { user: { id: string } };
    await first.page.reload();
    await expect
      .poll(async () => (await queRecords(first.page)).map((r) => r.userId))
      .toEqual([user.id]);
    await first.ctx.close();
  });
});

test.describe('MQ.2 offline delivery through the service worker', () => {
  test('@pwa restricted help survives an offline reload and is revalidated on reconnection', async ({
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
    await waitForRecord(p, staff.userId);
    await controlledBySw(p);
    // An online session revalidation may still be finishing after the SW takes control.
    // Do not snapshot the receipt until the browser is actually offline.

    // The restricted bundle is never in the service-worker caches (IndexedDB only)
    const all = await p.evaluate(async () => {
      const out: string[] = [];
      for (const name of await caches.keys()) {
        for (const r of await (await caches.open(name)).keys())
          out.push(new URL(r.url).pathname + new URL(r.url).search);
      }
      return out;
    });
    expect(
      all.filter((u) => u.startsWith('/api/v1/que/kb') && !u.startsWith('/api/v1/que/kb/public')),
    ).toEqual([]);
    expect(all.filter((u) => u.startsWith('/api/v1/auth'))).toEqual([]);

    await staff.ctx.setOffline(true);
    // The invariant is that an offline reload does not reissue or rewrite restricted help.
    // Take the baseline after disconnect to exclude an in-flight ONLINE revalidation.
    const atDisconnection = await waitForRecord(p, staff.userId);
    await p.reload();
    await expect(p.getByTestId('connection-state')).toContainText('Offline');
    const offline = await waitForRecord(p, staff.userId);
    expect(offline.receivedAtLocalMs).toBe(atDisconnection.receivedAtLocalMs);
    expect(ids(offline)).toEqual(ids(atDisconnection));

    // Reconnection: the session is re-verified and the bundle revalidated (fresh receipt time)
    await staff.ctx.setOffline(false);
    await expect
      .poll(async () => (await queRecords(p))[0]?.receivedAtLocalMs ?? 0, { timeout: 20_000 })
      .toBeGreaterThan(atDisconnection.receivedAtLocalMs);
    expect((await queRecords(p))[0]!.roleDigest).toBe(atDisconnection.roleDigest);
    await staff.ctx.close();
  });

  test('@pwa the public bundle is precached and the public KB endpoint is served offline', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ serviceWorkers: 'allow' });
    const p = await ctx.newPage();
    await p.goto('/');
    await controlledBySw(p);
    // Built-in copy: a hashed JSON asset in the precache, and a valid public-only bundle
    const precached = await p.evaluate(async () => {
      for (const name of await caches.keys()) {
        for (const r of await (await caches.open(name)).keys()) {
          if (/\/assets\/visitor-[^/]+\.json/.test(r.url)) {
            const body = (await (await (await caches.open(name)).match(r))!.json()) as {
              audience: string;
              articles: { id: string; audiences: string[] }[];
            };
            return body;
          }
        }
      }
      return null;
    });
    expect(precached?.audience).toBe('visitor');
    expect(precached!.articles.length).toBeGreaterThan(0);
    for (const a of precached!.articles) expect(a.audiences).toContain('visitor');
    expect(JSON.stringify(precached).toLowerCase()).not.toContain('correct service');

    // Runtime copy: fetched once online, then answered by the service worker offline
    const first = await p.evaluate(async () => (await fetch('/api/v1/que/kb/public')).status);
    expect(first).toBe(200);
    await expect.poll(() => cacheKeys(p, 'que-public-kb')).toEqual(['/api/v1/que/kb/public']);
    await ctx.setOffline(true);
    const offline = await p.evaluate(async () => {
      const r = await fetch('/api/v1/que/kb/public');
      return { status: r.status, audience: ((await r.json()) as { audience: string }).audience };
    });
    expect(offline).toEqual({ status: 200, audience: 'visitor' });
    await ctx.close();
  });

  test('@pwa corrected rule: public facility details are cached; the live board and stream are not', async ({
    browser,
    page,
  }) => {
    const org = await apiSignup(page.request);
    const fac = await apiFacility(page.request, 'Rule Clinic');
    const ctx = await browser.newContext({ serviceWorkers: 'allow' });
    const p = await ctx.newPage();
    await p.goto(`/join/${org.slug}/${fac.slug}`);
    await controlledBySw(p);
    await expect(p.getByRole('heading', { level: 1 })).toContainText('Rule Clinic');
    const path = `/api/v1/public/facilities/${org.slug}/${fac.slug}`;
    await expect.poll(() => cacheKeys(p, 'facility-public-data')).toEqual([path]);
    // Fetch the board too, then confirm only the facility details were cached
    await p.evaluate(async (u) => (await fetch(`${u}/board`)).status, path);
    expect(await cacheKeys(p, 'facility-public-data')).toEqual([path]);

    await ctx.setOffline(true);
    const offline = await p.evaluate(async (u) => {
      const r = await fetch(u);
      return { status: r.status, body: JSON.stringify(await r.json()) };
    }, path);
    expect(offline.status).toBe(200);
    expect(offline.body).toContain('Rule Clinic');
    await ctx.close();
  });
});
