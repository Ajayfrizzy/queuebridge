import { expect, test, type Page } from '@playwright/test';
import { uuidv7 } from '@queuebridge/contracts';
import { apiQueueSetup, expectNoA11yViolations, hasHorizontalOverflow } from './helpers.js';
/**
 * M7.2 regression: "Display and alerts" and "Ask Que" did nothing when clicked.
 *
 * Root cause (reproduced on the development server, `vite`, React development build): both
 * dialogs open in an effect whose cleanup calls `dialog.close()`. React StrictMode runs effect
 * setup → cleanup → setup once more in development; the cleanup's `close()` queues a `close`
 * event that fires AFTER the second `showModal()`/`show()`, and its `onClose` handler unmounted
 * the freshly reopened dialog. Production builds run effects once, so the preview-based suite
 * never saw it. Fixed by ignoring a `close` event while the dialog is open again.
 *
 * This spec runs in the normal projects (production preview, production CSP) AND in the
 * `dev-strict` project against the development server, where the original failure reproduced.
 * It checks what the person sees: the element at the click point, rendered visibility,
 * focus movement and return.
 */
const CSRF = { 'X-QB-CSRF': '1' };

/** Click the centre of a control after proving nothing covers it (no overlay intercepts). */
async function clickVisible(page: Page, testId: string): Promise<void> {
  const el = page.getByTestId(testId).first();
  await expect(el).toBeVisible();
  const box = await el.boundingBox();
  if (!box) throw new Error(`${testId} has no box`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const hit = await page.evaluate(
    ({ x, y, id }) => {
      const e = document.elementFromPoint(x, y);
      return Boolean(e?.closest(`[data-testid="${id}"]`));
    },
    { x, y, id: testId },
  );
  expect(hit, `${testId} receives the pointer`).toBe(true);
  await page.mouse.click(x, y);
}
async function settingsDialogVisible(page: Page): Promise<void> {
  const d = page.getByTestId('display-settings');
  await expect(d).toBeVisible();
  // still open after the event loop has turned (the original defect closed it immediately)
  await page.waitForTimeout(400);
  await expect(d).toBeVisible();
  expect(await d.evaluate((el) => (el as HTMLDialogElement).open)).toBe(true);
  expect(
    await d.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + 20);
      return Boolean(top && el.contains(top));
    }),
    'the dialog is on top',
  ).toBe(true);
}
async function quePanelVisible(page: Page): Promise<void> {
  const p = page.getByTestId('que-panel');
  await expect(p).toBeVisible();
  await page.waitForTimeout(400);
  await expect(p).toBeVisible();
  await expect(p.getByLabel('Search help')).toBeFocused();
}

for (const scheme of ['light', 'dark'] as const) {
  test(`@responsive @dev ${scheme}: Display and alerts opens from the landing page and works by mouse and keyboard`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await clickVisible(page, 'open-display-settings');
    await settingsDialogVisible(page);
    await expect(page.getByRole('heading', { name: 'Display and alerts', level: 2 })).toBeFocused();
    // Theme, contrast and text size apply at once
    await page.getByLabel('Theme').selectOption({ label: scheme === 'dark' ? 'Light' : 'Dark' });
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      scheme === 'dark' ? 'light' : 'dark',
    );
    await page.getByLabel('Text size').selectOption('large');
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'large');
    await page.getByLabel('Contrast').selectOption('high');
    await expect(page.locator('html')).toHaveAttribute('data-contrast', 'high');
    await expectNoA11yViolations(page);
    // Escape closes and returns focus to the opener
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('display-settings')).toHaveCount(0);
    await expect(page.getByTestId('open-display-settings').first()).toBeFocused();
    // the choice survives a reload
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      scheme === 'dark' ? 'light' : 'dark',
    );
    // keyboard opening, then the Close button
    await page.getByTestId('open-display-settings').first().focus();
    await page.keyboard.press('Enter');
    await settingsDialogVisible(page);
    await page.getByRole('button', { name: /^Close/ }).click();
    await expect(page.getByTestId('display-settings')).toHaveCount(0);
    await expect(page.getByTestId('open-display-settings').first()).toBeFocused();
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });

  test(`@responsive @dev ${scheme}: the floating Ask Que launcher opens help, closes, and can be reopened`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const launcher = page.getByRole('button', { name: 'Ask Que', exact: true });
    await expect(launcher).toHaveCount(1);
    // floating at the bottom right, inside the viewport, a comfortable target, not in the header
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    const box = await launcher.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(vp.width - 8);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(vp.height - 8);
    expect(box?.x ?? 0).toBeGreaterThan(vp.width / 2);
    expect(box?.y ?? 0).toBeGreaterThan(vp.height / 2);
    expect(await launcher.evaluate((b) => b.closest('header'))).toBeNull();
    expect(await launcher.evaluate((b) => getComputedStyle(b).position)).toBe('fixed');
    const mobile = vp.width <= 640;
    for (let round = 0; round < 3; round++) {
      await clickVisible(page, 'ask-que');
      await quePanelVisible(page);
      await expect(page.getByTestId('que-panel')).toHaveAttribute(
        'data-mode',
        mobile ? 'sheet' : 'panel',
      );
      if (!mobile) {
        // the desktop panel opens just above the launcher, which stays visible and uncovered
        const panel = await page.getByTestId('que-panel').boundingBox();
        const l = await launcher.boundingBox();
        expect((panel?.y ?? 0) + (panel?.height ?? 0)).toBeLessThanOrEqual((l?.y ?? 0) + 1);
        expect(
          Math.abs((panel?.x ?? 0) + (panel?.width ?? 0) - ((l?.x ?? 0) + (l?.width ?? 0))),
        ).toBeLessThanOrEqual(2);
        await expectNoA11yViolations(page);
      }
      if (round === 0) {
        await page.keyboard.press('Escape');
      } else if (round === 1) {
        await page.getByRole('button', { name: 'Close Ask Que help' }).click();
      } else {
        await expect(page.getByTestId('que-panel')).toBeVisible();
        await page.getByRole('button', { name: 'Close Ask Que help' }).click();
      }
      await expect(page.getByTestId('que-panel')).toHaveCount(0);
      await expect(launcher).toBeFocused();
      await expect(launcher).toHaveAttribute('aria-expanded', 'false');
    }
    // keyboard: the launcher is reachable and has a visible focus indicator
    await launcher.focus();
    const outline = await launcher.evaluate((b) => {
      const cs = getComputedStyle(b);
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
    await page.keyboard.press('Enter');
    await quePanelVisible(page);
    expect(outline.width).toBeGreaterThanOrEqual(2);
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });
}

test('@responsive the launcher is usable on visitor, staff and admin screens and never covers their last controls', async ({
  page,
  browser,
}) => {
  const s = await apiQueueSetup(page.request);
  await page.request.post(`/api/v1/queues/${s.queueId ?? ''}/walk-ins`, {
    headers: CSRF,
    data: { operation_id: uuidv7() },
  });
  const v = await browser.newContext({
    serviceWorkers: 'block',
    viewport: page.viewportSize() ?? { width: 1280, height: 800 },
  });
  const vp = await v.newPage();
  await vp.goto(s.joinPath);
  await vp.getByRole('button', { name: /Get a ticket/ }).click();
  await expect(vp.getByTestId('ticket-code')).toBeVisible();
  const screens: [Page, string][] = [
    [vp, vp.url()],
    [vp, '/recover'],
    [vp, s.displayPath],
    [page, `/staff/queues/${s.queueId ?? ''}`],
    [page, `/admin/facilities/${s.facility.id}`],
  ];
  for (const [p, path] of screens) {
    await p.goto(path);
    await expect(p.getByRole('heading', { level: 1 })).toBeVisible();
    // scrolled to the end, the page's last focusable control is not under the launcher
    await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const clear = await p.evaluate(() => {
      const l = document.querySelector('[data-testid="ask-que"]')!.getBoundingClientRect();
      const controls = [
        ...document.querySelectorAll<HTMLElement>('main a, main button, main input, main select'),
      ].filter((e) => e.offsetParent !== null);
      const last = controls.at(-1)?.getBoundingClientRect();
      if (!last) return true;
      return !(
        last.right > l.left &&
        last.left < l.right &&
        last.bottom > l.top &&
        last.top < l.bottom
      );
    });
    expect(clear, `${path}: last control clear of the launcher`).toBe(true);
    expect(await hasHorizontalOverflow(p), path).toBe(false);
    await clickVisible(p, 'ask-que');
    await quePanelVisible(p);
    await p.keyboard.press('Escape');
    await expect(p.getByTestId('que-panel')).toHaveCount(0);
  }
  await v.close();
});

test('a failed help chunk load shows a message, and the launcher recovers on the next open', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.route('**/assets/QuePanel-*.js', (r) => r.abort());
  await clickVisible(page, 'ask-que');
  await expect(page.getByTestId('que-unavailable')).toBeVisible();
  // the message sits above the launcher, which stays usable
  const msg = await page.getByTestId('que-unavailable').boundingBox();
  const l = await page.getByTestId('ask-que').boundingBox();
  expect((msg?.y ?? 0) + (msg?.height ?? 0)).toBeLessThanOrEqual((l?.y ?? 0) + 1);
  await page.getByTestId('que-unavailable').getByRole('button', { name: 'Close' }).click();
  await page.unroute('**/assets/QuePanel-*.js');
  await clickVisible(page, 'ask-que');
  await quePanelVisible(page);
});
