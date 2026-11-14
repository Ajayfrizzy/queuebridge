import type { DeviceHealthState, HealthAlert, OwnDeviceWarningKind } from '@queuebridge/contracts';

/**
 * Plain-language wording for device health (catalog strings; REQ-F7.12). Honest about what the
 * server cannot know: a silent device may be offline, asleep, closed or lost; pending counts are
 * reported by the device and approximate. Nothing here suggests that the system will act by itself.
 */
export const HEALTH_LABEL: Record<DeviceHealthState, { symbol: string; text: string }> = {
  healthy: { symbol: '●', text: 'Healthy' },
  pending: { symbol: '↑', text: 'Has unsent actions' },
  offline: { symbol: '○', text: 'Offline / not heard from' },
  stale: { symbol: '◌', text: 'Stale: silent for a long time' },
  needs_review: { symbol: '!', text: 'Needs review' },
  revoked: { symbol: '✕', text: 'Revoked' },
};

/** Lower is more urgent (sorting by severity). */
export const HEALTH_RANK: Record<DeviceHealthState, number> = {
  needs_review: 0,
  stale: 1,
  offline: 2,
  pending: 3,
  healthy: 4,
  revoked: 5,
};

export const SEVERITY_LABEL: Record<HealthAlert['severity'], { symbol: string; text: string }> = {
  high: { symbol: '▲', text: 'High' },
  medium: { symbol: '■', text: 'Medium' },
  low: { symbol: '▽', text: 'Low' },
};

const n = (a: HealthAlert, k: string): number => a.details[k] ?? 0;
const s = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

export function alertTitle(a: HealthAlert): string {
  const subject = a.subject_label ?? 'Unnamed';
  switch (a.kind) {
    case 'coordinator_offline':
      return `${subject}: the offline coordinator is not responding`;
    case 'coordinator_expiring':
      return `${subject}: coordinator authorization is about to end`;
    case 'coordinator_expired':
      return `${subject}: coordinator authorization has ended`;
    case 'device_stale_pending':
      return `${subject}: silent for a long time with unsent actions`;
    case 'sync_failing':
      return `${subject}: sending keeps failing`;
    case 'conflicts_unreviewed':
      return `${subject}: offline actions are waiting for review`;
    case 'recovery_abuse':
      return 'Many failed ticket-recovery attempts';
    case 'alert_pipeline_failing':
      return 'Turn alerts are failing';
  }
}

export function alertAdvice(a: HealthAlert): string {
  switch (a.kind) {
    case 'coordinator_offline':
      return (
        `${s(n(a, 'waiting'), 'visitor is', 'visitors are')} waiting and ${s(n(a, 'called'), 'is', 'are')} called. ` +
        'The device may be offline, asleep, closed or lost, and it may still be working on site. ' +
        'You can wait, or fail over to another device in "Queues and coordinator authority". ' +
        'Failing over fences the old device: anything it did offline is held for review, never applied. ' +
        'Nothing happens automatically.'
      );
    case 'coordinator_expiring':
      return 'Renew it in "Queues and coordinator authority" if the outage continues. Renewing needs a connection.';
    case 'coordinator_expired':
      return 'The device can no longer call or serve offline; it can only record new arrivals. Renew or end the authority.';
    case 'device_stale_pending':
      return (
        `It last reported about ${s(n(a, 'pending'), 'unsent action', 'unsent actions')} (approximate). ` +
        'Those actions stay on the device until it reconnects. If the device is lost, revoke it: its actions may then be lost.'
      );
    case 'sync_failing':
      return `The same problem was reported ${s(n(a, 'reports'), 'time', 'times')} in a row. Check the device and its connection.`;
    case 'conflicts_unreviewed':
      return `${s(n(a, 'conflicts'), 'action is', 'actions are')} waiting. Review them in "Conflict review" below.`;
    case 'recovery_abuse':
      return 'Someone may be guessing recovery keys. The attempts are being slowed down automatically; no visitor is locked out.';
    case 'alert_pipeline_failing':
      return `${s(n(a, 'failed'), 'turn alert', 'turn alerts')} failed in the last hour. Visitors still see their status and the public board.`;
  }
}

export const OWN_WARNING_TEXT: Record<OwnDeviceWarningKind, (service: string | null) => string> = {
  coordinator_expiring: (svc) =>
    `Your coordinator authorization${svc ? ` for ${svc}` : ''} is about to end. Ask a supervisor to renew it while you are online.`,
  coordinator_expired: (svc) =>
    `Your coordinator authorization${svc ? ` for ${svc}` : ''} has ended. This device can no longer call or serve offline.`,
  sync_failing: () =>
    'This device keeps failing to send or save its actions. Check the connection, or ask a supervisor.',
};
