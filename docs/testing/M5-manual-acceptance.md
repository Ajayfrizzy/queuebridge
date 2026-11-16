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

## 0a. Acceptance schedule: two sets (approved by the product owner, 2026-11-16)

Manual acceptance is split into two sets so the remaining development can go on without dropping
any required verification. Check numbers, procedures and acceptance criteria are unchanged.

- **Set 1 — development acceptance: checks 1–14. Closed 2026-11-16, all 14 Pass** (checks 3, 6,
  9, 10, 12 and 13 after a correction or revalidation; their failures, investigations and retests
  are kept in each record).
- **Set 2 — final acceptance: checks 15–41**, including the desktop ("D") and per-device
  variants. Run at the final integration and pre-submission stage, after M7. Until a person runs
  them, their result is **Not tested — scheduled for final acceptance (Set 2)**. Deferral alone is
  never a Pass, Fail or Skip.
- **Rules that still apply:**
  - A confirmed critical security or integrity defect is never deferred. If one is found by any
    means (a test, a review, a manual check of either set), it is fixed and re-verified before the
    next checkpoint, whatever the schedule.
  - Automated regression, security, database, integration and CI testing continues on every
    change throughout MQ, M6 and M7; the automated groups behind these checks (8, 11, 14) must stay
    green. Automated tests support, but never replace, a manual result.
  - No out-of-pocket spending: Set 2 uses the Mac, devices already available, and free tools
    (for example a free quick tunnel for HTTPS). A check that needs a device that is not available
    is recorded as `Not tested — no compatible device`, not as a Pass.
  - Before Set 2 starts, re-read each procedure against the final (M7) screens: if a screen or
    label was renamed, update the wording only, never the acceptance criterion, and note the change
    in the record.
- **Set 2 inventory, grouped by environment (fewest configuration changes):**

  | Group                          | Checks                                                   | Environment (section 1)                                           |
  | ------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------- |
  | 1. Mac and desktop browser     | 18D, 19D, 20D, 21D (desktop push); 25, 26, 27, 28        | phase B: built app on 4173, VAPID keys, desktop Chrome            |
  | 2. Phones on the local network | 15, 16, 17                                               | phase C: `--host`, LAN origin in `CORS_ORIGIN` and `WEB_BASE_URL` |
  | 3. Android and Web Push        | 18, 19, 20, 21, 22, 23; 41 (TalkBack)                    | phase D: free HTTPS tunnel to 4173, VAPID keys, Android Chrome    |
  | 4. iOS (if a device is there)  | 24; 41 (VoiceOver on iOS)                                | phase D with an iPhone/iPad on iOS 16.4+                          |
  | 5. Device health and failover  | 29, 30, 31, 32, 33                                       | phase B: two browser profiles (or two devices), DevTools offline  |
  | 6. Accessibility and readers   | 34, 35, 36; 37, 38, 39, 40 (VoiceOver on macOS, or NVDA) | phase A/B on the Mac                                              |

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
- Actual (2026-11-15, reported by the tester): the recovery panel, the QR display, dismissal and
  the reload behaviour worked as expected. The tester also reported "the recovery code appears in
  the address bar".
- Finding (investigated 2026-11-15): **not a credential exposure.** After joining, the address is
  `/ticket/<public code>?k=<device-local id>`. The `?k=` value is the saved ticket's device-local
  id (a UUID such as `0193xxxx-xxxx-7xxx-…`, 36 characters, 8-4-4-4-12), which grants nothing on
  its own and does not work on another device. The recovery key is 32 characters shown as 8
  groups of 4 (`XXXX-XXXX-…`); it is never written into the ticket URL. The key appears in an
  address bar only when a recovery link or QR (`/recover/…#k=<key>`) or a staff walk-in link
  (`/ticket/…#t=…&k=…`) is opened, in the fragment, which browsers never send to the server. The
  page removes it in about 15–17 ms (measured), and no history entry keeps it. Regression tests:
  `e2e/recovery-url-secrecy.spec.ts` (join, link/QR, walk-in, and failure paths: every
  navigation, request URL, Referer header, request body, Back/Forward and reload; four spellings
  of the key; no other origin contacted). Mutations that fail the suite: fragment not removed on
  the recover page; key added to the join URL; walk-in fragment kept by both removal paths (the
  ticket page's `replaceState` and its later router replace to `?k=`; disabling only the first
  still passes because the second removes the fragment within the tested bound). Failure output
  was scanned and contains no key or token.
- Result: **Pass.** The tester confirmed (2026-11-15) that the value seen in the address bar was
  the device-local id after `?k=` (a UUID in 8-4-4-4-12 form), not the 8×4 recovery key.
- Evidence: tester report and confirmation; finding above; automated regression suite named above
  (committed `4a0431a`).

**2. Copy key (Mac)**

- Preconditions: as 1, before dismissing the panel.
- Steps: press **Copy key**; paste into a text editor.
- Expected: exactly the key text (no link, no code).
- Actual (2026-11-15, reported by the tester): "No issues observed." **Copy key** copied the
  complete recovery key, matching the displayed value.
- Result: **Pass.**
- Evidence: manual test performed by the tester on 2026-11-15 (Mac); no key or clipboard contents
  recorded.

**3. Print (Mac)**

- Preconditions: as 1.
- Steps: press **Print**; look at the print preview.
- Expected: ticket code and key text only; buttons, hints and site header not printed.
- Result: **Pass — verified after correction** (retest 2026-11-15; the first run failed, see the
  history below).
- History:
  - First run (2026-11-15, reported by the tester): **Print** opened the browser's print preview,
    but the recovery key was not in the preview. Result then: **Fail — recovery key absent from
    print output.** (The tester first labelled it Pass because the print preview opened; the
    printed content was incomplete.) Evidence: the tester's manual observation (Mac).
  - Cause and fix (2026-11-15): the general print rule hid every `section` not marked printable,
    which included the recovery-key panel. While the panel is on screen, printing now produces
    only the key sheet (ticket code, facility, grouped key, privacy note). Regression test
    `e2e/recovery-print.spec.ts` reads the print rendering; it fails on the old code and passes on
    the fix (Chromium and WebKit; Firefox could not be launched on this machine).
  - Retest (2026-11-15, reported by the tester): "No issues observed." The tester confirmed the
    corrected print preview meets the expected behaviour: the recovery key, the ticket code, the
    facility information and the privacy notice appear correctly, and unrelated interface
    controls are excluded.
- Evidence: the tester's manual retest on 2026-11-15 (Mac); regression test
  `e2e/recovery-print.spec.ts`. No key or private ticket link recorded.

**4. Share / Save as file (Mac)**

- Preconditions: as 1; Safari on macOS supports Share, Chrome on macOS may not.
- Steps: press **Share key** (where shown) and **Save as file**.
- Expected: Share opens the system sheet with the key in groups (no link); where Share is
  unsupported the button is absent; Save downloads `queuebridge-recovery-<code>.txt` containing the
  ticket code, facility, the grouped key and the privacy note (no link, no token).
- Result: **Pass — fully verified** (2026-11-15, Google Chrome on Mac).
- History:
  - First report (2026-11-15, reported by the tester): **Save as file** downloaded a recovery-key
    text file; the key in the file matched the displayed key. No issues were reported. Result
    then: **Partial — Save as file passed; remaining assertions not verified.** Not verified at
    that point: whether **Share key** was shown and how it behaved; the downloaded file name
    (`queuebridge-recovery-<code>.txt`); whether the file contained the ticket code, the facility
    name and the privacy note; whether the file excluded links and status tokens.
  - Completion (2026-11-15, reported by the tester; Google Chrome on Mac): the tester confirmed
    the file name and the remaining file-content checks passed (ticket code, facility name and
    privacy note present; no link and no status token). **Share key** was shown in Chrome, and
    pressing it opened the share interface with the grouped recovery key and no link. No issues
    were observed.
- Evidence: the tester's reports of manual tests on 2026-11-15 (Mac, Google Chrome); no key, file
  contents, private ticket link or token recorded.

**5. Recover with a typed key (Mac)**

- Preconditions: a ticket and its key from 1.
- Steps: private window → `/recover`; enter organization, facility, code and the key in lower
  case with spaces instead of hyphens; **Recover my ticket**.
- Expected: the ticket opens in the private window; the original window still works.
- Actual (2026-11-15, reported by the tester): "No issues observed." The tester recovered an
  existing ticket in a separate Chrome private window using the correct organization and facility
  identifiers, the ticket code, and the recovery key entered in lower case with spaces instead of
  hyphens. The recovered ticket opened, and the original browser window kept access.
- Result: **Pass.**
- Evidence: manual verification performed by the tester on 2026-11-15 (Google Chrome on Mac). No
  recovery key or private ticket link recorded.

**6. Throttle and uniform failures (Mac)**

- Preconditions: a fresh ticket and key. Locally every browser reaches the API through the same
  proxy address, so all windows count as one source.
- Steps: on `/recover`, enter a wrong key 5 times; then the right key; then also try a code that
  does not exist with any key.
- Expected: failures 1–5 show the same "could not recover" message (identical for the real and
  the non-existent code); the 6th attempt (even with the right key) says "Too many attempts from
  this connection"; after
  15 minutes the right key works. No message ever says whether the ticket exists.
- Result: **Pass — verified after correction** (manual retest 2026-11-15; the first run failed,
  see the history below).
- Actual (retest, 2026-11-15, reported by the tester; Google Chrome on Mac): "It pass every
  tests." The tester confirmed that five well-formed incorrect-key attempts showed the same
  generic recovery-failure message; the sixth attempt was refused even with the correct key; a
  non-existent ticket code gave no response that revealed whether a ticket exists; and the
  correct key recovered the ticket after the 15-minute restriction expired.
- Evidence: the tester's manual retest on 2026-11-15 (Google Chrome on Mac); the tester reported
  that all checks passed. No key, token, private link or request data recorded.
- History:
  - First run (2026-11-15, reported by the tester; Google Chrome on Mac). Observation: every
    incorrect submission showed the generic message "We could not recover a ticket with those
    details…"; after what appeared to be more than five incorrect submissions the tester entered
    the correct key and the ticket was recovered, with no "Too many attempts" message. Not tested
    in that run: the non-existent code, the 15-minute expiry, and that no message reveals whether
    the ticket exists. Result then: **Fail — recovery rate limit not enforced as expected.**
    Evidence: the tester's manual test.
  - Confirmed root cause (investigation, 2026-11-15): the run did not exceed the limit. The API
    request log showed 9 recovery requests from one source (`127.0.0.1`, through the Vite proxy):
    four 400 validation errors, a 404, a 400, two 404s and then the 200; the database throttle
    rows showed 3 counted failures for the ticket. Only the three 404s were valid incorrect-key
    attempts. The other submissions failed request validation (a field empty or malformed: the
    key field is a password field and is cleared after every failure, so pressing the button
    again sent an empty key) and, as designed, did not count toward the five-failure limit; the
    page showed them with the same "could not recover" message, which made them look like wrong
    keys. The backend rate-limit policy and code were not changed.
  - Fix (frontend only, 2026-11-15; in the working tree, not yet committed): the recover page no
    longer sends an incomplete form and says "Fill in the organization, the facility, the ticket
    code and the recovery key…"; a server format error (400) shows its own "not in the expected
    form" message. Neither depends on whether a ticket exists.
  - Automated regression tests (supporting evidence; they do not replace the manual retest):
    `e2e/recovery-throttle.spec.ts` (through the proxy; fails on the old page, passes on the fix)
    and "manual check 6 sequence" in `apps/api/src/recovery.db.test.ts` (real PostgreSQL,
    including the 15-minute expiry with a shifted window).

**7. New recovery key (Mac)**

- Preconditions: an open ticket page.
- Steps: **Get a new recovery key**; then try the OLD key on `/recover`; then the NEW key.
- Expected: a new key panel; the old key fails like any wrong key; the new key works; position and
  waiting time unchanged.
- Actual (2026-11-15, reported by the tester): "No issues observed." The tester generated a
  replacement recovery key for an existing ticket and the new recovery-key panel appeared. The
  previous key was rejected with the generic recovery-failure message, and the replacement key
  recovered the ticket. The ticket's queue position and estimated waiting time were unchanged by
  the key rotation.
- Result: **Pass.**
- Evidence: manual verification performed by the tester on 2026-11-15 (Google Chrome on Mac). No
  recovery key or private ticket link recorded.

**8. Sign out other devices (Mac, two browsers)**

- Preconditions: the same ticket open in browser A (join) and browser B (recovered with the key).
- Steps: after B has recovered, refresh A and read the notices; then in A press **Sign out other
  devices**; refresh B.
- Expected: A shows "Access to this ticket was given to another device at …"; after sign-out, B
  says this device no longer has access; A keeps working; A's message says how many devices were
  signed out.
- Actual (2026-11-15, reported by the tester): "It passes all tests." The tester recovered the
  same ticket in a second browser session and confirmed both sessions initially had access.
  Refreshing the original session showed the notice that access to the ticket had been given to
  another device. Pressing **Sign out other devices** revoked the other session and showed the
  number of devices signed out. After a refresh, the second session showed that it no longer had
  access, and the original session kept working. No issues were observed.
- Result: **Pass.**
- Evidence: manual verification performed by the tester on 2026-11-15 (two separate browser
  sessions on Mac). No recovery key, status token or private ticket link recorded.

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
- Result: **Pass — independently verified after revalidation** (2026-11-16). Earlier results
  (Partial, a reported Pass without database confirmation, then Partial again) are kept below as
  history.
- Actual (final revalidation, 2026-11-16, reported by the tester; no issues reported):
  - The counter staff requested recovery with both verification confirmations ticked.
  - A different supervisor approved the request.
  - The local helper detected and decoded the approved grant QR.
  - Visitor A, in a fresh browser context, opened the expected ticket, G001.
  - After the first redemption the database showed one more redeemed grant, one more
    staff-issued status token and one more staff-grant recovery event.
  - Visitor B, in another fresh browser context, tried to redeem the same grant, got the generic
    recovery-failure message and did not open the ticket.
  - The second attempt produced no additional redemption, token or recovery event.
- Database evidence (read-only, counts only; redeemed grants / staff-issued status tokens /
  staff-grant recovery events): before redemption 0 / 0 / 0; after the first redemption 1 / 1 / 1
  (change +1 / +1 / +1); after the second redemption 1 / 1 / 1 (change 0 / 0 / 0). The helper
  reported four PASS results. (A read-only re-count by Kiro afterwards gave the same 1 / 1 / 1.)
- Evidence: the tester's manual verification on 2026-11-16, using separate staff browser sessions
  (counter and supervisor) and the local check 9 helper
  (`apps/web/e2e/manual/check9-grant-redemption.ts`). No grant, QR payload, link, key or token
  recorded.
- Earlier status of each assertion (2026-11-15, before the final revalidation; now resolved):
  - Staff recovery request, the counter unable to approve, approval by a separate supervisor, and
    the grant shown only as a QR (never as text): reported successful by the tester; not in
    question.
  - First redemption of an approved grant opens the visitor's ticket: **requires a fresh,
    independently verified manual test.**
  - A second redemption of the same grant is rejected: **requires a fresh, independently verified
    manual test.**
- Earlier evidence discrepancy (found 2026-11-15 by Kiro while investigating check 10; read-only database
  inspection of the development database, metadata only): four staff recovery grants existed; none
  had `redeemed_at` set; no status token had been issued with source `staff`; and no recovery
  event recorded `method: staff_grant`. A successful redemption writes all three in one
  transaction. These findings do not show that the feature is broken (the automated tests below
  pass), and they do not show that no grant was redeemed in any environment; they mean the
  earlier manual observation does not, on its own, establish a successful grant redemption in
  this database. **The cause of the discrepancy is unconfirmed.**
- Revalidation attempt (2026-11-15, reported by the tester, with a screenshot): the supervisor's
  staff console showed "Nobody is waiting" and, under **Requests waiting for approval**, requests
  for G003 and G002; pressing **Approve** showed "Not found". The revalidation could not continue.
  - Database findings (Kiro, read-only, metadata only): the facility's time zone is Africa/Lagos,
    and local midnight (23:00 UTC) had passed, so the facility's operational date was already
    2026-11-16. G002 and G003 were waiting tickets in the still-open 2026-11-15 session; today's
    (2026-11-16) session had no waiting tickets. The two requests (made at 23:37 and 23:40 UTC,
    by a different staff member, same facility) were pending, unapproved and inside their
    10-minute window when listed; both have since expired unredeemed.
  - "Nobody is waiting" was correct: it describes the console's queue (today's session), not
    yesterday's tickets.
  - Root cause (defect, confirmed by a regression test): the approval list was facility-wide,
    but approval checks that the ticket belongs to the queue named in the address. The supervisor
    was on today's queue, so the list offered yesterday's requests and every Approve was refused
    as not found. No security bypass: the server refused the approval as designed.
  - Fix (working tree, not committed): a queue's approval list now shows only requests for tickets
    of that queue. If an approval is refused anyway (expired, already decided, or no longer in
    this queue), the panel explains that in plain words and refreshes the list, instead of "Not
    found". The approval policy, permissions, second-person rule and 10-minute expiry are
    unchanged. Regression tests: "approval list scope" in `apps/api/src/recovery.db.test.ts`
    (fails on the old query) and "a request decided elsewhere…" in
    `e2e/recovery-staff-restricted.spec.ts` (fails on the old panel).
  - Next: make a fresh request and approval with the counter and the supervisor on the **same**
    queue page (today's session), then run the helper (revalidation procedure below).
- Revalidation attempt (2026-11-16, reported by the tester): the helper (screen version), run with
  and without `--check`, reported 0 approved grant QR codes visible; the database counts were
  0 / 0 / 0; nothing was redeemed.
  - Findings (Kiro, counts and metadata only): an approved, unexpired, unredeemed grant existed at
    that time (G001, today's session), so a usable QR was on the counter's page. A screenshot of
    the whole screen, with Screen Recording allowed, contained no QR symbol at all: the browser
    with the QR is not visible in a full-screen capture when another window (the one running the
    command) covers it, or it is on another Space. The helper also could not tell these cases
    apart. Not an application defect.
  - Correction (local helper only; no application change): by default the helper now opens its
    own counter window and reads the QR from that page's element (no screen capture, no
    permission). With `--check` or on failure it reports, as counts only: image captured, screen
    permission (screen mode), QR symbols detected, decoded, shaped like a grant link, matching
    this web address, and approved grants still usable in the database, with a next step. Kiro
    verified it against a real approved grant (1 detected / 1 decoded / 1 matching, nothing
    redeemed) and ran the screen preflight against the development stack (captured: yes;
    permission: yes; detected 0; usable grants 1; hint: QR not visible on screen).
- Not covered by this check: scanning the grant QR with a real phone. That remains a separate
  acceptance scenario (check 17, phase C).
- History:
  - Retest as reported by the tester (2026-11-15, "No issues observed."), kept as reported: the
    tester had already confirmed (first run) that the staff recovery request, approval by a
    separate supervisor and the grant QR on the staff screen worked correctly. In the Mac-only
    retest the first redemption of an approved grant opened the visitor's ticket; after the
    private visitor session was closed, redeeming the same grant again was rejected. Result
    recorded then: **Pass — fully verified after retest.** Evidence: the tester's manual
    verification using separate browser sessions on the Mac, with the Mac-only QR-decoding
    procedure below. Superseded by the Partial result above because of the evidence discrepancy.
  - First run (2026-11-15, reported by the tester): the staff-assisted recovery steps completed
    successfully, except the check that a grant that has already been used cannot be used again.
    The tester first reported Pass, then clarified that this last step could not be completed
    because the grant QR was opened on a phone. Staff recovery request and separate-supervisor
    approval: reported successful. Grant QR shown on the staff screen and ticket recovery:
    reported successful (scanning or redeeming the grant on the phone was not claimed). Second
    use of the same grant: not tested. Result then: **Partial — one-time-use verification
    pending.** Evidence: the tester's manual test; opening `localhost` from a phone prevented
    completion of the remaining step.
  - Explanation (2026-11-15): the grant QR is built from the staff browser's own address
    (`window.location.origin`), so with the staff console on `http://localhost:5173` the QR held
    a `localhost` link that the phone could not reach (on a phone, `localhost` is the phone
    itself). This was a limitation of the local test environment, not an application defect; no
    code was changed. The remaining one-time-use requirement was then verified with the
    documented Mac-only QR-decoding procedure below; no deployment was required.
  - Supporting automated coverage (not a substitute for this check): `e2e/recovery.spec.ts` opens
    the same grant in a second browser context and expects the neutral error;
    `apps/api/src/recovery.db.test.ts` "a grant redeemed twice at the same time opens the ticket
    exactly once".
- Revalidation procedure (revised 2026-11-16; run by the tester on 2026-11-16, result above): the local-only helper
  `apps/web/e2e/manual/check9-grant-redemption.ts` (not a test, not run by CI). It opens its own
  "counter" browser window; the tester signs in there as the counter account and makes the
  request in the normal staff console, and the supervisor approves in their own browser. When the
  one-time QR appears in that window, the helper photographs only the QR element (taken by the
  browser, so nothing on screen matters and no Screen Recording permission is needed), decodes it
  offline with macOS CoreImage in a private temporary folder, deletes the image at once and keeps
  the link in memory. It then opens the link through the normal `/recover` page and API in a
  fresh, isolated browser context (no cookies, no storage, no saved ticket), then once more in a
  second fresh context, reading counts from the database in a read-only session before and after.
  It prints only counts, the public ticket code and pass/fail lines; never the grant, the link or
  a token. Kiro verified it against a real approved grant in the staff console (throwaway test,
  deleted; nothing redeemed): 1 QR detected, 1 decoded, 1 matching the expected grant link.
  1. In Terminal, from the repository root:
     `set -a; . ./.env; set +a; cd apps/web && node e2e/manual/check9-grant-redemption.ts; cd ../..`
     (`--check` stops after finding the QR and prints the diagnostics without redeeming;
     `--screen` reads the QR from a screenshot of the whole screen instead.)
  2. In the "counter" window that opens: sign in with the **counter** account, open today's
     queue, **Help a visitor get their ticket back** → a waiting ticket and a reason, tick both
     boxes, **Start recovery**. In the supervisor's own browser, on the same queue page:
     **Approve**. Do this within 10 minutes.
  3. Terminal prints the QR diagnostics (counts only). Then a window opens for "visitor A".
     Observe: it shows the ticket (same code as in the counter window). Press Enter.
  4. A new window opens for "visitor B" with the same grant. Observe: the neutral "We could not
     recover a ticket…" message; no ticket opens. Press Enter.
  5. Expected database evidence: after visitor A, redeemed grants +1, staff-issued status tokens
     +1, staff-grant recovery events +1; after visitor B, no change in any count; the summary
     shows four PASS lines.
  6. Record Pass only if what you saw in steps 3 and 4 matches and the summary shows four PASS
     lines; record the counts (numbers only). The counter's panel keeps showing the QR after the
     redemption (it stops checking once the request is approved), so it is not evidence either
     way.
- Earlier retest procedure (used 2026-11-15; superseded by the revalidation above because private
  windows can share a session and no database evidence was taken):

  1. Steps as above up to "counter shows the grant QR".
  2. In Terminal (allow Screen Recording when macOS asks), capture only the QR:
     `f=/tmp/qb-grant-$$.png; screencapture -i "$f"`
  3. Open it in a new private window (the visitor's device):
     `u="$(osascript -l JavaScript /tmp/qb-qr-decode.js "$f")"; [ -n "$u" ] && open -na "Google Chrome" --args --incognito "$u" || echo "No QR code found"`
     Expected: the ticket opens; the counter's screen then says the visitor has their ticket back.
     (Correction, 2026-11-15: the counter's panel stops checking once the request is approved, so
     it does not show that message after a redemption; the QR stays on screen.)
  4. Close **every** private window (this ends that private session), then in the same Terminal
     run the command from step 3 again. Expected: the neutral "could not recover" message; no
     ticket opens.
  5. Delete the capture: `rm -f "$f"; unset u f`.
     The helper `/tmp/qb-qr-decode.js` uses macOS CoreImage only (no network) and prints nothing
     when no QR is found. If it is missing (for example after a restart), save this as
     `/tmp/qb-qr-decode.js`:

  ```js
  ObjC.import('CoreImage');
  ObjC.import('Foundation');
  function run(argv) {
    const img = $.CIImage.imageWithContentsOfURL($.NSURL.fileURLWithPath(argv[0]));
    if (!img || img.isNil()) return '';
    const det = $.CIDetector.detectorOfTypeContextOptions(
      $.CIDetectorTypeQRCode,
      $(),
      $({ CIDetectorAccuracy: $.CIDetectorAccuracyHigh }),
    );
    const found = det.featuresInImage(img);
    return found.count > 0 ? ObjC.unwrap(found.objectAtIndex(0).messageString) : '';
  }
  ```

**10. Restricted assistance (Mac)**

- Preconditions: as 9.
- Steps: repeat 9, answering "no" to the checks.
- Expected: restricted assistance only: guidance text, no QR, no credential.
- Result: **Pass — verified after correction** (manual retest 2026-11-15; the first run failed,
  see the history below).
- Actual (retest, 2026-11-15, reported by the tester: "No issues observed."): the tester completed
  the restricted-assistance scenario. With the first staff confirmation ticked and the second
  verification box left unticked, the page gave restricted-assistance guidance only. No recovery
  credential or QR was issued, no new supervisor approval request appeared, and both verification
  boxes were cleared again.
- Evidence: the tester's manual retest on 2026-11-15, using the counter staff and supervisor
  browser sessions on the Mac; the tester reported no issues. Supporting, read-only: the audit log
  contains a `ticket_recovery.restricted_assistance` event at 22:06 UTC with the second answer
  false. No grant, key, token or private link recorded.
- History:
  - First run (2026-11-15, reported by the tester): "There is no section to click no or yes, only
    start recovery and as for the supervisor to approve, it just a button which is approve only."
    The tester could not find the Yes/No verification questions required for restricted
    assistance. The visible workflow offered **Start recovery** and a supervisor approval action,
    and the tester could not carry out the "no" scenario. (No grant issuance without verification
    was reported.) Result then: **Fail — restricted-assistance scenario could not be exercised.**
    Evidence: the tester's manual test (Mac).
- Investigation (2026-11-15):
  - The verification "questions" are two checkboxes in the staff panel, not Yes/No buttons:
    "I asked the visitor before showing them any detail of the ticket" (required before **Start
    recovery** is enabled) and "They named the correct service and a join time within 10 minutes,
    and it matches the ticket". Answering "no" means leaving the second box unticked.
  - The server enforces restricted assistance on its own: with the second answer false it
    returns `restricted_assistance`, creates no grant and no approval request (so a supervisor has
    nothing to approve), and records an audit event without secrets; a missing answer is rejected
    (400), never treated as "yes". No security bypass was found.
  - The audit log of the run shows only requests sent with the second answer "yes" and no
    restricted-assistance event; the last one was waiting for approval, which is what the
    supervisor saw. Defect found: both checkboxes kept their ticks after a request and when another
    ticket was chosen, so answers given for one visitor were reused for the next (after check 9,
    the boxes were still ticked).
  - Fix (working tree, not committed): the staff panel clears both answers after every request
    and whenever the ticket changes. No server or policy change. Regression test
    `e2e/recovery-staff-restricted.spec.ts` (fails on the old panel, passes on the fix); the
    existing staff test in `e2e/recovery.spec.ts` now gives the answers again for its second
    request.
  - The investigation found no backend security bypass; the correction is frontend only.
- Retest procedure (performed by the tester on 2026-11-15; result above):
  1. Counter browser: staff console → **Help a visitor get their ticket back** → choose a waiting
     ticket and a reason.
  2. Tick only "I asked the visitor before showing them any detail of the ticket". Leave "They
     named the correct service and a join time…" **unticked** (this is the "no" answer).
  3. Press **Start recovery**. Expected: "No credential can be given…" guidance; no "Recovery
     for …" box, no QR; both boxes are unticked again.
  4. Supervisor browser: **Requests waiting for approval** shows no request for that ticket
     (wait about 10 seconds for it to refresh).

**11. Auditor cannot assist (Mac)**

- Preconditions: auditor account.
- Steps: open the staff console for the queue.
- Expected: no recovery or command actions offered (read-only).
- Actual (2026-11-16, reported by the tester): "All tests passed." The tester signed in with the
  auditor account and inspected the staff console. The auditor could see the permitted read-only
  information, but no recovery-assistance actions or queue-changing commands were offered. All
  expected restrictions held. (This check covers what the console offers; direct API requests by
  an auditor were not tested manually.)
- Result: **Pass.**
- Evidence: manual verification performed by the tester on 2026-11-16, using the auditor account
  on Mac. No credentials or private ticket information recorded.

**12. Audit trail of recovery (Mac)**

- Preconditions: after 9.
- Steps: auditor → queue → Audit trail; also supervisor → connectivity dashboard counters.
- Expected: entries name the requesting and approving staff and the reason; no key, grant or token
  text anywhere.
- Result: **Pass — verified after correction** (manual retest 2026-11-16; the first run failed,
  see the history below).
- Actual (retest, 2026-11-16, reported by the tester: "It displays all now."): the new **Recovery
  activity** section shows the required recovery audit information. The requesting staff member,
  the approving supervisor, the recovery reason and the redemption by the visitor's device are
  visible with the right attribution, in both the supervisor and the auditor views. The tester
  reported no remaining issues.
- Evidence: the tester's manual retest on 2026-11-16, using the supervisor and auditor accounts on
  the Mac. Supporting (not a substitute): the automated regression tests listed below passed
  before the manual retest. No key, grant, hash, token or private link recorded.
- Summary of the correction: recovery events were already stored correctly in `admin_events`; the
  queue Audit trail showed only queue events. The approved amendment (ADR-015 amendment 1, design
  §15.9a) added a separate read-only Recovery activity section backed by
  `GET /api/v1/queues/:id/recovery/audit`, with the existing `AUDIT_VIEW` permission. Recovery
  events remain separate from the queue's tamper-evident event chain, and no existing record was
  modified or backfilled.
- History:
  - First run (2026-11-16, reported by the tester): "It passed all except that the staff
    initiating the recovery for user and supervisor approving doesn't display in the audit trail
    for both supervisor and auditor though it displays the same information." Audit information
    appeared in the supervisor and auditor views (the same in both), but the requesting staff
    member and the approving supervisor were not identified. The tester reported that the other
    parts passed. Result then: **Fail — recovery audit attribution incomplete**, later **Fail —
    awaiting manual retest** once the correction was implemented. Evidence: the tester's manual
    test (Mac).
- Investigation (2026-11-16; read-only, metadata only; no code changed):
  - Recording is correct. Every request (`ticket_recovery.assist`) and approval
    (`ticket_recovery.approved`) event in the development database has an actor that resolves to
    a staff account; for the grant redeemed in check 9 the request event's actor is the grant's
    creator, the approval event's actor is its approver, and they are two different people. The
    reason code (`lost_device`) is stored on both. The redemption event has no staff actor, which
    is correct (the visitor's own device redeems the grant). No secret is stored in any of them.
  - Presentation is missing. By design, recovery never writes queue events (ADR-015, testing
    8.R6); its audit records are `admin_events` (design §15, rule 8). The queue **Audit trail**
    page and its API (`GET /queues/:id/audit`, design §API, M4) show only the queue's event
    chain, and no page or API shows recovery `admin_events`. What both roles saw in the Audit
    trail was queue activity, not recovery records. This check's Expected line assumed a view that
    the approved design does not specify; the gap is in the design and this guide, not a recording
    defect.
  - Historical events: all recovery events since M5 carry their actor ids, so a view added later
    would show them as recorded, without rewriting anything.
  - Proposed correction (awaiting approval; not implemented): a read-only, tenant-scoped "Recovery
    activity" section on the queue's Audit trail page, backed by a new
    `GET /api/v1/queues/:id/recovery/audit` for `OPERATIONS_VIEW` roles (supervisor, facility and
    organization admin, auditor read-only). It would list, for that queue's tickets, the recovery
    events with time, ticket code, event, requester and approver (names resolved from the stored
    actor ids at read time), reason, assurance and method, and no key, grant, token, hash or
    link. It adds an API endpoint to the approved design, so it needs approval first.
  - Decision (2026-11-16): approved by the project owner. Recorded as ADR-015 amendment 1 and
    design §15.9a before implementation. The endpoint uses the same permission as the queue audit
    view (`AUDIT_VIEW`: auditor, supervisor, facility admin; organization admins through their
    facility permission); the proposal above said `OPERATIONS_VIEW`, which was corrected to match
    the existing Audit trail page.
  - Implementation (working tree, not committed): `GET /api/v1/queues/:id/recovery/audit` and a
    "Recovery activity" section below "Events" on the Audit trail page. It reads the existing
    `ticket_recovery.*` admin events of this queue's tickets, oldest first, 50 per page. Each row
    shows time, ticket code, what happened, who did it ("Requested by …", "Approved by …", "The
    visitor's own device"), the reason, assurance and method. Names are the staff accounts' current
    names (a deactivated account is marked as such). The queue event chain is unchanged; no record
    was written, rewritten or backfilled. Regression tests: `apps/api/src/recovery-audit.db.test.ts`
    (6 of 7 fail before the endpoint existed, 7 of 7 pass after) and `e2e/recovery-audit.spec.ts`
    (both fail without the section, pass with it).
  - Expected in the development database (read-only preview, kinds only): for G001 (2026-11-16)
    four request and approval pairs from the check 9 attempts, each with a staff actor, and one
    redemption by the visitor's device with a staff grant at 11:17 UTC (12:17 in Lagos), which is
    the verified check 9 revalidation.
- Retest procedure (performed by the tester on 2026-11-16; result above):
  1. Reload the browsers (the running development servers already have the change).
  2. Supervisor: staff console → today's General Consultation queue → **Audit trail** → scroll to
     **Recovery activity**. Find the G001 rows at about 12:17 local time: "Staff recovery requested
     (needs a second person)" with "Requested by" and the **counter** staff member's name,
     "reason: Lost or broken phone"; "Request approved (second person)" with "Approved by" and the
     **supervisor's** name (a different person); "Ticket opened on the visitor's device" with "The
     visitor's own device" and "with a staff grant" (not a staff name).
  3. Auditor: sign in, open the same queue's **Audit trail**. Expected: the same Recovery activity
     rows as the supervisor saw, and no button in that section.
  4. Both: no recovery key, grant, token or link appears anywhere on the page.

**13. Temporary tickets are not recoverable yet (Mac, phase B)**

- Preconditions: counter signed in on the built app; DevTools → Network → Offline.
- Steps: **Issue walk-in ticket** while offline; read the card; open `/recover` in another window.
- Expected: the card says it is a temporary reference and recovery is not available until the
  server confirms it; the recover page has the note about temporary references; going online syncs
  and gives a real code.
- Result: **Pass — verified after environment correction** (manual retest 2026-11-16; the first
  run was blocked by a setup issue, not a product defect; see the history below).
- Actual (retest, 2026-11-16, reported by the tester: "No issues observed."): the tester completed
  the phase B retest with the built application at `http://localhost:4173` and confirmed that:
  - the counter staff device registered successfully while online;
  - offline walk-in ticket issuance worked;
  - the offline ticket showed a temporary reference, not a confirmed ticket number;
  - the page said the ticket was saved on this device only and could not be recovered yet;
  - the recover page explained that temporary references need server confirmation before
    recovery;
  - restoring connectivity synchronized the pending walk-in action;
  - the temporary reference received a real, server-confirmed ticket code;
  - no issues were observed.
- Evidence: the tester's manual retest on 2026-11-16, using Google Chrome on Mac with the built
  application on port 4173. No session cookie, device credential, recovery key or private link
  recorded.
- History:
  - First run (2026-11-16, reported by the tester): "It displays the device is not registered for
    offline use." During offline walk-in ticket issuance, QueueBridge reported that the device was
    not registered for offline use, and the tester could not verify the temporary reference, the
    recovery restriction or synchronization (those items were not tested in that run). Result
    then: **Fail — blocked by offline device registration**, root cause pending, later confirmed
    as an environment setup issue. Evidence: the tester's manual test with the phase B built
    application (`http://localhost:4173`) on Mac.
  - Correction (2026-11-16, environment only): Kiro changed the local `.env` so that
    `CORS_ORIGIN` accepts both `http://localhost:5173` and `http://localhost:4173` (no other
    setting changed), restarted the API, and checked the origins without writing data: requests
    from both origins passed the origin check, and an unlisted origin was still refused with
    `csrf-rejected`. No application code change was needed. The successful retest above followed
    this correction.
- Investigation (2026-11-16; no code changed):
  - How registration works: the staff console registers the browser as a device automatically,
    while online, the first time a staff member opens a queue of the facility. The device id is
    stored in this browser's offline storage, per user and facility and per web address (port
    5173 and port 4173 are separate). Without it, offline actions are refused with this message
    (expected protection). Offline walk-in capture does not need coordinator authority; only
    offline calling and advancing do.
  - What happened: the API log shows the built app's registration request
    (`POST /api/v1/devices`, 13:54:57 local) refused with 403 `csrf-rejected`. The API accepts
    state-changing requests only from origins in `CORS_ORIGIN`, which was `http://localhost:5173`
    only; the built app sends `Origin: http://localhost:4173`. Signing in was not needed on 4173
    because the session cookie from 5173 is shared by host, so read-only pages worked but no
    device was registered (the database shows no device created during the attempt).
  - Conclusion: setup issue, not a product defect; the Origin protection worked as designed. Phase
    B's configuration (section 1) requires adding the built app's origin and restarting the API.
    Minor follow-up noted, not changed: the message says "Reconnect once" even when the device was
    online and registration was refused.
- Setup for this check (added 2026-11-16): `CORS_ORIGIN` must include `http://localhost:4173`
  (for example `http://localhost:5173,http://localhost:4173`, so the development app keeps
  working), and the API must be restarted after the change. `WEB_BASE_URL` is not used by this
  check.
- Retest procedure (performed by the tester on 2026-11-16; result above):
  1. Online, in the phase B built app (`http://localhost:4173`): sign in as the **counter**
     account and open today's queue in the staff console; wait until it has loaded. No "not
     registered" message should appear later.
  2. Chrome DevTools → **Network** → **Offline** (in that tab; do not reload).
  3. Press **Issue walk-in ticket**. Expected: a card with a temporary reference, "Saved on this
     device only", "This is a temporary reference, not a ticket number", and "Ticket recovery is
     not available until then."
  4. Open `http://localhost:4173/recover` in another window. Expected: the note "Were you given a
     temporary reference while the desk was offline? That ticket can be recovered only after the
     server has confirmed it…".
  5. In the first tab, DevTools → **No throttling**. Expected: the pending action syncs and the
     ticket gets a confirmed ticket code in the queue list (the card's temporary reference is not
     a ticket code).

**14. Missed turn and rejoin (Mac)**

- Preconditions: admin sets the service's rejoin policy to "self resume" (Administration →
  Services); grace window default 300 s.
- Steps: call the visitor, mark missed; on the ticket page press **I am here, return me to the
  queue** within 5 minutes; repeat and wait past 5 minutes.
- Expected: inside the window: back to waiting; after it: told to join again or ask staff;
  automatic no-show stays off unless enabled.
- Result: **Pass** (2026-11-16, after the Edit policy fix below; Set 1 closes with this check).
- Actual (2026-11-16, reported by the tester): the missed-turn and rejoin scenarios work. The
  tester then looked at the automatic no-show setting, found it **on**, changed it and saved the
  policy. The tester did not report the final state of that checkbox; it is taken from the saved
  record below, not inferred.
- Evidence (read-only database check by Kiro, 2026-11-16; metadata only):
  - Policy versions of "General Consultation": v4 (16:34 UTC) set "self resume" and saved
    automatic no-show **on** (120 seconds); v5 (17:25 UTC) kept "self resume" and saved automatic
    no-show **off**. v5 is the service's current policy; the grace window stayed 300 s. Earlier
    versions (v1–v3) had no automatic no-show (off by default).
  - Inside the window: G005 was missed by staff at 16:51:54 UTC and returned to waiting at
    16:52:11 by the visitor's own request (`visitor_rejoined`, no staff actor).
  - After the window: G005 was missed again at 16:54:15; the visitor's rejoin at 17:00:03 (window
    ended 16:59:15) was refused with `grace_window_expired`: "The time to rejoin has passed.
    Please join the queue again."
  - Every miss that day was recorded by staff; there was no automatic miss, including while v4
    was in force.
- Remaining evidence: none needed for this check's criteria. Not covered here, by design:
  automatic no-show actually firing when enabled (automated tests 8.R9/8.R12; check 28 in Set 2
  covers "no automatic no-show from failed alerts").
- Preparation notes (2026-11-16, reported by the tester): as organization administrator,
  Administration → Services → **Edit policy** turned the page blank immediately, on the built app
  (port 4173) and on the development app (port 5173). The rejoin policy could not be set to "self
  resume"; neither the policy setup nor this check's scenario has been carried out.
  - Cause (Kiro, 2026-11-16; product defect in the editor, not an environment issue): the
    services in the development database were saved before M5 and their stored policies have no
    `rejoin_policy`, `auto_miss` or `staff_recovery` fields. The services API returns the stored
    policy as it is, and the editor read `policy.auto_miss.enabled` directly, which threw while
    rendering and unmounted the page. Services created through the current API store those
    fields, which is why the existing tests passed.
  - Fix (working tree, not committed): the editor reads the three M5 fields with the same
    defaults the server already applies to older policies (`recoveryPolicyOf`: staff decide,
    automatic no-show off, staff recovery on). No stored policy, default or permission changed;
    the policy is only rewritten, as a new version, when an administrator saves it. Regression
    test `e2e/policy-editor-legacy.spec.ts` recreates a pre-M5 policy in the test database; it
    fails on the old editor (the editor never appears) and passes on the fix.
  - Preparation steps (before running this check): as organization or facility administrator,
    Administration → the facility → **Services** → **Edit policy** for "General Consultation"; set
    **Visitors who missed their turn** to "Visitor may return themselves inside the grace window";
    leave everything else as it is; **Save policy** (the version number goes up by one). The new
    version applies at once, also to today's open queue: each queue decision reads the service's
    current policy under the queue lock.

### Phones on the same Wi-Fi (phase C)

**15. Scan the join QR (phone)**

- Preconditions: phase C settings; join QR shown in Administration (built from `WEB_BASE_URL`).
- Steps: scan with the phone camera.
- Expected: the join page opens on the phone; a ticket can be taken.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**16. Scan the key QR (second phone)**

- Preconditions: a ticket on phone 1 with its key panel open.
- Steps: scan the key QR with phone 2.
- Expected: the ticket opens on phone 2; the address bar shows no key after loading. (Copy and
  Share need HTTPS on phones; test them on the Mac, checks 2 and 4.)
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**17. Scan a staff grant QR (phone)**

- Preconditions: an approved grant from check 9.
- Steps: scan it with the visitor's phone.
- Expected: access granted once; a second scan fails.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

### M5.4 Web Push (desktop variant "D" in phase B; phones in phase D)

**18 / 18D. Opt in and receive a push**

- Preconditions: VAPID configured, worker running with `PUSH_TRANSPORT` unset; built app; for 18
  an Android phone on the HTTPS address, for 18D desktop Chrome on `localhost:4173`.
- Steps: join; **Get a push alert (optional)**; allow; put the page in the background (phone:
  lock the screen; desktop: switch to another window); staff call the ticket.
- Expected: the permission prompt appears only after pressing the button; "Push alert is on for
  this ticket on this device"; a notification "Your turn: <code>" appears (record the delay); the
  staff console shows "Push sent, not confirmed".
- Actual (18): — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —
- Actual (18D): — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**19 / 19D. Open the notification**

- Preconditions: after 18 / 18D.
- Steps: tap/click the notification.
- Expected: the right ticket page opens with the banner; the staff console then shows "Seen on
  device".
- Actual (19): — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —
- Actual (19D): — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**20 / 20D. Turn push off**

- Preconditions: push on.
- Steps: **Turn off push alert**; staff release and call again.
- Expected: no notification; the in-app banner still appears with the page open.
- Actual (20): — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —
- Actual (20D): — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**21 / 21D. Permission denied**

- Preconditions: a new ticket; site permission not yet granted.
- Steps: press the button and choose Block/Deny; reload.
- Expected: text explains how to allow notifications in site settings; no push button; no new
  prompt on reload; in-app alerts still work.
- Actual (21): — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —
- Actual (21D): — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**22. Two tickets with the same code (Android)**

- Preconditions: `queuebridge-demo` admin opens today's queues for "Queue 2" (`sas`) and "Lacrin"
  (`surulere-branch`) with no tickets yet.
- Steps: on one phone take the first ticket in each (both `A001`); turn push on for both; call
  both.
- Expected: two separate notifications; each opens its own ticket (check the service and facility
  names on the page).
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**23. Notification for a forgotten ticket (Android)**

- Preconditions: after 22.
- Steps: on ticket `sas`/A001 press **Forget this ticket on this device**; staff release and call
  it again; tap its notification.
- Expected: "This alert is for ticket A001. That ticket is not saved on this device"; the
  `surulere-branch` ticket is NOT opened; an **Enter your recovery key** link is offered.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**24. iPhone/iPad (iOS 16.4+), if available**

- Preconditions: HTTPS address; an iOS device.
- Steps: open in Safari (tab) → read the push panel; Share → Add to Home Screen; open the
  installed app; join; opt in; lock; call.
- Expected: in the tab the panel explains Home Screen installation; in the installed app the
  opt-in works; record exactly whether a notification arrives.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: — (if no device: `Not tested — no compatible device`)

### Delivery failure and recovery (Mac, phase B)

**25. Worker stopped (Mac)**

- Preconditions: a subscribed ticket (18D).
- Steps: stop the worker; call the ticket; serve and complete it.
- Expected: the in-app banner appears on the open page; serving and completing work; no
  notification while the worker is stopped.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**26. Stale alert after restart (Mac)**

- Preconditions: as 25 with a new call.
- Steps: keep the worker stopped for more than 2 minutes after the call; start it.
- Expected: no late notification; the connectivity dashboard "Visitor push alerts" counts it
  under Failed (time-to-live elapsed).
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**27. Broken worker push configuration (Mac)**

- Preconditions: worker terminal only: set a different (wrong) `VAPID_PRIVATE_KEY`, restart the
  worker; API unchanged.
- Steps: watch the worker log; open the connectivity dashboard after 30 s; call a ticket.
- Expected: one worker error "Web Push disabled: invalid VAPID configuration", other jobs keep
  running; the dashboard warns "Settings differ between the server and the alert worker:
  VAPID_PUBLIC_KEY"; calls and the in-app banner work. Restore the key afterwards.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**28. No automatic no-show from failed alerts (Mac)**

- Preconditions: automatic no-show off (default); a called ticket whose push failed (26 or 27).
- Steps: wait 10 minutes.
- Expected: the ticket stays "Called"; only staff can mark it missed.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

### M5.3 Device health and continuity (phase B; two browser profiles, or two real devices)

**29. Offline and stale coordinator (Mac or two devices)**

- Preconditions: profile 1 = counter ("tablet"), profile 2 = supervisor ("laptop"), both on the
  queue; supervisor assigns the tablet as coordinator; at least one waiting ticket.
- Steps: take the tablet offline (DevTools Offline, or close it); wait 2 minutes, then 15 minutes;
  watch the supervisor's connectivity dashboard.
- Expected: tablet "offline" after about 2 minutes, "stale" after 15; the "offline coordinator is
  not responding" alert with advice; nothing changes automatically.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**30. Offline actions stay local (Mac)**

- Preconditions: as 29, tablet offline but still coordinator.
- Steps: call and serve on the tablet; look at the visitor page and staff alert line.
- Expected: tablet shows "Local" / "Pending sync"; the visitor page does not show the call as
  confirmed; no push and no in-app alert until the server commits it.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**31. Explicit failover and fencing (Mac or two devices)**

- Preconditions: as 30.
- Steps: on the laptop's connectivity dashboard press **Fail over to this device**; call on the
  laptop; bring the tablet back online.
- Expected: the laptop can call; the tablet's offline actions are held as "needs review" (stale
  epoch), never applied silently; the supervisor resolves them from the conflict list; no
  duplicate alert to the visitor.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**32. Lost device (Mac or two devices)**

- Preconditions: a registered device with unsent actions (offline).
- Steps: connectivity dashboard → **Revoke** for that device, reason lost; bring it online.
- Expected: wording warns that its unsent actions may be lost; it can no longer sync; signing in
  again registers a new device.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**33. Acknowledge alerts by role (Mac)**

- Preconditions: an open alert (29).
- Steps: supervisor acknowledges; counter and auditor open the dashboard.
- Expected: "Acknowledged by <name>"; counter has no acknowledge action (and only sees its own
  device warning on the console); auditor is read-only.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

### M5.2 Accessibility (Mac)

**34. Keyboard only**

- Preconditions: phase A, mouse/trackpad untouched.
- Steps: join → ticket → **Display and alerts** → push panel → `/recover` → rejoin (14), with
  Tab/Shift-Tab/Enter/Space/Escape only; have staff call while the Display and alerts dialog is
  open.
- Expected: every control reachable in a sensible order; focus always visible and never trapped;
  the dialog returns focus to its opener; a call closes the dialog and focus stays on the page
  (the banner); Dismiss returns focus to the heading.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**35. 200 % zoom**

- Preconditions: Cmd-+ to 200 % (Safari or Chrome).
- Steps: ticket page with key panel, recover page, connectivity dashboard.
- Expected: no horizontal scrolling, nothing cut off; the 32-character key wraps.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**36. Display preferences and orientation**

- Preconditions: Display and alerts dialog; macOS Accessibility settings; a phone or tablet for
  rotation (any phase).
- Steps: high contrast, extra-large text, reduce motion, quiet mode; then macOS "Increase
  contrast" and "Reduce motion"; trigger a call; rotate a phone between portrait and landscape.
- Expected: settings apply before the page appears (no flash); nothing moves; quiet mode: no sound
  or vibration but the banner shows; rotation reflows, nothing locked.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

### Screen readers

**37. Called announcement (VoiceOver on macOS, or NVDA)**

- Preconditions: screen reader on; ticket page open.
- Steps: staff call the ticket; refresh; watch position changes before the call.
- Expected: the call is announced once and not again on refresh; position changes politely, at
  most one per 15 s.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**38. Push panel states (VoiceOver/NVDA)**

- Steps: navigate the push panel in its off, on, blocked and unsupported states.
- Expected: each state's text is read; buttons have names.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**39. Recover form (VoiceOver/NVDA)**

- Steps: submit empty, then a wrong key, then the right key.
- Expected: errors announced and linked to their fields; the failure message read; success
  announced once.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**40. Staff alert line and health panel (VoiceOver/NVDA)**

- Steps: staff console with a called, subscribed ticket; connectivity dashboard when a new
  high-priority alert opens.
- Expected: the visitor-alert line is read ("Push sent, not confirmed" …); a new high-priority
  alert announced politely; acknowledge buttons named with the alert.
- Actual: — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

**41. Phone screen readers (TalkBack on Android; VoiceOver on iOS if available)**

- Steps: repeat 37 and 39 on the phone.
- Expected: as 37 and 39.
- Actual (TalkBack): — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —
- Actual (VoiceOver iOS): — · Result: Not tested — scheduled for final acceptance (Set 2) · Evidence: —

---

## 6. Known limits while testing

- Push is best effort: no notification, a late one, or one only after unlocking must be recorded
  as observed, not counted as a queue failure.
- The system-notification and notification-click branches ran only in unit tests against the real
  file; checks 18–24 are their only real evidence.
- The visitor bundle is above the 100 kB target (REQ-F7.7); first loads on slow networks are
  slower than intended (M7).
