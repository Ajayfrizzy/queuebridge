import { expect, test, type Page } from '@playwright/test';

/**
 * M5.4: the REAL generated service worker (`sw.js` → `importScripts('push-handler.js')`) receives
 * a push delivered by Chromium itself (DevTools `ServiceWorker.deliverPushMessage`), with no push
 * service involved (testing steering 14.6). This proves the production handler is wired into the
 * built service worker and hands a push to the focused page, which shows it.
 *
 * Limits, stated: headless Chromium reports the page as focused and keeps notification permission
 * `denied`, so the system-notification branch (tag, `renotify`, click) cannot run here; it is
 * covered against the same file by src/lib/pushHandler.test.ts and by the manual real-device
 * checks in docs/testing/M5-evidence.md. Nothing here proves delivery by a real push service.
 */
test.use({ serviceWorkers: 'allow' });

const REF = '0193a1b2-0000-4000-8000-0000000000c1';
const payload = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({
    v: 2,
    type: 'ticket.called',
    ref: REF,
    code: 'A012',
    counter: 'Counter 2',
    seq: 41,
    rp: '/recover/acme/city-clinic/A012',
    ts: '2026-11-12T10:00:00Z',
    ...o,
  });

async function deliver(page: Page, data: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const origin = new URL(page.url()).origin;
  const registration = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
      const r = e.registrations.find((x) => x.scopeURL.startsWith(origin) && !x.isDeleted);
      if (r) resolve(r.registrationId);
    });
  });
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin,
    registrationId: await registration,
    data,
  });
}

test('the built service worker hands a push to the focused page; a malformed push hands nothing', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const w = window as unknown as { __msgs: unknown[] };
    w.__msgs = [];
    navigator.serviceWorker.addEventListener('message', (e) => w.__msgs.push(e.data));
  });
  // this page shows no ticket with that reference: the app shows the non-blocking notice
  await deliver(page, payload());
  const notice = page.getByTestId('push-handoff-notice');
  await expect(notice).toContainText('An alert arrived for ticket A012 (Counter 2)');
  await expect(notice.getByRole('link', { name: 'Open ticket A012' })).toHaveAttribute(
    'href',
    `/ticket/A012?ref=${REF}`,
  );
  const msgs = (): Promise<unknown[]> =>
    page.evaluate(() => (window as unknown as { __msgs: unknown[] }).__msgs);
  expect(await msgs()).toEqual([
    {
      type: 'qb-turn-alert',
      ref: REF,
      code: 'A012',
      seq: 41,
      counter: 'Counter 2',
      rp: '/recover/acme/city-clinic/A012',
    },
  ]);
  // no credential crossed: the message carries the reference and public values only
  expect(JSON.stringify(await msgs())).not.toMatch(/token|secret|endpoint|p256dh|auth/i);
  // a malformed or foreign payload is never handed to the page
  await deliver(page, payload({ v: 1 }));
  await deliver(page, 'not json');
  // a well-formed push after them proves both were processed (in order) and dropped
  await deliver(page, payload({ seq: 42 }));
  await expect.poll(async () => (await msgs()).length).toBe(2);
  expect(((await msgs())[1] as { seq: number }).seq).toBe(42);
});
