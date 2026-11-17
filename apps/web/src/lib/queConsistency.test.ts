import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Permission, QueueAction, TicketState } from '@queuebridge/contracts';
import { TRANSITION_RULES } from '@queuebridge/domain';
import { ROUTE_REGISTRY, UNREGISTERED_PATHS, operationRoles } from '@queuebridge/assist';
import { COUNTER_ROLES, QUEUE_MANAGER_ROLES, WALK_IN_ROLES } from './permissions.js';

/**
 * MQ.1 decision D3 — consistency between the Ask Que route registry, the web router and the
 * web UI's own role hints. The UI hints are checked, not rewired (no RBAC redesign).
 */

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/**
 * Full paths declared by `<Route>` elements in App.tsx, resolving nested relative paths.
 * Handles self-closing and parent routes, attributes over several lines, and JSX inside braces.
 */
function routerPaths(src: string): string[] {
  const out: string[] = [];
  const stack: (string | null)[] = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('</Route>', i)) {
      stack.pop();
      i += 8;
      continue;
    }
    if (src.startsWith('<Route', i) && /[\s>]/.test(src[i + 6] ?? '')) {
      // Scan to the end of the opening tag, skipping `{...}` (which may contain `/>`)
      let j = i + 6;
      let depth = 0;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '>' && depth === 0) break;
        j++;
      }
      const tag = src.slice(i, j + 1);
      const selfClosing = tag.endsWith('/>');
      const attrs = tag.replace(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '{}');
      const m = /\bpath="([^"]+)"/.exec(attrs);
      const isIndex = /\bindex\b/.test(attrs);
      const parent = [...stack].reverse().find((p) => p !== null) ?? '';
      let full: string | null = null;
      if (m) {
        const p = m[1]!;
        full = p.startsWith('/') ? p : `${parent.replace(/\/$/, '')}/${p}`;
        out.push(full);
      } else if (isIndex && parent) {
        out.push(parent);
      }
      if (!selfClosing) stack.push(full);
      i = j + 1;
      continue;
    }
    i++;
  }
  return [...new Set(out)];
}

const APP = read('../App.tsx');
const PATHS = routerPaths(APP);

describe('D3 check 2: Que registry ⇔ web router', () => {
  it('parses the router (sanity)', () => {
    expect(PATHS).toContain('/');
    expect(PATHS).toContain('/admin/facilities/:id/staff');
    expect(PATHS).toContain('/staff/queues/:queueId/audit');
    expect(PATHS).toContain('/supervisor/*');
  });

  it('every registered Que route exists in the router', () => {
    for (const e of Object.values(ROUTE_REGISTRY)) expect(PATHS).toContain(e.path);
  });

  it('every router path is either registered or deliberately unregistered', () => {
    const registered = new Set(Object.values(ROUTE_REGISTRY).map((e) => e.path));
    const unregistered = PATHS.filter((p) => !registered.has(p)).sort();
    // A new route forces an explicit decision here (register it, or list it as unregistered)
    expect(unregistered).toEqual(
      [
        '/admin/facilities/:id/counters',
        '/admin/facilities/:id/services',
        '/recover/:orgSlug/:facilitySlug',
        '/recover/:orgSlug/:facilitySlug/:code',
        '/supervisor/*',
      ].sort(),
    );
    for (const p of UNREGISTERED_PATHS) expect(registered.has(p)).toBe(false);
  });
});

describe('D3 check 3: frontend role assumptions match the shared permission map', () => {
  const set = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

  it('QUEUE_MANAGER_ROLES = QUEUE_MANAGE; WALK_IN_ROLES = WALK_IN', () => {
    expect(set(QUEUE_MANAGER_ROLES)).toEqual(set(Permission.QUEUE_MANAGE));
    expect(set(WALK_IN_ROLES)).toEqual(set(Permission.WALK_IN));
  });

  it('COUNTER_ROLES = the call-next roles of the ticket state machine', () => {
    const callNext = operationRoles(
      { action: QueueAction.TICKET_CALL_NEXT, from: TicketState.WAITING },
      TRANSITION_RULES,
    ).filter((r) => r !== 'org_admin');
    expect(set(COUNTER_ROLES)).toEqual(set(callNext));
  });

  it('the staff console audit-link roles = AUDIT_VIEW', () => {
    const m = /const AUDIT_ROLES = \[([^\]]*)\]/.exec(read('../pages/StaffConsole.tsx'));
    expect(m).not.toBeNull();
    const roles = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
    expect(set(roles)).toEqual(set(Permission.AUDIT_VIEW));
  });

  it('the staff home connectivity-link roles = OPERATIONS_VIEW', () => {
    const src = read('../pages/StaffHome.tsx');
    const m =
      /hasFacilityRole\(user, fid, \[([^\]]*)\]\) \? \(\s*<p>\s*<Link to=\{`\/staff\/facilities\/\$\{fid\}\/connectivity`\}/.exec(
        src,
      );
    expect(m).not.toBeNull();
    const roles = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
    expect(set(roles)).toEqual(set(Permission.OPERATIONS_VIEW));
  });
});
