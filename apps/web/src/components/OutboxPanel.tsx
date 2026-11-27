import type { ReactElement } from 'react';
import { QueueAction, SyncStatus } from '@queuebridge/contracts';
import type { OutboxOperation } from '@queuebridge/continuity';
import { SyncStateIndicator } from '@queuebridge/ui';

const VERB: Record<string, string> = {
  [QueueAction.TICKET_CREATE]: 'Captured ticket',
  [QueueAction.TICKET_CALL_NEXT]: 'Called',
  [QueueAction.TICKET_SERVE]: 'Started serving',
  [QueueAction.TICKET_COMPLETE]: 'Completed',
  [QueueAction.TICKET_MISS]: 'Marked missed',
};

/** Plain-language description of one recorded action (no ids shown to people). */
export function describeOperation(
  op: OutboxOperation,
  labelFor: (op: OutboxOperation) => string,
): string {
  const verb = VERB[op.action] ?? op.action;
  return `${verb} ${op.result?.public_code ?? labelFor(op)}`.trim();
}

/** The device's recorded actions for this queue with their sync state. */
export function OutboxPanel({
  ops,
  labelFor,
}: {
  ops: OutboxOperation[];
  labelFor: (op: OutboxOperation) => string;
}): ReactElement | null {
  const visible = ops
    .filter((o) => o.status !== SyncStatus.COMMITTED && o.status !== SyncStatus.DUPLICATE)
    .sort((a, b) => a.client_sequence - b.client_sequence);
  if (visible.length === 0) return null;
  return (
    <section aria-labelledby="outbox-heading" className="card" data-testid="outbox-panel">
      <h2 id="outbox-heading" className="card-title">
        Actions on this device
      </h2>
      <p className="hint">
        These were saved here and are <strong>not confirmed</strong> by the server until they show
        Synced.
      </p>
      <ul className="op-list">
        {visible.map((o) => (
          <li
            key={o.operation_id}
            className="op-row"
            data-testid="outbox-row"
            data-status={o.status}
          >
            <span>{describeOperation(o, labelFor)}</span>
            <SyncStateIndicator status={o.status} />
            {o.status === SyncStatus.NEEDS_REVIEW || o.status === SyncStatus.REJECTED ? (
              <span className="muted">
                {o.result?.message ?? 'A supervisor will look at this.'}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
