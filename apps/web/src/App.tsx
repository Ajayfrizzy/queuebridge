import { BrowserRouter, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';

/**
 * Root application router.
 * Route stubs — full implementations in M1–M5.
 */
export function App(): ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        {/* Visitor routes */}
        <Route path="/join/:facilitySlug" element={<PlaceholderPage title="Join Queue" />} />
        <Route path="/ticket/:code" element={<PlaceholderPage title="Ticket Status" />} />

        {/* Staff routes */}
        <Route path="/staff/*" element={<PlaceholderPage title="Staff Console" />} />

        {/* Supervisor routes */}
        <Route path="/supervisor/*" element={<PlaceholderPage title="Supervisor Dashboard" />} />

        {/* Admin routes */}
        <Route path="/admin/*" element={<PlaceholderPage title="Admin Panel" />} />

        {/* Public display board */}
        <Route path="/display/:facilityId" element={<PlaceholderPage title="Queue Display" />} />

        {/* Home */}
        <Route path="/" element={<PlaceholderPage title="QueueBridge" />} />
      </Routes>
    </BrowserRouter>
  );
}

function PlaceholderPage({ title }: { title: string }): ReactElement {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>{title}</h1>
      <p>QueueBridge — M0 foundation. Full implementation begins at M1.</p>
    </main>
  );
}
