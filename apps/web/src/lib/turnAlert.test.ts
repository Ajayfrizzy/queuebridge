import { beforeEach, describe, expect, it } from 'vitest';
import {
  applicationServerKey,
  callToAlert,
  lastAlertedSequence,
  markAlerted,
  parseAlertOpenParams,
  parseHandoff,
  pushSupport,
  type PushEnvironment,
} from './turnAlert.js';
import {
  otherTicketUsesPush,
  resolveByPushRef,
  saveTicket,
  setPushRef,
  storedTickets,
  ticketsWithCode,
} from './tickets.js';

/** Group 14 (14.1, 14.3, 14.13, 14.14), page-side rules without a browser. */
const REF_A = '0193a1b2-0000-4000-8000-00000000000a';
const REF_B = '0193a1b2-0000-4000-8000-00000000000b';
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('14.1 once per committed call event', () => {
  it('alerts only for a server-confirmed call with a committed sequence', () => {
    const none = { cached: false, alreadyAlerted: null };
    expect(callToAlert({ state: 'called', call_sequence: 7 }, none)).toBe(7);
    expect(callToAlert({ state: 'waiting', call_sequence: null }, none)).toBeNull();
    expect(callToAlert({ state: 'serving', call_sequence: null }, none)).toBeNull();
    // an offline copy never alerts, even if it says "called"
    expect(
      callToAlert({ state: 'called', call_sequence: 7 }, { ...none, cached: true }),
    ).toBeNull();
    // no committed call sequence (defensive): no alert
    expect(callToAlert({ state: 'called', call_sequence: null }, none)).toBeNull();
    expect(callToAlert(undefined, none)).toBeNull();
  });

  it('a refresh or replay of the same call does not repeat; a new call does', () => {
    const key = 'A012@Clinic/General';
    expect(lastAlertedSequence(key)).toBeNull();
    markAlerted(key, 7);
    const again = { cached: false, alreadyAlerted: lastAlertedSequence(key) };
    expect(callToAlert({ state: 'called', call_sequence: 7 }, again)).toBeNull();
    // a re-call (released, then called again) is a new committed event
    expect(callToAlert({ state: 'called', call_sequence: 9 }, again)).toBe(9);
    // tickets are independent
    expect(lastAlertedSequence('A012@Other/General')).toBeNull();
  });

  it('survives a page reload in the same tab (sessionStorage)', () => {
    markAlerted('k', 3);
    expect(JSON.parse(sessionStorage.getItem('qb.turnAlerted.v1') ?? '{}')).toEqual({ k: 3 });
  });
});

describe('14.13 / 14.14 notification identity: the reference, never the public code alone', () => {
  const base = {
    code: 'A012',
    token: 't'.repeat(43),
    serviceName: 'General',
    joinPath: null,
    savedAt: '2026-11-12T09:00:00.000Z',
  };

  it('two saved tickets with the same public code resolve separately by pushRef', () => {
    const a = saveTicket({ ...base, facilityName: 'Clinic A' });
    const b = saveTicket({ ...base, token: 'u'.repeat(43), facilityName: 'Clinic B' });
    expect(a && b).toBeTruthy();
    expect(setPushRef(a?.id ?? '', REF_A)).toBe(true);
    expect(setPushRef(b?.id ?? '', REF_B)).toBe(true);
    expect(ticketsWithCode('A012')).toHaveLength(2);
    expect(resolveByPushRef(REF_A)?.facilityName).toBe('Clinic A');
    expect(resolveByPushRef(REF_B)?.facilityName).toBe('Clinic B');
    // unknown reference: nothing, even though a ticket with the code exists
    expect(resolveByPushRef('0193a1b2-0000-4000-8000-0000000000ff')).toBeUndefined();
    expect(resolveByPushRef('')).toBeUndefined();
  });

  it('clearing a pushRef keeps the ticket; the shared browser subscription is tracked', () => {
    const a = saveTicket({ ...base, facilityName: 'Clinic A' });
    const b = saveTicket({ ...base, token: 'u'.repeat(43), facilityName: 'Clinic B' });
    setPushRef(a?.id ?? '', REF_A);
    setPushRef(b?.id ?? '', REF_B);
    expect(otherTicketUsesPush(a?.id ?? '')).toBe(true);
    setPushRef(b?.id ?? '', null);
    expect(otherTicketUsesPush(a?.id ?? '')).toBe(false);
    expect(storedTickets()).toHaveLength(2);
    expect(storedTickets().find((t) => t.id === b?.id)?.pushRef).toBeUndefined();
    // the pushRef is not a credential and the stored record holds no push secret
    const raw = localStorage.getItem('qb.tickets.v1') ?? '';
    expect(raw).not.toMatch(/endpoint|p256dh|auth"/);
    expect(setPushRef('missing', REF_A)).toBe(false);
  });

  it('open parameters are validated: no markup, no foreign redirect', () => {
    const ok = parseAlertOpenParams(
      new URLSearchParams(
        `ref=${REF_A}&seq=41&rp=${encodeURIComponent('/recover/acme/city/A012')}`,
      ),
    );
    expect(ok).toEqual({ ref: REF_A, seq: 41, rp: '/recover/acme/city/A012' });
    for (const rp of [
      'https://evil.example/recover/a/b/c',
      '//evil.example/recover/a/b/c',
      '/recover/a/b',
      '/recover/a/b/c?x=1',
      'javascript:alert(1)',
      '/recover/a/b/<script>',
    ]) {
      expect(parseAlertOpenParams(new URLSearchParams({ rp })).rp, rp).toBeNull();
    }
    expect(parseAlertOpenParams(new URLSearchParams('ref=A012&seq=-1'))).toEqual({
      ref: null,
      seq: null,
      rp: null,
    });
  });

  it('a service-worker hand-off must be ours and well-formed', () => {
    expect(
      parseHandoff({ type: 'qb-turn-alert', ref: REF_A, code: 'A012', seq: 4, counter: 'C 2' }),
    ).toEqual({ ref: REF_A, code: 'A012', seq: 4, counter: 'C 2', rp: null });
    expect(parseHandoff({ type: 'other', ref: REF_A, code: 'A012', seq: 4 })).toBeNull();
    expect(parseHandoff({ type: 'qb-turn-alert', ref: 'x', code: 'A012', seq: 4 })).toBeNull();
    expect(parseHandoff({ type: 'qb-turn-alert', ref: REF_A, code: '<b>', seq: 4 })).toBeNull();
    expect(parseHandoff({ type: 'qb-turn-alert', ref: REF_A, code: 'A012', seq: 0 })).toBeNull();
    expect(parseHandoff(null)).toBeNull();
    expect(parseHandoff('qb-turn-alert')).toBeNull();
  });
});

describe('14.3 push support is detected, never assumed', () => {
  const env = (o: Partial<PushEnvironment>): PushEnvironment => ({
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    isIos: false,
    isStandalone: false,
    ...o,
  });
  it('classifies supported, iOS-not-installed and unsupported', () => {
    expect(pushSupport(env({}))).toBe('supported');
    expect(pushSupport(env({ hasPushManager: false, isIos: true }))).toBe('ios_not_installed');
    // installed iOS app with push: supported
    expect(pushSupport(env({ isIos: true, isStandalone: true }))).toBe('supported');
    // installed but too old for push
    expect(pushSupport(env({ hasPushManager: false, isIos: true, isStandalone: true }))).toBe(
      'unsupported',
    );
    expect(pushSupport(env({ hasServiceWorker: false }))).toBe('unsupported');
    expect(pushSupport(env({ hasNotification: false }))).toBe('unsupported');
  });

  it('decodes the VAPID application server key (65-byte uncompressed P-256 point)', () => {
    const bytes = new Uint8Array(65).map((_, i) => (i === 0 ? 4 : i));
    const b64 = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect([...applicationServerKey(b64)]).toEqual([...bytes]);
  });
});
