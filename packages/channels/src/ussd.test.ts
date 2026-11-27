import { describe, expect, it } from 'vitest';
import { USSD_MAX_MESSAGE, type UssdResponse } from '@queuebridge/contracts';
import { SANDBOX_PREFIX } from './sandbox.js';
import {
  USSD_SERVICES_PER_PAGE,
  groupKey,
  runUssdMenu,
  ussdInputs,
  type UssdApplication,
  type UssdFacilityRef,
  type UssdJoinResult,
  type UssdServiceOption,
  type UssdTicketResult,
} from './ussd.js';

/**
 * M6.2 menu engine (REQ-F12.1, F12.3): navigation, Back/Exit, invalid-input recovery, paging,
 * the 182-character limit, idempotent confirm, and that no key ever enters the state. The
 * application here is an in-memory stand-in that records calls; the real one (API services on
 * PostgreSQL) is tested in apps/api/src/ussd.db.test.ts.
 */
const KEY = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
const FACILITY: UssdFacilityRef = {
  facilityId: 'f-1',
  organizationId: 'o-1',
  name: 'Lagos Island General Hospital Outpatients Wing',
};

interface Calls {
  join: { queueId: string; op: string }[];
  check: { code: string; key: string }[];
}
function fakeApp(o: {
  services?: UssdServiceOption[];
  join?: UssdJoinResult;
  check?: UssdTicketResult;
  /** services returned on the second and later listings (a service closing meanwhile) */
  later?: UssdServiceOption[];
}): { app: UssdApplication; calls: Calls } {
  const calls: Calls = { join: [], check: [] };
  let listings = 0;
  const app: UssdApplication = {
    findFacility: async (_c, code) => (code === '123456' ? FACILITY : null),
    listServices: async () => {
      listings += 1;
      return (listings > 1 && o.later ? o.later : o.services) ?? [];
    },
    join: async (_c, _f, queueId, op) => {
      calls.join.push({ queueId, op });
      return o.join ?? { ok: true, code: 'A012', service: 'General', recoveryKey: KEY };
    },
    checkTicket: async (_c, _f, code, key) => {
      calls.check.push({ code, key });
      return o.check ?? { ok: false, reason: 'failed' };
    },
  };
  return { app, calls };
}
const svc = (n: number, name = `Service ${n}`): UssdServiceOption => ({
  queueId: `q-${n}`,
  name,
  waiting: n,
  estimate: '10-20 min',
});

/** Drives the menu through `inputs`, threading the state as the API does. */
async function drive(app: UssdApplication, inputs: string[]): Promise<UssdResponse[]> {
  const out: UssdResponse[] = [];
  let state: Record<string, unknown> = {};
  for (const input of ['', ...inputs]) {
    const r = await runUssdMenu(
      { session_key_hash: 'sk', msisdn: 'mh', input, session_state: state },
      app,
      { label: SANDBOX_PREFIX },
    );
    out.push(r);
    state = r.next_state ?? {};
    if (r.action === 'END') break;
  }
  return out;
}
const last = (rs: UssdResponse[]): UssdResponse => rs[rs.length - 1] as UssdResponse;

describe('USSD menu: entering a facility (discovery)', () => {
  it('starts by asking for the facility code, labelled test only', async () => {
    const [r] = await drive(fakeApp({}).app, []);
    expect(r?.action).toBe('CON');
    expect(r?.message.startsWith(SANDBOX_PREFIX)).toBe(true);
    expect(r?.message).toContain('6-digit facility code');
  });
  it('a known code opens the facility menu; unknown or malformed codes are retried, then end', async () => {
    const { app } = fakeApp({});
    expect(last(await drive(app, ['123456'])).message).toContain('1 Join a queue');
    const unknown = await drive(app, ['999999', '888888', '777777']);
    expect(unknown[1]?.message).toContain('No facility has that code');
    expect(last(unknown)).toMatchObject({ action: 'END' });
    expect(last(unknown).message).toContain('No facility found');
    const malformed = await drive(app, ['12', 'abc', '0123456']);
    expect(malformed[1]?.message).toContain('Use 6 digits');
    expect(last(malformed).action).toBe('END');
    expect(last(malformed).message).toContain('Too many invalid entries');
  });
  it('lists only what the application offers, with paging and Back', async () => {
    const services = Array.from({ length: USSD_SERVICES_PER_PAGE + 2 }, (_, i) => svc(i + 1));
    const { app } = fakeApp({ services });
    const rs = await drive(app, ['123456', '1']);
    expect(last(rs).message).toContain('1 Service 1 (1 waiting)');
    expect(last(rs).message).toContain('8 More');
    const page2 = await drive(app, ['123456', '1', '8']);
    expect(last(page2).message).toContain(`1 Service ${USSD_SERVICES_PER_PAGE + 1}`);
    const back = await drive(app, ['123456', '1', '9']);
    expect(last(back).message).toContain('1 Join a queue');
  });
  it('says so when no service is taking visitors', async () => {
    const rs = await drive(fakeApp({ services: [] }).app, ['123456', '1']);
    expect(last(rs).message).toContain('is taking visitors right now');
    expect(last(rs).action).toBe('CON');
  });
});

describe('USSD menu: joining', () => {
  it('confirm joins once with the operation id fixed on the confirm screen; the key is shown grouped', async () => {
    const { app, calls } = fakeApp({ services: [svc(1, 'General')] });
    const rs = await drive(app, ['123456', '1', '1', '1']);
    const confirm = rs[3] as UssdResponse;
    expect(confirm.message).toContain('Join General? 1 waiting.');
    expect(confirm.message).toContain('not a promise');
    const op = (confirm.next_state as { joinOperationId: string }).joinOperationId;
    expect(op).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(calls.join).toEqual([{ queueId: 'q-1', op }]);
    const done = last(rs);
    expect(done.action).toBe('END');
    expect(done.message).toContain('Ticket A012, General.');
    expect(done.message).toContain(groupKey(KEY));
    expect(done.next_state).toMatchObject({ joined: { code: 'A012' } });
    // the key is in the one screen that issues it, never in the state
    expect(JSON.stringify(done.next_state)).not.toContain(KEY);
  });
  it('replaying the same confirm step reuses the same operation id (no second ticket upstream)', async () => {
    const { app, calls } = fakeApp({ services: [svc(1)] });
    const rs = await drive(app, ['123456', '1', '1']);
    const state = last(rs).next_state ?? {};
    for (let i = 0; i < 2; i++) {
      await runUssdMenu(
        { session_key_hash: 'sk', msisdn: 'mh', input: '1', session_state: state },
        app,
        {
          label: SANDBOX_PREFIX,
        },
      );
    }
    expect(new Set(calls.join.map((c) => c.op)).size).toBe(1);
  });
  it('a service that closed between the list and the choice is reported, not joined', async () => {
    const { app, calls } = fakeApp({ services: [svc(1, 'General')], later: [] });
    const rs = await drive(app, ['123456', '1', '1']);
    expect(last(rs).message).toContain('General is not taking visitors right now.');
    expect(calls.join).toEqual([]);
  });
  it.each([
    ['closed', 'has closed', 'CON'],
    ['paused', 'is paused', 'CON'],
    ['not_accepting', 'not taking visitors', 'CON'],
    ['limit', 'joined as many queues as allowed', 'END'],
    ['unavailable', 'Joining is not available right now', 'END'],
  ] as const)('a refused join (%s) explains it without a ticket', async (reason, text, action) => {
    const { app } = fakeApp({ services: [svc(1, 'General')], join: { ok: false, reason } });
    const r = last(await drive(app, ['123456', '1', '1', '1']));
    expect(r.message).toContain(text);
    expect(r.action).toBe(action);
    expect(JSON.stringify(r.next_state)).not.toContain('joined');
  });
  it('without recovery configured the join says status by phone is not available', async () => {
    const { app } = fakeApp({
      services: [svc(1)],
      join: { ok: true, code: 'A013', service: 'S', recoveryKey: null },
    });
    expect(last(await drive(app, ['123456', '1', '1', '1'])).message).toContain(
      'Checking this ticket by phone is not available here',
    );
  });
});

describe('USSD menu: status and recovery need the code AND the recovery key', () => {
  const ok: UssdTicketResult = {
    ok: true,
    code: 'B004',
    service: 'Pharmacy',
    state: 'waiting',
    ahead: 3,
    counter: null,
    estimate: '5-10 min',
    movedFrom: 'A012',
  };
  it('status: code, then key; the key goes to the check once and never into the state', async () => {
    const { app, calls } = fakeApp({ check: ok });
    const rs = await drive(app, ['123456', '2', 'a012', KEY]);
    expect(rs[3]?.message).toContain('Ticket A012.');
    expect(calls.check).toEqual([{ code: 'A012', key: KEY }]);
    const r = last(rs);
    expect(r.action).toBe('END');
    expect(r.message).toContain('Moved from A012.');
    expect(r.message).toContain('B004 Pharmacy: waiting, 3 ahead of you. About 5-10 min');
    for (const step of rs) expect(JSON.stringify(step.next_state ?? {})).not.toContain(KEY);
  });
  it.each([
    ['failed', 'could not open a ticket with these details'],
    ['throttled', 'Too many attempts'],
    ['unavailable', 'not available here right now'],
  ] as const)('a refused check (%s) ends with a uniform message', async (reason, text) => {
    const { app } = fakeApp({ check: { ok: false, reason } });
    const r = last(await drive(app, ['123456', '2', 'A012', 'WRONGKEY']));
    expect(r).toMatchObject({ action: 'END' });
    expect(r.message).toContain(text);
  });
  it('an invalid ticket code is retried; Back returns', async () => {
    const { app, calls } = fakeApp({});
    const rs = await drive(app, ['123456', '2', 'hello']);
    expect(last(rs).message).toContain('Not a ticket code');
    expect(last(await drive(app, ['123456', '2', '9'])).message).toContain('1 Join a queue');
    expect(last(await drive(app, ['123456', '2', 'A012', '9'])).message).toContain(
      'Enter your ticket code',
    );
    expect(calls.check).toEqual([]);
  });
  it('recovery with code and key names the current ticket', async () => {
    const { app } = fakeApp({
      check: { ...ok, state: 'called', counter: 'Counter 2', ahead: null },
    });
    const r = last(await drive(app, ['123456', '3', '1', 'A012', KEY]));
    expect(r.message).toContain('Your ticket is B004.');
    expect(r.message).toContain('called. Go to Counter 2 now.');
  });
  it('lost code or key: honest staff guidance, nothing is looked up', async () => {
    const { app, calls } = fakeApp({});
    const r = last(await drive(app, ['123456', '3', '2']));
    expect(r.action).toBe('END');
    expect(r.message).toContain('Ask staff at');
    expect(r.message).toContain('A phone number or a ticket code alone cannot open a ticket.');
    expect(calls.check).toEqual([]);
  });
});

describe('USSD menu: limits and exits', () => {
  it('0 exits from any screen', async () => {
    for (const path of [[], ['123456'], ['123456', '1'], ['123456', '2'], ['123456', '3']]) {
      const r = last(await drive(fakeApp({ services: [svc(1)] }).app, [...path, '0']));
      expect(r.action).toBe('END');
      expect(r.message).toContain('Goodbye');
    }
  });
  it('three invalid choices in a row end the session', async () => {
    const r = last(await drive(fakeApp({}).app, ['123456', '7', '7', '7']));
    expect(r.action).toBe('END');
    expect(r.message).toContain('Too many invalid entries');
  });
  it('every screen stays within 182 characters, with long names and big numbers', async () => {
    const long = 'Paediatric Emergency and Immunisation Clinic Annex';
    const services = Array.from({ length: 9 }, (_, i) => ({
      ...svc(i + 1, `${long} ${i}`),
      waiting: 9999,
      estimate: '120-240 min',
    }));
    const paths = [
      [],
      ['123456'],
      ['123456', '1'],
      ['123456', '1', '8'],
      ['123456', '1', '1'],
      ['123456', '1', '1', '1'],
      ['123456', '2', 'ABC1234'],
      ['123456', '2', 'ABC1234', KEY],
      ['123456', '3'],
      ['123456', '3', '2'],
      ['123456', '3', '1', 'A012', KEY],
    ];
    for (const path of paths) {
      const { app } = fakeApp({
        services,
        join: { ok: true, code: 'ABC1234', service: long, recoveryKey: KEY },
        check: {
          ok: true,
          code: 'ABC1234',
          service: long,
          state: 'waiting',
          ahead: 9999,
          counter: null,
          estimate: '120-240 min',
          movedFrom: 'XYZ9999',
        },
      });
      for (const r of await drive(app, path)) {
        expect(r.message.length, `${path.join('*')}: ${r.message}`).toBeLessThanOrEqual(
          USSD_MAX_MESSAGE,
        );
        expect(r.message.startsWith(SANDBOX_PREFIX)).toBe(true);
      }
    }
  });
  it('splits the provider text into inputs', () => {
    expect(ussdInputs('')).toEqual([]);
    expect(ussdInputs('123456*1*2')).toEqual(['123456', '1', '2']);
  });
});
