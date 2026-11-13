import { useEffect, type ReactElement } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { Loading } from './Form.js';

/**
 * Guard for pages that need a signed-in user: unauthenticated visitors are sent to /login.
 *
 * The redirect is an effect that is re-evaluated on every router location change, not a
 * one-shot <Navigate>. React can coalesce several router updates (for example the sign-out
 * navigation and an immediate Back) into one render whose final location equals the first; a
 * one-shot redirect that had already fired then never fires again and leaves a blank protected
 * URL (M5.0). It is skipped while the browser URL has already moved on from the location this
 * render still shows: that newer navigation is the one that counts.
 */
export function RequireAuth(): ReactElement | null {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (loading || user) return;
    if (window.location.pathname !== location.pathname) return;
    void navigate('/login', { replace: true });
  }, [loading, user, location, navigate]);

  if (loading) return <Loading what="your session" />;
  if (!user) return null;
  return <Outlet />;
}
