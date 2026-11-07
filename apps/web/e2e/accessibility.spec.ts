import { expect, test, type Page } from '@playwright/test';
import {
  apiFacility,
  apiSignup,
  expectNoA11yViolations,
  hasHorizontalOverflow,
  uid,
  uiLogin,
} from './helpers.js';

/** Group 11 (M1 scope): keyboard operability, landmarks, live regions, contrast, responsive layout. */

async function seededFacility(
  page: Page,
): Promise<{ facilityId: string; orgSlug: string; email: string }> {
  const org = await apiSignup(page.request, 'A11y Org');
  const fac = await apiFacility(page.request, 'Accessible Clinic');
  const csrf = { 'X-QB-CSRF': '1' };
  const svc = await page.request.post(`/api/v1/facilities/${fac.id}/services`, {
    headers: csrf,
    data: { name: 'Registration' },
  });
  const sid = ((await svc.json()) as { service: { id: string } }).service.id;
  const ctr = await page.request.post(`/api/v1/facilities/${fac.id}/counters`, {
    headers: csrf,
    data: { name: 'Desk 1' },
  });
  const cid = ((await ctr.json()) as { counter: { id: string } }).counter.id;
  await page.request.post('/api/v1/counter_service_capabilities', {
    headers: csrf,
    data: { counter_id: cid, service_id: sid },
  });
  await page.request.post(`/api/v1/facilities/${fac.id}/invitations`, {
    headers: csrf,
    data: { email: 'pending.person@example.test', role: 'staff_reception' },
  });
  return { facilityId: fac.id, orgSlug: org.slug, email: org.email };
}

test('every M1 screen has no WCAG 2.1 A/AA violations (axe)', async ({ page }) => {
  for (const path of ['/', '/signup', '/login']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoA11yViolations(page);
  }
  const { facilityId } = await seededFacility(page);
  for (const path of [
    '/admin',
    `/admin/facilities/${facilityId}`,
    `/admin/facilities/${facilityId}/services`,
    `/admin/facilities/${facilityId}/counters`,
    `/admin/facilities/${facilityId}/staff`,
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText(/^Loading/)).toHaveCount(0);
    await expectNoA11yViolations(page);
  }
});

test('error states are accessible too (axe on validation errors)', async ({ page }) => {
  await page.goto('/signup');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByTestId('error-summary')).toBeVisible();
  await expectNoA11yViolations(page);
  // Inline field error is programmatically associated with its input
  const email = page.getByLabel('Your email');
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  const describedBy = await email.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`#${describedBy}`)).toContainText(/email/i);
});

test('signup and facility creation are completable with the keyboard alone', async ({ page }) => {
  const slug = uid('kbd');
  await page.goto('/signup');
  // Skip link is the first tab stop and works
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();

  await page.getByLabel('Organization name').focus();
  await page.keyboard.type('Keyboard Org');
  await page.keyboard.press('Tab'); // address (auto-filled)
  await page.keyboard.press('Control+A');
  await page.keyboard.type(slug);
  await page.keyboard.press('Tab');
  await page.keyboard.type('Kay Board');
  await page.keyboard.press('Tab');
  await page.keyboard.type(`${slug}@example.test`);
  await page.keyboard.press('Tab');
  await page.keyboard.type('correct-horse-battery-1');
  await page.keyboard.press('Enter'); // submit from the last field
  await expect(page).toHaveURL(/\/admin$/);
  // Focus moved to the new page's main landmark after navigation
  await expect(page.locator('#main')).toBeFocused();

  await page.getByLabel('Facility name').focus();
  await page.keyboard.type('Keyboard Clinic');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('status')).toHaveText('Facility Keyboard Clinic created.');
  await page.getByRole('link', { name: 'Keyboard Clinic' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Keyboard Clinic');
});

test('status changes are announced through a polite live region', async ({ page }) => {
  const { facilityId } = await seededFacility(page);
  await page.goto(`/admin/facilities/${facilityId}/counters`);
  const live = page.getByRole('status').filter({ hasText: /./ });
  await expect(page.getByTestId('status')).toHaveAttribute('aria-live', 'polite');
  await page.getByRole('checkbox', { name: 'Registration' }).uncheck();
  await expect(live).toHaveText('Desk 1 no longer serves Registration.');
});

test('status is never conveyed by colour alone', async ({ page }) => {
  const { facilityId } = await seededFacility(page);
  await page.goto(`/admin/facilities/${facilityId}/services`);
  const item = page.getByTestId('service-item').first();
  await expect(item).toContainText('Active'); // textual status
  await item.getByRole('button', { name: /Deactivate/ }).click();
  await expect(item).toContainText('Inactive');
});

test('respects reduced motion and offers a print-safe QR page', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { facilityId } = await seededFacility(page);
  await page.goto(`/admin/facilities/${facilityId}`);
  const dur = await page.evaluate(() => getComputedStyle(document.body).transitionDuration);
  expect(['0s', '0.001s', '0s, 0s']).toContain(dur);
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('join-qr')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
});

test.describe('@responsive layout on narrow viewports', () => {
  test('no horizontal scrolling and no axe violations on key screens', async ({ page }) => {
    const { facilityId, orgSlug, email } = await seededFacility(page);
    // Fresh session through the UI at this viewport
    await page.context().clearCookies();
    await uiLogin(page, orgSlug, email);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Administration');

    const screens = [
      '/admin',
      `/admin/facilities/${facilityId}`,
      `/admin/facilities/${facilityId}/services`,
      `/admin/facilities/${facilityId}/counters`,
      `/admin/facilities/${facilityId}/staff`,
    ];
    for (const path of screens) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText(/^Loading/)).toHaveCount(0);
      expect(await hasHorizontalOverflow(page), `overflow on ${path}`).toBe(false);
      await expectNoA11yViolations(page);
    }
    for (const path of ['/', '/signup', '/login']) {
      await page.context().clearCookies();
      await page.goto(path);
      expect(await hasHorizontalOverflow(page), `overflow on ${path}`).toBe(false);
    }
  });

  test('touch targets are at least 44×44 CSS px for primary controls', async ({ page }) => {
    await page.goto('/signup');
    for (const locator of [
      page.getByRole('button', { name: 'Create organization' }),
      page.getByLabel('Organization name'),
      page.getByLabel('Password'),
    ]) {
      const box = await locator.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });
});
