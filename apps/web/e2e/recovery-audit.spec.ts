import { expect, test, type Browser, type Page } from '@playwright/test';
import { apiQueueSetup, expectNoA11yViolations, type QueueSetup } from './helpers.js';
import { makeStaff } from './offline-helpers.js';

/**
 * Manual check 12 (2026-11-16): the requester and the approver of a staff-assisted recovery were
 * not shown anywhere. Recovery is audited in admin events (never in the queue's event chain), and
 * the Audit trail page showed only the chain. These tests drive the check 9 scenario through the
 * real screens and then read the new Recovery activity section (design §15.9a) as a supervisor
 * and as an auditor. The grant is compared in memory only; the on-failure trace is off.
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

async function rows(page: Page): Promise<{ kind: string; text: string }[]> {
  const table = page.getByTestId('recovery-activity-table');
  await expect(table).toBeVisible();
  return table
    .locator('tbody tr')
    .evaluateAll((trs) =>
      trs.map((tr) => ({ kind: tr.getAttribute('data-kind') ?? '', text: tr.textContent ?? '' })),
    );
}

test('Recovery activity names the requester and the approver, shows the reason and the visitor redemption, for supervisor and auditor alike', async ({
  page,
  browser,
}) => {
  const s: Setup = await apiQueueSetup(page.request);
  const code = await joinCode(browser, s);
  const counter = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
  const sup = await makeStaff(browser, page.request, s.facility.id, 'supervisor');
  const auditor = await makeStaff(browser, page.request, s.facility.id, 'auditor');

  // Check 9 through the real screens: the counter requests, the supervisor approves
  await counter.page.goto(`/staff/queues/${s.queueId}`);
  const panel = counter.page.getByTestId('staff-recovery');
  await panel.getByLabel('Ticket', { exact: true }).selectOption({ label: code });
  await panel.getByLabel(/I asked the visitor before showing/).check();
  await panel.getByLabel(/They named the correct service/).check();
  const res = counter.page.waitForResponse((r) => r.url().includes('/recovery/assist'));
  await panel.getByRole('button', { name: 'Start recovery' }).click();
  const grant = ((await (await res).json()) as { grant: string }).grant;
  await sup.page.goto(`/staff/queues/${s.queueId}`);
  const approvals = sup.page.getByTestId('staff-recovery-approvals');
  await expect(approvals).toContainText(code, { timeout: 15_000 });
  await approvals.getByRole('button', { name: new RegExp(`Approve recovery for ${code}`) }).click();
  await expect(counter.page.getByTestId('staff-recovery-qr')).toBeVisible({ timeout: 15_000 });
  // the visitor redeems on their own device
  const visitor = await browser.newContext({ serviceWorkers: 'block' });
  const vp = await visitor.newPage();
  await vp.goto(`/recover#g=${grant}`);
  await expect(vp.getByTestId('ticket-code')).toHaveText(code);
  await visitor.close();

  const views: Record<string, { kind: string; text: string }[]> = {};
  for (const [who, p] of [
    ['supervisor', sup.page],
    ['auditor', auditor.page],
  ] as [string, Page][]) {
    await p.goto(`/staff/queues/${s.queueId}/audit`);
    await expect(p.getByRole('heading', { name: 'Recovery activity' })).toBeVisible();
    const r = await rows(p);
    views[who] = r;
    expect(r.map((x) => x.kind)).toEqual(['request', 'approval', 'recovered']);
    const [request, approval, recovered] = r;
    expect(request?.text).toContain(code);
    expect(request?.text).toContain('Requested by Staff staff_counter');
    expect(request?.text).toContain('reason: Lost or broken phone');
    expect(approval?.text).toContain('Approved by Staff supervisor');
    expect(approval?.text).not.toContain('staff_counter');
    expect(request?.text).not.toContain('Staff supervisor');
    expect(recovered?.text).toContain('The visitor’s own device');
    expect(recovered?.text).toContain('with a staff grant');
    expect(recovered?.text).not.toContain('Staff supervisor');
    // no credential anywhere on the page, and nothing to act on in the section
    const main = await p.locator('main').innerText();
    expect(main.includes(grant), 'grant on the page').toBe(false);
    expect(main).not.toMatch(/#g=|#k=/);
    await expect(p.getByTestId('recovery-activity').getByRole('button')).toHaveCount(0);
  }
  expect(views['auditor']).toEqual(views['supervisor']);
  await expectNoA11yViolations(auditor.page);
  for (const x of [counter, sup, auditor]) await x.ctx.close();
});

test('a queue with no recovery shows a plain empty state; counter staff cannot open the audit trail', async ({
  page,
  browser,
}) => {
  const s: Setup = await apiQueueSetup(page.request);
  await page.goto(`/staff/queues/${s.queueId}/audit`);
  await expect(page.getByTestId('recovery-activity-empty')).toHaveText(
    'No recovery activity for this queue.',
  );
  const counter = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
  const r = await counter.page.request.get(`/api/v1/queues/${s.queueId}/recovery/audit`);
  expect(r.status()).toBe(403);
  await counter.ctx.close();
});
