import { useEffect, useRef, type ReactElement } from 'react';
import { SyncStatus } from '@queuebridge/contracts';
import { SyncStateIndicator } from '@queuebridge/ui';
import { useAuth } from '../auth.js';
import { useAnnounce } from './Announcer.js';
import { useOffline } from '../offline/OfflineProvider.js';

/**
 * Always-visible connectivity and sync status for signed-in staff.
 * Server reachability and browser connectivity are different things (REQ-F9.3): this reflects
 * whether the API actually answered. Offline is announced politely; trouble (revoked device,
 * ended session, unusable storage, another user's unsent work) is announced assertively.
 */
export function ConnectivityBar(): ReactElement | null {
  const { user, offlineIdentity } = useAuth();
  const o = useOffline();
  const trouble = useRef<HTMLDivElement>(null);
  const announce = useAnnounce();
  const wasReachable = useRef(o.reachable);
  const hasTrouble = o.problem !== null || o.storage === 'unavailable' || o.foreignPending > 0;

  // Connection changes go through the app's single polite live region (no second region here)
  useEffect(() => {
    if (wasReachable.current === o.reachable) return;
    wasReachable.current = o.reachable;
    announce(
      o.reachable
        ? 'Back online. Sending any saved actions.'
        : 'You are offline. Actions are saved on this device and are not confirmed yet.',
    );
  }, [o.reachable, announce]);

  useEffect(() => {
    if (o.problem) trouble.current?.focus();
  }, [o.problem]);

  if (!user && o.summary.unsynced === 0 && o.reachable) return null;
  const s = o.summary;
  return (
    <div
      className={`connectivity-bar${o.reachable ? '' : ' is-offline'}`}
      data-testid="connectivity-bar"
    >
      <div className="container">
        <p data-testid="connection-state" className="connection-state">
          {o.reachable ? (
            <strong>
              <span aria-hidden="true">● </span>Online
            </strong>
          ) : (
            <strong>
              <span aria-hidden="true">○ </span>Offline
            </strong>
          )}
          {!o.reachable
            ? ' — actions are saved on this device and stay marked Local until the server confirms them.'
            : offlineIdentity
              ? ' — checking your sign-in…'
              : ''}
        </p>
        {s.unsynced > 0 ? (
          <p data-testid="unsynced-count">
            <SyncStateIndicator
              status={s.pending_sync > 0 ? SyncStatus.PENDING_SYNC : SyncStatus.LOCAL_ONLY}
            />{' '}
            {s.unsynced} unsent {s.unsynced === 1 ? 'action' : 'actions'}
            {o.flushing ? ' — sending…' : ''}
          </p>
        ) : null}
        {s.needs_review > 0 ? (
          <p data-testid="review-count">
            <SyncStateIndicator status={SyncStatus.NEEDS_REVIEW} /> {s.needs_review} waiting for a
            supervisor
          </p>
        ) : null}
      </div>
      {hasTrouble ? (
        <div className="container">
          <div
            ref={trouble}
            role="alert"
            tabIndex={-1}
            className="alert alert-error"
            data-testid="offline-problem"
          >
            {o.problem === 'device_revoked' ? (
              <p>
                <strong>This device was revoked by a supervisor.</strong> Its unsent actions cannot
                be synced. Ask a supervisor, then clear local data and register again.
              </p>
            ) : null}
            {o.problem === 'session_ended' ? (
              <p>
                <strong>Your sign-in ended.</strong> Sign in again as the same person to send your
                unsent actions.
              </p>
            ) : null}
            {o.storage === 'unavailable' ? (
              <p>
                <strong>This browser cannot save offline data.</strong> Offline mode is switched off
                here: nothing is recorded locally, so do not rely on this device during an outage.
              </p>
            ) : null}
            {o.foreignPending > 0 ? (
              <p>
                <strong>
                  {o.foreignPending} unsent{' '}
                  {o.foreignPending === 1 ? 'action belongs' : 'actions belong'} to another person
                </strong>{' '}
                who used this device. They are never sent under your name. That person must sign in
                to send them, or a supervisor can clear local data.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
