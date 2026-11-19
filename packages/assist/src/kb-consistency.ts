import {
  CAPABILITY_IDS,
  CAPABILITY_STATUSES,
  MILESTONES,
  safeMarkdownRouteRefs,
  type Audience,
  type KbArticle,
} from '@queuebridge/contracts';
import { ROUTE_REGISTRY } from './registry.js';

/**
 * Group 13.5 knowledge-base consistency (MQ.6; design §11.2, §11.10; REQ-F13.2, REQ-F13.9).
 * Pure: callers pass the compiled articles, the committed capability coverage contract
 * (`knowledge/capabilities.json`), and optionally the capability manifest the server builds and
 * today's date. Every rule returns plain problem strings prefixed with its rule id, so CI output
 * says what to fix. These checks make the MQ.6 maintenance rule enforceable: a later milestone
 * (M6 SMS/USSD, M7 UI and onboarding) that changes a capability, a route or a screen without
 * updating the affected articles fails here.
 *
 * Rules
 * - C1 the contract covers exactly the manifest's capability ids
 * - C2 every capability lists at least one existing article that documents it
 * - C3 every article that requires a capability is listed under it
 * - C4 the contract status equals the manifest status          (needs the manifest)
 * - C5 the contract default availability equals the manifest   (needs the manifest)
 * - A1 an article that can be shown never says its feature is not offered / not available yet
 * - A2 an article for a `sandbox` or `preview` capability says so
 * - A3 an article dated after the newest shown milestone is gated on a capability not yet live
 * - R1 every related route can be opened by at least one of the article's audiences
 * - R2 every body link is a related route
 * - R3 every screen default article exists
 * - V1 no review date lies in the future                       (needs today's date)
 */

export const KB_CAPABILITY_CONTRACT_VERSION = 1;

/** Default availability as the articles were written for it (production defaults). */
export type ContractAvailability =
  | 'available'
  | 'not_implemented'
  | 'not_configured'
  | 'switched_off';

export interface KbCapabilityContractEntry {
  /** Lifecycle status the documenting articles were reviewed against. */
  status: (typeof CAPABILITY_STATUSES)[number];
  /** Availability with production default configuration. */
  defaultAvailability: ContractAvailability;
  /** Articles that document this capability (required-by articles must be among them). */
  articles: string[];
}

export interface KbCapabilityContract {
  contractVersion: number;
  capabilities: Record<string, KbCapabilityContractEntry>;
}

const AVAILABILITIES: readonly ContractAvailability[] = [
  'available',
  'not_implemented',
  'not_configured',
  'switched_off',
];

/** Structural validation of the committed contract file (it is untrusted JSON). */
export function parseCapabilityContract(raw: unknown): {
  contract: KbCapabilityContract | null;
  problems: string[];
} {
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { contract: null, problems: ['C0 capabilities.json is not an object'] };
  }
  const o = raw as Record<string, unknown>;
  if (o['contractVersion'] !== KB_CAPABILITY_CONTRACT_VERSION) {
    problems.push(`C0 contractVersion must be ${KB_CAPABILITY_CONTRACT_VERSION}`);
  }
  const caps = o['capabilities'];
  if (typeof caps !== 'object' || caps === null) {
    return { contract: null, problems: [...problems, 'C0 capabilities must be an object'] };
  }
  const out: Record<string, KbCapabilityContractEntry> = {};
  for (const [id, e] of Object.entries(caps as Record<string, unknown>)) {
    const entry = e as Record<string, unknown> | null;
    const status = entry?.['status'];
    const availability = entry?.['defaultAvailability'];
    const articles = entry?.['articles'];
    if (!(CAPABILITY_STATUSES as readonly unknown[]).includes(status)) {
      problems.push(`C0 ${id}: unknown status`);
      continue;
    }
    if (!(AVAILABILITIES as readonly unknown[]).includes(availability)) {
      problems.push(`C0 ${id}: unknown defaultAvailability`);
      continue;
    }
    if (!Array.isArray(articles) || articles.some((a) => typeof a !== 'string')) {
      problems.push(`C0 ${id}: articles must be a list of article ids`);
      continue;
    }
    out[id] = {
      status: status as KbCapabilityContractEntry['status'],
      defaultAvailability: availability as ContractAvailability,
      articles: articles as string[],
    };
  }
  return {
    contract: { contractVersion: Number(o['contractVersion']), capabilities: out },
    problems,
  };
}

export interface KbConsistencyInput {
  articles: readonly KbArticle[];
  contract: KbCapabilityContract;
  /** The capability manifest the server builds with production defaults (C4, C5, A1–A3). */
  manifest?: unknown;
  /** `YYYY-MM-DD` (V1). */
  today?: string;
}

interface EntryView {
  status?: unknown;
  availability?: unknown;
  unavailableReason?: unknown;
  since?: unknown;
}

function manifestEntry(manifest: unknown, id: string): EntryView | null {
  if (typeof manifest !== 'object' || manifest === null) return null;
  const caps = (manifest as { capabilities?: unknown }).capabilities;
  if (typeof caps !== 'object' || caps === null) return null;
  const e = (caps as Record<string, unknown>)[id];
  return typeof e === 'object' && e !== null ? (e as EntryView) : null;
}

const order = (m: unknown): number => (MILESTONES as readonly unknown[]).indexOf(m);

/** Wording that says a feature cannot be used (only allowed while the feature is never shown). */
export const UNAVAILABLE_WORDING = /\bnot (?:offered|available yet)\b/i;
/** Wording that labels a sandbox or preview feature honestly (REQ-F13.9.1). */
export const SANDBOX_WORDING = /\b(?:sandbox|test only|test-only|preview)\b/i;

/**
 * Whether one of the article's audiences may open the route. Articles never list `org_admin`
 * (it receives every staff audience), so a direct match is exact.
 */
function routeReachable(article: KbArticle, routeAudiences: readonly Audience[]): boolean {
  return article.audiences.some((a) => routeAudiences.includes(a));
}

/** All Group 13.5 problems for the given knowledge base; empty when consistent. */
export function kbConsistencyProblems(input: KbConsistencyInput): string[] {
  const problems: string[] = [];
  const { articles, contract, manifest, today } = input;
  const byId = new Map(articles.map((a) => [a.id, a]));
  const ids = new Set<string>(CAPABILITY_IDS);

  // C1 — exactly the manifest's capability ids
  for (const id of CAPABILITY_IDS) {
    if (!contract.capabilities[id]) problems.push(`C1 ${id}: missing from capabilities.json`);
  }
  for (const id of Object.keys(contract.capabilities)) {
    if (!ids.has(id)) problems.push(`C1 ${id}: not a manifest capability`);
  }
  // C2 — documented by existing articles
  for (const [id, e] of Object.entries(contract.capabilities)) {
    if (e.articles.length === 0) problems.push(`C2 ${id}: no article documents it`);
    for (const a of e.articles) {
      if (!byId.has(a)) problems.push(`C2 ${id}: article ${a} does not exist`);
    }
  }
  // C3 — every gated article is recorded under its capability
  for (const a of articles) {
    for (const c of a.requiresCapabilities) {
      if (!contract.capabilities[c]?.articles.includes(a.id)) {
        problems.push(`C3 ${a.id}: requires ${c} but is not listed under it`);
      }
    }
  }

  if (manifest !== undefined) {
    // C4, C5 — the articles were reviewed against what the server reports now
    for (const id of CAPABILITY_IDS) {
      const e = contract.capabilities[id];
      const m = manifestEntry(manifest, id);
      if (!e) continue;
      if (!m) {
        problems.push(`C4 ${id}: missing from the server manifest`);
        continue;
      }
      if (m.status !== e.status) {
        problems.push(
          `C4 ${id}: the server reports status ${String(m.status)} but the articles (${e.articles.join(
            ', ',
          )}) were reviewed for ${e.status}: review and update them, then capabilities.json`,
        );
      }
      const actual = m.availability === 'available' ? 'available' : m.unavailableReason;
      if (actual !== e.defaultAvailability) {
        problems.push(
          `C5 ${id}: default availability is ${String(actual)} but capabilities.json says ${
            e.defaultAvailability
          }: review the articles, then capabilities.json`,
        );
      }
    }
    // A1, A2 — wording matches what can be shown
    for (const a of articles) {
      for (const c of a.requiresCapabilities) {
        const status = manifestEntry(manifest, c)?.status;
        if (status !== 'planned' && UNAVAILABLE_WORDING.test(a.body)) {
          problems.push(
            `A1 ${a.id}: says the feature is unavailable, but ${c} is ${String(status)}`,
          );
        }
        if ((status === 'sandbox' || status === 'preview') && !SANDBOX_WORDING.test(a.body)) {
          problems.push(`A2 ${a.id}: ${c} is ${status}; the article must say so`);
        }
      }
    }
    // A3 — content dated for a later milestone stays behind a capability that is not live
    let newest = -1;
    for (const id of CAPABILITY_IDS) {
      const m = manifestEntry(manifest, id);
      if (m && m.status !== 'planned' && order(m.since) > newest) newest = order(m.since);
    }
    for (const a of articles) {
      if (order(a.availableSince) <= newest) continue;
      const gated = a.requiresCapabilities.some(
        (c) => manifestEntry(manifest, c)?.status !== 'live',
      );
      if (!gated) {
        problems.push(
          `A3 ${a.id}: dated ${a.availableSince}, later than any live capability, but not gated on one that is not live`,
        );
      }
    }
  }

  // R1–R3 — routes and screen defaults
  for (const a of articles) {
    for (const r of a.relatedRoutes) {
      const entry = ROUTE_REGISTRY[r];
      if (!entry) {
        problems.push(`R1 ${a.id}: unknown route ${r}`);
      } else if (!routeReachable(a, entry.audiences)) {
        problems.push(`R1 ${a.id}: none of its audiences can open ${r}`);
      }
    }
    for (const ref of safeMarkdownRouteRefs(a.body)) {
      if (!(a.relatedRoutes as readonly string[]).includes(ref)) {
        problems.push(`R2 ${a.id}: links ${ref}, which is not a related route`);
      }
    }
  }
  for (const entry of Object.values(ROUTE_REGISTRY)) {
    for (const id of entry.defaultArticles) {
      if (!byId.has(id)) problems.push(`R3 ${entry.id}: default article ${id} does not exist`);
    }
  }

  // V1 — review dates
  if (today !== undefined) {
    for (const a of articles) {
      if (a.lastReviewed > today)
        problems.push(`V1 ${a.id}: reviewed in the future (${a.lastReviewed})`);
    }
  }
  return problems;
}
