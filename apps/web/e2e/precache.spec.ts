import { expect, test } from '@playwright/test';
import { apiQueueSetup } from './helpers.js';

test.use({ serviceWorkers: 'allow' });

test('a fresh join install keeps landing assets on demand and restores visited screens offline', async ({
  page,
  context,
  request,
}) => {
  const queue = await apiQueueSetup(request);
  const landingRequests: string[] = [];
  context.on('request', (request) => {
    if (request.serviceWorker() && /\/assets\/(LandingPage|landing-preview)-/.test(request.url())) {
      landingRequests.push(request.url());
    }
  });
  await page.goto(queue.joinPath);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  expect(landingRequests).toEqual([]);
  const precached = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls = await Promise.all(
      names.map(async (name) => (await (await caches.open(name)).keys()).map((r) => r.url)),
    );
    return urls.flat();
  });
  expect(precached.some((url) => url.includes('/assets/StaffConsole-'))).toBe(true);
  expect(precached.some((url) => url.includes('/assets/LandingPage-'))).toBe(false);
  expect(precached.some((url) => url.includes('/assets/landing-preview-'))).toBe(false);
  await page.reload();
  await expect(page.getByRole('button', { name: /Get a ticket/ })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Queues');
  await page.locator('.workspaces').scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const urls = (await (await caches.open('landing-assets')).keys()).map(
          (r) => new URL(r.url).pathname,
        );
        return [
          'LandingPage-.*\\.js',
          'LandingPage-.*\\.css',
          ...['visitor', 'counter', 'facility'].map((key) => 'landing-preview-' + key + '-'),
        ].every((pattern) => urls.some((url) => new RegExp(pattern).test(url)));
      }),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Queues');
  await page.goto(queue.joinPath);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Queue Clinic');
});

test('a visitor can first open the recovery QR offline and reload the saved ticket', async ({
  page,
  request,
  context,
}) => {
  const queue = await apiQueueSetup(request);
  await page.goto(queue.joinPath);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.getByRole('button', { name: /Get a ticket/ }).click();
  await expect(page.getByTestId('ticket-state')).toHaveText('Waiting');
  const show = page.getByRole('button', { name: 'Show QR code' });
  await expect(show).toBeVisible();
  await context.setOffline(true);
  await show.click();
  await expect(page.getByTestId('recovery-qr').getByRole('img')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide QR code' })).toBeFocused();
  await page.reload();
  await expect(page.getByTestId('ticket-code')).toHaveText('G001');
});
