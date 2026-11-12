import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { uuidv7 } from '@queuebridge/contracts';
import { apiQueueSetup, expectNoA11yViolations, hasHorizontalOverflow } from './helpers.js';
import { makeStaff } from './offline-helpers.js';

/**
 * Manual-acceptance defects (M4) in the real staff workflow: an administrator deactivating a
 * counter (Administration → Counters) that is serving or calling a visitor. Real API +
 * PostgreSQL + built web app; `@responsive` also runs at 1440, 375 and 320 px.
 */

const CSRF = { 'X-QB-CSRF': '1' };

async function walkIn(request: APIRequestContext, queueId: string): Promise<string> {
  const r = await request.post(`/api/v1/queues/${queueId}/walk-ins`, {
    headers: CSRF,
    data: { operation_id: uuidv7() },
  });
  expect(r.status()).toBe(201);
  return ((await r.json()) as { ticket: { public_code: string } }).ticket.public_code;
}

async function addCounter(request: APIRequestContext, fid: string, sid: string): Promise<string> {
  const c = await request.post(`/api/v1/facilities/${fid}/counters`, {
    headers: CSRF,
    data: { name: 'Counter 2' },
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

test.describe('@responsive counter deactivation keeps the serving/called invariant', () => {
  test('a serving counter cannot be deactivated; a calling one requeues the visitor and the console follows', async ({
    page,
    browser,
  }) => {
    const viewport = page.viewportSize();
    const s = await apiQueueSetup(page.request);
    const queueId = s.queueId ?? '';
    const counter2 = await addCounter(page.request, s.facility.id, s.serviceId);
    const g1 = await walkIn(page.request, queueId);
    const g2 = await walkIn(page.request, queueId);

    const op = await makeStaff(browser, page.request, s.facility.id, 'staff_counter', { viewport });
    await op.page.goto(`/staff/queues/${queueId}`);
    await op.page.locator('#counter-select').selectOption(s.counterId);
    await op.page.getByRole('button', { name: 'Call next' }).click();
    await expect(op.page.getByTestId('current-code')).toHaveText(g1);
    await op.page.getByRole('button', { name: 'Start serving' }).click();
    await expect(op.page.getByRole('button', { name: 'Complete' })).toBeVisible();

    // 2. The administrator tries to deactivate the SERVING counter: refused, stated in place
    await page.goto(`/admin/facilities/${s.facility.id}/counters`);
    const c1 = page.getByTestId('counter-item').filter({ hasText: 'Counter 1' });
    await c1.getByRole('button', { name: 'Deactivate Counter 1' }).click();
    await expect(c1.getByTestId('counter-notice')).toContainText('is serving a visitor');
    await expect(c1.getByRole('alert')).toBeVisible();
    await expect(c1.getByRole('button', { name: 'Deactivate Counter 1' })).toBeVisible(); // still active
    await expect(op.page.getByRole('button', { name: 'Complete' })).toBeEnabled();
    await op.page.getByRole('button', { name: 'Complete' }).click();
    await expect(op.page.getByTestId('counter-free')).toBeVisible();

    // 3. Operator calls g2 — then the administrator deactivates Counter 1
    await op.page.getByRole('button', { name: 'Call next' }).click();
    await expect(op.page.getByTestId('current-code')).toHaveText(g2);
    // a second console whose live updates are BLOCKED keeps the old view (stale state)
    const stale = await makeStaff(browser, page.request, s.facility.id, 'staff_counter', {
      viewport,
    });
    await stale.page.route('**/stream', (r) => r.abort());
    await stale.page.goto(`/staff/queues/${queueId}`);
    await stale.page.locator('#counter-select').selectOption(s.counterId);
    await expect(stale.page.getByTestId('current-code')).toHaveText(g2);

    await c1.getByRole('button', { name: 'Deactivate Counter 1' }).click();
    await expect(c1.getByTestId('counter-notice')).toContainText(
      `${g2} returned to the front of the queue`,
    );
    await expect(c1.getByRole('button', { name: 'Activate Counter 1' })).toBeVisible();

    // 10. The live console follows WITHOUT a reload: visitor back at the head, counter flagged
    await expect(op.page.getByTestId('counter-inactive')).toBeVisible();
    await expect(op.page.getByTestId('at-counter')).toHaveCount(0);
    await expect.poll(() => waitingCodes(op.page)).toEqual([g2]);
    await expect(op.page.getByRole('button', { name: 'Call next' })).toBeDisabled();
    expect(await hasHorizontalOverflow(op.page)).toBe(false);
    await expectNoA11yViolations(op.page);

    // 4. The stale console still offers "Start serving": the server refuses, the screen corrects
    await stale.page.getByRole('button', { name: 'Start serving' }).click();
    await expect(stale.page.getByTestId('command-error')).toContainText('waiting ticket cannot');
    await expect(stale.page.getByTestId('at-counter')).toHaveCount(0);
    await expect(stale.page.getByTestId('counter-inactive')).toBeVisible();
    await expect.poll(() => waitingCodes(stale.page)).toEqual([g2]);

    // 7. Still eligible: an open, capable counter calls the requeued visitor first
    await op.page.locator('#counter-select').selectOption(counter2);
    await op.page.getByRole('button', { name: 'Call next' }).click();
    await expect(op.page.getByTestId('current-code')).toHaveText(g2);

    // 9. The audit trail explains the requeue
    const audit = await page.request.get(`/api/v1/queues/${queueId}/audit?limit=200`);
    const events = (
      (await audit.json()) as {
        audit: { events: { event_type: string; payload: Record<string, unknown> }[] };
      }
    ).audit.events;
    const rel = events.find((e) => e.event_type === 'ticket.release');
    expect(rel?.payload).toMatchObject({ public_code: g2, reason_code: 'counter_deactivated' });
    await page.goto(`/staff/queues/${queueId}/audit`);
    await expect(page.locator('tr[data-event-type="ticket.release"]')).toContainText(
      'counter deactivated by an administrator',
    );

    await op.ctx.close();
    await stale.ctx.close();
  });
});

test.describe('@responsive removing a service from a counter keeps the calling/serving invariant (PR #6 final review)', () => {
  test('refused with a visible alert while calling or serving; allowed once the visit is done', async ({
    page,
    browser,
  }) => {
    const viewport = page.viewportSize();
    const s = await apiQueueSetup(page.request);
    const queueId = s.queueId ?? '';
    const g1 = await walkIn(page.request, queueId);

    const op = await makeStaff(browser, page.request, s.facility.id, 'staff_counter', { viewport });
    await op.page.goto(`/staff/queues/${queueId}`);
    await op.page.locator('#counter-select').selectOption(s.counterId);
    await op.page.getByRole('button', { name: 'Call next' }).click();
    await expect(op.page.getByTestId('current-code')).toHaveText(g1);

    await page.goto(`/admin/facilities/${s.facility.id}/counters`);
    const card = page.getByTestId('counter-item').filter({ hasText: 'Counter 1' });
    const box = card.getByRole('checkbox', { name: 'General Consultation' });
    await expect(box).toBeChecked();

    const tryRemove = async (): Promise<void> => {
      const resp = page.waitForResponse(
        (r) =>
          r.url().includes('/counter_service_capabilities/') && r.request().method() === 'DELETE',
      );
      await box.uncheck();
      expect((await resp).status()).toBe(409);
    };

    // 1. CALLED: refused, stated in place, checkbox returns to checked, operator unaffected
    await tryRemove();
    await expect(card.getByTestId('counter-notice')).toContainText('is calling a visitor');
    await expect(card.getByRole('alert')).toBeVisible();
    await expect(box).toBeChecked();
    await expect(op.page.getByTestId('current-code')).toHaveText(g1);
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await expectNoA11yViolations(page);

    // 2. SERVING: still refused
    await op.page.getByRole('button', { name: 'Start serving' }).click();
    await expect(op.page.getByRole('button', { name: 'Complete' })).toBeVisible();
    await tryRemove();
    await expect(card.getByTestId('counter-notice')).toContainText('is serving a visitor');
    await expect(box).toBeChecked();
    await expect(op.page.getByRole('button', { name: 'Complete' })).toBeEnabled();

    // 3. Server state unchanged: capability still listed, ticket still serving
    const counters = (await (
      await page.request.get(`/api/v1/facilities/${s.facility.id}/counters`)
    ).json()) as { counters: { id: string; service_ids: string[] }[] };
    expect(counters.counters.find((c) => c.id === s.counterId)?.service_ids).toEqual([s.serviceId]);

    // 4. Once the visit is complete, the same action succeeds
    await op.page.getByRole('button', { name: 'Complete' }).click();
    await expect(op.page.getByTestId('counter-free')).toBeVisible();
    await box.uncheck();
    await expect(page.getByTestId('toast')).toContainText(
      'Counter 1 no longer serves General Consultation.',
    );
    await expect(box).not.toBeChecked();
    await expect(card.getByTestId('counter-notice')).toHaveCount(0);
    await page.reload();
    await expect(
      page
        .getByTestId('counter-item')
        .filter({ hasText: 'Counter 1' })
        .getByRole('checkbox', { name: 'General Consultation' }),
    ).not.toBeChecked();
    await op.ctx.close();
  });
});

test.describe('policy configuration is for administrators only (manual test 1)', () => {
  test('a supervisor sees the services but no policy editor; the API refuses them', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request, { open: false });
    const sup = await makeStaff(browser, page.request, s.facility.id, 'supervisor');
    await sup.page.goto(`/admin/facilities/${s.facility.id}/services`);
    const svc = sup.page.getByTestId('service-item').filter({ hasText: 'General Consultation' });
    await expect(svc.getByTestId('policy-version')).toHaveText('Policy v1');
    await expect(svc.getByText('Edit policy')).toHaveCount(0);
    const r = await sup.page.request.patch(
      `/api/v1/facilities/${s.facility.id}/services/${s.serviceId}`,
      { headers: CSRF, data: { policy: { priority_order: ['priority', 'normal'] } } },
    );
    expect(r.status()).toBe(403);
    // the organization administrator does see it
    await page.goto(`/admin/facilities/${s.facility.id}/services`);
    await expect(
      page
        .getByTestId('service-item')
        .filter({ hasText: 'General Consultation' })
        .getByText('Edit policy'),
    ).toBeVisible();
    await sup.ctx.close();
  });
});

test.describe('operation ids after a definitive refusal (PR #6 review)', () => {
  test('a counter transfer refused because the target became busy succeeds when retried after it is free', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    const queueId = s.queueId ?? '';
    const counter2 = await addCounter(page.request, s.facility.id, s.serviceId);
    const g1 = await walkIn(page.request, queueId);
    await walkIn(page.request, queueId);

    const op = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    // Live updates blocked: the console keeps a stale view and falls back to slow polling
    await op.page.route('**/stream', (r) => r.abort());
    await op.page.goto(`/staff/queues/${queueId}`);
    await op.page.locator('#counter-select').selectOption(s.counterId);
    await op.page.getByRole('button', { name: 'Call next' }).click();
    await expect(op.page.getByTestId('current-code')).toHaveText(g1);
    const transfer = op.page.getByRole('form', { name: `Send ${g1} to another counter` });
    await transfer.getByLabel('Counter').selectOption(counter2);

    // Meanwhile Counter 2 calls the next visitor (the operator's screen does not know yet)
    const busy = await page.request.post(`/api/v1/queues/${queueId}/commands`, {
      headers: CSRF,
      data: { operation_id: uuidv7(), action: 'ticket.call_next', counter_id: counter2 },
    });
    const g2Id = ((await busy.json()) as { outcome: { ticket_id: string } }).outcome.ticket_id;
    await transfer.getByRole('button', { name: 'Send to counter' }).click();
    await expect(op.page.getByTestId('command-error')).toContainText('still handling');

    // Counter 2 finishes; once the console sees it free again, the SAME transfer is retried
    for (const action of ['ticket.serve', 'ticket.complete']) {
      await page.request.post(`/api/v1/queues/${queueId}/commands`, {
        headers: CSRF,
        data: { operation_id: uuidv7(), action, ticket_id: g2Id },
      });
    }
    await expect(transfer.getByRole('button', { name: 'Send to counter' })).toBeEnabled({
      timeout: 25_000,
    });
    await transfer.getByRole('button', { name: 'Send to counter' }).click();
    // A fresh operation id was used: the transfer EXECUTES (no replay of the stored refusal)
    await expect(op.page.getByTestId('counter-free')).toContainText('Counter 1 is free');
    const q = (await (await page.request.get(`/api/v1/queues/${queueId}`)).json()) as {
      queue: { tickets: { public_code: string; counter_id: string | null; state: string }[] };
    };
    expect(q.queue.tickets.find((t) => t.public_code === g1)).toMatchObject({
      state: 'called',
      counter_id: counter2,
    });
    await op.ctx.close();
  });
});
