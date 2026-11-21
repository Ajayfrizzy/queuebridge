// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Facility, FacilityReadiness, SessionUser } from '@queuebridge/contracts';

/**
 * M7.2 review correction: the checklist uses readiness only for the facility it was loaded for.
 * The API is replaced by controllable promises so responses can be delayed and reordered.
 */
type Pending = { fid: string; resolve: (r: { readiness: FacilityReadiness }) => void };
const pending: Pending[] = [];
const FA = '00000000-0000-7000-8000-0000000000aa';
const FB = '00000000-0000-7000-8000-0000000000bb';
const facility = (id: string, name: string): Facility => ({
  id,
  name,
  slug: name.toLowerCase(),
  timezone: 'UTC',
  status: 'active',
  created_at: '2026-11-20T10:00:00.000Z',
});
vi.mock('../lib/api.js', () => ({
  api: {
    listFacilities: (): Promise<{ facilities: Facility[] }> =>
      Promise.resolve({ facilities: [facility(FA, 'Alpha'), facility(FB, 'Beta')] }),
    readiness: (fid: string): Promise<{ readiness: FacilityReadiness }> =>
      new Promise((resolve) => pending.push({ fid, resolve })),
  },
}));
const { Onboarding } = await import('./Onboarding.js');
const { createLandingI18n } = await import('./i18n.js');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ready = (ok: boolean): FacilityReadiness => ({
  configuration_ready: ok,
  facility_active: true,
  services: ok
    ? [
        {
          id: '00000000-0000-7000-8000-000000000001',
          name: 'S',
          status: 'active',
          operational: true,
          active_counter_count: 1,
          configured_counter_count: 1,
        },
      ]
    : [],
  counters: [],
  issues: [],
  visitor_join: { operational: true, reason: '' },
});
const admin = {
  id: 'u',
  email: 'a@example.test',
  display_name: 'A',
  organization: { id: 'o', name: 'O', slug: 'o' },
  roles: [{ role: 'org_admin', facility_id: null }],
} as unknown as SessionUser;

let container: HTMLDivElement;
let root: Root;
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
/** States of the service and counter steps (the two that readiness decides) */
const states = (): (string | null)[] =>
  [...container.querySelectorAll('[data-testid="onboarding-step"]')]
    .slice(2, 4)
    .map((li) => li.getAttribute('data-state'));
const links = (): string[] =>
  [...container.querySelectorAll('[data-testid="onboarding-step"] a')].map(
    (a) => a.getAttribute('href') ?? '',
  );
const select = async (fid: string): Promise<void> => {
  const el = container.querySelector('select') as HTMLSelectElement;
  await act(async () => {
    el.value = fid;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const answer = async (fid: string, r: FacilityReadiness): Promise<void> => {
  const p = pending.find((x) => x.fid === fid);
  if (!p) throw new Error(`no pending readiness request for ${fid}`);
  pending.splice(pending.indexOf(p), 1);
  await act(async () => {
    p.resolve({ readiness: r });
    await Promise.resolve();
  });
};

beforeEach(async () => {
  pending.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <I18nextProvider i18n={createLandingI18n()}>
          <Onboarding user={admin} />
        </I18nextProvider>
      </MemoryRouter>,
    );
  });
  await flush();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('M7.2 onboarding readiness follows the selected facility', () => {
  it('switching shows no state from the previous facility, not even before the new answer', async () => {
    await answer(FA, ready(true));
    expect(states()).toEqual(['done', 'done']);
    await select(FB);
    // Beta's readiness has not arrived: nothing is claimed, and Alpha's "done" is gone
    expect(states()).toEqual(['unknown', 'unknown']);
    expect(links()).toContain(`/admin/facilities/${FB}/services`);
    expect(links().some((h) => h.includes(FA))).toBe(false);
    await answer(FB, ready(false));
    expect(states()).toEqual(['todo', 'todo']);
  });

  it('a delayed answer for a facility no longer selected is ignored', async () => {
    // Alpha's request is still pending when the person switches to Beta
    await select(FB);
    await answer(FB, ready(false));
    expect(states()).toEqual(['todo', 'todo']);
    await answer(FA, ready(true)); // arrives late
    expect(states()).toEqual(['todo', 'todo']);
    // and switching back waits for Alpha's own fresh answer
    await select(FA);
    expect(states()).toEqual(['unknown', 'unknown']);
    await answer(FA, ready(true));
    expect(states()).toEqual(['done', 'done']);
  });

  it('returning to a facility while a slower answer for another is pending keeps them apart', async () => {
    await select(FB); // Alpha pending, Beta pending
    await select(FA); // Alpha requested again
    await answer(FB, ready(true)); // Beta answers while Alpha is selected
    expect(states()).toEqual(['unknown', 'unknown']);
    // the first (cancelled) Alpha request, then the current one
    await answer(FA, ready(true));
    await answer(FA, ready(false));
    expect(states()).toEqual(['todo', 'todo']);
  });
});
