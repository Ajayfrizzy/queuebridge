import { expect, test } from '@playwright/test';
import {
  apiQueueSetup,
  expectNoA11yViolations,
  hasHorizontalOverflow,
  PASSWORD,
  uiLogin,
} from './helpers.js';
import { makeStaff, op, storedOperations, waitForDevice } from './offline-helpers.js';

const CSRF = { 'X-QB-CSRF': '1' };

/**
 * M3 — offline operation in a real browser against the real stack (Groups 5, 6, 11, 12 Journey C).
 * Connectivity loss is simulated with the browser's own offline switch (requests genuinely fail).
 */

test.describe('offline shell and authorized data (PWA)', () => {
  test('@pwa the app shell and the last authorized queue reopen with no network', async ({
    browser,
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter', {
      serviceWorkers: 'allow',
    });
    const p = staff.page;
    // Visit the facility page online once so its authorized data is cached
    await p.goto(`/staff/facilities/${s.facility.id}`);
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('Queue Clinic');
    await p.goto(`/staff/queues/${s.queueId}`);
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('General Consultation');
    await waitForDevice(p);
    // wait for the service worker to take control, so the shell is precached
    await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await p.reload();
    await expect
      .poll(() => p.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);

    await staff.ctx.setOffline(true);
    await p.reload();
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('General Consultation');
    await expect(p.getByTestId('connection-state')).toContainText('Offline');
    await expect(p.getByTestId('cached-notice')).toContainText('last saved copy');
    await expect(p.getByTestId('whoami')).toContainText('Staff staff_counter');

    // the facility page was cached too
    await p.goto(`/staff/facilities/${s.facility.id}`);
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('Queue Clinic');
    await expect(p.getByTestId('cached-notice')).toBeVisible();
    // a page never opened online says so honestly instead of pretending
    await p.goto(`/staff/facilities/${s.facility.id}/connectivity`);
    await expect(p.getByRole('alert').first()).toContainText('Cannot reach the server');
    await staff.ctx.close();
  });
});

test.describe('provisional capture, durability and recovery (Journey C)', () => {
  test('@pwa captured tickets survive a reload, stay Local/unconfirmed, then confirm on reconnect', async ({
    browser,
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter', {
      serviceWorkers: 'allow',
    });
    const p = staff.page;
    await p.goto(`/staff/queues/${s.queueId}`);
    await expect(p.getByTestId('connection-state')).toContainText('Online');
    await waitForDevice(p);
    await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await p.reload();
    await expect
      .poll(() => p.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    await waitForDevice(p);

    // --- connectivity lost ---
    await staff.ctx.setOffline(true);
    await expect(p.getByTestId('connection-state')).toContainText('Offline');
    await p.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    const ref = await p.getByTestId('offline-capture-ref').innerText();
    expect(ref).toMatch(/^P-[0-9A-F]{6}$/); // a temporary reference, never a ticket number
    await expect(p.getByTestId('offline-capture')).toContainText('temporary reference');

    // durable BEFORE the success message: it is already in IndexedDB
    expect(await storedOperations(p)).toEqual([
      expect.objectContaining({ action: 'ticket.create', status: 'local_only' }),
    ]);
    const row = p.getByTestId('provisional-ticket');
    await expect(row).toContainText(ref);
    await expect(row.getByTestId('sync-state-indicator')).toContainText('Local');
    await expect(p.getByTestId('unsynced-count')).toContainText('1 unsent action');

    // the server (and therefore every visitor and the public board) knows nothing yet
    const board = await page.request.get(
      `/api/v1/public/facilities/${s.org.slug}/${s.facility.slug}/board`,
    );
    const waiting = ((await board.json()) as { board: { services: { waiting_count: number }[] } })
      .board.services[0]?.waiting_count;
    expect(waiting).toBe(0);

    // --- browser restart while still offline: the pending operation survives ---
    await p.reload();
    await expect(p.getByTestId('provisional-ticket')).toContainText(ref);
    await expect(p.getByTestId('outbox-row')).toHaveAttribute('data-status', 'local_only');

    // --- connectivity restored ---
    await staff.ctx.setOffline(false);
    await expect(p.getByTestId('connection-state')).toContainText('Online', { timeout: 15_000 });
    await expect(p.getByTestId('unsynced-count')).toHaveCount(0, { timeout: 20_000 });
    await expect(p.getByTestId('provisional-ticket')).toHaveCount(0);
    // reconciled to a confirmed ticket with a real code, exactly once
    await expect(p.getByTestId('waiting-list')).toContainText('G001');
    await expect(p.getByTestId('waiting-list').getByRole('listitem')).toHaveCount(1);
    const after = await page.request.get(
      `/api/v1/public/facilities/${s.org.slug}/${s.facility.slug}/board`,
    );
    expect(
      ((await after.json()) as { board: { services: { waiting_count: number }[] } }).board
        .services[0]?.waiting_count,
    ).toBe(1);
    expect((await storedOperations(p))[0]?.status).toBe('committed');
    await staff.ctx.close();
  });
});

test.describe('offline authority', () => {
  test('without designated authority a device may capture tickets but cannot call', async ({
    browser,
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    const p = staff.page;
    await p.goto(`/staff/queues/${s.queueId}`);
    await waitForDevice(p);
    await staff.ctx.setOffline(true);
    await expect(p.getByTestId('authority-banner')).toContainText('No offline authority');
    await expect(p.getByRole('button', { name: 'Issue walk-in ticket' })).toBeEnabled();
    await p.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await expect(p.getByTestId('offline-capture-ref')).toBeVisible();
    await expect(p.getByRole('button', { name: 'Call next' })).toBeDisabled();
    await staff.ctx.close();
  });

  test('the coordinator advances offline, authority expiry stops it, capture still works', async ({
    browser,
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    const csrf = { headers: CSRF };
    // a visitor is waiting
    const j = await page.request.post(`/api/v1/queues/${s.queueId}/join`, {
      ...csrf,
      data: { operation_id: op(), join_proof: 'A'.repeat(43) },
    });
    expect(j.status()).toBe(201);

    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    const p = staff.page;
    await p.clock.install({ time: new Date() });
    await p.goto(`/staff/queues/${s.queueId}`);
    const deviceId = await waitForDevice(p);

    // supervisor designates this device for 30 minutes
    const a = await page.request.post(`/api/v1/queues/${s.queueId}/coordinator`, {
      ...csrf,
      data: { operation_id: op(), device_id: deviceId, ttl_minutes: 30 },
    });
    expect(a.status()).toBe(200);
    await p.reload();
    await expect(p.getByTestId('authority-active')).toContainText('offline coordinator');

    // --- outage: the coordinator calls the next visitor; it is local only ---
    await staff.ctx.setOffline(true);
    await expect(p.getByTestId('connection-state')).toContainText('Offline');
    await p.getByRole('button', { name: 'Call next' }).click();
    await expect(p.getByTestId('local-note')).toContainText('not confirmed by the server yet');
    const current = p.getByTestId('at-counter');
    await expect(current.getByTestId('current-code')).toHaveText('G001');
    await expect(current.getByTestId('sync-state-indicator')).toContainText('Local');
    // the visitor-facing truth is untouched: still waiting
    const stat = await page.request.get(`/api/v1/queues/${s.queueId}`);
    const tickets = ((await stat.json()) as { queue: { tickets: { state: string }[] } }).queue
      .tickets;
    expect(tickets[0]?.state).toBe('waiting');

    // --- authority runs out while still offline ---
    await p.clock.fastForward('00:45:00');
    await expect(p.getByTestId('authority-banner')).toContainText('Offline authority expired');
    await expect(p.getByRole('button', { name: 'Start serving' })).toBeDisabled();
    await expect(p.getByRole('button', { name: 'Issue walk-in ticket' })).toBeEnabled();
    await staff.ctx.close();
  });

  test('two conflicting Call Next operations: only the server-side one commits; the other is held for review', async ({
    browser,
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    const csrf = { headers: CSRF };
    await page.request.post(`/api/v1/queues/${s.queueId}/join`, {
      ...csrf,
      data: { operation_id: op(), join_proof: 'B'.repeat(43) },
    });

    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    const p = staff.page;
    await p.goto(`/staff/queues/${s.queueId}`);
    const deviceId = await waitForDevice(p);
    await page.request.post(`/api/v1/queues/${s.queueId}/coordinator`, {
      ...csrf,
      data: { operation_id: op(), device_id: deviceId, ttl_minutes: 60 },
    });
    await p.reload();
    await expect(p.getByTestId('authority-active')).toBeVisible();

    // Partition: the coordinator calls G001 locally
    await staff.ctx.setOffline(true);
    await p.getByRole('button', { name: 'Call next' }).click();
    await expect(p.getByTestId('outbox-row')).toHaveAttribute('data-status', 'local_only');

    // Meanwhile the supervisor, who cannot reach that device, revokes it and calls G001 online
    const rev = await page.request.post(`/api/v1/queues/${s.queueId}/coordinator/revoke`, {
      ...csrf,
      data: { operation_id: op(), reason_code: 'device_lost' },
    });
    expect(rev.status()).toBe(200);
    const call = await page.request.post(`/api/v1/queues/${s.queueId}/commands`, {
      ...csrf,
      data: { operation_id: op(), action: 'ticket.call_next', counter_id: s.counterId },
    });
    expect(call.status()).toBe(200);

    // Reconnect: the stale coordinator's call must NOT commit
    await staff.ctx.setOffline(false);
    await expect(p.getByTestId('review-count')).toContainText('1 waiting for a supervisor', {
      timeout: 20_000,
    });
    await expect(p.getByTestId('outbox-row')).toHaveAttribute('data-status', 'needs_review');
    await expect(p.getByTestId('outbox-row')).toContainText('replaced');
    await expect(p.getByTestId('outbox-row').getByTestId('sync-state-indicator')).toContainText(
      'Needs review',
    );

    const st = await page.request.get(`/api/v1/queues/${s.queueId}`);
    const body = (await st.json()) as {
      queue: { tickets: { public_code: string; state: string; counter_id: string }[] };
    };
    expect(body.queue.tickets).toEqual([
      expect.objectContaining({ public_code: 'G001', state: 'called', counter_id: s.counterId }),
    ]);

    // The supervisor sees and resolves it in the dashboard
    const sup = await browser.newContext({ serviceWorkers: 'block' });
    const sp = await sup.newPage();
    await uiLogin(sp, s.org.slug, s.org.email);
    await expect(sp.getByTestId('whoami')).toBeVisible();
    await sp.goto(`/staff/facilities/${s.facility.id}/connectivity`);
    await expect(sp.getByTestId('conflict')).toContainText('replaced');
    await sp.getByLabel('Reason for your decision').selectOption('duplicate_of_online_action');
    await sp.getByRole('button', { name: /^Dismiss/ }).click();
    await expect(sp.getByTestId('no-conflicts')).toBeVisible();

    // The coordinator's device learns the outcome and shows it plainly
    await expect(p.getByTestId('outbox-row')).toHaveAttribute('data-status', 'rejected', {
      timeout: 30_000,
    });
    await expect(p.getByTestId('outbox-row')).toContainText('chose not to apply');
    await sup.close();
    await staff.ctx.close();
  });
});

test.describe('safe handling of local data', () => {
  test('signing out with unsent actions asks first and never drops them silently', async ({
    browser,
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    const p = staff.page;
    await p.goto(`/staff/queues/${s.queueId}`);
    await waitForDevice(p);
    await staff.ctx.setOffline(true);
    await p.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await expect(p.getByTestId('unsynced-count')).toBeVisible();

    await p.getByRole('button', { name: 'Sign out' }).click();
    await expect(p.getByTestId('discard-warning')).toContainText('1 unsent action');
    await p.getByRole('button', { name: 'Cancel' }).click();
    expect(await storedOperations(p)).toHaveLength(1); // still there

    // back online: send first, then sign out cleanly with nothing lost
    await staff.ctx.setOffline(false);
    await expect(p.getByTestId('unsynced-count')).toHaveCount(0, { timeout: 20_000 });
    await p.getByRole('button', { name: 'Sign out' }).click();
    await expect(p).toHaveURL(/\/$/);
    expect(await storedOperations(p)).toHaveLength(0); // sensitive local data erased on sign-out
    const left = await p.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const o = indexedDB.open('queuebridge-offline');
          o.onsuccess = (): void => {
            const r = o.result.transaction('kv').objectStore('kv').getAllKeys();
            r.onsuccess = (): void => resolve(r.result as string[]);
          };
        }),
    );
    expect(
      left.filter((k) => k.startsWith('snap:') || k.startsWith('cache:') || k === 'identity'),
    ).toEqual([]);
    await staff.ctx.close();
  });

  test('on a shared device, one person’s unsent actions are never sent under another person’s sign-in', async ({
    browser,
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    const a = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    const p = a.page;
    await p.goto(`/staff/queues/${s.queueId}`);
    await waitForDevice(p);
    await a.ctx.setOffline(true);
    await p.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await expect(p.getByTestId('unsynced-count')).toBeVisible();
    // Person A's sign-in is gone before the device reconnects (cookie cleared / session ended)
    await a.ctx.clearCookies();
    const aOperationId = ((await storedOperations(p)) as unknown as { operation_id: string }[])[0]
      ?.operation_id;
    expect(aOperationId).toBeTruthy();
    // Record every sync request this browser sends from now on
    const sent: string[] = [];
    p.on('request', (r) => {
      if (r.url().includes('/api/v1/sync/batches')) sent.push(r.postData() ?? '');
    });
    await a.ctx.setOffline(false);
    await p.reload();

    // Person B signs in on the same browser profile
    const invite = await page.request.post(`/api/v1/facilities/${s.facility.id}/invitations`, {
      headers: CSRF,
      data: { email: `b-${Date.now()}@example.test`, role: 'staff_reception' },
    });
    const { token } = (await invite.json()) as { token: string };
    const acc = await p.request.post('/api/v1/invitations/accept', {
      headers: CSRF,
      data: { token, display_name: 'Person B', password: PASSWORD },
    });
    expect(acc.status()).toBe(201);
    await p.goto(`/staff/queues/${s.queueId}`);
    await expect(p.getByTestId('whoami')).toContainText('Person B');
    await expect(p.getByTestId('offline-problem')).toContainText('belongs to another person');

    // Force a real flush under B's session: B captures offline, reconnects, and B's own ticket
    // syncs. Any flush that would include A's action has therefore already happened.
    await waitForDevice(p);
    await a.ctx.setOffline(true);
    await p.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await expect(p.getByTestId('offline-capture-ref')).toBeVisible();
    await a.ctx.setOffline(false);
    await expect(p.getByTestId('handover')).toBeVisible({ timeout: 20_000 });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((body) => body.includes(aOperationId ?? '~'))).toBe(false);
    // The server holds only B's ticket
    const q = await page.request.get(`/api/v1/queues/${s.queueId}`);
    expect(((await q.json()) as { queue: { tickets: unknown[] } }).queue.tickets).toHaveLength(1);
    // ... and A's action is still safely stored on the device
    const kept = (await storedOperations(p)) as unknown as {
      operation_id: string;
      status: string;
    }[];
    const aStill = kept.find((o) => o.operation_id === aOperationId);
    expect(['local_only', 'pending_sync']).toContain(aStill?.status);
    await a.ctx.close();
  });

  test('a browser that cannot store offline data says so and refuses to pretend', async ({
    browser,
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    const p = staff.page;
    await p.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    });
    await p.goto(`/staff/queues/${s.queueId}`);
    await expect(p.getByTestId('offline-problem')).toContainText('cannot save offline data');
    await staff.ctx.setOffline(true);
    await p.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await expect(p.getByTestId('command-error')).toContainText('not registered for offline use');
    await expect(p.getByTestId('provisional-ticket')).toHaveCount(0);
    await staff.ctx.close();
  });
});

test.describe('connectivity and recovery dashboard (F9)', () => {
  test('a supervisor designates, replaces and ends a coordinator and sees device health', async ({
    browser,
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    const a = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    await a.page.goto(`/staff/queues/${s.queueId}`);
    await waitForDevice(a.page);

    const sup = await browser.newContext({ serviceWorkers: 'block' });
    const sp = await sup.newPage();
    await uiLogin(sp, s.org.slug, s.org.email);
    await expect(sp.getByTestId('whoami')).toBeVisible();
    await sp.goto(`/staff/facilities/${s.facility.id}/connectivity`);
    await expect(sp.getByRole('heading', { level: 1 })).toHaveText('Connectivity and recovery');
    await expect(sp.getByTestId('device-row')).toHaveCount(1);
    await expect(sp.getByTestId('device-row')).toContainText('Staff staff_counter');
    await expect(sp.getByTestId('coordinator-status')).toContainText('none');

    await sp.getByLabel('Designate device').selectOption({ index: 1 });
    await sp.getByRole('button', { name: /Make coordinator/ }).click();
    await expect(sp.getByTestId('coordinator-status')).toContainText('authority active');
    await expect(sp.getByTestId('device-row')).toContainText('General Consultation');

    await sp.getByRole('button', { name: /End authority/ }).click();
    await expect(sp.getByTestId('coordinator-status')).toContainText('none');

    // revoking a device is explicit and confirmed
    await sp.getByRole('button', { name: /^Revoke/ }).click();
    await sp.getByRole('button', { name: /Confirm revoke/ }).click();
    await expect(sp.getByTestId('device-row')).toHaveAttribute('data-health', 'revoked');
    // ... and the revoked device is told so
    await a.page.reload();
    await expect(a.page.getByTestId('offline-problem')).toContainText('revoked', {
      timeout: 20_000,
    });

    // unauthorised staff cannot see the dashboard
    await a.page.goto(`/staff/facilities/${s.facility.id}/connectivity`);
    await expect(a.page.getByRole('alert').first()).toContainText(/do not have access|not exist/);
    await sup.close();
    await a.ctx.close();
  });

  test('@responsive the dashboard and the offline console are accessible and fit narrow screens', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    // the staff browser uses this project's viewport (320 / 375 / desktop)
    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter', {
      viewport: page.viewportSize(),
    });
    await staff.page.goto(`/staff/queues/${s.queueId}`);
    await waitForDevice(staff.page);
    await staff.ctx.setOffline(true);
    await staff.page.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await expect(staff.page.getByTestId('outbox-panel')).toBeVisible();
    await expectNoA11yViolations(staff.page);
    expect(await hasHorizontalOverflow(staff.page)).toBe(false);
    await staff.ctx.setOffline(false);
    await staff.ctx.close();

    // `page` is already signed in as the organization admin (apiSignup shares its cookies)
    await page.goto(`/staff/facilities/${s.facility.id}/connectivity`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Connectivity and recovery');
    await expectNoA11yViolations(page);
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });
});
