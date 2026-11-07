import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import type { ApiRequestError } from '../lib/api.js';

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  children: (aria: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean;
  }) => ReactNode;
}

/** A labelled form control with optional hint and inline error wired up via ARIA. */
export function Field({ id, label, hint, error, children }: FieldProps): ReactElement {
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': Boolean(error) })}
      {error ? (
        <p id={errId} className="field-error">
          <span aria-hidden="true">⚠ </span>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Error summary: announced immediately and focused so keyboard users land on it. */
export function ErrorSummary({
  error,
  title = 'There was a problem',
}: {
  error: ApiRequestError | null;
  title?: string;
}): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) ref.current?.focus();
  }, [error]);
  if (!error) return null;
  const fields = Object.entries(error.fieldErrors());
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="alert alert-error"
      data-testid="error-summary"
    >
      <h2 className="alert-title">{title}</h2>
      <p>{error.message}</p>
      {fields.length > 0 ? (
        <ul>
          {fields.map(([field, message]) => (
            <li key={field}>
              <a
                href={`#${field}`}
                onClick={(e) => {
                  e.preventDefault();
                  ref.current
                    ?.closest('form')
                    ?.querySelector<HTMLElement>(`[name="${field}"]`)
                    ?.focus();
                }}
              >
                {message}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Loading({ what }: { what: string }): ReactElement {
  return (
    <p role="status" className="muted">
      Loading {what}…
    </p>
  );
}

export function StatusBadge({
  active,
  on = 'Active',
  off = 'Inactive',
}: {
  active: boolean;
  on?: string;
  off?: string;
}): ReactElement {
  // Text + symbol, never colour alone
  return (
    <span className={`badge ${active ? 'badge-ok' : 'badge-off'}`}>
      <span aria-hidden="true">{active ? '● ' : '○ '}</span>
      {active ? on : off}
    </span>
  );
}
