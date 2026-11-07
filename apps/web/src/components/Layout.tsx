import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { ApiRequestError } from '../lib/api.js';

/** Page shell: skip link, banner, navigation, and route-change focus management. */
export function Layout(): ReactElement {
  const { user, logout, signedOut, acknowledgeSignedOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);
  const alertRef = useRef<HTMLDivElement>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  async function signOut(): Promise<void> {
    setSigningOut(true);
    setLogoutError(null);
    try {
      // Local state is cleared only after the server confirmed; guards then send the user home
      await logout();
      void navigate('/');
    } catch (e) {
      setLogoutError(
        e instanceof ApiRequestError && e.status > 0
          ? 'The server could not end your session.'
          : 'We could not reach the server to end your session.',
      );
    } finally {
      setSigningOut(false);
    }
  }

  // After a confirmed sign out lands on home, later visits to protected pages go to sign-in again
  useEffect(() => {
    if (signedOut && location.pathname === '/') acknowledgeSignedOut();
  }, [signedOut, location.pathname, acknowledgeSignedOut]);

  // A stale failure notice must not outlive the session it refers to
  useEffect(() => {
    if (!user) setLogoutError(null);
  }, [user]);

  // Move focus to the failure notice so keyboard and screen-reader users land on the retry action
  useEffect(() => {
    if (logoutError) alertRef.current?.focus();
  }, [logoutError]);

  // Move focus to the main landmark after client-side navigation so keyboard and
  // screen-reader users start at the new content instead of the old position.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [location.pathname]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="site-header">
        <div className="container header-row">
          <Link to="/" className="brand">
            QueueBridge
          </Link>
          <nav aria-label="Primary">
            <ul className="nav-list">
              {user ? (
                <>
                  <li>
                    <NavLink to="/admin">Administration</NavLink>
                  </li>
                  <li className="who" data-testid="whoami">
                    <span className="visually-hidden">Signed in as </span>
                    {user.display_name}
                  </li>
                  <li>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={signingOut}
                      onClick={() => void signOut()}
                    >
                      {signingOut ? 'Signing out…' : 'Sign out'}
                    </button>
                  </li>
                </>
              ) : (
                <>
                  <li>
                    <NavLink to="/login">Sign in</NavLink>
                  </li>
                  <li>
                    <NavLink to="/signup">Create organization</NavLink>
                  </li>
                </>
              )}
            </ul>
          </nav>
        </div>
      </header>
      {logoutError ? (
        <div className="container">
          <div
            ref={alertRef}
            role="alert"
            tabIndex={-1}
            className="alert alert-error"
            data-testid="logout-error"
          >
            <h2 className="alert-title">You are still signed in</h2>
            <p>
              {logoutError} Your session is still active. Check your connection and try again,
              especially on a shared device.
            </p>
            <div className="btn-row">
              <button type="button" className="btn btn-primary" onClick={() => void signOut()}>
                Retry sign out
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setLogoutError(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <main id="main" ref={mainRef} tabIndex={-1} className="container main">
        <Outlet />
      </main>
    </>
  );
}
