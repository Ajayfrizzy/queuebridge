# M5 Manual Acceptance — Instructions and Record

Authoritative guide for the M5.1–M5.4 checks that automated tests cannot settle. Every check has
a record block; fill in **Actual**, **Result** (`Pass`, `Fail` or `Not tested`) and **Evidence**
(screenshot file name, screen-recording, or a short description; never a secret). A check is
`Not tested` until a person has done it; an automated test never counts as a manual pass. Copy the
final results into `docs/testing/M5-evidence.md` → "Manual results".

Nothing in this file is a credential. Passwords, VAPID keys and tunnel addresses belong in a
private file outside the repository (for example `~/.config/queuebridge/`, mode 600).

---

## 0. Environment status (prepared 2026-11-15)

- Development database `queuebridge` (container `queuebridge-pg`, `localhost:55433`): identity
  verified (`_queuebridge_identity` = `queuebridge`), **migrated to 9/9** (0007–0009 applied with
  the repository runner); all 20 existing queue sessions verify (`verified`) after migration.
  Backup taken before migrating: `~/queuebridge-backups/queuebridge-20261115-121152-pre-0007.dump`
  (mode 600; restore-tested).
- `.env` (`pnpm env:check` → `READY`): session, contact-encryption and audit keys set; **Web Push
  not configured** (no VAPID keys). Non-secret settings: `CORS_ORIGIN` and `WEB_BASE_URL` =
  `http://localhost:5173`, `PORT=3002`, `API_PROXY_TARGET=http://localhost:3002`, `TRUST_PROXY=false`.
- Existing accounts you can use (passwords are yours, from M4; not stored here):
  - organization `m4-acceptance`, facility `m4-clinic` (one counter; services "General
    Consultation" prefix `G` and "General Consultation 2" prefix `A`): one account each for
    **org_admin, staff_counter, supervisor, auditor**.
  - organization `queuebridge-demo`, facilities `sas` and `surulere-branch` (org_admin only).
    "Queue 2" at `sas` and "Lacrin" at `surulere-branch` both use prefix `A`, so the first ticket
    of the day in each is `A001`: the same-code fixture for checks 22–23.
  - organization `demo-health-centre`: one account holding five roles (not usable for refusal
    checks).
- Missing for some checks: a `staff_reception` account is optional (counter staff can issue
  walk-ins). Invite one through Administration → Staff if you want to test reception separately.

## 1. Configuration per phase (names only; set values in `.env`)

| Phase                             | Change from the current `.env`                                                                                                                                                                        | Why                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A, B (Mac, `localhost`)           | none                                                                                                                                                                                                  | `localhost` is a secure origin on the Mac                                                          |
| B with desktop push               | `pnpm env:generate --vapid`; add `VAPID_SUBJECT=mailto:<you>`; `CORS_ORIGIN`/`WEB_BASE_URL` = `http://localhost:4173` while using the built app                                                       | real Web Push from desktop Chrome on `localhost` (no HTTPS needed on the Mac itself)               |
| C (phone on the same Wi-Fi, HTTP) | add `http://<Mac LAN address>:5173` to `CORS_ORIGIN` (comma list) and set `WEB_BASE_URL` to it                                                                                                        | the API's Origin check must accept the phone's origin; join QR codes are built from `WEB_BASE_URL` |
| D (Android/iOS push)              | an HTTPS address that reaches the Mac's port 4173 (e.g. a free quick tunnel: `cloudflared tunnel --url http://localhost:4173`); add it to `CORS_ORIGIN`, set `WEB_BASE_URL` to it; VAPID keys as in B | phones allow service workers and push only on HTTPS                                                |

Restart the API and worker after every `.env` change (they read the environment once). Restore
`CORS_ORIGIN`/`WEB_BASE_URL` to `http://localhost:5173` when you are done.

## 2. Commands

From the repository root, in **every** terminal first:

```bash
set -a; . ./.env; set +a
```

Build once (and after any code change). `dev:api` and `dev:worker` run the built `dist/` files:

```bash
pnpm build
```

| Terminal                         | Command                                                                                                                 | Notes                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1 — API (port 3002)              | `pnpm dev:api`                                                                                                          | restarts on rebuild                                    |
| 2 — worker                       | `pnpm dev:worker`                                                                                                       | health evaluation every 30 s, push delivery, retention |
| 3 — web, development (port 5173) | `pnpm dev:web` (add `-- --host` for phase C)                                                                            | no service worker: no push, no offline reload          |
| 3 — web, built (port 4173)       | `pnpm --filter @queuebridge/web exec vite build && pnpm --filter @queuebridge/web exec vite preview --port 4173 --host` | service worker: push, offline shell, installable       |

Read-only helper for push checks (counts only):

```bash
psql "$DATABASE_URL" -c "SELECT status, detail_code, COUNT(*) FROM notifications WHERE channel='web_push' AND created_at > NOW() - INTERVAL '1 hour' GROUP BY 1,2"
```

(`psql` is not required; the connectivity dashboard shows the same counts.)

## 3. Where each check runs

| Needs                                                           | Checks                                       |
| --------------------------------------------------------------- | -------------------------------------------- |
| **Mac only** (Safari/Chrome/Firefox on `localhost`)             | 1–14, 25–36, 37–40 (VoiceOver on macOS)      |
| **Mac + desktop Chrome with real Web Push** (phase B; no HTTPS) | 18D, 19D, 20D, 21D (desktop variants), 25–27 |
| **Any phone on the same Wi-Fi (HTTP)**                          | 15, 16, 17                                   |
| **Android phone + HTTPS + real Web Push**                       | 18–23, 41 (TalkBack)                         |
| **iPhone/iPad iOS 16.4+ + HTTPS** (if available)                | 24, 41 (VoiceOver iOS)                       |
| **Windows + NVDA** (optional alternative to VoiceOver)          | 37–40                                        |

## 4. Recommended order (fewest environment changes)

1. **Phase A** — Mac, `pnpm dev:web`, current `.env`: 1–12, 14, 33–36, then 37–40 with VoiceOver.
2. **Phase B** — Mac, built app on 4173 (switch `CORS_ORIGIN`/`WEB_BASE_URL` to 4173): 13, 29–32
   (two browser profiles stand in for tablet and laptop; DevTools → Network → Offline), then add
   VAPID keys and run 18D–21D, 25–28 with desktop Chrome.
3. **Phase C** — same Wi-Fi, `pnpm dev:web -- --host` with the LAN origin: 15–17.
4. **Phase D** — HTTPS tunnel to 4173: 18–23 on Android, 41 TalkBack; then 24 and 41 on iOS if
   available.
5. Restore `.env` to the localhost values.

---

## 5. Checks

Record template for each check: **Actual:** — · **Result:** Not tested · **Evidence:** —

### M5.1 Recovery (F4)

**1. Recovery key shown once (Mac)**

- Preconditions: phase A; today's queue for the service is open (supervisor or admin → Staff
  console → facility → **Open today's queue**).
- Steps: open the facility's join page (`/join/<org>/<facility>`), press **Get a ticket** on the
  service; read the key panel; press **Show QR code**; press **I have saved my key**; reload.
- Expected: the "Your recovery key" panel appears once, with the key as 8 groups of 4 letters and
  digits joined by hyphens and the buttons Copy key, (Share key), Save as file, Print, Show QR
  code; **Show QR code** reveals a QR (it encodes the recovery link; no link is shown as text);
  the address bar never contains the key; after **I have saved my key** the panel is gone and does
  not return on reload.
- Actual: — · Result: Not tested · Evidence: —

**2. Copy key (Mac)**

- Preconditions: as 1, before dismissing the panel.
- Steps: press **Copy key**; paste into a text editor.
- Expected: exactly the key text (no link, no code).
- Actual: — · Result: Not tested · Evidence: —

**3. Print (Mac)**

- Preconditions: as 1.
- Steps: press **Print**; look at the print preview.
- Expected: ticket code and key text only; buttons, hints and site header not printed.
- Actual: — · Result: Not tested · Evidence: —

**4. Share / Save as file (Mac)**

- Preconditions: as 1; Safari on macOS supports Share, Chrome on macOS may not.
- Steps: press **Share key** (where shown) and **Save as file**.
- Expected: Share opens the system sheet with the key in groups (no link); where Share is
  unsupported the button is absent; Save downloads `queuebridge-recovery-<code>.txt` containing the
  ticket code, facility, the grouped key and the privacy note (no link, no token).
- Actual: — · Result: Not tested · Evidence: —

**5. Recover with a typed key (Mac)**

- Preconditions: a ticket and its key from 1.
- Steps: private window → `/recover`; enter organization, facility, code and the key in lower
  case with spaces instead of hyphens; **Recover my ticket**.
- Expected: the ticket opens in the private window; the original window still works.
- Actual: — · Result: Not tested · Evidence: —

**6. Throttle and uniform failures (Mac)**

- Preconditions: a fresh ticket and key. Locally every browser reaches the API through the same
  proxy address, so all windows count as one source.
- Steps: on `/recover`, enter a wrong key 5 times; then the right key; then also try a code that
  does not exist with any key.
- Expected: failures 1–5 show the same "could not recover" message (identical for the real and
  the non-existent code); the 6th attempt (even with the right key) says "Too many attempts from
  this connection"; after
  15 minutes the right key works. No message ever says whether the ticket exists.
- Actual: — · Result: Not tested · Evidence: —

**7. New recovery key (Mac)**

- Preconditions: an open ticket page.
- Steps: **Get a new recovery key**; then try the OLD key on `/recover`; then the NEW key.
- Expected: a new key panel; the old key fails like any wrong key; the new key works; position and
  waiting time unchanged.
- Actual: — · Result: Not tested · Evidence: —

**8. Sign out other devices (Mac, two browsers)**

- Preconditions: the same ticket open in browser A (join) and browser B (recovered with the key).
- Steps: after B has recovered, refresh A and read the notices; then in A press **Sign out other
  devices**; refresh B.
- Expected: A shows "Access to this ticket was given to another device at …"; after sign-out, B
  says this device no longer has access; A keeps working; A's message says how many devices were
  signed out.
- Actual: — · Result: Not tested · Evidence: —

**9. Staff-assisted recovery, two people (Mac, two staff browsers)**

- Preconditions: `m4-acceptance` counter account and supervisor account signed in in separate
  browsers on the same queue; a waiting ticket.
- Steps: counter → staff console → **Help a visitor get their ticket back** → choose the ticket,
  reason, answer the checks "yes" → request; try to approve with the counter account; supervisor →
  same panel → **Requests waiting for approval** → approve; counter shows the grant QR; open it on
  the "visitor" browser (or copy its link from the QR with a phone, check 17); try the grant again.
- Expected: "Waiting for a different supervisor to approve"; the counter cannot approve; after
  approval the visitor's browser gets the ticket; second use fails; the staff screen never shows
  the grant as text.
- Actual: — · Result: Not tested · Evidence: —

**10. Restricted assistance (Mac)**

- Preconditions: as 9.
- Steps: repeat 9, answering "no" to the checks.
- Expected: restricted assistance only: guidance text, no QR, no credential.
- Actual: — · Result: Not tested · Evidence: —

**11. Auditor cannot assist (Mac)**

- Preconditions: auditor account.
- Steps: open the staff console for the queue.
- Expected: no recovery or command actions offered (read-only).
- Actual: — · Result: Not tested · Evidence: —

**12. Audit trail of recovery (Mac)**

- Preconditions: after 9.
- Steps: auditor → queue → Audit trail; also supervisor → connectivity dashboard counters.
- Expected: entries name the requesting and approving staff and the reason; no key, grant or token
  text anywhere.
- Actual: — · Result: Not tested · Evidence: —

**13. Temporary tickets are not recoverable yet (Mac, phase B)**

- Preconditions: counter signed in on the built app; DevTools → Network → Offline.
- Steps: **Issue walk-in ticket** while offline; read the card; open `/recover` in another window.
- Expected: the card says it is a temporary reference and recovery is not available until the
  server confirms it; the recover page has the note about temporary references; going online syncs
  and gives a real code.
- Actual: — · Result: Not tested · Evidence: —

**14. Missed turn and rejoin (Mac)**

- Preconditions: admin sets the service's rejoin policy to "self resume" (Administration →
  Services); grace window default 300 s.
- Steps: call the visitor, mark missed; on the ticket page press **I am here, return me to the
  queue** within 5 minutes; repeat and wait past 5 minutes.
- Expected: inside the window: back to waiting; after it: told to join again or ask staff;
  automatic no-show stays off unless enabled.
- Actual: — · Result: Not tested · Evidence: —

### Phones on the same Wi-Fi (phase C)

**15. Scan the join QR (phone)**

- Preconditions: phase C settings; join QR shown in Administration (built from `WEB_BASE_URL`).
- Steps: scan with the phone camera.
- Expected: the join page opens on the phone; a ticket can be taken.
- Actual: — · Result: Not tested · Evidence: —

**16. Scan the key QR (second phone)**

- Preconditions: a ticket on phone 1 with its key panel open.
- Steps: scan the key QR with phone 2.
- Expected: the ticket opens on phone 2; the address bar shows no key after loading. (Copy and
  Share need HTTPS on phones; test them on the Mac, checks 2 and 4.)
- Actual: — · Result: Not tested · Evidence: —

**17. Scan a staff grant QR (phone)**

- Preconditions: an approved grant from check 9.
- Steps: scan it with the visitor's phone.
- Expected: access granted once; a second scan fails.
- Actual: — · Result: Not tested · Evidence: —

### M5.4 Web Push (desktop variant "D" in phase B; phones in phase D)

**18 / 18D. Opt in and receive a push**

- Preconditions: VAPID configured, worker running with `PUSH_TRANSPORT` unset; built app; for 18
  an Android phone on the HTTPS address, for 18D desktop Chrome on `localhost:4173`.
- Steps: join; **Get a push alert (optional)**; allow; put the page in the background (phone:
  lock the screen; desktop: switch to another window); staff call the ticket.
- Expected: the permission prompt appears only after pressing the button; "Push alert is on for
  this ticket on this device"; a notification "Your turn: <code>" appears (record the delay); the
  staff console shows "Push sent, not confirmed".
- Actual (18): — · Result: Not tested · Evidence: —
- Actual (18D): — · Result: Not tested · Evidence: —

**19 / 19D. Open the notification**

- Preconditions: after 18 / 18D.
- Steps: tap/click the notification.
- Expected: the right ticket page opens with the banner; the staff console then shows "Seen on
  device".
- Actual (19): — · Result: Not tested · Evidence: —
- Actual (19D): — · Result: Not tested · Evidence: —

**20 / 20D. Turn push off**

- Preconditions: push on.
- Steps: **Turn off push alert**; staff release and call again.
- Expected: no notification; the in-app banner still appears with the page open.
- Actual (20): — · Result: Not tested · Evidence: —
- Actual (20D): — · Result: Not tested · Evidence: —

**21 / 21D. Permission denied**

- Preconditions: a new ticket; site permission not yet granted.
- Steps: press the button and choose Block/Deny; reload.
- Expected: text explains how to allow notifications in site settings; no push button; no new
  prompt on reload; in-app alerts still work.
- Actual (21): — · Result: Not tested · Evidence: —
- Actual (21D): — · Result: Not tested · Evidence: —

**22. Two tickets with the same code (Android)**

- Preconditions: `queuebridge-demo` admin opens today's queues for "Queue 2" (`sas`) and "Lacrin"
  (`surulere-branch`) with no tickets yet.
- Steps: on one phone take the first ticket in each (both `A001`); turn push on for both; call
  both.
- Expected: two separate notifications; each opens its own ticket (check the service and facility
  names on the page).
- Actual: — · Result: Not tested · Evidence: —

**23. Notification for a forgotten ticket (Android)**

- Preconditions: after 22.
- Steps: on ticket `sas`/A001 press **Forget this ticket on this device**; staff release and call
  it again; tap its notification.
- Expected: "This alert is for ticket A001. That ticket is not saved on this device"; the
  `surulere-branch` ticket is NOT opened; an **Enter your recovery key** link is offered.
- Actual: — · Result: Not tested · Evidence: —

**24. iPhone/iPad (iOS 16.4+), if available**

- Preconditions: HTTPS address; an iOS device.
- Steps: open in Safari (tab) → read the push panel; Share → Add to Home Screen; open the
  installed app; join; opt in; lock; call.
- Expected: in the tab the panel explains Home Screen installation; in the installed app the
  opt-in works; record exactly whether a notification arrives.
- Actual: — · Result: Not tested · Evidence: — (if no device: `Not tested — no compatible device`)

### Delivery failure and recovery (Mac, phase B)

**25. Worker stopped (Mac)**

- Preconditions: a subscribed ticket (18D).
- Steps: stop the worker; call the ticket; serve and complete it.
- Expected: the in-app banner appears on the open page; serving and completing work; no
  notification while the worker is stopped.
- Actual: — · Result: Not tested · Evidence: —

**26. Stale alert after restart (Mac)**

- Preconditions: as 25 with a new call.
- Steps: keep the worker stopped for more than 2 minutes after the call; start it.
- Expected: no late notification; the connectivity dashboard "Visitor push alerts" counts it
  under Failed (time-to-live elapsed).
- Actual: — · Result: Not tested · Evidence: —

**27. Broken worker push configuration (Mac)**

- Preconditions: worker terminal only: set a different (wrong) `VAPID_PRIVATE_KEY`, restart the
  worker; API unchanged.
- Steps: watch the worker log; open the connectivity dashboard after 30 s; call a ticket.
- Expected: one worker error "Web Push disabled: invalid VAPID configuration", other jobs keep
  running; the dashboard warns "Settings differ between the server and the alert worker:
  VAPID_PUBLIC_KEY"; calls and the in-app banner work. Restore the key afterwards.
- Actual: — · Result: Not tested · Evidence: —

**28. No automatic no-show from failed alerts (Mac)**

- Preconditions: automatic no-show off (default); a called ticket whose push failed (26 or 27).
- Steps: wait 10 minutes.
- Expected: the ticket stays "Called"; only staff can mark it missed.
- Actual: — · Result: Not tested · Evidence: —

### M5.3 Device health and continuity (phase B; two browser profiles, or two real devices)

**29. Offline and stale coordinator (Mac or two devices)**

- Preconditions: profile 1 = counter ("tablet"), profile 2 = supervisor ("laptop"), both on the
  queue; supervisor assigns the tablet as coordinator; at least one waiting ticket.
- Steps: take the tablet offline (DevTools Offline, or close it); wait 2 minutes, then 15 minutes;
  watch the supervisor's connectivity dashboard.
- Expected: tablet "offline" after about 2 minutes, "stale" after 15; the "offline coordinator is
  not responding" alert with advice; nothing changes automatically.
- Actual: — · Result: Not tested · Evidence: —

**30. Offline actions stay local (Mac)**

- Preconditions: as 29, tablet offline but still coordinator.
- Steps: call and serve on the tablet; look at the visitor page and staff alert line.
- Expected: tablet shows "Local" / "Pending sync"; the visitor page does not show the call as
  confirmed; no push and no in-app alert until the server commits it.
- Actual: — · Result: Not tested · Evidence: —

**31. Explicit failover and fencing (Mac or two devices)**

- Preconditions: as 30.
- Steps: on the laptop's connectivity dashboard press **Fail over to this device**; call on the
  laptop; bring the tablet back online.
- Expected: the laptop can call; the tablet's offline actions are held as "needs review" (stale
  epoch), never applied silently; the supervisor resolves them from the conflict list; no
  duplicate alert to the visitor.
- Actual: — · Result: Not tested · Evidence: —

**32. Lost device (Mac or two devices)**

- Preconditions: a registered device with unsent actions (offline).
- Steps: connectivity dashboard → **Revoke** for that device, reason lost; bring it online.
- Expected: wording warns that its unsent actions may be lost; it can no longer sync; signing in
  again registers a new device.
- Actual: — · Result: Not tested · Evidence: —

**33. Acknowledge alerts by role (Mac)**

- Preconditions: an open alert (29).
- Steps: supervisor acknowledges; counter and auditor open the dashboard.
- Expected: "Acknowledged by <name>"; counter has no acknowledge action (and only sees its own
  device warning on the console); auditor is read-only.
- Actual: — · Result: Not tested · Evidence: —

### M5.2 Accessibility (Mac)

**34. Keyboard only**

- Preconditions: phase A, mouse/trackpad untouched.
- Steps: join → ticket → **Display and alerts** → push panel → `/recover` → rejoin (14), with
  Tab/Shift-Tab/Enter/Space/Escape only; have staff call while the Display and alerts dialog is
  open.
- Expected: every control reachable in a sensible order; focus always visible and never trapped;
  the dialog returns focus to its opener; a call closes the dialog and focus stays on the page
  (the banner); Dismiss returns focus to the heading.
- Actual: — · Result: Not tested · Evidence: —

**35. 200 % zoom**

- Preconditions: Cmd-+ to 200 % (Safari or Chrome).
- Steps: ticket page with key panel, recover page, connectivity dashboard.
- Expected: no horizontal scrolling, nothing cut off; the 32-character key wraps.
- Actual: — · Result: Not tested · Evidence: —

**36. Display preferences and orientation**

- Preconditions: Display and alerts dialog; macOS Accessibility settings; a phone or tablet for
  rotation (any phase).
- Steps: high contrast, extra-large text, reduce motion, quiet mode; then macOS "Increase
  contrast" and "Reduce motion"; trigger a call; rotate a phone between portrait and landscape.
- Expected: settings apply before the page appears (no flash); nothing moves; quiet mode: no sound
  or vibration but the banner shows; rotation reflows, nothing locked.
- Actual: — · Result: Not tested · Evidence: —

### Screen readers

**37. Called announcement (VoiceOver on macOS, or NVDA)**

- Preconditions: screen reader on; ticket page open.
- Steps: staff call the ticket; refresh; watch position changes before the call.
- Expected: the call is announced once and not again on refresh; position changes politely, at
  most one per 15 s.
- Actual: — · Result: Not tested · Evidence: —

**38. Push panel states (VoiceOver/NVDA)**

- Steps: navigate the push panel in its off, on, blocked and unsupported states.
- Expected: each state's text is read; buttons have names.
- Actual: — · Result: Not tested · Evidence: —

**39. Recover form (VoiceOver/NVDA)**

- Steps: submit empty, then a wrong key, then the right key.
- Expected: errors announced and linked to their fields; the failure message read; success
  announced once.
- Actual: — · Result: Not tested · Evidence: —

**40. Staff alert line and health panel (VoiceOver/NVDA)**

- Steps: staff console with a called, subscribed ticket; connectivity dashboard when a new
  high-priority alert opens.
- Expected: the visitor-alert line is read ("Push sent, not confirmed" …); a new high-priority
  alert announced politely; acknowledge buttons named with the alert.
- Actual: — · Result: Not tested · Evidence: —

**41. Phone screen readers (TalkBack on Android; VoiceOver on iOS if available)**

- Steps: repeat 37 and 39 on the phone.
- Expected: as 37 and 39.
- Actual (TalkBack): — · Result: Not tested · Evidence: —
- Actual (VoiceOver iOS): — · Result: Not tested · Evidence: —

---

## 6. Known limits while testing

- Push is best effort: no notification, a late one, or one only after unlocking must be recorded
  as observed, not counted as a queue failure.
- The system-notification and notification-click branches ran only in unit tests against the real
  file; checks 18–24 are their only real evidence.
- The visitor bundle is above the 100 kB target (REQ-F7.7); first loads on slow networks are
  slower than intended (M7).
