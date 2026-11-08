import { describe, expect, it } from 'vitest';
import { randomSecret, uuidv7 } from './ids.js';
import { SecretTokenSchema } from './queue.js';
import { UuidV7Schema } from './schemas.js';

describe('uuidv7', () => {
  it('produces valid, unique, time-ordered v7 UUIDs', () => {
    const ids = Array.from({ length: 500 }, (_, i) => uuidv7(1_700_000_000_000 + i));
    for (const id of ids) expect(UuidV7Schema.safeParse(id).success).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('encodes the timestamp in the first 48 bits', () => {
    const id = uuidv7(0x0123456789ab);
    expect(id.startsWith('01234567-89ab-7')).toBe(true);
  });
});

describe('randomSecret', () => {
  it('base64url-encodes exactly like Node (no padding)', async () => {
    const { Buffer } = await import('node:buffer');
    const tok = randomSecret();
    // round-trip through Node's decoder must give 32 bytes and re-encode identically
    const raw = Buffer.from(tok, 'base64url');
    expect(raw.length).toBe(32);
    expect(raw.toString('base64url')).toBe(tok);
  });

  it('is a 43-char base64url token accepted by SecretTokenSchema, and unique', () => {
    const a = randomSecret();
    expect(SecretTokenSchema.safeParse(a).success).toBe(true);
    expect(randomSecret()).not.toBe(a);
  });
});
