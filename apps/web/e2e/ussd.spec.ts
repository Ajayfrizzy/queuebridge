import postgres from 'postgres';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { uuidv7 } from '@queuebridge/contracts';
import { createHmac, randomBytes } from 'node:crypto';
import { apiQueueSetup } from './helpers.js';
import { E2E_USSD_WEBHOOK_SECRET } from './push-env.js';

/**
 * M6.2 USSD in the sandbox against the real stack (REQ-F12.5: end-to-end sandbox sessions).
 * Real: the API, PostgreSQL, the session store, the join path, the recovery-key check, the staff
 * call, the public board in a browser. Simulated: the provider, whose signed requests this spec
 * sends. No shortcode is dialled and no mobile network is involved; every screen says [SANDBOX].
 *
 * The documented sandbox signature is computed here independently of the implementation (the web
 * app does not import `packages/channels`): `v1=` HMAC-SHA-256(secret,
 * `ussd.v1.${timestamp}.${nonce}.${rawBody}`).
 */
const CSRF = { 'X-QB-CSRF': '1' };
const DB_URL = process.env['TEST_DATABASE_URL'] ?? '';
type Setup = Awaited<ReturnType<typeof apiQueueSetup>>;

function sign(body: string, secret = E2E_USSD_WEBHOOK_SECRET): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  return {
    'x-qb-ussd-timestamp': ts,
    'x-qb-ussd-nonce': nonce,
    'x-qb-ussd-signature': `v1=${createHmac('sha256', secret).update(`ussd.v1.${ts}.${nonce}.${body}`).digest('hex')}`,
  };
}

/** A subscriber on a feature phone, as the (simulated) provider forwards it. */
class Dial {
  readonly session = `sess_${randomBytes(6).toString('hex')}`;
  readonly msisdn = `+234806${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  private readonly inputs: string[] = [];
  constructor(private readonly request: APIRequestContext) {}
  async send(input?: string): Promise<{ status: number; text: string }> {
    if (input !== undefined) this.inputs.push(input);
    return this.post();
  }
  private async post(): Promise<{ status: number; text: string }> {
    const body = JSON.stringify({
      session_id: this.session,
      msisdn: this.msisdn,
      text: this.inputs.join('*'),
    });
    const r = await this.request.post('/api/v1/webhooks/ussd/sandbox', {
      headers: { 'content-type': 'application/json', ...sign(body) },
      data: body,
    });
    return { status: r.status(), text: await r.text() };
  }
  /** The provider repeating the last callback (same text, re-signed). */
  async repeat(): Promise<{ status: number; text: string }> {
    return this.post();
  }
  async run(...inputs: string[]): Promise<string> {
    let last = (await this.send()).text;
    for (const i of inputs) last = (await this.send(i)).text;
    return last;
  }
}

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function ussdSetup(page: Page): Promise<Setup & { code: string }> {
  const s = await apiQueueSetup(page.request);
  const r = await page.request.put(`/api/v1/facilities/${s.facility.id}/ussd`, {
    headers: CSRF,
    data: { enabled: true },
  });
  expect(r.status()).toBe(200);
  const code = String(((await r.json()) as { ussd: { access_code: string } }).ussd.access_code);
  expect(code).toMatch(/^[1-9][0-9]{5}$/);
  return { ...s, code };
}

test.describe('M6.2 USSD sandbox end to end', () => {
  test('a feature-phone visitor joins over the signed webhook; staff call the ticket; the board and the phone both show the call', async ({
    page,
    browser,
  }) => {
    const s = await ussdSetup(page);
    const phone = new Dial(page.request);
    const first = await phone.send();
    expect(first.status).toBe(200);
    expect(first.text.startsWith('CON [SANDBOX]')).toBe(true);
    expect(first.text).toContain('QueueBridge test service.');
    expect(await phone.send(s.code)).toMatchObject({
      text: expect.stringContaining('1 Join a queue'),
    });
    expect((await phone.send('1')).text).toContain('Choose a service:');
    expect((await phone.send('1')).text).toContain('1 Join');
    const joined = (await phone.send('1')).text;
    const m =
      /^END \[SANDBOX\]\nTicket ([A-Z]{1,3}[0-9]{3,4}),[\s\S]*Key: ((?:[0-9A-Z]{4} ?){8})/.exec(
        joined,
      );
    expect(m, joined).not.toBeNull();
    const code = m?.[1] ?? '';
    const key = (m?.[2] ?? '').replace(/ /g, '');
    // the provider repeating the confirm returns the same screen, never a second ticket
    expect((await phone.repeat()).text).toBe(joined);
    const tickets = await withDb(
      (sql) => sql<{ public_code: string; state: string }[]>`
        SELECT public_code, state FROM tickets
         WHERE queue_session_id = ${s.queueId ?? ''} AND created_channel = 'ussd'`,
    );
    expect(tickets).toEqual([{ public_code: code, state: 'waiting' }]);
    // status needs the code AND the key
    const status = await new Dial(page.request).run(s.code, '2', code, key);
    expect(status).toContain(`${code} `);
    expect(status).toContain('waiting, you are next.');
    // staff call it (authoritative command); the public board shows it in a browser
    const call = await page.request.post(`/api/v1/queues/${s.queueId ?? ''}/commands`, {
      headers: CSRF,
      data: { operation_id: uuidv7(), action: 'ticket.call_next', counter_id: s.counterId },
    });
    expect(call.status()).toBe(200);
    const board = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
    await board.goto(s.displayPath);
    await expect(board.locator('main')).toContainText(code);
    await board.context().close();
    // and the phone, checking again, sees the call
    expect(await new Dial(page.request).run(s.code, '2', code, key)).toContain('called. Go to');
  });

  test('a code alone never opens a ticket; unsigned requests are refused; nothing changes', async ({
    page,
  }) => {
    const s = await ussdSetup(page);
    const owner = await new Dial(page.request).run(s.code, '1', '1', '1');
    const code = /Ticket ([A-Z]{1,3}[0-9]{3,4})/.exec(owner)?.[1] ?? '';
    const wrong = await new Dial(page.request).run(s.code, '2', code, 'A'.repeat(32));
    expect(wrong).toContain('could not open a ticket with these details');
    const lost = await new Dial(page.request).run(s.code, '3', '2');
    expect(lost).toContain('A phone number or a ticket code alone cannot open a ticket.');
    const unsigned = await page.request.post('/api/v1/webhooks/ussd/sandbox', {
      headers: { 'content-type': 'application/json', ...sign('{}', 'x'.repeat(48)) },
      data: JSON.stringify({ session_id: 'sess_unsigned1', msisdn: '+2348060000000', text: '' }),
    });
    expect(unsigned.status()).toBe(401);
    const [n] = await withDb(
      (sql) => sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM tickets WHERE queue_session_id = ${s.queueId ?? ''}`,
    );
    expect(n?.n).toBe(1);
  });
});
