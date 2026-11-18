import { expect, test, type Page } from '@playwright/test';
import { uuidv7 } from '@queuebridge/contracts';
import { apiQueueSetup, apiSignup } from './helpers.js';

/**
 * Screenshot capture for visual review. Set CAPTURE=<label> (e.g. before / after) to write
 * full-page screenshots to docs/testing/screenshots/m2-ui/. Runs only when CAPTURE is set.
 */
const CAPTURE = process.env['CAPTURE'];
const SHOT_DIR = '../../docs/testing/screenshots/m2-ui';

async function shot(page: Page, name: string): Promise<void> {
  if (!CAPTURE) return;
  const w = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: `${SHOT_DIR}/${CAPTURE}-${name}-${w}.png`, fullPage: true });
}

test.describe('@responsive visual capture', () => {
  test.skip(!CAPTURE, 'capture only');
  test('M2 screens', async ({ page, browser }) => {
    const s = await apiQueueSetup(page.request);
    // Second open service so the transfer form appears
    const svc2 = await page.request.post(`/api/v1/facilities/${s.facility.id}/services`, {
      headers: { 'X-QB-CSRF': '1' },
      data: { name: 'Laboratory' },
    });
    const svc2Id = ((await svc2.json()) as { service: { id: string } }).service.id;
    await page.request.post(`/api/v1/facilities/${s.facility.id}/queues`, {
      headers: { 'X-QB-CSRF': '1' },
      data: { service_id: svc2Id },
    });

    const visitor = await browser.newContext({
      serviceWorkers: 'block',
      viewport: page.viewportSize() ?? { width: 1280, height: 720 },
    });
    const vp = await visitor.newPage();
    await vp.goto(s.joinPath);
    await expect(vp.getByTestId('join-service').first()).toBeVisible();
    await shot(vp, 'join');
    await vp.getByRole('button', { name: /Get a ticket for General/ }).click();
    await expect(vp.getByTestId('ticket-code')).toHaveText('G001');
    // two more waiting so the list and position are realistic
    for (let i = 0; i < 2; i++) {
      await page.request.post(`/api/v1/queues/${s.queueId}/walk-ins`, {
        headers: { 'X-QB-CSRF': '1' },
        data: { operation_id: uuidv7() },
      });
    }
    await vp.reload();
    await vp.getByText('How this is estimated').click();
    await shot(vp, 'ticket-waiting');

    await page.goto(`/staff/queues/${s.queueId}`);
    await expect(page.getByTestId('waiting-list')).toContainText('G001');
    await shot(page, 'console-idle');
    await page.getByRole('button', { name: 'Call next' }).click();
    await expect(page.getByTestId('current-code')).toHaveText('G001');
    await page.getByRole('button', { name: 'Start serving' }).click();
    await expect(page.getByLabel('Transfer to')).toBeVisible();
    await page.getByRole('button', { name: 'Issue walk-in ticket' }).click();
    await expect(page.getByTestId('walkin-code')).toBeVisible();
    await shot(page, 'console-serving-walkin');

    await expect(vp.getByTestId('ticket-state')).toHaveText('Being served');
    await shot(vp, 'ticket-serving');
    await vp.goto(s.displayPath);
    await expect(vp.getByTestId('now-calling').first()).toContainText('G001');
    await shot(vp, 'board');
    await visitor.close();

    // Header at this width (signed in), cropped to the header area
    if (CAPTURE) {
      await page.goto('/admin');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const w = page.viewportSize()?.width ?? 0;
      await page.screenshot({
        path: `${SHOT_DIR}/${CAPTURE}-header-signedin-${w}.png`,
        clip: { x: 0, y: 0, width: w, height: 200 },
      });
    }

    // M1 admin screens share the card/alert spacing rules: capture for regression review
    for (const [path, name] of [
      [`/admin/facilities/${s.facility.id}`, 'admin-overview'],
      [`/admin/facilities/${s.facility.id}/counters`, 'admin-counters'],
      [`/admin/facilities/${s.facility.id}/staff`, 'admin-staff'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText(/^Loading/)).toHaveCount(0);
      await shot(page, name);
    }
  });
});

// ---------------------------------------------------------------------------
// Permanent layout regression checks (geometry + computed styles, no pixel snapshots)
// ---------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`no box for ${selector}`);
  return b;
}

async function staffConsoleServing(page: Page): Promise<{ joinPath: string; displayPath: string }> {
  const s = await apiQueueSetup(page.request);
  const svc2 = await page.request.post(`/api/v1/facilities/${s.facility.id}/services`, {
    headers: { 'X-QB-CSRF': '1' },
    data: { name: 'Laboratory' },
  });
  const svc2Id = ((await svc2.json()) as { service: { id: string } }).service.id;
  await page.request.post(`/api/v1/facilities/${s.facility.id}/queues`, {
    headers: { 'X-QB-CSRF': '1' },
    data: { service_id: svc2Id },
  });
  for (let i = 0; i < 2; i++) {
    await page.request.post(`/api/v1/queues/${s.queueId}/walk-ins`, {
      headers: { 'X-QB-CSRF': '1' },
      data: { operation_id: uuidv7() },
    });
  }
  await page.goto(`/staff/queues/${s.queueId}`);
  await page.getByRole('button', { name: 'Call next' }).click();
  await page.getByRole('button', { name: 'Start serving' }).click();
  await expect(page.getByLabel('Transfer to')).toBeVisible();
  await page.getByRole('button', { name: 'Issue walk-in ticket' }).click();
  await expect(page.getByTestId('walkin-code')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  return { joinPath: s.joinPath, displayPath: s.displayPath };
}

test.describe('@responsive UI layout consistency', () => {
  test('staff console: separated panels, select gutters, grouped transfer form, QR panel, row actions', async ({
    page,
  }) => {
    await staffConsoleServing(page);

    // 1. Separate panels never touch: every sibling in each column is >= 16px apart
    for (const column of ['.split-main', '.split-side']) {
      const gaps = await page.locator(`${column} > *`).evaluateAll((els) => {
        const visible = els.filter((e) => (e as HTMLElement).offsetHeight > 0);
        return visible
          .slice(1)
          .map(
            (e, i) => e.getBoundingClientRect().top - visible[i]!.getBoundingClientRect().bottom,
          );
      });
      expect(gaps.length, column).toBeGreaterThan(0);
      for (const g of gaps) expect(g, `${column} gap`).toBeGreaterThanOrEqual(16);
    }

    // 2. Every select reserves a gutter for the arrow and keeps the 44px target height
    const selects = await page.locator('select').evaluateAll((els) =>
      els.map((e) => {
        const cs = getComputedStyle(e);
        return {
          pr: parseFloat(cs.paddingRight),
          pl: parseFloat(cs.paddingLeft),
          h: e.getBoundingClientRect().height,
          appearance: cs.appearance,
        };
      }),
    );
    expect(selects.length).toBeGreaterThanOrEqual(3);
    for (const s of selects) {
      expect(s.pr).toBeGreaterThanOrEqual(40);
      expect(s.pr).toBeGreaterThan(s.pl);
      expect(s.h).toBeGreaterThanOrEqual(44);
      expect(s.appearance).toBe('none');
    }

    // 3. Transfer form: grouped in a fieldset, each label sits above its control, all inside
    const fieldset = await box(page, 'form[aria-label^="Transfer"] fieldset');
    for (const id of ['transfer-target', 'transfer-reason']) {
      const label = await box(page, `label[for="${id}"]`);
      const control = await box(page, `#${id}`);
      expect(label.y + label.height, `${id} label above control`).toBeLessThanOrEqual(
        control.y + 1,
      );
      expect(Math.abs(label.x - control.x), `${id} label aligned with control`).toBeLessThanOrEqual(
        2,
      );
      expect(control.x).toBeGreaterThanOrEqual(fieldset.x);
      expect(control.x + control.width).toBeLessThanOrEqual(fieldset.x + fieldset.width + 0.5);
    }
    const transferBtn = await box(page, 'form[aria-label^="Transfer"] button[type="submit"]');
    expect(transferBtn.x + transferBtn.width).toBeLessThanOrEqual(
      fieldset.x + fieldset.width + 0.5,
    );
    expect(await page.getByRole('group', { name: 'Transfer this ticket' }).count()).toBe(1);

    // 4. Walk-in QR panel: QR centred, with clear space above and below
    const panel = await box(page, '[data-testid="walkin-result"]');
    const qr = await box(page, '[data-testid="walkin-result"] svg.qr');
    const leftGap = qr.x - panel.x;
    const rightGap = panel.x + panel.width - (qr.x + qr.width);
    expect(Math.abs(leftGap - rightGap), 'QR centred').toBeLessThanOrEqual(3);
    const textAbove = await box(page, '[data-testid="walkin-result"] p:not(.ticket-code)');
    expect(qr.y - (textAbove.y + textAbove.height), 'space above QR').toBeGreaterThanOrEqual(8);
    const hide = await box(page, '[data-testid="walkin-result"] button');
    expect(hide.y - (qr.y + qr.height), 'space below QR').toBeGreaterThanOrEqual(8);

    // 5. Hierarchy: current ticket is the focal panel; its primary action comes first
    const current = await box(page, '[data-testid="at-counter"]');
    const code = await page
      .getByTestId('current-code')
      .evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    expect(code).toBeGreaterThanOrEqual(40);
    expect(current.width).toBeGreaterThan(200);
    const firstAction = page.getByTestId('at-counter').locator('.btn-row button').first();
    await expect(firstAction).toHaveText('Complete');
    await expect(firstAction).toHaveClass(/btn-primary/);
    await expect(page.getByTestId('waiting-count')).toHaveText('2');

    // 6. Waiting rows: the action stays at the right edge of the row
    const rows = await page.locator('[data-testid="waiting-list"] .ticket-row').evaluateAll((els) =>
      els.map((row) => {
        const r = row.getBoundingClientRect();
        const btn = row.querySelector('button')!.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(row).paddingRight);
        return {
          rowRight: r.right,
          btnRight: btn.right,
          pad,
          btnTop: btn.top,
          rowTop: r.top,
          rowBottom: r.bottom,
        };
      }),
    );
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(
        Math.abs(r.rowRight - r.pad - 1 - r.btnRight),
        'action right-aligned',
      ).toBeLessThanOrEqual(2);
      expect(r.btnTop).toBeGreaterThan(r.rowTop);
    }

    // 7. Visible focus indicator on keyboard focus
    await page.getByTestId('at-counter').locator('.btn-row button').first().focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement as Element);
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
    expect(outline.style).toBe('solid');
    expect(outline.width).toBeGreaterThanOrEqual(3);

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);
  });

  test('forced-colors mode restores the native select arrow', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await staffConsoleServing(page);
    const appearance = await page
      .locator('#counter-select')
      .evaluate((e) => getComputedStyle(e).appearance);
    expect(appearance).toBe('auto');
  });

  test('visitor ticket, join and board use consistent card spacing and aligned toolbars', async ({
    page,
    browser,
  }) => {
    const s = await staffConsoleServing(page);
    const vctx = await browser.newContext({
      serviceWorkers: 'block',
      viewport: page.viewportSize() ?? { width: 1280, height: 720 },
    });
    const v = await vctx.newPage();

    await v.goto(s.joinPath);
    await expect(v.getByTestId('join-service').first()).toBeVisible();
    const cardGaps = await v
      .locator('[data-testid="join-service"]')
      .first()
      .evaluate((card) => {
        const kids = Array.from(card.children).filter((e) => (e as HTMLElement).offsetHeight > 0);
        return kids
          .slice(1)
          .map((e, i) =>
            Math.round(e.getBoundingClientRect().top - kids[i]!.getBoundingClientRect().bottom),
          );
      });
    // one consistent internal rhythm (12px), no stray paragraph margins
    for (const g of cardGaps) expect(g).toBe(12);

    await v.getByRole('button', { name: /Get a ticket for General/ }).click();
    await expect(v.getByTestId('ticket-code')).toBeVisible();
    const stackGaps = await v
      .locator('main .stack > *')
      .evaluateAll((els) =>
        els
          .slice(1)
          .map((e, i) =>
            Math.round(e.getBoundingClientRect().top - els[i]!.getBoundingClientRect().bottom),
          ),
      );
    for (const g of stackGaps) expect(g).toBe(16);

    await v.goto(s.displayPath);
    await expect(v.getByTestId('now-calling').first()).toContainText('G001');
    const live = await box(v, '[data-testid="live-mode"]');
    const toggle = await box(v, '.board .check.inline input');
    const label = await box(v, '.board .check.inline');
    const bar = await box(v, '.board .toolbar-spread > .toolbar');
    const vw = v.viewportSize()!.width;
    // Whether the badge and the toggle share a row depends on font metrics
    // (they wrap on narrow Linux viewports). Either outcome must be deliberate:
    const sameRow = toggle.y < live.y + live.height && live.y < toggle.y + toggle.height;
    if (sameRow) {
      // one row: vertically centred against each other
      expect(
        Math.abs(live.y + live.height / 2 - (toggle.y + toggle.height / 2)),
        'toolbar items aligned',
      ).toBeLessThanOrEqual(6);
    } else {
      // wrapped: the toggle starts a new row flush with the toolbar's start edge,
      // below the badge (no overlap), never indented or floating
      expect(
        Math.abs(label.x - bar.x),
        'wrapped toolbar item aligned to row start',
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(live.x - bar.x),
        'first toolbar item aligned to row start',
      ).toBeLessThanOrEqual(2);
      expect(label.y, 'wrapped toolbar item below first row').toBeGreaterThanOrEqual(
        live.y + live.height,
      );
    }
    for (const b of [live, label]) {
      expect(b.x, 'toolbar item inside viewport').toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, 'toolbar item inside viewport').toBeLessThanOrEqual(vw + 0.5);
    }
    expect(
      await v.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);
    await vctx.close();
  });
});

test.describe('@responsive site header', () => {
  async function headerItems(page: Page): Promise<(Box & { name: string; kind: string })[]> {
    return page
      .locator(
        '.site-header .brand, .site-header nav a, .site-header .header-tools button, .site-header .account .who, .site-header .account button',
      )
      .evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return {
            name: (e.textContent ?? '').trim(),
            kind: e.tagName === 'A' || e.tagName === 'BUTTON' ? 'control' : 'text',
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
          };
        }),
      );
  }

  function overlaps(a: Box, b: Box): boolean {
    return (
      a.x < b.x + b.width - 0.5 &&
      b.x < a.x + a.width - 0.5 &&
      a.y < b.y + b.height - 0.5 &&
      b.y < a.y + a.height - 0.5
    );
  }

  for (const signedIn of [false, true]) {
    test(`${signedIn ? 'signed-in' : 'anonymous'}: no overlap or clipping, 44px targets, deliberate rows, keyboard reachable`, async ({
      page,
    }) => {
      if (signedIn) await apiSignup(page.request, 'Org With A Rather Long Name');
      await page.goto(signedIn ? '/admin' : '/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const vw = page.viewportSize()?.width ?? 0;
      const items = await headerItems(page);
      // M5.2 adds "Display and alerts"; MQ.3 adds "Ask Que" (same checks apply to both)
      expect(items.length).toBe(signedIn ? 7 : 5);

      for (const it of items) {
        expect(it.x, `${it.name} not clipped left`).toBeGreaterThanOrEqual(0);
        expect(it.x + it.width, `${it.name} not clipped right`).toBeLessThanOrEqual(vw + 0.5);
        if (it.kind === 'control' && it.name !== 'QueueBridge') {
          expect(it.height, `${it.name} target height`).toBeGreaterThanOrEqual(44);
        }
      }
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          expect(
            overlaps(items[i]!, items[j]!),
            `${items[i]!.name} overlaps ${items[j]!.name}`,
          ).toBe(false);
        }
      }

      if (vw < 640 && signedIn) {
        const by = (n: string): Box => items.find((x) => x.name.includes(n))!;
        const brand = by('QueueBridge');
        const nav = by('Staff console');
        const admin = by('Administration');
        const who = by('Org Admin');
        const signOut = by('Sign out');
        // Row 1 brand, row 2 navigation (both links on one row), row 3 account (name + button)
        expect(nav.y).toBeGreaterThan(brand.y + brand.height - 1);
        expect(Math.abs(nav.y - admin.y)).toBeLessThanOrEqual(1);
        expect(who.y).toBeGreaterThan(nav.y + nav.height - 1);
        expect(
          Math.abs(who.y + who.height / 2 - (signOut.y + signOut.height / 2)),
        ).toBeLessThanOrEqual(4);
        expect(signOut.x).toBeGreaterThan(who.x); // name left, button right
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
      ).toBe(false);

      // Keyboard: skip link, brand, every nav link and the Sign out button are reachable in order
      // Fresh navigation: sequential focus starts at the top of the document
      await page.goto(signedIn ? '/admin' : '/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
      const expected = signedIn
        ? [
            'QueueBridge',
            'Staff console',
            'Administration',
            'Ask Que',
            'Display and alerts',
            'Sign out',
          ]
        : ['QueueBridge', 'Sign in', 'Create organization', 'Ask Que', 'Display and alerts'];
      for (const name of expected) {
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() =>
          (document.activeElement?.textContent ?? '').trim(),
        );
        expect(focused).toBe(name);
      }
      if (signedIn) {
        await expect(page.getByRole('group', { name: 'Account' })).toContainText('Org Admin');
      }
    });
  }
});
