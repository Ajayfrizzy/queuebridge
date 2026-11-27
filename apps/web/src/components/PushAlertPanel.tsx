import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { PushCapability } from '@queuebridge/contracts';
import { useAnnounce } from './Announcer.js';
import { api, ApiRequestError } from '../lib/api.js';
import { otherTicketUsesPush, setPushRef } from '../lib/tickets.js';
import {
  applicationServerKey,
  pushSupport,
  readPushEnvironment,
  type PushSupport,
} from '../lib/turnAlert.js';

/**
 * Optional Web Push turn alert for ONE saved ticket on this device (REQ-F14.4; design §12.5.1).
 *
 * - Permission is requested only inside the click on "Get a push alert". Nothing on page load.
 * - Unsupported, blocked (denied) and iPhone/iPad-not-installed states each get specific text and
 *   no button that cannot work. A denied permission is respected: no re-prompting.
 * - The server returns a non-secret `subscription_ref`, saved as `pushRef` on the saved ticket.
 * - One browser has ONE push subscription for this site, shared by every saved ticket. Turning
 *   push off for one ticket therefore unsubscribes the browser only when no other saved ticket
 *   still uses it.
 * - Copy never promises delivery: push is best effort; the page, the public board and staff
 *   calling are the reliable channels.
 */
const READY_TIMEOUT_MS = 10_000;

async function swRegistration(): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('service worker not ready')), READY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sameKey(sub: PushSubscription, key: Uint8Array): boolean {
  const k = sub.options?.applicationServerKey;
  if (!k) return true; // not reported by this browser: assume unchanged
  const a = new Uint8Array(k);
  return a.length === key.length && a.every((b, i) => b === key[i]);
}

function subscriptionBody(sub: PushSubscription): {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
} {
  const j = sub.toJSON();
  return {
    endpoint: j.endpoint ?? '',
    expirationTime: j.expirationTime ?? null,
    keys: { p256dh: j.keys?.['p256dh'] ?? '', auth: j.keys?.['auth'] ?? '' },
  };
}

type Note = { text: string; error: boolean } | null;

const DENIED_TEXT =
  'Notifications are blocked for this site in your browser. To use a push alert, allow notifications for this site in your browser’s site settings, then reload this page. This page still shows when it is your turn.';

export function PushAlertPanel({
  code,
  token,
  savedId,
  pushRef,
  onPushRefChange,
}: {
  code: string;
  token: string;
  savedId: string | null;
  pushRef: string | null;
  onPushRefChange: (ref: string | null) => void;
}): ReactElement {
  const announce = useAnnounce();
  const [cap, setCap] = useState<PushCapability | 'offline' | null>(null);
  const [support] = useState<PushSupport>(() => pushSupport(readPushEnvironment()));
  const [permission, setPermission] = useState<NotificationPermission | null>(() =>
    typeof Notification === 'undefined' ? null : Notification.permission,
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    let live = true;
    api
      .pushCapability()
      .then((c) => live && setCap(c))
      .catch(() => live && setCap('offline'));
    return () => {
      live = false;
    };
  }, []);

  // Keep "on" truthful: if this browser no longer has the subscription or permission, show
  // "off"; if it does, re-register it quietly (same endpoint → the same reference on the
  // server, which also restores a subscription the server ended when this device's token was
  // replaced). Never prompts.
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current || !pushRef || support !== 'supported' || !cap || cap === 'offline') return;
    if (cap.web_push !== 'live') return;
    checked.current = true;
    const forget = (): void => {
      if (savedId) setPushRef(savedId, null);
      onPushRefChange(null);
    };
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      void api.unsubscribePush(code, token, pushRef).catch(() => undefined);
      forget();
      return;
    }
    void (async () => {
      try {
        const reg = await swRegistration();
        const sub = await reg.pushManager.getSubscription();
        if (!sub) {
          void api.unsubscribePush(code, token, pushRef).catch(() => undefined);
          forget();
          return;
        }
        const r = await api.subscribePush(code, token, subscriptionBody(sub));
        if (r.subscription_ref !== pushRef) {
          if (savedId) setPushRef(savedId, r.subscription_ref);
          onPushRefChange(r.subscription_ref);
        }
      } catch (e) {
        // the server refused (ended ticket, limit): it is off for this ticket now
        if (e instanceof ApiRequestError && e.status >= 400 && e.status < 500) forget();
      }
    })();
  }, [pushRef, support, cap, code, token, savedId, onPushRefChange]);

  function say(n: Note): void {
    setNote(n);
    if (n) announce(n.text);
  }

  async function enable(): Promise<void> {
    if (!cap || cap === 'offline' || cap.web_push !== 'live' || !cap.public_key) return;
    setBusy(true);
    setNote(null);
    let created: PushSubscription | null = null;
    try {
      // Asked ONLY here, inside the click
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        say({
          text:
            perm === 'denied'
              ? DENIED_TEXT
              : 'The push alert was not turned on. You can try again at any time.',
          error: false,
        });
        return;
      }
      const key = applicationServerKey(cap.public_key);
      const reg = await swRegistration();
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameKey(sub, key)) {
        await sub.unsubscribe();
        sub = null;
      }
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        created = sub;
      }
      const r = await api.subscribePush(code, token, subscriptionBody(sub));
      const remembered = savedId ? setPushRef(savedId, r.subscription_ref) : false;
      onPushRefChange(r.subscription_ref);
      say({
        text: remembered
          ? 'Push alert is on for this ticket on this device.'
          : 'Push alert is on, but this browser could not remember it. If a notification opens a page that does not find your ticket, use your saved link or recovery key.',
        error: false,
      });
    } catch (e) {
      // Do not leave a browser subscription behind that no ticket uses
      if (created && !(savedId && otherTicketUsesPush(savedId))) {
        await created.unsubscribe().catch(() => undefined);
      }
      say({
        text:
          e instanceof ApiRequestError && e.status !== 0
            ? e.message
            : e instanceof ApiRequestError
              ? 'You are offline. The push alert can be turned on when you are back online.'
              : 'The push alert could not be set up on this device. This page still shows when it is your turn.',
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    if (!pushRef) return;
    setBusy(true);
    setNote(null);
    try {
      try {
        await api.unsubscribePush(code, token, pushRef);
      } catch (e) {
        // already gone on the server: still off
        if (!(e instanceof ApiRequestError && e.status === 404)) throw e;
      }
      if (savedId) setPushRef(savedId, null);
      onPushRefChange(null);
      if (!(savedId && otherTicketUsesPush(savedId)) && support === 'supported') {
        try {
          const reg = await swRegistration();
          await (await reg.pushManager.getSubscription())?.unsubscribe();
        } catch {
          // the server side is off, which is what stops the alerts
        }
      }
      say({ text: 'Push alert is off for this ticket on this device.', error: false });
    } catch (e) {
      say({
        text:
          e instanceof ApiRequestError && e.status === 0
            ? 'You are offline. The push alert can be turned off when you are back online.'
            : 'The push alert could not be turned off. Please try again.',
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }

  let body: ReactElement;
  if (cap === null) {
    body = <p className="muted">Checking whether push alerts are available…</p>;
  } else if (cap === 'offline' && !pushRef) {
    body = (
      <p data-testid="push-state" data-state="offline">
        Push alerts can be set up when you are online.
      </p>
    );
  } else if (cap !== 'offline' && cap.web_push !== 'live') {
    body = (
      <p data-testid="push-state" data-state="disabled">
        Push alerts are not available here.
      </p>
    );
  } else if (support === 'ios_not_installed') {
    body = (
      <p data-testid="push-state" data-state="ios_not_installed">
        On iPhone and iPad, push alerts work only in the installed app: add QueueBridge to your Home
        Screen (iOS 16.4 or later), open it from there, and turn the alert on in the app.
      </p>
    );
  } else if (support === 'unsupported') {
    body = (
      <p data-testid="push-state" data-state="unsupported">
        This browser does not support push alerts.
      </p>
    );
  } else if (pushRef) {
    body = (
      <>
        <p data-testid="push-state" data-state="on">
          <span aria-hidden="true">✓ </span>Push alert is on for this ticket on this device.
        </p>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void disable()}
            data-testid="push-off"
          >
            {busy ? 'Turning off…' : 'Turn off push alert'}
          </button>
        </div>
      </>
    );
  } else if (permission === 'denied') {
    body = (
      <p data-testid="push-state" data-state="denied">
        {DENIED_TEXT}
      </p>
    );
  } else {
    body = (
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void enable()}
          data-testid="push-on"
        >
          {busy ? 'Setting up…' : 'Get a push alert (optional)'}
        </button>
      </div>
    );
  }

  return (
    <section aria-labelledby="push-heading" className="card" data-testid="push-panel">
      <h2 id="push-heading" className="card-title">
        Alert when you are called
      </h2>
      <p>
        This page shows an alert when it is your turn. A push alert can also tell you while this
        page is in the background. Push is best effort: it may arrive late or not at all, and not
        every device supports it. On Android it can work with the browser closed; on a computer the
        browser must be running.
      </p>
      {body}
      {note ? (
        <p
          role={note.error ? 'alert' : 'status'}
          className={note.error ? 'alert alert-error' : 'alert alert-info'}
          data-testid="push-note"
        >
          {note.text}
        </p>
      ) : null}
      <p className="hint">
        Always keep an eye on the public board: staff calling your ticket there is the reliable way
        to know it is your turn.
      </p>
    </section>
  );
}
