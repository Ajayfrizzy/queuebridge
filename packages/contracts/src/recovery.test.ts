import { describe, expect, it } from 'vitest';
import { ServicePolicySchema } from './admin.js';
import {
  RECOVERY_ALPHABET,
  RECOVERY_KEY_BITS,
  RECOVERY_KEY_LENGTH,
  RecoverTicketRequestSchema,
  RecoveryAssistRequestSchema,
  RecoveryAuditEntrySchema,
  RecoveryAuditQuerySchema,
  RecoverySecretSchema,
  encodeRecoveryKey,
  formatRecoveryKey,
  normalizeRecoveryKey,
  recoveryPolicyOf,
} from './recovery.js';

const bytes = (fill: (i: number) => number): Uint8Array =>
  Uint8Array.from({ length: RECOVERY_KEY_BITS / 8 }, (_, i) => fill(i));

describe('recovery key encoding (REQ-F4.7: at least 128 bits)', () => {
  it('carries 160 bits, never below the 128-bit minimum, as 32 characters', () => {
    expect(RECOVERY_KEY_BITS).toBe(160);
    expect(RECOVERY_KEY_BITS).toBeGreaterThanOrEqual(128);
    expect(RECOVERY_KEY_LENGTH).toBe(32);
    expect(encodeRecoveryKey(bytes(() => 0))).toBe('0'.repeat(32));
    expect(encodeRecoveryKey(bytes(() => 255))).toBe('Z'.repeat(32));
  });

  it('is a bijection on 5-bit groups (no bits are lost or folded)', () => {
    // 0x00 0x44 0x32 0x14 0xC7 … encodes bit patterns 00000 00001 00010 …
    const k = encodeRecoveryKey(bytes((i) => (i * 37 + 11) & 255));
    expect(k).toHaveLength(32);
    expect([...k].every((c) => RECOVERY_ALPHABET.includes(c))).toBe(true);
    const different = encodeRecoveryKey(bytes((i) => ((i * 37 + 11) & 255) ^ (i === 19 ? 1 : 0)));
    expect(different).not.toBe(k);
    expect(different.slice(0, 31)).toBe(k.slice(0, 31)); // the last bit changes the last char only
  });

  it('refuses any input that is not exactly 20 bytes', () => {
    expect(() => encodeRecoveryKey(new Uint8Array(16))).toThrow();
    expect(() => encodeRecoveryKey(new Uint8Array(21))).toThrow();
  });

  it('uses an alphabet without I, L, O and U', () => {
    expect(RECOVERY_ALPHABET).toHaveLength(32);
    for (const c of 'ILOU') expect(RECOVERY_ALPHABET).not.toContain(c);
  });
});

describe('readable formatting and tolerant input', () => {
  const key = encodeRecoveryKey(bytes((i) => (i * 91 + 7) & 255));

  it('formats as eight hyphenated groups of four', () => {
    const f = formatRecoveryKey(key);
    expect(f).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    expect(f.replace(/-/g, '')).toBe(key);
  });

  it('accepts lower case, spaces and hyphens', () => {
    const typed = formatRecoveryKey(key).toLowerCase().replace(/-/g, ' - ');
    expect(normalizeRecoveryKey(typed)).toBe(key);
  });

  it('folds I and L to 1 and O to 0 (ambiguous when read aloud)', () => {
    expect(normalizeRecoveryKey('IL' + 'O'.repeat(30))).toBe('11' + '0'.repeat(30));
  });

  it('rejects wrong lengths and characters outside the alphabet (U)', () => {
    expect(normalizeRecoveryKey(key.slice(1))).toBeNull();
    expect(normalizeRecoveryKey(key + 'A')).toBeNull();
    expect(normalizeRecoveryKey('U' + key.slice(1))).toBeNull();
    expect(normalizeRecoveryKey('')).toBeNull();
  });

  it('the canonical form validates as a recovery secret; formatted text does not', () => {
    expect(RecoverySecretSchema.safeParse(key).success).toBe(true);
    expect(RecoverySecretSchema.safeParse(formatRecoveryKey(key)).success).toBe(false);
  });
});

describe('request schemas', () => {
  it('a recovery request needs the facility, the ticket code AND the key, or a grant', () => {
    const key = 'K'.repeat(32);
    const ok = {
      org_slug: 'acme',
      facility_slug: 'clinic',
      ticket_code: 'A012',
      recovery_key: key,
    };
    expect(RecoverTicketRequestSchema.safeParse(ok).success).toBe(true);
    expect(RecoverTicketRequestSchema.safeParse({ grant: key }).success).toBe(true);
    // The public ticket code alone is never a valid request
    expect(
      RecoverTicketRequestSchema.safeParse({
        org_slug: 'acme',
        facility_slug: 'clinic',
        ticket_code: 'A012',
      }).success,
    ).toBe(false);
    // Unknown fields (e.g. an attempt to pass a ticket id) are refused
    expect(RecoverTicketRequestSchema.safeParse({ ...ok, ticket_id: 'x' }).success).toBe(false);
  });

  it('staff assistance cannot submit presence or the public code as a factor', () => {
    const base = {
      reason_code: 'lost_device',
      account_matches: true,
      asked_before_revealing: true,
    };
    expect(RecoveryAssistRequestSchema.safeParse(base).success).toBe(true);
    expect(RecoveryAssistRequestSchema.safeParse({ ...base, visitor_present: true }).success).toBe(
      false,
    );
    expect(
      RecoveryAssistRequestSchema.safeParse({ ...base, knows_ticket_code: true }).success,
    ).toBe(false);
    expect(RecoveryAssistRequestSchema.safeParse({ ...base, contact_match: true }).success).toBe(
      false,
    );
    expect(
      RecoveryAssistRequestSchema.safeParse({ ...base, asked_before_revealing: false }).success,
    ).toBe(false);
  });
});

describe('service policy recovery fields', () => {
  it('defaults keep the M2–M4 behaviour: staff resume, no automatic no-show, staff recovery on', () => {
    const p = ServicePolicySchema.parse({});
    expect(p.rejoin_policy).toBe('staff_resume');
    expect(p.auto_miss).toEqual({ enabled: false });
    expect(p.staff_recovery).toBe(true);
    expect(p.grace_window_seconds).toBe(300); // unchanged grace default
  });

  it('enabling automatic no-show requires an explicit time (no default) in 60–3600 s', () => {
    expect(ServicePolicySchema.safeParse({ auto_miss: { enabled: true } }).success).toBe(false);
    expect(
      ServicePolicySchema.safeParse({ auto_miss: { enabled: true, after_seconds: 59 } }).success,
    ).toBe(false);
    expect(
      ServicePolicySchema.safeParse({ auto_miss: { enabled: true, after_seconds: 3601 } }).success,
    ).toBe(false);
    expect(
      ServicePolicySchema.parse({ auto_miss: { enabled: true, after_seconds: 120 } }).auto_miss,
    ).toEqual({ enabled: true, after_seconds: 120 });
  });

  it('recoveryPolicyOf reads policies stored before M5.1 with safe defaults', () => {
    expect(recoveryPolicyOf({})).toEqual({
      rejoin_policy: 'staff_resume',
      auto_miss: { enabled: false, after_seconds: null },
      staff_recovery: true,
    });
    // an enabled flag without a time is treated as disabled (never a guessed default)
    expect(recoveryPolicyOf({ auto_miss: { enabled: true } }).auto_miss.enabled).toBe(false);
  });
});

describe('Recovery activity audit view (design §15.9a)', () => {
  it('query: bounded limit, uuid cursor, nothing else', () => {
    expect(RecoveryAuditQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(RecoveryAuditQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    for (const bad of [{ limit: '0' }, { limit: '101' }, { after: 'x' }, { extra: '1' }]) {
      expect(RecoveryAuditQuerySchema.safeParse(bad).success).toBe(false);
    }
  });
  it('entry: staff, visitor device, system or not recorded; unknown kinds rejected', () => {
    const base = {
      at: '2026-11-16T10:00:00.000Z',
      ticket_code: 'G001',
      kind: 'approval',
      performed_by: { kind: 'staff', name: 'Staff supervisor', account_status: 'inactive' },
      reason_code: 'lost_device',
      assurance: 'basic',
      method: null,
      revoked_devices: null,
    };
    expect(RecoveryAuditEntrySchema.safeParse(base).success).toBe(true);
    expect(
      RecoveryAuditEntrySchema.safeParse({ ...base, performed_by: { kind: 'visitor_device' } })
        .success,
    ).toBe(true);
    expect(RecoveryAuditEntrySchema.safeParse({ ...base, kind: 'grant_shown' }).success).toBe(
      false,
    );
    expect(
      RecoveryAuditEntrySchema.safeParse({ ...base, performed_by: { kind: 'staff' } }).success,
    ).toBe(false);
  });
});
