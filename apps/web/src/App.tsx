import { BrowserRouter, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';
import { AuthProvider } from './auth.js';
import { OfflineProvider } from './offline/OfflineProvider.js';
import { AnnouncerProvider } from './components/Announcer.js';
import { A11yProvider } from './components/DisplaySettings.js';
import { Layout } from './components/Layout.js';
import { RequireAuth } from './components/RequireAuth.js';
import { AcceptInvite } from './pages/AcceptInvite.js';
import { AdminDashboard } from './pages/AdminDashboard.js';
import { FacilityChannels } from './pages/FacilityChannels.js';
import { FacilityCounters } from './pages/FacilityCounters.js';
import { FacilityLayout } from './pages/FacilityLayout.js';
import { FacilityOverview } from './pages/FacilityOverview.js';
import { FacilityServices } from './pages/FacilityServices.js';
import { FacilityStaff } from './pages/FacilityStaff.js';
import { Home } from './pages/Home.js';
import { Login } from './pages/Login.js';
import { Signup } from './pages/Signup.js';
import { DisplayBoard } from './pages/DisplayBoard.js';
import { JoinPage } from './pages/JoinPage.js';
import { Connectivity } from './pages/Connectivity.js';
import { StaffConsole } from './pages/StaffConsole.js';
import { AuditTrail } from './pages/AuditTrail.js';
import { StaffFacility, StaffHome } from './pages/StaffHome.js';
import { TicketPage } from './pages/TicketPage.js';
import { RecoverPage } from './pages/RecoverPage.js';

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
                  <Route path="/" element={<Home />} />
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
                  <Route path="/join/:orgSlug/:facilitySlug" element={<JoinPage />} />
                  <Route path="/ticket/:code" element={<TicketPage />} />
                  {/* Ticket recovery (M5.1): key or grant in the URL fragment only */}
                  <Route path="/recover" element={<RecoverPage />} />
                  <Route path="/recover/:orgSlug/:facilitySlug" element={<RecoverPage />} />
                  <Route path="/recover/:orgSlug/:facilitySlug/:code" element={<RecoverPage />} />
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
