import { BrowserRouter, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';
import { AuthProvider } from './auth.js';
import { AnnouncerProvider } from './components/Announcer.js';
import { Layout } from './components/Layout.js';
import { RequireAuth } from './components/RequireAuth.js';
import { AcceptInvite } from './pages/AcceptInvite.js';
import { AdminDashboard } from './pages/AdminDashboard.js';
import { FacilityCounters } from './pages/FacilityCounters.js';
import { FacilityLayout } from './pages/FacilityLayout.js';
import { FacilityOverview } from './pages/FacilityOverview.js';
import { FacilityServices } from './pages/FacilityServices.js';
import { FacilityStaff } from './pages/FacilityStaff.js';
import { Home } from './pages/Home.js';
import { Login } from './pages/Login.js';
import { Signup } from './pages/Signup.js';

/**
 * Root application router.
 * M1 delivers identity and facility administration; visitor, staff-console and display
 * routes remain stubs until M2+.
 */
export function App(): ReactElement {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AnnouncerProvider>
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
                </Route>
              </Route>

              {/* Visitor routes — implemented in M2 */}
              <Route
                path="/join/:orgSlug/:facilitySlug"
                element={<PlaceholderPage title="Join Queue" />}
              />
              <Route path="/ticket/:code" element={<PlaceholderPage title="Ticket Status" />} />
              {/* Staff / supervisor consoles and public board — M2+ */}
              <Route path="/staff/*" element={<PlaceholderPage title="Staff Console" />} />
              <Route
                path="/supervisor/*"
                element={<PlaceholderPage title="Supervisor Dashboard" />}
              />
              <Route
                path="/display/:facilityId"
                element={<PlaceholderPage title="Queue Display" />}
              />
            </Route>
          </Routes>
        </AnnouncerProvider>
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
