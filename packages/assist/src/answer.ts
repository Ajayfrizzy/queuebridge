import {
  Permission,
  type KbArticle,
  type QueAnswer,
  type Role,
  type RouteId,
} from '@queuebridge/contracts';
import { ROLE_NAMES, audiencesFor } from './audiences.js';
import { capabilityNotice, gateFor, type CapabilityGate } from './capabilities.js';
import { buildPath, isRoutePermitted, type NavigationContext } from './links.js';
import { ROUTE_REGISTRY } from './registry.js';
import { buildIndex, search, tokenize } from './search.js';

/**
 * Deterministic answer builder (design §11.4). Pure: no network, no inference, no clock. Every
 * citation is an article the user's audiences may read and whose capabilities may be shown;
 * every link is a screen the user may open at the current facility.
 */

export interface KbBundle {
  kbVersion: number;
  articles: readonly KbArticle[];
}

export interface AnswerContext extends NavigationContext {
  /** Current screen; `null` when unknown (no screen defaults, no screen boost). */
  routeId: RouteId | null;
  /** Capability manifest (server-issued; possibly a cached snapshot). Untrusted shape. */
  manifest: unknown;
}

export const MAX_CITATIONS = 5;
export const MAX_LINKS = 5;
export const ASK_STAFF = 'You can also ask a member of staff.';

/** Plain screen names for "which role is required" text. */
export const SCREEN_NAMES: Readonly<Record<RouteId, string>> = {
  'public.home': 'the home page',
  'public.signup': 'organization sign-up',
  'public.login': 'sign-in',
  'public.accept_invite': 'the invitation page',
  'visitor.join': 'the join page',
  'visitor.ticket': 'your ticket page',
  'visitor.recover': 'ticket recovery',
  'public.display': 'the public display board',
  'admin.home': 'administration',
  'admin.facility': 'facility settings',
  'admin.facility.staff': 'facility staff management',
  'staff.home': 'the staff console',
  'staff.facility': "the facility's queues",
  'staff.console': 'the queue console',
  'staff.audit': 'the audit trail',
  'staff.connectivity': 'connectivity and recovery',
};

export interface ArticleView {
  article: KbArticle;
  gate: Exclude<CapabilityGate, 'blocked'>;
}

/**
 * Articles the user may read (audience) split by capability gate. `blocked` articles are never
 * cited; they only produce "not set up here" / "not available yet" notices.
 */
export function partitionArticles(
  bundle: KbBundle,
  ctx: Pick<AnswerContext, 'grants' | 'manifest'>,
): { visible: ArticleView[]; blocked: KbArticle[] } {
  const audiences = new Set(audiencesFor(ctx.grants));
  const visible: ArticleView[] = [];
  const blocked: KbArticle[] = [];
  for (const article of bundle.articles) {
    if (!article.audiences.some((a) => audiences.has(a))) continue;
    const gate = gateFor(ctx.manifest, article.requiresCapabilities);
    if (gate === 'blocked') blocked.push(article);
    else visible.push({ article, gate });
  }
  return { visible, blocked };
}

function roleRequirementNotice(id: RouteId): string | null {
  const access = ROUTE_REGISTRY[id].access;
  if (access.kind !== 'permission') return null;
  const roles: readonly Role[] = [...Permission[access.permission], 'org_admin'];
  return `Opening ${SCREEN_NAMES[id]} needs one of these roles: ${roles
    .map((r) => ROLE_NAMES[r])
    .join(', ')}.`;
}

function uniq<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

function linksAndRoleNotices(
  articles: readonly KbArticle[],
  ctx: AnswerContext,
): { links: RouteId[]; notices: string[] } {
  const links: RouteId[] = [];
  const notices: string[] = [];
  for (const id of uniq(articles.flatMap((a) => a.relatedRoutes))) {
    if (buildPath(id, ctx) !== null) {
      if (links.length < MAX_LINKS) links.push(id);
    } else if (ctx.grants !== null && !isRoutePermitted(id, ctx)) {
      const n = roleRequirementNotice(id);
      if (n) notices.push(n);
    }
  }
  return { links, notices };
}

function capabilityNotices(articles: readonly KbArticle[], manifest: unknown): string[] {
  return uniq(
    articles
      .flatMap((a) => a.requiresCapabilities)
      .map((c) => capabilityNotice(manifest, c))
      .filter((n): n is string => n !== null),
  );
}

/** Answer a question deterministically for the current screen and user. */
export function answer(query: string, ctx: AnswerContext, bundle: KbBundle): QueAnswer {
  const { visible, blocked } = partitionArticles(bundle, ctx);
  const routeId = ctx.routeId;
  const asked = tokenize(query).length > 0;

  const hits = asked
    ? search(
        buildIndex(visible.map((v) => v.article)),
        query,
        routeId ? { routeId, limit: MAX_CITATIONS } : { limit: MAX_CITATIONS },
      )
    : [];
  // Blocked articles never appear; a matching one only explains why the capability is absent
  const blockedHits = asked ? search(buildIndex(blocked), query, { limit: 3 }) : [];
  const unavailable = capabilityNotices(
    blockedHits.map((h) => h.article),
    ctx.manifest,
  );

  let cited: KbArticle[];
  let lead: string;
  if (hits.length > 0) {
    cited = hits.map((h) => h.article);
    lead = cited.length === 1 ? '1 help article matches.' : `${cited.length} help articles match.`;
  } else {
    const visibleById = new Map(visible.map((v) => [v.article.id, v.article]));
    const defaults = routeId
      ? ROUTE_REGISTRY[routeId].defaultArticles
          .map((id) => visibleById.get(id))
          .filter((a): a is KbArticle => a !== undefined)
          .slice(0, MAX_CITATIONS)
      : [];
    cited = defaults;
    const start = asked ? 'No help article matched your question.' : '';
    const middle = defaults.length > 0 ? 'Here is help for this screen.' : '';
    lead = [start, middle, ASK_STAFF].filter(Boolean).join(' ');
  }

  const { links, notices } = linksAndRoleNotices(cited, ctx);
  const labels = capabilityNotices(cited, ctx.manifest);
  const text = [lead, ...labels, ...unavailable, ...notices].join('\n').slice(0, 4000);
  return {
    mode: 'deterministic',
    text,
    citations: cited.map((a) => a.id),
    links,
    kbVersion: bundle.kbVersion,
  };
}
