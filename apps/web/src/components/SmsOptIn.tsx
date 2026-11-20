import { type ReactElement } from 'react';
import {
  PHONE_INPUT_MAX,
  SMS_CONSENT_TEXT,
  SMS_CONSENT_VERSION,
  normalizePhoneNumber,
  type SmsJoinOptIn,
} from '@queuebridge/contracts';
import { Field } from './Form.js';

/**
 * M6.1 optional SMS turn alert at joining (design §13.2; REQ-F11.9). The number is optional and
 * the consent box is separate and starts unticked; joining never needs either. The number lives
 * in React state only: it is never written to local storage, the pending-join record or logs.
 */
export interface SmsOptInState {
  phone: string;
  consent: boolean;
}

export const EMPTY_SMS_OPT_IN: SmsOptInState = { phone: '', consent: false };

const INVALID =
  'Enter a mobile number such as 0803 123 4567 or +234 803 123 4567, or leave it empty.';
const NO_CONSENT = 'Tick the box to get a text message, or clear the number.';
const NO_NUMBER = 'Enter your mobile number, or untick the box.';

/**
 * What to send with the join: `null` = no SMS (nothing entered), an opt-in, or an error message
 * that must be fixed first (a number without consent is never sent silently).
 */
export function smsOptInFor(s: SmsOptInState): { sms: SmsJoinOptIn | null; error: string | null } {
  const phone = s.phone.trim();
  if (!phone && !s.consent) return { sms: null, error: null };
  if (!phone) return { sms: null, error: NO_NUMBER };
  if (!normalizePhoneNumber(phone)) return { sms: null, error: INVALID };
  if (!s.consent) return { sms: null, error: NO_CONSENT };
  return { sms: { phone, consent: true, consent_version: SMS_CONSENT_VERSION }, error: null };
}

export function SmsOptIn({
  mode,
  value,
  onChange,
  error,
}: {
  mode: 'sandbox' | 'live';
  value: SmsOptInState;
  onChange: (v: SmsOptInState) => void;
  error: string | null;
}): ReactElement {
  return (
    <fieldset className="card sms-opt-in" data-testid="sms-opt-in">
      <legend>Text message when you are called (optional)</legend>
      {mode === 'sandbox' ? (
        <p className="alert alert-info" data-testid="sms-test-mode">
          Test mode: no real text messages are sent here.
        </p>
      ) : null}
      <Field
        id="sms-phone"
        label="Mobile number"
        hint="Leave it empty to join without text messages."
        error={error ?? undefined}
      >
        {(aria) => (
          <input
            {...aria}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={PHONE_INPUT_MAX}
            value={value.phone}
            onChange={(e) => onChange({ ...value, phone: e.target.value })}
          />
        )}
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={value.consent}
          onChange={(e) => onChange({ ...value, consent: e.target.checked })}
          data-testid="sms-consent"
        />{' '}
        {SMS_CONSENT_TEXT}
      </label>
      <p className="hint">
        Your turn is always shown on your ticket page and called out by staff. A text message is an
        extra, and it can arrive late.
      </p>
    </fieldset>
  );
}
