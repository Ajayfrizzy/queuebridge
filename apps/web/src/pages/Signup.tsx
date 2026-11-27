import { PasswordInput } from '../components/PasswordInput.js';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { ErrorSummary, Field } from '../components/Form.js';
import { api, ApiRequestError } from '../lib/api.js';
import { slugify } from '../lib/permissions.js';

export function Signup(): ReactElement {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [orgName, setOrgName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
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
      const res = await api.signupOrganization({
        organization_name: orgName,
        organization_slug: slug,
        admin_display_name: String(form.get('admin_display_name') ?? ''),
        admin_email: String(form.get('admin_email') ?? ''),
        admin_password: String(form.get('admin_password') ?? ''),
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
      <h1>Create your organization</h1>
      <p className="muted">
        You will become the organization administrator. Already registered?{' '}
        <Link to="/login">Sign in</Link>.
      </p>
      <form
        onSubmit={(e) => void onSubmit(e)}
        noValidate
        aria-label="Create organization"
        className="card form"
      >
        <ErrorSummary error={error} />
        <Field id="organization_name" label="Organization name" error={fe['organization_name']}>
          {(aria) => (
            <input
              {...aria}
              name="organization_name"
              value={orgName}
              required
              autoComplete="organization"
              onChange={(e) => {
                setOrgName(e.target.value);
                if (!slugEdited) setSlug(slugify(e.target.value));
              }}
            />
          )}
        </Field>
        <Field
          id="organization_slug"
          label="Organization URL identifier (slug)"
          hint="Appears in web addresses, for example /join/your-slug/…, and is entered when staff sign in. Lowercase letters, numbers and single hyphens (3–48 characters). Suggested from the name; you can edit it."
          error={fe['organization_slug']}
        >
          {(aria) => (
            <input
              {...aria}
              name="organization_slug"
              value={slug}
              required
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(e.target.value);
              }}
            />
          )}
        </Field>
        <Field id="admin_display_name" label="Your name" error={fe['admin_display_name']}>
          {(aria) => <input {...aria} name="admin_display_name" required autoComplete="name" />}
        </Field>
        <Field id="admin_email" label="Your email" error={fe['admin_email']}>
          {(aria) => (
            <input {...aria} name="admin_email" type="email" required autoComplete="email" />
          )}
        </Field>
        <Field
          id="admin_password"
          label="Password"
          hint="At least 12 characters. A few random words make a strong, memorable password."
          error={fe['admin_password']}
        >
          {(aria) => (
            <PasswordInput {...aria} name="admin_password" required autoComplete="new-password" />
          )}
        </Field>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create organization'}
        </button>
      </form>
    </>
  );
}
