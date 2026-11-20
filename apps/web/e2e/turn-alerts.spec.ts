import postgres from 'postgres';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { uuidv7 } from '@queuebridge/contracts';
import { apiQueueSetup, expectNoA11yViolations, hasHorizontalOverflow } from './helpers.js';
import { E2E_PUSH_HOST } from './push-env.js';
import { runWorkerUntilReached } from './worker-once.js';

/**
 * M5.4 Smart Turn Alerts in real browsers against the real stack (testing steering Group 14:
 * 14.1, 14.3, 14.4, 14.5, 14.7, 14.8, 14.12, 14.13, 14.14; Group 11 at 320/375/1280/1440 px).
 *
 * What is real: the API, PostgreSQL, the committed queue commands, the worker (run once, as in
 * production) and its delivery pipeline. What is simulated, and why: browsers in CI have no push
 * service, so `PushManager`/`Notification` are replaced by an in-page double that returns a
 * subscription on a fictional host, and the worker uses the TEST-ONLY sandbox transport. The
 * service-worker hand-off is the `message` event the real handler posts (its logic is unit-tested
 * against the real file in src/lib/pushHandler.test.ts). Nothing here proves delivery on a real
 * device; that is a recorded manual check (docs/testing/M5-evidence.md).
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

interface PushInit {
  /** Notification.permission at page load */
  permission?: 'default' | 'granted' | 'denied';
  /** what the (double) permission prompt answers */
  onRequest?: 'granted' | 'denied' | 'default';
  /** path prefix of the fictional endpoint: drives the sandbox outcome (/ok/, /gone/, …) */
  endpointPath?: string;
  /** remove PushManager (a browser without push) */
  noPush?: boolean;
  prefs?: Record<string, unknown>;
}

/** A visitor browser with the push double installed (see the file comment). */
async function visitor(
  browser: Browser,
  init: PushInit = {},
  ctxOpts: Parameters<Browser['newContext']>[0] = {},
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...ctxOpts });
  await ctx.addInitScript(
    ({ o, host }) => {
      const w = window as unknown as Record<string, unknown>;
      if (o.prefs && !localStorage.getItem('qb.a11y.v1')) {
        localStorage.setItem('qb.a11y.v1', JSON.stringify(o.prefs));
      }
      w['__permCalls'] = 0;
      w['__subscribeCalls'] = 0;
      w['__unsubscribed'] = 0;
      w['__vib'] = [] as unknown[];
      const perm = sessionStorage.getItem('qb.e2e.perm');
      w['__perm'] = perm ?? o.permission ?? 'default';
      Object.defineProperty(Navigator.prototype, 'vibrate', {
        configurable: true,
        value: (p: unknown): boolean => {
          (w['__vib'] as unknown[]).push(p);
          return true;
        },
      });
      if (o.noPush) delete w['PushManager'];
      if ('Notification' in window) {
        Object.defineProperty(Notification, 'permission', {
          configurable: true,
          get: () => w['__perm'],
        });
        Object.defineProperty(Notification, 'requestPermission', {
          configurable: true,
          value: async (): Promise<string> => {
            w['__permCalls'] = Number(w['__permCalls']) + 1;
            if (w['__perm'] === 'default') w['__perm'] = o.onRequest ?? 'granted';
            sessionStorage.setItem('qb.e2e.perm', String(w['__perm']));
            return String(w['__perm']);
          },
        });
      }
      const KEY = 'qb.e2e.pushsub';
      const b64 = (n: number): string =>
        btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n))))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
      const make = (json: { endpoint: string }): unknown => ({
        endpoint: json.endpoint,
        options: { applicationServerKey: null },
        toJSON: () => json,
        unsubscribe: async (): Promise<boolean> => {
          sessionStorage.removeItem(KEY);
          w['__unsubscribed'] = Number(w['__unsubscribed']) + 1;
          return true;
        },
      });
      const reg = {
        pushManager: {
          getSubscription: async (): Promise<unknown> => {
            const raw = sessionStorage.getItem(KEY);
            return raw ? make(JSON.parse(raw) as { endpoint: string }) : null;
          },
          subscribe: async (): Promise<unknown> => {
            w['__subscribeCalls'] = Number(w['__subscribeCalls']) + 1;
            const json = {
              endpoint: `https://${host}${o.endpointPath ?? '/ok/'}${b64(12)}`,
              expirationTime: null,
              keys: { p256dh: b64(65), auth: b64(16) },
            };
            sessionStorage.setItem(KEY, JSON.stringify(json));
            return make(json);
          },
        },
      };
      if (navigator.serviceWorker) {
        Object.defineProperty(navigator.serviceWorker, 'ready', {
          configurable: true,
          get: () => Promise.resolve(reg),
        });
      }
    },
    { o: init, host: E2E_PUSH_HOST },
  );
  return { ctx, page: await ctx.newPage() };
}

async function joinAsVisitor(page: Page, s: Setup): Promise<string> {
  await page.goto(s.joinPath);
  await page.getByRole('button', { name: /Get a ticket/ }).click();
  await expect(page.getByTestId('ticket-code')).toBeVisible();
  await page.getByRole('button', { name: 'I have saved my key' }).click();
  return (await page.getByTestId('ticket-code').innerText()).trim();
}
/** Staff command through the API, as the signed-in staff member of `who` (a page or context). */
async function command(
  who: { request: APIRequestContext },
  queueId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const r = await who.request.post(`/api/v1/queues/${queueId}/commands`, {
    headers: CSRF,
    data: { operation_id: uuidv7(), ...body },
  });
  expect(r.status(), await r.text()).toBe(200);
}
const callNext = (who: { request: APIRequestContext }, s: Setup): Promise<void> =>
  command(who, s.queueId ?? '', { action: 'ticket.call_next', counter_id: s.counterId });

/** The saved tickets on the visitor's device (to read its token and pushRef). */
async function saved(page: Page): Promise<
  {
    id: string;
    code: string;
    token: string;
    facilityName: string;
    serviceName: string;
    pushRef?: string;
  }[]
> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('qb.tickets.v1') ?? '[]') as never);
}
const counters = async (
  page: Page,
): Promise<{ perm: number; subscribe: number; unsubscribed: number; vib: number }> =>
  page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      perm: Number(w['__permCalls']),
      subscribe: Number(w['__subscribeCalls']),
      unsubscribed: Number(w['__unsubscribed']),
      vib: (w['__vib'] as unknown[]).length,
    };
  });
/**
 * After a worker run, the outcome of this device's alert. Workers of tests running in parallel
 * may have claimed the row (SKIP LOCKED) and still be sending it, so wait for an outcome instead
 * of reading a snapshot (bounded by the expect timeout).
 */
async function outcomeOf(ref: string): Promise<{ status: string; detail_code: string }[]> {
  await expect
    .poll(async () => (await notificationsOf(ref)).every((n) => n.status !== 'pending'))
    .toBe(true);
  return notificationsOf(ref);
}
/**
 * The real worker (`--once`), run as often as the backlog of older push rows ahead of these
 * devices' alerts needs (see `runWorkerUntilReached`; a single run is not enough when more than
 * one batch is ahead, reproduced 2026-11-20). The outcome assertions that follow are unchanged.
 */
async function runWorkerFor(...refs: string[]): Promise<void> {
  const ids = await withDb(
    (sql) => sql<{ id: string }[]>`
      SELECT id FROM notifications WHERE push_subscription_id IN ${sql(refs)}`,
  );
  expect(ids.length).toBeGreaterThan(0);
  await runWorkerUntilReached(
    'turn-alerts',
    'web_push',
    ids.map((r) => r.id),
  );
}
async function notificationsOf(ref: string): Promise<{ status: string; detail_code: string }[]> {
  return withDb(
    (sql) => sql<{ status: string; detail_code: string }[]>`
      SELECT status, detail_code FROM notifications WHERE push_subscription_id = ${ref}
       ORDER BY created_at`,
  );
}
async function callSequenceOf(ref: string): Promise<number> {
  const [r] = await withDb(
    (sql) =>
      sql<
        { seq: number }[]
      >`SELECT event_sequence AS seq FROM notifications WHERE push_subscription_id = ${ref} ORDER BY created_at DESC LIMIT 1`,
  );
  return r?.seq ?? 0;
}
async function checkLayout(page: Page): Promise<void> {
  await expectNoA11yViolations(page);
  expect(await hasHorizontalOverflow(page)).toBe(false);
}
async function enablePush(page: Page): Promise<string> {
  await page.getByTestId('push-on').click();
  await expect(page.getByTestId('push-state')).toHaveAttribute('data-state', 'on');
  const ref = (await saved(page))[0]?.pushRef ?? '';
  expect(ref).toMatch(/^[0-9a-f-]{36}$/);
  return ref;
}

// ---------------------------------------------------------------------------------------------
// 14.1 in-app alert + 14.8 accessibility at every width
// ---------------------------------------------------------------------------------------------

test.describe('@responsive 14.1 in-app turn alert', () => {
  test('a committed call shows a persistent banner and announces once; reload and live replays never repeat it', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitor(browser, {}, { viewport: page.viewportSize() });
    const code = await joinAsVisitor(v.page, s);
    // nothing is requested on page load
    expect((await counters(v.page)).perm).toBe(0);
    await expect(v.page.getByTestId('turn-banner')).toHaveCount(0);
    await callNext(page, s);
    const banner = v.page.getByTestId('turn-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('It is your turn');
    await expect(banner).toContainText(code);
    await expect(banner).toContainText('Counter 1');
    await expect(banner).toContainText('Status: Called');
    await expect(banner).toContainText('General Consultation');
    await expect(v.page.getByTestId('turn-alert')).toContainText('Counter 1');
    await expect(v.page.getByTestId('turn-alert')).toHaveAttribute('aria-live', 'assertive');
    await expect(v.page).toHaveTitle(`Your turn: ${code} — QueueBridge`);
    expect((await counters(v.page)).vib).toBe(1);
    await checkLayout(v.page);
    // a reload shows the same committed call: the banner stays, nothing is announced or felt again
    await v.page.reload();
    await expect(v.page.getByTestId('turn-banner')).toBeVisible();
    await expect(v.page.getByTestId('turn-alert')).toHaveText('');
    expect((await counters(v.page)).vib).toBe(0); // fresh page, and no new cue
    // dismiss with the keyboard: focus goes to the page heading, not to the top of the document
    await v.page.getByTestId('turn-banner-dismiss').focus();
    await v.page.keyboard.press('Enter');
    await expect(v.page.getByTestId('turn-banner')).toHaveCount(0);
    await expect(v.page.locator('#main h1')).toBeFocused();
    // the status card still says Called, in text
    await expect(v.page.getByTestId('ticket-state')).toHaveText('Called');
    // released and called again: a NEW committed call alerts again
    const tid = await ticketId(page, s, code);
    await command(page, s.queueId ?? '', { action: 'ticket.resume', ticket_id: tid });
    await expect(v.page.getByTestId('ticket-state')).toHaveText('Waiting');
    await expect(v.page).not.toHaveTitle(/Your turn/);
    await callNext(page, s);
    await expect(v.page.getByTestId('turn-banner')).toBeVisible();
    await expect(v.page.getByTestId('turn-alert')).toContainText('Counter 1');
    expect((await counters(v.page)).vib).toBe(1);
    await v.ctx.close();
  });

  test('push panel states read correctly and pass axe at every width', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitor(browser, {}, { viewport: page.viewportSize() });
    await joinAsVisitor(v.page, s);
    const panel = v.page.getByTestId('push-panel');
    await expect(panel).toContainText('best effort');
    await expect(panel).toContainText('public board');
    await expect(v.page.getByTestId('push-on')).toBeVisible();
    await checkLayout(v.page);
    await enablePush(v.page);
    await checkLayout(v.page);
    await v.ctx.close();
  });
});

async function ticketId(page: Page, s: Setup, code: string): Promise<string> {
  const r = await page.request.get(`/api/v1/queues/${s.queueId ?? ''}`);
  return (
    (
      (await r.json()) as { queue: { tickets: { id: string; public_code: string }[] } }
    ).queue.tickets.find((t) => t.public_code === code)?.id ?? ''
  );
}

test.describe('14.1 / 14.8 alert preferences and display modes', () => {
  test('quiet mode: no sound or vibration, the visual banner and announcement still come', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitor(browser, { prefs: { quiet: true, sound: true, vibration: true } });
    await joinAsVisitor(v.page, s);
    await callNext(page, s);
    await expect(v.page.getByTestId('turn-banner')).toBeVisible();
    await expect(v.page.getByTestId('turn-alert')).toContainText('Counter 1');
    expect((await counters(v.page)).vib).toBe(0);
    await v.ctx.close();
  });

  test('high contrast, extra-large text and reduced motion at 320 px: no animation, no overflow, axe clean; no motion in any mode', async ({
    page,
    browser,
  }) => {
    for (const variant of ['in-app', 'system'] as const) {
      const s = await apiQueueSetup(page.request);
      const v = await visitor(
        browser,
        {
          prefs:
            variant === 'in-app'
              ? { contrast: 'high', textSize: 'xlarge', motion: 'reduce' }
              : { contrast: 'high', textSize: 'xlarge' },
        },
        {
          viewport: { width: 320, height: 640 },
          reducedMotion: variant === 'system' ? 'reduce' : 'no-preference',
        },
      );
      await joinAsVisitor(v.page, s);
      await callNext(page, s);
      const banner = v.page.getByTestId('turn-banner');
      await expect(banner).toBeVisible();
      expect(await banner.evaluate((el) => getComputedStyle(el).animationName), variant).toBe(
        'none',
      );
      await checkLayout(v.page);
      await v.ctx.close();
    }
    // and with no preference at all: the banner never moves (the app declares no animation)
    const s = await apiQueueSetup(page.request);
    const v = await visitor(browser);
    await joinAsVisitor(v.page, s);
    await callNext(page, s);
    const banner = v.page.getByTestId('turn-banner');
    await expect(banner).toBeVisible();
    expect(
      await banner.evaluate((el) => {
        const c = getComputedStyle(el);
        return { animation: c.animationName, transition: c.transitionDuration };
      }),
    ).toEqual({ animation: 'none', transition: '0s' });
    await v.ctx.close();
  });

  test('a call that arrives while the settings dialog is open closes it and keeps focus on the page', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitor(browser);
    await joinAsVisitor(v.page, s);
    await v.page.getByTestId('open-display-settings').first().click();
    await expect(v.page.getByTestId('display-settings')).toBeVisible();
    await callNext(page, s);
    await expect(v.page.getByTestId('display-settings')).toBeHidden();
    await expect(v.page.getByTestId('turn-banner')).toBeVisible();
    await expect(v.page.getByTestId('turn-alert')).toContainText('Counter 1');
    // focus went back to a real control, never lost to the document body
    expect(await v.page.evaluate(() => document.activeElement?.tagName ?? 'BODY')).not.toBe('BODY');
    await v.ctx.close();
  });

  test('with every option off and no push support, the ticket page and the public board still show the call', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitor(browser, {
      noPush: true,
      prefs: { quiet: true, sound: false, vibration: false },
    });
    const code = await joinAsVisitor(v.page, s);
    await expect(v.page.getByTestId('push-state')).toHaveAttribute('data-state', 'unsupported');
    await callNext(page, s);
    await expect(v.page.getByTestId('turn-banner')).toContainText(code);
    const board = await v.ctx.newPage();
    await board.goto(s.displayPath);
    await expect(board.locator('main')).toContainText(code);
    await expect(board.locator('main')).toContainText('Counter 1');
    await v.ctx.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 14.3 consent and subscription flow, 14.4/14.5 pipeline, 14.12 cap
// ---------------------------------------------------------------------------------------------

test.describe('14.3 push consent and the delivery pipeline', () => {
  test('opt-in only on click; the worker sends; staff see honest states; the page acknowledges; turn off revokes and erases', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitor(browser);
    const code = await joinAsVisitor(v.page, s);
    expect((await counters(v.page)).perm).toBe(0);
    const ref = await enablePush(v.page);
    expect(await counters(v.page)).toMatchObject({ perm: 1, subscribe: 1 });
    // stored encrypted: neither the fictional host nor the keys are readable in the row
    const [row] = await withDb(
      (sql) => sql<{ ct: string; revoked: boolean }[]>`
        SELECT encode(endpoint_ct, 'escape') AS ct, revoked_at IS NOT NULL AS revoked
          FROM push_subscriptions WHERE id = ${ref}`,
    );
    expect(row?.revoked).toBe(false);
    expect(row?.ct).not.toContain(E2E_PUSH_HOST);
    // the call commits; the worker (real, once) sends through the sandbox
    await callNext(page, s);
    await expect(v.page.getByTestId('turn-banner')).toBeVisible();
    // one entry for this device (pending until a worker, possibly another test's, sends it)
    expect(await notificationsOf(ref)).toHaveLength(1);
    await runWorkerFor(ref);
    expect(await outcomeOf(ref)).toEqual([{ status: 'sent', detail_code: 'accepted' }]);
    // staff console: plain words, never "delivered" for an accepted push
    await page.goto(`/staff/queues/${s.queueId ?? ''}`);
    const status = page.getByTestId('turn-alert-status');
    await expect(status.getByTestId('turn-alert-device')).toHaveText('Push sent, not confirmed');
    await expect(status).toContainText(
      'The public board and calling aloud remain the reliable fallback.',
    );
    // the service worker hands the push to the focused page; only the PAGE acknowledges
    const seq = await callSequenceOf(ref);
    await v.page.evaluate(
      ({ ref: r, code: c, seq: n }) =>
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'qb-turn-alert', ref: r, code: c, seq: n, counter: 'Counter 1' },
          }),
        ),
      { ref, code, seq },
    );
    await expect
      .poll(async () => (await notificationsOf(ref))[0])
      .toEqual({ status: 'delivered', detail_code: 'client_ack' });
    // a hand-off is never shown as a second notice on the page that claimed it
    await expect(v.page.getByTestId('push-handoff-notice')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('turn-alert-device')).toHaveText('Seen on device');
    // turn off with the keyboard
    await v.page.getByTestId('push-off').focus();
    await v.page.keyboard.press('Enter');
    await expect(v.page.getByTestId('push-state')).toHaveCount(0);
    await expect(v.page.getByTestId('push-on')).toBeVisible();
    await expect(v.page.getByTestId('push-note')).toContainText('off');
    expect((await counters(v.page)).unsubscribed).toBe(1);
    expect((await saved(v.page))[0]?.pushRef).toBeUndefined();
    const [after] = await withDb(
      (sql) => sql<{ reason: string; ct: string | null }[]>`
        SELECT revoke_reason AS reason, endpoint_ct::text AS ct FROM push_subscriptions WHERE id = ${ref}`,
    );
    expect(after).toEqual({ reason: 'visitor', ct: null });
    await v.ctx.close();
  });

  test('a refused permission is respected: specific text, no button, no prompt on reload', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitor(browser, { onRequest: 'denied' });
    await joinAsVisitor(v.page, s);
    await v.page.getByTestId('push-on').click();
    await expect(v.page.getByTestId('push-note')).toContainText('blocked for this site');
    await expect(v.page.getByTestId('push-state')).toHaveAttribute('data-state', 'denied');
    await expect(v.page.getByTestId('push-on')).toHaveCount(0);
    expect(await counters(v.page)).toMatchObject({ perm: 1, subscribe: 0 });
    await v.page.reload();
    await expect(v.page.getByTestId('push-state')).toHaveAttribute('data-state', 'denied');
    expect((await counters(v.page)).perm).toBe(0);
    // the in-app alert is unaffected
    await callNext(page, s);
    await expect(v.page.getByTestId('turn-banner')).toBeVisible();
    await v.ctx.close();
  });

  test('unsupported browsers and iPhone Safari outside the Home Screen app get specific text', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const ios = await visitor(
      browser,
      { noPush: true },
      {
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        viewport: { width: 375, height: 667 },
      },
    );
    await joinAsVisitor(ios.page, s);
    await expect(ios.page.getByTestId('push-state')).toHaveAttribute(
      'data-state',
      'ios_not_installed',
    );
    await expect(ios.page.getByTestId('push-state')).toContainText('Home Screen');
    await checkLayout(ios.page);
    await ios.ctx.close();
  });

  test('the 4th device is refused with the documented message and no browser subscription is left behind', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitor(browser);
    const code = await joinAsVisitor(v.page, s);
    const token = (await saved(v.page))[0]?.token ?? '';
    for (let i = 0; i < 3; i++) {
      const r = await v.page.request.post(`/api/v1/tickets/${code}/push-subscription`, {
        headers: { ...CSRF, 'X-QB-Ticket-Token': token },
        data: {
          endpoint: `https://${E2E_PUSH_HOST}/ok/other-device-${i}-${uuidv7()}`,
          keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) },
        },
      });
      expect(r.status(), await r.text()).toBe(201);
    }
    await v.page.getByTestId('push-on').click();
    await expect(v.page.getByTestId('push-note')).toHaveText(
      'Push is already on for 3 devices. Turn it off on one first.',
    );
    await expect(v.page.getByTestId('push-on')).toBeVisible();
    // the refused browser subscription was not left behind
    expect((await counters(v.page)).unsubscribed).toBe(1);
    await v.ctx.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 14.13 / 14.14 identity: the subscription reference, never the public code alone
// ---------------------------------------------------------------------------------------------

test.describe('14.13 / 14.14 notification identity', () => {
  test('two tickets with the SAME code from different facilities: each reference opens its own ticket; a contradicting k resolves to nothing', async ({
    page,
    browser,
  }) => {
    const a = await apiQueueSetup(page.request, { serviceName: 'Service Alpha' });
    // another organization's staff: their own signed-in context (one session per context)
    const staffB = await browser.newContext();
    const b = await apiQueueSetup(staffB.request, { serviceName: 'Service Beta' });
    const v = await visitor(browser);
    const codeA = await joinAsVisitor(v.page, a);
    const refA = await enablePush(v.page);
    const codeB = await joinAsVisitor(v.page, b);
    expect(codeB).toBe(codeA); // both queues number from the start
    await v.page.getByTestId('push-on').click();
    await expect(v.page.getByTestId('push-state')).toHaveAttribute('data-state', 'on');
    const tickets = await saved(v.page);
    const refB = tickets.find((t) => t.pushRef && t.pushRef !== refA)?.pushRef ?? '';
    expect(refB).toMatch(/^[0-9a-f-]{36}$/);
    expect(refB).not.toBe(refA);
    // one browser subscription, shared by both tickets (one subscribe call)
    expect((await counters(v.page)).subscribe).toBe(0); // counted per page: the 2nd reused it
    // both are called; each notification destination opens its own ticket
    await callNext(page, a);
    await callNext(staffB, b);
    await runWorkerFor(refA, refB);
    for (const [ref, facilityId] of [
      [refA, a.facility.id],
      [refB, b.facility.id],
    ] as const) {
      expect(await outcomeOf(ref)).toEqual([{ status: 'sent', detail_code: 'accepted' }]);
      // the server bound each reference to its own facility's ticket
      const [owner] = await withDb(
        (sql) =>
          sql<
            { facility_id: string }[]
          >`SELECT facility_id FROM push_subscriptions WHERE id = ${ref}`,
      );
      expect(owner?.facility_id).toBe(facilityId);
      // opening that reference shows that ticket, not the other one with the same code
      const [{ tok } = { tok: '' }] = await withDb(
        (sql) =>
          sql<
            { tok: string }[]
          >`SELECT t.id AS tok FROM push_subscriptions ps JOIN tickets t ON t.id = ps.ticket_id WHERE ps.id = ${ref}`,
      );
      expect(tok).toBeTruthy();
      await v.page.goto(`/ticket/${codeA}?ref=${ref}&seq=${await callSequenceOf(ref)}`);
      await expect(v.page.getByTestId('ticket-state')).toHaveText('Called');
      const expected = ref === refA ? 'Service Alpha' : 'Service Beta';
      expect(tickets.find((t) => t.pushRef === ref)?.serviceName).toBe(expected);
      await expect(v.page.locator('.page-head')).toContainText(expected);
      await expect(v.page.locator('.page-head')).not.toContainText(
        expected === 'Service Alpha' ? 'Service Beta' : 'Service Alpha',
      );
    }
    // opening from the notification acknowledged that one ticket's alert only
    await expect.poll(async () => (await notificationsOf(refA))[0]?.status).toBe('delivered');
    // `k` naming a different saved ticket than `ref`: not found, no status request
    const idA = tickets.find((t) => t.pushRef === refA)?.id ?? '';
    const statusCalls: string[] = [];
    v.page.on('request', (r) => {
      if (r.url().includes('/status')) statusCalls.push(r.url());
    });
    await v.page.goto(`/ticket/${codeA}?ref=${refB}&k=${idA}`);
    await expect(v.page.getByTestId('alert-not-saved')).toBeVisible();
    expect(statusCalls).toEqual([]);
    await v.ctx.close();
    await staffB.close();
  });

  test('a notification for a ticket this device forgot: neutral screen, no status request, never the other ticket with the same code', async ({
    page,
    browser,
  }) => {
    const a = await apiQueueSetup(page.request);
    const staffB = await browser.newContext();
    const b = await apiQueueSetup(staffB.request);
    const v = await visitor(browser);
    const code = await joinAsVisitor(v.page, a);
    const refA = await enablePush(v.page);
    await joinAsVisitor(v.page, b); // a second ticket with the same code stays saved
    // forget ticket A on this device
    const idA = (await saved(v.page)).find((t) => t.pushRef === refA)?.id ?? '';
    await v.page.goto(`/ticket/${code}?k=${idA}`);
    await v.page.getByRole('button', { name: 'Forget this ticket on this device' }).click();
    await expect(v.page.getByRole('heading', { level: 1 })).toHaveText('QueueBridge');
    const requests: string[] = [];
    v.page.on('request', (r) => requests.push(r.url()));
    const rp = `/recover/${a.org.slug}/${a.facility.slug}/${code}`;
    await v.page.goto(`/ticket/${code}?ref=${refA}&seq=3&rp=${encodeURIComponent(rp)}`);
    const neutral = v.page.getByTestId('alert-not-saved');
    await expect(neutral).toContainText(`This alert is for ticket ${code}`);
    await expect(neutral).toContainText('not saved on this device');
    await expect(v.page.getByTestId('ticket-state')).toHaveCount(0);
    await expect(v.page.getByTestId('alert-recover-link')).toHaveAttribute('href', rp);
    await expect(v.page.getByRole('link', { name: 'My saved tickets' })).toBeVisible();
    expect(requests.filter((u) => /\/api\/v1\/tickets\//.test(u))).toEqual([]);
    // no bearer credential anywhere in what the notification opened
    expect(v.page.url()).not.toMatch(/token|#t=|k=[^&]*[A-Z2-7]{16}/);
    await checkLayout(v.page);
    // the recovery link prefills the public identifiers and asks for the key
    await v.page.getByTestId('alert-recover-link').click();
    await expect(v.page).toHaveURL(new RegExp(`/recover/${a.org.slug}/`));
    await v.ctx.close();
    await staffB.close();
  });

  test('an unclaimed hand-off (another page is focused) shows a non-blocking notice built from the reference', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitor(browser);
    const code = await joinAsVisitor(v.page, s);
    const ref = await enablePush(v.page);
    await v.page.goto('/');
    await v.page.evaluate(
      ({ r, c }) =>
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'qb-turn-alert', ref: r, code: c, seq: 2, counter: 'Counter 1' },
          }),
        ),
      { r: ref, c: code },
    );
    const notice = v.page.getByTestId('push-handoff-notice');
    await expect(notice).toContainText(`An alert arrived for ticket ${code}`);
    await expect(notice.getByRole('link')).toHaveAttribute('href', `/ticket/${code}?ref=${ref}`);
    // a forged message that is not ours does nothing
    await v.page.evaluate(() =>
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent('message', { data: { type: 'qb-turn-alert', ref: 'x', code: '<b>' } }),
      ),
    );
    await expect(notice).toHaveCount(1);
    await notice.getByRole('link').click();
    await expect(v.page.getByTestId('ticket-code')).toHaveText(code);
    await v.ctx.close();
  });
});

// ---------------------------------------------------------------------------------------------
// 14.7 neutrality and the dashboard
// ---------------------------------------------------------------------------------------------

test.describe('14.7 failures never touch the queue; the dashboard counts them honestly', () => {
  test('an expired subscription (410) is revoked, the ticket stays called and can be served; counters shown', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await visitor(browser, { endpointPath: '/gone/' });
    const code = await joinAsVisitor(v.page, s);
    const ref = await enablePush(v.page);
    await callNext(page, s);
    await runWorkerFor(ref);
    expect(await outcomeOf(ref)).toEqual([{ status: 'failed', detail_code: 'gone' }]);
    await expect(v.page.getByTestId('ticket-state')).toHaveText('Called');
    const tid = await ticketId(page, s, code);
    await command(page, s.queueId ?? '', { action: 'ticket.serve', ticket_id: tid });
    await expect(v.page.getByTestId('ticket-state')).toHaveText('Being served');
    const [{ misses } = { misses: -1 }] = await withDb(
      (sql) =>
        sql<
          { misses: number }[]
        >`SELECT COUNT(*)::int AS misses FROM queue_events WHERE queue_session_id = ${s.queueId ?? ''} AND event_type = 'ticket.miss'`,
    );
    expect(misses).toBe(0);
    await page.goto(`/staff/facilities/${s.facility.id}/connectivity`);
    const panel = page.getByTestId('turn-alert-counters');
    await expect(panel).toContainText('Visitor push alerts (last hour)');
    await expect(panel).toContainText('not counted as a failure');
    // API and worker were given the same settings: no configuration warning
    await expect(page.getByTestId('config-mismatch')).toHaveCount(0);
    await checkLayout(page);
    await v.ctx.close();
  });
});
