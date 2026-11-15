import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { ApiRequestError } from '../lib/api.js';
import { useOffline } from '../offline/OfflineProvider.js';
import { ConnectivityBar } from './ConnectivityBar.js';
import { DisplaySettingsButton } from './DisplaySettings.js';
import { HealthAlertBanner } from './HealthAlertBanner.js';
import { PushHandoff } from './PushHandoff.js';
import { useRouteFocus } from '../lib/routeFocus.js';

/** Page shell: skip link, banner, navigation, and route-change focus management. */
export function Layout(): ReactElement {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const offline = useOffline();
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  async function signOut(force = false): Promise<void> {
    // Never silently destroy unsent work: make the person sync it or knowingly discard it
    if (!force && offline.summary.unsynced > 0) {
      setConfirmDiscard(true);
      return;
    }
    setConfirmDiscard(false);
    setSigningOut(true);
    setLogoutError(null);
    try {
      // Local state is cleared only after the server confirmed. Home is navigated to first (inside
      // logout, before the user is cleared) so route guards never act on a stale protected URL.
      await logout(() => void navigate('/'));
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

  // A stale failure notice must not outlive the session it refers to
  useEffect(() => {
    if (!user) setLogoutError(null);
  }, [user]);

  // Move focus to the failure notice so keyboard and screen-reader users land on the retry action
  useEffect(() => {
    if (logoutError) alertRef.current?.focus();
  }, [logoutError]);

  // Route change (REQ-F7.11): title updated, focus moved to the new page's heading
  useRouteFocus(mainRef, location.pathname);

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
          <nav aria-label="Primary" className="site-nav">
            <ul className="nav-list">
              {user ? (
                <>
                  <li>
                    <NavLink to="/staff">Staff console</NavLink>
                  </li>
                  <li>
                    <NavLink to="/admin">Administration</NavLink>
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
          <div className="header-tools">
            <DisplaySettingsButton />
          </div>
          {user ? (
            <div className="account" role="group" aria-label="Account">
              <span className="who" data-testid="whoami">
                <span className="visually-hidden">Signed in as </span>
                {user.display_name}
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={signingOut}
                onClick={() => void signOut()}
              >
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          ) : null}
        </div>
      </header>
      <ConnectivityBar />
      <HealthAlertBanner />
      <PushHandoff />
      {confirmDiscard ? (
        <div className="container">
          <div role="alert" className="alert alert-error" data-testid="discard-warning">
            <h2 className="alert-title">
              {offline.summary.unsynced} unsent{' '}
              {offline.summary.unsynced === 1 ? 'action' : 'actions'} on this device
            </h2>
            <p>Signing out erases them. Send them first, or sign out and discard them knowingly.</p>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!offline.reachable || offline.flushing}
                onClick={() => void offline.flush().then(() => setConfirmDiscard(false))}
              >
                {offline.reachable ? 'Send now' : 'Send now (offline)'}
              </button>
              <button type="button" className="btn btn-danger" onClick={() => void signOut(true)}>
                Sign out and discard
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmDiscard(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
