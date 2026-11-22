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
import { RequireAuth } from './components/RequireAuth.js';
import { AcceptInvite } from './pages/AcceptInvite.js';
import { Login } from './pages/Login.js';
import { Signup } from './pages/Signup.js';
import { DisplayBoard } from './pages/DisplayBoard.js';
import { Loading } from './components/Form.js';
/**
 * M7.2: the public landing page is its own lazily loaded chunk (design §14.1, §14.6). No other
 * route imports `./landing/`, so visitor, staff and admin screens never download it.
 */
const AdminDashboard = lazy(() =>
  import('./pages/AdminDashboard.js').then((m) => ({ default: m.AdminDashboard })),
);
const FacilityChannels = lazy(() =>
  import('./pages/FacilityChannels.js').then((m) => ({ default: m.FacilityChannels })),
);
const FacilityCounters = lazy(() =>
  import('./pages/FacilityCounters.js').then((m) => ({ default: m.FacilityCounters })),
);
const FacilityLayout = lazy(() =>
  import('./pages/FacilityLayout.js').then((m) => ({ default: m.FacilityLayout })),
);
const FacilityOverview = lazy(() =>
  import('./pages/FacilityOverview.js').then((m) => ({ default: m.FacilityOverview })),
);
const FacilityServices = lazy(() =>
  import('./pages/FacilityServices.js').then((m) => ({ default: m.FacilityServices })),
);
const FacilityStaff = lazy(() =>
  import('./pages/FacilityStaff.js').then((m) => ({ default: m.FacilityStaff })),
);
const Connectivity = lazy(() =>
  import('./pages/Connectivity.js').then((m) => ({ default: m.Connectivity })),
);
const StaffConsole = lazy(() =>
  import('./pages/StaffConsole.js').then((m) => ({ default: m.StaffConsole })),
);
const AuditTrail = lazy(() =>
  import('./pages/AuditTrail.js').then((m) => ({ default: m.AuditTrail })),
);
const StaffFacility = lazy(() =>
  import('./pages/StaffHome.js').then((m) => ({ default: m.StaffFacility })),
);
const StaffHome = lazy(() =>
  import('./pages/StaffHome.js').then((m) => ({ default: m.StaffHome })),
);

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

const LandingPage = lazy(() => import('./landing/LandingPage.js'));
function Landing(): ReactElement {
  return (
    <Suspense fallback={<Loading what="page" />}>
      <LandingPage />
    </Suspense>
  );
}

/**
 * Root application router.
 * M1: identity and facility administration. M2: visitor join and ticket status, public
 * display board and the staff queue console. The connectivity and recovery dashboard (M3) lives under /staff/facilities/:fid/connectivity.
 */
export function App(): ReactElement {
  return (
    <BrowserRouter>
      <AuthProvider>
        <OfflineProvider>
          <AnnouncerProvider>
            <A11yProvider>
              <Routes>
                <Route element={<Layout />}>
                  <Route path="/" element={<Landing />} />
                  <Route path="/signup" element={<Signup />} />
                  <Route path="/login" element={<Login />} />
                  <Route path="/accept-invite" element={<AcceptInvite />} />

                  <Route element={<RequireAuth />}>
                    <Route path="/admin" element={<AdminDashboard />} />
                    <Route path="/admin/facilities/:id" element={<FacilityLayout />}>
                      <Route index element={<FacilityOverview />} />
                      <Route path="services" element={<FacilityServices />} />
                      <Route path="counters" element={<FacilityCounters />} />
                      <Route path="staff" element={<FacilityStaff />} />
                      {/* SMS and USSD settings and monitoring (M6.3) */}
                      <Route path="channels" element={<FacilityChannels />} />
                    </Route>
                  </Route>

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
                  {/* Public display board (M2) */}
                  <Route path="/display/:orgSlug/:facilitySlug" element={<DisplayBoard />} />

                  <Route element={<RequireAuth />}>
                    {/* Staff console (M2) */}
                    <Route path="/staff" element={<StaffHome />} />
                    <Route path="/staff/facilities/:fid" element={<StaffFacility />} />
                    <Route path="/staff/queues/:queueId" element={<StaffConsole />} />
                    {/* Read-only audit trail and integrity check (M4, F8) */}
                    <Route path="/staff/queues/:queueId/audit" element={<AuditTrail />} />
                    {/* Connectivity and recovery dashboard (M3, F9) */}
                    <Route path="/staff/facilities/:fid/connectivity" element={<Connectivity />} />
                  </Route>

                  {/* Supervisor dashboard (device health) — M5 */}
                  <Route
                    path="/supervisor/*"
                    element={<PlaceholderPage title="Supervisor Dashboard" />}
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

function PlaceholderPage({ title }: { title: string }): ReactElement {
  return (
    <>
      <h1>{title}</h1>
      <p>This screen is delivered in a later milestone.</p>
    </>
  );
}
