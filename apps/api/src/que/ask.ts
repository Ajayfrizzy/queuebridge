import {
  CAPABILITY_IDS,
  isCapabilityUsable,
  type Audience,
  type CapabilityManifest,
  type KbArticle,
  type QueAnswer,
  type QueAskRequest,
  type QueFallbackReason,
  type RoleGrant,
} from '@queuebridge/contracts';
import {
  answer,
  audiencesFor,
  buildPath,
  guardAiExplanation,
  redactQuestion,
  restrictedArticles,
  type NavigationContext,
} from '@queuebridge/assist';
import type { Db } from '../db.js';
import { InferenceError, type InferenceAdapter } from './inference.js';
import type { LoadedKnowledgeBase } from './kb.js';

/**
 * `POST /api/v1/que/ask` orchestration (MQ.4; design §11.7). The deterministic answer is always
 * computed first and is the complete fallback. AI is attempted only when the deployment allows it
 * (zero-cost guard), the facility opted in, there are authorized articles to ground it, and the
 * shared daily cap has room. Output that fails the guard is never returned. Nothing here writes
 * tenant data: the only write is the aggregate daily counter.
 */

/** Articles sent to the adapter at most (the strongest deterministic matches). */
export const AI_MAX_ARTICLES = 3;

export interface AskContext {
  db: Db;
  kb: LoadedKnowledgeBase;
  adapter: InferenceAdapter;
  manifest: CapabilityManifest;
  deploymentAvailable: boolean;
  dailyCap: number;
  timeoutMs: number;
  /** Aborts when the client goes away. */
  clientSignal?: AbortSignal;
}

export interface AskOutcome {
  answer: QueAnswer;
  /** For logs and counters only (never question or answer text). */
  attempted: boolean;
  latencyMs: number | null;
  redactions: number;
}

/** Atomically take one slot of today's (UTC) cap; false when the cap is reached. */
export async function reserveDailySlot(db: Db, cap: number): Promise<boolean> {
  if (cap <= 0) return false;
  const rows = await db<{ requests: number }[]>`
    INSERT INTO que_ai_daily_usage (usage_date, requests)
    VALUES ((NOW() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (usage_date) DO UPDATE SET requests = que_ai_daily_usage.requests + 1
      WHERE que_ai_daily_usage.requests < ${cap}
    RETURNING requests`;
  return rows.length > 0;
}

export async function facilityOptedIn(
  db: Db,
  organizationId: string,
  facilityId: string,
): Promise<boolean> {
  const rows = await db<{ enabled: boolean }[]>`
    SELECT enabled FROM facility_que_ai_settings
     WHERE facility_id = ${facilityId} AND organization_id = ${organizationId}`;
  return rows[0]?.enabled === true;
}

function capabilitySummary(manifest: CapabilityManifest): string {
  return CAPABILITY_IDS.map(
    (id) => `${id}: ${isCapabilityUsable(manifest, id) ? 'available' : 'not available'}`,
  ).join('\n');
}

export async function askQue(
  ctx: AskContext,
  session: { organizationId: string; roles: RoleGrant[] },
  body: QueAskRequest,
): Promise<AskOutcome> {
  const audiences: Audience[] = audiencesFor(session.roles);
  // Only articles this session may read: public ones plus restricted ones for its audiences
  const articles: KbArticle[] = [
    ...ctx.kb.bundles.visitor.articles,
    ...restrictedArticles(ctx.kb.bundles, audiences),
  ];
  const nav: NavigationContext = {
    grants: session.roles,
    facilityId: body.facility_id,
    queueId: body.queue_id ?? null,
  };
  const deterministic = answer(
    body.question,
    { ...nav, routeId: body.route_id ?? null, manifest: ctx.manifest },
    { kbVersion: ctx.kb.kbVersion, articles },
  );
  const { text: redacted, redactions } = redactQuestion(body.question);
  const fallback = (
    reason: QueFallbackReason,
    attempted = false,
    latencyMs: number | null = null,
  ): AskOutcome => ({
    answer: { ...deterministic, fallbackReason: reason },
    attempted,
    latencyMs,
    redactions,
  });

  if (!ctx.deploymentAvailable) return fallback('ai_disabled');
  if (!(await facilityOptedIn(ctx.db, session.organizationId, body.facility_id)))
    return fallback('ai_disabled');

  const byId = new Map(articles.map((a) => [a.id, a]));
  const supplied = deterministic.citations
    .map((id) => byId.get(id))
    .filter((a): a is KbArticle => a !== undefined)
    .slice(0, AI_MAX_ARTICLES);
  // Nothing authorized to explain: AI would have nothing to be grounded in
  if (supplied.length === 0) return fallback('validation_failed');

  if (!(await reserveDailySlot(ctx.db, ctx.dailyCap))) return fallback('quota');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  const onClientGone = (): void => controller.abort();
  ctx.clientSignal?.addEventListener('abort', onClientGone, { once: true });
  const started = Date.now();
  let output: unknown;
  try {
    output = await ctx.adapter.explain(
      {
        question: redacted,
        articles: supplied.map((a) => ({ id: a.id, title: a.title, body: a.body })),
        capabilitySummary: capabilitySummary(ctx.manifest),
        locale: 'en',
      },
      controller.signal,
    );
  } catch (e) {
    const latency = Date.now() - started;
    if (controller.signal.aborted) return fallback('timeout', true, latency);
    if (e instanceof InferenceError && e.kind === 'quota') return fallback('quota', true, latency);
    return fallback('provider_error', true, latency);
  } finally {
    clearTimeout(timer);
    ctx.clientSignal?.removeEventListener('abort', onClientGone);
  }
  const latency = Date.now() - started;

  const guarded = guardAiExplanation(output, supplied, ctx.manifest);
  if (!guarded.ok) return fallback('validation_failed', true, latency);

  // Links come from the server, never from model text: permitted screens of the cited articles
  const links = [
    ...new Set(
      guarded.citations
        .flatMap((id) => byId.get(id)?.relatedRoutes ?? [])
        .filter((r) => buildPath(r, nav) !== null),
    ),
  ].slice(0, 5);
  return {
    answer: {
      mode: 'ai',
      text: guarded.text,
      citations: guarded.citations,
      links,
      kbVersion: ctx.kb.kbVersion,
    },
    attempted: true,
    latencyMs: latency,
    redactions,
  };
}

/** Per-user sliding-window limit (in-process, like the other per-IP limits). */
export class PerUserLimiter {
  private readonly hits = new Map<string, number[]>();
  public constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
  ) {}
  public allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits)
        if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
    return true;
  }
}
