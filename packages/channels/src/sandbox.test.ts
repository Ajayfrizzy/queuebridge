import { describe, expect, it, beforeEach } from 'vitest';
import { DeliveryStatus } from '@queuebridge/contracts';
import {
  SANDBOX_PREFIX,
  SANDBOX_SMS_SCENARIOS,
  SandboxSmsAdapter,
  SandboxUssdAdapter,
} from './sandbox.js';
import { signSmsWebhook } from './sms.js';

// ---------------------------------------------------------------------------
// SandboxSmsAdapter (Group 10; M6.1 replaced the M0 stub, which claimed `delivered` on send and
// accepted every webhook: both contradict REQ-F11.4 and the webhook security rules)
// ---------------------------------------------------------------------------
const SECRET = 'test-only-sms-webhook-secret-0123456789abcdef';
const send = (
  a: SandboxSmsAdapter,
  over: Partial<Parameters<SandboxSmsAdapter['sendMessage']>[0]> = {},
): ReturnType<SandboxSmsAdapter['sendMessage']> =>
  a.sendMessage({
    to: '+2348012345678',
    template_key: 'ticket.called',
    params: { code: 'A012', counter: 'Counter 2' },
    idempotency_key: 'sms:ticket.called:t1:7',
    sandbox: true,
    ...over,
  });

describe('SandboxSmsAdapter', () => {
  let adapter: SandboxSmsAdapter;
  let lines: string[];
  beforeEach(() => {
    lines = [];
    adapter = new SandboxSmsAdapter({ webhookSecret: SECRET, log: (l) => lines.push(l) });
  });

  it('accepts (sent), never delivered, and makes no network call', async () => {
    const result = await send(adapter);
    expect(result.status).toBe(DeliveryStatus.SENT);
    expect(result.status).not.toBe(DeliveryStatus.DELIVERED);
    expect(result.sandbox).toBe(true);
    expect(result.provider_message_id).toMatch(/^sbx_[0-9a-f]{32}$/);
  });

  it('the same idempotency key gives the same message id and is recorded once', async () => {
    const a = await send(adapter);
    const b = await send(adapter);
    expect(b.provider_message_id).toBe(a.provider_message_id);
    expect(adapter.getSentMessages()).toHaveLength(1);
    const c = await send(adapter, { idempotency_key: 'sms:ticket.called:t1:9' });
    expect(c.provider_message_id).not.toBe(a.provider_message_id);
    expect(adapter.getSentMessages()).toHaveLength(2);
  });

  it('labels the message as a test and logs [SANDBOX] without the number or the text', async () => {
    await send(adapter);
    expect(adapter.getSentMessages()[0]?.text).toMatch(/^\[TEST\] QueueBridge: ticket A012/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(SANDBOX_PREFIX);
    expect(lines[0]).not.toContain('8012345678');
    expect(lines[0]).not.toContain('A012');
  });

  it('simulates rejection, temporary unavailability and a transport error deterministically', async () => {
    const r = await send(adapter, {
      to: `+234801234${SANDBOX_SMS_SCENARIOS.rejected}`,
      idempotency_key: 'k-r',
    });
    expect(r).toEqual({ status: DeliveryStatus.FAILED, sandbox: true, retryable: false });
    const u = await send(adapter, {
      to: `+234801234${SANDBOX_SMS_SCENARIOS.unavailable}`,
      idempotency_key: 'k-u',
    });
    expect(u).toEqual({ status: DeliveryStatus.FAILED, sandbox: true, retryable: true });
    await expect(
      send(adapter, { to: `+234801234${SANDBOX_SMS_SCENARIOS.error}`, idempotency_key: 'k-e' }),
    ).rejects.toThrow(/simulated/);
    expect(adapter.getSentMessages()).toHaveLength(0);
  });

  it('refuses an unknown template or invalid parameters', async () => {
    await expect(
      send(adapter, { template_key: 'ticket.promo', idempotency_key: 'k1' }),
    ).rejects.toThrow();
    await expect(
      send(adapter, { params: { code: '<b>' }, idempotency_key: 'k2' }),
    ).rejects.toThrow();
    await expect(send(adapter, { to: '' })).rejects.toThrow();
  });

  it('clears its records', async () => {
    await send(adapter);
    adapter.clearSentMessages();
    expect(adapter.getSentMessages()).toHaveLength(0);
  });

  it('verifies signed webhooks: signature, timestamp window and secret', () => {
    const body = JSON.stringify({ kind: 'receipt', message_id: 'sbx_abcd', status: 'delivered' });
    const headers = signSmsWebhook(SECRET, body);
    expect(adapter.verifyWebhook(headers, body)).toBe(true);
    expect(adapter.verifyWebhook(headers, body.replace('delivered', 'failed'))).toBe(false);
    expect(
      adapter.verifyWebhook(signSmsWebhook('another-secret-of-at-least-32-chars!!', body), body),
    ).toBe(false);
    const stale = signSmsWebhook(SECRET, body, { timestamp: Math.floor(Date.now() / 1000) - 301 });
    expect(adapter.verifyWebhook(stale, body)).toBe(false);
    const future = signSmsWebhook(SECRET, body, { timestamp: Math.floor(Date.now() / 1000) + 301 });
    expect(adapter.verifyWebhook(future, body)).toBe(false);
    expect(adapter.verifyWebhook({}, body)).toBe(false);
    expect(adapter.verifyWebhook(headers, JSON.parse(body))).toBe(false); // must be the raw body
    expect(new SandboxSmsAdapter().verifyWebhook(headers, body)).toBe(false); // no secret
  });

  it('parses receipts strictly and never invents delivery', () => {
    const r = adapter.parseDeliveryReceipt({
      kind: 'receipt',
      message_id: 'sbx_abcd',
      status: 'failed',
    });
    expect(r.status).toBe(DeliveryStatus.FAILED);
    expect(r.raw_status).toBe('sandbox_failed');
    expect(() => adapter.parseDeliveryReceipt({ provider_message_id: 'msg-123' })).toThrow();
    expect(() =>
      adapter.parseDeliveryReceipt({ kind: 'receipt', message_id: 'sbx_abcd', status: 'read' }),
    ).toThrow();
    expect(() =>
      adapter.parseDeliveryReceipt({
        kind: 'receipt',
        message_id: 'sbx_abcd',
        status: 'delivered',
        x: 1,
      }),
    ).toThrow();
  });

  it('parses inbound replies (for STOP), and nothing else', () => {
    expect(
      adapter.parseInboundMessage({
        kind: 'inbound',
        message_id: 'in_0001',
        from: '+2348012345678',
        body: 'STOP',
      }),
    ).toMatchObject({ from: '+2348012345678', body: 'STOP', provider_message_id: 'in_0001' });
    expect(adapter.parseInboundMessage({})).toBeNull();
    expect(
      adapter.parseInboundMessage({ kind: 'receipt', message_id: 'x1234', status: 'delivered' }),
    ).toBeNull();
  });

  it('does not handle USSD', async () => {
    const r = await adapter.handleUssdSession({ session_key_hash: 'h', msisdn: '+1', input: '' });
    expect(r.action).toBe('END');
  });
});

// ---------------------------------------------------------------------------
// SandboxUssdAdapter
// ---------------------------------------------------------------------------

describe('SandboxUssdAdapter', () => {
  let adapter: SandboxUssdAdapter;
  const SESSION_KEY = 'test-session-hash-abc';
  const MSISDN = '+2348099887766';

  beforeEach(() => {
    adapter = new SandboxUssdAdapter();
  });

  it('starts a USSD session with a welcome menu (step 0)', async () => {
    const response = await adapter.handleUssdSession({
      session_key_hash: SESSION_KEY,
      msisdn: MSISDN,
      input: '',
      session_state: {},
    });
    expect(response.action).toBe('CON');
    expect(response.message).toContain(SANDBOX_PREFIX);
    expect(response.message).toContain('Welcome');
    expect(response.next_state).toEqual({ step: 1 });
  });

  it('navigates to join queue on input "1"', async () => {
    const response = await adapter.handleUssdSession({
      session_key_hash: SESSION_KEY,
      msisdn: MSISDN,
      input: '1',
      session_state: { step: 1 },
    });
    expect(response.action).toBe('CON');
    expect(response.message).toContain(SANDBOX_PREFIX);
    expect(response.next_state).toMatchObject({ step: 2, intent: 'join' });
  });

  it('navigates to status check on input "2"', async () => {
    const response = await adapter.handleUssdSession({
      session_key_hash: SESSION_KEY,
      msisdn: MSISDN,
      input: '2',
      session_state: { step: 1 },
    });
    expect(response.action).toBe('CON');
    expect(response.next_state).toMatchObject({ step: 2, intent: 'status' });
  });

  it('handles invalid input gracefully', async () => {
    const response = await adapter.handleUssdSession({
      session_key_hash: SESSION_KEY,
      msisdn: MSISDN,
      input: '9',
      session_state: { step: 1 },
    });
    expect(response.action).toBe('CON');
    expect(response.message).toContain('Invalid');
    expect(response.next_state).toEqual({ step: 1 });
  });

  it('ends session at final step', async () => {
    const response = await adapter.handleUssdSession({
      session_key_hash: SESSION_KEY,
      msisdn: MSISDN,
      input: 'confirm',
      session_state: { step: 2, intent: 'join' },
    });
    expect(response.action).toBe('END');
  });

  it('logs all session interactions', async () => {
    await adapter.handleUssdSession({
      session_key_hash: SESSION_KEY,
      msisdn: MSISDN,
      input: '',
      session_state: {},
    });
    const log = adapter.getSessionLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.session_key_hash).toBe(SESSION_KEY);
  });

  it('message respects max 182 character USSD limit', async () => {
    const response = await adapter.handleUssdSession({
      session_key_hash: SESSION_KEY,
      msisdn: MSISDN,
      input: '',
      session_state: {},
    });
    expect(response.message.length).toBeLessThanOrEqual(182);
  });

  it('all sandbox messages include the SANDBOX prefix', async () => {
    const steps = [
      { input: '', session_state: {} },
      { input: '1', session_state: { step: 1 } },
    ];
    for (const step of steps) {
      const response = await adapter.handleUssdSession({
        session_key_hash: SESSION_KEY,
        msisdn: MSISDN,
        ...step,
      });
      expect(response.message).toContain(SANDBOX_PREFIX);
    }
  });

  it('verifyWebhook returns true in sandbox mode', () => {
    expect(adapter.verifyWebhook({}, {})).toBe(true);
  });

  it('parseDeliveryReceipt throws (not an SMS adapter)', () => {
    expect(() => adapter.parseDeliveryReceipt({})).toThrow();
  });
});
