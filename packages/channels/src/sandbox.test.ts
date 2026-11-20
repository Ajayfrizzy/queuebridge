import { describe, expect, it, beforeEach } from 'vitest';
import { DeliveryStatus } from '@queuebridge/contracts';
import {
  SANDBOX_PREFIX,
  SANDBOX_SMS_SCENARIOS,
  SandboxSmsAdapter,
  SandboxUssdAdapter,
} from './sandbox.js';
import { signSmsWebhook } from './sms.js';
import { signUssdWebhook } from './ussd.js';

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
// SandboxUssdAdapter (M6.2 Group 10 contract; replaces the M0 placeholder, which accepted every
// webhook, logged every input and had no real flows). The menu itself is tested in ussd.test.ts.
// ---------------------------------------------------------------------------

describe('SandboxUssdAdapter', () => {
  const SECRET = 'test-only-ussd-webhook-secret-0123456789abcdef';
  let adapter: SandboxUssdAdapter;
  beforeEach(() => {
    adapter = new SandboxUssdAdapter({ webhookSecret: SECRET });
  });

  it('is the TEST-ONLY sandbox provider', () => {
    expect(adapter.provider).toBe('sandbox');
    expect(adapter.sandbox).toBe(true);
  });

  it('verifies the USSD signature over the raw body; refuses unsigned, wrong, stale, SMS-signed or secretless requests', () => {
    const body = '{"session_id":"sess_0001","msisdn":"+2348011111111","text":""}';
    expect(adapter.verifyWebhook(signUssdWebhook(SECRET, body), body)).toBe(true);
    expect(adapter.verifyWebhook({}, body)).toBe(false);
    expect(adapter.verifyWebhook(signUssdWebhook('x'.repeat(48), body), body)).toBe(false);
    expect(adapter.verifyWebhook(signUssdWebhook(SECRET, body), `${body} `)).toBe(false);
    const stale = signUssdWebhook(SECRET, body, {
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(adapter.verifyWebhook(stale, body)).toBe(false);
    // an SMS signature with the same secret, header names renamed, never verifies here
    const sms = signSmsWebhook(SECRET, body);
    const renamed = Object.fromEntries(
      Object.entries(sms).map(([k, v]) => [k.replace('-sms-', '-ussd-'), v]),
    );
    expect(adapter.verifyWebhook(renamed, body)).toBe(false);
    expect(new SandboxUssdAdapter().verifyWebhook(signUssdWebhook(SECRET, body), body)).toBe(false);
    // a parsed object is not the raw representation
    expect(adapter.verifyWebhook(signUssdWebhook(SECRET, body), JSON.parse(body))).toBe(false);
  });

  it('parses only the exact sandbox request shape', () => {
    expect(
      adapter.parseUssdRequest({
        session_id: 'sess_0001',
        msisdn: '+2348011111111',
        text: '1*123456',
      }),
    ).toEqual({ sessionId: 'sess_0001', msisdn: '+2348011111111', text: '1*123456' });
    expect(
      adapter.parseUssdRequest({
        session_id: 'sess_0001',
        msisdn: '2348011111111',
        text: '',
        service_code: '*000#',
      }),
    ).not.toBeNull();
    for (const bad of [
      null,
      [],
      'x',
      {},
      { session_id: 'short', msisdn: '+2348011111111', text: '' },
      { session_id: 'sess_0001', msisdn: 'call me', text: '' },
      { session_id: 'sess_0001', msisdn: '+2348011111111', text: 'a'.repeat(241) },
      { session_id: 'sess_0001', msisdn: '+2348011111111', text: '<script>' },
      { session_id: 'sess_0001', msisdn: '+2348011111111', text: '', extra: 1 },
      { session_id: 'sess_0001', msisdn: '+2348011111111', text: 1 },
    ]) {
      expect(adapter.parseUssdRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('renders the CON/END text contract', () => {
    expect(adapter.renderUssdResponse({ action: 'CON', message: '[SANDBOX] Hi' })).toEqual({
      contentType: 'text/plain; charset=utf-8',
      body: 'CON [SANDBOX] Hi',
    });
    expect(adapter.renderUssdResponse({ action: 'END', message: 'x' }).body).toBe('END x');
  });

  it('without an application it ends politely; it pushes nothing and handles no receipts', async () => {
    const r = await adapter.handleUssdSession({ session_key_hash: 'h', msisdn: 'm', input: '' });
    expect(r).toMatchObject({ action: 'END' });
    expect(r.message).toContain(SANDBOX_PREFIX);
    expect(
      (
        await adapter.sendMessage({
          to: '+2348011111111',
          template_key: 'ticket.called',
          params: { code: 'A001' },
          idempotency_key: 'k',
          sandbox: true,
        })
      ).status,
    ).toBe(DeliveryStatus.FAILED);
    expect(() => adapter.parseDeliveryReceipt({})).toThrow();
    expect(adapter.parseInboundMessage({})).toBeNull();
  });

  it('never logs (inputs can contain a recovery key)', async () => {
    const spy = [console.log, console.info, console.warn, console.error];
    const lines: unknown[] = [];
    console.log = console.info = console.warn = console.error = (...a: unknown[]) => lines.push(a);
    try {
      await adapter.handleUssdSession({ session_key_hash: 'h', msisdn: 'm', input: 'ABCD' });
    } finally {
      [console.log, console.info, console.warn, console.error] = spy as [
        typeof console.log,
        typeof console.log,
        typeof console.log,
        typeof console.log,
      ];
    }
    expect(lines).toEqual([]);
  });
});
