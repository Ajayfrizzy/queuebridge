import postgres from 'postgres';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { uuidv7 } from '@queuebridge/contracts';
import { apiQueueSetup, expectNoA11yViolations, hasHorizontalOverflow } from './helpers.js';
import { goOffline, makeStaff, waitForDevice } from './offline-helpers.js';
import { runWorkerOnce as runWorker } from './worker-once.js';

/**
 * M5.3 device health in real browsers against the real stack (Group 8: 8.D1, 8.D5; Group 11:
 * 11.A10). Alerts are raised by running the REAL worker once (`--once`), exactly as it runs in
 * production; only the passage of time (a device's last contact) is set in the database.
 * `@responsive` tests also run at 320, 375 and 1440 px.
 */
const CSRF = { 'X-QB-CSRF': '1' };
const DB_URL = process.env['TEST_DATABASE_URL'] ?? '';

const runWorkerOnce = (): void => runWorker('device-health');

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function assign(
  request: APIRequestContext,
  queueId: string,
  deviceId: string,
  ttl: number,
): Promise<void> {
  const r = await request.post(`/api/v1/queues/${queueId}/coordinator`, {
    headers: CSRF,
    data: { operation_id: uuidv7(), device_id: deviceId, ttl_minutes: ttl },
  });
  expect(r.status(), await r.text()).toBe(200);
}

async function walkIn(request: APIRequestContext, queueId: string): Promise<void> {
  const r = await request.post(`/api/v1/queues/${queueId}/walk-ins`, {
    headers: CSRF,
    data: { operation_id: uuidv7() },
  });
  expect(r.status()).toBe(201);
}

async function checkLayout(page: Page): Promise<void> {
  await expectNoA11yViolations(page);
  expect(await hasHorizontalOverflow(page)).toBe(false);
}

test.describe('@responsive M5.3 device-health dashboard', () => {
  test('a supervisor sees stale and offline devices, the coordinator alert with its advice, and acknowledges with the keyboard', async ({
    page,
    browser,
  }) => {
    const viewport = page.viewportSize();
    const s = await apiQueueSetup(page.request);
    const q = s.queueId ?? '';
    const sup = await makeStaff(browser, page.request, s.facility.id, 'supervisor', { viewport });
    const counter = await makeStaff(browser, page.request, s.facility.id, 'staff_counter', {
      viewport,
    });
    await counter.page.goto(`/staff/queues/${q}`);
    const deviceId = await waitForDevice(counter.page);
    await walkIn(page.request, q);
    await assign(sup.page.request, q, deviceId, 60);
    // Time passes: the coordinator tablet has not been heard from for 20 minutes.
    // A heartbeat that reached the API just before browser shutdown may still commit after
    // ctx.close(). Establish the stale fixture against the REAL API, rather than racing
    // that in-flight write and mistaking a fresh heartbeat for a device-health regression.
    await counter.ctx.close();
    await expect
      .poll(
        async () => {
          await withDb(
            (sql) =>
              sql`UPDATE devices SET last_seen_at = NOW() - INTERVAL '20 minutes' WHERE id = ${deviceId}`,
          );
          const response = await sup.page.request.get(
            `/api/v1/facilities/${s.facility.id}/operations/health`,
          );
          expect(response.status()).toBe(200);
          const body = (await response.json()) as {
            devices: { id: string; health: string }[];
          };
          return body.devices.find((d) => d.id === deviceId)?.health;
        },
        { message: 'The disconnected counter device becomes stale in the authoritative API' },
      )
      .toBe('stale');
    runWorkerOnce();

    const p = sup.page;
    await p.goto(`/staff/facilities/${s.facility.id}/connectivity`);
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('Connectivity and recovery');
    // honest wording about what the server can and cannot know
    await expect(p.locator('main')).toContainText('may be offline, asleep, closed or lost');
    // device state by server time, with text and a symbol (never colour alone)
    const row = p.getByTestId('device-row').filter({ has: p.getByText('Staff staff_counter') });
    await expect(row).toHaveAttribute('data-health', 'stale');
    await expect(row).toContainText('Stale: silent for a long time');
    // the alert, and its advice: recommends, never acts
    const alert = p
      .getByTestId('alert-item')
      .filter({ has: p.getByText('offline coordinator is not responding') });
    await expect(alert).toHaveAttribute('data-status', 'open');
    await expect(alert).toContainText('High');
    await expect(alert).toContainText('Nothing happens automatically');
    await expect(alert).toContainText('fences the old device');
    await expect(p.getByTestId('health-alert-banner')).toContainText('high priority');
    // the coordinator is still the counter's tablet: health changed nothing
    await expect(p.getByTestId('coordinator-status')).toContainText('authority active');
    await checkLayout(p);

    // acknowledge with the keyboard alone
    const button = alert.getByRole('button', { name: /^Acknowledge/ });
    await button.focus();
    await p.keyboard.press('Enter');
    await expect(alert).toHaveAttribute('data-status', 'acknowledged');
    await expect(alert.getByTestId('alert-acknowledged')).toContainText('Staff supervisor');
    await expect(p.getByTestId('connectivity-message')).toContainText('Alert acknowledged');
    await checkLayout(p);

    // filter and severity order
    await p.getByLabel('Show').selectOption('silent');
    await expect(p.getByTestId('device-row')).toHaveCount(1);
    await p.getByLabel('Show').selectOption('all');
    await sup.ctx.close();
  });

  test('an auditor reads alerts but cannot acknowledge; counter staff see only their own device warning', async ({
    page,
    browser,
  }) => {
    const viewport = page.viewportSize();
    const s = await apiQueueSetup(page.request);
    const q = s.queueId ?? '';
    const sup = await makeStaff(browser, page.request, s.facility.id, 'supervisor', { viewport });
    const auditor = await makeStaff(browser, page.request, s.facility.id, 'auditor', { viewport });
    const counter = await makeStaff(browser, page.request, s.facility.id, 'staff_counter', {
      viewport,
    });
    await counter.page.goto(`/staff/queues/${q}`);
    const deviceId = await waitForDevice(counter.page);
    // a 5-minute authority is inside the 300-second warning window from the start
    await assign(sup.page.request, q, deviceId, 5);
    runWorkerOnce();

    await auditor.page.goto(`/staff/facilities/${s.facility.id}/connectivity`);
    const a = auditor.page.getByTestId('alert-item').filter({ hasText: 'about to end' });
    await expect(a).toBeVisible();
    await expect(a.getByRole('button', { name: /Acknowledge/ })).toHaveCount(0);
    await expect(auditor.page.getByTestId('alerts-read-only')).toBeVisible();
    await checkLayout(auditor.page);

    // the counter's own console: a warning about THIS device, no access to the alert list
    await counter.page.reload();
    const warn = counter.page.getByTestId('own-device-warning');
    await expect(warn).toContainText(
      'Your coordinator authorization for General Consultation is about to end',
    );
    await expect(counter.page.getByTestId('health-alert-banner')).toHaveCount(0);
    await checkLayout(counter.page);
    // non-blocking: hide it; the console keeps working
    await warn.getByRole('button', { name: /^Hide/ }).click();
    await expect(warn).toHaveCount(0);
    const r = await counter.page.request.get(
      `/api/v1/facilities/${s.facility.id}/operations/health`,
    );
    expect(r.status()).toBe(403);
    for (const x of [sup, auditor, counter]) await x.ctx.close();
  });
});

test.describe('M5.3 lost device and offline behaviour', () => {
  test('revoke as lost: the warning names last contact and pending actions; afterwards the row says they may be lost', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const q = s.queueId ?? '';
    const sup = await makeStaff(browser, page.request, s.facility.id, 'supervisor');
    const counter = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    await counter.page.goto(`/staff/queues/${q}`);
    const deviceId = await waitForDevice(counter.page);
    const hb = await counter.page.request.post(`/api/v1/devices/${deviceId}/heartbeat`, {
      headers: CSRF,
      data: { pending_count: 3 },
    });
    expect(hb.status()).toBe(204);
    await counter.ctx.close();
    const p = sup.page;
    await p.goto(`/staff/facilities/${s.facility.id}/connectivity`);
    const row = p.getByTestId('device-row').filter({ has: p.getByText('Staff staff_counter') });
    await row.getByRole('button', { name: /^Revoke/ }).click();
    await expect(row.getByTestId('revoke-warning')).toContainText('about 3 unsent actions');
    await expect(row.getByTestId('revoke-warning')).toContainText('may be lost');
    await row.getByLabel('Reason').selectOption('lost');
    await row.getByRole('button', { name: /^Confirm revoke/ }).click();
    await expect(row).toHaveAttribute('data-health', 'revoked');
    await expect(row.getByTestId('revoked-detail')).toContainText('Lost at');
    await expect(row.getByTestId('revoked-detail')).toContainText(
      'Up to 3 actions were pending on this device and may be lost',
    );
    await expect(row.getByTestId('revoked-detail')).toContainText(
      'register it again as a new device',
    );
    await checkLayout(p);
    await sup.ctx.close();
  });

  test('the own-device warning stays readable offline, labelled with when it was checked', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const q = s.queueId ?? '';
    const sup = await makeStaff(browser, page.request, s.facility.id, 'supervisor');
    const counter = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    await counter.page.goto(`/staff/queues/${q}`);
    const deviceId = await waitForDevice(counter.page);
    await assign(sup.page.request, q, deviceId, 5);
    await counter.page.reload();
    await expect(counter.page.getByTestId('own-device-warning')).toBeVisible();
    await goOffline(counter.ctx, counter.page);
    await expect(counter.page.getByTestId('own-device-warning-stale')).toContainText(
      'may be out of date',
    );
    await expectNoA11yViolations(counter.page);
    await counter.ctx.setOffline(false);
    for (const x of [sup, counter]) await x.ctx.close();
  });

  test('"automatic alerts are paused" is said plainly when the worker has not run for 3 intervals', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const sup = await makeStaff(browser, page.request, s.facility.id, 'supervisor');
    await withDb(
      (sql) => sql`UPDATE health_evaluations SET last_evaluated_at = NOW() - INTERVAL '10 minutes'`,
    );
    try {
      await sup.page.goto(`/staff/facilities/${s.facility.id}/connectivity`);
      await expect(sup.page.getByTestId('alerts-paused')).toContainText(
        'Automatic alerts are paused',
      );
      await expectNoA11yViolations(sup.page);
    } finally {
      runWorkerOnce(); // restore a current evaluation for everyone else
    }
    await sup.page.reload();
    await expect(sup.page.getByTestId('alerts-paused')).toHaveCount(0);
    await sup.ctx.close();
  });
});
