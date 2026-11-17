import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_IDS,
  CapabilityEntrySchema,
  CapabilityManifestSchema,
  KbArticleSchema,
  QueAnswerSchema,
  ROUTE_IDS,
  RouteIdSchema,
  SafeMarkdownSchema,
  isCapabilityShowable,
  isCapabilityUsable,
  safeMarkdownRouteRefs,
  type CapabilityEntry,
  type CapabilityId,
} from './index.js';

const article = {
  id: 'visitor.join.status',
  title: 'Joining a queue and checking your ticket',
  audiences: ['visitor'],
  topics: ['registration', 'ticket_status'],
  requiresCapabilities: ['visitor_join'],
  relatedRoutes: ['visitor.join'],
  availableSince: 'M2',
  version: 1,
  lastReviewed: '2026-11-16',
  keywords: ['join', 'qr', 'ticket'],
  body: '# Join\n\n- Scan the QR code.\n- See [your ticket](route:visitor.ticket).',
};

function manifest(over: Partial<Record<CapabilityId, CapabilityEntry>> = {}): unknown {
  const capabilities = Object.fromEntries(
    CAPABILITY_IDS.map((id) => [id, { status: 'live', availability: 'available' }]),
  );
  return {
    version: 1,
    generatedAt: '2026-11-16T12:00:00.000Z',
    capabilities: { ...capabilities, ...over },
  };
}

describe('KbArticleSchema (REQ-F13.2.3)', () => {
  it('accepts a complete article', () => {
    expect(KbArticleSchema.parse(article)).toEqual(article);
  });

  it.each([
    ['id', 'Visitor Join'],
    ['id', 'nodots'],
    ['audiences', []],
    ['audiences', ['visitor_anonymous']],
    ['topics', ['billing']],
    ['requiresCapabilities', ['teleport']],
    ['relatedRoutes', ['supervisor.dashboard']],
    ['availableSince', 'M9'],
    ['version', 0],
    ['lastReviewed', '2026-02-30'],
    ['lastReviewed', '2026-13-01'],
    ['lastReviewed', '16/11/2026'],
  ])('rejects an invalid %s (%j)', (field, value) => {
    expect(KbArticleSchema.safeParse({ ...article, [field]: value }).success).toBe(false);
  });

  it.each(['id', 'title', 'audiences', 'topics', 'version', 'lastReviewed', 'body'])(
    'rejects a missing %s',
    (field) => {
      const a: Record<string, unknown> = { ...article };
      delete a[field];
      expect(KbArticleSchema.safeParse(a).success).toBe(false);
    },
  );

  it('rejects unknown fields (strict)', () => {
    expect(KbArticleSchema.safeParse({ ...article, tenant: 'x' }).success).toBe(false);
  });
});

describe('SafeMarkdownSchema (design §11.2: links to RouteIds only)', () => {
  it('allows ordinary prose with colons ("Device data: label and owner")', () => {
    expect(SafeMarkdownSchema.safeParse('Device data: label and owner. Note: no IP.').success).toBe(
      true,
    );
  });

  it('allows headings, lists, emphasis and route links', () => {
    const body = '## Steps\n\n1. Open **settings**.\n2. See _help_ in [audit](route:staff.audit).';
    expect(SafeMarkdownSchema.safeParse(body).success).toBe(true);
    expect(safeMarkdownRouteRefs(body)).toEqual(['staff.audit']);
  });

  it.each([
    ['raw HTML', 'Hello <script>alert(1)</script>'],
    ['an HTML tag', '<img src=x onerror=alert(1)>'],
    ['an external link', '[site](https://example.com)'],
    ['a bare URL', 'Visit http://example.com now'],
    ['a javascript: link', '[x](javascript:alert(1))'],
    ['a data: link', '[x](data:text/html;base64,AAAA)'],
    ['a relative path link', '[x](/staff/queues/1)'],
    ['a reference definition', '[x][1]\n\n[1]: /admin'],
    ['an image', '![x](route:public.home)'],
    ['an unknown route', '[x](route:supervisor.dashboard)'],
    ['a code block', '```\ncode\n```'],
    ['a mailto link', 'mailto:someone'],
    ['a www host', 'see www.example.com'],
  ])('rejects %s', (_label, body) => {
    expect(SafeMarkdownSchema.safeParse(body).success).toBe(false);
  });
});

describe('RouteIdSchema (design §11.3.1)', () => {
  it('lists the verified screens and excludes the /supervisor placeholder', () => {
    expect(ROUTE_IDS).toHaveLength(16);
    expect(ROUTE_IDS.some((r) => r.startsWith('supervisor'))).toBe(false);
    expect(RouteIdSchema.safeParse('staff.connectivity').success).toBe(true);
    expect(RouteIdSchema.safeParse('supervisor').success).toBe(false);
  });
});

describe('Capability manifest (decision D1)', () => {
  it('accepts an exhaustive manifest', () => {
    expect(CapabilityManifestSchema.safeParse(manifest()).success).toBe(true);
  });

  it('keeps exactly four lifecycle statuses', () => {
    for (const status of ['live', 'preview', 'sandbox', 'planned']) {
      const e =
        status === 'planned'
          ? { status, availability: 'unavailable', unavailableReason: 'not_implemented' }
          : { status, availability: 'available' };
      expect(CapabilityEntrySchema.safeParse(e).success).toBe(true);
    }
    expect(
      CapabilityEntrySchema.safeParse({ status: 'disabled', availability: 'available' }).success,
    ).toBe(false);
  });

  it.each([
    ['missing availability', { status: 'live' }],
    ['unknown availability', { status: 'live', availability: 'maybe' }],
    ['unavailable without a reason', { status: 'live', availability: 'unavailable' }],
    [
      'available with a reason',
      { status: 'live', availability: 'available', unavailableReason: 'not_configured' },
    ],
    ['planned but available', { status: 'planned', availability: 'available' }],
    [
      'planned with the wrong reason',
      { status: 'planned', availability: 'unavailable', unavailableReason: 'not_configured' },
    ],
    ['an unknown field', { status: 'live', availability: 'available', secret: 'x' }],
  ])('rejects an entry with %s', (_label, entry) => {
    expect(CapabilityEntrySchema.safeParse(entry).success).toBe(false);
  });

  it('rejects a manifest missing a capability (exhaustive) or with an unknown one', () => {
    const m = manifest() as { capabilities: Record<string, unknown> };
    const missing = { ...m, capabilities: { ...m.capabilities } };
    delete missing.capabilities['turn_alert_web_push'];
    expect(CapabilityManifestSchema.safeParse(missing).success).toBe(false);
    const extra = { ...m, capabilities: { ...m.capabilities, teleport: m.capabilities['ussd'] } };
    expect(CapabilityManifestSchema.safeParse(extra).success).toBe(false);
  });

  it('usable only when live AND available', () => {
    const m = manifest({
      turn_alert_web_push: {
        status: 'live',
        availability: 'unavailable',
        unavailableReason: 'not_configured',
      },
      sms_turn_alerts: { status: 'sandbox', availability: 'available' },
      ussd: {
        status: 'planned',
        availability: 'unavailable',
        unavailableReason: 'not_implemented',
      },
      device_health: { status: 'preview', availability: 'available' },
    });
    expect(isCapabilityUsable(m, 'ticket_recovery_key')).toBe(true);
    expect(isCapabilityUsable(m, 'turn_alert_web_push')).toBe(false);
    expect(isCapabilityUsable(m, 'sms_turn_alerts')).toBe(false);
    expect(isCapabilityUsable(m, 'ussd')).toBe(false);
    expect(isCapabilityUsable(m, 'device_health')).toBe(false);
    // Preview/sandbox may be shown (labelled) but are never "usable"
    expect(isCapabilityShowable(m, 'sms_turn_alerts')).toBe(true);
    expect(isCapabilityShowable(m, 'device_health')).toBe(true);
    expect(isCapabilityShowable(m, 'turn_alert_web_push')).toBe(false);
    expect(isCapabilityShowable(m, 'ussd')).toBe(false);
  });

  it('fails closed on missing, unknown or malformed input', () => {
    const bad: unknown[] = [
      undefined,
      null,
      'live',
      {},
      { capabilities: null },
      { capabilities: { turn_alert_in_app: { status: 'live' } } },
      { capabilities: { turn_alert_in_app: { status: 'live', availability: 'yes' } } },
      { capabilities: { turn_alert_in_app: { availability: 'available' } } },
      { capabilities: { turn_alert_in_app: null } },
    ];
    for (const m of bad) {
      expect(isCapabilityUsable(m, 'turn_alert_in_app')).toBe(false);
      expect(isCapabilityShowable(m, 'turn_alert_in_app')).toBe(false);
    }
    expect(isCapabilityUsable(manifest(), 'teleport')).toBe(false);
    // Prototype keys are not capabilities
    expect(isCapabilityUsable({ capabilities: {} }, 'constructor')).toBe(false);
  });
});

describe('QueAnswerSchema (design §11.4)', () => {
  const ok = {
    mode: 'deterministic',
    text: '1 help article matches.',
    citations: ['visitor.join.status'],
    links: ['visitor.recover'],
    kbVersion: 3,
  };

  it('round-trips a deterministic answer', () => {
    expect(QueAnswerSchema.parse(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
    expect(
      QueAnswerSchema.safeParse({ ...ok, mode: 'ai', fallbackReason: 'timeout' }).success,
    ).toBe(true);
  });

  it.each([
    ['an unknown mode', { mode: 'tool' }],
    ['a link outside the registry', { links: ['/supervisor/x'] }],
    ['an unknown fallback reason', { fallbackReason: 'paid_tier' }],
    ['an action field', { action: 'ticket.call_next' }],
    ['a negative kbVersion', { kbVersion: -1 }],
  ])('rejects %s', (_label, over) => {
    expect(QueAnswerSchema.safeParse({ ...ok, ...over }).success).toBe(false);
  });
});
