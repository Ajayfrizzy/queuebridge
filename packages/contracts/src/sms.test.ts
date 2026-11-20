import { describe, expect, it } from 'vitest';
import { JoinQueueRequestSchema } from './queue.js';
import {
  FacilitySmsSettingsUpdateSchema,
  SMS_CONSENT_TEXT,
  SMS_CONSENT_VERSION,
  SMS_INACTIVE_TEMPLATES,
  SMS_SENT_TEMPLATES,
  SMS_TEMPLATES,
  normalizePhoneNumber,
  phoneHint,
  smsIdempotencyKey,
} from './sms.js';

describe('normalizePhoneNumber (server-side validation, design §13.2)', () => {
  it.each([
    ['+2348012345678', '+2348012345678'],
    ['+234 801 234 5678', '+2348012345678'],
    ['08012345678', '+2348012345678'],
    ['0803-123-4567', '+2348031234567'],
    ['(0909) 123 4567', '+2349091234567'],
    ['002348012345678', '+2348012345678'],
    ['+44 20 7946 0958', '+442079460958'],
    ['+1 (415) 555-0100', '+14155550100'],
  ])('%s → %s', (input, out) => {
    expect(normalizePhoneNumber(input)).toBe(out);
  });

  it.each([
    '',
    '8012345678', // no country and no national prefix: not guessed
    '+234 0801 234 5678', // national 0 kept after the country code
    '+2346012345678', // not a Nigerian mobile range
    '+12345', // too short
    '+1234567890123456', // too long
    '0801234567', // national, one digit short
    '+234801234567x',
    'call me',
    '*123#',
    `+234${'1'.repeat(40)}`,
  ])('refuses %j', (input) => {
    expect(normalizePhoneNumber(input)).toBeNull();
  });

  it('phoneHint gives the last two digits only', () => {
    expect(phoneHint('+2348012345678')).toBe('78');
  });
});

describe('SMS opt-in on joining (separate, explicit consent)', () => {
  const base = { operation_id: '0193a000-0000-7000-8000-000000000001', join_proof: 'a'.repeat(43) };
  it('a join without SMS is unchanged', () => {
    expect(JoinQueueRequestSchema.safeParse(base).success).toBe(true);
  });
  it('the opt-in needs consent: true and the current consent version', () => {
    const ok = {
      ...base,
      sms: { phone: '08012345678', consent: true, consent_version: SMS_CONSENT_VERSION },
    };
    expect(JoinQueueRequestSchema.safeParse(ok).success).toBe(true);
    for (const sms of [
      { phone: '08012345678', consent: false, consent_version: SMS_CONSENT_VERSION },
      { phone: '08012345678', consent_version: SMS_CONSENT_VERSION },
      { phone: '08012345678', consent: true, consent_version: 'sms-consent-v0' },
      { phone: '08012345678', consent: true, consent_version: SMS_CONSENT_VERSION, extra: 1 },
      { phone: 'x'.repeat(33), consent: true, consent_version: SMS_CONSENT_VERSION },
    ]) {
      expect(JoinQueueRequestSchema.safeParse({ ...base, sms }).success).toBe(false);
    }
  });
});

describe('templates and keys', () => {
  it('all five REQ-F11.1 types exist; only the turn alert is sent under the current consent', () => {
    expect(SMS_TEMPLATES).toEqual([
      'ticket.joined',
      'ticket.nearing',
      'ticket.called',
      'ticket.delayed',
      'ticket.missed',
    ]);
    expect(SMS_SENT_TEMPLATES).toEqual(['ticket.called']);
  });
  it('the other four are inactive definitions; the consent text names only the called purpose', () => {
    expect(SMS_INACTIVE_TEMPLATES).toEqual([
      'ticket.joined',
      'ticket.nearing',
      'ticket.delayed',
      'ticket.missed',
    ]);
    expect([...SMS_SENT_TEMPLATES, ...SMS_INACTIVE_TEMPLATES].sort()).toEqual(
      [...SMS_TEMPLATES].sort(),
    );
    expect(SMS_CONSENT_TEXT).toMatch(/when I am called/);
    expect(SMS_CONSENT_TEXT).not.toMatch(/nearing|delay|missed|joined/i);
  });
  it('the idempotency key has the approved form', () => {
    expect(smsIdempotencyKey('ticket.called', 't-1', 42)).toBe('sms:ticket.called:t-1:42');
  });
});

describe('facility SMS setting', () => {
  it('turning SMS on needs a cap of at least 1; off accepts 0', () => {
    expect(
      FacilitySmsSettingsUpdateSchema.safeParse({ enabled: true, daily_cap: 50 }).success,
    ).toBe(true);
    expect(
      FacilitySmsSettingsUpdateSchema.safeParse({ enabled: false, daily_cap: 0 }).success,
    ).toBe(true);
    expect(FacilitySmsSettingsUpdateSchema.safeParse({ enabled: true, daily_cap: 0 }).success).toBe(
      false,
    );
    expect(
      FacilitySmsSettingsUpdateSchema.safeParse({ enabled: true, daily_cap: 100001 }).success,
    ).toBe(false);
    expect(FacilitySmsSettingsUpdateSchema.safeParse({ enabled: true }).success).toBe(false);
  });
});
