import { useState, type FormEvent, type ReactElement } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { ErrorSummary, Field } from '../components/Form.js';
import { api, ApiRequestError } from '../lib/api.js';

export function Login(): ReactElement {
  const { user, setUser, sessionEnded } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to="/admin" replace />;
  const fe = error?.fieldErrors() ?? {};

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await api.login({
        organization_slug: String(form.get('organization_slug') ?? ''),
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
      });
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

  return (
    <>
      <h1>Sign in</h1>
      <p className="muted">
        New here? <Link to="/signup">Create an organization</Link>.
      </p>
      {sessionEnded ? (
        <p role="alert" className="alert alert-info" data-testid="session-ended">
          Your session has ended — your access may have changed. Please sign in again.
        </p>
      ) : null}
      <form
        onSubmit={(e) => void onSubmit(e)}
        noValidate
        aria-label="Sign in"
        className="card form"
      >
        <ErrorSummary error={error} title="Could not sign in" />
        <Field
          id="organization_slug"
          label="Organization URL identifier (slug)"
          hint="The short identifier chosen when the organization was created, for example city-general."
          error={fe['organization_slug']}
        >
          {(aria) => (
            <input
              {...aria}
              name="organization_slug"
              required
              autoCapitalize="none"
              spellCheck={false}
            />
          )}
        </Field>
        <Field id="email" label="Email" error={fe['email']}>
          {(aria) => <input {...aria} name="email" type="email" required autoComplete="username" />}
        </Field>
        <Field id="password" label="Password" error={fe['password']}>
          {(aria) => (
            <input
              {...aria}
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          )}
        </Field>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </>
  );
}
