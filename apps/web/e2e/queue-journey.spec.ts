import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { uuidv7 } from '@queuebridge/contracts';
import {
  apiQueueSetup,
  expectNoA11yViolations,
  hasHorizontalOverflow,
  PASSWORD,
  UUID_RE,
} from './helpers.js';

async function freshContext(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  return { ctx, page: await ctx.newPage() };
}

test.describe('M2 exit journey: online join → call → serve → complete (web + staff + board)', () => {
  test('visitor, staff and display board stay in step through live updates', async ({
    page,
    browser,
  }) => {
    // Setup through the API; open today's queue through the staff UI
    const s = await apiQueueSetup(page.request, { open: false });
    await page.goto(`/admin/facilities/${s.facility.id}`);
    await expect(page.getByTestId('join-notice')).toContainText('No queue is open today');

    await page.getByRole('link', { name: 'Staff console' }).click();
    await page.getByRole('link', { name: 'Queue Clinic' }).click();
    await page.getByRole('button', { name: /Open today's queue/ }).click();
    await expect(page.getByTestId('status')).toContainText('is open for today');
    await page.getByRole('link', { name: /Open console/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('General Consultation');
    await expect(page.getByTestId('queue-state')).toContainText('Open');

    // The admin overview now reports the join link as live
    const staffConsoleUrl = page.url();
    await page.goto(`/admin/facilities/${s.facility.id}`);
    await expect(page.getByTestId('join-live')).toContainText('Visitors can join now');
    await page.goto(staffConsoleUrl);

    // Display board in its own browser (a waiting-room screen)
    const board = await freshContext(browser);
    await board.page.goto(s.displayPath);
    await expect(board.page.getByRole('heading', { level: 1 })).toHaveText('Queue Clinic');
    await expect(board.page.getByTestId('live-mode')).toHaveText('Live');

    // Visitor joins on their own phone (no account)
    const visitor = await freshContext(browser);
    await visitor.page.goto(s.joinPath);
    await expect(visitor.page.getByRole('heading', { level: 1 })).toHaveText('Queue Clinic');
    await visitor.page.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(visitor.page).toHaveURL(/\/ticket\/G001\?k=[^&#]+$/);
    await expect(visitor.page.getByTestId('ticket-code')).toHaveText('G001');
    await expect(visitor.page.getByTestId('ticket-state')).toHaveText('Waiting');
    await expect(visitor.page.getByTestId('status-message')).toHaveText(
      'You are next in line. Please stay nearby.',
    );
    await expect(visitor.page.getByTestId('ticket-position')).toContainText('1 in line');
    await expect(visitor.page.getByTestId('sync-status')).toContainText('Confirmed');
    await expect(visitor.page.getByTestId('estimate-text')).toContainText('Not enough information');
    await expect(visitor.page.getByTestId('policy-summary')).toContainText(
      'first come first served',
    );
    await expect(visitor.page.getByTestId('live-mode')).toHaveText('Live updates');
    await expect(board.page.getByTestId('next-codes')).toHaveText('G001');

    // Staff calls next — every screen updates WITHOUT reloading
    await expect(page.getByTestId('waiting-list')).toContainText('G001');
    await page.getByRole('button', { name: 'Call next' }).click();
    await expect(page.getByTestId('current-code')).toHaveText('G001');
    await expect(visitor.page.getByTestId('ticket-state')).toHaveText('Called');
    await expect(visitor.page.getByTestId('status-message')).toHaveText(
      'It is your turn. Please go to Counter 1 now.',
    );
    await expect(visitor.page.getByTestId('turn-alert')).toHaveText(
      'It is your turn. Please go to Counter 1 now.',
    );
    await expect(board.page.getByTestId('now-calling')).toContainText('G001');
    await expect(board.page.getByTestId('now-calling')).toContainText('Counter 1');
    await expect(board.page.getByTestId('board-announcement')).toContainText(
      'please go to Counter 1',
    );

    await page.getByRole('button', { name: 'Start serving' }).click();
    await expect(visitor.page.getByTestId('ticket-state')).toHaveText('Being served');
    await expect(board.page.getByTestId('now-calling')).toContainText('being served');

    await page.getByRole('button', { name: 'Complete' }).click();
    await expect(page.getByTestId('counter-free')).toContainText('Counter 1 is free');
    await expect(visitor.page.getByTestId('ticket-state')).toHaveText('Completed');
    await expect(visitor.page.getByTestId('status-message')).toHaveText(
      'Your visit is complete. Thank you.',
    );
    await expect(board.page.getByTestId('now-calling')).not.toContainText('G001');

    // Board DOM never contains internal ids
    expect(await board.page.locator('main').innerText()).not.toMatch(UUID_RE);
    await board.ctx.close();
    await visitor.ctx.close();
  });

  test('staff-assisted walk-in: code issued, status link works on another device and is scrubbed', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    await page.goto(`/staff/queues/${s.queueId}`);
    await page.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await expect(page.getByTestId('walkin-code')).toHaveText('G001');
    await expect(page.getByRole('img', { name: /status link for ticket G001/ })).toBeVisible();
    await expect(page.getByTestId('waiting-list')).toContainText('Walk-in');

    // Open the exact link the QR encodes, the way the visitor's phone would
    await page.getByText('Show status link').click();
    const link = await page.getByTestId('walkin-link').innerText();
    // M5.1: the fragment also carries the recovery key (never sent to a server)
    expect(link).toMatch(/\/ticket\/G001#t=[A-Za-z0-9_-]{43}&k=[0-9A-Z]{32}$/);
    const visitor = await freshContext(browser);
    await visitor.page.goto(link);
    await expect(visitor.page.getByTestId('ticket-code')).toHaveText('G001');
    await expect(visitor.page.getByTestId('ticket-state')).toHaveText('Waiting');
    expect(visitor.page.url()).not.toContain('#t='); // token scrubbed from the address bar/history
    await visitor.page.reload(); // remembered on the device
    await expect(visitor.page.getByTestId('ticket-code')).toHaveText('G001');
    await visitor.ctx.close();
  });
});

test.describe('visitor resilience and privacy', () => {
  test('a lost join response is recovered by retrying: same ticket, never a duplicate', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const visitor = await freshContext(browser);
    let first = true;
    await visitor.page.route('**/api/v1/queues/*/join', async (route) => {
      if (first) {
        first = false;
        await route.fetch(); // the server COMMITS the ticket…
        await route.abort('connectionreset'); // …but the response never reaches the phone
        return;
      }
      await route.continue();
    });
    await visitor.page.goto(s.joinPath);
    await visitor.page.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(visitor.page.getByTestId('join-error')).toContainText('Retrying is safe');
    await visitor.page.getByRole('button', { name: /Finish getting your ticket/ }).click();
    await expect(visitor.page).toHaveURL(/\/ticket\/G001\?k=[^&#]+$/);
    await expect(visitor.page.getByTestId('ticket-code')).toHaveText('G001');

    const staffView = await page.request.get(`/api/v1/queues/${s.queueId}`);
    const tickets = ((await staffView.json()) as { queue: { tickets: unknown[] } }).queue.tickets;
    expect(tickets).toHaveLength(1);
    await visitor.ctx.close();
  });

  test('ticket survives reload and a new tab; a second ticket for someone else needs confirmation', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const visitor = await freshContext(browser);
    await visitor.page.goto(s.joinPath);
    await visitor.page.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(visitor.page.getByTestId('ticket-code')).toHaveText('G001');
    await visitor.page.reload();
    await expect(visitor.page.getByTestId('ticket-code')).toHaveText('G001');

    const tab = await visitor.ctx.newPage();
    await tab.goto('/');
    await expect(tab.getByTestId('my-tickets')).toContainText('G001');

    await tab.goto(s.joinPath);
    await expect(tab.getByTestId('existing-tickets')).toContainText('G001');
    await tab.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(tab.getByTestId('join-error')).toContainText('for another person');
    await tab.getByLabel(/for someone else/).check();
    await tab.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(tab).toHaveURL(/\/ticket\/G002\?k=[^&#]+$/);
    await expect(tab.getByTestId('ticket-position')).toContainText('2 in line');

    await tab.getByRole('button', { name: 'Forget this ticket on this device' }).click();
    await expect(tab.getByTestId('my-tickets')).not.toContainText('G002');
    await visitor.ctx.close();
  });

  test('another device without the token cannot see the ticket', async ({ page, browser }) => {
    const s = await apiQueueSetup(page.request);
    const visitor = await freshContext(browser);
    await visitor.page.goto(s.joinPath);
    await visitor.page.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(visitor.page.getByTestId('ticket-code')).toHaveText('G001');

    const stranger = await freshContext(browser);
    await stranger.page.goto('/ticket/G001');
    await expect(stranger.page.getByTestId('ticket-unavailable')).toContainText(
      'does not have access',
    );
    const direct = await stranger.page.request.get('/api/v1/tickets/G001/status');
    expect(direct.status()).toBe(404);
    await visitor.ctx.close();
    await stranger.ctx.close();
  });

  test('when live updates are unavailable the page falls back to periodic refresh', async ({
    page,
    browser,
  }) => {
    test.setTimeout(60_000);
    const s = await apiQueueSetup(page.request);
    const visitor = await freshContext(browser);
    let streamAttempts = 0;
    let streamsServed = 0;
    await visitor.page.route('**/stream', (route) => {
      streamAttempts += 1;
      return route.abort('connectionrefused');
    });
    visitor.page.on('response', (r) => {
      if (r.url().includes('/stream') && r.ok()) streamsServed += 1;
    });
    await visitor.page.goto(s.joinPath);
    await visitor.page.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(visitor.page.getByTestId('live-mode')).toHaveText('Refreshing every 15 s');
    await expect(visitor.page.getByTestId('ticket-state')).toHaveText('Waiting');

    await page.request.post(`/api/v1/queues/${s.queueId}/commands`, {
      headers: { 'X-QB-CSRF': '1' },
      data: { operation_id: uuidv7(), action: 'ticket.call_next', counter_id: s.counterId },
    });
    // With every stream request refused, only the 15 s poll can deliver this change
    await expect(visitor.page.getByTestId('ticket-state')).toHaveText('Called', {
      timeout: 25_000,
    });
    expect(streamAttempts).toBeGreaterThan(0);
    expect(streamsServed).toBe(0);
    await visitor.ctx.close();
  });
});

test.describe('staff console permissions in the UI (API enforces independently)', () => {
  test('an auditor sees a read-only console; a forged command is refused', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const inv = await page.request.post(`/api/v1/facilities/${s.facility.id}/invitations`, {
      headers: { 'X-QB-CSRF': '1' },
      data: { email: 'auditor.m2@example.test', role: 'auditor' },
    });
    const { accept_url } = (await inv.json()) as { accept_url: string };
    const a = await freshContext(browser);
    await a.page.goto(accept_url);
    await a.page.getByLabel('Your name').fill('Audra');
    await a.page.getByLabel('Password').fill(PASSWORD);
    await a.page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('Administration');
    await a.page.goto(`/staff/queues/${s.queueId}`);
    await expect(a.page.getByTestId('read-only-console')).toBeVisible();
    await expect(a.page.getByRole('button', { name: 'Call next' })).toHaveCount(0);
    await expect(a.page.getByRole('button', { name: 'Issue walk-in ticket' })).toHaveCount(0);
    await expect(a.page.getByRole('button', { name: 'Pause queue' })).toHaveCount(0);
    const forged = await a.page.request.post(`/api/v1/queues/${s.queueId}/commands`, {
      headers: { 'X-QB-CSRF': '1' },
      data: { operation_id: uuidv7(), action: 'queue.pause' },
    });
    expect(forged.status()).toBe(403);
    await a.ctx.close();
  });
});

test.describe('@responsive M2 screens: accessibility and layout at 320/375/desktop', () => {
  test('join, ticket, board and staff console pass axe and do not overflow', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const visitor = await freshContext(browser);
    await visitor.page.setViewportSize(page.viewportSize() ?? { width: 1280, height: 720 });
    await visitor.page.goto(s.joinPath);
    await expect(visitor.page.getByTestId('join-service')).toBeVisible();
    await expectNoA11yViolations(visitor.page);
    expect(await hasHorizontalOverflow(visitor.page)).toBe(false);

    await visitor.page.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(visitor.page.getByTestId('ticket-code')).toHaveText('G001');
    await visitor.page.getByText('How this is estimated').click();
    await expectNoA11yViolations(visitor.page);
    expect(await hasHorizontalOverflow(visitor.page)).toBe(false);

    await page.goto(`/staff/queues/${s.queueId}`);
    await expect(page.getByTestId('waiting-list')).toContainText('G001');
    await expectNoA11yViolations(page);
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await page.getByRole('button', { name: 'Call next' }).click();
    await expect(page.getByTestId('current-code')).toHaveText('G001');
    await expectNoA11yViolations(page);

    await expect(visitor.page.getByTestId('ticket-state')).toHaveText('Called');
    await expectNoA11yViolations(visitor.page);

    await visitor.page.goto(s.displayPath);
    await expect(visitor.page.getByTestId('now-calling')).toContainText('G001');
    await expectNoA11yViolations(visitor.page);
    expect(await hasHorizontalOverflow(visitor.page)).toBe(false);
    await visitor.ctx.close();
  });

  test('a visitor can join and read their status with the keyboard alone', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const visitor = await freshContext(browser);
    await visitor.page.setViewportSize(page.viewportSize() ?? { width: 1280, height: 720 });
    await visitor.page.goto(s.joinPath);
    const button = visitor.page.getByRole('button', { name: /Get a ticket/ });
    for (
      let i = 0;
      i < 30 && !(await button.evaluate((el) => el === document.activeElement));
      i++
    ) {
      await visitor.page.keyboard.press('Tab');
    }
    await expect(button).toBeFocused();
    await visitor.page.keyboard.press('Enter');
    await expect(visitor.page.getByTestId('ticket-code')).toHaveText('G001');
    // Status message is a polite live region; focus moved to main on navigation
    await expect(visitor.page.getByTestId('status-message')).toHaveAttribute('role', 'status');
    await expect(visitor.page.locator('#main')).toBeFocused();
    const box = await visitor.page
      .getByRole('button', { name: 'Forget this ticket on this device' })
      .boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await visitor.ctx.close();
  });
});

test.describe('PR #4 review regressions', () => {
  async function ticketCount(page: Page, queueId: string | null): Promise<number> {
    const res = await page.request.get(`/api/v1/queues/${queueId}`);
    return ((await res.json()) as { queue: { tickets: unknown[] } }).queue.tickets.length;
  }

  test('the same public code at two facilities keeps both tickets on the device', async ({
    page,
    browser,
  }) => {
    const a = await apiQueueSetup(page.request, { serviceName: 'General Consultation' });
    const b = await apiQueueSetup(page.request, { serviceName: 'General Surgery' });
    const visitor = await freshContext(browser);
    for (const s of [a, b]) {
      await visitor.page.goto(s.joinPath);
      await visitor.page.getByRole('button', { name: /Get a ticket/ }).click();
      await expect(visitor.page.getByTestId('ticket-code')).toHaveText('G001');
    }

    await visitor.page.goto('/');
    const mine = visitor.page.getByTestId('my-tickets').getByRole('link');
    await expect(mine).toHaveCount(2);
    for (const service of ['General Consultation', 'General Surgery']) {
      await visitor.page.goto('/');
      await visitor.page.getByRole('link', { name: new RegExp(`G001 — ${service}`) }).click();
      await expect(visitor.page.getByTestId('ticket-code')).toHaveText('G001');
      await expect(visitor.page.getByText(new RegExp(`${service} · Queue Clinic`))).toBeVisible();
      await visitor.page.reload();
      await expect(visitor.page.getByText(new RegExp(`${service} · Queue Clinic`))).toBeVisible();
    }

    // A bare code link is ambiguous on this device: the visitor chooses instead of guessing
    await visitor.page.goto('/ticket/G001');
    await expect(visitor.page.getByTestId('ticket-choices').getByRole('link')).toHaveCount(2);

    // Forgetting one ticket keeps the other
    await visitor.page.getByRole('link', { name: /General Surgery/ }).click();
    await visitor.page.getByRole('button', { name: 'Forget this ticket on this device' }).click();
    await expect(mine).toHaveCount(1);
    await expect(mine).toContainText('General Consultation');
    await visitor.ctx.close();
  });

  test('a walk-in whose response is lost is finished with the same operation, not reissued', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    let first = true;
    await page.route('**/api/v1/queues/*/walk-ins', async (route) => {
      if (first) {
        first = false;
        await route.fetch(); // the server COMMITS the walk-in…
        await route.abort('connectionreset'); // …but the response never reaches the desk
        return;
      }
      await route.continue();
    });
    await page.goto(`/staff/queues/${s.queueId}`);
    await page.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await expect(page.getByRole('alert').first()).toContainText('may already have been issued');
    await page.getByRole('button', { name: 'Finish issuing walk-in ticket' }).click();
    await expect(page.getByTestId('walkin-code')).toHaveText('G001');
    await expect(page.getByRole('button', { name: 'Issue walk-in ticket' })).toBeVisible();
    expect(await ticketCount(page, s.queueId)).toBe(1);

    // The recovered status link (rotated token) works for the visitor
    await page.getByText('Show status link').click();
    const link = await page.getByTestId('walkin-link').innerText();
    const visitor = await freshContext(browser);
    await visitor.page.goto(link);
    await expect(visitor.page.getByTestId('ticket-code')).toHaveText('G001');

    // The next walk-in is a new visitor: a new operation, a new ticket
    await page.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await expect(page.getByTestId('walkin-code')).toHaveText('G002');
    expect(await ticketCount(page, s.queueId)).toBe(2);
    await visitor.ctx.close();
  });

  test('with browser storage unavailable, retrying a lost join still cannot duplicate', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const visitor = await freshContext(browser);
    await visitor.ctx.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      };
    });
    let first = true;
    await visitor.page.route('**/api/v1/queues/*/join', async (route) => {
      if (first) {
        first = false;
        await route.fetch();
        await route.abort('connectionreset');
        return;
      }
      await route.continue();
    });
    await visitor.page.goto(s.joinPath);
    await visitor.page.getByRole('button', { name: /Get a ticket/ }).click();
    await expect(visitor.page.getByTestId('join-error')).toContainText('keep this page open');
    await visitor.page.getByRole('button', { name: /Finish getting your ticket/ }).click();
    await expect(visitor.page.getByTestId('ticket-code')).toHaveText('G001');
    await expect(visitor.page.getByTestId('storage-warning')).toBeVisible();
    expect(await ticketCount(page, s.queueId)).toBe(1);
    await visitor.ctx.close();
  });
});
