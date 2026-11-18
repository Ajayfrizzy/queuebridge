import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RestrictedKbResponse } from '@queuebridge/contracts';
import { QueHelpClient } from './helpClient.js';
import { PageClock, SAFETY_MARGIN_MS, mergeResponse } from './offlineHelp.js';
import { MemoryRestrictedHelpStore } from './store.js';
import { art, response } from './fixtures.testkit.js';

const USER = '0193a000-0000-7000-8000-0000000000e1';
const OTHER = '0193a000-0000-7000-8000-0000000000e2';
const H = 3600_000;

class FakeClock extends PageClock {
  public t = 1_800_000_000_000;
  public jump = false;
  public constructor() {
    super(
      () => 0,
      () => 0,
    );
  }
  public override now(): number {
    return this.t;
  }
  public override jumped(): boolean {
    return this.jump;
  }
}

function setup(): {
  store: MemoryRestrictedHelpStore;
  clock: FakeClock;
  calls: (string | undefined)[];
  next: { value: unknown | ((known: string | undefined) => unknown) };
  client: QueHelpClient;
} {
  const store = new MemoryRestrictedHelpStore();
  const clock = new FakeClock();
  const calls: (string | undefined)[] = [];
  const next: { value: unknown } = { value: response() };
  const client = new QueHelpClient(
    store,
    async (known) => {
      calls.push(known);
      const v =
        typeof next.value === 'function'
          ? (next.value as (k: string | undefined) => unknown)(known)
          : next.value;
      if (v instanceof Error) throw v;
      return v;
    },
    clock,
  );
  return { store, clock, calls, next, client };
}

const httpError = (status: number): Error => Object.assign(new Error(`HTTP ${status}`), { status });

describe('QueHelpClient (design §11.5.3 invalidation)', () => {
  it('online sign-in stores the server bundle; help is hidden until revalidation finishes', async () => {
    const { client, store, next } = setup();
    let release!: () => void;
    next.value = (): Promise<RestrictedKbResponse> =>
      new Promise((r) => {
        release = (): void => r(response());
      });
    const signing = client.signedIn(USER, true);
    await new Promise((r) => setTimeout(r, 0));
    expect((await client.restrictedHelp(USER)).state).toBe('pending');
    release();
    expect(await signing).toBe('updated');
    const help = await client.restrictedHelp(USER);
    expect(help.state).toBe('valid');
    expect(help.articles.map((a) => a.id)).toEqual(['staff.a.one', 'staff.b.two']);
    expect(store.records.size).toBe(1);
  });

  it('a different user signing in deletes every other user’s help first', async () => {
    const { client, store, clock } = setup();
    await store.put({ ...mergeResponse(null, response({ userId: OTHER }), clock.t)! });
    await client.signedIn(USER, false);
    expect([...store.records.keys()]).toEqual([]);
    await client.signedIn(USER, true);
    expect([...store.records.keys()]).toEqual([USER]);
  });

  it('any 401 deletes all restricted help', async () => {
    const { client, store, next, clock } = setup();
    await client.signedIn(USER, true);
    await store.put({ ...mergeResponse(null, response({ userId: OTHER }), clock.t)! });
    next.value = httpError(401);
    expect(await client.refresh(USER)).toBe('signed_out');
    expect(store.records.size).toBe(0);
  });

  it('confirmed sign-out (purgeAll) deletes everything and stops an in-flight refresh from writing', async () => {
    const { client, store, next } = setup();
    let release!: () => void;
    next.value = (): Promise<RestrictedKbResponse> =>
      new Promise((r) => {
        release = (): void => r(response());
      });
    const refreshing = client.refresh(USER);
    await new Promise((r) => setTimeout(r, 0));
    await client.purgeAll();
    release();
    expect(await refreshing).toBe('superseded');
    expect(store.records.size).toBe(0);
  });

  it('a new role fingerprint replaces the bundle; old articles never survive', async () => {
    const { client, next } = setup();
    await client.signedIn(USER, true);
    next.value = (known: string | undefined): RestrictedKbResponse =>
      // The server answers the incremental request for the NEW roles with an empty delta
      response({
        roleDigest: 'c'.repeat(64),
        articles: known ? [] : [art('staff.c.three')],
        index: [{ id: 'staff.c.three', version: 1 }],
      });
    expect(await client.refresh(USER)).toBe('updated');
    const help = await client.restrictedHelp(USER);
    expect(help.articles.map((a) => a.id)).toEqual(['staff.c.three']);
  });

  it('incremental refresh sends the known versions and keeps unchanged articles', async () => {
    const { client, calls, next } = setup();
    await client.signedIn(USER, true);
    next.value = response({
      articles: [],
      index: [
        { id: 'staff.a.one', version: 1 },
        { id: 'staff.b.two', version: 1 },
      ],
    });
    expect(await client.refresh(USER)).toBe('updated');
    expect(calls).toEqual([undefined, 'staff.a.one:1,staff.b.two:1']);
    expect((await client.restrictedHelp(USER)).articles).toHaveLength(2);
  });

  it('an incomplete delta triggers a full fetch', async () => {
    const { client, calls, next } = setup();
    await client.signedIn(USER, true);
    next.value = (known: string | undefined): RestrictedKbResponse =>
      known
        ? response({ articles: [], index: [{ id: 'staff.new.one', version: 1 }] })
        : response({ articles: [art('staff.new.one')] });
    expect(await client.refresh(USER)).toBe('updated');
    expect(calls.at(-1)).toBeUndefined();
    expect((await client.restrictedHelp(USER)).articles.map((a) => a.id)).toEqual([
      'staff.new.one',
    ]);
  });

  it('a response for another user deletes everything (never stored)', async () => {
    const { client, store, next } = setup();
    next.value = response({ userId: OTHER });
    expect(await client.refresh(USER)).toBe('signed_out');
    expect(store.records.size).toBe(0);
  });

  it('unreachable or failing server: nothing is written, the cached copy follows the offline rules', async () => {
    const { client, store, next, clock } = setup();
    await client.signedIn(USER, true);
    for (const err of [httpError(0), httpError(503), { not: 'a response' }]) {
      next.value = err;
      expect(await client.signedIn(USER, true)).toBe('unavailable');
      expect((await client.restrictedHelp(USER)).state).toBe('valid');
    }
    clock.t += 12 * H - SAFETY_MARGIN_MS;
    expect((await client.restrictedHelp(USER)).state).toBe('expired');
    expect((await client.restrictedHelp(USER)).articles).toEqual([]);
    expect(store.records.size).toBe(1);
  });

  it('offline sign-in uses the cache; a clock rollback hides it until a fresh fetch succeeds', async () => {
    const { client, clock } = setup();
    await client.signedIn(USER, true);
    clock.t += H;
    expect((await client.signedIn(USER, false)) === 'offline').toBe(true);
    expect((await client.restrictedHelp(USER)).state).toBe('valid');
    clock.t -= 30 * 60_000;
    expect((await client.restrictedHelp(USER)).state).toBe('unverifiable');
    clock.t += 2 * H;
    expect((await client.restrictedHelp(USER)).state).toBe('unverifiable');
    expect(await client.refresh(USER)).toBe('updated');
    expect((await client.restrictedHelp(USER)).state).toBe('valid');
  });

  it('a monotonic-clock disagreement hides help', async () => {
    const { client, clock } = setup();
    await client.signedIn(USER, true);
    clock.jump = true;
    expect((await client.restrictedHelp(USER)).state).toBe('unverifiable');
  });
});

describe('change notification (MQ.3 views)', () => {
  it('notifies on pending, update, failure and purge; unsubscribe stops it; a broken view is ignored', async () => {
    const { client, next } = setup();
    let n = 0;
    const off = client.subscribe(() => {
      n++;
    });
    client.subscribe(() => {
      throw new Error('broken view');
    });
    await client.signedIn(USER, true);
    expect(n).toBe(2); // pending, then updated
    next.value = httpError(503);
    await client.refresh(USER);
    expect(n).toBe(3);
    await client.purgeAll();
    expect(n).toBe(4);
    off();
    await client.purgeAll();
    expect(n).toBe(4);
  });
});

describe('D2: the browser never computes the role fingerprint', () => {
  it('no Ask Que browser module hashes anything or derives authorization', () => {
    // Vitest runs with apps/web as the working directory
    const dir = join(process.cwd(), 'src', 'que');
    const files = readdirSync(dir).filter(
      (x) => x.endsWith('.ts') && !x.endsWith('.test.ts') && !x.endsWith('.testkit.ts'),
    );
    expect(files).toContain('helpClient.ts');
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src).not.toMatch(/crypto\.subtle|createHash|sha-?256|digest\(/i);
      // roleDigest is only ever copied from a server response
      for (const m of src.matchAll(/roleDigest\s*[:=]\s*([^,;\n]+)/g)) {
        expect(m[1]).toMatch(/response\.roleDigest|string|record\.roleDigest/);
      }
    }
  });
});
