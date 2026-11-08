import { expect, test } from '@playwright/test';
import { PASSWORD, apiFacility, apiSignup, uid, uiLogin } from './helpers.js';

/**
 * M1 exit criterion: a brand-new organization can sign up, configure a facility with a
 * service and counter, invite staff, and have that staff member sign in — entirely through
 * the browser UI, without any database access.
 */
test('new organization configures a facility end to end and onboards a staff member', async ({
  page,
  browser,
}) => {
  const orgName = `Journey Hospital ${uid('j')}`;
  const adminEmail = `${uid('admin')}@example.test`;

  // --- Organization signup -------------------------------------------------------------
  await page.goto('/');
  await page.getByRole('link', { name: 'Create an organization' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your organization');
  await page.getByLabel('Organization name').fill(orgName);
  const orgSlug = await page.getByLabel('Organization URL identifier').inputValue();
  expect(orgSlug).toMatch(/^journey-hospital-j-[0-9a-f]{8}$/); // auto-suggested from the name
  await page.getByLabel('Your name').fill('Ada Admin');
  await page.getByLabel('Your email').fill(adminEmail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create organization' }).click();

  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Administration');
  await expect(page.getByTestId('whoami')).toContainText('Ada Admin');
  await expect(page.getByTestId('no-facilities')).toBeVisible();

  // --- Facility ------------------------------------------------------------------------
  await page.getByLabel('Facility name').fill('Central Clinic');
  await expect(page.getByLabel('Facility URL identifier')).toHaveValue('central-clinic');
  await page.getByLabel('Time zone').fill('Africa/Lagos');
  await page.getByRole('button', { name: 'Create facility' }).click();
  await expect(page.getByTestId('status')).toHaveText('Facility Central Clinic created.');
  await page.getByRole('link', { name: 'Central Clinic' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Central Clinic');
  await expect(page.getByTestId('readiness-status')).toHaveText(/Setup incomplete/);
  await expect(page.getByTestId('readiness-issues')).toContainText('Add at least one service');

  // --- Service (with a published ordering policy) --------------------------------------
  await page.getByRole('link', { name: 'Services', exact: true }).click();
  await page.getByLabel('Service name').fill('General Consultation');
  await page.getByLabel('Description (optional)').fill('Walk-in consultations');
  await page.getByLabel('Enable “urgent” class').check();
  await page.getByLabel('Grace window (seconds)').fill('240');
  await page.getByRole('button', { name: 'Add service' }).click();
  const service = page.getByTestId('service-item').filter({ hasText: 'General Consultation' });
  await expect(service.getByTestId('service-policy')).toContainText('Urgent, Normal');
  await expect(service.getByTestId('service-policy')).not.toContainText('Priority');
  await expect(service.getByTestId('service-policy')).toContainText('Grace window 240s');
  await expect(service).toContainText('Active');

  // Duplicate name → inline problem, nothing duplicated
  await page.getByLabel('Service name').fill('general consultation');
  await page.getByRole('button', { name: 'Add service' }).click();
  await expect(page.getByTestId('error-summary')).toContainText('already exists');
  await expect(page.getByTestId('service-item')).toHaveCount(1);

  // --- Counter + capability ------------------------------------------------------------
  await page.getByRole('link', { name: 'Counters', exact: true }).click();
  await page.getByLabel('Counter name').fill('Counter 1');
  await page.getByRole('button', { name: 'Add counter' }).click();
  const counter = page.getByTestId('counter-item').filter({ hasText: 'Counter 1' });
  await expect(counter).toBeVisible();
  const serves = counter.getByRole('checkbox', { name: 'General Consultation' });
  await expect(serves).not.toBeChecked();
  // A service and a counter exist, but nothing links them: NOT ready (counts alone prove nothing)
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page.getByTestId('readiness-status')).toHaveText(/Setup incomplete/);
  await expect(page.locator('[data-code="no_active_counter_serves_active_service"]')).toBeVisible();
  await page.getByRole('link', { name: 'Counters', exact: true }).click();
  await serves.check();
  await expect(page.getByTestId('status')).toHaveText('Counter 1 now serves General Consultation.');
  await page.reload();
  await expect(
    page.getByTestId('counter-item').getByRole('checkbox', { name: 'General Consultation' }),
  ).toBeChecked(); // persisted server-side

  // --- Join link and QR ----------------------------------------------------------------
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page.getByTestId('readiness-status')).toHaveText(/Configuration ready/);
  await expect(page.getByTestId('readiness-service')).toContainText('Served by 1 active counter');
  await expect(page.getByTestId('readiness-counter')).toContainText('Serving 1 active service');
  // Even when configuration is ready, the join link is not live until visitor registration exists
  await expect(page.getByTestId('join-notice')).toContainText('Not live yet');
  await expect(page.getByTestId('join-notice')).toContainText('Do not share');
  const joinUrl = await page.getByTestId('join-url').innerText();
  expect(joinUrl).toBe(`http://localhost:4173/join/${orgSlug}/central-clinic`);
  await expect(page.getByTestId('join-qr')).toBeVisible();
  await expect(page.getByTestId('join-qr')).toHaveAttribute('aria-label', new RegExp(joinUrl));
  const download = page.getByRole('link', { name: 'Download QR (SVG)' });
  expect(await download.getAttribute('href')).toContain('data:image/svg+xml');
  // The link resolves to the real visitor join page (M2); no queue is open yet, and it says so
  await page.goto(new URL(joinUrl).pathname);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Central Clinic');
  await expect(page.getByTestId('no-open-queues')).toBeVisible();

  // --- Staff invitation ----------------------------------------------------------------
  await page.goBack();
  await page.getByRole('link', { name: 'Staff', exact: true }).click();
  await page.getByLabel('Email address').fill('counter.operator@example.test');
  await page.getByLabel('Role').selectOption('staff_counter');
  await page.getByRole('button', { name: 'Create invitation' }).click();
  const result = page.getByTestId('invite-result');
  await expect(result).toContainText('Email delivery is not configured');
  const inviteLink = await page.getByTestId('invite-link').innerText();
  expect(inviteLink).toMatch(/^http:\/\/localhost:4173\/accept-invite#token=[A-Za-z0-9_-]{43}$/);
  await expect(page.getByTestId('pending-invitations')).toContainText(
    'counter.operator@example.test',
  );
  await expect(page.getByTestId('active-staff')).not.toContainText('counter.operator@example.test');

  // --- Invitee accepts in a separate, signed-out browser context -----------------------
  const inviteeCtx = await browser.newContext({ serviceWorkers: 'block' });
  const invitee = await inviteeCtx.newPage();
  await invitee.goto(inviteLink);
  await expect(invitee.getByRole('heading', { level: 1 })).toContainText(`Join ${orgName}`);
  await expect(invitee.getByText('Counter operator')).toBeVisible();
  await expect(invitee.getByText('counter.operator@example.test')).toBeVisible();
  await invitee.getByLabel('Your name').fill('Chidi Operator');
  await invitee.getByLabel('Password').fill(PASSWORD);
  await invitee.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(invitee).toHaveURL(/\/admin$/);
  expect(invitee.url()).not.toContain('token'); // secret scrubbed from the address bar
  await expect(invitee.getByTestId('whoami')).toContainText('Chidi Operator');

  // Least privilege in the UI …
  await invitee.getByRole('link', { name: 'Central Clinic' }).click();
  await expect(invitee.getByTestId('read-only-note')).toBeVisible();
  await expect(invitee.getByRole('link', { name: 'Staff', exact: true })).toHaveCount(0);
  await invitee.getByRole('link', { name: 'Services', exact: true }).click();
  await expect(invitee.getByRole('button', { name: 'Add service' })).toHaveCount(0);
  await expect(invitee.getByTestId('service-item')).toHaveCount(1);
  // … and, independently of the UI, on the server:
  const forged = await invitee.request.post(
    `/api/v1/facilities/${new URL(invitee.url()).pathname.split('/')[3]}/services`,
    { headers: { 'X-QB-CSRF': '1' }, data: { name: 'Forged by operator' } },
  );
  expect(forged.status()).toBe(403);

  // --- Invite link is single-use -------------------------------------------------------
  const reuseCtx = await browser.newContext({ serviceWorkers: 'block' });
  const reuse = await reuseCtx.newPage();
  await reuse.goto(inviteLink);
  await expect(reuse.getByRole('heading', { level: 1 })).toHaveText('Invitation unavailable');
  await reuseCtx.close();

  // --- Sign out / sign in as the new staff member --------------------------------------
  await invitee.getByRole('button', { name: 'Sign out' }).click();
  await expect(invitee).toHaveURL(/\/$/);
  await uiLogin(invitee, orgSlug, 'counter.operator@example.test');
  await expect(invitee).toHaveURL(/\/admin$/);
  await expect(invitee.getByTestId('whoami')).toContainText('Chidi Operator');
  await inviteeCtx.close();

  // --- Admin sees the member and manages roles -----------------------------------------
  await page.getByRole('link', { name: 'Staff', exact: true }).click();
  await page.reload();
  const member = page.getByTestId('staff-item').filter({ hasText: 'Chidi Operator' });
  await expect(member).toContainText('Counter operator');
  // Accepted invitation left "Pending" and is now an active staff member
  await expect(page.getByTestId('no-pending')).toBeVisible();
  await expect(page.getByTestId('active-staff')).toContainText('Chidi Operator');
  await expect(page.getByTestId('invitation-history')).toContainText('accepted');
  await member.getByLabel('Add role').selectOption('supervisor');
  await member.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(member.getByRole('list', { name: /Roles for/ })).toContainText('Supervisor');
  await member.getByRole('button', { name: 'Remove Supervisor from Chidi Operator' }).click();
  await expect(member.getByRole('list', { name: /Roles for/ })).not.toContainText('Supervisor');
});

test('staff role revocation takes effect for an already signed-in user', async ({
  page,
  browser,
}) => {
  await apiSignup(page.request);
  const facility = await apiFacility(page.request);
  // Invite via API, accept in another context
  const inv = await page.request.post(`/api/v1/facilities/${facility.id}/invitations`, {
    headers: { 'X-QB-CSRF': '1' },
    data: { email: 'revoked.person@example.test', role: 'supervisor' },
  });
  const { accept_url } = (await inv.json()) as { accept_url: string };

  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const staffPage = await ctx.newPage();
  await staffPage.goto(accept_url);
  await staffPage.getByLabel('Your name').fill('Soon Revoked');
  await staffPage.getByLabel('Password').fill(PASSWORD);
  await staffPage.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(staffPage.getByRole('link', { name: 'Main Clinic' })).toBeVisible();

  // Admin removes the only role of that user
  await page.goto(`/admin/facilities/${facility.id}/staff`);
  const member = page.getByTestId('staff-item').filter({ hasText: 'Soon Revoked' });
  await member.getByRole('button', { name: 'Remove Supervisor from Soon Revoked' }).click();
  await expect(page.getByTestId('status')).toContainText('removed from Soon Revoked');

  // The still-signed-in user immediately loses access (server enforces; no stale session role)
  await staffPage.reload();
  await expect(staffPage.getByRole('link', { name: 'Main Clinic' })).toHaveCount(0);
  await staffPage.goto(`/admin/facilities/${facility.id}`);
  await expect(staffPage.getByRole('heading', { level: 1 })).toHaveText('Facility not found');
  await ctx.close();
});
