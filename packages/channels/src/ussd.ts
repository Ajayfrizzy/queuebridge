import {
  USSD_MAX_MESSAGE,
  uuidv7,
  type UssdResponse,
  type UssdSessionParams,
} from '@queuebridge/contracts';
import { signWebhookWith, verifyWebhookWith, type WebhookHeaderNames } from './sms.js';

/**
 * M6.2 USSD, provider-neutral part (REQ-F12.1–F12.3; ADR-009).
 *
 * - The request format, its signature and the CON/END response format belong to the adapter
 *   (`SandboxUssdAdapter` today; a live adapter after approval).
 * - The menu (`runUssdMenu`) is shared by every adapter: a stateful machine over a JSON state the
 *   API stores in PostgreSQL (`ussd_sessions`). It reaches the queue only through a
 *   `UssdApplication` the API implements with its existing services (public catalog, `joinQueue`,
 *   the recovery-key check), so there is no second queue engine and no I/O in this package.
 * - Nothing here logs; no screen, state or result carries a phone number or a status token. A
 *   recovery key appears only in the one join screen that issues it (the API stores that screen
 *   encrypted for replays) and is never stored in the state.
 */

// ---------------------------------------------------------------------------
// Signed requests (same construction as SMS, channel-separated context)
// ---------------------------------------------------------------------------

export const USSD_WEBHOOK_HEADERS = {
  timestamp: 'x-qb-ussd-timestamp',
  nonce: 'x-qb-ussd-nonce',
  signature: 'x-qb-ussd-signature',
} as const satisfies WebhookHeaderNames;
/** Signature context: an SMS signature can never verify here (and vice versa). */
const USSD_SIGNATURE_CONTEXT = 'ussd.v1.';

export function signUssdWebhook(
  secret: string,
  rawBody: string,
  opts: { timestamp?: number; nonce?: string } = {},
): Record<string, string> {
  return signWebhookWith(USSD_WEBHOOK_HEADERS, USSD_SIGNATURE_CONTEXT, secret, rawBody, opts);
}

export function verifyUssdWebhook(
  secret: string | undefined,
  headers: Record<string, string>,
  rawBody: unknown,
  nowMs: number = Date.now(),
): boolean {
  return verifyWebhookWith(
    USSD_WEBHOOK_HEADERS,
    USSD_SIGNATURE_CONTEXT,
    secret,
    headers,
    rawBody,
    nowMs,
  );
}

// ---------------------------------------------------------------------------
// Normalized request (what every adapter's parser produces)
// ---------------------------------------------------------------------------

export interface UssdRequest {
  /** The provider's session id (hashed by the API before storage) */
  sessionId: string;
  /** The subscriber number as the provider reports it (hashed by the API at once) */
  msisdn: string;
  /**
   * Every input of this session so far, joined with `*` (empty on the first request), the
   * convention of the common aggregators. Its length gives the step; its last part is the input.
   */
  text: string;
}

const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;
const MSISDN = /^\+?[0-9]{8,15}$/;
/** Digits, letters (ticket codes, recovery keys), spaces and hyphens; `*` separates inputs. */
const TEXT = /^[0-9A-Za-z *#-]{0,240}$/;

/** Splits `text` into the session's inputs; `[]` for the first request. */
export function ussdInputs(text: string): string[] {
  return text === '' ? [] : text.split('*');
}

/** Exact-shape check of a sandbox request body (`{session_id, msisdn, text, service_code?}`). */
export function parseSandboxUssdRequest(payload: unknown): UssdRequest | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const o = payload as Record<string, unknown>;
  const keys = Object.keys(o);
  const allowed = ['session_id', 'msisdn', 'text', 'service_code'];
  if (keys.some((k) => !allowed.includes(k))) return null;
  const { session_id: sessionId, msisdn, text, service_code: serviceCode } = o;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  if (typeof msisdn !== 'string' || !MSISDN.test(msisdn)) return null;
  if (typeof text !== 'string' || !TEXT.test(text)) return null;
  if (
    serviceCode !== undefined &&
    (typeof serviceCode !== 'string' || !/^[0-9*#]{1,32}$/.test(serviceCode))
  )
    return null;
  return { sessionId, msisdn, text };
}

/** The common CON/END text contract (`text/plain`). */
export function renderUssdText(r: UssdResponse): string {
  return `${r.action} ${r.message}`;
}

// ---------------------------------------------------------------------------
// The application the menu drives (implemented by the API with its existing services)
// ---------------------------------------------------------------------------

/** Who is asking: hashes only (`UssdSessionParams.session_key_hash` and `.msisdn`). */
export interface UssdCaller {
  sessionKeyHash: string;
  msisdnHash: string;
}

export interface UssdFacilityRef {
  facilityId: string;
  organizationId: string;
  name: string;
}

export interface UssdServiceOption {
  queueId: string;
  name: string;
  waiting: number;
  /** e.g. "10-20 min"; null when there is not enough data (never a promise) */
  estimate: string | null;
}

export type UssdJoinResult =
  | { ok: true; code: string; service: string; recoveryKey: string | null }
  | { ok: false; reason: 'not_accepting' | 'paused' | 'closed' | 'limit' | 'unavailable' };

export type UssdTicketState =
  | 'waiting'
  | 'called'
  | 'serving'
  | 'paused'
  | 'missed'
  | 'transferred'
  | 'other';

export type UssdTicketResult =
  | {
      ok: true;
      code: string;
      service: string;
      state: UssdTicketState;
      /** tickets ahead of this one while waiting (0 = next), as the status view reports it */
      ahead: number | null;
      counter: string | null;
      estimate: string | null;
      /** the code the visitor entered, when a transfer gave the ticket a new one */
      movedFrom: string | null;
    }
  | { ok: false; reason: 'failed' | 'throttled' | 'unavailable' };

export interface UssdApplication {
  /** A facility that opted in to USSD, by its public keypad code; null otherwise. */
  findFacility(caller: UssdCaller, accessCode: string): Promise<UssdFacilityRef | null>;
  /** The facility's services accepting visitors now (public catalog, committed state). */
  listServices(caller: UssdCaller, facility: UssdFacilityRef): Promise<UssdServiceOption[]>;
  /** Join through the authoritative join path, idempotent per `operationId`. */
  join(
    caller: UssdCaller,
    facility: UssdFacilityRef,
    queueId: string,
    operationId: string,
  ): Promise<UssdJoinResult>;
  /** Open a ticket with its code AND recovery key (the approved credential), throttled. */
  checkTicket(
    caller: UssdCaller,
    facility: UssdFacilityRef,
    ticketCode: string,
    rawKey: string,
  ): Promise<UssdTicketResult>;
}

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

type Screen =
  | 'facility_code'
  | 'main'
  | 'services'
  | 'confirm'
  | 'ticket_code'
  | 'ticket_key'
  | 'recover_menu';

/** Persisted between steps (JSON). Never holds a phone number, token or recovery key. */
export interface UssdMenuState {
  screen?: Screen;
  facility?: UssdFacilityRef;
  page?: number;
  /** The services listed on the current page, in menu order */
  options?: { queueId: string; name: string }[];
  selected?: { queueId: string; name: string; waiting: number; estimate: string | null };
  /** Fixed when the confirm screen is shown: a repeated confirm can never join twice */
  joinOperationId?: string;
  intent?: 'status' | 'recover';
  ticketCode?: string | undefined;
  /** Consecutive invalid entries on this screen */
  invalid?: number | undefined;
  facilityTries?: number;
  /** Set when this session created a ticket (the API records `joined_at`) */
  joined?: { code: string };
}

/** Options shown per page of services (each line is kept short for the 182-character limit). */
export const USSD_SERVICES_PER_PAGE = 4;
const MAX_INVALID = 3;
const MAX_FACILITY_TRIES = 3;
const BACK = '9';
const EXIT = '0';
const MORE = '8';

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1)).trimEnd()}…`;

/** Groups a 32-character key as 8 blocks of 4 for copying by hand. */
export const groupKey = (key: string): string => key.replace(/(.{4})(?=.)/g, '$1 ');

interface Ctx {
  label: string;
}

function fit(ctx: Ctx, lines: string[]): string {
  const text = [ctx.label, ...lines].filter((l) => l !== '').join('\n');
  // Every screen is designed below the limit; this is a last guard, never the normal path
  return text.length <= USSD_MAX_MESSAGE ? text : `${text.slice(0, USSD_MAX_MESSAGE - 1)}…`;
}

const con = (ctx: Ctx, state: UssdMenuState, lines: string[]): UssdResponse => ({
  action: 'CON',
  message: fit(ctx, lines),
  next_state: state as Record<string, unknown>,
});
const end = (ctx: Ctx, state: UssdMenuState, lines: string[]): UssdResponse => ({
  action: 'END',
  message: fit(ctx, lines),
  next_state: state as Record<string, unknown>,
});

const facilityScreen = (ctx: Ctx, s: UssdMenuState, note = ''): UssdResponse =>
  con(ctx, { ...s, screen: 'facility_code' }, [
    note || 'QueueBridge test service.',
    'Enter the 6-digit facility code shown at the facility:',
    `${EXIT} Exit`,
  ]);

const mainScreen = (ctx: Ctx, s: UssdMenuState, note = ''): UssdResponse =>
  con(ctx, { ...s, screen: 'main', invalid: note ? s.invalid : 0 }, [
    note,
    clip(s.facility?.name ?? '', 40),
    '1 Join a queue',
    '2 Check my ticket',
    '3 Recover my ticket',
    `${EXIT} Exit`,
  ]);

const ticketCodeScreen = (ctx: Ctx, s: UssdMenuState, note = ''): UssdResponse =>
  con(ctx, { ...s, screen: 'ticket_code' }, [
    note,
    'Enter your ticket code (for example A012):',
    `${BACK} Back`,
  ]);

const ticketKeyScreen = (ctx: Ctx, s: UssdMenuState): UssdResponse =>
  con(ctx, { ...s, screen: 'ticket_key' }, [
    `Ticket ${s.ticketCode ?? ''}.`,
    'Enter the 32-character recovery key you got when you joined:',
    `${BACK} Back`,
  ]);

const recoverScreen = (ctx: Ctx, s: UssdMenuState, note = ''): UssdResponse =>
  con(ctx, { ...s, screen: 'recover_menu' }, [
    note,
    'Recover my ticket',
    '1 I have my code and key',
    '2 I lost my code or key',
    `${BACK} Back`,
    `${EXIT} Exit`,
  ]);

async function servicesScreen(
  ctx: Ctx,
  app: UssdApplication,
  caller: UssdCaller,
  s: UssdMenuState,
  page: number,
): Promise<UssdResponse> {
  const facility = s.facility as UssdFacilityRef;
  const all = await app.listServices(caller, facility);
  if (all.length === 0) {
    return con(ctx, { ...s, screen: 'services', options: [], page: 0 }, [
      `No service at ${clip(facility.name, 40)} is taking visitors right now.`,
      `${BACK} Back`,
      `${EXIT} Exit`,
    ]);
  }
  const pages = Math.ceil(all.length / USSD_SERVICES_PER_PAGE);
  const p = page % pages;
  const slice = all.slice(p * USSD_SERVICES_PER_PAGE, (p + 1) * USSD_SERVICES_PER_PAGE);
  const lines = slice.map((o, i) => `${i + 1} ${clip(o.name, 22)} (${o.waiting} waiting)`);
  return con(
    ctx,
    {
      ...s,
      screen: 'services',
      page: p,
      options: slice.map((o) => ({ queueId: o.queueId, name: o.name })),
      invalid: 0,
    },
    [
      'Choose a service:',
      ...lines,
      [pages > 1 ? `${MORE} More` : '', `${BACK} Back`, `${EXIT} Exit`].filter(Boolean).join(' '),
    ],
  );
}

function statusLine(r: Extract<UssdTicketResult, { ok: true }>): string {
  const head = `${r.code} ${clip(r.service, 22)}`;
  switch (r.state) {
    case 'waiting':
      return `${head}: waiting${r.ahead === 0 ? ', you are next' : r.ahead ? `, ${r.ahead} ahead of you` : ''}.${r.estimate ? ` About ${r.estimate} (not a promise).` : ''}`;
    case 'called':
      return `${head}: called. Go to ${clip(r.counter ?? 'the counter', 24)} now.`;
    case 'serving':
      return `${head}: being served${r.counter ? ` at ${clip(r.counter, 24)}` : ''}.`;
    case 'paused':
      return `${head}: on hold. Please ask staff.`;
    case 'missed':
      return `${head}: missed. Ask staff about returning to the queue.`;
    default:
      return `${head}: please ask staff.`;
  }
}

/** A screen-level invalid entry: repeat the screen, end the session after three in a row. */
function invalid(
  ctx: Ctx,
  s: UssdMenuState,
  repeat: (s: UssdMenuState, note: string) => UssdResponse,
): UssdResponse {
  const count = (s.invalid ?? 0) + 1;
  if (count >= MAX_INVALID) {
    return end(ctx, { ...s, invalid: count }, ['Too many invalid entries. Please dial again.']);
  }
  return repeat({ ...s, invalid: count }, 'Invalid choice.');
}

/**
 * One step of the menu. Pure apart from the `UssdApplication` calls. The input is the latest
 * part of the provider's `text`; the caller loads and stores `session_state`.
 */
export async function runUssdMenu(
  params: UssdSessionParams,
  app: UssdApplication,
  opts: { label: string },
): Promise<UssdResponse> {
  const ctx: Ctx = { label: opts.label };
  const caller: UssdCaller = { sessionKeyHash: params.session_key_hash, msisdnHash: params.msisdn };
  const s = (params.session_state ?? {}) as UssdMenuState;
  const input = params.input.trim();

  if (!s.screen) return facilityScreen(ctx, {});
  if (input === EXIT) return end(ctx, s, ['Goodbye. Thank you for using QueueBridge.']);

  switch (s.screen) {
    case 'facility_code': {
      if (!/^[1-9][0-9]{5}$/.test(input)) {
        return invalid(ctx, s, (n, note) => facilityScreen(ctx, n, `${note} Use 6 digits.`));
      }
      const facility = await app.findFacility(caller, input);
      if (!facility) {
        const tries = (s.facilityTries ?? 0) + 1;
        if (tries >= MAX_FACILITY_TRIES) {
          return end(ctx, { ...s, facilityTries: tries }, [
            'No facility found. Check the code shown at the facility and dial again.',
          ]);
        }
        return facilityScreen(ctx, { ...s, facilityTries: tries }, 'No facility has that code.');
      }
      return mainScreen(ctx, { ...s, facility, invalid: 0 });
    }

    case 'main': {
      if (input === '1') return servicesScreen(ctx, app, caller, s, 0);
      if (input === '2') return ticketCodeScreen(ctx, { ...s, intent: 'status', invalid: 0 });
      if (input === '3') return recoverScreen(ctx, { ...s, invalid: 0 });
      return invalid(ctx, s, (n, note) => mainScreen(ctx, n, note));
    }

    case 'services': {
      if (input === BACK) return mainScreen(ctx, { ...s, options: [], page: 0 });
      if (input === MORE) return servicesScreen(ctx, app, caller, s, (s.page ?? 0) + 1);
      const options = s.options ?? [];
      const n = /^[1-9]$/.test(input) ? Number(input) : 0;
      const choice = n >= 1 ? options[n - 1] : undefined;
      if (!choice) {
        return invalid(ctx, s, (st, note) => {
          const r = con(ctx, st, [note, 'Choose a number from the list.', `${BACK} Back`]);
          return { ...r, next_state: { ...st, screen: 'services' } };
        });
      }
      // Fresh, committed figures for the chosen service (it may have closed meanwhile)
      const now = (await app.listServices(caller, s.facility as UssdFacilityRef)).find(
        (o) => o.queueId === choice.queueId,
      );
      if (!now) {
        return con(ctx, { ...s, screen: 'services', invalid: 0 }, [
          `${clip(choice.name, 30)} is not taking visitors right now.`,
          `${BACK} Back`,
          `${EXIT} Exit`,
        ]);
      }
      const selected = {
        queueId: now.queueId,
        name: now.name,
        waiting: now.waiting,
        estimate: now.estimate,
      };
      return con(
        ctx,
        { ...s, screen: 'confirm', selected, joinOperationId: uuidv7(), invalid: 0 },
        [
          `Join ${clip(now.name, 30)}? ${now.waiting} waiting.`,
          now.estimate ? `Wait about ${now.estimate} (not a promise).` : '',
          '1 Join',
          `${BACK} Back`,
          `${EXIT} Exit`,
        ],
      );
    }

    case 'confirm': {
      if (input === BACK) return servicesScreen(ctx, app, caller, s, s.page ?? 0);
      if (input !== '1' || !s.selected || !s.joinOperationId) {
        return invalid(ctx, s, (st, note) =>
          con(ctx, st, [
            note,
            `Join ${clip(st.selected?.name ?? '', 30)}?`,
            '1 Join',
            `${BACK} Back`,
          ]),
        );
      }
      const r = await app.join(
        caller,
        s.facility as UssdFacilityRef,
        s.selected.queueId,
        s.joinOperationId,
      );
      if (r.ok) {
        const lines = [`Ticket ${r.code}, ${clip(r.service, 24)}.`];
        if (r.recoveryKey) {
          lines.push(
            `Key: ${groupKey(r.recoveryKey)}`,
            'Write down the code and key to check your ticket later.',
          );
        } else {
          lines.push('Checking this ticket by phone is not available here. Ask staff.');
        }
        return end(ctx, { ...s, joined: { code: r.code } }, lines);
      }
      const name = clip(s.selected.name, 30);
      if (r.reason === 'limit') {
        return end(ctx, s, [
          'This phone has joined as many queues as allowed for now. Please ask staff.',
        ]);
      }
      if (r.reason === 'unavailable') {
        return end(ctx, s, ['Joining is not available right now. Try again later or ask staff.']);
      }
      const why =
        r.reason === 'closed'
          ? `${name} has closed.`
          : r.reason === 'paused'
            ? `${name} is paused and not taking new visitors.`
            : `${name} is not taking visitors right now.`;
      return con(ctx, { ...s, screen: 'services', invalid: 0 }, [
        why,
        `${BACK} Back`,
        `${EXIT} Exit`,
      ]);
    }

    case 'recover_menu': {
      if (input === BACK) return mainScreen(ctx, s);
      if (input === '1') return ticketCodeScreen(ctx, { ...s, intent: 'recover', invalid: 0 });
      if (input === '2') {
        return end(ctx, s, [
          `Ask staff at ${clip((s.facility as UssdFacilityRef).name, 40)}. They can help you safely in person.`,
          'A phone number or a ticket code alone cannot open a ticket.',
        ]);
      }
      return invalid(ctx, s, (n, note) => recoverScreen(ctx, n, note));
    }

    case 'ticket_code': {
      if (input === BACK) {
        return s.intent === 'recover'
          ? recoverScreen(ctx, { ...s, invalid: 0 })
          : mainScreen(ctx, s);
      }
      const code = input.toUpperCase();
      if (!/^[A-Z]{1,3}[0-9]{3,4}$/.test(code)) {
        return invalid(ctx, s, (n, note) => ticketCodeScreen(ctx, n, `${note} Not a ticket code.`));
      }
      return ticketKeyScreen(ctx, { ...s, ticketCode: code, invalid: 0 });
    }

    case 'ticket_key': {
      if (input === BACK) return ticketCodeScreen(ctx, { ...s, ticketCode: undefined, invalid: 0 });
      // The key is used for this one check and is never kept in the state
      const r = await app.checkTicket(
        caller,
        s.facility as UssdFacilityRef,
        s.ticketCode ?? '',
        input,
      );
      const done: UssdMenuState = { ...s, ticketCode: undefined };
      if (!r.ok) {
        if (r.reason === 'throttled') {
          return end(ctx, done, ['Too many attempts. Try again in 15 minutes or ask staff.']);
        }
        if (r.reason === 'unavailable') {
          return end(ctx, done, [
            'Ticket checks are not available here right now. Please ask staff.',
          ]);
        }
        return end(ctx, done, [
          'We could not open a ticket with these details. Check the code and key, or ask staff.',
        ]);
      }
      const moved = r.movedFrom ? `Moved from ${r.movedFrom}. ` : '';
      if (s.intent === 'recover') {
        return end(ctx, done, [
          `${moved}Your ticket is ${r.code}.`,
          statusLine(r),
          'Keep your key safe.',
        ]);
      }
      return end(ctx, done, [moved ? moved.trim() : '', statusLine(r)]);
    }
  }
  return facilityScreen(ctx, {});
}
