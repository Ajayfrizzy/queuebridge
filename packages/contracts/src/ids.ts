/** Minimal Web Crypto surface (this package targets plain ES2022 without DOM/Node typings). */
interface WebCrypto {
  getRandomValues<T extends Uint8Array>(array: T): T;
}
const webCrypto = (): WebCrypto => (globalThis as unknown as { crypto: WebCrypto }).crypto;

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j++) out += B64URL[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}

/**
 * RFC 9562 UUID version 7 (48-bit Unix-ms timestamp + 74 random bits) using Web Crypto, which is
 * available in browsers and Node 20+. Used for client operation ids (idempotency keys).
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  webCrypto().getRandomValues(bytes);
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 256-bit URL-safe random secret (base64url, 43 chars), e.g. a visitor's join proof. */
export function randomSecret(): string {
  const bytes = new Uint8Array(32);
  webCrypto().getRandomValues(bytes);
  return base64url(bytes);
}
