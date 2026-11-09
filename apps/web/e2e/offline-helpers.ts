import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { uuidv7 } from '@queuebridge/contracts';
import { PASSWORD, uid } from './helpers.js';

const CSRF = { 'X-QB-CSRF': '1' };

export interface Persona {
  ctx: BrowserContext;
  page: Page;
  userId: string;
  email: string;
}

/** Invite a staff member through the real API and sign them in inside a fresh browser context. */
export async function makeStaff(
  browser: Browser,
  admin: APIRequestContext,
  facilityId: string,
  role: string,
  opts: {
    serviceWorkers?: 'allow' | 'block';
    viewport?: { width: number; height: number } | null;
  } = {},
): Promise<Persona> {
  const email = `${role}-${uid('u')}@example.test`;
  const inv = await admin.post(`/api/v1/facilities/${facilityId}/invitations`, {
    headers: CSRF,
    data: { email, role },
  });
  expect(inv.status()).toBe(201);
  const { token } = (await inv.json()) as { token: string };
  const ctx = await browser.newContext({
    serviceWorkers: opts.serviceWorkers ?? 'block',
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
  });
  const page = await ctx.newPage();
  const acc = await page.request.post('/api/v1/invitations/accept', {
    headers: CSRF,
    data: { token, display_name: `Staff ${role}`, password: PASSWORD },
  });
  expect(acc.status()).toBe(201);
  const { user } = (await acc.json()) as { user: { id: string } };
  return { ctx, page, userId: user.id, email };
}

/** The device id the app stored in IndexedDB, or null (never creates the database itself). */
async function readDeviceId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === 'queuebridge-offline')) return null;
    return new Promise<string | null>((resolve) => {
      const open = indexedDB.open('queuebridge-offline');
      open.onerror = (): void => resolve(null);
      open.onsuccess = (): void => {
        const db = open.result;
        if (!db.objectStoreNames.contains('kv')) {
          db.close();
          resolve(null);
          return;
        }
        const req = db.transaction('kv').objectStore('kv').getAll();
        req.onsuccess = (): void => {
          const rec = (req.result as { key: string; value: unknown }[]).find((r) =>
            r.key.startsWith('device:'),
          );
          db.close();
          resolve(rec ? String(rec.value) : null);
        };
        req.onerror = (): void => {
          db.close();
          resolve(null);
        };
      };
    });
  });
}

/** Wait until the console has registered this browser as a device (stored in IndexedDB). */
export async function waitForDevice(page: Page): Promise<string> {
  let id: string | null = null;
  await expect
    .poll(
      async () => {
        id = await readDeviceId(page);
        return id;
      },
      { timeout: 15_000 },
    )
    .not.toBeNull();
  // ...and until the console itself has picked it up (offline actions need it in memory)
  await expect(page.locator('[data-device-ready="true"]')).toHaveCount(1);
  return id as unknown as string;
}

/** Operations currently stored in IndexedDB (for asserting durability). */
export async function storedOperations(page: Page): Promise<{ status: string; action: string }[]> {
  return page.evaluate(
    () =>
      new Promise<{ status: string; action: string }[]>((resolve, reject) => {
        const open = indexedDB.open('queuebridge-offline');
        open.onerror = (): void => reject(new Error('open failed'));
        open.onsuccess = (): void => {
          const db = open.result;
          if (!db.objectStoreNames.contains('operations')) {
            db.close();
            resolve([]);
            return;
          }
          const req = db.transaction('operations').objectStore('operations').getAll();
          req.onsuccess = (): void => {
            db.close();
            resolve(req.result as { status: string; action: string }[]);
          };
          req.onerror = (): void => {
            db.close();
            reject(new Error('read failed'));
          };
        };
      }),
  );
}

export const op = (): string => uuidv7();
