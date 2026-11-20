import postgres from 'postgres';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { uuidv7 } from '@queuebridge/contracts';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { apiQueueSetup, expectNoA11yViolations, hasHorizontalOverflow } from './helpers.js';
import { makeStaff } from './offline-helpers.js';
import { E2E_SMS_WEBHOOK_SECRET } from './push-env.js';
import { runWorkerUntilReached } from './worker-once.js';

/**
 * M6.1 SMS turn alerts in a real browser against the real stack (design §13; REQ-F11.8–F11.13;
 * Group 11 for the new controls). What is real: the API, PostgreSQL, the committed call, the
 * worker (run once, as in production) and its outbox pipeline, the signed webhook. What is
 * simulated: the provider. The adapter is the TEST-ONLY sandbox, so no message leaves the
 * machine and every message and screen says so. Nothing here proves delivery to a phone.
 */
const CSRF = { 'X-QB-CSRF': '1' };
const DB_URL = process.env['TEST_DATABASE_URL'] ?? '';
type Setup = Awaited<ReturnType<typeof apiQueueSetup>>;

/**
 * The documented sandbox formats, computed here independently of the implementation (apps/web
 * does not import `packages/channels`): message id `sbx_` + SHA-256(idempotency key)[0..32];
 * signature `v1=` HMAC-SHA-256(secret, `${timestamp}.${nonce}.${rawBody}`).
 */
const sandboxMessageId = (key: string): string =>
  `sbx_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
function signSmsWebhook(secret: string, body: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  return {
    'x-qb-sms-timestamp': ts,
    'x-qb-sms-nonce': nonce,
    'x-qb-sms-signature': `v1=${createHmac('sha256', secret).update(`${ts}.${nonce}.${body}`).digest('hex')}`,
  };
}

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function smsSetup(page: Page): Promise<Setup> {
  const s = await apiQueueSetup(page.request);
  const r = await page.request.put(`/api/v1/facilities/${s.facility.id}/sms`, {
    headers: CSRF,
    data: { enabled: true, daily_cap: 50 },
  });
  expect(r.status()).toBe(200);
  return s;
}

async function visitor(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  return { ctx, page: await ctx.newPage() };
}

async function callNext(page: Page, s: Setup): Promise<void> {
  const r = await page.request.post(`/api/v1/queues/${s.queueId ?? ''}/commands`, {
    headers: CSRF,
    data: { operation_id: uuidv7(), action: 'ticket.call_next', counter_id: s.counterId },
  });
  expect(r.status()).toBe(200);
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

const notificationOf = async (
  s: Setup,
  code: string,
): Promise<
  { id: string; status: string; detail_code: string | null; dedup_key: string } | undefined
> =>
  withDb(async (sql) => {
    const [r] = await sql<
      { id: string; status: string; detail_code: string | null; dedup_key: string }[]
    >`
      SELECT n.id, n.status, n.detail_code, o.dedup_key
        FROM notifications n JOIN notification_outbox o ON o.notification_id = n.id
        JOIN tickets t ON t.id = n.ticket_id
       WHERE t.public_code = ${code} AND t.queue_session_id = ${s.queueId ?? ''} AND n.channel = 'sms'
       ORDER BY n.created_at DESC LIMIT 1`;
    return r;
  });

test.describe('M6.1 SMS opt-in at joining', () => {
  test('separate, unticked, purpose-stated consent; test mode is labelled; joining never needs it', async ({
    page,
    browser,
  }) => {
    const s = await smsSetup(page);
    const v = await visitor(browser);
    await v.page.goto(s.joinPath);
    const box = v.page.getByTestId('sms-opt-in');
    await expect(
      v.page.getByRole('group', { name: 'Text message when you are called (optional)' }),
    ).toBeVisible();
    await expect(box.getByTestId('sms-test-mode')).toHaveText(
      'Test mode: no real text messages are sent here.',
    );
    await expect(v.page.getByTestId('sms-consent')).not.toBeChecked();
    await expect(box).toContainText('Send me a text message when I am called.');
    await expectNoA11yViolations(v.page);
    // a number without the box is never sent silently: nothing is created
    await v.page.getByLabel('Mobile number').fill('0803 123 4567');
    await v.page.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(
      v.page.getByText('Tick the box to get a text message, or clear the number.'),
    ).toBeVisible();
    await expect(v.page.getByLabel('Mobile number')).toBeFocused();
    await expect(v.page.getByTestId('ticket-code')).toHaveCount(0);
    // an invalid number is refused in place
    await v.page.getByLabel('Mobile number').fill('12345');
    await v.page.getByTestId('sms-consent').check();
    await v.page.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(v.page.getByText(/Enter a mobile number such as 0803 123 4567/)).toBeVisible();
    await expect(v.page.getByTestId('ticket-code')).toHaveCount(0);
    // leaving both empty joins normally
    await v.page.getByLabel('Mobile number').fill('');
    await v.page.getByTestId('sms-consent').uncheck();
    await v.page.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(v.page.getByTestId('ticket-code')).toBeVisible();
    await expect(v.page.getByTestId('ticket-sms')).toHaveCount(0);
    // the number is never written to this device
    const stored = await v.page.evaluate(
      () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    );
    expect(stored).not.toContain('1234567');
    await v.ctx.close();
  });

  test('a facility without SMS shows no phone field', async ({ page, browser }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitor(browser);
    await v.page.goto(s.joinPath);
    await expect(v.page.getByRole('button', { name: /Get a ticket/ })).toBeVisible();
    await expect(v.page.getByTestId('sms-opt-in')).toHaveCount(0);
    await v.ctx.close();
  });

  test('@responsive the SMS controls fit the screen and pass axe at every width', async ({
    page,
    browser,
  }) => {
    const s = await smsSetup(page);
    const v = await visitor(browser);
    await v.page.setViewportSize(page.viewportSize() ?? { width: 375, height: 800 });
    await v.page.goto(s.joinPath);
    await expect(v.page.getByTestId('sms-opt-in')).toBeVisible();
    expect(await hasHorizontalOverflow(v.page)).toBe(false);
    await expectNoA11yViolations(v.page);
    await joinWithSms(v.page, s, '08031234567');
    await expect(v.page.getByTestId('ticket-sms')).toBeVisible();
    expect(await hasHorizontalOverflow(v.page)).toBe(false);
    await expectNoA11yViolations(v.page);
    await v.ctx.close();
  });
});

test.describe('M6.1 SMS turn alert end to end (sandbox)', () => {
  test('committed call → worker sends a [TEST] message → signed receipt → staff see honest states; the visitor stops it', async ({
    page,
    browser,
  }) => {
    const s = await smsSetup(page);
    const v = await visitor(browser);
    const code = await joinWithSms(v.page, s, '0803 765 4321');
    const panel = v.page.getByTestId('ticket-sms');
    await expect(panel.getByTestId('sms-state')).toHaveText(
      'Text message alert is on for this ticket.',
    );
    await expect(panel.getByTestId('sms-test-mode')).toBeVisible();
    // stored encrypted: no digits of the number in the row
    const [row] = await withDb(
      (sql) => sql<{ ct: string }[]>`
        SELECT vc.phone_ciphertext AS ct FROM visitor_contacts vc JOIN tickets t ON t.id = vc.ticket_id
         WHERE t.public_code = ${code} AND t.queue_session_id = ${s.queueId ?? ''}`,
    );
    expect(row?.ct).toBeTruthy();
    expect(row?.ct).not.toContain('7654321');
    // the call commits; the in-app alert does not wait for SMS
    await callNext(page, s);
    await expect(v.page.getByTestId('turn-banner')).toContainText(code);
    const queued = await notificationOf(s, code);
    expect(queued).toMatchObject({ status: 'pending' });
    // the real worker (run once, or as often as the backlog ahead needs): the sandbox accepts,
    // never "delivered" from a send
    await runWorkerUntilReached('sms', 'sms', [queued?.id ?? '']);
    await expect.poll(async () => (await notificationOf(s, code))?.status).toBe('sent');
    await page.goto(`/staff/queues/${s.queueId ?? ''}`);
    const status = page.getByTestId('turn-alert-status');
    await expect(status.getByTestId('sms-alert-status')).toContainText(
      'Test text message accepted (sandbox: nothing sent to a phone)',
    );
    // the simulated provider receipt arrives on the signed webhook
    const n = await notificationOf(s, code);
    const body = JSON.stringify({
      kind: 'receipt',
      message_id: sandboxMessageId(n?.dedup_key ?? ''),
      status: 'delivered',
    });
    const hook = await page.request.post('/api/v1/webhooks/sms/sandbox', {
      headers: {
        'content-type': 'application/json',
        ...signSmsWebhook(E2E_SMS_WEBHOOK_SECRET, body),
      },
      data: body,
    });
    expect(hook.status()).toBe(200);
    await page.reload();
    await expect(
      page.getByTestId('turn-alert-status').getByTestId('sms-alert-status'),
    ).toContainText('Test receipt received (simulated: no real message)');
    // the visitor stops text messages from the ticket page (keyboard)
    const stop = panel.getByRole('button', { name: 'Stop text messages' });
    await stop.focus();
    await v.page.keyboard.press('Enter');
    await expect(panel.getByTestId('sms-state')).toHaveText(
      'Text message alert is off for this ticket. Your number has been deleted.',
    );
    await page.reload();
    await expect(page.getByTestId('staff-stop-sms')).toHaveCount(0);
    // nothing about SMS changed the ticket
    const [tk] = await withDb(
      (sql) =>
        sql<
          { state: string }[]
        >`SELECT state FROM tickets WHERE public_code = ${code} AND queue_session_id = ${s.queueId ?? ''}`,
    );
    expect(tk?.state).toBe('called');
    await v.ctx.close();
  });

  test('staff at the counter can stop text messages for the called visitor; auditors see no control', async ({
    page,
    browser,
  }) => {
    const s = await smsSetup(page);
    const v = await visitor(browser);
    await joinWithSms(v.page, s, '08051112222');
    await callNext(page, s);
    const counter = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    await counter.page.goto(`/staff/queues/${s.queueId ?? ''}`);
    const stop = counter.page.getByTestId('staff-stop-sms');
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(
      counter.page.getByText(
        'Text messages stopped for this visitor. Their number has been deleted.',
      ),
    ).toBeVisible();
    await expect(counter.page.getByTestId('staff-stop-sms')).toHaveCount(0);
    await v.page.reload();
    await expect(v.page.getByTestId('ticket-sms').getByTestId('sms-state')).toHaveText(
      'Text message alert is off for this ticket. Your number has been deleted.',
    );
    const auditor = await makeStaff(browser, page.request, s.facility.id, 'auditor');
    await auditor.page.goto(`/staff/queues/${s.queueId ?? ''}`);
    await expect(auditor.page.getByTestId('staff-stop-sms')).toHaveCount(0);
    await counter.ctx.close();
    await auditor.ctx.close();
    await v.ctx.close();
  });
});
