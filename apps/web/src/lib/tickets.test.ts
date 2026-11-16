import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketStatus } from '@queuebridge/contracts';
import {
  beginJoin,
  finishJoin,
  findTicketById,
  forgetTicket,
  isPendingVolatile,
  pendingJoins,
  saveTicket,
  storedTickets,
  ticketPath,
  ticketsWithCode,
} from './tickets.js';

const base = {
  token: 't'.repeat(43),
  facilityName: 'Clinic A',
  serviceName: 'General',
  joinPath: '/join/a/clinic',
  savedAt: '2026-11-06T09:00:00.000Z',
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of pendingJoins()) finishJoin(p.queueId);
});

describe('saved tickets are scoped by a device-local id, not the public code', () => {
  it('keeps two tickets that share a public code (different facilities)', () => {
    const a = saveTicket({ ...base, code: 'A001' });
    const b = saveTicket({
      ...base,
      code: 'A001',
      token: 'u'.repeat(43),
      facilityName: 'Clinic B',
    });
    expect(a && b && a.id !== b.id).toBe(true);
    expect(
      ticketsWithCode('A001')
        .map((t) => t.facilityName)
        .sort(),
    ).toEqual(['Clinic A', 'Clinic B']);
    expect(findTicketById(a!.id)?.facilityName).toBe('Clinic A');
    expect(findTicketById(b!.id)?.token).toBe('u'.repeat(43));
  });

  it('updates the same entry in place (transfer changes the code) and forgets only one', () => {
    const a = saveTicket({ ...base, code: 'A001' })!;
    const b = saveTicket({ ...base, code: 'A001', facilityName: 'Clinic B' })!;
    saveTicket({ ...a, code: 'B004' });
    expect(storedTickets()).toHaveLength(2);
    expect(findTicketById(a.id)?.code).toBe('B004');
    forgetTicket(a.id);
    expect(storedTickets().map((t) => t.id)).toEqual([b.id]);
  });

  it('links carry the local id; legacy entries without one get a stable id', () => {
    localStorage.setItem('qb.tickets.v1', JSON.stringify([{ ...base, code: 'C007' }]));
    const [legacy] = storedTickets();
    expect(legacy?.id).toBe('legacy-C007');
    expect(storedTickets()[0]?.id).toBe(legacy?.id);
    expect(ticketPath(legacy!)).toBe('/ticket/C007?k=legacy-C007');
    forgetTicket('legacy-C007');
    expect(storedTickets()).toHaveLength(0);
  });

  it('reports failure when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(saveTicket({ ...base, code: 'A001' })).toBeNull();
  });
});

describe('pending joins survive storage failure for the life of the page', () => {
  it('persists the idempotency key before sending and reuses it on retry', () => {
    const p = beginJoin('q1', 'General');
    expect(isPendingVolatile('q1')).toBe(false);
    expect(JSON.parse(localStorage.getItem('qb.pendingJoins.v1')!)).toHaveLength(1);
    expect(beginJoin('q1', 'General')).toEqual(p);
    finishJoin('q1');
    expect(pendingJoins()).toHaveLength(0);
  });

  it('keeps the key in memory when storage is unavailable, so a retry reuses it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const p = beginJoin('q2', 'General');
    expect(isPendingVolatile('q2')).toBe(true);
    const retry = beginJoin('q2', 'General');
    expect(retry.operationId).toBe(p.operationId);
    expect(retry.joinProof).toBe(p.joinProof);
    expect(pendingJoins().map((x) => x.queueId)).toEqual(['q2']);
    finishJoin('q2');
    expect(isPendingVolatile('q2')).toBe(false);
    expect(pendingJoins()).toHaveLength(0);
  });
});

describe('offline last-confirmed ticket copy (REQ-F7.16)', () => {
  const status = {
    public_code: 'A001',
    state: 'waiting',
  } as unknown as TicketStatus;
  it('holds no credential and is removed when the ticket is forgotten', async () => {
    const { forgetTicket, loadSnapshot, saveSnapshot, saveTicket } = await import('./tickets.js');
    const saved = saveTicket({
      code: 'A001',
      token: 'T'.repeat(43),
      facilityName: 'F',
      serviceName: 'S',
      joinPath: null,
      savedAt: new Date().toISOString(),
    });
    expect(saved).not.toBeNull();
    saveSnapshot(saved!.id, status);
    expect(loadSnapshot(saved!.id)?.status.public_code).toBe('A001');
    // the stored copy never contains the token
    expect(localStorage.getItem('qb.ticketView.v1')).not.toContain('T'.repeat(43));
    forgetTicket(saved!.id);
    expect(loadSnapshot(saved!.id)).toBeNull();
  });
  it('dropSnapshot removes only that ticket', async () => {
    const { dropSnapshot, loadSnapshot, saveSnapshot } = await import('./tickets.js');
    saveSnapshot('a', status);
    saveSnapshot('b', status);
    dropSnapshot('a');
    expect(loadSnapshot('a')).toBeNull();
    expect(loadSnapshot('b')).not.toBeNull();
  });
});
