import { lazy, Suspense, type ReactElement } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Loading } from './components/Form.js';
import { RequireAuth } from './components/RequireAuth.js';
import { AcceptInvite } from './pages/AcceptInvite.js';
import { Login } from './pages/Login.js';
import { Signup } from './pages/Signup.js';
import { DisplayBoard } from './pages/DisplayBoard.js';
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

const LandingPage = lazy(() => import('./landing/LandingPage.js'));
function Landing(): ReactElement {
  return (
    <Suspense fallback={<Loading what="page" />}>
      <LandingPage />
    </Suspense>
  );
}

export default function OtherRoutes(): ReactElement {
  return (
    <Routes>
      {' '}
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
      <Route path="/supervisor/*" element={<PlaceholderPage title="Supervisor Dashboard" />} />
    </Routes>
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
