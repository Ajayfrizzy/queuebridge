import { createHash } from 'node:crypto';
import { AUDIENCE_MAPPING_VERSION } from '@queuebridge/assist';
import type { AuthContext } from './rbac.js';

/** Domain separator of the role fingerprint (design §11.5.4). */
export const ROLE_DIGEST_DOMAIN = 'qb.que.role-digest.v1';

/**
 * The single, authoritative role fingerprint of a session (MQ.2, decision D2; design §11.5.4).
 *
 * SHA-256 over: domain separator, organization ID, staff user ID, the audience-mapping version,
 * and the session's role grants `(facility_id or null, role)` sorted canonically — exactly the
 * grants the server authorizes with (`AuthContext.roles`, loaded per request). Any role grant,
 * revocation, facility change or mapping change produces a different digest. Every Ask Que
 * endpoint that issues restricted content uses this function; nothing else (and nothing in the
 * browser) computes a digest.
 */
export function roleDigest(
  auth: Pick<AuthContext, 'organizationId' | 'staffUserId' | 'roles'>,
): string {
  const grants = auth.roles
    .map((g) => [g.facility_id, g.role] as const)
    .sort((a, b) => {
      const fa = a[0] ?? '';
      const fb = b[0] ?? '';
      if (fa !== fb) return fa < fb ? -1 : 1;
      return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    });
  const canonical = JSON.stringify([
    ROLE_DIGEST_DOMAIN,
    auth.organizationId,
    auth.staffUserId,
    AUDIENCE_MAPPING_VERSION,
    grants,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
