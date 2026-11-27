import { describe, expect, it } from 'vitest';
import { SMS_TEMPLATES } from '@queuebridge/contracts';
import { createSmsAdapter } from './registry.js';
import {
  SMS_MAX_CHARS,
  createContactCipher,
  isStopKeyword,
  renderSmsTemplate,
  signSmsWebhook,
  verifySmsWebhook,
} from './sms.js';

const KEY = '7e57'.repeat(16);
const SECRET = 'test-only-sms-webhook-secret-0123456789abcdef';

describe('SMS templates (REQ-F11.1)', () => {
  it('renders all five types with the ticket code only (no number, name or link)', () => {
    for (const t of SMS_TEMPLATES) {
      const text = renderSmsTemplate(
        t,
        { code: 'a012', counter: 'Counter 2', service: 'Pharmacy' },
        { sandbox: false },
      );
      expect(text).toContain('QueueBridge: ');
      expect(text).toContain('A012');
      expect(text.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
      expect(text).not.toMatch(/https?:|www\.|\+\d{6,}/);
    }
  });

  it('ticket.called names the counter; sandbox text is labelled [TEST]', () => {
    expect(
      renderSmsTemplate(
        'ticket.called',
        { code: 'A012', counter: 'Counter 2' },
        { sandbox: false },
      ),
    ).toBe('QueueBridge: ticket A012, it is your turn. Please go to Counter 2 now.');
    expect(renderSmsTemplate('ticket.called', { code: 'A012' }, { sandbox: true })).toBe(
      '[TEST] QueueBridge: ticket A012, it is your turn. Please go to the counter now.',
    );
  });

  it('the opt-out hint points to the ticket page and never promises a STOP reply', () => {
    const t = renderSmsTemplate(
      'ticket.called',
      { code: 'A012', counter: 'Counter 2' },
      { sandbox: true, optOutHint: true },
    );
    expect(t).toBe(
      '[TEST] QueueBridge: ticket A012, it is your turn. Please go to Counter 2 now. Stop texts on your ticket page.',
    );
    expect(t).not.toMatch(/reply/i);
    expect(t.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
  });
  it('trims long or hostile labels and refuses bad codes and unknown templates', () => {
    const t = renderSmsTemplate(
      'ticket.called',
      { code: 'A1', counter: `x\u0000${'y'.repeat(300)}` },
      { sandbox: true, optOutHint: true },
    );
    expect(t.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(t).not.toContain('\u0000');
    expect(() => renderSmsTemplate('ticket.called', { code: 'A 1' }, { sandbox: false })).toThrow();
    expect(() => renderSmsTemplate('ticket.promo', { code: 'A1' }, { sandbox: false })).toThrow();
  });
});

describe('contact cipher (design §13.2)', () => {
  it('seals with random IVs, opens, and refuses tampering', () => {
    const c = createContactCipher(KEY);
    expect(c).not.toBeNull();
    const a = c!.sealPhone('+2348012345678');
    const b = c!.sealPhone('+2348012345678');
    expect(a).not.toBe(b);
    expect(a).not.toContain('8012345678');
    expect(c!.openPhone(a)).toBe('+2348012345678');
    const buf = Buffer.from(a, 'base64');
    buf[buf.length - 1] ^= 1;
    expect(() => c!.openPhone(buf.toString('base64'))).toThrow();
  });

  it('the lookup hash is keyed, stable and not a plain hash', async () => {
    const { createHash } = await import('node:crypto');
    const c = createContactCipher(KEY)!;
    const other = createContactCipher('ab'.repeat(32))!;
    expect(c.phoneHash('+2348012345678')).toBe(c.phoneHash('+2348012345678'));
    expect(c.phoneHash('+2348012345678')).not.toBe(other.phoneHash('+2348012345678'));
    expect(c.phoneHash('+2348012345678')).not.toBe(
      createHash('sha256').update('+2348012345678').digest('hex'),
    );
  });

  it('is unavailable without a valid 64-hex key', () => {
    expect(createContactCipher(undefined)).toBeNull();
    expect(createContactCipher('short')).toBeNull();
  });

  it('uses a different derived key than another purpose (push ciphertext cannot be opened)', async () => {
    const { createSubscriptionCipher } = await import('./push.js');
    const push = createSubscriptionCipher(KEY)!;
    const sealed = push.seal('+2348012345678').toString('base64');
    expect(() => createContactCipher(KEY)!.openPhone(sealed)).toThrow();
  });
});

describe('signed webhooks and keywords', () => {
  it('a valid signature verifies once per body and within the window', () => {
    const body = '{"kind":"receipt"}';
    const h = signSmsWebhook(SECRET, body, { timestamp: 1_000_000, nonce: 'n'.repeat(16) });
    expect(verifySmsWebhook(SECRET, h, body, 1_000_000_000)).toBe(true);
    expect(verifySmsWebhook(SECRET, h, body, 1_000_301_000)).toBe(false);
    expect(verifySmsWebhook('short', h, body, 1_000_000_000)).toBe(false);
    expect(
      verifySmsWebhook(SECRET, { ...h, 'x-qb-sms-nonce': 'bad nonce' }, body, 1_000_000_000),
    ).toBe(false);
  });

  it('recognizes opt-out replies only as whole messages', () => {
    for (const k of ['STOP', 'stop', ' Stop. ', 'UNSUBSCRIBE', 'quit'])
      expect(isStopKeyword(k)).toBe(true);
    for (const k of ['please stop calling', 'stopwatch', '', 'START'])
      expect(isStopKeyword(k)).toBe(false);
  });
});

describe('adapter registry (ADR-009)', () => {
  it('only the sandbox exists; any other provider is refused, never silently replaced', () => {
    const a = createSmsAdapter('sandbox');
    expect(a.provider).toBe('sandbox');
    expect(a.sandbox).toBe(true);
    expect(() => createSmsAdapter('termii')).toThrow(/no live provider is approved/);
  });
});
