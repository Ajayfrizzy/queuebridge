import { createECDH, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import ece from 'http_ece';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SandboxPushTransport,
  WebPushTransport,
  isBlockedAddress,
  assertVapidKeys,
  classifyPushStatus,
  createSubscriptionCipher,
  encryptPushPayload,
  endpointHash,
  generateVapidKeys,
  validatePushEndpoint,
  vapidAuthorization,
  DEFAULT_PUSH_HOSTS,
  type PushTarget,
} from './push.js';

const b64u = (b: Buffer): string => b.toString('base64url');

/** A receiving browser: its own P-256 key pair and auth secret, like PushSubscription.keys. */
function receiver(): {
  target: (endpoint: string) => PushTarget;
  decrypt: (body: Buffer) => string;
} {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = b64u(Buffer.from('0123456789abcdef'));
  return {
    target: (endpoint) => ({ endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth } }),
    decrypt: (body) =>
      ece
        .decrypt(body, { version: 'aes128gcm', privateKey: ua, authSecret: auth })
        .toString('utf8'),
  };
}

const vapid = { ...generateVapidKeys(), subject: 'mailto:ops@example.test' };

describe('RFC 8291 message encryption (aes128gcm)', () => {
  it('the library decrypts the RFC 8291 §5 example exactly (independent reference vector)', () => {
    const ua = createECDH('prime256v1');
    ua.setPrivateKey(Buffer.from('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', 'base64url'));
    expect(b64u(ua.getPublicKey())).toBe(
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    );
    const body = Buffer.from(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
      'base64url',
    );
    const plain = ece.decrypt(body, {
      version: 'aes128gcm',
      privateKey: ua,
      authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
    });
    expect(plain.toString('utf8')).toBe('When I grow up, I want to be a watermelon');
  });

  it('what QueueBridge sends decrypts with the receiving browser key, and only with it', () => {
    const r = receiver();
    const other = receiver();
    const t = r.target('https://fcm.googleapis.com/fcm/send/x');
    const a = encryptPushPayload(t, '{"v":2}');
    const b = encryptPushPayload(t, '{"v":2}');
    expect(r.decrypt(a)).toBe('{"v":2}');
    expect(a.equals(b)).toBe(false); // fresh salt and sender key every time
    expect(() => other.decrypt(a)).toThrow();
  });
});

describe('RFC 8292 VAPID', () => {
  it('signs an ES256 JWT for the push service origin, valid at most 24 h, with the public key', () => {
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', vapid);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [h, c, s] = (m?.[1] ?? '').split('.');
    expect(m?.[2]).toBe(vapid.publicKey);
    expect(JSON.parse(Buffer.from(h ?? '', 'base64url').toString())).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    });
    const claims = JSON.parse(Buffer.from(c ?? '', 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(claims['aud']).toBe('https://fcm.googleapis.com');
    expect(claims['sub']).toBe('mailto:ops@example.test');
    const exp = Number(claims['exp']);
    expect(exp - Date.now() / 1000).toBeLessThanOrEqual(24 * 3600);
    const pub = Buffer.from(vapid.publicKey, 'base64url');
    const key = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) },
      format: 'jwk',
    });
    const ok = cryptoVerify(
      'sha256',
      Buffer.from(`${h}.${c}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s ?? '', 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('refuses malformed or mismatched keys and subjects, with messages that contain no key material', () => {
    const other = generateVapidKeys();
    for (const bad of [
      { ...vapid, publicKey: 'AAAA' },
      { ...vapid, privateKey: 'AAAA' },
      { ...vapid, subject: 'ops@example.test' },
    ]) {
      expect(() => assertVapidKeys(bad)).toThrow();
      try {
        assertVapidKeys(bad);
      } catch (e) {
        expect(String(e)).not.toContain(vapid.privateKey);
      }
    }
    // a private key that does not belong to the public key is refused at startup
    expect(() => assertVapidKeys({ ...vapid, privateKey: other.privateKey })).toThrow(
      'VAPID_PRIVATE_KEY does not belong to VAPID_PUBLIC_KEY',
    );
    expect(() => assertVapidKeys(vapid)).not.toThrow();
  });
});

/** The local test push server is plain HTTP on loopback: both need the TEST-ONLY opt-ins. */
const local = (timeoutMs?: number): WebPushTransport =>
  new WebPushTransport(vapid, {
    isAllowedEndpoint: () => true,
    allowPrivateAddressesForTests: true,
    ...(timeoutMs ? { timeoutMs } : {}),
  });

describe('WebPushTransport against a real local HTTP push endpoint', () => {
  let server: Server | null = null;
  let hits = 0;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });
  async function endpoint(
    handler: (req: IncomingMessage, body: Buffer) => [number, number?],
  ): Promise<string> {
    server = createServer((req, res) => {
      hits += 1;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const [status, delay] = handler(req, Buffer.concat(chunks));
        setTimeout(() => {
          res.writeHead(status);
          res.end('echo would go here');
        }, delay ?? 0);
      });
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server?.address() as AddressInfo).port}/push/abc`;
  }

  it('POSTs the encrypted payload with TTL, Urgency, Topic, aes128gcm and a VAPID header', async () => {
    const r = receiver();
    let seen: { headers: IncomingMessage['headers']; plain: string } | null = null;
    const url = await endpoint((req, body) => {
      seen = { headers: req.headers, plain: r.decrypt(body) };
      return [201];
    });
    const t = local();
    const res = await t.send(r.target(url), '{"v":2,"type":"ticket.called"}', {
      ttlSeconds: 120,
      topic: 'abc123',
    });
    expect(res).toEqual({ kind: 'accepted', status: 201 });
    const s = seen as unknown as { headers: IncomingMessage['headers']; plain: string };
    expect(s.plain).toBe('{"v":2,"type":"ticket.called"}');
    expect(s.headers['ttl']).toBe('120');
    expect(s.headers['urgency']).toBe('high');
    expect(s.headers['topic']).toBe('abc123');
    expect(s.headers['content-encoding']).toBe('aes128gcm');
    expect(String(s.headers['authorization'])).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  });

  it('maps 404/410 to gone, 429/5xx to retry, other 4xx to rejected, and a timeout to retry', async () => {
    const r = receiver();
    for (const [status, kind] of [
      [410, 'gone'],
      [404, 'gone'],
      [429, 'retry'],
      [503, 'retry'],
      [403, 'rejected'],
      [400, 'rejected'],
    ] as const) {
      const url = await endpoint(() => [status]);
      expect((await local().send(r.target(url), 'x', { ttlSeconds: 1, topic: 't' })).kind).toBe(
        kind,
      );
      await new Promise<void>((done) => server?.close(() => done()));
      server = null;
    }
    const slow = await endpoint(() => [201, 2000]);
    expect(
      await local(200).send(r.target(slow), 'x', {
        ttlSeconds: 1,
        topic: 't',
      }),
    ).toEqual({
      kind: 'retry',
      status: null,
    });
  });

  it('never follows a redirect (the endpoint was validated; a redirect target was not)', async () => {
    const r = receiver();
    const url = await endpoint(() => [307]);
    expect((await local().send(r.target(url), 'x', { ttlSeconds: 1, topic: 't' })).kind).not.toBe(
      'accepted',
    );
  });

  it('SSRF: the default policy refuses a non-allow-listed or plain-HTTP endpoint before any request', async () => {
    const r = receiver();
    const url = await endpoint(() => [201]);
    hits = 0;
    for (const e of [url, 'https://evil.example/push', 'http://fcm.googleapis.com/fcm/send/x']) {
      expect(
        await new WebPushTransport(vapid).send(r.target(e), 'x', { ttlSeconds: 1, topic: 't' }),
      ).toEqual({
        kind: 'rejected',
        status: 0,
      });
    }
    expect(hits).toBe(0);
  });

  it('SSRF: even an allowed name is refused when it resolves to a loopback/private address (checked at connect)', async () => {
    const r = receiver();
    const url = await endpoint(() => [201]);
    const port = new URL(url).port;
    hits = 0;
    const policyOnly = new WebPushTransport(vapid, { isAllowedEndpoint: () => true });
    // a host NAME resolving to 127.0.0.1 (DNS answer checked on the address actually used)
    expect(
      await policyOnly.send(r.target(`http://localhost:${port}/push/abc`), 'x', {
        ttlSeconds: 1,
        topic: 't',
      }),
    ).toEqual({ kind: 'rejected', status: 0 });
    // an IP literal is refused without resolution
    for (const e of [url, `http://[::1]:${port}/x`]) {
      expect(await policyOnly.send(r.target(e), 'x', { ttlSeconds: 1, topic: 't' })).toEqual({
        kind: 'rejected',
        status: 0,
      });
    }
    expect(hits).toBe(0);
  });

  it('classifies statuses', () => {
    expect(classifyPushStatus(202).kind).toBe('accepted');
    expect(classifyPushStatus(413).kind).toBe('rejected');
  });
});

describe('isBlockedAddress', () => {
  it('blocks loopback, private, link-local, CGNAT, reserved, multicast and mapped forms; allows public', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      'not-an-ip',
    ]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of [
      '142.250.180.10',
      '8.8.8.8',
      '172.32.0.1',
      '2607:f8b0:4004:800::200a',
      '::ffff:8.8.8.8',
    ]) {
      expect(isBlockedAddress(a), a).toBe(false);
    }
  });
});

describe('SandboxPushTransport is test-only and offline', () => {
  it('makes no network call, answers by path, and logs [SANDBOX] with neither endpoint nor payload', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network must not be used'));
    const lines: string[] = [];
    const s = new SandboxPushTransport((l) => lines.push(l));
    const t = (path: string): PushTarget => ({
      endpoint: `https://push.sandbox.test${path}`,
      keys: { p256dh: 'x', auth: 'y' },
    });
    expect((await s.send(t('/ok/1'), 'SECRET-PAYLOAD', { ttlSeconds: 5, topic: 'top' })).kind).toBe(
      'accepted',
    );
    expect((await s.send(t('/gone/1'), 'p', { ttlSeconds: 5, topic: 'top' })).kind).toBe('gone');
    expect((await s.send(t('/retry/1'), 'p', { ttlSeconds: 5, topic: 'top' })).kind).toBe('retry');
    expect((await s.send(t('/reject/1'), 'p', { ttlSeconds: 5, topic: 'top' })).kind).toBe(
      'rejected',
    );
    await expect(s.send(t('/throw/1'), 'p', { ttlSeconds: 5, topic: 'top' })).rejects.toThrow(
      '[SANDBOX]',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines.every((l) => l.startsWith('[SANDBOX]'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/SECRET-PAYLOAD|push\.sandbox\.test/);
    fetchSpy.mockRestore();
  });
});

describe('subscription secrets and endpoint validation', () => {
  it('seals with AES-256-GCM: round trip, fresh IV, tamper detected, disabled without a key', () => {
    const c = createSubscriptionCipher('ab'.repeat(32));
    expect(c).not.toBeNull();
    const a = c!.seal('https://fcm.googleapis.com/fcm/send/secret');
    const b = c!.seal('https://fcm.googleapis.com/fcm/send/secret');
    expect(a.equals(b)).toBe(false);
    expect(a.toString('utf8')).not.toContain('secret');
    expect(c!.open(a)).toBe('https://fcm.googleapis.com/fcm/send/secret');
    const tampered = Buffer.from(a);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => c!.open(tampered)).toThrow();
    // a different environment key cannot open it
    expect(() => createSubscriptionCipher('cd'.repeat(32))!.open(a)).toThrow();
    expect(createSubscriptionCipher(undefined)).toBeNull();
    expect(createSubscriptionCipher('short')).toBeNull();
  });

  it('endpoint hash is stable per endpoint and reveals nothing readable', () => {
    expect(endpointHash('https://a/b')).toBe(endpointHash('https://a/b'));
    expect(endpointHash('https://a/b')).not.toBe(endpointHash('https://a/c'));
    expect(endpointHash('https://a/b')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts only HTTPS endpoints of known push services (no SSRF to internal hosts)', () => {
    const ok = [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QKx',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ];
    const bad = [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evil-fcm.googleapis.com.example/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://10.0.0.5/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://localhost/x',
      'https://metadata.google.internal/computeMetadata',
      'not a url',
    ];
    for (const u of ok) expect(validatePushEndpoint(u, DEFAULT_PUSH_HOSTS), u).toBe(true);
    for (const u of bad) expect(validatePushEndpoint(u, DEFAULT_PUSH_HOSTS), u).toBe(false);
  });
});
