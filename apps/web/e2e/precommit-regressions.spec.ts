import { expect, test } from '@playwright/test';
import { apiQueueSetup, hasHorizontalOverflow } from './helpers.js';

for (const failure of [false, true]) {
  test(`facility poster waits for a printable matrix (encoder failure: ${failure})`, async ({
    page,
  }) => {
    const s = await apiQueueSetup(page.request);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/qr-*.js', async (route) => {
      await gate;
      if (failure) await route.abort();
      else await route.continue();
    });
    await page.addInitScript(() => {
      window.print = () => {
        document.documentElement.dataset['printed'] = 'yes';
      };
    });
    await page.goto(`/admin/facilities/${s.facility.id}`);
    const print = page.getByRole('button', { name: 'Print', exact: true });
    try {
      await expect(page.getByText('Preparing QR code…')).toBeVisible();
      await expect(print).toBeDisabled();
      await print.evaluate((el) => (el as HTMLButtonElement).click());
      await expect(page.locator('html')).not.toHaveAttribute('data-printed', 'yes');
      await expect(page.getByRole('button', { name: 'Copy link' })).toBeEnabled();
    } finally {
      release();
    }
    if (failure) {
      await expect(page.getByText('QR code unavailable.')).toBeVisible();
      await expect(print).toBeDisabled();
      await expect(page.getByRole('link', { name: 'Download QR (SVG)' })).toHaveCount(0);
    } else {
      await expect(page.getByTestId('join-qr')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Download QR (SVG)' })).toBeVisible();
      await print.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('html')).toHaveAttribute('data-printed', 'yes');
    }
  });
}

test('overflow inside the shell is detected while the document fits', async ({ page }) => {
  await page.goto('/recover');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await hasHorizontalOverflow(page)).toBe(false);
  await page.locator('.app-shell').evaluate((shell) => {
    const child = document.createElement('div');
    child.style.width = shell.clientWidth + 100 + 'px';
    shell.append(child);
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(await hasHorizontalOverflow(page)).toBe(true);
});

test('failed recovery import retries with the in-memory fragment and refresh clears it', async ({
  page,
}) => {
  const key = 'synthetic-test-key';
  await page.route('**/RecoverPage-*.js', (route) => route.abort(), { times: 1 });
  await page.goto('/recover#k=' + key);
  await expect(page.getByRole('heading', { name: 'This page could not load' })).toBeFocused();
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.locator('body')).not.toContainText(key);
  await page.getByRole('button', { name: 'Try again' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('input[type=password]')).toHaveValue(key);
  expect(new URL(page.url()).hash).toBe('');
  await page.reload();
  await expect(page.locator('input[type=password]')).toHaveValue('');
});
