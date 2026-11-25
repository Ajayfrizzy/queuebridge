import { PasswordInput } from '../components/PasswordInput.js';
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAnnounce } from '../components/Announcer.js';
import { Field } from '../components/Form.js';
import { api, ApiRequestError } from '../lib/api.js';
import { fragmentParam } from '../lib/recoveryKey.js';
import { saveTicket, ticketPath } from '../lib/tickets.js';

/**
 * Visitor ticket recovery (REQ-F4.7–F4.9, design §15.5).
 *
 * Routes: `/recover`, `/recover/:org/:facility` and `/recover/:org/:facility/:code`. The recovery
 * key (`#k=`) or a staff grant (`#g=`) arrives in the URL FRAGMENT only: it never reaches the
 * server, an access log or a Referer header. It is read once, removed from the address bar at
 * once and sent in a POST body. Nothing the visitor types is stored on the device.
 *
 * Every failed recovery shows the same message: the page never says whether a ticket exists,
 * whether the key was wrong, or whether the ticket ended. Only an incomplete or malformed form
 * (which depends on what was typed, not on any ticket) gets its own message. There is no CAPTCHA
 * and no lockout.
 */
const NOT_RECOVERED =
  'We could not recover a ticket with those details. Check the facility, the ticket code and the ' +
  'recovery key, then try again. If you cannot find your key, ask a member of staff for help.';
/**
 * Format problems are told apart from a failed recovery (manual check 6): they depend only on
 * what was typed, never on whether a ticket exists, so they reveal nothing. An empty field is
 * caught before sending; the key field is cleared after every failure and is a password field,
 * so pressing the button again used to send an empty key that looked like another wrong key.
 */
const MISSING =
  'Fill in the organization, the facility, the ticket code and the recovery key. The key field is ' +
  'emptied after every attempt, so type the key again.';
const MALFORMED =
  'Some of these details are not in the expected form. Check the organization and facility (as ' +
  'in the join link), the ticket code (for example A012) and the 32-character key, then try again.';

export function RecoverPage({ fragment }: { fragment: string }): ReactElement {
  const params = useParams();
  const navigate = useNavigate();
  const announce = useAnnounce();
  const [org, setOrg] = useState(params['orgSlug'] ?? '');
  const [facility, setFacility] = useState(params['facilitySlug'] ?? '');
  const [code, setCode] = useState(params['code'] ?? '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; offline: boolean } | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const heading = useRef<HTMLHeadingElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const autoRan = useRef(false);

  useEffect(() => {
    const up = (): void => setOnline(true);
    const down = (): void => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  async function submit(body: Parameters<typeof api.recoverTicket>[0]): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const { ticket } = await api.recoverTicket(body);
      const saved = saveTicket({
        code: ticket.public_code,
        token: ticket.status_token,
        facilityName: ticket.facility_name,
        serviceName: ticket.service_name,
        joinPath: org && facility ? `/join/${org}/${facility}` : null,
        savedAt: new Date().toISOString(),
      });
      announce(`Ticket ${ticket.public_code} recovered.`);
      void navigate(
        saved ? ticketPath(saved) : `/ticket/${encodeURIComponent(ticket.public_code)}`,
        { replace: true, state: saved ? undefined : { token: ticket.status_token, unsaved: true } },
      );
    } catch (e) {
      setKey('');
      const offline = e instanceof ApiRequestError && e.status === 0;
      const text =
        e instanceof ApiRequestError && e.status === 429
          ? 'Too many attempts from this connection. Wait a few minutes and try again.'
          : offline
            ? 'Recovery needs a connection. Connect to the internet and try again.'
            : e instanceof ApiRequestError && e.status === 400
              ? MALFORMED
              : NOT_RECOVERED;
      setMessage({ text, offline });
      announce(text);
    } finally {
      setBusy(false);
    }
  }

  // Link or QR: read the fragment once, remove it from the address bar, and submit
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    const hash = fragment;
    const k = fragmentParam(hash, 'k');
    const g = fragmentParam(hash, 'g');
    if (!k && !g) {
      heading.current?.focus();
      return;
    }
    if (g) {
      void submit({ grant: g });
    } else if (k && params['orgSlug'] && params['facilitySlug'] && params['code']) {
      void submit({
        org_slug: params['orgSlug'],
        facility_slug: params['facilitySlug'],
        ticket_code: params['code'],
        recovery_key: k,
      });
    } else if (k) {
      setKey(k);
    }
    // Runs once on arrival (guarded by the ref); later renders must not resubmit
  }, []);

  useEffect(() => {
    if (message) messageRef.current?.focus();
  }, [message]);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    const body = {
      org_slug: org.trim().toLowerCase(),
      facility_slug: facility.trim().toLowerCase(),
      ticket_code: code.trim().toUpperCase(),
      recovery_key: key,
    };
    if (!body.org_slug || !body.facility_slug || !body.ticket_code || !key.trim()) {
      // Nothing is sent: an incomplete form is not a recovery attempt
      setMessage({ text: MISSING, offline: false });
      announce(MISSING);
      return;
    }
    void submit(body);
  }

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Get your ticket back
      </h1>
      <p>
        Lost your phone or cleared your browser? Enter the recovery key you were given when you
        joined. Your ticket code alone is not enough. This keeps your place safe from other people.
      </p>
      {!online ? (
        <p role="status" className="alert alert-info" data-testid="recover-offline">
          Recovery needs a connection. You are offline right now. Connect to the internet to
          continue.
        </p>
      ) : null}
      {message ? (
        <div
          ref={messageRef}
          tabIndex={-1}
          role="alert"
          className="alert alert-error"
          data-testid="recover-error"
        >
          <p>{message.text}</p>
        </div>
      ) : null}
      <form onSubmit={onSubmit} noValidate className="stack" aria-label="Recover a ticket">
        <Field
          id="rec-org"
          label="Organization"
          hint="The first part of the join link, for example “city-clinic” in /join/city-clinic/main."
        >
          {(aria) => (
            <input
              {...aria}
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          )}
        </Field>
        <Field id="rec-facility" label="Facility" hint="The second part of the join link.">
          {(aria) => (
            <input
              {...aria}
              value={facility}
              onChange={(e) => setFacility(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          )}
        </Field>
        <Field id="rec-code" label="Ticket code" hint="For example A012.">
          {(aria) => (
            <input
              {...aria}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          )}
        </Field>
        <Field
          id="rec-key"
          label="Recovery key"
          hint="32 letters and numbers, usually shown in groups of four. Spaces, hyphens and capitals do not matter."
        >
          {(aria) => (
            <PasswordInput
              {...aria}
              label="recovery key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          )}
        </Field>
        <p className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={busy || !online}>
            {busy ? 'Checking…' : 'Recover my ticket'}
          </button>
        </p>
      </form>
      <p className="muted">
        Do not have your key? Ask a member of staff. They will check who you are before they help,
        and a second staff member must approve.
      </p>
      <p className="muted" data-testid="recover-provisional-note">
        Were you given a temporary reference while the desk was offline? That ticket can be
        recovered only after the server has confirmed it and staff have given you your real ticket
        code.
      </p>
      <p>
        <Link to="/">Back to start</Link>
      </p>
    </>
  );
}
