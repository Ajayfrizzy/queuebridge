import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { PASSWORD, apiFacility, apiSignup, uiLogin, expectNoA11yViolations } from './helpers.js';

const CSRF = { 'X-QB-CSRF': '1' };

async function seedFacility(page: Page): Promise<{ fid: string; orgSlug: string; email: string }> {
  const org = await apiSignup(page.request);
  const fac = await apiFacility(page.request, 'Refinement Clinic');
  return { fid: fac.id, orgSlug: org.slug, email: org.email };
}

test.describe('URL identifier wording', () => {
  test('organization and facility "address" fields are clearly URL identifiers (slugs)', async ({
    page,
  }) => {
    await page.goto('/signup');
    await expect(page.getByLabel('Organization URL identifier (slug)')).toBeVisible();
    await expect(page.getByText('Organization address')).toHaveCount(0);
    await page.goto('/login');
    await expect(page.getByLabel('Organization URL identifier (slug)')).toBeVisible();
    await apiSignup(page.request);
    await page.goto('/admin');
    await expect(page.getByLabel('Facility URL identifier (slug)')).toBeVisible();
    await expect(page.getByText('Facility address')).toHaveCount(0);
  });
});

test.describe('notifications', () => {
  test('visible notifications can be dismissed (button and Escape) without losing the announcement', async ({
    page,
  }) => {
    const { fid } = await seedFacility(page);
    await page.goto(`/admin/facilities/${fid}/counters`);
    await page.getByLabel('Counter name').fill('Desk A');
    await page.getByRole('button', { name: 'Add counter' }).click();

    const toast = page.getByTestId('toast');
    await expect(toast).toContainText('Counter Desk A added.');
    // The screen-reader live region carries the same message independently of the visible toast
    await expect(page.getByTestId('status')).toHaveText('Counter Desk A added.');
    await expect(page.getByTestId('status')).toHaveAttribute('aria-live', 'polite');
    // the visible copy is not a second live region (no double announcement)
    await expect(toast).not.toHaveAttribute('aria-live', /./);

    await page.getByRole('button', { name: 'Dismiss notification' }).click();
    await expect(toast).toHaveCount(0);
    await expect(page.getByTestId('status')).toHaveText('Counter Desk A added.');

    await page.getByLabel('Counter name').fill('Desk B');
    await page.getByRole('button', { name: 'Add counter' }).click();
    await expect(page.getByTestId('toast')).toContainText('Counter Desk B added.');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('notifications dismiss themselves and the live region is cleared afterwards', async ({
    page,
  }) => {
    await page.clock.install();
    const { fid } = await seedFacility(page);
    await page.goto(`/admin/facilities/${fid}/counters`);
    await page.getByLabel('Counter name').fill('Desk Timed');
    await page.getByRole('button', { name: 'Add counter' }).click();
    await page.clock.runFor(100);
    await expect(page.getByTestId('toast')).toBeVisible();
    await page.clock.runFor(9000);
    await expect(page.getByTestId('toast')).toHaveCount(0);
    await page.clock.runFor(3000);
    await expect(page.getByTestId('status')).toHaveText('');
  });

  test('a visible notification does not introduce accessibility violations', async ({ page }) => {
    const { fid } = await seedFacility(page);
    await page.goto(`/admin/facilities/${fid}/counters`);
    await page.getByLabel('Counter name').fill('Desk Axe');
    await page.getByRole('button', { name: 'Add counter' }).click();
    await expect(page.getByTestId('toast')).toBeVisible();
    await expectNoA11yViolations(page);
  });
});

test.describe('readiness and operational eligibility (UI)', () => {
  test('inactive counters/services are never operational, yet stay configurable', async ({
    page,
  }) => {
    const { fid } = await seedFacility(page);
    const svc = await page.request.post(`/api/v1/facilities/${fid}/services`, {
      headers: CSRF,
      data: { name: 'Pharmacy' },
    });
    const sid = ((await svc.json()) as { service: { id: string } }).service.id;
    const ctr = await page.request.post(`/api/v1/facilities/${fid}/counters`, {
      headers: CSRF,
      data: { name: 'Window 1' },
    });
    const cid = ((await ctr.json()) as { counter: { id: string } }).counter.id;

    // Counter starts inactive and is configured WHILE inactive
    await page.request.patch(`/api/v1/facilities/${fid}/counters/${cid}`, {
      headers: CSRF,
      data: { active: false },
    });
    await page.goto(`/admin/facilities/${fid}/counters`);
    const card = page.getByTestId('counter-item').filter({ hasText: 'Window 1' });
    await expect(card.getByTestId('counter-operational')).toContainText(
      'Not operational: inactive',
    );
    const box = card.getByRole('checkbox', { name: 'Pharmacy' });
    await expect(box).toBeEnabled();
    await box.check();
    await expect(box).toBeChecked();

    await page.getByRole('link', { name: 'Overview' }).click();
    await expect(page.getByTestId('readiness-status')).toHaveText(/Setup incomplete/);
    await expect(page.getByTestId('readiness-counter')).toContainText(
      'Inactive: not operational (1 service assignment kept)',
    );
    await expect(page.getByTestId('readiness-service')).toContainText(
      'Only inactive counters serve this service',
    );

    // Activating the counter makes it eligible without touching the assignment
    await page.getByRole('link', { name: 'Counters', exact: true }).click();
    await card.getByRole('button', { name: /^Activate/ }).click();
    await expect(card.getByTestId('counter-operational')).toContainText(
      'Operational: serving 1 active service',
    );
    await page.getByRole('link', { name: 'Overview' }).click();
    await expect(page.getByTestId('readiness-status')).toHaveText(/Configuration ready/);

    // Deactivating the service removes eligibility again
    await page.request.patch(`/api/v1/facilities/${fid}/services/${sid}`, {
      headers: CSRF,
      data: { status: 'inactive' },
    });
    await page.reload();
    await expect(page.getByTestId('readiness-status')).toHaveText(/Setup incomplete/);
    await expect(page.getByTestId('readiness-service')).toContainText(
      'Inactive: not available to visitors',
    );
    await page.getByRole('link', { name: 'Counters', exact: true }).click();
    await expect(page.getByTestId('counter-item').getByText('(inactive service)')).toBeVisible();
    await expect(page.getByTestId('counter-operational')).toContainText(
      'Not operational: no active service assigned',
    );
  });

  test('the join link is clearly marked as not live, in every readiness state', async ({
    page,
  }) => {
    const { fid } = await seedFacility(page);
    await page.goto(`/admin/facilities/${fid}`);
    await expect(page.getByTestId('join-notice')).toContainText('Not live yet');
    await expect(page.getByTestId('join-qr')).toHaveAttribute('aria-label', /preview only/);
  });
});

test.describe('service policy display', () => {
  test('shows only the priority classes that are actually enabled', async ({ page }) => {
    const { fid } = await seedFacility(page);
    const make = async (name: string, priority_order: string[]): Promise<void> => {
      const r = await page.request.post(`/api/v1/facilities/${fid}/services`, {
        headers: CSRF,
        data: { name, policy: { version: 'v1', priority_order, grace_window_seconds: 60 } },
      });
      expect(r.status()).toBe(201);
    };
    await make('Only Normal', ['normal']);
    await make('Urgent Lane', ['urgent', 'normal']);
    await make('Priority Lane', ['priority', 'normal']);
    await make('All Lanes', ['urgent', 'priority', 'normal']);
    await page.goto(`/admin/facilities/${fid}/services`);
    const policy = (n: string): Locator =>
      page.getByTestId('service-item').filter({ hasText: n }).getByTestId('service-policy');
    await expect(policy('Only Normal')).toContainText('Single queue');
    await expect(policy('Only Normal')).not.toContainText(/urgent/i);
    await expect(policy('Urgent Lane')).toContainText('Urgent, Normal');
    await expect(policy('Urgent Lane')).not.toContainText('Priority,');
    await expect(policy('Priority Lane')).toContainText('Priority, Normal');
    await expect(policy('Priority Lane')).not.toContainText('Urgent');
    await expect(policy('All Lanes')).toContainText('Urgent, Priority, Normal');
  });
});

test.describe('staff screen: active staff, pending invitations, deactivation', () => {
  async function inviteAndAccept(
    page: Page,
    browser: Browser,
    fid: string,
    email: string,
    name: string,
    role: string,
  ): Promise<{ ctx: BrowserContext; p: Page }> {
    const inv = await page.request.post(`/api/v1/facilities/${fid}/invitations`, {
      headers: CSRF,
      data: { email, role },
    });
    const { accept_url } = (await inv.json()) as { accept_url: string };
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const p = await ctx.newPage();
    await p.goto(accept_url);
    await p.getByLabel('Your name').fill(name);
    await p.getByLabel('Password').fill(PASSWORD);
    await p.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('Administration');
    return { ctx, p };
  }

  test('org admin separates active/pending/deactivated; deactivation ends the live session; reactivation requires sign-in', async ({
    page,
    browser,
  }) => {
    const { fid, orgSlug } = await seedFacility(page);
    const { ctx, p } = await inviteAndAccept(
      page,
      browser,
      fid,
      'live.user@example.test',
      'Live User',
      'staff_counter',
    );
    await page.request.post(`/api/v1/facilities/${fid}/invitations`, {
      headers: CSRF,
      data: { email: 'waiting@example.test', role: 'auditor' },
    });

    await p.getByRole('link', { name: 'Refinement Clinic' }).click();
    await expect(p.getByTestId('read-only-note')).toBeVisible();

    await page.goto(`/admin/facilities/${fid}/staff`);
    await expect(page.getByTestId('active-staff')).toContainText('Live User');
    await expect(page.getByTestId('active-staff')).not.toContainText('waiting@example.test');
    await expect(page.getByTestId('pending-invitations')).toContainText('waiting@example.test');
    await expect(page.getByTestId('org-admins')).toContainText('Org Admin');

    const member = page.getByTestId('staff-item').filter({ hasText: 'Live User' });
    await member.getByRole('button', { name: 'Deactivate account for Live User' }).click();
    // two-step confirmation; cancelling changes nothing
    await member.getByRole('button', { name: 'Cancel' }).click();
    await expect(member).toHaveAttribute('data-status', 'active');
    await member.getByRole('button', { name: 'Deactivate account for Live User' }).click();
    await member.getByRole('button', { name: 'Confirm deactivate Live User' }).click();
    await expect(page.getByTestId('status')).toContainText('Live User deactivated');
    await expect(page.getByTestId('inactive-staff')).toContainText('Live User');
    await expect(page.getByTestId('active-staff')).not.toContainText('Live User');
    await expect(
      page.getByTestId('inactive-staff').getByRole('button', { name: /Add$/ }),
    ).toHaveCount(0);

    // Already-authenticated session is ended by the server: next action returns to sign-in
    await p.getByRole('link', { name: 'Services', exact: true }).click();
    await expect(p).toHaveURL(/\/login$/);
    await expect(p.getByTestId('session-ended')).toBeVisible();
    await uiLogin(p, orgSlug, 'live.user@example.test');
    await expect(p.getByTestId('error-summary')).toBeVisible(); // login refused while deactivated

    // Reactivate: the user can sign in again
    await page
      .getByTestId('staff-item')
      .filter({ hasText: 'Live User' })
      .getByRole('button', { name: 'Reactivate account for Live User' })
      .click();
    await page.getByRole('button', { name: 'Confirm reactivate Live User' }).click();
    await expect(page.getByTestId('active-staff')).toContainText('Live User');
    await uiLogin(p, orgSlug, 'live.user@example.test');
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('Administration');
    await ctx.close();
  });

  test('a facility_admin cannot deactivate accounts (no control, and the API refuses)', async ({
    page,
    browser,
  }) => {
    const { fid } = await seedFacility(page);
    const { ctx, p } = await inviteAndAccept(
      page,
      browser,
      fid,
      'fadmin@example.test',
      'Facility Admin',
      'facility_admin',
    );
    const victim = await page.request.post(`/api/v1/facilities/${fid}/invitations`, {
      headers: CSRF,
      data: { email: 'v@example.test', role: 'staff_reception' },
    });
    expect(victim.status()).toBe(201);
    await p.getByRole('link', { name: 'Refinement Clinic' }).click();
    await p.getByRole('link', { name: 'Staff', exact: true }).click();
    await expect(p.getByTestId('active-staff')).toContainText('Facility Admin');
    await expect(p.getByRole('button', { name: /Deactivate account/ })).toHaveCount(0);
    await expect(p.getByText('Only organization administrators can deactivate')).toBeVisible();
    const id = await p.evaluate(async () => {
      const r = await fetch('/api/v1/auth/me');
      return ((await r.json()) as { user: { id: string } }).user.id;
    });
    const res = await p.request.patch(`/api/v1/staff/${id}`, {
      headers: CSRF,
      data: { status: 'inactive' },
    });
    expect(res.status()).toBe(403);
    await ctx.close();
  });

  test('role revocation reaches a signed-in user and the UI returns them to a safe state', async ({
    page,
    browser,
  }) => {
    const { fid } = await seedFacility(page);
    const { ctx, p } = await inviteAndAccept(
      page,
      browser,
      fid,
      'rr@example.test',
      'Role Revoked',
      'facility_admin',
    );
    await p.getByRole('link', { name: 'Refinement Clinic' }).click();
    await p.getByRole('link', { name: 'Services', exact: true }).click();
    await expect(p.getByRole('button', { name: 'Add service' })).toBeVisible();

    await page.goto(`/admin/facilities/${fid}/staff`);
    await page
      .getByTestId('staff-item')
      .filter({ hasText: 'Role Revoked' })
      .getByRole('button', { name: /Remove Facility administrator from Role Revoked/ })
      .click();
    await expect(page.getByTestId('toast')).toContainText('removed from Role Revoked');

    // Server-side the write is refused immediately even though the page still shows the old controls
    const forged = await p.request.post(`/api/v1/facilities/${fid}/services`, {
      headers: CSRF,
      data: { name: 'Should Fail' },
    });
    expect(forged.status()).toBe(404); // no remaining role at this facility
    await p.reload();
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('Facility not found');
    await ctx.close();
  });
});

test.describe('@responsive desktop layout uses the available width', () => {
  test('two columns on wide screens, single column on narrow screens, never overflowing', async ({
    page,
  }) => {
    const { fid } = await seedFacility(page);
    for (const path of [
      `/admin/facilities/${fid}/services`,
      `/admin/facilities/${fid}/counters`,
      `/admin/facilities/${fid}/staff`,
      `/admin/facilities/${fid}`,
      '/admin',
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText(/^Loading/)).toHaveCount(0);
      const vw = page.viewportSize()?.width ?? 0;
      const main = await page.locator('.split-main').first().boundingBox();
      const side = await page.locator('.split-side').first().boundingBox();
      expect(main && side, `columns exist on ${path}`).toBeTruthy();
      if (vw >= 1024) {
        expect(side!.x, `side column sits right of main on ${path}`).toBeGreaterThan(
          main!.x + main!.width - 1,
        );
        expect(Math.abs(side!.y - main!.y), `columns top-aligned on ${path}`).toBeLessThan(40);
      } else {
        expect(side!.y, `stacked on ${path}`).toBeGreaterThan(main!.y + main!.height - 1);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
      ).toBe(false);
    }
  });

  test('content fills the viewport up to the 80rem container (no narrow fixed column)', async ({
    page,
  }) => {
    await apiSignup(page.request);
    await page.goto('/admin');
    const vw = page.viewportSize()?.width ?? 0;
    const w = (await page.locator('#main').boundingBox())?.width ?? 0;
    // Container is capped at 1280px; below that it must use (nearly) the whole viewport
    expect(w).toBeGreaterThan(Math.min(vw, 1280) - 40);
    if (vw >= 1400) expect(w).toBeGreaterThan(1200);
  });
});
