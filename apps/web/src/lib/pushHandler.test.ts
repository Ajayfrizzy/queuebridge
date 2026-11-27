import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { turnAlertTag } from '@queuebridge/contracts';

/**
 * The service-worker turn-alert handler (public/push-handler.js), exercised with in-test doubles
 * for `clients` and `registration` (Group 14: 14.6 client handler, 14.13 identity, 14.14 no
 * credential). The real file is loaded, exactly as `importScripts` loads it.
 */
interface Handler {
  parsePayload: (t: string) => Record<string, unknown> | null;
  openPath: (p: unknown) => string;
  notificationFor: (p: unknown) => { title: string; options: Record<string, unknown> };
  handlePush: (t: string, clients: unknown, reg: unknown) => Promise<string>;
  handleClick: (data: unknown, clients: unknown, origin: string) => Promise<string>;
}
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'push-handler.js'),
  'utf8',
);
function load(): Handler {
  const self: Record<string, unknown> = {};
  new Function('self', src)(self);
  return self['__qbPush'] as Handler;
}
const REF_A = '0193a1b2-0000-4000-8000-00000000000a';
const REF_B = '0193a1b2-0000-4000-8000-00000000000b';
const payload = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({
    v: 2,
    type: 'ticket.called',
    ref: REF_A,
    code: 'A012',
    counter: 'Counter 2',
    seq: 41,
    rp: '/recover/acme/city-clinic/A012',
    ts: '2026-11-12T10:00:00Z',
    ...o,
  });

function doubles(windows: Record<string, unknown>[] = []): {
  clients: Record<string, unknown>;
  reg: Record<string, unknown>;
  shown: { title: string; options: Record<string, unknown> }[];
  opened: string[];
} {
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  return {
    shown,
    opened,
    clients: {
      matchAll: async () => windows,
      openWindow: async (p: string) => {
        opened.push(p);
        return null;
      },
    },
    reg: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
  };
}

describe('push: focused window hand-off or a system notification', () => {
  it('a focused, visible window gets the payload and no notification is shown', async () => {
    const h = load();
    const posted: unknown[] = [];
    const d = doubles([
      { focused: false, visibilityState: 'hidden', postMessage: () => undefined },
      { focused: true, visibilityState: 'visible', postMessage: (m: unknown) => posted.push(m) },
    ]);
    expect(await h.handlePush(payload(), d.clients, d.reg)).toBe('handoff');
    expect(d.shown).toEqual([]);
    expect(posted).toEqual([
      {
        type: 'qb-turn-alert',
        ref: REF_A,
        code: 'A012',
        seq: 41,
        counter: 'Counter 2',
        rp: '/recover/acme/city-clinic/A012',
      },
    ]);
  });

  it('otherwise one notification tagged by the subscription reference (a retry replaces it)', async () => {
    const h = load();
    const d = doubles([
      { focused: false, visibilityState: 'hidden', postMessage: () => undefined },
    ]);
    expect(await h.handlePush(payload(), d.clients, d.reg)).toBe('shown');
    expect(d.shown).toHaveLength(1);
    const n = d.shown[0];
    expect(n?.title).toBe('Your turn: A012');
    expect(n?.options['tag']).toBe(turnAlertTag(REF_A));
    expect(n?.options['renotify']).toBe(true);
    expect(n?.options['data']).toEqual({
      ref: REF_A,
      code: 'A012',
      seq: 41,
      rp: '/recover/acme/city-clinic/A012',
    });
    // honest copy: no promise
    expect(JSON.stringify(n)).not.toMatch(/guarantee|delivered|will always/i);
  });

  it('two tickets with the SAME public code get different tags and destinations', () => {
    const h = load();
    const a = h.notificationFor(h.parsePayload(payload()));
    const b = h.notificationFor(h.parsePayload(payload({ ref: REF_B })));
    expect(a.options['tag']).not.toBe(b.options['tag']);
    expect(h.openPath(h.parsePayload(payload()))).not.toBe(
      h.openPath(h.parsePayload(payload({ ref: REF_B }))),
    );
  });

  it('a malformed or foreign payload shows only a neutral notice that opens the start page', async () => {
    const h = load();
    for (const bad of [
      'not json',
      payload({ v: 1 }),
      payload({ ref: 'A012' }),
      payload({ code: '<img src=x>' }),
      payload({ seq: 1.5 }),
    ]) {
      const d = doubles();
      expect(await h.handlePush(bad, d.clients, d.reg)).toBe('generic');
      expect(d.shown[0]?.options['data']).toBeUndefined();
      expect(d.shown[0]?.options['tag']).toBe('qb-generic');
    }
    expect(h.openPath(null)).toBe('/');
  });

  it('the handler holds and carries no credential (14.14)', () => {
    // nothing in the service worker reads storage, cookies or a token
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/localStorage|indexedDB|document\.cookie|status_token|X-QB-Ticket/);
    const h = load();
    const n = h.notificationFor(h.parsePayload(payload()));
    expect(JSON.stringify(n)).not.toMatch(/token|key|secret|endpoint|p256dh/i);
  });
});

describe('notificationclick: focus and navigate, or open, the reference path', () => {
  it('builds /ticket/<code>?ref=<ref>&seq=<n>&rp=<public path> and drops an unsafe rp', () => {
    const h = load();
    expect(h.openPath(h.parsePayload(payload()))).toBe(
      `/ticket/A012?ref=${REF_A}&seq=41&rp=${encodeURIComponent('/recover/acme/city-clinic/A012')}`,
    );
    expect(h.openPath({ ref: REF_A, code: 'A012', seq: 41, rp: 'https://evil.example/x' })).toBe(
      `/ticket/A012?ref=${REF_A}&seq=41`,
    );
  });

  it('focuses and navigates an existing window of this origin', async () => {
    const h = load();
    const nav: string[] = [];
    let focused = 0;
    const d = doubles([
      { url: 'https://other.example/', focus: () => undefined, navigate: async () => undefined },
      {
        url: 'https://app.example/ticket/B001?k=1',
        focus: () => {
          focused += 1;
        },
        navigate: async (p: string) => {
          nav.push(p);
        },
      },
    ]);
    const data = h.parsePayload(payload());
    const p = await h.handleClick(data, d.clients, 'https://app.example');
    expect(focused).toBe(1);
    expect(nav).toEqual([p]);
    expect(d.opened).toEqual([]);
  });

  it('opens a new window when none exists or navigation is refused', async () => {
    const h = load();
    const none = doubles();
    const p = await h.handleClick(h.parsePayload(payload()), none.clients, 'https://app.example');
    expect(none.opened).toEqual([p]);
    const refused = doubles([
      {
        url: 'https://app.example/',
        focus: () => undefined,
        navigate: async () => {
          throw new Error('not controlled');
        },
      },
    ]);
    await refused.clients;
    const p2 = await h.handleClick(
      h.parsePayload(payload()),
      refused.clients,
      'https://app.example',
    );
    expect(refused.opened).toEqual([p2]);
  });
});
