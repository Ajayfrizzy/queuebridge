import { expect, test, type Page } from '@playwright/test';
import { apiQueueSetup, PASSWORD } from './helpers.js';
import { makeStaff, op, storedOperations, waitForDevice } from './offline-helpers.js';

const CSRF = { 'X-QB-CSRF': '1' };

/**
 * Regression tests for PR #5 review findings (Codex P2 ×3). Every identity change here happens
 * INSIDE the running SPA (sign-in form, in-app links) — no page reload — because the defects
 * lived in state that a reload would have wiped.
 */

async function setup(
  page: Page,
): Promise<Awaited<ReturnType<typeof apiQueueSetup>> & { queueId: string }> {
  const s = await apiQueueSetup(page.request);
  if (!s.queueId) throw new Error('queue not opened');
  return { ...s, queueId: s.queueId };
}

/** Sign in through the form and reach the queue console using in-app navigation only. */
async function spaSignInAndOpenConsole(
  p: Page,
  orgSlug: string,
  email: string,
  facilityName: string,
): Promise<void> {
  await p
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Sign in' })
    .click();
  await p.getByLabel('Organization URL identifier').fill(orgSlug);
  await p.getByLabel('Email').fill(email);
  await p.getByLabel('Password').fill(PASSWORD);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await expect(p.getByTestId('whoami')).toBeVisible();
  await p
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Staff console' })
    .click();
  await p.getByRole('link', { name: facilityName }).click();
  await p.getByRole('link', { name: /Open console/ }).click();
  await expect(p.getByRole('heading', { level: 1 })).toHaveText('General Consultation');
}

test('finding 1: a second person signing in without a reload records under THEIR OWN device and syncs', async ({
  browser,
  page,
}) => {
  const s = await setup(page);
  const a = await makeStaff(browser, page.request, s.facility.id, 'staff_reception');
  const b = await makeStaff(browser, page.request, s.facility.id, 'staff_reception');
  await b.ctx.close(); // only B's credentials are needed; B signs in on A's browser
  const p = a.page;
  await p.goto(`/staff/queues/${s.queueId}`);
  const deviceA = await waitForDevice(p);

  // A signs out (nothing unsent), B signs in on the same tab — no reload
  await p.getByRole('button', { name: 'Sign out' }).click();
  await expect(p).toHaveURL(/\/$/);
  await spaSignInAndOpenConsole(p, s.org.slug, b.email, 'Queue Clinic');
  await expect(p.getByTestId('whoami')).toContainText('Staff staff_reception');
  await expect(p.locator('[data-device-ready="true"]')).toHaveCount(1);

  await a.ctx.setOffline(true);
  await p.getByRole('button', { name: 'Issue walk-in ticket' }).click();
  await expect(p.getByTestId('offline-capture-ref')).toBeVisible();
  const recorded = (await storedOperations(p)) as unknown as {
    device_id: string;
    owner_user_id: string;
  }[];
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.owner_user_id).toBe(b.userId);
  expect(recorded[0]?.device_id).not.toBe(deviceA);

  await a.ctx.setOffline(false);
  await expect(p.getByTestId('handover')).toBeVisible({ timeout: 20_000 });
  expect((await storedOperations(p)).map((o) => o.status)).toEqual(['committed']);
  await a.ctx.close();
});

test('finding 2: after the session ends, signing in again (no reload) sends the saved work', async ({
  browser,
  page,
}) => {
  const s = await setup(page);
  const a = await makeStaff(browser, page.request, s.facility.id, 'staff_reception');
  const p = a.page;
  await p.goto(`/staff/queues/${s.queueId}`);
  await waitForDevice(p);
  await a.ctx.setOffline(true);
  await p.getByRole('button', { name: 'Issue walk-in ticket' }).click();
  await expect(p.getByTestId('offline-capture-ref')).toBeVisible();

  // The server session ends while offline; reconnecting gets 401 on sync
  await a.ctx.clearCookies();
  await a.ctx.setOffline(false);
  await expect(p.getByTestId('offline-problem')).toContainText('sign-in ended', {
    timeout: 20_000,
  });
  expect((await storedOperations(p)).map((o) => o.status)).toEqual(['pending_sync']); // kept

  // Same person signs in again inside the running app (the 401 left the SPA on its sign-in path)
  await p.getByRole('link', { name: 'QueueBridge' }).click();
  await spaSignInAndOpenConsole(p, s.org.slug, a.email, 'Queue Clinic');
  await expect(p.getByTestId('handover')).toBeVisible({ timeout: 20_000 });
  expect((await storedOperations(p)).map((o) => o.status)).toEqual(['committed']);
  await expect(p.getByTestId('offline-problem')).toHaveCount(0);
  await a.ctx.close();
});

test('finding 3: an ONLINE coordinator’s action is sent with its exact authority and commits immediately', async ({
  browser,
  page,
}) => {
  const s = await setup(page);
  const j = await page.request.post(`/api/v1/queues/${s.queueId}/join`, {
    headers: CSRF,
    data: { operation_id: op(), join_proof: 'C'.repeat(43) },
  });
  expect(j.status()).toBe(201);
  const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
  const p = staff.page;
  await p.goto(`/staff/queues/${s.queueId}`);
  const deviceId = await waitForDevice(p);
  const a = await page.request.post(`/api/v1/queues/${s.queueId}/coordinator`, {
    headers: CSRF,
    data: { operation_id: op(), device_id: deviceId, ttl_minutes: 60 },
  });
  expect(a.status()).toBe(200);
  await p.reload();
  await expect(p.getByTestId('authority-active')).toBeVisible();

  // Online: the coordinator's command goes through the outbox and is flushed at once
  await p.getByRole('button', { name: 'Call next' }).click();
  await expect
    .poll(async () => (await storedOperations(p)).map((o) => o.status), { timeout: 20_000 })
    .toEqual(['committed']);
  const q = await page.request.get(`/api/v1/queues/${s.queueId}`);
  const tickets = ((await q.json()) as { queue: { tickets: { state: string }[] } }).queue.tickets;
  expect(tickets[0]?.state).toBe('called');

  // Housekeeping: once nothing unsent references an older token, only the current one is kept
  const keys = await p.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const o = indexedDB.open('queuebridge-offline');
        o.onsuccess = (): void => {
          const r = o.result.transaction('kv').objectStore('kv').getAllKeys();
          r.onsuccess = (): void => resolve(r.result as string[]);
        };
      }),
  );
  const held = keys.filter((k) => k.startsWith('auth:'));
  expect(held).toHaveLength(1);
  expect(held[0]).toMatch(new RegExp(`^auth:${s.queueId}:1:`));
  await staff.ctx.close();
});
