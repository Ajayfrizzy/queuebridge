import postgres from 'postgres';
import { expect, test } from '@playwright/test';
import { apiQueueSetup } from './helpers.js';

/**
 * Manual check 14 preparation (2026-11-16): Administration → Services → **Edit policy** turned the
 * page blank on both 5173 and 4173. Cause: services saved before M5 have a stored policy without
 * the M5.1 fields (`rejoin_policy`, `auto_miss`, `staff_recovery`); the services API returns the
 * stored policy as it is, and the editor read `policy.auto_miss.enabled`, which threw while
 * rendering and unmounted the page.
 *
 * The test recreates that stored shape in the disposable TEST database (it removes the three M5
 * keys from one test service's policy, exactly like a service created before M5), then drives the
 * real page.
 */

test('Edit policy opens for a service saved before M5, shows the current values with the M5 defaults, and saves Self resume without changing anything else', async ({
  page,
}) => {
  const dbUrl = process.env['TEST_DATABASE_URL'];
  expect(dbUrl, 'TEST_DATABASE_URL is required to recreate a pre-M5 policy').toBeTruthy();
  const s = await apiQueueSetup(page.request, { open: false });
  // A pre-M5 policy, with values that differ from the defaults so they are visibly kept
  const sql = postgres(dbUrl ?? '', { max: 1, onnotice: () => undefined });
  try {
    await sql`
      UPDATE services
         SET policy = (policy - 'rejoin_policy' - 'auto_miss' - 'staff_recovery')
                      || jsonb_build_object('grace_window_seconds', 240,
                                            'transfer_placement', 'end_of_queue')
       WHERE id = ${s.serviceId}`;
  } finally {
    await sql.end();
  }

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`/admin/facilities/${s.facility.id}/services`);
  const svc = page.getByTestId('service-item').filter({ hasText: 'General Consultation' });
  await expect(svc.getByTestId('policy-version')).toHaveText('Policy v1');
  await svc.getByText('Edit policy').click();

  const editor = svc.getByTestId('policy-editor');
  await expect(editor).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); // the page is not blank
  // the current (stored) values
  await expect(editor.getByLabel('Grace window (seconds)')).toHaveValue('240');
  await expect(editor.getByLabel('Transferred visitors')).toHaveValue('end_of_queue');
  // the M5 fields the stored policy does not have show their defaults
  const rejoin = editor.getByLabel('Visitors who missed their turn');
  await expect(rejoin).toHaveValue('staff_resume');
  await expect(
    editor.getByLabel('Automatically mark an unanswered call as missed (off by default)'),
  ).not.toBeChecked();
  await expect(editor.getByLabel('Seconds before an unanswered call is marked missed')).toHaveValue(
    '',
  );
  await expect(editor.getByLabel(/Allow staff-assisted ticket recovery/)).toBeChecked();

  // Self resume, and nothing else
  await rejoin.selectOption('self_resume');
  await editor.getByRole('button', { name: 'Save policy' }).click();
  await expect(svc.getByTestId('policy-version')).toHaveText('Policy v2');

  const res = await page.request.get(`/api/v1/facilities/${s.facility.id}/services`);
  const saved = (
    (await res.json()) as { services: { id: string; policy: Record<string, unknown> }[] }
  ).services.find((x) => x.id === s.serviceId)?.policy;
  expect(saved).toMatchObject({
    version: 'v2',
    rejoin_policy: 'self_resume',
    grace_window_seconds: 240,
    transfer_placement: 'end_of_queue',
    auto_miss: { enabled: false },
    staff_recovery: true,
  });
  expect(errors, 'no uncaught exception on the page').toEqual([]);
});
