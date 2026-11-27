import { expect, test } from '@playwright/test';

test('a delayed recovery page receives the scrubbed fragment on first render', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/RecoverPage-*.js', async (route) => {
    await gate;
    await route.continue();
  });
  const requested = page.waitForRequest('**/RecoverPage-*.js');
  try {
    await page.goto('/recover#k=synthetic-delay-key', { waitUntil: 'commit' });
    await requested;
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    await expect(page.locator('body')).not.toContainText('synthetic-delay-key');
  } finally {
    release();
  }
  await expect(page.locator('input[type=password]')).toHaveValue('synthetic-delay-key');
});
