import {
  CAPABILITY_IDS,
  KbArticleSchema,
  type CapabilityEntry,
  type CapabilityId,
  type CapabilityManifest,
  type KbArticle,
  type RoleGrant,
} from '@queuebridge/contracts';
import type { KbBundle } from './answer.js';

/**
 * TEST FIXTURES ONLY — not knowledge-base content. Real articles are authored in MQ.5; these
 * stand-ins reuse the approved ids from design §11.10a so the registry defaults resolve.
 */

export const FA = '0193a000-0000-7000-8000-00000000000a';
export const FB = '0193a000-0000-7000-8000-00000000000b';
export const QA = '0193a000-0000-7000-8000-0000000000a1';

export const grant = (role: RoleGrant['role'], facility_id: string | null = FA): RoleGrant => ({
  role,
  facility_id,
});

function a(over: Partial<KbArticle> & Pick<KbArticle, 'id' | 'title' | 'audiences'>): KbArticle {
  return KbArticleSchema.parse({
    topics: ['staff_operations'],
    requiresCapabilities: [],
    relatedRoutes: [],
    availableSince: 'M5',
    version: 1,
    lastReviewed: '2026-11-16',
    keywords: [],
    body: '# Fixture\n\nTest fixture body.',
    ...over,
  });
}

const STAFF = ['reception', 'counter', 'supervisor', 'facility_admin', 'auditor'] as const;

export const ARTICLES: readonly KbArticle[] = [
  a({
    id: 'visitor.join.status',
    title: 'Joining a queue and checking your ticket',
    audiences: ['visitor'],
    topics: ['registration', 'ticket_status'],
    requiresCapabilities: ['visitor_join'],
    relatedRoutes: ['visitor.join', 'visitor.ticket'],
    keywords: ['join', 'qr', 'position', 'estimate'],
  }),
  a({
    id: 'visitor.recovery.key',
    title: 'Your recovery key',
    audiences: ['visitor'],
    topics: ['recovery'],
    requiresCapabilities: ['ticket_recovery_key'],
    relatedRoutes: ['visitor.recover'],
    keywords: ['recovery', 'key', 'lost', 'phone'],
  }),
  a({
    id: 'visitor.recovery.how',
    title: 'Recovering a ticket',
    audiences: ['visitor'],
    topics: ['recovery'],
    requiresCapabilities: ['ticket_recovery_key'],
    relatedRoutes: ['visitor.recover'],
    keywords: ['recover', 'lost', 'new phone'],
  }),
  a({
    id: 'visitor.recovery.staff',
    title: 'Getting help from staff without your key',
    audiences: ['visitor'],
    topics: ['recovery'],
    requiresCapabilities: ['staff_assisted_recovery'],
    relatedRoutes: ['visitor.recover'],
    keywords: ['staff', 'help', 'no key', 'recovery'],
    body: '# Ask staff\n\nStaff ask some questions about your visit.',
  }),
  a({
    id: 'staff.recovery.assist',
    title: 'Staff-assisted recovery: verification questions',
    audiences: ['reception', 'counter', 'supervisor', 'facility_admin'],
    topics: ['recovery'],
    requiresCapabilities: ['staff_assisted_recovery'],
    relatedRoutes: ['staff.console'],
    keywords: ['verification', 'questions', 'service', 'join time', 'recovery'],
    body: '# Verification questions\n\nFIXTURE-STAFF-ONLY-VERIFICATION-CONTENT',
  }),
  a({
    id: 'staff.recovery.approve',
    title: 'Approving a recovery request',
    audiences: ['supervisor', 'facility_admin'],
    topics: ['recovery'],
    requiresCapabilities: ['staff_assisted_recovery'],
    relatedRoutes: ['staff.console'],
    keywords: ['approve', 'approver', 'recovery'],
  }),
  a({
    id: 'staff.recovery.activity',
    title: 'Recovery activity on the audit trail',
    audiences: ['supervisor', 'facility_admin', 'auditor'],
    topics: ['recovery', 'audit'],
    requiresCapabilities: ['recovery_audit_view'],
    relatedRoutes: ['staff.audit'],
    keywords: ['recovery', 'activity', 'audit', 'requester', 'approver'],
  }),
  a({
    id: 'staff.sync.states',
    title: 'Sync states explained',
    audiences: [...STAFF],
    topics: ['connectivity'],
    relatedRoutes: ['staff.console', 'staff.connectivity'],
    keywords: ['offline', 'pending', 'committed', 'needs review', 'sync'],
  }),
  a({
    id: 'staff.device.health',
    title: 'Device health alerts',
    audiences: ['supervisor', 'facility_admin', 'auditor'],
    topics: ['connectivity'],
    requiresCapabilities: ['device_health'],
    relatedRoutes: ['staff.connectivity'],
    keywords: ['device', 'stale', 'coordinator', 'alert'],
  }),
  a({
    id: 'staff.roles.workflows',
    title: 'Which role does what',
    audiences: [...STAFF],
    topics: ['staff_operations'],
    relatedRoutes: ['staff.home', 'admin.facility.staff'],
    keywords: ['roles', 'permissions', 'who can'],
  }),
  a({
    id: 'admin.policy.recovery',
    title: 'Recovery and missed-turn policy settings',
    audiences: ['facility_admin'],
    topics: ['facility_configuration'],
    relatedRoutes: ['admin.facility'],
    keywords: ['grace', 'rejoin', 'auto miss', 'policy'],
  }),
  a({
    id: 'visitor.alerts',
    title: 'Turn alerts on your ticket page',
    audiences: ['visitor'],
    topics: ['turn_alerts'],
    requiresCapabilities: ['turn_alert_in_app'],
    relatedRoutes: ['visitor.ticket'],
    keywords: ['alert', 'called', 'sound', 'vibration'],
  }),
  a({
    id: 'visitor.alerts.push',
    title: 'Push alerts when you are called',
    audiences: ['visitor'],
    topics: ['turn_alerts'],
    requiresCapabilities: ['turn_alert_web_push'],
    relatedRoutes: ['visitor.ticket'],
    keywords: ['push', 'notification', 'alert'],
  }),
  a({
    id: 'visitor.sms.alerts',
    title: 'SMS turn alerts',
    audiences: ['visitor'],
    topics: ['turn_alerts'],
    requiresCapabilities: ['sms_turn_alerts'],
    keywords: ['sms', 'text message', 'alert'],
  }),
  a({
    id: 'visitor.ussd',
    title: 'Using USSD',
    audiences: ['visitor'],
    topics: ['registration'],
    requiresCapabilities: ['ussd'],
    keywords: ['ussd', 'feature phone', 'code'],
  }),
];

export const BUNDLE: KbBundle = { kbVersion: 7, articles: ARTICLES };

export function manifest(
  over: Partial<Record<CapabilityId, CapabilityEntry>> = {},
): CapabilityManifest {
  const capabilities = Object.fromEntries(
    CAPABILITY_IDS.map((id) => [id, { status: 'live', availability: 'available' }]),
  ) as Record<CapabilityId, CapabilityEntry>;
  return {
    version: 1,
    generatedAt: '2026-11-16T12:00:00.000Z',
    capabilities: { ...capabilities, ...over },
  };
}

export const NO_PUSH: CapabilityEntry = {
  status: 'live',
  availability: 'unavailable',
  unavailableReason: 'not_configured',
};
export const PLANNED: CapabilityEntry = {
  status: 'planned',
  availability: 'unavailable',
  unavailableReason: 'not_implemented',
};
