import { z } from 'zod';
import { IsoDateTimeSchema } from './schemas.js';

/**
 * Ask Que Anything (F13) contracts — MQ.1 (design §11.2–§11.4, ADR-011, decisions D1–D4).
 *
 * Que is read-only: nothing here describes a command. Every schema is strict so unknown fields
 * from untrusted sources (KB build input, API responses) are rejected rather than ignored.
 */

// ---------------------------------------------------------------------------
// Audiences, topics, milestones
// ---------------------------------------------------------------------------

/** KB audiences (design §11.2). `visitor` = `visitor_anonymous`; others map to roles. */
export const AUDIENCES = [
  'visitor',
  'reception',
  'counter',
  'supervisor',
  'facility_admin',
  'org_admin',
  'auditor',
] as const;
export const AudienceSchema = z.enum(AUDIENCES);
export type Audience = z.infer<typeof AudienceSchema>;

/** Help topics (design §11.2; the last three added at the M5 reconciliation). */
export const KB_TOPICS = [
  'registration',
  'ticket_status',
  'recovery',
  'staff_operations',
  'facility_configuration',
  'connectivity',
  'turn_alerts',
  'accessibility',
  'audit',
] as const;
export const KbTopicSchema = z.enum(KB_TOPICS);
export type KbTopic = z.infer<typeof KbTopicSchema>;

export const MILESTONES = ['M1', 'M2', 'M3', 'M4', 'M5', 'MQ', 'M6', 'M7'] as const;
export const MilestoneIdSchema = z.enum(MILESTONES);
export type MilestoneId = z.infer<typeof MilestoneIdSchema>;

// ---------------------------------------------------------------------------
// Route identifiers (design §11.3.1). `/supervisor/*` is a placeholder and is NOT registered.
// ---------------------------------------------------------------------------

export const ROUTE_IDS = [
  'public.home',
  'public.signup',
  'public.login',
  'public.accept_invite',
  'visitor.join',
  'visitor.ticket',
  'visitor.recover',
  'public.display',
  'admin.home',
  'admin.facility',
  'admin.facility.staff',
  'staff.home',
  'staff.facility',
  'staff.console',
  'staff.audit',
  'staff.connectivity',
] as const;
export const RouteIdSchema = z.enum(ROUTE_IDS);
export type RouteId = z.infer<typeof RouteIdSchema>;

// ---------------------------------------------------------------------------
// Capability manifest (design §11.2, decision D1)
// ---------------------------------------------------------------------------

/** Capability ids for M5 (design §11.10a). Unknown ids are never usable. */
export const CAPABILITY_IDS = [
  'visitor_join',
  'ticket_recovery_key',
  'staff_assisted_recovery',
  'recovery_audit_view',
  'self_resume',
  'auto_miss',
  'offline_coordinator',
  'device_health',
  'turn_alert_in_app',
  'turn_alert_sound',
  'turn_alert_vibration',
  'turn_alert_web_push',
  'accessibility_prefs',
  'sms_turn_alerts',
  'ussd',
  'ask_que_ai',
] as const;
export const CapabilityIdSchema = z.enum(CAPABILITY_IDS);
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

/** Lifecycle status: what is built and how mature it is (unchanged four values). */
export const CAPABILITY_STATUSES = ['live', 'preview', 'sandbox', 'planned'] as const;
export const CapabilityStatusSchema = z.enum(CAPABILITY_STATUSES);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

/** D1: whether a capability can be used in this deployment now (server-computed). */
export const CAPABILITY_AVAILABILITIES = ['available', 'unavailable'] as const;
export const CapabilityAvailabilitySchema = z.enum(CAPABILITY_AVAILABILITIES);
export type CapabilityAvailability = z.infer<typeof CapabilityAvailabilitySchema>;

export const UNAVAILABLE_REASONS = ['not_implemented', 'not_configured', 'switched_off'] as const;
export const UnavailableReasonSchema = z.enum(UNAVAILABLE_REASONS);
export type UnavailableReason = z.infer<typeof UnavailableReasonSchema>;

export const CapabilityEntrySchema = z
  .object({
    status: CapabilityStatusSchema,
    availability: CapabilityAvailabilitySchema,
    unavailableReason: UnavailableReasonSchema.optional(),
    since: MilestoneIdSchema.optional(),
    note: z.string().min(1).max(280).optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.availability === 'unavailable' && e.unavailableReason === undefined) {
      ctx.addIssue({ code: 'custom', message: 'unavailableReason is required when unavailable' });
    }
    if (e.availability === 'available' && e.unavailableReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'unavailableReason is only allowed when unavailable',
      });
    }
    // `planned` is never usable, whatever a source claims (design §11.2)
    if (
      e.status === 'planned' &&
      (e.availability !== 'unavailable' || e.unavailableReason !== 'not_implemented')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'planned capabilities are unavailable/not_implemented',
      });
    }
  });
export type CapabilityEntry = z.infer<typeof CapabilityEntrySchema>;

export const CAPABILITY_MANIFEST_VERSION = 1 as const;

export const CapabilityManifestSchema = z
  .object({
    version: z.literal(CAPABILITY_MANIFEST_VERSION),
    /** Server time; diagnostic and for offline wording only (never compared with device time). */
    generatedAt: IsoDateTimeSchema,
    /** Exhaustive: the server always lists every known capability. */
    capabilities: z.record(CapabilityIdSchema, CapabilityEntrySchema),
  })
  .strict();
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

/**
 * D1 usable rule: a capability may be presented as usable now only when it is `live` AND
 * `available`. Fails closed: a missing manifest, a missing entry, or a missing or unknown
 * status/availability value is not usable. Accepts untyped input on purpose (cached or
 * partially parsed manifests).
 */
export function isCapabilityUsable(manifest: unknown, id: string): boolean {
  if (typeof manifest !== 'object' || manifest === null) return false;
  const caps = (manifest as { capabilities?: unknown }).capabilities;
  if (typeof caps !== 'object' || caps === null) return false;
  if (!Object.prototype.hasOwnProperty.call(caps, id)) return false;
  const entry = (caps as Record<string, unknown>)[id];
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as { status?: unknown; availability?: unknown };
  return e.status === 'live' && e.availability === 'available';
}

/**
 * Whether a capability may be shown at all (usable, or a labelled `preview`/`sandbox` that is
 * available). Same fail-closed reading as `isCapabilityUsable`.
 */
export function isCapabilityShowable(manifest: unknown, id: string): boolean {
  if (isCapabilityUsable(manifest, id)) return true;
  if (typeof manifest !== 'object' || manifest === null) return false;
  const caps = (manifest as { capabilities?: unknown }).capabilities;
  if (typeof caps !== 'object' || caps === null) return false;
  if (!Object.prototype.hasOwnProperty.call(caps, id)) return false;
  const e = (caps as Record<string, unknown>)[id] as
    | { status?: unknown; availability?: unknown }
    | null
    | undefined;
  if (typeof e !== 'object' || e === null) return false;
  return (e.status === 'preview' || e.status === 'sandbox') && e.availability === 'available';
}

// ---------------------------------------------------------------------------
// Safe Markdown (design §11.2): headings, lists, emphasis, links to RouteIds only
// ---------------------------------------------------------------------------

/** Link syntax allowed in article bodies: `[text](route:<RouteId>)`. */
export const SAFE_MARKDOWN_ROUTE_LINK = /\[([^\]\n]{1,120})\]\(route:([a-z_.]+)\)/g;

/** Route ids referenced by `route:` links in a body (unvalidated strings). */
export function safeMarkdownRouteRefs(body: string): string[] {
  return [...body.matchAll(SAFE_MARKDOWN_ROUTE_LINK)].map((m) => m[2] ?? '');
}

const ROUTE_ID_SET: ReadonlySet<string> = new Set(ROUTE_IDS);

export const SafeMarkdownSchema = z
  .string()
  .min(1)
  .max(8000)
  .superRefine((body, ctx) => {
    if (/<\s*[a-z!/?]/i.test(body)) {
      ctx.addIssue({ code: 'custom', message: 'raw HTML is not allowed' });
    }
    if (/!\[/.test(body)) ctx.addIssue({ code: 'custom', message: 'images are not allowed' });
    if (
      /\b(?:https?|ftp|file):\/\//i.test(body) ||
      /\b(?:javascript|data|vbscript|mailto|tel):\S/i.test(body) ||
      /\bwww\.[a-z0-9-]+\./i.test(body)
    ) {
      ctx.addIssue({ code: 'custom', message: 'URLs are not allowed; link to a RouteId' });
    }
    if (/^\s*```|`{3}/m.test(body)) {
      ctx.addIssue({ code: 'custom', message: 'code blocks are not allowed' });
    }
    // Every `](` must be a route link; reference-style definitions are refused too
    const withoutRouteLinks = body.replace(SAFE_MARKDOWN_ROUTE_LINK, '');
    if (/\]\(|\]\[|^\s*\[[^\]]+\]:/m.test(withoutRouteLinks)) {
      ctx.addIssue({ code: 'custom', message: 'only [text](route:<RouteId>) links are allowed' });
    }
    for (const ref of safeMarkdownRouteRefs(body)) {
      if (!ROUTE_ID_SET.has(ref)) {
        ctx.addIssue({ code: 'custom', message: `unknown RouteId in link: ${ref}` });
      }
    }
  });
export type SafeMarkdown = z.infer<typeof SafeMarkdownSchema>;

// ---------------------------------------------------------------------------
// Knowledge-base article (design §11.2; REQ-F13.2.3)
// ---------------------------------------------------------------------------

export const KbArticleIdSchema = z
  .string()
  .min(3)
  .max(80)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/, 'dotted lowercase id, e.g. visitor.join.qr');

/** Calendar date `YYYY-MM-DD` that exists. */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
  }, 'invalid date');

export const KbArticleSchema = z
  .object({
    id: KbArticleIdSchema,
    title: z.string().trim().min(1).max(120),
    audiences: z.array(AudienceSchema).min(1),
    topics: z.array(KbTopicSchema).min(1),
    requiresCapabilities: z.array(CapabilityIdSchema),
    relatedRoutes: z.array(RouteIdSchema),
    availableSince: MilestoneIdSchema,
    version: z.number().int().min(1),
    lastReviewed: IsoDateSchema,
    keywords: z.array(z.string().trim().min(1).max(40)).max(40),
    body: SafeMarkdownSchema,
  })
  .strict();
export type KbArticle = z.infer<typeof KbArticleSchema>;

// ---------------------------------------------------------------------------
// Answer (design §11.4)
// ---------------------------------------------------------------------------

export const QUE_FALLBACK_REASONS = [
  'ai_disabled',
  'offline',
  'timeout',
  'quota',
  'provider_error',
  'validation_failed',
] as const;
export const QueFallbackReasonSchema = z.enum(QUE_FALLBACK_REASONS);
export type QueFallbackReason = z.infer<typeof QueFallbackReasonSchema>;

export const QueAnswerSchema = z
  .object({
    mode: z.enum(['deterministic', 'ai']),
    /** Plain text (never HTML). */
    text: z.string().max(4000),
    /** KbArticle ids, all authorized for the user. */
    citations: z.array(KbArticleIdSchema),
    /** RouteIds, all permitted for the user. */
    links: z.array(RouteIdSchema),
    fallbackReason: QueFallbackReasonSchema.optional(),
    kbVersion: z.number().int().min(0),
  })
  .strict();
export type QueAnswer = z.infer<typeof QueAnswerSchema>;
