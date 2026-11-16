import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { uuidv7 } from '@queuebridge/contracts';
import {
  apiQueueSetup,
  expectNoA11yViolations,
  hasHorizontalOverflow,
  type QueueSetup,
} from './helpers.js';
import { makeStaff } from './offline-helpers.js';

/**
 * M5.1 secure ticket recovery in real browsers against the real stack (testing steering Group 8
 * 8.R1, 8.R2, 8.R4, 8.R5, 8.R8; Group 11 recover page). Requests, throttling, hashing and
 * authorization are covered on real PostgreSQL in the API suite; these tests prove what a person
 * actually sees and can do, and that the secrets stay where the design says they stay.
 */
const CSRF = { 'X-QB-CSRF': '1' };
type Setup = QueueSetup & { queueId: string | null };

async function freshContext(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  return { ctx, page: await ctx.newPage() };
}

/** A visitor joins in their own context; returns the key exactly as the visitor sees it. */
async function joinVisitor(
  browser: Browser,
  s: Setup,
): Promise<{ ctx: BrowserContext; page: Page; code: string; key: string }> {
  const v = await freshContext(browser);
  await v.page.goto(s.joinPath);
  await v.page.getByRole('button', { name: /Get a ticket/ }).click();
  await expect(v.page.getByTestId('recovery-key-panel')).toBeVisible();
  const text = (await v.page.getByTestId('recovery-key-text').innerText()).toUpperCase();
  const grouped = /(?:[0-9A-Z]{4}-){7}[0-9A-Z]{4}/.exec(text)?.[0] ?? '';
  expect(grouped).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  const code = (await v.page.getByTestId('ticket-code').innerText()).trim();
  return { ...v, code, key: grouped.replace(/-/g, '') };
}

const recoverLink = (s: Setup, code: string): string =>
  `/recover/${s.org.slug}/${s.facility.slug}/${code}`;

async function storageDump(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
}

async function queueTickets(
  request: APIRequestContext,
  queueId: string,
): Promise<{ id: string; public_code: string; state: string }[]> {
  const r = await request.get(`/api/v1/queues/${queueId}`);
  return (
    (await r.json()) as { queue: { tickets: { id: string; public_code: string; state: string }[] } }
  ).queue.tickets;
}

async function command(
  request: APIRequestContext,
  queueId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const r = await request.post(`/api/v1/queues/${queueId}/commands`, {
    headers: CSRF,
    data: { operation_id: uuidv7(), ...body },
  });
  expect(r.status(), await r.text()).toBe(200);
}

test.describe('visitor recovery with the key (8.R1, 8.R2, 8.R4)', () => {
  test('the key is shown once; the link or typed key recovers on a new device; nothing secret is stored or left in the URL', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const a = await joinVisitor(browser, s);
    // shown in three forms: readable groups (above), a QR, and Copy / Save / Print actions
    await expect(a.page.getByRole('button', { name: 'Copy key' })).toBeVisible();
    await expect(a.page.getByRole('button', { name: 'Save as file' })).toBeVisible();
    await expect(a.page.getByRole('button', { name: 'Print' })).toBeVisible();
    await a.page.getByRole('button', { name: 'Show QR code' }).click();
    await expect(a.page.getByRole('img', { name: /QR code that recovers ticket/ })).toBeVisible();
    // the key is NOT in storage on the original device, nor in the URL
    expect(await storageDump(a.page)).not.toContain(a.key);
    expect(a.page.url()).not.toContain(a.key);

    // confirm and reload: the key is gone (shown once)
    await a.page.getByRole('button', { name: 'I have saved my key' }).click();
    await expect(a.page.getByTestId('recovery-key-panel')).toHaveCount(0);
    await a.page.reload();
    await expect(a.page.getByTestId('ticket-code')).toHaveText(a.code);
    await expect(a.page.getByTestId('recovery-key-panel')).toHaveCount(0);

    // a second phone with the public code only: no access
    const b = await freshContext(browser);
    await b.page.goto(`/ticket/${a.code}`);
    await expect(b.page.getByTestId('ticket-unavailable')).toBeVisible();

    // ... the link/QR (key in the FRAGMENT) recovers in one step, and the fragment is removed
    const requests: string[] = [];
    b.page.on('request', (r) => requests.push(r.url()));
    await b.page.goto(`${recoverLink(s, a.code)}#k=${a.key}`);
    await expect(b.page.getByTestId('ticket-code')).toHaveText(a.code);
    expect(b.page.url()).not.toContain(a.key);
    expect(b.page.url()).not.toContain('#k=');
    // the key never appeared in any URL the browser requested (it travels only in a POST body)
    expect(requests.filter((u) => u.includes(a.key))).toEqual([]);
    expect(await storageDump(b.page)).not.toContain(a.key);
    // recovery changed nothing about the queue
    await expect(b.page.getByTestId('ticket-state')).toHaveText('Waiting');
    await expect(b.page.getByTestId('ticket-position')).toContainText('1 in line');

    // typed key: spaces, hyphens and lower case are accepted
    const c = await freshContext(browser);
    await c.page.goto('/recover');
    await c.page.getByLabel('Organization').fill(s.org.slug);
    await c.page.getByLabel('Facility').fill(s.facility.slug);
    await c.page.getByLabel('Ticket code').fill(a.code.toLowerCase());
    await c.page.getByLabel('Recovery key').fill(a.key.toLowerCase().replace(/(.{4})/g, '$1 '));
    await c.page.getByRole('button', { name: 'Recover my ticket' }).click();
    await expect(c.page.getByTestId('ticket-code')).toHaveText(a.code);

    for (const x of [a, b, c]) await x.ctx.close();
  });

  test('every failure looks the same and the page never reveals whether a ticket exists', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const a = await joinVisitor(browser, s);
    const wrongKey = 'Z'.repeat(32);
    async function attempt(at: {
      code: string;
      key: string;
    }): Promise<{ message: string; requests: number }> {
      const v = await freshContext(browser);
      let requests = 0;
      v.page.on('request', (r) => {
        if (r.url().endsWith('/api/v1/tickets/recover')) requests += 1;
      });
      await v.page.goto(recoverLink(s, at.code));
      await v.page.getByLabel('Recovery key').fill(at.key);
      await v.page.getByRole('button', { name: 'Recover my ticket' }).click();
      const err = v.page.getByTestId('recover-error');
      await expect(err).toBeVisible();
      await expect(v.page.getByRole('button', { name: 'Recover my ticket' })).toBeEnabled();
      const message = (await err.innerText()).trim();
      expect(v.page.url()).toContain('/recover/');
      expect(await storageDump(v.page)).not.toContain('"qb.tickets.v1"');
      await v.ctx.close();
      return { message, requests };
    }
    // Key checks that fail: one message for a real and an unknown code
    const failed = [
      await attempt({ code: a.code, key: wrongKey }), // right code, wrong key
      await attempt({ code: 'Q999', key: wrongKey }), // unknown code
    ];
    expect(new Set(failed.map((f) => f.message)).size).toBe(1);
    for (const f of failed) expect(f.requests).toBe(1);
    // The public code alone (no key): never sent, never opens anything, and the page answers the
    // same for a real and an unknown code (manual check 6: an empty form has its own message,
    // which depends only on what was typed)
    const codeAlone = [
      await attempt({ code: a.code, key: '' }),
      await attempt({ code: 'Q999', key: '' }),
    ];
    expect(new Set(codeAlone.map((f) => f.message)).size).toBe(1);
    for (const f of codeAlone) expect(f.requests).toBe(0);
    for (const m of [failed[0]?.message ?? '', codeAlone[0]?.message ?? '']) {
      expect(m).not.toMatch(/wrong|not found|exists|expired|ended|incorrect/i);
    }
    await a.ctx.close();
  });

  test('a new key replaces the old one; "sign out other devices" ends access elsewhere and shows a notice', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const a = await joinVisitor(browser, s);
    const b = await freshContext(browser);
    await b.page.goto(`${recoverLink(s, a.code)}#k=${a.key}`);
    await expect(b.page.getByTestId('ticket-code')).toHaveText(a.code);

    // device A keeps the ticket and makes a NEW key: the old one stops working at once
    await a.page.getByRole('button', { name: 'I have saved my key' }).click();
    await a.page.getByRole('button', { name: 'Get a new recovery key' }).click();
    await expect(a.page.getByTestId('recovery-key-panel')).toBeVisible();
    const fresh = /(?:[0-9A-Z]{4}-){7}[0-9A-Z]{4}/
      .exec((await a.page.getByTestId('recovery-key-text').innerText()).toUpperCase())?.[0]
      ?.replace(/-/g, '');
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(a.key);
    const stale = await freshContext(browser);
    await stale.page.goto(`${recoverLink(s, a.code)}#k=${a.key}`);
    await expect(stale.page.getByTestId('recover-error')).toBeVisible();
    const ok = await freshContext(browser);
    await ok.page.goto(`${recoverLink(s, a.code)}#k=${fresh}`);
    await expect(ok.page.getByTestId('ticket-code')).toHaveText(a.code);

    // device B sees that access was granted elsewhere; A signs everything else out
    await b.page.reload();
    await expect(b.page.getByTestId('access-elsewhere')).toBeVisible();
    await a.page.getByRole('button', { name: 'I have saved my key' }).click();
    await a.page.getByRole('button', { name: 'Sign out other devices' }).click();
    await expect(a.page.getByTestId('recovery-note')).toContainText('Signed out');
    await b.page.reload();
    await expect(b.page.getByTestId('ticket-unavailable')).toBeVisible();
    await ok.page.reload();
    await expect(ok.page.getByTestId('ticket-unavailable')).toBeVisible();
    // the signing-out device still works
    await a.page.reload();
    await expect(a.page.getByTestId('ticket-code')).toHaveText(a.code);

    for (const x of [a, b, stale, ok]) await x.ctx.close();
  });

  test('a staff walk-in link carries the key in its fragment, shown once on the visitor phone', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    await page.goto(`/staff/queues/${s.queueId}`);
    await page.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await expect(page.getByTestId('walkin-code')).toHaveText('G001');
    await expect(page.getByTestId('walkin-key')).toBeVisible();
    await page.getByText('Show status link').click();
    const link = await page.getByTestId('walkin-link').innerText();
    expect(link).toMatch(/\/ticket\/G001#t=[A-Za-z0-9_-]{43}&k=[0-9A-Z]{32}$/);
    const v = await freshContext(browser);
    await v.page.goto(link);
    await expect(v.page.getByTestId('ticket-code')).toHaveText('G001');
    await expect(v.page.getByTestId('recovery-key-panel')).toBeVisible();
    expect(v.page.url()).not.toMatch(/#|[0-9A-Z]{32}/);
    await v.page.reload();
    await expect(v.page.getByTestId('recovery-key-panel')).toHaveCount(0);
    await v.ctx.close();
  });

  test('offline: the recover page says a connection is needed and keeps working as a page', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await freshContext(browser);
    await v.page.goto(recoverLink(s, 'G001'));
    await v.ctx.setOffline(true);
    await expect(v.page.getByTestId('recover-offline')).toBeVisible();
    await expect(v.page.getByRole('button', { name: 'Recover my ticket' })).toBeDisabled();
    await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
    await v.ctx.setOffline(false);
    await expect(v.page.getByTestId('recover-offline')).toHaveCount(0);
    await v.ctx.close();
  });

  test('keyboard only: the recover form is completed with Tab, typing and Enter', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const a = await joinVisitor(browser, s);
    const v = await freshContext(browser);
    await v.page.goto('/recover');
    // focus lands on the page heading; Tab walks the form in reading order
    await expect(
      v.page.getByRole('heading', { level: 1, name: 'Get your ticket back' }),
    ).toBeFocused();
    for (const [label, value] of [
      ['Organization', s.org.slug],
      ['Facility', s.facility.slug],
      ['Ticket code', a.code],
      ['Recovery key', a.key],
    ] as const) {
      await v.page.keyboard.press('Tab');
      await expect(v.page.getByLabel(label)).toBeFocused();
      await v.page.keyboard.type(value);
    }
    await v.page.keyboard.press('Enter');
    await expect(v.page.getByTestId('ticket-code')).toHaveText(a.code);
    await v.ctx.close();
    await a.ctx.close();
  });
});

test.describe('staff-assisted recovery (8.R5)', () => {
  test('presence and the public code are not enough; with the basic factor a DIFFERENT supervisor must approve; the grant is redeemed only on the visitor device', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const lostPhone = await joinVisitor(browser, s);
    const sup = await makeStaff(browser, page.request, s.facility.id, 'supervisor');
    await sup.page.goto(`/staff/queues/${s.queueId}`);
    await page.goto(`/staff/queues/${s.queueId}`);

    const panel = page.getByTestId('staff-recovery');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Ticket', { exact: true }).selectOption({ label: lostPhone.code });
    await panel.getByLabel(/I asked the visitor before showing/).check();

    // 1. No verified factor: restricted assistance only, no credential of any kind
    await panel.getByRole('button', { name: 'Start recovery' }).click();
    await expect(page.getByTestId('staff-recovery-note')).toContainText(
      'No credential can be given',
    );
    await expect(page.getByTestId('staff-recovery-active')).toHaveCount(0);

    // 2. Basic factor: a request is created; the requester cannot approve it. The answers are
    // given again for every request (they are cleared after each one)
    await expect(panel.getByLabel(/I asked the visitor before showing/)).not.toBeChecked();
    await panel.getByLabel(/I asked the visitor before showing/).check();
    await panel.getByLabel(/They named the correct service/).check();
    const assist = page.waitForResponse((r) => r.url().includes('/recovery/assist'));
    await panel.getByRole('button', { name: 'Start recovery' }).click();
    const grant = ((await (await assist).json()) as { grant: string }).grant;
    expect(grant).toMatch(/^[0-9A-Z]{32}$/);
    await expect(page.getByTestId('staff-recovery-waiting')).toBeVisible();
    await expect(page.getByTestId('staff-recovery-qr')).toHaveCount(0);
    // the grant is never printed on the staff screen
    expect(await page.locator('main').innerText()).not.toContain(grant);
    const own = page.getByTestId('staff-recovery-approvals');
    await expect(own).toContainText('A different supervisor must approve your request.');
    await expect(own.getByRole('button', { name: /Approve/ })).toBeDisabled();

    // an unapproved grant cannot be redeemed (the visitor sees only the neutral message)
    const early = await freshContext(browser);
    await early.page.goto(`/recover#g=${grant}`);
    await expect(early.page.getByTestId('recover-error')).toBeVisible();
    await early.ctx.close();

    // 3. A different supervisor approves; the requester now shows the one-time QR
    const approvals = sup.page.getByTestId('staff-recovery-approvals');
    await expect(approvals).toContainText(lostPhone.code, { timeout: 15_000 });
    await approvals
      .getByRole('button', { name: new RegExp(`Approve recovery for ${lostPhone.code}`) })
      .click();
    await expect(page.getByTestId('staff-recovery-qr')).toBeVisible({ timeout: 15_000 });
    expect(await page.locator('main').innerText()).not.toContain(grant);

    // 4. Redeemed on the visitor's own device: one time only, the ticket is unchanged
    const phone = await freshContext(browser);
    await phone.page.goto(`/recover#g=${grant}`);
    await expect(phone.page.getByTestId('ticket-code')).toHaveText(lostPhone.code);
    expect(phone.page.url()).not.toContain(grant);
    await expect(phone.page.getByTestId('ticket-state')).toHaveText('Waiting');
    const again = await freshContext(browser);
    await again.page.goto(`/recover#g=${grant}`);
    await expect(again.page.getByTestId('recover-error')).toBeVisible();

    for (const x of [lostPhone, phone, again]) await x.ctx.close();
    await sup.ctx.close();
  });

  test('"end access on all devices" ends every device and the key of a ticket from the staff screen', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await joinVisitor(browser, s);
    await page.goto(`/staff/queues/${s.queueId}`);
    const panel = page.getByTestId('staff-recovery');
    await panel.getByLabel('Ticket', { exact: true }).selectOption({ label: v.code });
    await panel.getByRole('button', { name: /End access on all of this ticket/ }).click();
    await expect(page.getByTestId('staff-recovery-note')).toContainText('Signed out 1 device');
    await v.page.getByRole('button', { name: 'I have saved my key' }).click();
    await v.page.reload();
    await expect(v.page.getByTestId('ticket-unavailable')).toBeVisible();
    // the recovery key was removed too (the phone may have been stolen with it): it no longer works
    const b = await freshContext(browser);
    await b.page.goto(`${recoverLink(s, v.code)}#k=${v.key}`);
    await expect(b.page.getByTestId('recover-error')).toBeVisible();
    await b.ctx.close();
    await v.ctx.close();
  });
});

test.describe('missed turns, rejoin and the published automatic rule (8.R8, 8.R9)', () => {
  test('self_resume: a missed visitor returns to the queue inside the grace window; staff_resume shows no button', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await joinVisitor(browser, s);
    await v.page.getByRole('button', { name: 'I have saved my key' }).click();
    await command(page.request, s.queueId ?? '', {
      action: 'ticket.call_next',
      counter_id: s.counterId,
    });
    await expect(v.page.getByTestId('ticket-state')).toHaveText('Called');
    const t = (await queueTickets(page.request, s.queueId ?? '')).find(
      (x) => x.public_code === v.code,
    );
    await command(page.request, s.queueId ?? '', { action: 'ticket.miss', ticket_id: t?.id });
    await expect(v.page.getByTestId('ticket-state')).toHaveText('Missed');
    // default policy: staff decide, so the visitor is directed to staff and there is no button
    await expect(v.page.getByTestId('missed-help')).toContainText('ask a member of staff');
    await expect(v.page.getByRole('button', { name: /return me to the queue/ })).toHaveCount(0);

    const pol = await page.request.patch(
      `/api/v1/facilities/${s.facility.id}/services/${s.serviceId}`,
      {
        headers: CSRF,
        data: { policy: { rejoin_policy: 'self_resume' } },
      },
    );
    expect(pol.status()).toBe(200);
    await v.page.reload();
    await v.page.getByRole('button', { name: /return me to the queue/ }).click();
    await expect(v.page.getByTestId('ticket-state')).toHaveText('Waiting');
    await v.ctx.close();
  });

  test('the visitor sees the automatic no-show rule only while it is on', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const v = await joinVisitor(browser, s);
    await v.page.getByRole('button', { name: 'I have saved my key' }).click();
    await command(page.request, s.queueId ?? '', {
      action: 'ticket.call_next',
      counter_id: s.counterId,
    });
    await expect(v.page.getByTestId('ticket-state')).toHaveText('Called');
    await expect(v.page.getByTestId('auto-miss-rule')).toHaveCount(0);
    const on = await page.request.patch(
      `/api/v1/facilities/${s.facility.id}/services/${s.serviceId}`,
      {
        headers: CSRF,
        data: { policy: { auto_miss: { enabled: true, after_seconds: 600 } } },
      },
    );
    expect(on.status()).toBe(200);
    await v.page.reload();
    await expect(v.page.getByTestId('auto-miss-rule')).toContainText('600 seconds');
    await v.ctx.close();
  });

  test('admin: automatic no-show needs explicit seconds; staff recovery can be switched off', async ({
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    await page.goto(`/admin/facilities/${s.facility.id}/services`);
    const item = page.getByTestId('service-item').first();
    await item.getByText('Edit policy').click();
    const editor = page.getByTestId('policy-editor');
    await editor.getByLabel(/Automatically mark an unanswered call/).check();
    await editor.getByRole('button', { name: 'Save policy' }).click();
    await expect(page.getByTestId('error-summary')).toBeVisible();
    await editor.getByLabel(/Seconds before an unanswered call/).fill('120');
    await editor.getByLabel(/Allow staff-assisted ticket recovery/).uncheck();
    await editor.getByRole('button', { name: 'Save policy' }).click();
    await expect(item.getByTestId('policy-version')).toContainText('v2');
  });
});

test.describe('@responsive recovery screens are accessible and fit narrow screens', () => {
  test('recover page, key panel and staff panel pass axe and do not scroll sideways', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const a = await joinVisitor(browser, s);
    await a.page.getByRole('button', { name: 'Show QR code' }).click();
    await expectNoA11yViolations(a.page);
    expect(await hasHorizontalOverflow(a.page)).toBe(false);
    await a.page.getByRole('button', { name: 'I have saved my key' }).click();
    await expectNoA11yViolations(a.page);
    expect(await hasHorizontalOverflow(a.page)).toBe(false);

    const v = await freshContext(browser);
    for (const path of [recoverLink(s, a.code), '/recover']) {
      await v.page.goto(path);
      await expect(v.page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoA11yViolations(v.page);
      expect(await hasHorizontalOverflow(v.page)).toBe(false);
    }
    // an error state and an unavailable ticket are accessible too
    await v.page.goto(recoverLink(s, a.code));
    await v.page.getByLabel('Recovery key').fill('Z'.repeat(32));
    await v.page.getByRole('button', { name: 'Recover my ticket' }).click();
    await expect(v.page.getByTestId('recover-error')).toBeVisible();
    await expectNoA11yViolations(v.page);
    await v.page.goto(`/ticket/${a.code}`);
    await expect(v.page.getByTestId('ticket-unavailable')).toBeVisible();
    await expectNoA11yViolations(v.page);

    await page.goto(`/staff/queues/${s.queueId}`);
    await expect(page.getByTestId('staff-recovery')).toBeVisible();
    await expectNoA11yViolations(page);
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await v.ctx.close();
    await a.ctx.close();
  });
});
