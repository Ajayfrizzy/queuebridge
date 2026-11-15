# M5 Manual Acceptance — Instructions and Checklist

Scope: the M5.1–M5.4 checks that automated tests cannot settle (real devices, real assistive
technology, real push services, real people at a desk). Record every result in
`docs/testing/M5-evidence.md` → "M5 acceptance report" → "Manual results", as **Pass**, **Fail**
(with what was seen) or **Not executed** (with the reason). Do not record a check as passed
because an automated test covers something similar.

Nothing in this file is a credential. Keep accounts, passwords, VAPID keys and tunnel addresses in
a private file outside the repository (for example `~/.config/queuebridge/`, mode 600).

---

## 0. Where each check can run

| Kind                                               | Needs                                                                                                                                                      | Checks             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **L — local desktop**                              | this Mac, a desktop browser, `localhost`                                                                                                                   | 1–14, 25–30, 33–36 |
| **D — local + a phone/tablet on the same network** | phone browser; QR scanning; HTTP is enough (no service worker needed)                                                                                      | 15–17, 31, 32      |
| **H — HTTPS origin reachable from the phone**      | an `https://` address for the web app (a tunnel or a host with a certificate), real VAPID keys, the worker able to reach the push services on the internet | 18–24              |
| **A — assistive technology**                       | VoiceOver (macOS/iOS), TalkBack (Android) or NVDA (Windows)                                                                                                | 37–41              |

Why HTTPS for H: browsers allow service workers and push only on a secure origin. `localhost`
counts as secure on the Mac itself, but a phone opening `http://192.168.x.x` does not. iOS push
additionally needs the app installed to the Home Screen from an HTTPS origin, on iOS/iPadOS 16.4
or later.

---

## 1. Prerequisites (one-time; your action)

1. **PostgreSQL**: the container `queuebridge-pg` (port 55433) running (`docs/local-environment.md` §1).
2. **Development database migrations.** At the time of writing the development database
   `queuebridge` is at migration **0006**; M5 needs **0007–0009**. Back it up first and then
   migrate, as described in `docs/local-environment.md` §5 ("Applying a new migration to the
   existing development database"):
   ```bash
   set -a; . ./.env; set +a
   pnpm db:check            # shows the pending migrations; changes nothing
   # back up (see §5), then:
   pnpm db:migrate
   ```
3. **Secrets in `.env`** (never committed): `pnpm env:generate` (session, contact and audit keys
   if missing). For H checks also `pnpm env:generate --vapid`, then add a contact yourself:
   `VAPID_SUBJECT=mailto:<your address>`. Verify: `pnpm build && pnpm env:check` → `READY`.
4. **Accounts with one role each** (`docs/local-environment.md` §6): an organization admin, a
   `staff_reception`, a `staff_counter`, two `supervisor`s (one approves another's request), an
   `auditor`. A facility with one service and **two counters** serving it.
5. For H checks only: an HTTPS address for the web app that the phone can open, for example a
   free quick tunnel from your own machine (`cloudflared tunnel --url http://localhost:4173`) or a
   staging host with a certificate. Add that origin to `CORS_ORIGIN` and `WEB_BASE_URL` (comma
   list for `CORS_ORIGIN`) so the API's Origin/CSRF checks accept it. Choosing a tunnel is your
   decision; no paid service is needed.

## 2. Starting the stack locally

Run each in its own terminal, from the repository root, after loading the environment:

```bash
set -a; . ./.env; set +a     # in EVERY terminal (no dotenv)

# Terminal 1 — API (port 3002)
pnpm dev:api

# Terminal 2 — worker (health evaluation every 30 s, push delivery, retention, checkpoints)
pnpm dev:worker

# Terminal 3 — web, for L/D checks that need no service worker (port 5173)
pnpm dev:web -- --host        # --host only if a phone on the network must reach it

# Terminal 3 (instead) — web as built, WITH the service worker (needed for push, offline shell,
# installability; port 4173). Re-run after code changes.
pnpm --filter @queuebridge/web exec vite build
pnpm --filter @queuebridge/web exec vite preview --port 4173 --host
```

`CORS_ORIGIN`/`WEB_BASE_URL` must name the origin you open (`http://localhost:5173`,
`http://localhost:4173` or your HTTPS address). For push checks the worker must run with real
VAPID keys and `PUSH_TRANSPORT` unset or `web` (never `sandbox`). Watch the worker terminal: it
logs counts and outcome codes only, never endpoints or keys.

Useful read-only check while testing (counts only):

```bash
psql "$DATABASE_URL" -c "SELECT status, detail_code, COUNT(*) FROM notifications WHERE channel='web_push' AND created_at > NOW() - INTERVAL '1 hour' GROUP BY 1,2"
```

---

## 3. Checklist

Each line: **what to do** → **expected result**.

### M5.1 Recovery (F4)

1. (L) Join from the join link; on the ticket page the recovery key panel appears once → key shown
   as 8 groups of 4, a QR and a link; the address bar never contains the key.
2. (L) Press **Copy** → the clipboard holds the key; paste into a text editor; no other value.
3. (L) Press **Print** (or Ctrl/Cmd-P) → the preview contains the ticket code and the key text
   only; buttons, hints and the page chrome are not printed.
4. (L) Press **Share** where the browser supports it → the system share sheet opens with the
   recovery link; where unsupported the button is absent or explains why.
5. (L) In a private window, open `/recover`, enter facility, code and the key typed with spaces,
   hyphens and lower case → the ticket opens; the original window still works.
6. (L) Enter a wrong key five times from the same browser, then the right key → the sixth attempt
   says "Too many attempts"; from another network (or after 15 minutes) the right key works.
   Every failure reads exactly the same, whether or not the code exists.
7. (L) On the ticket page press **Get a new recovery key** → a new key is shown; the old key now
   fails on `/recover`; your place in the queue is unchanged.
8. (L) With two browsers holding the ticket, press **Sign out other devices** in one → the other
   shows "no longer has access" on its next refresh; the first keeps working; the first sees a
   notice the next time access is granted elsewhere.
9. (L, two staff accounts) Staff console → ticket → **Help a visitor get their ticket back** as the
   counter operator, answering yes to the checks → "approval required"; the same person cannot
   approve; the second supervisor approves from their list → the grant QR is shown once on the
   staff screen; opening it on the visitor's device gives access; using it a second time fails.
10. (L) Repeat 9 answering "no" to the checks → restricted assistance only: no QR, no credential.
11. (L) As the auditor, try the same → the action is not offered / refused.
12. (L) Auditor → Audit trail: the recovery and approval entries name both staff members and the
    reason, and show no key, grant or token.
13. (L) During an offline capture at the desk (staff console offline, issue a walk-in) → the
    temporary reference card says recovery is not available until the server confirms it; the
    recover page shows the matching note about temporary references.
14. (L, missed-turn) With `rejoin_policy = self_resume`, call and mark missed, then press
    **I am here** inside the grace window → back in the queue; after the window → told to join
    again.

### QR scanning and phones (D)

15. (D) Scan the join QR with a phone camera → the join page opens on the phone.
16. (D) Scan the key QR from the ticket page with a second phone → the ticket opens; the address
    bar shows no key after loading.
17. (D) Scan a staff grant QR (from check 9) with the visitor's phone → access granted once.

### M5.4 Web Push and notification identity (H)

18. (H, Android Chrome) Open the HTTPS app, join, press **Get a push alert (optional)** → the
    permission prompt appears only now; allow → "Push alert is on for this ticket on this
    device". Lock the phone; staff call the ticket → a notification "Your turn: <code>" arrives
    (record the delay); the staff console shows "Push sent, not confirmed".
19. (H) Tap the notification → the ticket page opens on the right ticket, shows the banner, and
    the staff console then shows "Seen on device".
20. (H) Turn the push alert off; release and call again → no notification; the in-app banner still
    appears when the page is open.
21. (H) Deny permission at the prompt → the page explains how to allow it in site settings and
    offers no button that cannot work; reload → no new prompt.
22. (H, two tickets with the same code) Join facility A and facility B (both first tickets share a
    code), turn push on for both, call both → two separate notifications; each opens its own
    ticket (check service and facility names).
23. (H) Forget ticket A on the phone, then tap A's notification (call it again if needed) → the
    neutral "not saved on this device" page; ticket B is NOT opened; the recovery-key link is
    offered.
24. (H, iOS/iPadOS 16.4+ if available) In Safari (tab) → the push panel explains Home Screen
    installation. Add to Home Screen, open the installed app, opt in, repeat 18–19 → record what
    happens exactly. If no compatible device is available, record **Not executed**.

### Delivery failure and recovery (L)

25. (L) Stop the worker; call a subscribed ticket → the in-app banner appears on the open page;
    queue progression is unaffected; serve and complete work.
26. (L) Start the worker after more than 120 s → the stale alert is not sent (TTL); the connectivity
    dashboard counts it under "Failed".
27. (L) Configure a wrong VAPID private key for the worker only → the worker logs one error and
    keeps running its other jobs; the dashboard shows "Settings differ between the server and the
    alert worker" if the public key differs; calls still work.
28. (L, auto no-show off) A called visitor whose push failed is never marked missed automatically.

### M5.3 Device health and continuity (two devices: L or D)

29. (L/D) Two browsers (tablet and laptop) signed in as counter and supervisor; assign the tablet
    as coordinator; take the tablet offline (airplane mode) → after 2 minutes the dashboard shows
    it **offline**, after 15 minutes **stale**, and the `coordinator_offline` alert with its advice;
    nothing changes automatically.
30. (L/D) While offline, call and serve on the tablet → the tablet labels them Local / Pending
    sync; the visitor page does not show them as confirmed and no push is sent.
31. (D) On the laptop's connectivity dashboard the supervisor presses **Fail over to this device** → the laptop can call; reconnect the tablet
    → its offline calls are held for review ("needs review", stale epoch), never applied silently;
    resolve them from the conflict list.
32. (D) On the connectivity dashboard press **Revoke** for the tablet with the reason "lost" → the wording warns that unsent actions may be lost; the tablet
    can no longer sync; registering it again creates a new device.
33. (L) Acknowledge an alert as supervisor → it shows "Acknowledged by …"; as counter staff the
    action is not offered; as auditor it is read-only.

### M5.2 Accessibility (L)

34. (L, keyboard only) Join → ticket → Display and alerts → turn on the push alert → recover →
    rejoin, with Tab/Shift-Tab/Enter/Space/Escape only → every control reachable, focus always
    visible, never trapped; dialog returns focus to its opener; a call while the dialog is open
    closes it and focus stays on the page.
35. (L) Browser zoom 200 % on the ticket, recover and dashboard pages → no horizontal scrolling,
    nothing cut off; the 32-character key wraps.
36. (L) Display and alerts → high contrast, extra-large text, reduce motion, quiet mode; also the OS
    settings (increase contrast, reduce motion) → applied before the page appears, nothing moves,
    quiet mode gives no sound/vibration but the banner still shows; rotate a phone/tablet between
    portrait and landscape → content reflows, nothing is locked.

### Screen readers (A)

37. (A) VoiceOver or NVDA on the ticket page during a call → "It is your turn" content announced
    once (not repeated on refresh); position changes announced politely at most every 15 s.
38. (A) Push panel states (off, on, denied, unsupported) are read with their explanation; buttons
    have names.
39. (A) Recover form: errors are announced and linked to their fields; the success announcement is
    heard once.
40. (A) Staff console alert line ("Push sent, not confirmed" …) and the device-health alerts panel:
    new high-priority alerts announced politely; acknowledge buttons named with the alert.
41. (A, TalkBack on Android or VoiceOver on iOS) Repeat 37 and 39 on a phone.

---

## 4. Known limits to keep in mind while testing

- Push is best effort: no notification, a late one, or one only after unlocking are all possible
  and must be recorded as observed, not as a failure of the queue.
- Headless browser tests could not run the system-notification and notification-click branches;
  checks 18–24 are the only evidence for them.
- The visitor bundle is above the 100 kB target (REQ-F7.7); first loads on slow networks are
  slower than intended (M7 work).
