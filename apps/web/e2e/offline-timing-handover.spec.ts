import { expect, test, type Page } from '@playwright/test';
import { apiQueueSetup } from './helpers.js';
import { makeStaff, op, storedOperations, waitForDevice } from './offline-helpers.js';

const CSRF = { 'X-QB-CSRF': '1' };

/**
 * M3 follow-up: (1) offline authority timing against device-clock manipulation, restarts and
 * delayed sync; (2) one-time hand-over of the visitor status link after an offline capture is
 * confirmed. Real browser, real API, real PostgreSQL.
 */

/** Queue setup with an opened queue (narrowed id). */
async function setup(
  page: Page,
): Promise<Awaited<ReturnType<typeof apiQueueSetup>> & { queueId: string }> {
  const s = await apiQueueSetup(page.request);
  if (!s.queueId) throw new Error('queue not opened');
  return { ...s, queueId: s.queueId };
}

async function join(page: Page, queueId: string, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    const r = await page.request.post(`/api/v1/queues/${queueId}/join`, {
      headers: CSRF,
      data: { operation_id: op(), join_proof: String.fromCharCode(65 + i).repeat(43) },
    });
    expect(r.status()).toBe(201);
  }
}

async function designate(page: Page, queueId: string, deviceId: string, ttl = 60): Promise<void> {
  const a = await page.request.post(`/api/v1/queues/${queueId}/coordinator`, {
    headers: CSRF,
    data: { operation_id: op(), device_id: deviceId, ttl_minutes: ttl },
  });
  expect(a.status()).toBe(200);
}

async function serverTickets(
  page: Page,
  queueId: string,
): Promise<{ public_code: string; state: string }[]> {
  const r = await page.request.get(`/api/v1/queues/${queueId}`);
  return ((await r.json()) as { queue: { tickets: { public_code: string; state: string }[] } })
    .queue.tickets;
}

/** Raw IndexedDB dump (both stores) as text, for asserting what is and is not persisted. */
async function idbDump(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const o = indexedDB.open('queuebridge-offline');
        o.onsuccess = (): void => {
          const tx = o.result.transaction(['kv', 'operations']);
          const a = tx.objectStore('kv').getAll();
          const b = tx.objectStore('operations').getAll();
          tx.oncomplete = (): void => resolve(JSON.stringify([a.result, b.result]));
        };
      }),
  );
}

test.describe('offline authority vs the device clock', () => {
  test('winding the clock back while offline stops advancement and is never committed silently', async ({
    browser,
    page,
  }) => {
    const s = await setup(page);
    await join(page, s.queueId, 2);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    const p = staff.page;
    await p.clock.install({ time: new Date() });
    await p.goto(`/staff/queues/${s.queueId}`);
    await designate(page, s.queueId, await waitForDevice(p), 30);
    await p.reload();
    await expect(p.getByTestId('authority-active')).toBeVisible();

    await staff.ctx.setOffline(true);
    await p.getByRole('button', { name: 'Call next' }).click();
    await expect(p.getByTestId('local-note')).toBeVisible();
    await expect.poll(async () => (await storedOperations(p)).length).toBe(1);
    // 40 minutes pass (authority expires at 30) and someone winds the wall clock back an hour
    await p.clock.fastForward('00:40:00');
    await p.clock.setSystemTime(new Date(Date.now() - 20 * 60_000));
    await expect(p.getByTestId('authority-banner')).toContainText('clock was changed');
    await expect(p.getByRole('button', { name: 'Start serving' })).toBeDisabled();
    // capture still works
    await p.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await expect(p.getByTestId('offline-capture-ref')).toBeVisible();

    // The first call (made inside the window) carries clean monotonic evidence
    const ops = (await storedOperations(p)) as unknown as {
      action: string;
      authority_timing: { source: string; rollback_detected: boolean } | null;
    }[];
    const call = ops.find((o) => o.action === 'ticket.call_next');
    expect(call?.authority_timing).toMatchObject({ source: 'monotonic', rollback_detected: false });
    await staff.ctx.close();
  });

  test('@pwa restart while offline, then delayed sync: actions inside the window commit; nothing commits twice', async ({
    browser,
    page,
  }) => {
    const s = await setup(page);
    await join(page, s.queueId, 1);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter', {
      serviceWorkers: 'allow',
    });
    const p = staff.page;
    await p.goto(`/staff/queues/${s.queueId}`);
    await designate(page, s.queueId, await waitForDevice(p), 60);
    await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await p.reload();
    await expect
      .poll(() => p.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    await expect(p.getByTestId('authority-active')).toBeVisible();

    await staff.ctx.setOffline(true);
    await p.getByRole('button', { name: 'Call next' }).click();
    await expect(p.getByTestId('at-counter').getByTestId('sync-state-indicator')).toContainText(
      'Local',
    );

    // Browser restart while still offline
    await p.reload();
    await expect(p.getByTestId('authority-active')).toBeVisible();
    await p.getByRole('button', { name: 'Start serving' }).click();
    await expect.poll(async () => (await storedOperations(p)).length).toBe(2);
    const ops = (await storedOperations(p)) as unknown as {
      action: string;
      authority_timing: { source: string } | null;
    }[];
    expect(ops.map((o) => [o.action, o.authority_timing?.source])).toEqual([
      ['ticket.call_next', 'monotonic'],
      ['ticket.serve', 'restarted'],
    ]);

    // Reconnect (still inside the authority window): both commit, once
    await staff.ctx.setOffline(false);
    await expect(p.getByTestId('unsynced-count')).toHaveCount(0, { timeout: 20_000 });
    expect((await storedOperations(p)).map((o) => o.status)).toEqual(['committed', 'committed']);
    expect(await serverTickets(page, s.queueId)).toEqual([
      expect.objectContaining({ public_code: 'G001', state: 'serving' }),
    ]);
    await staff.ctx.close();
  });
});

test.describe('one-time hand-over of the confirmed status link', () => {
  test('after sync, the capturer sees the CONFIRMED code with a working QR link; it is not persisted; Done removes it', async ({
    browser,
    page,
  }) => {
    const s = await setup(page);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_reception');
    const p = staff.page;
    await p.goto(`/staff/queues/${s.queueId}`);
    await waitForDevice(p);
    await staff.ctx.setOffline(true);
    await p.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    const ref = await p.getByTestId('offline-capture-ref').innerText();
    // nothing to hand over while unconfirmed
    await expect(p.getByTestId('handover')).toHaveCount(0);

    await staff.ctx.setOffline(false);
    const card = p.getByTestId('handover');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId('handover-code')).toHaveText('G001');
    await expect(card).not.toContainText(ref);
    await expect(
      card.getByRole('img', { name: /QR code with the status link for ticket G001/ }),
    ).toBeVisible();
    await card.getByText('Show status link').click();
    const link = await card.getByTestId('handover-link').innerText();
    expect(link).toMatch(/^http:\/\/localhost:4173\/ticket\/G001#t=[A-Za-z0-9_-]{43}$/);
    const secret = link.split('#t=')[1] ?? '';

    // Never persisted on the device
    expect(await idbDump(p)).not.toContain(secret);

    // The visitor's phone opens it: real status page, server-confirmed
    const visitor = await browser.newContext({ serviceWorkers: 'block' });
    const vp = await visitor.newPage();
    await vp.goto(link);
    await expect(vp.getByTestId('ticket-code')).toHaveText('G001');
    await expect(vp.getByTestId('sync-status')).toContainText('Confirmed');
    expect(vp.url()).not.toContain(secret); // the fragment secret is scrubbed from the address bar

    // One-time: Done removes it from the screen and from memory
    await card.getByRole('button', { name: /Done — handed to visitor/ }).click();
    await expect(p.getByTestId('handover')).toHaveCount(0);
    await p.reload();
    await expect(p.getByTestId('handover')).toHaveCount(0);

    // Re-issue on request: a NEW link; the previous one stops working
    // Re-issuing warns first that the visitor's existing link will stop working
    await p.getByRole('button', { name: 'New status link for G001' }).click();
    const warning = p.getByTestId('reissue-warning');
    await expect(warning).toContainText('Replace the status link for G001?');
    await expect(warning).toContainText('stop working immediately');
    // Backing out changes nothing: the visitor's link still works
    await warning.getByRole('button', { name: /Keep current link/ }).click();
    await expect(p.getByTestId('reissue-warning')).toHaveCount(0);
    const stillValid = await visitor.newPage();
    await stillValid.goto(link);
    await expect(stillValid.getByTestId('ticket-code')).toHaveText('G001');
    await p.getByRole('button', { name: 'New status link for G001' }).click();
    await p.getByRole('button', { name: /Replace link — old link stops working/ }).click();
    const again = p.getByTestId('handover');
    await expect(again).toBeVisible();
    await again.getByText('Show status link').click();
    const link2 = await again.getByTestId('handover-link').innerText();
    expect(link2).not.toBe(link);
    const old = await visitor.newPage();
    await old.goto(link);
    await expect(old.getByRole('alert').first()).toBeVisible(); // stale link: no access
    await expect(old.getByTestId('ticket-code')).toHaveCount(0);
    const fresh = await visitor.newPage();
    await fresh.goto(link2);
    await expect(fresh.getByTestId('ticket-code')).toHaveText('G001');

    // Credentials never appear on the public board
    const board = await page.request.get(
      `/api/v1/public/facilities/${s.org.slug}/${s.facility.slug}/board`,
    );
    const text = await board.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain(link2.split('#t=')[1] ?? 'x');
    await visitor.close();
    await staff.ctx.close();
  });

  test('lost acknowledgement: the server confirmed but the response never arrived — the retry hands over a working link, one ticket', async ({
    browser,
    page,
  }) => {
    const s = await setup(page);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_reception');
    const p = staff.page;
    await p.goto(`/staff/queues/${s.queueId}`);
    await waitForDevice(p);
    await staff.ctx.setOffline(true);
    await p.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await expect(p.getByTestId('offline-capture-ref')).toBeVisible();

    // The first sync reaches the server (and commits) but its response is dropped
    let dropped = 0;
    await p.route('**/api/v1/sync/batches', async (route) => {
      if (dropped === 0) {
        dropped++;
        await route.fetch(); // the server processes it
        await route.abort('connectionreset'); // ...the device never hears back
        return;
      }
      await route.continue();
    });
    await staff.ctx.setOffline(false);
    await expect.poll(() => dropped).toBe(1);
    expect(await serverTickets(page, s.queueId)).toHaveLength(1); // committed server-side

    // Retry (periodic flush) → duplicate → a fresh credential for the SAME ticket
    const card = p.getByTestId('handover');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('handover-code')).toHaveText('G001');
    await card.getByText('Show status link').click();
    const link = await card.getByTestId('handover-link').innerText();
    // the device learned the outcome only from the retry (second attempt, answered `duplicate`)
    const stored = (await storedOperations(p)) as unknown as { status: string; attempts: number }[];
    expect(stored.map((o) => [o.status, o.attempts])).toEqual([['duplicate', 2]]);
    expect(await serverTickets(page, s.queueId)).toHaveLength(1);
    const v = await browser.newContext({ serviceWorkers: 'block' });
    const vp = await v.newPage();
    await vp.goto(link);
    await expect(vp.getByTestId('ticket-code')).toHaveText('G001');
    await v.close();
    await staff.ctx.close();
  });

  test('another staff member on the same queue never sees someone else’s hand-over', async ({
    browser,
    page,
  }) => {
    const s = await setup(page);
    const a = await makeStaff(browser, page.request, s.facility.id, 'staff_reception');
    const b = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    await a.page.goto(`/staff/queues/${s.queueId}`);
    await waitForDevice(a.page);
    await b.page.goto(`/staff/queues/${s.queueId}`);
    await waitForDevice(b.page);
    await a.ctx.setOffline(true);
    await a.page.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await a.ctx.setOffline(false);
    await expect(a.page.getByTestId('handover')).toBeVisible({ timeout: 20_000 });
    await expect(b.page.getByTestId('waiting-list')).toContainText('G001', { timeout: 20_000 });
    await expect(b.page.getByTestId('handover-panel')).toHaveCount(0);
    await a.ctx.close();
    await b.ctx.close();
  });
});
