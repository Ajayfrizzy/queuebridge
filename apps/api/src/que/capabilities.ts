import {
  CAPABILITY_IDS,
  CAPABILITY_MANIFEST_VERSION,
  CapabilityManifestSchema,
  type CapabilityEntry,
  type CapabilityId,
  type CapabilityManifest,
} from '@queuebridge/contracts';
import type { Env } from '../env.js';
import { VISITOR_JOIN_OPERATIONAL } from '../readiness.js';
import { webPushAvailable } from '../routes/push.js';
import { aiDeploymentAvailable } from './inference.js';

/**
 * Ask Que capability manifest (MQ.1; design §11.2 and §11.10a; decision D1).
 *
 * `status` is what is built; `availability` is whether it can be used in this deployment now.
 * Availability is derived from the same server checks that gate each feature, so the manifest
 * cannot disagree with the feature. Only booleans leave this module: no environment value, key,
 * host or secret is ever placed in the manifest.
 */

/** Booleans read from authoritative server configuration. */
export interface CapabilityFlags {
  visitorJoinOperational: boolean;
  webPushAvailable: boolean;
  /**
   * MQ.4: the AI layer may be called here. With no approved provider this is only ever true for
   * the TEST-ONLY sandbox adapter, which the manifest reports as `sandbox`, never `live`.
   */
  aiAvailable: 'off' | 'sandbox';
}

export function capabilityFlags(
  env: Pick<
    Env,
    | 'CONTACT_ENCRYPTION_KEY'
    | 'VAPID_PUBLIC_KEY'
    | 'QUE_AI_ADAPTER'
    | 'QUE_AI_ENABLED'
    | 'QUE_AI_COST_MODE'
    | 'QUE_AI_DAILY_CAP'
  >,
): CapabilityFlags {
  return {
    visitorJoinOperational: VISITOR_JOIN_OPERATIONAL,
    webPushAvailable: webPushAvailable(env),
    aiAvailable: aiDeploymentAvailable(env) && env.QUE_AI_ADAPTER === 'sandbox' ? 'sandbox' : 'off',
  };
}

const AVAILABLE = { status: 'live', availability: 'available' } as const;

function liveIf(
  ok: boolean,
  since: CapabilityEntry['since'],
  reason: 'not_configured' | 'switched_off',
  note: string,
): CapabilityEntry {
  return ok
    ? { ...AVAILABLE, since }
    : { status: 'live', availability: 'unavailable', unavailableReason: reason, since, note };
}

function planned(note: string): CapabilityEntry {
  return {
    status: 'planned',
    availability: 'unavailable',
    unavailableReason: 'not_implemented',
    note,
  };
}

/**
 * Build the manifest. Exhaustive over `CAPABILITY_IDS`; validated against the shared schema
 * before it is returned, so a malformed manifest can never be served.
 */
export function buildCapabilityManifest(flags: CapabilityFlags, now: Date): CapabilityManifest {
  const capabilities: Record<CapabilityId, CapabilityEntry> = {
    visitor_join: liveIf(
      flags.visitorJoinOperational,
      'M2',
      'switched_off',
      'Online joining is switched off here.',
    ),
    ticket_recovery_key: { ...AVAILABLE, since: 'M5' },
    // Per-service policy (staff_recovery, rejoin_policy, auto_miss) is facility context, not
    // deployment availability (design §11.10a): it is read online per service.
    staff_assisted_recovery: { ...AVAILABLE, since: 'M5' },
    recovery_audit_view: { ...AVAILABLE, since: 'M5' },
    self_resume: { ...AVAILABLE, since: 'M5' },
    auto_miss: { ...AVAILABLE, since: 'M5' },
    offline_coordinator: { ...AVAILABLE, since: 'M3' },
    device_health: { ...AVAILABLE, since: 'M5' },
    turn_alert_in_app: { ...AVAILABLE, since: 'M5' },
    turn_alert_sound: { ...AVAILABLE, since: 'M5' },
    turn_alert_vibration: { ...AVAILABLE, since: 'M5' },
    turn_alert_web_push: liveIf(
      flags.webPushAvailable,
      'M5',
      'not_configured',
      'Push alerts are not set up here.',
    ),
    accessibility_prefs: { ...AVAILABLE, since: 'M5' },
    sms_turn_alerts: planned('SMS turn alerts are planned (M6).'),
    ussd: planned('USSD access is planned (M6).'),
    // MQ.4: the layer is built; it is switched off unless a zero-cost adapter is enabled. No
    // provider is selected, so it is never `live` + `available` (D1).
    ask_que_ai:
      flags.aiAvailable === 'sandbox'
        ? {
            status: 'sandbox',
            availability: 'available',
            since: 'MQ',
            note: 'TEST-ONLY sandbox AI explanations.',
          }
        : {
            status: 'live',
            availability: 'unavailable',
            unavailableReason: 'switched_off',
            since: 'MQ',
            note: 'AI explanations are switched off here; built-in help is available.',
          },
  };
  // Exhaustiveness is also enforced by the schema (record over the capability enum)
  for (const id of CAPABILITY_IDS) {
    if (!(id in capabilities)) throw new Error(`capability manifest missing ${id}`);
  }
  return CapabilityManifestSchema.parse({
    version: CAPABILITY_MANIFEST_VERSION,
    generatedAt: now.toISOString(),
    capabilities,
  });
}
