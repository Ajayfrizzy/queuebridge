import {
  CAPABILITY_IDS,
  isCapabilityUsable,
  type CapabilityId,
  type KbArticle,
} from '@queuebridge/contracts';
import { DATA_PATTERNS } from './kb-compile.js';
import { tokenize } from './search.js';

/**
 * Optional AI explanation layer: question redaction and the output guard (MQ.4; design §11.7;
 * REQ-F13.4.5, F13.9.3). Pure and deterministic. Model output is untrusted data: it is accepted
 * only when it is plain text grounded in the authorized articles that were supplied, cites only
 * those articles, introduces no links, data, numbers, claimed actions or capabilities, and fits
 * the length limit. The guard is the final authority; anything it rejects falls back to
 * deterministic help.
 */

export const AI_MAX_OUTPUT_CHARS = 1200;
/** Share of the answer's content words that must come from the cited articles. */
export const AI_MIN_GROUNDING = 0.6;

const REDACTED = '[redacted]';

/** Replace ASCII control characters (U+0000–U+001F, U+007F) with spaces. */
function withoutControls(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    out += c < 0x20 || c === 0x7f ? ' ' : ch;
  }
  return out;
}

/** Likely personal data or secrets removed before a question leaves the server (REQ-F13.4.5). */
const REDACTIONS: readonly RegExp[] = [
  /\b(?:https?:\/\/|www\.)\S+/gi,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  // Recovery keys and tokens: grouped base32 (`ABCD-EFGH-…`) or long opaque strings
  /\b(?:[A-Za-z2-7]{4}[\s-]){3,}[A-Za-z2-7]{4}\b/g,
  /\b[A-Za-z0-9_-]{20,}\b/g,
  // Phone numbers (7+ digits with common separators)
  /\+?\d[\d\s().-]{6,}\d/g,
  // Ticket codes (A123, AB1234)
  /\b[A-Za-z]{1,3}\d{3,4}\b/g,
];

export function redactQuestion(question: string): { text: string; redactions: number } {
  let text = withoutControls(question);
  let redactions = 0;
  for (const re of REDACTIONS) {
    text = text.replace(re, () => {
      redactions++;
      return REDACTED;
    });
  }
  return { text: text.replace(/\s+/g, ' ').trim(), redactions };
}

/** Words that name each capability in prose; used to stop claims about unusable ones. */
const CAPABILITY_WORDS: Readonly<Record<CapabilityId, readonly RegExp[]>> = {
  visitor_join: [/\bjoin(?:ing)? (?:a |the )?queue online\b/i],
  ticket_recovery_key: [/\brecovery key\b/i],
  staff_assisted_recovery: [/\bstaff[- ]assisted\b/i],
  recovery_audit_view: [/\brecovery activity\b/i],
  self_resume: [/\bself[- ]resume\b/i, /\breturn to the queue yourself\b/i],
  auto_miss: [/\bautomatic(?:ally)? (?:no[- ]show|miss)/i, /\bauto[- ]miss\b/i],
  offline_coordinator: [/\bcoordinator\b/i],
  device_health: [/\bdevice health\b/i],
  turn_alert_in_app: [/\bin-app alert/i],
  turn_alert_sound: [/\balert sound\b/i, /\bsound alert/i],
  turn_alert_vibration: [/\bvibrat/i],
  turn_alert_web_push: [/\bpush\b/i, /\bnotification/i],
  accessibility_prefs: [/\bdisplay settings\b/i],
  sms_turn_alerts: [/\bsms\b/i, /\btext message/i],
  ussd: [/\bussd\b/i],
  ask_que_ai: [],
};

const UNSAFE_MARKUP: readonly RegExp[] = [
  /<[^>]*>/,
  /\]\(|!\[|`/,
  /\b(?:https?|ftp|file|javascript|data|vbscript|mailto|tel):/i,
  /\bwww\./i,
  /\broute:/i,
];

/** Claims that something was done, or that Que can act; and prompt-injection artefacts. */
const ACTION_OR_INJECTION: readonly RegExp[] = [
  /\b(?:i|we|que)\s*(?:have|'ve|will|'ll|can|just|already)?\s*(?:called|cancel+ed|cancel|moved|approved|approve|updated|changed|deleted|reset|granted|revoked|recovered|opened|closed|paused|resumed|served|completed|transferred|assigned)\b/i,
  /\b(?:has|have|was|were) been (?:called|cancel+ed|moved|approved|updated|changed|deleted|reset|granted|revoked|recovered|served|completed|transferred)\b/i,
  /\bignore (?:all |any )?(?:previous|prior|above) (?:instructions|messages)\b/i,
  /\bsystem prompt\b|\bdeveloper message\b|\bjailbreak\b/i,
  /\byour turn (?:is|will be) (?:in|at)\b|\byou will be (?:called|served)\b/i,
];

export type GuardFailure =
  | 'malformed'
  | 'length'
  | 'citations'
  | 'markup'
  | 'sensitive'
  | 'action_or_injection'
  | 'capability'
  | 'ungrounded_number'
  | 'ungrounded';

export type GuardResult =
  | { ok: true; text: string; citations: string[] }
  | { ok: false; reason: GuardFailure };

function articleText(a: KbArticle): string {
  return [a.title, a.keywords.join(' '), a.body].join('\n');
}

/**
 * Validate untrusted model output against the articles that were supplied to it.
 * `supplied` must be exactly the authorized articles sent to the adapter.
 */
export function guardAiExplanation(
  output: unknown,
  supplied: readonly KbArticle[],
  manifest: unknown,
  maxChars: number = AI_MAX_OUTPUT_CHARS,
): GuardResult {
  if (typeof output !== 'object' || output === null) return { ok: false, reason: 'malformed' };
  const o = output as { text?: unknown; citations?: unknown };
  if (typeof o.text !== 'string' || !Array.isArray(o.citations))
    return { ok: false, reason: 'malformed' };
  if (!o.citations.every((c) => typeof c === 'string')) return { ok: false, reason: 'malformed' };

  const text = withoutControls(o.text).replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > maxChars) return { ok: false, reason: 'length' };

  const byId = new Map(supplied.map((a) => [a.id, a]));
  const citations = [...new Set(o.citations as string[])];
  if (citations.length === 0 || !citations.every((c) => byId.has(c))) {
    return { ok: false, reason: 'citations' };
  }

  if (UNSAFE_MARKUP.some((re) => re.test(text))) return { ok: false, reason: 'markup' };
  if (DATA_PATTERNS.some(([, re]) => re.test(text))) return { ok: false, reason: 'sensitive' };
  if (ACTION_OR_INJECTION.some((re) => re.test(text)))
    return { ok: false, reason: 'action_or_injection' };

  for (const id of CAPABILITY_IDS) {
    if (isCapabilityUsable(manifest, id)) continue;
    if (CAPABILITY_WORDS[id].some((re) => re.test(text)))
      return { ok: false, reason: 'capability' };
  }

  const source = citations
    .map((c) => byId.get(c))
    .filter((a): a is KbArticle => a !== undefined)
    .map(articleText)
    .join('\n');
  // Numbers (times, limits, counts) must come from the cited articles, never from the model
  const sourceNumbers = new Set(source.match(/\d+/g) ?? []);
  for (const n of text.match(/\d+/g) ?? []) {
    if (!sourceNumbers.has(n)) return { ok: false, reason: 'ungrounded_number' };
  }

  // Most content words must come from the cited articles (no new instructions or topics)
  const sourceWords = new Set(tokenize(source).filter((t) => t.length >= 4));
  const words = tokenize(text).filter((t) => t.length >= 4);
  if (words.length === 0) return { ok: false, reason: 'ungrounded' };
  const grounded = words.filter((w) => sourceWords.has(w)).length / words.length;
  if (grounded < AI_MIN_GROUNDING) return { ok: false, reason: 'ungrounded' };

  return { ok: true, text, citations };
}
