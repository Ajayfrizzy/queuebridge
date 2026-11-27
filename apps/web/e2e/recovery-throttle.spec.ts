import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from '@playwright/test';
import { apiQueueSetup, type QueueSetup } from './helpers.js';

/**
 * Manual check 6 (2026-11-15) recorded "recovery succeeded after more than five wrong keys". The
 * API request log of that run showed 9 recovery requests from one source: four 400 validation
 * errors, a 404, another 400, two 404s and then the 200. Only the three 404s were key checks;
 * the 400s were submissions the page sent with a field empty or malformed (the key field is a
 * password field and is cleared after every failure), and the page showed them with the same
 * "could not recover" message as a wrong key. So the limiter was never reached.
 *
 * These tests drive the real page through the same `/api` proxy configuration as `vite dev`
 * (`vite preview` reuses `server.proxy`), so every request reaches the API from one loopback
 * source, as in the manual run.
 *
 * Expiry after 15 minutes needs the database clock and is proved on real PostgreSQL by
 * `apps/api/src/recovery.db.test.ts` ("no irreversible lockout", "manual check 6 sequence").
 *
 * No secret in any output: the real key is compared in memory only, assertions on it are
 * booleans with messages, and the on-failure trace is off.
 */
test.use({ trace: 'off' });

type Setup = QueueSetup & { queueId: string | null };

const NOT_RECOVERED = /We could not recover a ticket with those details/;
const TOO_MANY = /Too many attempts from this connection/;
const MISSING = /Fill in the organization, the facility, the ticket code and the recovery key/;
const MALFORMED = /Some of these details are not in the expected form/;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A well-formed key (32 characters of the key alphabet) that is not `not`. */
function wrongKey(not: string): string {
  for (;;) {
    const k = Array.from(
      { length: 32 },
      () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)],
    ).join('');
    if (k !== not) return k;
  }
}
/** Spellings a person might type: lower case with spaces, hyphen groups, mixed case run-on. */
const SPELL = [
  (k: string): string => k.toLowerCase().replace(/(.{4})(?!$)/g, '$1 '),
  (k: string): string => k.replace(/(.{4})(?!$)/g, '$1-'),
  (k: string): string => k.replace(/(.)(.)/g, (_m, a: string, b: string) => a.toLowerCase() + b),
  (k: string): string => ` ${k.toLowerCase().replace(/(.{8})(?!$)/g, '$1-')} `,
  (k: string): string => k,
];

async function context(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  return { ctx, page: await ctx.newPage() };
}

async function joined(
  browser: Browser,
  s: Setup,
): Promise<{ code: string; key: string; ctx: BrowserContext }> {
  const v = await context(browser);
  await v.page.goto(s.joinPath);
  await v.page.getByRole('button', { name: /Get a ticket/ }).click();
  await expect(v.page.getByTestId('recovery-key-panel')).toBeVisible();
  const text = (await v.page.getByTestId('recovery-key-text').innerText()).toUpperCase();
  const grouped = /(?:[0-9A-Z]{4}-){7}[0-9A-Z]{4}/.exec(text)?.[0] ?? '';
  expect(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/.test(grouped), 'key panel shows 8 groups of 4').toBe(
    true,
  );
  const code = (await v.page.getByTestId('ticket-code').innerText()).trim();
  return { code, key: grouped.replace(/-/g, ''), ctx: v.ctx };
}

/** Recovery responses seen by the page: status and problem body without its correlation id. */
function recoveryResponses(page: Page): { status: number; body: string }[] {
  const seen: { status: number; body: string }[] = [];
  page.on('response', (r: Response) => {
    if (!r.url().endsWith('/api/v1/tickets/recover')) return;
    void r
      .json()
      .catch(() => ({}))
      .then((b: Record<string, unknown>) => {
        const { instance: _i, ticket: _t, ...rest } = b;
        // a 200 carries the status token: never kept, only its presence
        seen.push({ status: r.status(), body: JSON.stringify(rest) });
      });
  });
  return seen;
}

async function fill(page: Page, s: Setup, code: string, key: string): Promise<void> {
  await page.getByLabel('Organization').fill(s.org.slug);
  await page.getByLabel('Facility').fill(s.facility.slug);
  await page.getByLabel('Ticket code').fill(code);
  await page.getByLabel('Recovery key').fill(key);
}
async function submitAndRead(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Recover my ticket' }).click();
  const alert = page.getByTestId('recover-error');
  await expect(alert).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recover my ticket' })).toBeEnabled();
  return (await alert.innerText()).trim();
}

test.describe('manual check 6: throttle and uniform failures through the dev proxy', () => {
  test('five wrong keys in any spelling, then the right key is refused; a non-existent code fails identically', async ({
    page,
    browser,
  }) => {
    const s: Setup = await apiQueueSetup(page.request);
    const v = await joined(browser, s);
    const r = await context(browser);
    const seen = recoveryResponses(r.page);
    await r.page.goto('/recover');

    const messages: string[] = [];
    for (let i = 0; i < 5; i++) {
      // the key field is cleared after every failure, so every attempt types a key again
      await fill(r.page, s, v.code, SPELL[i]!(wrongKey(v.key)));
      messages.push(await submitAndRead(r.page));
    }
    for (const m of messages) expect(m).toMatch(NOT_RECOVERED);
    expect(new Set(messages).size, 'failures 1–5 show one identical message').toBe(1);

    // The 6th attempt, with the RIGHT key, is refused: the ticket does not open
    await fill(r.page, s, v.code, v.key.toLowerCase().replace(/(.{4})(?!$)/g, '$1 '));
    expect(await submitAndRead(r.page)).toMatch(TOO_MANY);
    expect(new URL(r.page.url()).pathname, 'ticket not opened').toBe('/recover');

    // the server saw exactly five key checks that failed, then a refusal; nothing malformed
    await expect.poll(() => seen.length).toBe(6);
    expect(seen.map((x) => x.status)).toEqual([404, 404, 404, 404, 404, 429]);

    // A code that does not exist: the same message, status and body as the real ticket
    const before = seen.length;
    await fill(r.page, s, 'Z999', wrongKey(''));
    const missing = await submitAndRead(r.page);
    expect(missing).toBe(messages[0]);
    await expect.poll(() => seen.length).toBe(before + 1);
    expect(seen[before]?.status).toBe(404);
    expect(seen[before]?.body, 'non-existent code: same problem body').toBe(seen[0]?.body);

    // The rightful holder's own device is unaffected (no lockout of the ticket itself)
    const holder = await context(browser);
    await holder.page.goto('/recover');
    await fill(holder.page, s, v.code, v.key);
    // same loopback source as the attacker here, so it is refused too: shared-address behaviour
    // as documented (manual check 6 preconditions); a clean source is proved in the API suite
    expect(await submitAndRead(holder.page)).toMatch(TOO_MANY);
    for (const c of [v.ctx, r.ctx, holder.ctx]) await c.close();
  });

  test('an empty or malformed submission is not shown as a failed recovery and is never sent as one', async ({
    page,
    browser,
  }) => {
    const s: Setup = await apiQueueSetup(page.request);
    const v = await joined(browser, s);
    const r = await context(browser);
    const seen = recoveryResponses(r.page);
    await r.page.goto('/recover');

    // A wrong key, then "Recover my ticket" again: the (password) key field was cleared
    await fill(r.page, s, v.code, wrongKey(v.key));
    expect(await submitAndRead(r.page)).toMatch(NOT_RECOVERED);
    expect(
      (await r.page.getByLabel('Recovery key').inputValue()).length === 0,
      'key field cleared',
    ).toBe(true);
    expect(await submitAndRead(r.page)).toMatch(MISSING);
    // nothing was sent for the empty submission
    await expect.poll(() => seen.length).toBe(1);

    // Every required field is checked before sending
    for (const label of ['Organization', 'Facility', 'Ticket code']) {
      await fill(r.page, s, v.code, wrongKey(v.key));
      await r.page.getByLabel(label).fill('   ');
      expect(await submitAndRead(r.page)).toMatch(MISSING);
    }
    expect(seen.length, 'no request for an incomplete form').toBe(1);

    // A malformed value that only the server can reject (ticket code too long): a format message,
    // never the "could not recover" message (a format error says nothing about any ticket)
    await fill(r.page, s, 'TOOLONG123', wrongKey(v.key));
    expect(await submitAndRead(r.page)).toMatch(MALFORMED);
    await expect.poll(() => seen.length).toBe(2);
    expect(seen[1]?.status).toBe(400);

    // The counted failures are still exactly the key checks: four more wrong keys reach the limit
    for (let i = 0; i < 4; i++) {
      await fill(r.page, s, v.code, wrongKey(v.key));
      expect(await submitAndRead(r.page)).toMatch(NOT_RECOVERED);
    }
    await fill(r.page, s, v.code, v.key);
    expect(await submitAndRead(r.page)).toMatch(TOO_MANY);
    for (const c of [v.ctx, r.ctx]) await c.close();
  });
});
