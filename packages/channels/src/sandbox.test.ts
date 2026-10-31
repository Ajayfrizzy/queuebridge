import { describe, expect, it, beforeEach } from 'vitest';
import { DeliveryStatus } from '@queuebridge/contracts';
import { SANDBOX_PREFIX, SandboxSmsAdapter, SandboxUssdAdapter } from './sandbox.js';

// ---------------------------------------------------------------------------
// SandboxSmsAdapter
// ---------------------------------------------------------------------------

describe('SandboxSmsAdapter', () => {
  let adapter: SandboxSmsAdapter;

  beforeEach(() => {
    adapter = new SandboxSmsAdapter();
  });

  it('returns DELIVERED status without making real network calls', async () => {
    const result = await adapter.sendMessage({
      to: '+2348012345678',
      template_key: 'ticket.confirmed',
      params: { code: 'A001' },
      idempotency_key: 'test-key-001',
      sandbox: true,
    });
    expect(result.status).toBe(DeliveryStatus.DELIVERED);
    expect(result.sandbox).toBe(true);
  });

  it('includes the SANDBOX prefix in the provider_message_id', async () => {
    const result = await adapter.sendMessage({
      to: '+2348012345678',
      template_key: 'ticket.confirmed',
      params: {},
      idempotency_key: 'test-key-002',
      sandbox: true,
    });
    expect(result.provider_message_id).toContain('sandbox-');
  });

  it('records sent messages for test assertions', async () => {
    await adapter.sendMessage({
      to: '+2348012345678',
      template_key: 'ticket.confirmed',
      params: {},
      idempotency_key: 'test-key-003',
      sandbox: true,
    });
    expect(adapter.getSentMessages()).toHaveLength(1);
    expect(adapter.getSentMessages()[0]?.idempotency_key).toBe('test-key-003');
  });

  it('clears message log on clearSentMessages', async () => {
    await adapter.sendMessage({
      to: '+1',
      template_key: 'test',
      params: {},
      idempotency_key: 'k1',
      sandbox: true,
    });
    adapter.clearSentMessages();
    expect(adapter.getSentMessages()).toHaveLength(0);
  });

  it('verifyWebhook returns true in sandbox mode', () => {
    expect(adapter.verifyWebhook({}, {})).toBe(true);
  });

  it('parseDeliveryReceipt handles a valid payload', () => {
    const receipt = adapter.parseDeliveryReceipt({ provider_message_id: 'msg-123' });
    expect(receipt.provider_message_id).toBe('msg-123');
    expect(receipt.status).toBe(DeliveryStatus.DELIVERED);
  });

  it('parseDeliveryReceipt throws on invalid payload', () => {
    expect(() => adapter.parseDeliveryReceipt({ no_id: true })).toThrow();
  });

  it('parseInboundMessage returns null (SMS adapter)', () => {
    expect(adapter.parseInboundMessage({})).toBeNull();
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
