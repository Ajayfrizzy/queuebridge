import { useEffect, useRef, type ReactElement } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.js';

/** Page shell: skip link, banner, navigation, and route-change focus management. */
export function Layout(): ReactElement {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);

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
                      onClick={() => {
                        void navigate('/');
                        void logout();
                      }}
                    >
                      Sign out
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
      <main id="main" ref={mainRef} tabIndex={-1} className="container main">
        <Outlet />
      </main>
    </>
  );
}
