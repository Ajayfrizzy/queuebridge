import { describe, expect, it } from 'vitest';
import type { SmsMonitorRow } from '@queuebridge/contracts';
import { smsRowText } from './FacilityChannels.js';

const row = (over: Partial<SmsMonitorRow>): SmsMonitorRow => ({
  ticket_code: 'A-001',
  template: 'ticket.called',
  created_at: '2026-11-20T10:00:00.000Z',
  status: 'pending',
  detail_code: null,
  provider_mode: 'sandbox',
  attempts: 0,
  due_at: null,
  ...over,
});

describe('SMS monitoring wording (M6.3): recorded states only, never a delivery claim', () => {
  it('keeps sent, delivered, unknown and suppressed distinct', () => {
    const texts = (['sent', 'delivered', 'unknown', 'suppressed'] as const).map((status) =>
      smsRowText(row({ status, detail_code: status === 'suppressed' ? 'opted_out' : null })),
    );
    expect(new Set(texts).size).toBe(4);
  });
  it('an accepted message is never called delivered; a sandbox one never reached a phone', () => {
    expect(smsRowText(row({ status: 'sent' }))).toBe(
      'Accepted by the test provider (nothing sent to a phone)',
    );
    expect(smsRowText(row({ status: 'sent', provider_mode: 'live' }))).toBe(
      'Accepted by the provider, not confirmed',
    );
    for (const mode of ['sandbox', 'live'] as const) {
      expect(smsRowText(row({ status: 'sent', provider_mode: mode }))).not.toMatch(/deliver/i);
    }
    expect(smsRowText(row({ status: 'delivered' }))).toBe(
      'Test receipt (simulated, no real message)',
    );
  });
  it('names the reason a message was not sent, including the delayed-SMS skip', () => {
    expect(smsRowText(row({ status: 'suppressed', detail_code: 'alert_seen' }))).toBe(
      'Not sent (the ticket page showed the alert first)',
    );
    expect(smsRowText(row({ status: 'failed', detail_code: 'cap' }))).toBe(
      'Not sent: daily limit reached',
    );
    expect(smsRowText(row({ status: 'unknown' }))).toBe('Outcome unknown');
  });
  it('a delayed message is waiting, not sent', () => {
    expect(smsRowText(row({ due_at: '2026-11-20T10:00:20.000Z' }))).toBe(
      'Waiting for the delay (not sent yet)',
    );
    expect(smsRowText(row({}))).toBe('Not sent yet');
  });
});
