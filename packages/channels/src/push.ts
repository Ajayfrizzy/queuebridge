import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
} from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import ece from 'http_ece';

/**
 * M5.4 Web Push (REQ-F14.5, design §12.5, ADR-013).
 *
 * A narrow `PushTransport`, separate from the SMS/USSD-shaped `ChannelAdapter`:
 *  - `SandboxPushTransport`: TEST-ONLY, labelled `[SANDBOX]`, never touches the network.
 *  - `WebPushTransport`: the standard Web Push protocol with VAPID (RFC 8030, RFC 8291,
 *    RFC 8292). Payload encryption uses the MIT-licensed `http_ece` (aes128gcm, RFC 8188);
 *    the VAPID token is signed with Node's own crypto (ES256). No paid service, no SaaS.
 *
 * Delivery is AT-LEAST-ONCE WITH COLLAPSE (same `Topic` per subscription), never exactly-once,
 * and "accepted by the push service" is not "seen by the visitor".
 */

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSendOptions {
  ttlSeconds: number;
  /** `Topic` header: collapses a re-sent message for the same device */
  topic: string;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
}

/**
 * Outcome of one attempt. `accepted` = the push service took it (2xx); `gone` = 404/410, the
 * subscription no longer exists; `retry` = 429/5xx/network/timeout; `rejected` = any other
 * definitive refusal (for example 400/401/403/413).
 */
export type PushSendResult =
  | { kind: 'accepted'; status: number }
  | { kind: 'gone'; status: number }
  | { kind: 'retry'; status: number | null }
  | { kind: 'rejected'; status: number };

export interface PushTransport {
  readonly name: 'sandbox' | 'web-push';
  send(target: PushTarget, payload: string, opts: PushSendOptions): Promise<PushSendResult>;
}

// ---------------------------------------------------------------------------
// Sandbox (tests and local development only)
// ---------------------------------------------------------------------------

export interface SandboxPushRecord {
  endpoint: string;
  payload: string;
  ttlSeconds: number;
  topic: string;
  urgency: string;
}

/**
 * TEST-ONLY transport: records what would have been sent and answers by the endpoint's path,
 * so tests can exercise every outcome deterministically and without any network:
 * `/gone/` → 410, `/retry/` → 503, `/reject/` → 400, `/throw/` → an exception, `/slow/<ms>/`
 * → waits, otherwise 201. Everything it logs is prefixed `[SANDBOX]`.
 */
export class SandboxPushTransport implements PushTransport {
  public readonly name = 'sandbox' as const;
  public readonly sent: SandboxPushRecord[] = [];
  public constructor(private readonly log: (line: string) => void = () => undefined) {}

  public async send(
    target: PushTarget,
    payload: string,
    opts: PushSendOptions,
  ): Promise<PushSendResult> {
    const path = new URL(target.endpoint).pathname;
    const slow = /\/slow\/(\d+)\//.exec(path);
    if (slow) await new Promise((r) => setTimeout(r, Number(slow[1])));
    if (path.includes('/throw/')) throw new Error('[SANDBOX] simulated transport crash');
    this.sent.push({
      endpoint: target.endpoint,
      payload,
      ttlSeconds: opts.ttlSeconds,
      topic: opts.topic,
      urgency: opts.urgency ?? 'normal',
    });
    // Counts and outcome only: never the endpoint or the payload
    this.log(`[SANDBOX] push send #${this.sent.length} topic=${opts.topic}`);
    if (path.includes('/gone/')) return { kind: 'gone', status: 410 };
    if (path.includes('/retry/')) return { kind: 'retry', status: 503 };
    if (path.includes('/reject/')) return { kind: 'rejected', status: 400 };
    return { kind: 'accepted', status: 201 };
  }
}

// ---------------------------------------------------------------------------
// Standard Web Push (VAPID)
// ---------------------------------------------------------------------------

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (65 bytes) */
  publicKey: string;
  /** P-256 private scalar, base64url (32 bytes) */
  privateKey: string;
  /** `mailto:` or `https:` contact for the push service operator (RFC 8292) */
  subject: string;
}

const b64u = (b: Buffer): string => b.toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

/** Generate a VAPID key pair (used by `pnpm env:generate`; never committed). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), fromB64u(pub.x ?? ''), fromB64u(pub.y ?? '')]);
  return { publicKey: b64u(raw), privateKey: priv.d ?? '' };
}

/** Validate VAPID keys at startup (shape only); throws a message without key material. */
export function assertVapidKeys(k: VapidKeys): void {
  const pub = fromB64u(k.publicKey);
  if (pub.length !== 65 || pub[0] !== 4)
    throw new Error('VAPID_PUBLIC_KEY must be an uncompressed P-256 key (base64url, 65 bytes)');
  if (fromB64u(k.privateKey).length !== 32)
    throw new Error('VAPID_PRIVATE_KEY must be a P-256 private key (base64url, 32 bytes)');
  if (!/^(mailto:.+@.+|https:\/\/.+)$/.test(k.subject))
    throw new Error('VAPID_SUBJECT must be a mailto: or https: URL');
  // the private key must belong to the public key (the JWK import verifies the point)
  try {
    vapidAuthorization('https://push.example.invalid/x', k, 60);
  } catch {
    throw new Error('VAPID_PRIVATE_KEY does not belong to VAPID_PUBLIC_KEY');
  }
}

/**
 * RFC 8292 `Authorization: vapid t=<JWT>, k=<public key>` for the endpoint's origin.
 * The JWT is ES256 (raw r||s signature), audience = push service origin, expiry ≤ 24 h.
 */
export function vapidAuthorization(
  endpoint: string,
  k: VapidKeys,
  validSeconds = 12 * 3600,
): string {
  const pub = fromB64u(k.publicKey);
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: k.privateKey,
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
    format: 'jwk',
  });
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + Math.min(validSeconds, 24 * 3600),
        sub: k.subject,
      }),
    ),
  );
  const signature = cryptoSign('sha256', Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${k.publicKey}`;
}

/** RFC 8291 message encryption (aes128gcm) to the subscription's keys. */
export function encryptPushPayload(target: PushTarget, payload: string): Buffer {
  const local = createECDH('prime256v1');
  local.generateKeys();
  return ece.encrypt(Buffer.from(payload, 'utf8'), {
    version: 'aes128gcm',
    dh: target.keys.p256dh,
    privateKey: local,
    authSecret: target.keys.auth,
    salt: b64u(randomBytes(16)),
  });
}

/**
 * Addresses a push request must never reach: loopback, private, link-local, carrier-grade NAT,
 * benchmarking, multicast, reserved and unspecified ranges (IPv4 and IPv6, including
 * IPv4-mapped IPv6). Checked on the address actually connected to, after DNS resolution.
 */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

/** True when `address` (an IP literal) is not a public unicast address. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return BLOCKED.check(mapped[1], 'ipv4');
    return BLOCKED.check(address, 'ipv6');
  }
  return true;
}

/** A send refused before any byte left the process (policy, not a network fault). */
class EndpointRefused extends Error {
  public constructor() {
    super('push endpoint refused by policy');
    this.name = 'EndpointRefused';
  }
}

export interface WebPushTransportOptions {
  /** Whole request deadline: connect, send and response headers (default 10 s) */
  timeoutMs?: number;
  /**
   * Re-checked on EVERY send, so an endpoint stored before a policy change (or written outside
   * the API) is never contacted. Default: HTTPS on the default port to a browser push service.
   */
  isAllowedEndpoint?: (endpoint: string) => boolean;
  /** TEST-ONLY: allow loopback/private addresses (a local push server). Never set in production. */
  allowPrivateAddressesForTests?: boolean;
}

export class WebPushTransport implements PushTransport {
  public readonly name = 'web-push' as const;
  private readonly timeoutMs: number;
  private readonly isAllowedEndpoint: (endpoint: string) => boolean;
  private readonly allowPrivate: boolean;
  public constructor(
    private readonly vapid: VapidKeys,
    opts: WebPushTransportOptions | number = {},
  ) {
    assertVapidKeys(vapid);
    const o = typeof opts === 'number' ? { timeoutMs: opts } : opts;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.isAllowedEndpoint =
      o.isAllowedEndpoint ?? ((e: string): boolean => validatePushEndpoint(e, DEFAULT_PUSH_HOSTS));
    this.allowPrivate = o.allowPrivateAddressesForTests === true;
  }

  public async send(
    target: PushTarget,
    payload: string,
    opts: PushSendOptions,
  ): Promise<PushSendResult> {
    // Policy first: nothing is encrypted, resolved or sent for a refused endpoint
    if (!this.isAllowedEndpoint(target.endpoint)) return { kind: 'rejected', status: 0 };
    const url = new URL(target.endpoint);
    if (!this.allowPrivate && isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) {
      return { kind: 'rejected', status: 0 };
    }
    const body = encryptPushPayload(target, payload);
    try {
      const status = await this.post(url, body, {
        TTL: String(Math.max(0, Math.floor(opts.ttlSeconds))),
        Urgency: opts.urgency ?? 'high',
        Topic: opts.topic,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
        Authorization: vapidAuthorization(target.endpoint, this.vapid),
      });
      return classifyPushStatus(status);
    } catch (err) {
      if (err instanceof EndpointRefused) return { kind: 'rejected', status: 0 };
      return { kind: 'retry', status: null };
    }
  }

  /**
   * One POST. Redirects are never followed (a 3xx is a definitive "rejected"); the resolved
   * address is checked at connect time (no gap between check and use, so DNS rebinding cannot
   * redirect it); TLS certificate validation is Node's default and is never disabled; the
   * response body is never read (it is discarded unread, so its size does not matter).
   */
  private post(url: URL, body: Buffer, headers: Record<string, string>): Promise<number> {
    const allowPrivate = this.allowPrivate;
    const lookup = (
      hostname: string,
      options: object,
      cb: (
        err: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number,
      ) => void,
    ): void => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return cb(err, []);
        const list = addresses as LookupAddress[];
        const ok = allowPrivate ? list : list.filter((a) => !isBlockedAddress(a.address));
        // every resolved address must be public: a mixed answer is refused, not filtered
        if (ok.length === 0 || ok.length !== list.length) return cb(new EndpointRefused(), []);
        const all = (options as { all?: boolean }).all === true;
        if (all) return cb(null, ok);
        const first = ok[0] as LookupAddress;
        return cb(null, first.address, first.family);
      });
    };
    return new Promise<number>((resolve, reject) => {
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(
        url,
        { method: 'POST', headers, lookup: lookup as never, timeout: this.timeoutMs },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          res.resume();
          res.destroy();
          resolve(status);
        },
      );
      const deadline = setTimeout(
        () => req.destroy(new Error('push request timed out')),
        this.timeoutMs,
      );
      req.on('timeout', () => req.destroy(new Error('push request timed out')));
      req.on('error', (e) => reject(e));
      req.on('close', () => clearTimeout(deadline));
      req.end(body);
    });
  }
}

export function classifyPushStatus(status: number): PushSendResult {
  if (status >= 200 && status < 300) return { kind: 'accepted', status };
  if (status === 404 || status === 410) return { kind: 'gone', status };
  if (status === 429 || status >= 500) return { kind: 'retry', status };
  return { kind: 'rejected', status };
}

// ---------------------------------------------------------------------------
// Subscription secrets at rest and endpoint validation (API and worker share these)
// ---------------------------------------------------------------------------

export interface SubscriptionCipher {
  seal(plaintext: string): Buffer;
  open(sealed: Buffer): string;
}

/**
 * AES-256-GCM with a key derived (HKDF-SHA256, purpose `push-subscription`) from the
 * environment-injected `CONTACT_ENCRYPTION_KEY` (64 hex characters). Layout: iv(12) | tag(16) |
 * ciphertext. Returns null when no key is configured: push is then disabled, never weakened.
 */
export function createSubscriptionCipher(keyHex: string | undefined): SubscriptionCipher | null {
  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) return null;
  const key = Buffer.from(
    hkdfSync('sha256', Buffer.from(keyHex, 'hex'), 'queuebridge:push:v1', 'push-subscription', 32),
  );
  return {
    seal: (plaintext) => {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]);
    },
    open: (sealed) => {
      const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
      d.setAuthTag(sealed.subarray(12, 28));
      return Buffer.concat([d.update(sealed.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

/** Idempotency hash of an endpoint (never logged, never used as a key or tag). */
export const endpointHash = (endpoint: string): string =>
  createHash('sha256').update(`queuebridge:push-endpoint:v1|${endpoint}`).digest('hex');

/** Push services of the major browsers. Deployments may extend the list (PUSH_ENDPOINT_HOSTS). */
export const DEFAULT_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
] as const;

/**
 * The worker will POST to this URL, so an attacker-chosen endpoint would be a server-side
 * request forgery vector. Accept only HTTPS on the default port, without credentials, to a
 * host name (never an IP literal) under an allowed push-service domain.
 */
export function validatePushEndpoint(endpoint: string, allowedHosts: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.port !== '' && u.port !== '443') return false;
  const host = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return false;
  return allowedHosts.some((h) => {
    const suffix = h.toLowerCase().replace(/^\./, '');
    return host === suffix || host.endsWith(`.${suffix}`);
  });
}
