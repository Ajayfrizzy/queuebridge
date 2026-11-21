import { expect, test, type Browser, type Page } from '@playwright/test';
import { uuidv7 } from '@queuebridge/contracts';
import { apiQueueSetup, expectNoA11yViolations, hasHorizontalOverflow } from './helpers.js';
import { makeStaff } from './offline-helpers.js';
/**
 * M7.1 design system, branding and responsive redesign (design §14, ADR-014; Groups 11, 15.3,
 * 15.4). Real stack. Every redesigned role screen is checked with axe and for page overflow at
 * 320, 375, 768, 1280 and 1440 px in the light, dark and high-contrast themes, plus large text;
 * the supplied brand assets must resolve through the one manifest; the desktop sidebar must
 * collapse without losing names; and the MQ.5 findings U2 and U5 are exercised in the console.
 */
const CSRF = { 'X-QB-CSRF': '1' };
const WIDTHS = [320, 375, 768, 1280, 1440] as const;
type Setup = Awaited<ReturnType<typeof apiQueueSetup>>;

async function walkIns(page: Page, s: Setup, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const r = await page.request.post(`/api/v1/queues/${s.queueId ?? ''}/walk-ins`, {
      headers: CSRF,
      data: { operation_id: uuidv7() },
    });
    expect(r.status()).toBe(201);
  }
}
async function callNext(page: Page, s: Setup): Promise<void> {
  const r = await page.request.post(`/api/v1/queues/${s.queueId ?? ''}/commands`, {
    headers: CSRF,
    data: { operation_id: uuidv7(), action: 'ticket.call_next', counter_id: s.counterId },
  });
  expect(r.status()).toBe(200);
}
/** A visitor ticket page in its own context (theme and preferences as given). */
async function visitorTicket(
  browser: Browser,
  s: Setup,
  opts: { colorScheme: 'light' | 'dark'; prefs?: Record<string, unknown> | undefined },
): Promise<Page> {
  const ctx = await browser.newContext({ serviceWorkers: 'block', colorScheme: opts.colorScheme });
  if (opts.prefs) {
    await ctx.addInitScript(
      (p) => localStorage.setItem('qb.a11y.v1', JSON.stringify(p)),
      opts.prefs,
    );
  }
  const v = await ctx.newPage();
  await v.goto(s.joinPath);
  await v.getByRole('button', { name: /Get a ticket/ }).click();
  await expect(v.getByTestId('ticket-code')).toBeVisible();
  await v.getByRole('button', { name: 'I have saved my key' }).click();
  return v;
}

async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
}

const THEMES = [
  { name: 'light', colorScheme: 'light', prefs: undefined },
  { name: 'dark', colorScheme: 'dark', prefs: undefined },
  { name: 'high contrast', colorScheme: 'light', prefs: { contrast: 'high' } },
  { name: 'high contrast (dark system)', colorScheme: 'dark', prefs: { contrast: 'high' } },
] as const;

for (const theme of THEMES) {
  test(`${theme.name}: every role screen is axe-clean with no page overflow at 320–1440 px`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    const s = await apiQueueSetup(page.request);
    await walkIns(page, s, 3);
    await callNext(page, s);
    await page.emulateMedia({ colorScheme: theme.colorScheme });
    await page.goto('/');
    if (theme.prefs) {
      await page.evaluate(
        (p) => localStorage.setItem('qb.a11y.v1', JSON.stringify(p)),
        theme.prefs,
      );
    }
    const fid = s.facility.id;
    const screens = [
      '/',
      '/admin',
      `/admin/facilities/${fid}`,
      `/admin/facilities/${fid}/services`,
      `/admin/facilities/${fid}/channels`,
      `/staff/queues/${s.queueId ?? ''}`,
      `/staff/queues/${s.queueId ?? ''}/audit`,
      `/staff/facilities/${fid}/connectivity`,
      s.displayPath,
      s.joinPath,
      '/recover',
    ];
    const visitor = await visitorTicket(browser, s, theme);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of screens) {
        await page.goto(path);
        await settle(page);
        expect(await hasHorizontalOverflow(page), `${path} overflows at ${width}px`).toBe(false);
        await expectNoA11yViolations(page);
      }
      await visitor.setViewportSize({ width, height: 900 });
      await visitor.reload();
      await expect(visitor.getByTestId('ticket-code')).toBeVisible();
      expect(await hasHorizontalOverflow(visitor), `ticket overflows at ${width}px`).toBe(false);
      await expectNoA11yViolations(visitor);
    }
    await visitor.context().close();
  });
}

test('large text (150 %) reflows the redesigned screens without page overflow', async ({
  page,
  browser,
}) => {
  const s = await apiQueueSetup(page.request);
  await walkIns(page, s, 2);
  await page.goto('/');
  await page.evaluate(() =>
    localStorage.setItem('qb.a11y.v1', JSON.stringify({ textSize: 'xlarge' })),
  );
  for (const width of [320, 1280] as const) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/admin', `/staff/queues/${s.queueId ?? ''}`, s.displayPath]) {
      await page.goto(path);
      await settle(page);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
        '24px',
      );
      expect(await hasHorizontalOverflow(page), `${path} at ${width}px`).toBe(false);
    }
  }
  const v = await visitorTicket(browser, s, {
    colorScheme: 'light',
    prefs: { textSize: 'xlarge' },
  });
  await v.setViewportSize({ width: 320, height: 800 });
  expect(await hasHorizontalOverflow(v)).toBe(false);
  await v.context().close();
});

test('the supplied brand assets resolve through the single manifest and the page head', async ({
  page,
  request,
}) => {
  const manifest = (await (await request.get('/manifest.webmanifest')).json()) as {
    theme_color: string;
    icons: { src: string; sizes: string; purpose?: string }[];
  };
  expect(manifest.theme_color).toBe('#102a43');
  expect(manifest.icons.map((i) => i.src)).toEqual([
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/icon-maskable-512.png',
  ]);
  expect(manifest.icons.find((i) => i.purpose === 'maskable')?.sizes).toBe('512x512');
  // from a nested route, every icon the head references resolves
  await page.goto('/staff/queues/00000000-0000-0000-0000-000000000000');
  const hrefs = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLLinkElement>(
        'link[rel~="icon"], link[rel="apple-touch-icon"]',
      ),
    ].map((l) => l.href),
  );
  expect(hrefs.map((h) => new URL(h).pathname).sort()).toEqual([
    '/apple-touch-icon.png',
    '/favicon.ico',
    '/favicon.png',
  ]);
  for (const path of [
    ...hrefs.map((h) => new URL(h).pathname),
    ...manifest.icons.map((i) => i.src),
  ]) {
    const r = await request.get(path);
    expect(r.status(), path).toBe(200);
    expect(r.headers()['content-type'], path).toMatch(/^image\//);
  }
  expect(await page.locator('link[rel="manifest"]').count()).toBe(1);
  // the header mark is the supplied favicon artwork, decorative next to the name
  await expect(page.getByRole('link', { name: 'QueueBridge' }).locator('img')).toHaveAttribute(
    'alt',
    '',
  );
});

test('desktop sidebar: collapses to an icon rail, keeps the link names, widens the content', async ({
  page,
}) => {
  await apiQueueSetup(page.request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/admin');
  await settle(page);
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const toggle = page.getByRole('button', { name: 'Collapse navigation' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const open = await nav.boundingBox();
  const mainOpen = await page.locator('#main').boundingBox();
  expect(open?.x ?? 99).toBeLessThan(1);
  expect(open?.height ?? 0).toBeGreaterThan(300);
  const box = await toggle.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await toggle.click();
  const expandBtn = page.getByRole('button', { name: 'Expand navigation' });
  await expect(expandBtn).toHaveAttribute('aria-expanded', 'false');
  await expect(expandBtn).toBeFocused();
  const closed = await nav.boundingBox();
  expect(closed?.width ?? 999).toBeLessThan(80);
  expect((await page.locator('#main').boundingBox())?.width ?? 0).toBeGreaterThan(
    mainOpen?.width ?? 0,
  );
  // names survive (text is visually hidden, not removed)
  await expect(nav.getByRole('link', { name: 'Staff console' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Administration' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectNoA11yViolations(page);
  await expandBtn.click();
  await expect(page.getByRole('button', { name: 'Collapse navigation' })).toBeVisible();
  // phones: no sidebar and no toggle; the same navigation sits in the header
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.getByRole('button', { name: /navigation/ })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Staff console' })).toBeVisible();
});

test('the public board is distance-readable: navy ground, large identifiers, codes only', async ({
  page,
}) => {
  const s = await apiQueueSetup(page.request);
  await walkIns(page, s, 2);
  await callNext(page, s);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(s.displayPath);
  const board = page.locator('.board');
  await expect(board.getByTestId('now-calling')).toContainText(/\w/);
  expect(await board.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(16, 42, 67)');
  const size = await board
    .locator('.board-code')
    .first()
    .evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  expect(size).toBeGreaterThanOrEqual(80);
  await expectNoA11yViolations(page);
});

test.describe('MQ.5 U2 and U5 in the redesigned console', () => {
  test('U2: a facility administrator can change priority but is not offered "Call out of order"; a supervisor is', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    await walkIns(page, s, 1);
    for (const [role, offered] of [
      ['facility_admin', false],
      ['supervisor', true],
    ] as const) {
      const p = await makeStaff(browser, page.request, s.facility.id, role);
      await p.page.goto(`/staff/queues/${s.queueId ?? ''}`);
      await p.page.getByRole('button', { name: /^Supervisor actions/ }).click();
      const panel = p.page.getByTestId('override-panel');
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('group', { name: 'Call out of order' })).toHaveCount(
        offered ? 1 : 0,
      );
      await p.ctx.close();
    }
  });

  test('U5: counter staff put a waiting ticket on hold; reception is not offered it', async ({
    page,
    browser,
  }) => {
    const s = await apiQueueSetup(page.request);
    await walkIns(page, s, 1);
    const reception = await makeStaff(browser, page.request, s.facility.id, 'staff_reception');
    await reception.page.goto(`/staff/queues/${s.queueId ?? ''}`);
    await expect(reception.page.getByTestId('waiting-list').getByRole('listitem')).toHaveCount(1);
    await expect(reception.page.getByRole('button', { name: /^Put on hold/ })).toHaveCount(0);
    await reception.ctx.close();
    const counter = await makeStaff(browser, page.request, s.facility.id, 'staff_counter');
    await counter.page.goto(`/staff/queues/${s.queueId ?? ''}`);
    const row = counter.page.getByTestId('waiting-list').getByRole('listitem').first();
    const code = (await row.locator('.ticket-row-code').innerText()).trim();
    await row.getByRole('button', { name: `Put on hold ${code}` }).click();
    const held = counter.page.getByRole('region', { name: 'On hold and missed' });
    await expect(held).toContainText(code);
    await expect(counter.page.getByTestId('waiting-list').getByRole('listitem')).toHaveCount(0);
    await counter.ctx.close();
  });
});
