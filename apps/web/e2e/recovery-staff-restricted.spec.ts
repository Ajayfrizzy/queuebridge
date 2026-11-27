import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { apiQueueSetup, type QueueSetup } from './helpers.js';
import { makeStaff } from './offline-helpers.js';

/**
 * Manual check 10 (2026-11-15): the tester could not exercise "answering no" and saw only
 * "Start recovery" and, for the supervisor, an "Approve" button. The audit log of that run shows
 * every staff request was sent with `account_matches: true`; no restricted-assistance event was
 * ever recorded. The two verification answers are checkboxes, and they KEPT their ticks after a
 * request and when another ticket was chosen, so the answers given for one visitor were silently
 * reused for the next one (design §15.5a: the questions are asked of each visitor, before any
 * detail is revealed).
 *
 * These tests drive the staff console like the manual checks 9 and 10, in that order, on one page.
 * The grant (present in the assist response of a verified request) is never printed: assertions
 * on it are booleans with messages, and the on-failure trace is off.
 */
test.use({ trace: 'off' });

type Setup = QueueSetup & { queueId: string | null };

async function joinCode(browser: Browser, s: Setup): Promise<string> {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const p = await ctx.newPage();
  await p.goto(s.joinPath);
  await p.getByRole('button', { name: /Get a ticket/ }).click();
  const code = (await p.getByTestId('ticket-code').innerText()).trim();
  await ctx.close();
  return code;
}

const asked = (page: Page): Locator =>
  page.getByTestId('staff-recovery').getByLabel(/I asked the visitor before showing/);
const named = (page: Page): Locator =>
  page.getByTestId('staff-recovery').getByLabel(/They named the correct service/);
const start = (page: Page): Locator =>
  page.getByTestId('staff-recovery').getByRole('button', { name: 'Start recovery' });

async function assist(page: Page): Promise<{ outcome: string; hasGrant: boolean }> {
  const res = page.waitForResponse((r) => r.url().includes('/recovery/assist'));
  await start(page).click();
  const body = (await (await res).json()) as { outcome?: string; grant?: unknown };
  return { outcome: body.outcome ?? '', hasGrant: typeof body.grant === 'string' };
}

test.describe('manual check 9 revalidation: approving a request that can no longer be approved', () => {
  test('a request decided elsewhere is explained in plain words, never as a bare "Not found"', async ({
    page,
    browser,
  }) => {
    const s: Setup = await apiQueueSetup(page.request);
    const code = await joinCode(browser, s);
    const supA = await makeStaff(browser, page.request, s.facility.id, 'supervisor');
    const supB = await makeStaff(browser, page.request, s.facility.id, 'supervisor');
    await page.goto(`/staff/queues/${s.queueId}`);
    const panel = page.getByTestId('staff-recovery');
    await panel.getByLabel('Ticket', { exact: true }).selectOption({ label: code });
    await asked(page).check();
    await named(page).check();
    expect((await assist(page)).outcome).toBe('approval_required');

    // Supervisor B's screen keeps showing the request (its list is held at that moment) ...
    await supB.page.goto(`/staff/queues/${s.queueId}`);
    const listB = supB.page.getByTestId('staff-recovery-approvals');
    await expect(listB).toContainText(code, { timeout: 15_000 });
    // Hold B's list at the current answer (captured once, before A approves): a page-level
    // stub, so no request is in flight when the contexts close
    const current = await supB.page.request.get(`/api/v1/queues/${s.queueId}/recovery/requests`);
    const held = await current.text();
    await supB.page.route('**/recovery/requests', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: held }),
    );
    // ... while supervisor A approves it
    await supA.page.goto(`/staff/queues/${s.queueId}`);
    const listA = supA.page.getByTestId('staff-recovery-approvals');
    await expect(listA).toContainText(code, { timeout: 15_000 });
    await listA.getByRole('button', { name: new RegExp(`Approve recovery for ${code}`) }).click();
    await expect(supA.page.getByTestId('staff-recovery-note')).toContainText(
      `Approved recovery for ${code}`,
    );

    // B presses Approve on the stale row: a plain explanation, not "Not found"
    await listB.getByRole('button', { name: new RegExp(`Approve recovery for ${code}`) }).click();
    const note = supB.page.getByTestId('staff-recovery-note');
    await expect(note).toContainText(`The request for ${code} can no longer be approved here`);
    await expect(note).not.toContainText('Not found');
    await supB.page.unrouteAll({ behavior: 'ignoreErrors' });
    for (const x of [supA, supB]) await x.ctx.close();
  });
});

test.describe('manual check 10: restricted assistance and fresh answers for every request', () => {
  test('"no" (the service/join-time box left unticked): guidance only, no QR, no credential, nothing for the supervisor to approve', async ({
    page,
    browser,
  }) => {
    const s: Setup = await apiQueueSetup(page.request);
    const code = await joinCode(browser, s);
    const sup = await makeStaff(browser, page.request, s.facility.id, 'supervisor');
    await sup.page.goto(`/staff/queues/${s.queueId}`);
    await page.goto(`/staff/queues/${s.queueId}`);

    const panel = page.getByTestId('staff-recovery');
    await panel.getByLabel('Ticket', { exact: true }).selectOption({ label: code });
    await expect(start(page), 'Start recovery needs the first confirmation').toBeDisabled();
    await asked(page).check();
    await expect(named(page)).not.toBeChecked();
    const r = await assist(page);
    expect(r.outcome).toBe('restricted_assistance');
    expect(r.hasGrant, 'no credential in the response').toBe(false);
    await expect(page.getByTestId('staff-recovery-note')).toContainText(
      'No credential can be given',
    );
    await expect(page.getByTestId('staff-recovery-active')).toHaveCount(0);
    await expect(page.getByTestId('staff-recovery-qr')).toHaveCount(0);

    // The supervisor's list refreshes and has nothing to approve for this ticket
    await sup.page.waitForResponse((x) => x.url().includes('/recovery/requests'));
    await sup.page.waitForResponse((x) => x.url().includes('/recovery/requests'));
    const approvals = sup.page.getByTestId('staff-recovery-approvals');
    await expect(approvals).toContainText('None right now.');
    await expect(approvals).not.toContainText(code);
    await sup.ctx.close();
  });

  test('the answers are given again for every request: after a verified request (check 9), the next one (check 10) starts unticked and ends in restricted assistance', async ({
    page,
    browser,
  }) => {
    const s: Setup = await apiQueueSetup(page.request);
    const first = await joinCode(browser, s);
    const second = await joinCode(browser, s);
    await page.goto(`/staff/queues/${s.queueId}`);
    const panel = page.getByTestId('staff-recovery');
    const ticket = panel.getByLabel('Ticket', { exact: true });

    // Choosing another ticket clears answers given for the previous one
    await ticket.selectOption({ label: first });
    await asked(page).check();
    await named(page).check();
    await ticket.selectOption({ label: second });
    await expect(asked(page), 'answers cleared when the ticket changes').not.toBeChecked();
    await expect(named(page), 'answers cleared when the ticket changes').not.toBeChecked();

    // Check 9: both answers "yes" for the first visitor: a request that needs approval
    await ticket.selectOption({ label: first });
    await asked(page).check();
    await named(page).check();
    const verified = await assist(page);
    expect(verified.outcome).toBe('approval_required');
    await expect(page.getByTestId('staff-recovery-waiting')).toBeVisible();

    // The answers are not carried over to the next visitor
    await expect(asked(page), 'answers cleared after a request').not.toBeChecked();
    await expect(named(page), 'answers cleared after a request').not.toBeChecked();
    await expect(start(page)).toBeDisabled();

    // Check 10: the next visitor cannot confirm the service and join time
    await ticket.selectOption({ label: second });
    await asked(page).check();
    const restricted = await assist(page);
    expect(restricted.outcome).toBe('restricted_assistance');
    expect(restricted.hasGrant, 'no credential in the response').toBe(false);
    await expect(page.getByTestId('staff-recovery-note')).toContainText(
      'No credential can be given',
    );
    await expect(page.getByTestId('staff-recovery-qr')).toHaveCount(0);
    // and after restricted assistance the answers are cleared as well
    await expect(asked(page)).not.toBeChecked();
    await expect(named(page)).not.toBeChecked();
  });
});
