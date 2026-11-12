import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { uuidv7 } from '@queuebridge/contracts';
import { apiQueueSetup, expectNoA11yViolations, hasHorizontalOverflow } from './helpers.js';
import { makeStaff } from './offline-helpers.js';

/**
 * M4 browser journeys against the real stack (API + PostgreSQL): supervisor priority override,
 * routing when counters close, counter-to-counter transfer, the audit trail with integrity
 * verification, and policy versioning. `@responsive` tests also run at 320 and 375 px wide
 * (and 1440 px) with axe WCAG 2.1 A/AA and a no-horizontal-overflow check.
 */

const CSRF = { 'X-QB-CSRF': '1' };

async function enablePriority(request: APIRequestContext, fid: string, sid: string): Promise<void> {
  const r = await request.patch(`/api/v1/facilities/${fid}/services/${sid}`, {
    headers: CSRF,
    data: { policy: { priority_order: ['priority', 'normal'] } },
  });
  expect(r.status()).toBe(200);
}

async function walkIns(request: APIRequestContext, queueId: string, n: number): Promise<string[]> {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await request.post(`/api/v1/queues/${queueId}/walk-ins`, {
      headers: CSRF,
      data: { operation_id: uuidv7() },
    });
    expect(r.status()).toBe(201);
    codes.push(((await r.json()) as { ticket: { public_code: string } }).ticket.public_code);
  }
  return codes;
}

async function addCounter(
  request: APIRequestContext,
  fid: string,
  sid: string,
  name: string,
): Promise<string> {
  const c = await request.post(`/api/v1/facilities/${fid}/counters`, {
    headers: CSRF,
    data: { name },
  });
  const id = ((await c.json()) as { counter: { id: string } }).counter.id;
  await request.post('/api/v1/counter_service_capabilities', {
    headers: CSRF,
    data: { counter_id: id, service_id: sid },
  });
  return id;
}

const waitingCodes = (page: Page): Promise<string[]> =>
  page.getByTestId('waiting-list').locator('.ticket-row-code').allInnerTexts();

async function checkLayout(page: Page): Promise<void> {
  await expectNoA11yViolations(page);
  expect(await hasHorizontalOverflow(page)).toBe(false);
}

test.describe('@responsive M4 supervisor priority override', () => {
  test('a supervisor moves a visitor up with a recorded reason; a counter operator cannot', async ({
    page,
    browser,
  }) => {
    const viewport = page.viewportSize();
    const s = await apiQueueSetup(page.request);
    const queueId = s.queueId ?? '';
    await enablePriority(page.request, s.facility.id, s.serviceId);
    await walkIns(page.request, queueId, 3);

    const sup = await makeStaff(browser, page.request, s.facility.id, 'supervisor', { viewport });
    await sup.page.goto(`/staff/queues/${queueId}`);
    await expect(sup.page.getByTestId('waiting-list')).toContainText('G003');
    expect(await waitingCodes(sup.page)).toEqual(['G001', 'G002', 'G003']);

    await sup.page.getByRole('button', { name: 'Supervisor actions for G003' }).click();
    const panel = sup.page.getByTestId('override-panel');
    const form = panel.getByRole('form', { name: 'Change priority of G003' });
    await form.getByLabel('New class').selectOption('priority');
    await form.getByLabel('Reason').selectOption('accessibility_need');
    // Too-short explanation keeps the action disabled
    await form.getByLabel(/Explanation/).fill('abc');
    await expect(form.getByRole('button', { name: 'Change priority' })).toBeDisabled();
    await form.getByLabel(/Explanation/).fill('Visitor uses a wheelchair and cannot stand');
    await form.getByRole('button', { name: 'Change priority' }).click();
    // Explicit confirmation step naming what will be recorded
    await expect(form.getByTestId('override-confirm')).toContainText(
      'Move G003 from Normal to Priority',
    );
    await checkLayout(sup.page);
    await form.getByRole('button', { name: 'Confirm priority change' }).click();

    await expect(sup.page.getByTestId('override-panel')).toHaveCount(0);
    await expect.poll(() => waitingCodes(sup.page)).toEqual(['G003', 'G001', 'G002']);
    const first = sup.page.getByTestId('waiting-list').locator('li').first();
    await expect(first.getByTestId('priority-badge')).toHaveText(/Priority/);
    await checkLayout(sup.page);

    // The published order is enforced server-side: "Call next" now calls G003
    await sup.page.getByRole('button', { name: 'Call next' }).click();
    await expect(sup.page.getByTestId('current-code')).toHaveText('G003');

    // A counter operator sees no override controls, and the API refuses them anyway (403)
    const op = await makeStaff(browser, page.request, s.facility.id, 'staff_counter', { viewport });
    await op.page.goto(`/staff/queues/${queueId}`);
    await expect(op.page.getByTestId('waiting-list')).toContainText('G001');
    await expect(op.page.getByRole('button', { name: /Supervisor actions/ })).toHaveCount(0);
    const q = (await (await op.page.request.get(`/api/v1/queues/${queueId}`)).json()) as {
      queue: { tickets: { id: string; public_code: string }[] };
    };
    const g001 = q.queue.tickets.find((t) => t.public_code === 'G001')?.id ?? '';
    const denied = await op.page.request.post(`/api/v1/tickets/${g001}/priority-override`, {
      headers: CSRF,
      data: {
        operation_id: uuidv7(),
        to_class: 'priority',
        reason_code: 'urgent_need',
        reason_text: 'Trying to skip the line',
      },
    });
    expect(denied.status()).toBe(403);
    await op.page.reload();
    await expect.poll(() => waitingCodes(op.page)).toEqual(['G001', 'G002']);

    await sup.ctx.close();
    await op.ctx.close();
  });
});

test.describe('@responsive M4 routing when counters close', () => {
  test('closing a counter returns a called visitor to the front; closed counters cannot call; transfers keep the visitor', async ({
    page,
    browser,
  }) => {
    const viewport = page.viewportSize();
    const s = await apiQueueSetup(page.request);
    const queueId = s.queueId ?? '';
    const counter2 = await addCounter(page.request, s.facility.id, s.serviceId, 'Counter 2');
    await walkIns(page.request, queueId, 2);

    // Counter operator at Counter 1 calls G001, then cannot close while a visitor is called
    const op = await makeStaff(browser, page.request, s.facility.id, 'staff_counter', { viewport });
    await op.page.goto(`/staff/queues/${queueId}`);
    await op.page.getByLabel('Counter', { exact: true }).selectOption({ label: 'Counter 1' });
    await op.page.getByRole('button', { name: 'Call next' }).click();
    await expect(op.page.getByTestId('current-code')).toHaveText('G001');
    await expect(op.page.getByRole('button', { name: 'Close Counter 1' })).toBeDisabled();
    await expect(op.page.getByTestId('close-blocked-hint')).toContainText('Only a supervisor');
    await checkLayout(op.page);

    // Counter-to-counter transfer: G001 goes to Counter 2 without re-queueing
    const transfer = op.page.getByRole('form', { name: 'Send G001 to another counter' });
    await transfer.getByLabel('Counter').selectOption({ label: 'Counter 2' });
    await transfer.getByRole('button', { name: 'Send to counter' }).click();
    await expect(op.page.getByTestId('counter-free')).toContainText('Counter 1 is free');

    // Supervisor at Counter 2 closes it: the called visitor returns to the FRONT of the line
    const sup = await makeStaff(browser, page.request, s.facility.id, 'supervisor', { viewport });
    await sup.page.goto(`/staff/queues/${queueId}`);
    // (the option reads "Counter 2 (serving G001)", so select by id)
    await sup.page.getByLabel('Counter', { exact: true }).selectOption(counter2);
    await expect(sup.page.getByTestId('current-code')).toHaveText('G001');
    await sup.page.getByLabel('Close counter — reason').selectOption('break');
    await sup.page.getByRole('button', { name: 'Close Counter 2' }).click();
    await expect(sup.page.getByTestId('counter-availability')).toContainText('Counter 2 is closed');
    await expect.poll(() => waitingCodes(sup.page)).toEqual(['G001', 'G002']);
    await expect(sup.page.getByRole('button', { name: 'Call next' })).toBeDisabled();
    await checkLayout(sup.page);

    // Idle Counter 1 closed by the operator: now no counter can serve — stated plainly
    await op.page.reload();
    await op.page.getByLabel('Close counter — reason').selectOption('end_of_shift');
    await op.page.getByRole('button', { name: 'Close Counter 1' }).click();
    await expect(op.page.getByTestId('no-open-counter')).toBeVisible();
    await expect(op.page.getByRole('button', { name: 'Call next' })).toBeDisabled();

    // Reopen: the released visitor is called first (waiting age kept)
    await op.page.getByRole('button', { name: 'Open Counter 1' }).click();
    await expect(op.page.getByTestId('no-open-counter')).toHaveCount(0);
    await op.page.getByRole('button', { name: 'Call next' }).click();
    await expect(op.page.getByTestId('current-code')).toHaveText('G001');

    await sup.ctx.close();
    await op.ctx.close();
  });
});

test.describe('@responsive M4 audit trail', () => {
  test('an auditor reads the trail with override explanations and verifies integrity; operational staff cannot', async ({
    page,
    browser,
  }) => {
    const viewport = page.viewportSize();
    const s = await apiQueueSetup(page.request);
    const queueId = s.queueId ?? '';
    await enablePriority(page.request, s.facility.id, s.serviceId);
    await walkIns(page.request, queueId, 2);
    const q = (await (await page.request.get(`/api/v1/queues/${queueId}`)).json()) as {
      queue: { tickets: { id: string; public_code: string }[] };
    };
    const g002 = q.queue.tickets.find((t) => t.public_code === 'G002')?.id ?? '';
    const o = await page.request.post(`/api/v1/tickets/${g002}/priority-override`, {
      headers: CSRF,
      data: {
        operation_id: uuidv7(),
        to_class: 'priority',
        reason_code: 'returning_visitor',
        reason_text: 'Was sent back from the lab',
      },
    });
    expect(o.status()).toBe(200);

    const auditor = await makeStaff(browser, page.request, s.facility.id, 'auditor', { viewport });
    await auditor.page.goto(`/staff/queues/${queueId}`);
    await auditor.page.getByTestId('audit-link').click();
    await expect(auditor.page.getByRole('heading', { level: 1 })).toContainText('Audit trail');
    await expect(auditor.page.getByTestId('summary-priority')).toHaveText('1');
    const row = auditor.page.locator('tr[data-event-type="ticket.priority_override"]');
    await expect(row).toContainText('Was sent back from the lab');
    await expect(row).toContainText('Normal → Priority');
    await expect(row).toContainText('Org Admin');

    await auditor.page.getByRole('button', { name: 'Verify integrity' }).click();
    const result = auditor.page.getByTestId('verify-result');
    await expect(result).toHaveAttribute('data-status', 'verified');
    await expect(result.getByTestId('verify-status')).toContainText('Verified');
    await expect(result).toBeFocused();
    await expect(
      auditor.page.getByRole('link', { name: 'Download redacted export' }),
    ).toHaveAttribute('href', `/api/v1/queues/${queueId}/audit/export`);
    await checkLayout(auditor.page);

    // The export is redacted: no names and no free-text explanations
    const exp = await auditor.page.request.get(`/api/v1/queues/${queueId}/audit/export`);
    expect(exp.status()).toBe(200);
    const text = await exp.text();
    expect(text).not.toContain('Was sent back from the lab');
    expect(text).not.toContain('Org Admin');

    // A counter operator gets no link and a clear refusal
    const op = await makeStaff(browser, page.request, s.facility.id, 'staff_counter', { viewport });
    await op.page.goto(`/staff/queues/${queueId}`);
    await expect(op.page.getByTestId('waiting-list')).toContainText('G001');
    await expect(op.page.getByTestId('audit-link')).toHaveCount(0);
    await op.page.goto(`/staff/queues/${queueId}/audit`);
    await expect(op.page.getByRole('alert')).toContainText('cannot view the audit trail');

    await auditor.ctx.close();
    await op.ctx.close();
  });
});

test.describe('M4 policy versions', () => {
  test('editing the published policy creates a server-assigned version kept in history', async ({
    page,
  }) => {
    const s = await apiQueueSetup(page.request, { open: false });
    await page.goto(`/admin/facilities/${s.facility.id}/services`);
    const svc = page.getByTestId('service-item').filter({ hasText: 'General Consultation' });
    await expect(svc.getByTestId('policy-version')).toHaveText('Policy v1');

    await svc.getByText('Edit policy').click();
    const editor = svc.getByTestId('policy-editor');
    await editor.getByLabel('Enable “priority” class').check();
    await editor.getByLabel('Transferred visitors').selectOption('end_of_queue');
    await editor.getByRole('button', { name: 'Save policy' }).click();
    await expect(svc.getByTestId('policy-version')).toHaveText('Policy v2');
    await expect(svc.getByTestId('service-policy')).toContainText('Priority, Normal');
    await expect(svc.getByTestId('service-policy')).toContainText('end of the destination queue');

    // Saving the same rules again does not create a version (the editor stays open)
    await svc.getByTestId('policy-editor').getByRole('button', { name: 'Save policy' }).click();
    await expect(svc.getByTestId('policy-version')).toHaveText('Policy v2');

    await svc.getByText('Policy history').click();
    const history = svc.getByTestId('policy-history');
    await expect(history.locator('li')).toHaveCount(2);
    await expect(history.locator('li').first()).toContainText('v2');
    await expect(history.locator('li').last()).toContainText('v1');
    await expectNoA11yViolations(page);
  });
});
