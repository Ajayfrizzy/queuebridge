import { useId, useRef, useState, type ReactElement } from 'react';
import {
  COUNTER_CLOSE_REASONS,
  COUNTER_TRANSFER_REASONS,
  type CounterAvailabilityResult,
  type PriorityClass,
  type StaffQueue,
} from '@queuebridge/contracts';
import { api } from '../lib/api.js';
import { OperationIdTracker, type RunOutcome } from '../lib/operationIds.js';
import { classLabel } from '../lib/policy.js';

/**
 * M4 staff controls: priority overrides, routing overrides (call out of order), counter
 * availability and counter-to-counter transfers. Controls are shown only to roles that may use
 * them, but EVERY rule is enforced by the API — a hidden button is a courtesy, not a control.
 *
 * `run` executes one online action and returns true on success; the console owns busy state,
 * announcements, error display and the reload afterwards.
 */
export type RunOnline = (action: () => Promise<string>) => Promise<RunOutcome>;

const REASON_LABELS: Record<string, string> = {
  accessibility_need: 'Accessibility need',
  urgent_need: 'Urgent need',
  returning_visitor: 'Returning visitor',
  administrative_error: 'Administrative error',
  specialist_counter: 'Needs a specialist counter',
  counter_closing: 'This counter is closing',
  visitor_request: 'Visitor asked',
  staff_judgement: 'Staff judgement',
  break: 'Break',
  end_of_shift: 'End of shift',
  equipment_issue: 'Equipment issue',
  staff_reassigned: 'Staff reassigned',
  other: 'Other',
};

/** Human label for a reason code (configured custom codes fall back to a readable form). */
export function reasonLabel(code: string): string {
  const known = REASON_LABELS[code];
  if (known) return known;
  const s = code.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Priority class as text plus a symbol — never colour alone. Nothing for the default class. */
export function PriorityBadge({ cls }: { cls: PriorityClass }): ReactElement | null {
  if (cls === 'normal') return null;
  return (
    <span className="badge badge-priority" data-testid="priority-badge">
      <span aria-hidden="true">{cls === 'urgent' ? '▲▲ ' : '▲ '}</span>
      {classLabel(cls)}
    </span>
  );
}

interface TicketRef {
  id: string;
  public_code: string;
  priority_class: PriorityClass;
}

/**
 * Supervisor panel for one waiting ticket: change its priority class, or call it to a counter
 * out of the published order. Both require a configured reason and an explanation; both are
 * recorded with the supervisor's name and the policy version, and appear in the audit trail.
 */
export function TicketOverridePanel({
  ticket,
  policy,
  counter,
  canCallOutOfOrder,
  disabled,
  run,
  onClose,
}: {
  ticket: TicketRef;
  policy: StaffQueue['policy'];
  /** This device's counter, when it can take a call right now */
  counter: { id: string; name: string } | null;
  /**
   * MQ.5 U2: calling out of order is a supervisor transition (and organization administrators);
   * facility administrators keep "Change priority". The API enforces it either way.
   */
  canCallOutOfOrder: boolean;
  disabled: boolean;
  run: RunOnline;
  onClose: () => void;
}): ReactElement {
  const uid = useId();
  const classes = policy.priority_order.filter((c) => c !== ticket.priority_class);
  const [toClass, setToClass] = useState<string>(classes[0] ?? '');
  const [reason, setReason] = useState<string>(policy.override_reasons[0] ?? '');
  const [text, setText] = useState('');
  const [confirming, setConfirming] = useState(false);
  // One operation id per attempt: a retry after a lost response cannot apply twice
  // One id per command; reused only to retry the same command after an unknown outcome
  const overrideIds = useRef(new OperationIdTracker());
  const [callReason, setCallReason] = useState<string>(policy.override_reasons[0] ?? '');
  const [callText, setCallText] = useState('');
  const callIds = useRef(new OperationIdTracker());
  const textOk = text.trim().length >= 5;
  const callTextOk = callText.trim().length >= 5;

  return (
    <div
      className="ticket-row-panel stack-sm"
      data-testid="override-panel"
      role="group"
      aria-label={`Supervisor actions for ${ticket.public_code}`}
    >
      {classes.length > 0 ? (
        <form
          aria-label={`Change priority of ${ticket.public_code}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (!confirming) {
              setConfirming(true);
              return;
            }
            const text_ = text.trim();
            const operationId = overrideIds.current.idFor(
              JSON.stringify([ticket.id, toClass, reason, text_]),
            );
            void run(async () => {
              await api.priorityOverride(ticket.id, {
                operation_id: operationId,
                to_class: toClass as PriorityClass,
                reason_code: reason,
                reason_text: text_,
              });
              return `${ticket.public_code} moved to ${classLabel(toClass)}. The change is recorded in the audit trail.`;
            }).then((outcome) => {
              overrideIds.current.settle(outcome);
              if (outcome === 'committed') onClose();
              setConfirming(false);
            });
          }}
        >
          <fieldset className="form-grid">
            <legend>Change priority</legend>
            <div className="field">
              <label htmlFor={`${uid}-class`}>New class</label>
              <select
                id={`${uid}-class`}
                value={toClass}
                onChange={(e) => {
                  setToClass(e.target.value);
                  setConfirming(false);
                }}
              >
                {classes.map((c) => (
                  <option key={c} value={c}>
                    {classLabel(c)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${uid}-reason`}>Reason</label>
              <select
                id={`${uid}-reason`}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setConfirming(false);
                }}
              >
                {policy.override_reasons.map((r) => (
                  <option key={r} value={r}>
                    {reasonLabel(r)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${uid}-text`}>
                Explanation (kept private, shown only in the audit)
              </label>
              <textarea
                id={`${uid}-text`}
                rows={2}
                maxLength={500}
                value={text}
                aria-describedby={`${uid}-text-hint`}
                onChange={(e) => {
                  setText(e.target.value);
                  setConfirming(false);
                }}
              />
              <p id={`${uid}-text-hint`} className="hint">
                At least 5 characters. Never shown on public screens.
              </p>
            </div>
            {confirming ? (
              <p role="status" className="alert alert-warn" data-testid="override-confirm">
                Move {ticket.public_code} from {classLabel(ticket.priority_class)} to{' '}
                {classLabel(toClass)}? This is recorded with your name, the reason and policy{' '}
                {policy.version}.
              </p>
            ) : null}
            <div className="form-actions btn-row">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={disabled || !textOk || !toClass || !reason}
              >
                {confirming ? 'Confirm priority change' : 'Save priority change'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Close without saving
              </button>
              {confirming ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setConfirming(false)}
                >
                  Go back
                </button>
              ) : null}
            </div>
          </fieldset>
        </form>
      ) : (
        <p className="hint">This service has no priority classes, so priority cannot change.</p>
      )}

      {canCallOutOfOrder ? (
        <form
          aria-label={`Call ${ticket.public_code} out of order`}
          onSubmit={(e) => {
            e.preventDefault();
            if (!counter) return;
            const callText_ = callText.trim();
            const operationId = callIds.current.idFor(
              JSON.stringify([ticket.id, counter.id, callReason, callText_]),
            );
            void run(async () => {
              await api.callOutOfOrder(ticket.id, {
                operation_id: operationId,
                counter_id: counter.id,
                reason_code: callReason,
                reason_text: callText_,
              });
              return `Called ${ticket.public_code} to ${counter.name} out of order. Recorded in the audit trail.`;
            }).then((outcome) => {
              callIds.current.settle(outcome);
              if (outcome === 'committed') onClose();
            });
          }}
        >
          <fieldset className="form-grid">
            <legend>Call out of order</legend>
            {counter ? null : (
              <p className="hint" data-testid="call-out-of-order-hint">
                Choose your counter (open and free) to call this visitor ahead of the published
                order.
              </p>
            )}
            <div className="field">
              <label htmlFor={`${uid}-call-reason`}>Reason</label>
              <select
                id={`${uid}-call-reason`}
                value={callReason}
                onChange={(e) => setCallReason(e.target.value)}
              >
                {policy.override_reasons.map((r) => (
                  <option key={r} value={r}>
                    {reasonLabel(r)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${uid}-call-text`}>Explanation (kept private)</label>
              <textarea
                id={`${uid}-call-text`}
                rows={2}
                maxLength={500}
                value={callText}
                onChange={(e) => setCallText(e.target.value)}
              />
            </div>
            <div className="form-actions">
              <button
                type="submit"
                className="btn btn-secondary"
                disabled={disabled || !counter || !callTextOk || !callReason}
              >
                Call {ticket.public_code} now{counter ? ` to ${counter.name}` : ''}
              </button>
            </div>
          </fieldset>
        </form>
      ) : null}
      {classes.length === 0 && (
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
            <span className="visually-hidden"> supervisor actions for {ticket.public_code}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Open or close a counter for the rest of the day. Closing needs a reason. Closing while a
 * visitor is CALLED returns them to the head of the line (supervisor only); closing while
 * SERVING is refused — finish or transfer first.
 */
export function CounterAvailabilityControl({
  counter,
  atCounterState,
  canRelease,
  disabled,
  run,
  onResult,
}: {
  counter: { id: string; name: string; availability: 'open' | 'closed' };
  atCounterState: 'called' | 'serving' | null;
  canRelease: boolean;
  disabled: boolean;
  run: RunOnline;
  onResult: (r: CounterAvailabilityResult) => void;
}): ReactElement {
  const uid = useId();
  const [reason, setReason] = useState<string>(COUNTER_CLOSE_REASONS[0]);
  const isOpen = counter.availability === 'open';
  const blocked =
    isOpen && (atCounterState === 'serving' || (atCounterState === 'called' && !canRelease));

  if (!isOpen) {
    return (
      <div className="stack-sm" data-testid="counter-availability">
        <p className="alert alert-warn" role="status">
          <strong>{counter.name} is closed.</strong> It receives no calls until it is opened again.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled}
          onClick={() =>
            void run(async () => {
              const res = await api.setCounterAvailability(counter.id, { availability: 'open' });
              onResult(res.result);
              return `${counter.name} is open.`;
            })
          }
        >
          Open {counter.name}
        </button>
      </div>
    );
  }
  return (
    <form
      className="inline-form"
      data-testid="counter-availability"
      aria-label={`Close ${counter.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const res = await api.setCounterAvailability(counter.id, {
            availability: 'closed',
            reason_code: reason as (typeof COUNTER_CLOSE_REASONS)[number],
          });
          onResult(res.result);
          const released = res.result.released.map((r) => r.public_code);
          return `${counter.name} closed.${
            released.length > 0 ? ` ${released.join(', ')} returned to the front of the queue.` : ''
          }`;
        });
      }}
    >
      <div className="field">
        <label htmlFor={`${uid}-close`}>Close counter — reason</label>
        <select id={`${uid}-close`} value={reason} onChange={(e) => setReason(e.target.value)}>
          {COUNTER_CLOSE_REASONS.map((r) => (
            <option key={r} value={r}>
              {reasonLabel(r)}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn btn-secondary" disabled={disabled || blocked}>
        Close {counter.name}
      </button>
      {blocked ? (
        <p className="hint" data-testid="close-blocked-hint">
          {atCounterState === 'serving'
            ? 'Finish or transfer the visitor you are serving before closing.'
            : 'A visitor has been called here. Only a supervisor can close now (they go back to the front of the line).'}
        </p>
      ) : atCounterState === 'called' ? (
        <p className="hint">The called visitor will go back to the front of the line.</p>
      ) : null}
    </form>
  );
}

/** Hand the visitor at this counter to another open, free counter of the same service. */
export function CounterTransferForm({
  ticket,
  targets,
  disabled,
  run,
}: {
  ticket: { id: string; public_code: string };
  targets: { id: string; name: string }[];
  disabled: boolean;
  run: RunOnline;
}): ReactElement {
  const uid = useId();
  const [to, setTo] = useState('');
  const [reason, setReason] = useState<string>(COUNTER_TRANSFER_REASONS[0]);
  const transferIds = useRef(new OperationIdTracker());
  if (targets.length === 0) {
    return (
      <p className="hint" data-testid="no-counter-transfer">
        No other open, free counter can take {ticket.public_code} right now.
      </p>
    );
  }
  return (
    <form
      aria-label={`Send ${ticket.public_code} to another counter`}
      onSubmit={(e) => {
        e.preventDefault();
        const target = targets.find((t) => t.id === to);
        if (!target) return;
        const operationId = transferIds.current.idFor(
          JSON.stringify([ticket.id, target.id, reason]),
        );
        void run(async () => {
          await api.counterTransfer(ticket.id, {
            operation_id: operationId,
            to_counter_id: target.id,
            reason_code: reason as (typeof COUNTER_TRANSFER_REASONS)[number],
          });
          return `${ticket.public_code} sent to ${target.name}.`;
        }).then((outcome) => {
          transferIds.current.settle(outcome);
          if (outcome === 'committed') setTo('');
        });
      }}
    >
      <fieldset className="form-grid">
        <legend>Send to another counter</legend>
        <div className="field">
          <label htmlFor={`${uid}-to`}>Counter</label>
          <select id={`${uid}-to`} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose a counter…</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-why`}>Reason</label>
          <select id={`${uid}-why`} value={reason} onChange={(e) => setReason(e.target.value)}>
            {COUNTER_TRANSFER_REASONS.map((r) => (
              <option key={r} value={r}>
                {reasonLabel(r)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn-secondary" disabled={disabled || !to}>
            Send to counter
          </button>
        </div>
      </fieldset>
    </form>
  );
}
