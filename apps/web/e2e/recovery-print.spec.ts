import {
  expect,
  firefox,
  test,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Page,
} from '@playwright/test';
import { apiQueueSetup, type QueueSetup } from './helpers.js';

/**
 * Manual check 3 (2026-11-15) failed: **Print** on the recovery-key panel opened the print preview
 * but the key was not in it. These tests check what the print rendering contains, not that
 * `window.print()` was called: with print media emulated they read the text the engine renders
 * (`innerText` follows the print stylesheet) and which elements are laid out.
 *
 * Expected (manual check 3): ticket code and key text only; buttons, hints, QR and site header
 * not printed. Run in Chromium (the project browser) and, when installed, WebKit and Firefox.
 *
 * No secret in any output: every check on a value that holds the key is a boolean or a count with
 * a message, and the on-failure trace is off (it would store page snapshots).
 */
test.use({ trace: 'off' });

type Setup = QueueSetup & { queueId: string | null };

const BUTTON_LABELS = [
  'Copy key',
  'Share key',
  'Save as file',
  'Print',
  'Show QR code',
  'Hide QR code',
  'I have saved my key',
];

/** `window.print()` replaced by a counter: the native dialog would block a headless page. */
async function visitor(
  browser: Browser,
  baseURL: string,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ serviceWorkers: 'block', baseURL });
  await ctx.addInitScript(() => {
    const w = window as unknown as { __printCalls: number };
    w.__printCalls = 0;
    window.print = (): void => {
      w.__printCalls += 1;
    };
  });
  return { ctx, page: await ctx.newPage() };
}

async function checkPrint(browser: Browser, s: Setup, baseURL: string): Promise<void> {
  const v = await visitor(browser, baseURL);
  const { page } = v;
  await page.goto(s.joinPath);
  await page.getByRole('button', { name: /Get a ticket/ }).click();
  await expect(page.getByTestId('recovery-key-panel')).toBeVisible();
  const shown = (await page.getByTestId('recovery-key-text').innerText()).toUpperCase();
  const grouped = /(?:[0-9A-Z]{4}-){7}[0-9A-Z]{4}/.exec(shown)?.[0] ?? '';
  expect(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/.test(grouped), 'key panel shows 8 groups of 4').toBe(
    true,
  );
  const code = (await page.getByTestId('ticket-code').innerText()).trim();
  // the QR is open as well: it must not be printed (the paper carries the readable key)
  await page.getByRole('button', { name: 'Show QR code' }).click();
  await expect(page.getByTestId('recovery-qr')).toBeVisible();

  const urlBefore = page.url();
  const storageBefore = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
  );
  const requests: string[] = [];
  page.on('request', (r) => requests.push(`${r.url()} ${r.postData() ?? ''}`));

  await page.getByRole('button', { name: 'Print' }).click();
  expect(
    await page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls),
    'Print opens the browser print dialog once',
  ).toBe(1);

  await page.emulateMedia({ media: 'print' });
  const printed = (await page.evaluate(() => document.body.innerText)).toUpperCase();
  // The complete key, as shown on screen, and the ticket code are in the print rendering
  expect(printed.includes(grouped), 'printed page contains the complete recovery key').toBe(true);
  expect(printed.includes(code.toUpperCase()), 'printed page contains the ticket code').toBe(true);
  expect(await page.getByTestId('recovery-key-text').isVisible(), 'key laid out in print').toBe(
    true,
  );
  const box = await page.getByTestId('recovery-key-text').boundingBox();
  expect((box?.width ?? 0) > 0 && (box?.height ?? 0) > 0, 'key has a printed area').toBe(true);

  // Nothing else: no button, link, QR, hint, site header or other ticket-page section
  const visibleButtons = await page
    .locator('button')
    .evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).length);
  expect(visibleButtons, 'no button printed').toBe(0);
  const visibleLinks = await page
    .locator('a')
    .evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).length);
  expect(visibleLinks, 'no link printed').toBe(0);
  for (const label of BUTTON_LABELS) {
    expect(printed.includes(label.toUpperCase()), `"${label}" not printed`).toBe(false);
  }
  expect(await page.getByTestId('recovery-qr').isVisible(), 'QR not printed').toBe(false);
  expect(await page.locator('.site-header').isVisible(), 'site header not printed').toBe(false);
  expect(await page.getByTestId('ticket-state').isVisible(), 'status card not printed').toBe(false);
  expect(printed.includes('SKIP TO MAIN CONTENT'), 'skip link not printed').toBe(false);
  expect(printed.includes('KEEP THIS PRIVATE'), 'privacy note printed').toBe(true);
  // Chromium can produce the real print output: the key sheet is a single page (the hidden page
  // content leaves no blank pages behind). The PDF is kept in memory only.
  if (browser.browserType().name() === 'chromium') {
    const pdf = (await page.pdf({ format: 'A4' })).toString('latin1');
    const pages = pdf.match(/\/Type\s*\/Page(?!s)/g)?.length ?? 0;
    expect(pages, 'key sheet prints on one page').toBe(1);
  }

  // Printing changes nothing else: no request, no address or storage change carries the key, and
  // the one-time panel is still on screen afterwards (dismissal stays the visitor's choice)
  const compact = grouped.replace(/-/g, '');
  const carries = (h: string): boolean =>
    [grouped, compact].some((k) => h.toUpperCase().includes(k));
  expect(requests.filter(carries).length, 'secret found in a request').toBe(0);
  expect(page.url() === urlBefore, 'address unchanged by printing').toBe(true);
  const storageAfter = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
  );
  expect(carries(storageAfter), 'secret found in storage').toBe(false);
  expect(storageAfter === storageBefore, 'storage unchanged by printing').toBe(true);
  const rootAttributes = await page.evaluate(() =>
    [...document.documentElement.attributes, ...document.body.attributes]
      .map((a) => a.value)
      .join(' '),
  );
  expect(carries(rootAttributes), 'secret found in a document attribute').toBe(false);

  await page.emulateMedia({ media: 'screen' });
  await expect(page.getByTestId('recovery-key-panel')).toBeVisible();
  expect(
    await page.getByRole('button', { name: 'Print' }).isVisible(),
    'buttons back on screen',
  ).toBe(true);
  // the print-only heading is not shown on screen
  expect(await page.getByTestId('recovery-print-heading').isVisible()).toBe(false);

  // after "I have saved my key" the page prints as before: no key anywhere
  await page.getByRole('button', { name: 'I have saved my key' }).click();
  await expect(page.getByTestId('recovery-key-panel')).toHaveCount(0);
  await page.emulateMedia({ media: 'print' });
  const after = await page.evaluate(() => document.body.innerText);
  expect(carries(after), 'key not printed once dismissed').toBe(false);
  await v.ctx.close();
}

test.describe('manual check 3: Print on the recovery-key panel prints the key', () => {
  test('Chromium: the print rendering contains the ticket code and the complete key, and nothing else', async ({
    page,
    browser,
    baseURL,
  }) => {
    const s: Setup = await apiQueueSetup(page.request);
    await checkPrint(browser, s, baseURL ?? '');
  });

  for (const [name, engine] of [
    ['WebKit', webkit],
    ['Firefox', firefox],
  ] as [string, BrowserType][]) {
    test(`${name}: the same print rendering`, async ({ page, baseURL }) => {
      let other: Browser | null = null;
      try {
        other = await engine.launch();
      } catch {
        test.skip(true, `${name} is not installed on this machine`);
      }
      if (!other) return;
      try {
        const s: Setup = await apiQueueSetup(page.request);
        await checkPrint(other, s, baseURL ?? '');
      } finally {
        await other.close();
      }
    });
  }
});
