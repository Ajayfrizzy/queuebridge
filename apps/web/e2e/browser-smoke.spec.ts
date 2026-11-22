import { expect, test } from '@playwright/test';
import { apiQueueSetup, expectNoA11yViolations, hasHorizontalOverflow } from './helpers.js';

test('landing, theme, keyboard help and sign-up entry', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const settings = page.getByTestId('open-display-settings').first();
  await settings.click();
  await page.getByLabel('Theme').selectOption({ label: 'Dark' });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const launcher = page.getByRole('button', { name: 'Ask Que', exact: true });
  await launcher.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByTestId('que-panel');
  await expect(panel).toBeVisible();
  await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(launcher).toBeFocused();
  expect(await hasHorizontalOverflow(page)).toBe(false);
  await page.locator('.hero a[href="/signup"]').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your organization');
  await expectNoA11yViolations(page);
});

test('visitor joins, recovers in a fresh browser context and sees the staff call', async ({
  page,
  request,
  browser,
  viewport,
}) => {
  const setup = await apiQueueSetup(request);
  await page.goto(setup.joinPath);
  await page.getByRole('button', { name: /Get a ticket/ }).click();
  await expect(page.getByTestId('ticket-code')).toHaveText('G001');
  const text = await page.getByTestId('recovery-key-text').innerText();
  const key = /(?:[0-9A-Z]{4}-){7}[0-9A-Z]{4}/.exec(text)?.[0];
  expect(key).toBeTruthy();
  const baseURL = new URL(page.url()).origin;
  const recovered = await browser.newContext({ baseURL, viewport, serviceWorkers: 'block' });
  const staff = await browser.newContext({
    baseURL,
    viewport,
    storageState: await request.storageState(),
    serviceWorkers: 'block',
  });
  try {
    const ticket = await recovered.newPage();
    await ticket.goto(`/recover/${setup.org.slug}/${setup.facility.slug}/G001#k=${key}`);
    await expect(ticket.getByTestId('ticket-state')).toHaveText('Waiting');
    expect(new URL(ticket.url()).hash).toBe('');
    const consolePage = await staff.newPage();
    await consolePage.goto(`/staff/queues/${setup.queueId}`);
    await expect(consolePage.getByTestId('waiting-list')).toContainText('G001');
    await consolePage.getByRole('button', { name: 'Call next' }).click();
    await expect(consolePage.getByTestId('current-code')).toHaveText('G001');
    await expect(ticket.getByTestId('turn-alert')).toContainText('Counter 1');
    await expect(ticket.getByTestId('ticket-state')).toHaveText('Called');
  } finally {
    await recovered.close();
    await staff.close();
  }
});
