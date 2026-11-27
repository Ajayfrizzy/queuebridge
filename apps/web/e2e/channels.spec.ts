import postgres from 'postgres';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { uuidv7 } from '@queuebridge/contracts';
import { apiQueueSetup, expectNoA11yViolations, hasHorizontalOverflow } from './helpers.js';
import { makeStaff } from './offline-helpers.js';
import { runWorkerOnce, runWorkerUntilReached } from './worker-once.js';
/**
 * M6.3 Channels screen and the optional delayed SMS, in a real browser against the real stack
 * (design §13; REQ-F11.10–F11.13, F12; Groups 8, 11, 13, 14). Real: the API, PostgreSQL, the
 * committed call, the visitor's ticket page, its acknowledgement and the worker run once as in
 * production. Simulated: the provider (TEST-ONLY sandbox, nothing leaves the machine). The only
 * DB write is moving a delayed row's due time to now, so the test does not wait out the delay.
 */
const CSRF = { 'X-QB-CSRF': '1' };
const DB_URL = process.env['TEST_DATABASE_URL'] ?? '';
type Setup = Awaited<ReturnType<typeof apiQueueSetup>>;

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
const channelsPath = (s: Setup): string => `/admin/facilities/${s.facility.id}/channels`;

async function visitor(
  browser: Browser,
  opts: { hidden?: boolean } = {},
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  if (opts.hidden) {
    // A background tab: the page sees `hidden` until the test "shows" it
    await ctx.addInitScript(() => {
      const w = window as unknown as { __qbHidden: boolean };
      w.__qbHidden = true;
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (w.__qbHidden ? 'hidden' : 'visible'),
      });
    });
  }
  return { ctx, page: await ctx.newPage() };
}
async function joinWithSms(page: Page, s: Setup, phone: string): Promise<string> {
  await page.goto(s.joinPath);
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByTestId('sms-consent').check();
  await page.getByRole('button', { name: /Get a ticket/ }).click();
  await expect(page.getByTestId('ticket-code')).toBeVisible();
  await page.getByRole('button', { name: 'I have saved my key' }).click();
  return (await page.getByTestId('ticket-code').innerText()).trim();
}
async function callNext(page: Page, s: Setup): Promise<void> {
  const r = await page.request.post(`/api/v1/queues/${s.queueId ?? ''}/commands`, {
    headers: CSRF,
    data: { operation_id: uuidv7(), action: 'ticket.call_next', counter_id: s.counterId },
  });
  expect(r.status()).toBe(200);
}
interface Row {
  id: string;
  status: string;
  detail_code: string | null;
  skip_if_seen: boolean | null;
  due_in: number;
}
const smsOf = async (s: Setup, code: string): Promise<Row | undefined> =>
  withDb(async (sql) => {
    const [r] = await sql<Row[]>`
      SELECT n.id, n.status, n.detail_code, (o.payload->>'skip_if_seen')::boolean AS skip_if_seen,
             EXTRACT(EPOCH FROM (o.next_attempt_at - NOW()))::int AS due_in
        FROM notifications n JOIN notification_outbox o ON o.notification_id = n.id
        JOIN tickets t ON t.id = n.ticket_id
       WHERE t.public_code = ${code} AND t.queue_session_id = ${s.queueId ?? ''} AND n.channel = 'sms'
       ORDER BY n.created_at DESC LIMIT 1`;
    return r;
  });
const seenCount = async (s: Setup, code: string): Promise<number> =>
  withDb(async (sql) => {
    const [r] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM turn_alert_seen a JOIN tickets t ON t.id = a.ticket_id
       WHERE t.public_code = ${code} AND t.queue_session_id = ${s.queueId ?? ''}`;
    return r?.n ?? 0;
  });
const makeDue = async (id: string): Promise<void> =>
  withDb(async (sql) => {
    await sql`UPDATE notification_outbox SET next_attempt_at = NOW() WHERE notification_id = ${id}`;
  });
async function setDelay(page: Page, s: Setup, delay: number | null): Promise<void> {
  const r = await page.request.put(`/api/v1/facilities/${s.facility.id}/sms`, {
    headers: CSRF,
    data: { enabled: true, daily_cap: 50, delay_seconds: delay },
  });
  expect(r.status()).toBe(200);
}

test.describe('M6.3 Channels screen (facility administrator)', () => {
  test('SMS and USSD settings: honest mode, validation, success, no double submit', async ({
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    await page.goto(channelsPath(s));
    await expect(page.getByRole('heading', { name: 'Channels', level: 2 })).toBeVisible();
    const sms = page.getByTestId('sms-settings');
    const ussd = page.getByTestId('ussd-settings');
    // the deployment's mode is shown, never chosen: Sandbox checked, Live disabled and explained
    await expect(sms.getByTestId('sms-sandbox-warning')).toHaveText(
      '⚠ Test mode — no real messages are sent',
    );
    await expect(ussd.getByTestId('ussd-sandbox-warning')).toHaveText(
      '⚠ Test mode — no real mobile-network USSD session',
    );
    for (const box of [sms.getByTestId('sms-mode'), ussd.getByTestId('ussd-mode')]) {
      await expect(box.getByLabel('Sandbox (test mode)')).toBeChecked();
      await expect(box.getByLabel('Sandbox (test mode)')).toBeDisabled();
      await expect(box.getByLabel('Live')).toBeDisabled();
      await expect(box.getByLabel('Live')).not.toBeChecked();
      await expect(box).toContainText('Live is not available');
    }
    await expect(ussd.getByTestId('ussd-no-shortcode')).toContainText(
      'There is no real USSD code to dial.',
    );
    await expect(sms.getByTestId('sms-readiness')).toContainText('Off for this facility');
    await expect(sms.getByTestId('sms-delay-help')).toContainText('Off by default');
    await expectNoA11yViolations(page);

    // client validation: turning SMS on needs a cap; a delay below the minimum is refused
    await sms.getByLabel('Send text message turn alerts at this facility').check();
    await sms
      .getByLabel(
        'Send a text message only if the ticket page has not shown the alert after a delay',
      )
      .check();
    await sms.getByLabel('Delay before the text message (seconds)').fill('5');
    await sms.getByTestId('sms-save').click();
    const errs = sms.getByTestId('channel-errors');
    await expect(errs).toBeFocused();
    await expect(errs).toContainText('Enter a daily limit of at least 1 to turn text messages on.');
    await expect(errs).toContainText(/Enter a whole number of seconds from 10 to \d+\./);
    await expect(
      sms.getByLabel('Daily limit for this facility (messages per day)'),
    ).toHaveAttribute('aria-invalid', 'true');
    await expectNoA11yViolations(page);
    // the error link moves focus to the field
    await errs.getByRole('link', { name: /daily limit/ }).click();
    await expect(sms.getByLabel('Daily limit for this facility (messages per day)')).toBeFocused();

    // a valid save: one request even when pressed twice, then announced
    let puts = 0;
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().endsWith(`/facilities/${s.facility.id}/sms`)) puts += 1;
    });
    await sms.getByLabel('Daily limit for this facility (messages per day)').fill('25');
    await sms.getByLabel('Delay before the text message (seconds)').fill('20');
    await sms.getByTestId('sms-save').dblclick();
    await expect(sms.getByTestId('sms-saved')).toHaveText(
      '✓ SMS settings saved: on, delay 20 seconds.',
    );
    expect(puts).toBe(1);
    await expect(sms.getByTestId('sms-readiness')).toContainText('Turned on for this facility');
    await expect(sms.getByTestId('sms-usage')).toContainText('0 of 25');
    // the server kept it (reload)
    await page.reload();
    await expect(page.getByLabel('Delay before the text message (seconds)')).toHaveValue('20');

    // USSD on: the facility code appears and is described as public
    await ussd.getByLabel('Answer the USSD menu for this facility').check();
    await ussd.getByTestId('ussd-save').click();
    await expect(ussd.getByTestId('ussd-saved')).toHaveText('✓ USSD settings saved: on.');
    await expect(ussd.getByTestId('ussd-access-code')).toContainText(/Facility code: \d{6}/);
    await expect(ussd.getByTestId('ussd-access-code')).toContainText('opens no ticket');

    // a delay over the server bound is refused by the API too (the browser cannot bypass it)
    const bad = await page.request.put(`/api/v1/facilities/${s.facility.id}/sms`, {
      headers: CSRF,
      data: { enabled: true, daily_cap: 25, delay_seconds: 3600 },
    });
    expect(bad.status()).toBe(422);
    // and the browser cannot set a provider mode at all (strict body)
    const mode = await page.request.put(`/api/v1/facilities/${s.facility.id}/sms`, {
      headers: CSRF,
      data: { enabled: true, daily_cap: 25, deployment_mode: 'live' },
    });
    expect(mode.status()).toBe(400);
  });

  test('@responsive the Channels screen fits and passes axe at every width', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    await setDelay(page, s, 20);
    // one recorded alert, so the monitoring table is on screen too
    const v = await visitor(browser);
    await joinWithSms(v.page, s, '0803 999 0000');
    await v.ctx.close();
    await callNext(page, s);
    await page.goto(channelsPath(s));
    await expect(page.getByTestId('sms-monitor-table')).toContainText(
      'Waiting for the delay (not sent yet)',
    );
    await expect(page.getByTestId('ussd-monitor-counts')).toBeVisible();
    const layout = await page.getByTestId('channels-page').evaluate((screen) => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const cards = Array.from(screen.querySelectorAll(':scope > section'), (card) =>
        card.getBoundingClientRect(),
      );
      return {
        gaps: cards.slice(1).map((card, index) => card.top - cards[index]!.bottom),
        bottomClearance: window.innerHeight - cards[cards.length - 1]!.bottom,
      };
    });
    expect(layout.gaps).toHaveLength(3);
    for (const gap of layout.gaps) expect(gap).toBeGreaterThan(0);
    expect(layout.bottomClearance).toBeGreaterThanOrEqual(0);
    expect(layout.bottomClearance).toBeLessThan(100);
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await expectNoA11yViolations(page);
  });

  test('768 px: no horizontal overflow and axe clean', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1000 });
    const s = await apiQueueSetup(page.request);
    await page.goto(channelsPath(s));
    await expect(page.getByTestId('sms-monitor')).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await expectNoA11yViolations(page);
  });

  test('keyboard only: the settings can be changed and saved without a pointer', async ({
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    await page.goto(channelsPath(s));
    const box = page.getByLabel('Send text message turn alerts at this facility');
    await box.focus();
    await page.keyboard.press('Space');
    await expect(box).toBeChecked();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Daily limit for this facility (messages per day)')).toBeFocused();
    await page.keyboard.type('10');
    await page.getByTestId('sms-save').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('sms-saved')).toHaveText(
      '✓ SMS settings saved: on, sent immediately.',
    );
  });
});

test.describe('M6.3 Channels screen for other roles', () => {
  test('counter staff see the settings read-only and no monitoring; an auditor sees monitoring read-only', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    await setDelay(page, s, null);
    const counter = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    await counter.page.goto(channelsPath(s));
    await expect(counter.page.getByTestId('channels-read-only')).toBeVisible();
    await expect(
      counter.page.getByLabel('Send text message turn alerts at this facility'),
    ).toBeDisabled();
    await expect(counter.page.getByTestId('sms-save')).toHaveCount(0);
    await expect(counter.page.getByTestId('ussd-save')).toHaveCount(0);
    await expect(counter.page.getByTestId('sms-monitor')).toHaveCount(0);
    await expect(counter.page.getByTestId('channels-monitor-restricted')).toBeVisible();
    // the API refuses the change and the monitor too
    const put = await counter.page.request.put(`/api/v1/facilities/${s.facility.id}/sms`, {
      headers: CSRF,
      data: { enabled: false, daily_cap: 0 },
    });
    expect(put.status()).toBe(403);
    const mon = await counter.page.request.get(`/api/v1/facilities/${s.facility.id}/sms/monitor`);
    expect(mon.status()).toBe(403);
    await expectNoA11yViolations(counter.page);
    await counter.ctx.close();

    const auditor = await makeStaff(browser, page.request, s.facility.id, 'auditor');
    await auditor.page.goto(channelsPath(s));
    await expect(auditor.page.getByTestId('sms-monitor')).toBeVisible();
    await expect(auditor.page.getByTestId('ussd-monitor')).toBeVisible();
    await expect(
      auditor.page.getByLabel('Send text message turn alerts at this facility'),
    ).toBeDisabled();
    await expect(auditor.page.getByTestId('sms-save')).toHaveCount(0);
    await auditor.ctx.close();
  });

  test('Ask Que on the Channels screen offers the channel help, labelled as test mode', async ({
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    await setDelay(page, s, null);
    await page.goto(channelsPath(s));
    await page.getByTestId('ask-que').click();
    const panel = page.getByTestId('que-panel');
    await expect(panel.getByTestId('que-results')).toBeVisible();
    const titles = panel.locator('.que-article-link');
    await expect(
      titles.filter({ hasText: 'Text message settings and delivery monitoring' }),
    ).toHaveCount(1);
    await expect(titles.filter({ hasText: 'USSD settings and session monitoring' })).toHaveCount(1);
    await titles.filter({ hasText: 'Text message settings and delivery monitoring' }).click();
    await expect(panel.getByTestId('que-article')).toContainText('no real messages are sent');
  });
});

test.describe('M6.3 delayed SMS and the in-app acknowledgement (sandbox)', () => {
  test('the ticket page showed the alert before the delay ended: no SMS, no cap used, monitoring says so', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    await setDelay(page, s, 20);
    const v = await visitor(browser);
    const code = await joinWithSms(v.page, s, '0803 111 2233');
    await callNext(page, s);
    await expect(v.page.getByTestId('turn-banner')).toContainText(code);
    // the visible page acknowledged this committed call
    await expect.poll(() => seenCount(s, code)).toBe(1);
    const queued = await smsOf(s, code);
    expect(queued).toMatchObject({ status: 'pending', skip_if_seen: true });
    expect(queued?.due_in ?? 0).toBeGreaterThan(5);
    await makeDue(queued?.id ?? '');
    await runWorkerUntilReached('channels-seen', 'sms', [queued?.id ?? '']);
    expect(await smsOf(s, code)).toMatchObject({ status: 'suppressed', detail_code: 'alert_seen' });
    // not counted against the facility cap
    await page.goto(channelsPath(s));
    await expect(page.getByTestId('sms-usage')).toContainText('0 of 50');
    const table = page.getByTestId('sms-monitor-table');
    await expect(table.getByRole('row', { name: new RegExp(code) })).toContainText(
      'Not sent (the ticket page showed the alert first)',
    );
    await expect(page.getByTestId('sms-monitor')).not.toContainText('0803');
    await expectNoA11yViolations(page);
    await v.ctx.close();
  });

  test('no ticket page open: the delayed SMS waits for its time, then is sent (test provider)', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    await setDelay(page, s, 20);
    const v = await visitor(browser);
    const code = await joinWithSms(v.page, s, '0803 444 5566');
    await v.ctx.close();
    await callNext(page, s);
    const queued = await smsOf(s, code);
    expect(queued).toMatchObject({ status: 'pending', skip_if_seen: true });
    // not due yet: a worker run leaves it alone (database time)
    runWorkerOnce('channels-not-due');
    expect(await smsOf(s, code)).toMatchObject({ status: 'pending' });
    await makeDue(queued?.id ?? '');
    await runWorkerUntilReached('channels-sent', 'sms', [queued?.id ?? '']);
    expect(await smsOf(s, code)).toMatchObject({ status: 'sent' });
    expect(await seenCount(s, code)).toBe(0);
    await page.goto(channelsPath(s));
    await expect(
      page.getByTestId('sms-monitor-table').getByRole('row', { name: new RegExp(code) }),
    ).toContainText('Accepted by the test provider (nothing sent to a phone)');
  });

  test('a background tab does not acknowledge until it is shown', async ({ page, browser }) => {
    const s = await apiQueueSetup(page.request);
    await setDelay(page, s, 20);
    const v = await visitor(browser, { hidden: true });
    let acks = 0;
    v.page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/alerts/seen')) acks += 1;
    });
    const code = await joinWithSms(v.page, s, '0803 777 8899');
    await callNext(page, s);
    await expect(v.page.getByTestId('turn-banner')).toContainText(code);
    expect(acks).toBe(0);
    expect(await seenCount(s, code)).toBe(0);
    // the visitor switches to the tab
    await v.page.evaluate(() => {
      (window as unknown as { __qbHidden: boolean }).__qbHidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => seenCount(s, code)).toBe(1);
    expect(acks).toBe(1);
    await v.ctx.close();
  });

  test('immediate (default): the SMS is due at once and never skipped', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    await setDelay(page, s, null);
    const v = await visitor(browser);
    const code = await joinWithSms(v.page, s, '0803 222 3344');
    await callNext(page, s);
    await expect(v.page.getByTestId('turn-banner')).toContainText(code);
    await expect.poll(() => seenCount(s, code)).toBe(1);
    const queued = await smsOf(s, code);
    expect(queued?.skip_if_seen ?? false).toBe(false);
    expect(queued?.due_in ?? 99).toBeLessThanOrEqual(1);
    await runWorkerUntilReached('channels-immediate', 'sms', [queued?.id ?? '']);
    expect(await smsOf(s, code)).toMatchObject({ status: 'sent' });
    await v.ctx.close();
  });
});
