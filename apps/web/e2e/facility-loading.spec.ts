import { expect, test } from '@playwright/test';
import { apiFacility, apiSignup, uiLogin } from './helpers.js';

test('facility list previews stay within the signed-in session', async ({ page, request }) => {
  const first = await apiSignup(request);
  await apiFacility(request, 'First session facility');
  const second = await apiSignup(request);
  await apiFacility(request, 'Second session facility');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const delayList = async (): Promise<() => void> => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      '**/api/v1/facilities',
      async (route) => {
        await gate;
        await route.continue();
      },
      { times: 1 },
    );
    return release;
  };
  let release = await delayList();
  await uiLogin(page, first.slug, first.email);
  await expect(page.getByText('Loading facilities…')).toBeVisible();
  await expect(page.locator('.facility-spinner')).toHaveCSS('animation-name', 'none');
  release();
  await expect(page.getByRole('link', { name: 'First session facility' })).toBeVisible();
  release = await delayList();
  await page.getByRole('link', { name: 'Staff console', exact: true }).click();
  await expect(page.getByText('Updating facilities…')).toBeVisible();
  await expect(page.getByRole('link', { name: 'First session facility' })).toBeVisible();
  release();
  await expect(page.getByText('Updating facilities…')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true }).first()).toBeVisible();
  release = await delayList();
  await uiLogin(page, second.slug, second.email);
  await expect(page.getByText('Loading facilities…')).toBeVisible();
  await expect(page.getByText('First session facility')).toHaveCount(0);
  release();
  await expect(page.getByRole('link', { name: 'Second session facility' })).toBeVisible();
});
