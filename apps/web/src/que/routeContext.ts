import { matchPath } from 'react-router-dom';
import { ROUTE_IDS, type RouteId } from '@queuebridge/contracts';
import { ROUTE_REGISTRY } from '@queuebridge/assist';

/**
 * Which registered screen the browser is on (MQ.3; design §11.3.1), using the registry's own
 * React Router patterns. An exact match wins; otherwise the longest registered prefix (for
 * example `/admin/facilities/:id/services` → `admin.facility`, `/recover/a/b` →
 * `visitor.recover`). `/` never matches as a prefix. Unregistered screens such as the
 * `/supervisor/*` placeholder resolve to no screen.
 */
export interface QueRoute {
  routeId: RouteId | null;
  /** Facility from the path (`:id` / `:fid`), when the screen has one. */
  facilityId: string | null;
  queueId: string | null;
  orgSlug: string | null;
  facilitySlug: string | null;
}

const NONE: QueRoute = {
  routeId: null,
  facilityId: null,
  queueId: null,
  orgSlug: null,
  facilitySlug: null,
};

function contextOf(id: RouteId, params: Record<string, string | undefined>): QueRoute {
  return {
    routeId: id,
    facilityId: params['id'] ?? params['fid'] ?? null,
    queueId: params['queueId'] ?? null,
    orgSlug: params['orgSlug'] ?? null,
    facilitySlug: params['facilitySlug'] ?? null,
  };
}

export function matchQueRoute(pathname: string): QueRoute {
  if (pathname.startsWith('/supervisor')) return NONE;
  for (const id of ROUTE_IDS) {
    const m = matchPath({ path: ROUTE_REGISTRY[id].path, end: true }, pathname);
    if (m) return contextOf(id, m.params);
  }
  let best: { id: RouteId; params: Record<string, string | undefined>; len: number } | null = null;
  for (const id of ROUTE_IDS) {
    const path = ROUTE_REGISTRY[id].path;
    if (path === '/') continue;
    const m = matchPath({ path, end: false }, pathname);
    if (m && (!best || path.length > best.len)) best = { id, params: m.params, len: path.length };
  }
  return best ? contextOf(best.id, best.params) : NONE;
}
