/**
 * LOCAL-ONLY manual acceptance helper for check 9 (one-time staff recovery grant). Not a test,
 * not used by CI, never run against anything but the local development stack.
 *
 * Default mode (no screen capture, no macOS permission):
 *  1. opens a "counter" browser window controlled by the helper; the tester signs in there as the
 *     COUNTER account and makes the recovery request in the normal staff console, and the
 *     supervisor approves it in their own browser, as usual;
 *  2. when the one-time QR appears in that window, the helper photographs only the QR element
 *     (an element screenshot taken by the browser) into a private temporary folder, decodes it
 *     there with macOS CoreImage (offline) and deletes the image at once; the link stays in memory;
 *  3. opens the link in a FRESH, isolated browser context (no cookies, no storage, no saved
 *     ticket) through the normal `/recover#g=` page and API: the real redemption flow;
 *  4. opens the same link in a SECOND fresh context;
 *  5. reads counts from the database (read-only session) before and after each attempt.
 *
 * `--screen`: instead of step 1–2, read the QR from a screenshot of the whole Mac screen (the QR
 * must be visible, not covered by Terminal; needs Screen Recording permission for the app that
 * runs the command, which takes effect only after that app is restarted).
 * `--check`: stop after finding the QR and print the diagnostics; nothing is redeemed.
 *
 * Output: counts, the public ticket code and pass/fail lines only. Never the grant, the link, a
 * status token or any database value other than counts.
 *
 * Usage (repository root):
 *   set -a; . ./.env; set +a; cd apps/web && node e2e/manual/check9-grant-redemption.ts; cd ../..
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from '@playwright/test';

const run = promisify(execFile);
/** Terminal output (a command-line helper, not app code): counts and pass/fail lines only. */
const say = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const sayErr = (s: string): void => {
  process.stderr.write(`${s}\n`);
};
const ORIGIN = process.env['QB_WEB_ORIGIN'] ?? 'http://localhost:5173';
/** The shape of a staff grant link: `<origin>/recover#g=<32 characters>` */
const GRANT_LINK = /^(https?:\/\/[^/#?]+)\/recover#g=[0-9A-Z]{32}$/;
const QR_SELECTOR = '[data-testid="staff-recovery-qr"] svg';

/**
 * Decodes every QR in the given images with CoreImage (offline). Returns, per image, how many QR
 * symbols were detected and the payloads that decoded; and whether this process may capture the
 * screen. The payloads are returned to the caller only, never printed.
 */
const DECODE_JXA = `ObjC.import('CoreImage');
ObjC.import('Foundation');
ObjC.import('CoreGraphics');
function run(argv) {
  let permission = null;
  try {
    ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
    permission = $.CGPreflightScreenCaptureAccess();
  } catch (e) {}
  const images = [];
  for (const path of argv) {
    const img = $.CIImage.imageWithContentsOfURL($.NSURL.fileURLWithPath(path));
    if (!img || img.isNil()) { images.push({ readable: false, detected: 0, payloads: [] }); continue; }
    const det = $.CIDetector.detectorOfTypeContextOptions(
      $.CIDetectorTypeQRCode, $(), $({ CIDetectorAccuracy: $.CIDetectorAccuracyHigh }));
    const found = det.featuresInImage(img);
    const payloads = [];
    for (let i = 0; i < found.count; i++) {
      const m = found.objectAtIndex(i).messageString;
      if (m && !m.isNil()) payloads.push(ObjC.unwrap(m));
    }
    images.push({ readable: true, detected: Number(found.count), payloads });
  }
  return JSON.stringify({ permission, images });
}`;

/** Safe diagnostics: counts and yes/no only. */
export interface QrDiagnostics {
  source: 'counter window' | 'screen';
  captured: boolean;
  /** CoreGraphics' answer for the app running the command (screen mode only) */
  screenPermission: boolean | null;
  images: number;
  detected: number;
  decoded: number;
  /** decoded payloads with the shape of a staff grant link */
  grantShaped: number;
  /** of those, links for this web origin */
  matching: number;
}
export interface QrResult {
  diagnostics: QrDiagnostics;
  /** the grant links found (in memory only; never print) */
  links: string[];
}

async function decodeImages(
  dir: string,
  files: string[],
  source: QrDiagnostics['source'],
  origin: string,
): Promise<QrResult> {
  const jxa = join(dir, 'decode.js');
  await writeFile(jxa, DECODE_JXA, { mode: 0o600 });
  const present = files.filter((f) => existsSync(f));
  const { stdout } = await run('osascript', ['-l', 'JavaScript', jxa, ...present]);
  const r = JSON.parse(stdout.trim() || '{}') as {
    permission: boolean | null;
    images: { readable: boolean; detected: number; payloads: string[] }[];
  };
  const payloads = r.images.flatMap((i) => i.payloads);
  const shaped = payloads.filter((p) => GRANT_LINK.test(p));
  const links = [...new Set(shaped.filter((p) => GRANT_LINK.exec(p)?.[1] === origin))];
  return {
    diagnostics: {
      source,
      captured: present.length > 0 && r.images.some((i) => i.readable),
      screenPermission: source === 'screen' ? r.permission : null,
      images: present.length,
      detected: r.images.reduce((n, i) => n + i.detected, 0),
      decoded: payloads.length,
      grantShaped: shaped.length,
      matching: links.length,
    },
    links,
  };
}

/** The approved grant QR from a staff-console page (element screenshot; nothing on screen). */
export async function grantFromPage(page: Page, dir: string, origin: string): Promise<QrResult> {
  const file = join(dir, 'qr.png');
  try {
    await page.locator(QR_SELECTOR).screenshot({ path: file });
    return await decodeImages(dir, [file], 'counter window', origin);
  } finally {
    await rm(file, { force: true });
  }
}

/** The approved grant QR from a screenshot of the whole screen (fallback). */
export async function grantFromScreen(dir: string, origin: string): Promise<QrResult> {
  const shots = [1, 2, 3].map((n) => join(dir, `screen-${n}.png`));
  try {
    try {
      await run('screencapture', ['-x', '-t', 'png', ...shots]);
    } catch {
      return {
        diagnostics: {
          source: 'screen',
          captured: false,
          screenPermission: null,
          images: 0,
          detected: 0,
          decoded: 0,
          grantShaped: 0,
          matching: 0,
        },
        links: [],
      };
    }
    return await decodeImages(dir, shots, 'screen', origin);
  } finally {
    await Promise.all(shots.map((s) => rm(s, { force: true })));
  }
}

export function describe(
  d: QrDiagnostics,
  usableGrants: number | null,
  origin: string = ORIGIN,
): string[] {
  const yn = (b: boolean | null): string => (b === null ? 'unknown' : b ? 'yes' : 'no');
  const lines = [
    `  source: ${d.source}`,
    `  image captured: ${yn(d.captured)}${d.source === 'screen' ? ` (${d.images} display image(s))` : ''}`,
  ];
  if (d.source === 'screen') lines.push(`  screen recording permission: ${yn(d.screenPermission)}`);
  lines.push(
    `  QR symbols detected: ${d.detected}`,
    `  QR symbols decoded: ${d.decoded}`,
    `  decoded values shaped like a staff grant link: ${d.grantShaped}`,
    `  of those, for ${origin}: ${d.matching}`,
  );
  if (usableGrants !== null) {
    lines.push(
      `  approved grants still usable in the database (not expired, not redeemed): ${usableGrants}`,
    );
  }
  const usable = d.matching === 1 && (usableGrants ?? 1) > 0;
  lines.push(`  a usable grant QR was found: ${usable ? 'yes' : 'no'}`);
  if (!usable) {
    const hint =
      d.source === 'screen' && !d.captured
        ? 'The screen could not be captured: allow the app running this command under System Settings → Privacy & Security → Screen Recording, quit and reopen that app, then run again.'
        : d.source === 'screen' && d.screenPermission === false
          ? 'Screen Recording is not allowed for the app running this command, so only the desktop is captured. Allow it, quit and reopen the app, or run without --screen.'
          : d.detected === 0
            ? d.source === 'screen'
              ? 'No QR code is visible on the screen: the browser with the QR may be covered (for example by Terminal) or on another Space. Run without --screen instead.'
              : 'No QR code was found in the counter window.'
            : d.grantShaped === 0
              ? 'A QR code was found but it is not a staff grant QR (for example a join or recovery-key QR).'
              : d.matching === 0
                ? `The grant QR is for a different web address than ${origin}. Open the staff console at ${origin}, or set QB_WEB_ORIGIN.`
                : d.matching > 1
                  ? 'More than one grant QR was found. Leave only one.'
                  : 'The grant has expired or was already used: make a new request and approval.';
    lines.push(`  next step: ${hint}`);
  }
  return lines;
}

interface Counts {
  redeemedGrants: number;
  staffTokens: number;
  staffGrantEvents: number;
  usableGrants: number;
}

/** Connection settings from DATABASE_URL as libpq environment variables (no secret in argv). */
function pgEnv(): NodeJS.ProcessEnv {
  const raw = process.env['DATABASE_URL'];
  if (!raw) throw new Error('DATABASE_URL is not set. Run: set -a; . ./.env; set +a');
  const u = new URL(raw);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, ''),
    // the session cannot write, whatever the query says
    PGOPTIONS: '-c default_transaction_read_only=on',
  };
}

async function counts(): Promise<Counts> {
  const sql =
    "SELECT (SELECT COUNT(*) FROM ticket_recovery_grants WHERE redeemed_at IS NOT NULL) || ',' || " +
    "(SELECT COUNT(*) FROM ticket_recovery_credentials WHERE source = 'staff') || ',' || " +
    "(SELECT COUNT(*) FROM admin_events WHERE event_type = 'ticket_recovery.recovered' AND details->>'method' = 'staff_grant') || ',' || " +
    '(SELECT COUNT(*) FROM ticket_recovery_grants WHERE approved_at IS NOT NULL AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW())';
  const { stdout } = await run('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    env: pgEnv(),
  });
  const n = stdout.trim().split(',').map(Number);
  if (n.length !== 4 || !n.every((x) => Number.isInteger(x))) {
    throw new Error('unexpected count output');
  }
  return {
    redeemedGrants: n[0] ?? 0,
    staffTokens: n[1] ?? 0,
    staffGrantEvents: n[2] ?? 0,
    usableGrants: n[3] ?? 0,
  };
}

const show = (c: Counts): string =>
  `redeemed grants ${c.redeemedGrants}, staff-issued status tokens ${c.staffTokens}, staff-grant recovery events ${c.staffGrantEvents}`;
const delta = (a: Counts, b: Counts): [number, number, number] => [
  b.redeemedGrants - a.redeemedGrants,
  b.staffTokens - a.staffTokens,
  b.staffGrantEvents - a.staffGrantEvents,
];

type Outcome = { kind: 'ticket'; code: string } | { kind: 'refused' } | { kind: 'unclear' };

/** Opens the link in a brand-new isolated context and reports what the visitor's page shows. */
async function redeemInFreshContext(
  browser: Browser,
  link: string,
  label: string,
  ask: (q: string) => Promise<void>,
): Promise<Outcome> {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: null });
  try {
    const stored = await ctx.storageState();
    if (stored.cookies.length > 0 || stored.origins.length > 0) {
      throw new Error('the new browser context is not empty');
    }
    const page = await ctx.newPage();
    try {
      await page.goto(link);
    } catch {
      // Playwright's own message would contain the address: never print it
      throw new Error(`${label}: the page could not be opened (is the web server on ${ORIGIN}?)`);
    }
    const ticket = page.getByTestId('ticket-code');
    const refused = page.getByTestId('recover-error');
    try {
      await ticket.or(refused).first().waitFor({ timeout: 15_000 });
    } catch {
      return { kind: 'unclear' };
    }
    const outcome: Outcome = (await ticket.isVisible())
      ? { kind: 'ticket', code: (await ticket.innerText()).trim() }
      : { kind: 'refused' };
    const addressClean = !new URL(page.url()).hash.includes('g=');
    say(`  address bar no longer holds the grant: ${addressClean ? 'yes' : 'NO'}`);
    await ask(`  Look at the "${label}" window now, then press Enter to continue… `);
    return outcome;
  } finally {
    await ctx.close();
  }
}

/** The counter window: the tester signs in and makes the request there; wait for the QR. */
async function grantFromCounterWindow(browser: Browser, dir: string): Promise<QrResult> {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: null });
  try {
    const page = await ctx.newPage();
    try {
      await page.goto(`${ORIGIN}/login`);
    } catch {
      throw new Error(`the counter window could not open ${ORIGIN} (is the web server running?)`);
    }
    say('\nA "counter" browser window has opened. In THAT window:');
    say("  1. sign in with the COUNTER account and open today's queue in the staff console;");
    say('  2. Help a visitor get their ticket back: choose a waiting ticket and a reason,');
    say('     tick both boxes, press Start recovery;');
    say('  3. ask the supervisor to approve it in their own browser (same queue page).');
    say('Waiting for the one-time QR to appear in the counter window (up to 20 minutes)…');
    await page.locator(QR_SELECTOR).waitFor({ state: 'visible', timeout: 20 * 60_000 });
    return await grantFromPage(page, dir, ORIGIN);
  } finally {
    await ctx.close();
  }
}

async function main(): Promise<number> {
  const checkOnly = process.argv.includes('--check');
  const screen = process.argv.includes('--screen');
  const dir = await mkdtemp(join(tmpdir(), 'qb-check9-'));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string): Promise<void> => {
    await rl.question(q);
  };
  let browser: Browser | null = null;
  try {
    const before = await counts();
    say(`Database (read-only) before: ${show(before)}`);
    say(`  approved grants still usable now: ${before.usableGrants}`);
    browser = screen ? null : await chromium.launch({ headless: false });
    const found = screen
      ? await grantFromScreen(dir, ORIGIN)
      : await grantFromCounterWindow(browser as Browser, dir);
    const usable = (await counts()).usableGrants;
    say('\nQR diagnostics (counts only):');
    for (const line of describe(found.diagnostics, usable)) say(line);
    if (found.links.length !== 1 || usable === 0) return 2;
    if (checkOnly) {
      say('\n--check: nothing was redeemed. Run again without --check to redeem.');
      return 0;
    }
    const link = found.links[0] ?? '';

    browser ??= await chromium.launch({ headless: false });
    say('\nFirst redemption, in a new empty browser context ("visitor A"):');
    const first = await redeemInFreshContext(browser, link, 'visitor A', ask);
    const afterFirst = await counts();
    const d1 = delta(before, afterFirst);
    say(
      `  page shows: ${first.kind === 'ticket' ? `ticket ${first.code}` : first.kind === 'refused' ? 'the "could not recover" message' : 'neither (timed out)'}`,
    );
    say(`  database after: ${show(afterFirst)} (change ${d1.join(' / ')})`);

    say('\nSecond redemption of the same grant, in another new empty context ("visitor B"):');
    const second = await redeemInFreshContext(browser, link, 'visitor B', ask);
    const afterSecond = await counts();
    const d2 = delta(afterFirst, afterSecond);
    say(
      `  page shows: ${second.kind === 'ticket' ? `ticket ${second.code}` : second.kind === 'refused' ? 'the "could not recover" message' : 'neither (timed out)'}`,
    );
    say(`  database after: ${show(afterSecond)} (change ${d2.join(' / ')})`);

    const checks: [string, boolean][] = [
      ['first redemption opened a ticket', first.kind === 'ticket'],
      [
        'first redemption: +1 redeemed grant, +1 staff token, +1 staff-grant event',
        d1.every((n) => n === 1),
      ],
      ['second redemption was refused', second.kind === 'refused'],
      ['second redemption: no change in any count', d2.every((n) => n === 0)],
    ];
    say('\nSummary:');
    for (const [name, ok] of checks) say(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    say(
      'These are supporting observations; record the manual check from what you saw in the windows.',
    );
    return checks.every(([, ok]) => ok) ? 0 : 1;
  } catch (e) {
    sayErr(`Stopped: ${e instanceof Error ? e.message.split('\n')[0] : 'unexpected error'}`);
    return 1;
  } finally {
    rl.close();
    await browser?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// Run only when executed directly (the functions above are also used by a verification test)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
