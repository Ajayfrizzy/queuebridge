import { describe, expect, it } from 'vitest';
import { ROUTE_IDS } from '@queuebridge/contracts';
import { ROUTE_REGISTRY } from '@queuebridge/assist';
import { matchQueRoute } from './routeContext.js';

const F = '0193a000-0000-7000-8000-00000000000a';
const Q = '0193a000-0000-7000-8000-0000000000a1';

describe('matchQueRoute (route-context synchronization)', () => {
  it('maps every registered path pattern to its RouteId', () => {
    const sample: Record<string, string> = {
      ':id': F,
      ':fid': F,
      ':queueId': Q,
      ':orgSlug': 'acme',
      ':facilitySlug': 'main',
      ':code': 'A123',
    };
    for (const id of ROUTE_IDS) {
      const path = ROUTE_REGISTRY[id].path.replace(/:[A-Za-z]+/g, (p) => sample[p] ?? p);
      expect(matchQueRoute(path).routeId).toBe(id);
    }
  });

  it('extracts the facility, queue and public slugs from the path', () => {
    expect(matchQueRoute(`/staff/facilities/${F}/connectivity`)).toMatchObject({
      routeId: 'staff.connectivity',
      facilityId: F,
    });
    expect(matchQueRoute(`/admin/facilities/${F}/staff`)).toMatchObject({
      routeId: 'admin.facility.staff',
      facilityId: F,
    });
    expect(matchQueRoute(`/staff/queues/${Q}/audit`)).toMatchObject({
      routeId: 'staff.audit',
      queueId: Q,
      facilityId: null,
    });
    expect(matchQueRoute('/join/acme/main')).toMatchObject({
      routeId: 'visitor.join',
      orgSlug: 'acme',
      facilitySlug: 'main',
    });
  });

  it('falls back to the longest registered prefix for unregistered sub-screens', () => {
    expect(matchQueRoute(`/admin/facilities/${F}/services`)).toMatchObject({
      routeId: 'admin.facility',
      facilityId: F,
    });
    expect(matchQueRoute('/recover/acme/main/A123').routeId).toBe('visitor.recover');
  });

  it('the /supervisor placeholder and unknown paths resolve to no screen (never "/")', () => {
    for (const p of ['/supervisor', '/supervisor/anything', '/nope', '/staffx']) {
      expect(matchQueRoute(p).routeId).toBeNull();
    }
    expect(matchQueRoute('/').routeId).toBe('public.home');
  });
});
