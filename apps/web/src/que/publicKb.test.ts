import { describe, expect, it } from 'vitest';
import { loadCapabilities, loadPublicKb } from './publicKb.js';
import { art } from './fixtures.testkit.js';

const bundle = {
  kbVersion: 2,
  audience: 'visitor',
  articles: [{ ...art('visitor.x.one'), audiences: ['visitor'] }],
};
const ok = (body: unknown): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body)));
const fail = (): Promise<never> =>
  Promise.reject(Object.assign(new Error('offline'), { status: 0 }));

describe('loadPublicKb', () => {
  it('prefers the server copy', async () => {
    const r = await loadPublicKb(
      async () => bundle,
      () => fail(),
      '/built-in.json',
    );
    expect(r?.source).toBe('server');
    expect(r?.bundle.kbVersion).toBe(2);
  });

  it('falls back to the built-in (precached) copy when the server is unreachable', async () => {
    const r = await loadPublicKb(fail, () => ok({ ...bundle, kbVersion: 1 }), '/built-in.json');
    expect(r?.source).toBe('built_in');
    expect(r?.bundle.kbVersion).toBe(1);
  });

  it('never returns invalid content: a non-public or malformed bundle is refused', async () => {
    const staff = { ...bundle, audience: 'supervisor' };
    expect(
      await loadPublicKb(
        async () => staff,
        () => ok(staff),
        '/b.json',
      ),
    ).toBeNull();
    const unsafe = { ...bundle, articles: [{ ...bundle.articles[0], body: '<script>x</script>' }] };
    expect(
      await loadPublicKb(
        async () => unsafe,
        () => ok(unsafe),
        '/b.json',
      ),
    ).toBeNull();
    expect(await loadPublicKb(fail, () => fail(), '/b.json')).toBeNull();
  });
});

describe('loadCapabilities (fail closed)', () => {
  it('returns null for an unreachable server or an invalid manifest', async () => {
    expect(await loadCapabilities(fail)).toBeNull();
    expect(await loadCapabilities(async () => ({ version: 1, capabilities: {} }))).toBeNull();
  });
});
