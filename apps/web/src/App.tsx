import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  lazy,
  Suspense,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
} from 'react';
import { AuthProvider } from './auth.js';
import { OfflineProvider } from './offline/OfflineProvider.js';
import { AnnouncerProvider } from './components/Announcer.js';
import { A11yProvider } from './components/DisplaySettings.js';
import { Layout } from './components/Layout.js';
import { Loading } from './components/Form.js';
const OtherRoutes = lazy(() => import('./OtherRoutes.js'));
const visitorModules = {
  join: async () => (await import('./pages/JoinPage.js')).JoinPage,
  ticket: async () => (await import('./pages/TicketPage.js')).TicketPage,
  recover: async () => (await import('./pages/RecoverPage.js')).RecoverPage,
};
type VisitorPage = keyof typeof visitorModules;

function RouteLoadFailure({ retry }: { retry: () => void }): ReactElement {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => heading.current?.focus(), []);
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        This page could not load
      </h1>
      <p>Check your connection and try again. If you refresh, reopen your original link.</p>
      <button className="btn btn-primary" onClick={retry}>
        Try again
      </button>
    </>
  );
}

function loadVisitorPage(
  page: VisitorPage,
): React.LazyExoticComponent<ComponentType<{ fragment: string; retry: () => void }>> {
  return lazy(async () => {
    let component: ComponentType<{ fragment: string; retry: () => void }>;
    try {
      component = await visitorModules[page]();
    } catch {
      component = RouteLoadFailure;
    }
    return { default: component };
  });
}

function VisitorRoute({ page }: { page: VisitorPage }): ReactElement {
  const location = useLocation();
  // React Router's in-memory location retains the fragment while the address bar is scrubbed.
  useLayoutEffect(() => {
    if (page === 'join' || !location.hash || window.location.hash !== location.hash) return;
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    );
  }, [page, location.hash]);
  return <VisitorContent key={page} page={page} fragment={location.hash} />;
}

function VisitorContent({ page, fragment }: { page: VisitorPage; fragment: string }): ReactElement {
  const [Page, setPage] = useState(() => loadVisitorPage(page));
  return (
    <Suspense fallback={<Loading what="page" />}>
      <Page fragment={fragment} retry={() => setPage(() => loadVisitorPage(page))} />
    </Suspense>
  );
}

export function App(): ReactElement {
  return (
    <BrowserRouter>
      <AuthProvider>
        <OfflineProvider>
          <AnnouncerProvider>
            <A11yProvider>
              <Routes>
                <Route element={<Layout />}>
                  {/* Visitor routes (M2) — no account needed */}
                  <Route
                    path="/join/:orgSlug/:facilitySlug"
                    element={<VisitorRoute page="join" />}
                  />
                  <Route path="/ticket/:code" element={<VisitorRoute page="ticket" />} />
                  {/* Ticket recovery (M5.1): key or grant in the URL fragment only */}
                  <Route path="/recover" element={<VisitorRoute page="recover" />} />
                  <Route
                    path="/recover/:orgSlug/:facilitySlug"
                    element={<VisitorRoute page="recover" />}
                  />
                  <Route
                    path="/recover/:orgSlug/:facilitySlug/:code"
                    element={<VisitorRoute page="recover" />}
                  />
                  <Route
                    path="*"
                    element={
                      <Suspense fallback={<Loading what="page" />}>
                        <OtherRoutes />
                      </Suspense>
                    }
                  />
                </Route>
              </Routes>
            </A11yProvider>
          </AnnouncerProvider>
        </OfflineProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
