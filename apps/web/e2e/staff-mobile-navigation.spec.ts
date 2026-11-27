import { expect, test } from '@playwright/test';
import { apiQueueSetup } from './helpers.js';

test('staff mobile menu, channel spacing and document scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const s = await apiQueueSetup(page.request);
  await page.goto('/admin/facilities/' + s.facility.id + '/channels');
  const menu = page.getByRole('button', { name: 'Menu' });
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeHidden();
  await menu.click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  const usage = page.getByTestId('sms-usage');
  await expect(usage).toBeVisible();
  expect(
    await usage.evaluate(
      (el) =>
        el.getBoundingClientRect().top - el.previousElementSibling!.getBoundingClientRect().bottom,
    ),
  ).toBeGreaterThan(0);
  for (const path of ['/staff/facilities/' + s.facility.id + '/connectivity', s.joinPath]) {
    await page.goto(path);
    await expect(page.locator('main h1')).toBeVisible();
    expect(await page.locator('.app-shell').evaluate((el) => getComputedStyle(el).overflowY)).toBe(
      'visible',
    );
  }
});

test('password can be shown and hidden without clearing or submitting', async ({ page }) => {
  await page.goto('/login');
  const field = page.locator('input[name=password]');
  await field.fill('local-example-only');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(field).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide password' }).click();
  await expect(field).toHaveAttribute('type', 'password');
  await expect(field).toHaveValue('local-example-only');
});
