import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { apiQueueSetup, UUID_RE, type QueueSetup } from './helpers.js';

/**
 * 8.R4: the recovery key never travels in a URL (testing steering: "the QR/link carries the key
 * only in the URL fragment: the fragment never appears in server access logs or Referer, is
 * removed from the address bar after reading, and travels only in a POST body").
 *
 * Added after manual check 1 (2026-11-15) reported "the recovery code appears in the address
 * bar". The address after joining is `/ticket/<public code>?k=<device-local id>`: the `k` QUERY
 * parameter is the saved ticket's device-local id (a UUID that grants nothing), not the key. These
 * tests prove that for every path that handles a key: join, the recovery link or QR, and the staff
 * walk-in link. They record every main-frame navigation, every request URL, every Referer header
 * and every request body, follow Back, Forward and reload, and check four spellings of the key.
 * The key is read from the page and compared in memory only; it is never printed.
 */
type Setup = QueueSetup & { queueId: string | null };

/**
 * No secret in any output, also when an assertion fails: every check on a value that could hold a
 * key or token is a boolean or a count with a message, never the value itself. The on-failure
 * trace is off here because a trace records request bodies and page snapshots (the keys are
 * throwaway test-database keys, but they are still not written to artifacts).
 */
test.use({ trace: 'off' });

interface Trace {
  navigations: string[];
  /** when each main-frame navigation was observed (ms, monotonic) */
  at: number[];
  requests: { url: string; referer: string; body: string; method: string }[];
}
function watch(page: Page): Trace {
  const t: Trace = { navigations: [], at: [], requests: [] };
  page.on('framenavigated', (f) => {
    if (f !== page.mainFrame()) return;
    t.navigations.push(f.url());
    t.at.push(performance.now());
  });
  page.on('request', (r) => {
    t.requests.push({
      url: r.url(),
      referer: r.headers()['referer'] ?? '',
      body: r.postData() ?? '',
      method: r.method(),
    });
  });
  return t;
}
/** Every spelling a person or a program might use for the key. */
const spellings = (key: string): string[] => {
  const grouped = key.replace(/(.{4})(?!$)/g, '$1-');
  return [key, grouped, key.toLowerCase(), grouped.toLowerCase()];
};
const leaks = (haystack: string[], key: string): string[] =>
  haystack.filter((h) => spellings(key).some((k) => h.includes(k)));
/** How many of these strings contain the secret (a count: assertion messages never echo it). */
const leakCount = (haystack: string[], key: string): number => leaks(haystack, key).length;
/**
 * The address may hold the secret only while the link itself is loading: from the link's own
 * load, every navigation that carries it must come before the first clean one, and none may
 * follow. Returns how long (ms) the secret was in the address, or -1 if it stayed or reappeared.
 */
function fragmentWindow(t: Trace, secret: string): number {
  const carrying = t.navigations.map((u) => leakCount([u], secret) > 0);
  // measured from the link's own load (navigation events of the page before it may still arrive)
  const start = carrying.indexOf(true);
  if (start === -1) return 0;
  const firstClean = carrying.indexOf(false, start);
  if (firstClean === -1) return -1;
  if (carrying.slice(firstClean).some(Boolean)) return -1;
  return (t.at[firstClean] ?? 0) - (t.at[start] ?? 0);
}

async function context(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  return { ctx, page: await ctx.newPage() };
}
async function keyOnScreen(page: Page): Promise<string> {
  const text = (await page.getByTestId('recovery-key-text').innerText()).toUpperCase();
  const grouped = /(?:[0-9A-Z]{4}-){7}[0-9A-Z]{4}/.exec(text)?.[0] ?? '';
  expect(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/.test(grouped), 'key panel shows 8 groups of 4').toBe(
    true,
  );
  return grouped.replace(/-/g, '');
}
const sameOrigin = (t: Trace, origin: string): string[] =>
  t.requests.map((r) => r.url).filter((u) => !u.startsWith(origin) && !u.startsWith('data:'));

test.describe('8.R4 the recovery key never travels in a URL, Referer or history entry', () => {
  test('join: the address shows the public code and the device-local id only; no request, Referer, history entry or reload carries the key', async ({
    page,
    browser,
    baseURL,
  }) => {
    const s: Setup = await apiQueueSetup(page.request);
    const v = await context(browser);
    const trace = watch(v.page);
    await v.page.goto(s.joinPath);
    await v.page.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(v.page.getByTestId('recovery-key-panel')).toBeVisible();
    const key = await keyOnScreen(v.page);
    const code = (await v.page.getByTestId('ticket-code').innerText()).trim();

    // What the address bar shows: the public code in the path, the device-local id in `?k=`
    const url = new URL(v.page.url());
    expect(url.pathname).toBe(`/ticket/${code}`);
    expect(url.hash === '', 'address has no fragment').toBe(true);
    const localId = url.searchParams.get('k') ?? '';
    expect(new RegExp(`^${UUID_RE.source}$`, 'i').test(localId), '?k= is a device-local UUID').toBe(
      true,
    );
    expect(spellings(key).includes(localId), '?k= is not the key').toBe(false);
    // ... and that id is the saved ticket's own id on this device, nothing more
    const saved = await v.page.evaluate(
      () => JSON.parse(localStorage.getItem('qb.tickets.v1') ?? '[]') as { id: string }[],
    );
    expect(saved.map((x) => x.id)).toContain(localId);

    // QR shown, then confirmed; Back, Forward and reload
    await v.page.getByRole('button', { name: 'Show QR code' }).click();
    await expect(v.page.getByTestId('recovery-qr')).toBeVisible();
    expect(leakCount([v.page.url()], key), 'secret found').toBe(0);
    await v.page.getByRole('button', { name: 'I have saved my key' }).click();
    await v.page.goBack();
    await expect
      .poll(() => v.page.url().endsWith(s.joinPath), { message: 'Back reaches the join page' })
      .toBe(true);
    await v.page.goForward();
    await expect(v.page.getByTestId('ticket-code')).toHaveText(code);
    await v.page.reload();
    await expect(v.page.getByTestId('ticket-code')).toHaveText(code);
    await expect(v.page.getByTestId('recovery-key-panel')).toHaveCount(0);

    // Nowhere: not in any address the tab showed, any requested URL, any Referer, any body
    expect(leakCount(trace.navigations, key), 'secret found').toBe(0);
    expect(
      leakCount(
        trace.requests.map((r) => r.url),
        key,
      ),
      'secret found',
    ).toBe(0);
    expect(
      leakCount(
        trace.requests.map((r) => r.referer),
        key,
      ),
      'secret found',
    ).toBe(0);
    expect(
      leakCount(
        trace.requests.map((r) => r.body),
        key,
      ),
      'secret found',
    ).toBe(0);
    // no request to any other origin (no analytics, fonts or trackers to leak to)
    expect(
      sameOrigin(trace, new URL(baseURL ?? '').origin).length,
      'requests to other origins',
    ).toBe(0);
    await v.ctx.close();
  });

  test('recovery link or QR: the fragment is read once and replaced; Back never returns to it; the key leaves the device only in the recovery POST body', async ({
    page,
    browser,
    baseURL,
  }) => {
    const s: Setup = await apiQueueSetup(page.request);
    const a = await context(browser);
    await a.page.goto(s.joinPath);
    await a.page.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(a.page.getByTestId('recovery-key-panel')).toBeVisible();
    const key = await keyOnScreen(a.page);
    const code = (await a.page.getByTestId('ticket-code').innerText()).trim();

    const b = await context(browser);
    await b.page.goto('/'); // an earlier page in this tab's history
    const trace = watch(b.page);
    await b.page.goto(`/recover/${s.org.slug}/${s.facility.slug}/${code}#k=${key}`);
    await expect(b.page.getByTestId('ticket-code')).toHaveText(code);
    expect(new URL(b.page.url()).hash === '', 'address has no fragment').toBe(true);
    expect(leakCount([b.page.url()], key), 'secret found').toBe(0);

    // Only while the link itself loads (the browser's own load, which never sends a fragment to
    // a server) does the address hold the key; once it is clean it never holds it again
    const window = fragmentWindow(trace, key);
    expect(window, 'key reappeared in the address').toBeGreaterThanOrEqual(0);
    expect(window, 'key stayed in the address too long').toBeLessThan(2000);
    test
      .info()
      .annotations.push({ type: 'fragment-visible-ms', description: String(Math.round(window)) });
    // Never in a requested URL or a Referer header; in exactly one body: POST /tickets/recover
    expect(
      leakCount(
        trace.requests.map((r) => r.url),
        key,
      ),
      'secret found',
    ).toBe(0);
    expect(
      leakCount(
        trace.requests.map((r) => r.referer),
        key,
      ),
      'secret found',
    ).toBe(0);
    const bodies = trace.requests.filter((r) => leakCount([r.body], key) > 0);
    expect(bodies.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'POST /api/v1/tickets/recover',
    ]);

    // Back: the recovery entry was replaced twice (key removed, then the ticket page took its
    // place), so Back reaches the page before the link: there is no history entry holding the key
    const posts = trace.requests.length;
    await b.page.goBack();
    await expect
      .poll(() => b.page.url() === `${new URL(baseURL ?? '').origin}/`, {
        message: 'Back reaches the page before the link',
      })
      .toBe(true);
    expect(leakCount([b.page.url()], key), 'secret found').toBe(0);
    await b.page.goForward();
    await expect(b.page.getByTestId('ticket-code')).toHaveText(code);
    expect(leakCount([b.page.url()], key), 'secret found').toBe(0);
    // going back and forward never re-submitted the key
    expect(
      trace.requests.slice(posts).filter((r) => r.url.endsWith('/api/v1/tickets/recover')).length,
      'recovery re-submitted',
    ).toBe(0);
    await b.page.reload();
    expect(leakCount([b.page.url()], key), 'secret found').toBe(0);
    expect(
      sameOrigin(trace, new URL(baseURL ?? '').origin).length,
      'requests to other origins',
    ).toBe(0);
    for (const x of [a, b]) await x.ctx.close();
  });

  test('staff walk-in link: the token and key fragment is removed at once; Back, Forward and reload never bring it back', async ({
    page,
    browser,
    baseURL,
  }) => {
    const s: Setup = await apiQueueSetup(page.request);
    await page.goto(`/staff/queues/${s.queueId}`);
    await page.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await expect(page.getByTestId('walkin-key')).toBeVisible();
    await page.getByText('Show status link').click();
    const link = await page.getByTestId('walkin-link').innerText();
    const frag = new URLSearchParams(new URL(link).hash.slice(1));
    const key = frag.get('k') ?? '';
    const token = frag.get('t') ?? '';
    expect(/^[0-9A-Z]{32}$/.test(key), 'walk-in link carries a key').toBe(true);
    expect(/^[A-Za-z0-9_-]{43}$/.test(token), 'walk-in link carries a token').toBe(true);

    const v = await context(browser);
    await v.page.goto('/');
    const trace = watch(v.page);
    await v.page.goto(link);
    await expect(v.page.getByTestId('recovery-key-panel')).toBeVisible();
    expect(new URL(v.page.url()).hash === '', 'address has no fragment').toBe(true);
    for (const secret of [key, token]) {
      const window = fragmentWindow(trace, secret);
      expect(window, 'secret reappeared in the address').toBeGreaterThanOrEqual(0);
      expect(window, 'secret stayed in the address too long').toBeLessThan(2000);
      expect(
        leakCount(
          trace.requests.map((r) => r.url),
          secret,
        ),
        'secret found',
      ).toBe(0);
      expect(
        leakCount(
          trace.requests.map((r) => r.referer),
          secret,
        ),
        'secret found',
      ).toBe(0);
    }
    // the key is never sent anywhere; the token only in its request HEADER (not URL or body)
    expect(
      leakCount(
        trace.requests.map((r) => r.body),
        key,
      ),
      'secret found',
    ).toBe(0);
    expect(
      leakCount(
        trace.requests.map((r) => r.body),
        token,
      ),
      'secret found',
    ).toBe(0);
    // the ticket page saves the ticket after its first status response and then replaces the
    // address with `?k=<device-local id>`; wait for that before touching history, otherwise
    // Back races the in-page navigation
    const savedAddress = (): boolean =>
      UUID_RE.test(new URL(v.page.url()).searchParams.get('k') ?? '');
    await expect
      .poll(savedAddress, { message: 'ticket page reached its saved address' })
      .toBe(true);
    const home = `${new URL(baseURL ?? '').origin}/`;
    await v.page.goBack();
    await expect
      .poll(() => v.page.url() === home, { message: 'Back reaches the page before the link' })
      .toBe(true);
    await v.page.waitForLoadState('load');
    expect(leakCount([v.page.url()], key), 'secret found').toBe(0);
    expect(leakCount([v.page.url()], token), 'secret found').toBe(0);
    await v.page.goForward();
    await expect.poll(savedAddress, { message: 'Forward returns to the saved address' }).toBe(true);
    await expect(v.page.getByTestId('ticket-code')).toBeVisible();
    expect(leakCount([v.page.url()], key), 'secret found').toBe(0);
    expect(leakCount([v.page.url()], token), 'secret found').toBe(0);
    await v.page.reload();
    expect(leakCount([v.page.url()], key), 'secret found').toBe(0);
    expect(leakCount([v.page.url()], token), 'secret found').toBe(0);
    await v.ctx.close();
  });

  test('failure paths: a wrong key in a recovery link and an invalid walk-in link are removed from the address even though nothing else happens', async ({
    page,
    browser,
    baseURL,
  }) => {
    const s: Setup = await apiQueueSetup(page.request);
    // made-up secrets of the right shape (never real ones)
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const fake = (n: number, abc = alphabet): string =>
      Array.from({ length: n }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
    const wrongKey = fake(32);
    const v = await context(browser);
    await v.page.goto('/');
    const trace = watch(v.page);
    await v.page.goto(`/recover/${s.org.slug}/${s.facility.slug}/G001#k=${wrongKey}`);
    await expect(v.page.getByText(/could not recover a ticket/).first()).toBeVisible();
    expect(new URL(v.page.url()).hash === '', 'address has no fragment').toBe(true);
    expect(fragmentWindow(trace, wrongKey), 'key stayed or came back').toBeGreaterThanOrEqual(0);
    expect(
      leakCount(
        trace.requests.map((r) => r.url),
        wrongKey,
      ),
      'secret found',
    ).toBe(0);
    await v.page.reload();
    expect(leakCount([v.page.url()], wrongKey), 'secret found').toBe(0);
    expect(
      (await v.page.getByLabel('Recovery key').inputValue()).length === 0,
      'key field empty',
    ).toBe(true);

    const fakeToken = fake(43, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-');
    const fakeKey = fake(32);
    const w = await context(browser);
    await w.page.goto('/');
    const t2 = watch(w.page);
    await w.page.goto(`/ticket/G999#t=${fakeToken}&k=${fakeKey}`);
    await expect(w.page.getByTestId('ticket-unavailable')).toBeVisible();
    expect(new URL(w.page.url()).hash === '', 'address has no fragment').toBe(true);
    for (const secret of [fakeToken, fakeKey]) {
      expect(fragmentWindow(t2, secret), 'secret stayed or came back').toBeGreaterThanOrEqual(0);
      expect(
        leakCount(
          t2.requests.map((r) => r.url),
          secret,
        ),
        'secret found',
      ).toBe(0);
    }
    const home = `${new URL(baseURL ?? '').origin}/`;
    await w.page.goBack();
    await expect
      .poll(() => w.page.url() === home, { message: 'Back reaches the page before the link' })
      .toBe(true);
    await w.page.goForward();
    await expect(w.page.getByTestId('ticket-unavailable')).toBeVisible();
    expect(leakCount([w.page.url()], fakeKey), 'secret found').toBe(0);
    expect(leakCount([w.page.url()], fakeToken), 'secret found').toBe(0);
    for (const x of [v, w]) await x.ctx.close();
  });
});
