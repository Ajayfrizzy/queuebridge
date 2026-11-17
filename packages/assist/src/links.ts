import { ROUTE_IDS, type RoleGrant, type RouteId } from '@queuebridge/contracts';
import { holdsPermission } from './audiences.js';
import { ROUTE_REGISTRY } from './registry.js';

/**
 * Safe navigation (REQ-F13.1.2, design §11.3). Que offers a link only to a registered, linkable
 * screen the user's roles permit at the current facility, built from context it already has.
 * A link never carries a query string, a fragment or a credential.
 */

/** What Que knows about where the user is. All values come from the current page, not input. */
export interface NavigationContext {
  /** Server-derived grants of the signed-in user; `null` for an anonymous visitor. */
  grants: readonly RoleGrant[] | null;
  /** Facility of the current screen, when there is one. */
  facilityId: string | null;
  /** Queue session of the current screen (staff console / audit), when there is one. */
  queueId?: string | null;
  /** Public slugs of the current facility (visitor join / display), when known. */
  orgSlug?: string | null;
  facilitySlug?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Whether the user may open the screen at the context facility (advisory; the API decides). */
export function isRoutePermitted(id: RouteId, ctx: NavigationContext): boolean {
  const entry = ROUTE_REGISTRY[id];
  switch (entry.access.kind) {
    case 'public':
      return true;
    case 'credential':
      return false;
    case 'signed_in':
      return ctx.grants !== null;
    case 'permission':
      return holdsPermission(ctx.grants, ctx.facilityId, entry.access.permission);
  }
}

/** Every RouteId Que may link to for this context, in registry order. */
export function permittedLinks(ctx: NavigationContext): RouteId[] {
  return ROUTE_IDS.filter((id) => buildPath(id, ctx) !== null);
}

/**
 * The concrete path for a link, or `null` when Que must not offer it: unregistered, not
 * linkable, not permitted, or a required parameter is missing or malformed.
 */
export function buildPath(id: RouteId, ctx: NavigationContext): string | null {
  const entry = ROUTE_REGISTRY[id];
  if (!entry.linkable || !isRoutePermitted(id, ctx)) return null;
  switch (entry.scope) {
    case 'none':
      return entry.path;
    case 'facility': {
      const f = ctx.facilityId;
      if (!f || !UUID.test(f)) return null;
      return entry.path.replace(/:(id|fid)\b/, encodeURIComponent(f));
    }
    case 'queue': {
      const q = ctx.queueId;
      if (!q || !UUID.test(q)) return null;
      return entry.path.replace(':queueId', encodeURIComponent(q));
    }
    case 'facility_slugs': {
      const o = ctx.orgSlug;
      const s = ctx.facilitySlug;
      if (!o || !s || !SLUG.test(o) || !SLUG.test(s)) return null;
      return entry.path
        .replace(':orgSlug', encodeURIComponent(o))
        .replace(':facilitySlug', encodeURIComponent(s));
    }
  }
}
