import { expect, test, type Locator, type Page } from '@playwright/test';
import { apiFacility, apiQueueSetup, apiSignup, expectNoA11yViolations } from './helpers.js';
import { makeStaff } from './offline-helpers.js';

const CSRF = { 'X-QB-CSRF': '1' };

/**
 * MQ.4 — optional AI explanations in a real browser (design §11.7, §11.9; REQ-F13.4, F13.7.2,
 * F13.8.2). The e2e API runs the TEST-ONLY sandbox adapter (scripted, never networked); AI still
 * needs a facility opt-in. No real provider exists.
 */

const panel = (p: Page): Locator => p.getByTestId('que-panel');
const search = (p: Page): Locator => panel(p).getByLabel('Search help');

async function openQue(p: Page): Promise<void> {
  await p.getByTestId('ask-que').click();
  await expect(panel(p).getByTestId('que-results')).toBeVisible();
}

async function optIn(page: Page, facilityId: string): Promise<void> {
  const r = await page.request.put(`/api/v1/facilities/${facilityId}/que-ai`, {
    headers: CSRF,
    data: { enabled: true, consent_version: 'que-ai-consent-v1', consent_acknowledged: true },
  });
  expect(r.status()).toBe(200);
}

test.describe('MQ.4 facility opt-in (admin page)', () => {
  test('off by default; turning on needs the disclosure to be acknowledged; turning off works', async ({
    page,
  }) => {
    await apiSignup(page.request);
    const fac = await apiFacility(page.request, 'AI Clinic');
    await page.goto(`/admin/facilities/${fac.id}`);
    const section = page.getByTestId('que-ai-settings');
    await expect(section.getByRole('heading', { name: 'Ask Que AI explanations' })).toBeVisible();
    await expect(section.getByTestId('que-ai-state')).toHaveText(
      'Off for this facility (default).',
    );
    await expect(section).toContainText('No ticket, visitor, staff or facility data is sent.');
    const turnOn = section.getByRole('button', { name: 'Turn on AI explanations' });
    await expect(turnOn).toBeDisabled();
    await section
      .getByLabel('I have read this and agree to turn on AI explanations for this facility.')
      .check();
    await turnOn.click();
    await expect(section.getByTestId('que-ai-state')).toContainText('On for this facility');
    await expectNoA11yViolations(page);
    await section.getByRole('button', { name: 'Turn off AI explanations' }).click();
    await expect(section.getByTestId('que-ai-state')).toHaveText(
      'Off for this facility (default).',
    );
  });

  test('a supervisor can see the setting but not change it', async ({ browser, page }) => {
    await apiSignup(page.request);
    const fac = await apiFacility(page.request);
    const staff = await makeStaff(browser, page.request, fac.id, 'supervisor');
    await staff.page.goto(`/admin/facilities/${fac.id}`);
    const section = staff.page.getByTestId('que-ai-settings');
    await expect(section).toContainText('Only a facility administrator can change this.');
    await expect(section.getByRole('button')).toHaveCount(0);
    await staff.ctx.close();
  });

  test('a deployment without an AI provider says so, on the admin page and in Ask Que', async ({
    page,
  }) => {
    await apiSignup(page.request);
    const fac = await apiFacility(page.request);
    await optIn(page, fac.id);
    // Present the disabled-by-default deployment's answer for this facility
    await page.route(`**/api/v1/facilities/${fac.id}/que-ai`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await route.fulfill({
        response: res,
        json: { ...body, deployment_available: false, available: false },
      });
    });
    await page.goto(`/admin/facilities/${fac.id}`);
    await expect(page.getByTestId('que-ai-deployment')).toContainText(
      'Not available on this deployment: no AI provider is set up',
    );
    await expect(page.getByTestId('que-ai-deployment')).toContainText(
      'The opt-in is recorded but has no effect.',
    );
    await openQue(page);
    await search(page).fill('sync states');
    await expect(panel(page).getByTestId('que-ai-status')).toHaveText(
      'AI explanations are not set up here. This is built-in help.',
    );
    await expect(panel(page).getByRole('button', { name: 'Explain with AI' })).toHaveCount(0);
  });
});

test.describe('MQ.4 AI explanations in Ask Que', () => {
  test('staff on an opted-in facility get a labelled, cited AI explanation; visitors get none', async ({
    browser,
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    await optIn(page, s.facility.id);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    const p = staff.page;
    const writes: string[] = [];
    p.on('request', (r) => {
      if (r.method() !== 'GET' && r.url().includes('/api/v1/que'))
        writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await p.goto(`/staff/queues/${s.queueId}`);
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('General Consultation');
    await openQue(p);
    // No AI control before a question is asked
    await expect(panel(p).getByRole('button', { name: 'Explain with AI' })).toHaveCount(0);
    await search(p).fill('sync states');
    await panel(p).getByRole('button', { name: 'Explain with AI' }).click();
    const answer = panel(p).getByTestId('que-ai-answer');
    await expect(answer.getByText('AI-generated')).toBeVisible();
    await expect(answer).toContainText('What the sync states mean:');
    await expect(answer).toContainText('Check with staff before acting on queue decisions.');
    await expect(panel(p).getByTestId('que-live')).toHaveText(
      'AI explanation ready. It is labelled and can be wrong.',
    );
    await expect(answer.locator('a')).toHaveCount(0); // AI text never carries links
    await expectNoA11yViolations(p);
    // Sources open the cited built-in article
    await answer.getByRole('button', { name: 'What the sync states mean' }).click();
    await expect(
      panel(p).getByTestId('que-article').getByRole('heading', { level: 3 }),
    ).toBeFocused();
    expect(writes).toEqual(['POST /api/v1/que/ask']);
    await staff.ctx.close();

    // An anonymous visitor on the same facility's join page: no AI anywhere
    await page.context().clearCookies();
    await page.goto(s.joinPath);
    await openQue(page);
    await search(page).fill('recover key');
    await expect(panel(page).getByTestId('que-ai')).toHaveCount(0);
    expect((await panel(page).innerText()).toLowerCase()).not.toContain('ai explanation');
  });

  test('a rejected or failed AI answer falls back to built-in help with a plain reason', async ({
    browser,
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    await optIn(page, s.facility.id);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    const p = staff.page;
    await p.goto(`/staff/queues/${s.queueId}`);
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('General Consultation');
    await openQue(p);
    for (const [marker, reason] of [
      ['sandbox:inject', 'The AI explanation could not be checked against built-in help.'],
      ['sandbox:timeout', 'The AI explanation took too long.'],
      ['sandbox:error', 'The AI service did not answer.'],
    ] as const) {
      await search(p).fill(`sync states ${marker}`);
      await panel(p).getByRole('button', { name: 'Explain with AI' }).click();
      const fb = panel(p).getByTestId('que-ai-fallback');
      await expect(fb).toContainText('AI explanation unavailable — showing built-in help.');
      await expect(fb).toContainText(reason);
      await expect(panel(p).getByTestId('que-ai-answer')).toHaveCount(0);
      expect(await panel(p).innerText()).not.toMatch(/cancelled the ticket|Ignore previous/);
      // Built-in results are still shown
      await expect(panel(p).locator('.que-article-link').first()).toBeVisible();
    }
    await staff.ctx.close();
  });

  test('a facility that has not opted in shows no AI control', async ({ browser, page }) => {
    const s = await apiQueueSetup(page.request);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'supervisor');
    const p = staff.page;
    await p.goto(`/staff/queues/${s.queueId}`);
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('General Consultation');
    await openQue(p);
    await search(p).fill('sync states');
    await expect(panel(p).getByTestId('que-ai-status')).toHaveText(
      'AI explanations are not set up here. This is built-in help.',
    );
    await expect(panel(p).getByRole('button', { name: 'Explain with AI' })).toHaveCount(0);
    await staff.ctx.close();
  });

  test('@pwa offline: no AI control, and the panel says AI needs a connection', async ({
    browser,
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    await optIn(page, s.facility.id);
    const staff = await makeStaff(browser, page.request, s.facility.id, 'staff_counter', {
      serviceWorkers: 'allow',
    });
    const p = staff.page;
    await p.goto(`/staff/queues/${s.queueId}`);
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('General Consultation');
    await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await p.reload();
    await expect
      .poll(() => p.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('General Consultation');
    await staff.ctx.setOffline(true);
    await expect(p.getByTestId('connection-state')).toContainText('Offline');
    await openQue(p);
    await search(p).fill('sync states');
    await expect(panel(p).getByTestId('que-offline')).toHaveText('Offline');
    await expect(panel(p).getByTestId('que-ai-status')).toHaveText(
      'AI explanations need a connection. Built-in help works offline.',
    );
    await expect(panel(p).getByRole('button', { name: 'Explain with AI' })).toHaveCount(0);
    await staff.ctx.close();
  });
});
