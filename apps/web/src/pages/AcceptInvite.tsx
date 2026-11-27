import { PasswordInput } from '../components/PasswordInput.js';
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { ErrorSummary, Field, Loading } from '../components/Form.js';
import { api, ApiRequestError, type InvitationPreview } from '../lib/api.js';
import { ROLE_LABELS } from '../lib/permissions.js';

/** The invitation secret travels in the URL fragment, which browsers never send to servers. */
function readToken(): string {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return params.get('token') ?? '';
}

export function AcceptInvite(): ReactElement {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [token] = useState(readToken);
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .previewInvitation(token)
      .then((r) => setPreview(r.invitation))
      .catch((e: unknown) => setError(e instanceof ApiRequestError ? e : null))
      .finally(() => setLoading(false));
  }, [token]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await api.acceptInvitation({
        token,
        display_name: String(form.get('display_name') ?? ''),
        password: String(form.get('password') ?? ''),
      });
      // Remove the secret from the address bar / history once it has been redeemed
      window.history.replaceState(null, '', '/accept-invite');
      setUser(res.user);
      void navigate('/admin');
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err : new ApiRequestError(0, null, 'Unexpected error'),
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading what="invitation" />;
  if (!token || !preview) {
    return (
      <>
        <h1>Invitation unavailable</h1>
        <p role="alert">
          This invitation link is invalid, has expired, or has already been used. Ask your
          administrator to send a new one.
        </p>
      </>
    );
  }
  const fe = error?.fieldErrors() ?? {};

  return (
    <>
      <h1>Join {preview.organization_name}</h1>
      <p>
        You have been invited to <strong>{preview.facility_name}</strong> as{' '}
        <strong>{ROLE_LABELS[preview.role] ?? preview.role}</strong>. Your sign-in email will be{' '}
        <strong>{preview.email}</strong>.
      </p>
      <form
        onSubmit={(e) => void onSubmit(e)}
        noValidate
        aria-label="Accept invitation"
        className="card form"
      >
        <ErrorSummary error={error} />
        <Field id="display_name" label="Your name" error={fe['display_name']}>
          {(aria) => <input {...aria} name="display_name" required autoComplete="name" />}
        </Field>
        <Field
          id="password"
          label="Password"
          hint="At least 12 characters. If you already have an account in this organization, enter your existing password."
          error={fe['password']}
        >
          {(aria) => (
            <PasswordInput {...aria} name="password" required autoComplete="new-password" />
          )}
        </Field>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Joining…' : 'Accept invitation'}
        </button>
      </form>
    </>
  );
}
