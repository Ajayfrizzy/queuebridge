import {
  isCapabilityShowable,
  isCapabilityUsable,
  type CapabilityId,
} from '@queuebridge/contracts';

/**
 * Capability gating for help content (design §11.2, decision D1). Que presents a capability as
 * usable only when it is `live` and `available`; an available `preview` or `sandbox` capability
 * is shown with its label; anything else is never offered as usable.
 */

/** Plain names used in notices. */
export const CAPABILITY_NAMES: Readonly<Record<CapabilityId, string>> = {
  visitor_join: 'Joining a queue online',
  ticket_recovery_key: 'Ticket recovery with a recovery key',
  staff_assisted_recovery: 'Staff-assisted ticket recovery',
  recovery_audit_view: 'Recovery activity view',
  self_resume: 'Returning to the queue yourself after a missed turn',
  auto_miss: 'Automatic missed turns',
  offline_coordinator: 'Offline queue coordinator',
  device_health: 'Device health alerts',
  turn_alert_in_app: 'In-app turn alerts',
  turn_alert_sound: 'Turn alert sound',
  turn_alert_vibration: 'Turn alert vibration',
  turn_alert_web_push: 'Push turn alerts',
  accessibility_prefs: 'Display settings',
  sms_turn_alerts: 'SMS turn alerts',
  ussd: 'USSD access',
  ask_que_ai: 'AI explanations in Ask Que',
};

const TURN_FALLBACK = 'The ticket page, the public board and staff calling still show your turn.';

/** The reliable fallback named when an alert channel cannot be used (design §11.2, D1). */
const FALLBACK: Partial<Readonly<Record<CapabilityId, string>>> = {
  turn_alert_web_push: TURN_FALLBACK,
  turn_alert_sound: TURN_FALLBACK,
  turn_alert_vibration: TURN_FALLBACK,
  sms_turn_alerts: TURN_FALLBACK,
  ussd: 'Ask a member of staff for help joining or checking a ticket.',
  ask_que_ai: 'Built-in help is available.',
};

export type CapabilityGate = 'usable' | 'labelled' | 'blocked';

/** How an article requiring `ids` may be used. Fails closed on any unknown or missing entry. */
export function gateFor(manifest: unknown, ids: readonly CapabilityId[]): CapabilityGate {
  let labelled = false;
  for (const id of ids) {
    if (isCapabilityUsable(manifest, id)) continue;
    if (isCapabilityShowable(manifest, id)) {
      labelled = true;
      continue;
    }
    return 'blocked';
  }
  return labelled ? 'labelled' : 'usable';
}

function entryOf(manifest: unknown, id: CapabilityId): Record<string, unknown> | null {
  if (typeof manifest !== 'object' || manifest === null) return null;
  const caps = (manifest as { capabilities?: unknown }).capabilities;
  if (typeof caps !== 'object' || caps === null) return null;
  if (!Object.prototype.hasOwnProperty.call(caps, id)) return null;
  const e = (caps as Record<string, unknown>)[id];
  return typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : null;
}

/**
 * One plain sentence for a capability that is not usable as live, or `null` when it is.
 * Never says or implies that an unavailable capability can be used.
 */
export function capabilityNotice(manifest: unknown, id: CapabilityId): string | null {
  if (isCapabilityUsable(manifest, id)) return null;
  const name = CAPABILITY_NAMES[id];
  const e = entryOf(manifest, id);
  if (isCapabilityShowable(manifest, id)) {
    return e?.['status'] === 'sandbox'
      ? `${name}: sandbox (test only, no real messages).`
      : `${name}: preview.`;
  }
  const reason = e?.['unavailableReason'];
  const status = e?.['status'];
  const fallback = FALLBACK[id];
  let text: string;
  if (status === 'planned' || reason === 'not_implemented') text = `${name}: not available yet.`;
  else if (reason === 'not_configured' || reason === 'switched_off') {
    text = `${name}: not set up here.`;
  } else {
    // Missing, unknown or malformed entry: fail closed with neutral wording
    text = `${name}: not available here.`;
  }
  return fallback ? `${text} ${fallback}` : text;
}
