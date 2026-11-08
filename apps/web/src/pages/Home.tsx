import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { storedTickets } from '../lib/tickets.js';

export function Home(): ReactElement {
  const { user } = useAuth();
  const tickets = storedTickets();
  return (
    <>
      {tickets.length > 0 ? (
        <section aria-labelledby="my-tickets" className="alert alert-info" data-testid="my-tickets">
          <h2 id="my-tickets" className="alert-title">
            Your tickets on this device
          </h2>
          <ul>
            {tickets.map((t) => (
              <li key={t.code}>
                <Link to={`/ticket/${t.code}`}>
                  {t.code} — {t.serviceName}, {t.facilityName}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <h1>QueueBridge</h1>
      <p className="lead">
        Keep service moving — even when the connection does not. Set up your facility, services and
        counters, invite your team, and share a join link or QR code with visitors.
      </p>
      {user ? (
        <p>
          <Link className="btn btn-primary" to="/admin">
            Go to administration
          </Link>
        </p>
      ) : (
        <p className="btn-row">
          <Link className="btn btn-primary" to="/signup">
            Create an organization
          </Link>
          <Link className="btn btn-secondary" to="/login">
            Sign in
          </Link>
        </p>
      )}
    </>
  );
}
