import { describe, expect, it } from 'vitest';
import { SMS_CONSENT_VERSION } from '@queuebridge/contracts';
import { smsOptInFor } from './SmsOptIn.js';
import { smsStateText } from './TurnAlertStatus.js';

describe('SMS opt-in at joining (REQ-F11.9)', () => {
  it('nothing entered: an ordinary join', () => {
    expect(smsOptInFor({ phone: '  ', consent: false })).toEqual({ sms: null, error: null });
  });
  it('a number and the ticked box: an explicit opt-in with the current consent version', () => {
    expect(smsOptInFor({ phone: '0803 123 4567', consent: true })).toEqual({
      sms: { phone: '0803 123 4567', consent: true, consent_version: SMS_CONSENT_VERSION },
      error: null,
    });
  });
  it('a number without the box, the box without a number, or a bad number: never sent silently', () => {
    expect(smsOptInFor({ phone: '08031234567', consent: false }).error).toMatch(/Tick the box/);
    expect(smsOptInFor({ phone: '', consent: true }).error).toMatch(/Enter your mobile number/);
    expect(smsOptInFor({ phone: '12345', consent: true }).error).toMatch(/such as 0803 123 4567/);
    for (const s of [
      { phone: '08031234567', consent: false },
      { phone: '', consent: true },
      { phone: '12345', consent: true },
    ]) {
      expect(smsOptInFor(s).sms).toBeNull();
    }
  });
});

describe('staff SMS wording (REQ-F11.13)', () => {
  const at = '2026-11-19T12:00:00.000Z';
  it('accepted is never described as delivered; only a receipt is', () => {
    expect(
      smsStateText({ state: 'sent', detail_code: 'accepted', sandbox: false, updated_at: at }),
    ).toBe('Text message accepted by the provider, not confirmed');
    expect(
      smsStateText({ state: 'delivered', detail_code: 'receipt', sandbox: false, updated_at: at }),
    ).toBe('Text message delivered (provider receipt)');
  });
  it('sandbox states say nothing reached a phone', () => {
    expect(
      smsStateText({ state: 'sent', detail_code: 'accepted', sandbox: true, updated_at: at }),
    ).toMatch(/sandbox: nothing sent to a phone/);
    expect(
      smsStateText({
        state: 'delivered',
        detail_code: 'sandbox_receipt',
        sandbox: true,
        updated_at: at,
      }),
    ).toMatch(/simulated: no real message/);
    expect(
      smsStateText({ state: 'pending', detail_code: null, sandbox: true, updated_at: at }),
    ).toMatch(/^Test: /);
  });
  it('cap and opt-out are named plainly', () => {
    expect(
      smsStateText({ state: 'failed', detail_code: 'cap', sandbox: true, updated_at: at }),
    ).toBe('Text message not sent: daily limit reached');
    expect(
      smsStateText({
        state: 'suppressed',
        detail_code: 'opted_out',
        sandbox: false,
        updated_at: at,
      }),
    ).toBe('Text message not sent (visitor stopped text messages)');
  });
});
