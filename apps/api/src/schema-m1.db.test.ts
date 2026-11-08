import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFacility,
  createTestApp,
  signupOrg,
  type TestApp,
  type TestOrg,
} from './testing/harness.js';
import { migrationFiles, readMigration, withIsolatedDatabase } from './testing/isolated-db.js';

/** Database contract checks for migration 0003 (runs against a real PostgreSQL). */

let t: TestApp;
let org: TestOrg;
let facilityId: string;
const RUN = Math.random().toString(36).slice(2);
const H1 = `schema-h1-${RUN}`;
const H2 = `schema-h2-${RUN}`;
const H3 = `schema-h3-${RUN}`;

beforeAll(async () => {
  t = await createTestApp();
  org = await signupOrg(t.app);
  facilityId = (await createFacility(org)).id;
});
afterAll(async () => {
  await t.close();
});

describe('migration 0003', () => {
  it('is idempotent: re-applying the file twice succeeds and preserves data', async () => {
    // Runs in a throwaway database: re-executing DDL on the shared test DB while other test
    // files are mid-transaction caused lock deadlocks (observed in the M2 test run).
    await withIsolatedDatabase(async (sql) => {
      for (const f of await migrationFiles()) await sql.unsafe(await readMigration(f));
      const orgRows = await sql<{ id: string }[]>`
        INSERT INTO organizations (name, slug) VALUES ('Iso', 'iso-org') RETURNING id`;
      const orgId = orgRows[0]!.id;
      const userRows = await sql<{ id: string }[]>`
        INSERT INTO staff_users (organization_id, email, password_hash, display_name)
        VALUES (${orgId}, 'iso@example.test', 'x', 'Iso') RETURNING id`;
      await sql`INSERT INTO role_assignments (staff_user_id, organization_id, facility_id, role)
                VALUES (${userRows[0]!.id}, ${orgId}, NULL, 'org_admin')`;
      const sqlText = await readMigration('0003_tenancy_roles_invitations.sql');
      await sql.unsafe(sqlText);
      await sql.unsafe(sqlText);
      const roles =
        await sql`SELECT 1 FROM role_assignments WHERE staff_user_id = ${userRows[0]!.id}`;
      expect(roles).toHaveLength(1);
    });
  });

  it('is recorded by the migration runner after earlier migrations', async () => {
    const rows = await t.db<
      { filename: string }[]
    >`SELECT filename FROM _migrations ORDER BY filename`;
    const names = rows.map((r) => r.filename);
    expect(names.slice(0, 3)).toEqual([
      '0001_initial_schema.sql',
      '0002_append_only_trigger.sql',
      '0003_tenancy_roles_invitations.sql',
    ]);
  });
});

describe('role_assignments scope rules', () => {
  it('org_admin must not carry a facility; every other role must', async () => {
    await expect(
      t.db`INSERT INTO role_assignments (staff_user_id, organization_id, facility_id, role)
           VALUES (${org.adminId}, ${org.organizationId}, ${facilityId}, 'org_admin')`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      t.db`INSERT INTO role_assignments (staff_user_id, organization_id, facility_id, role)
           VALUES (${org.adminId}, ${org.organizationId}, NULL, 'supervisor')`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('an organization-wide role cannot be duplicated for one user', async () => {
    await expect(
      t.db`INSERT INTO role_assignments (staff_user_id, organization_id, facility_id, role)
           VALUES (${org.adminId}, ${org.organizationId}, NULL, 'org_admin')`,
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('fills organization_id from the facility when omitted (legacy inserts keep working)', async () => {
    const rows = await t.db<{ organization_id: string }[]>`
      INSERT INTO role_assignments (staff_user_id, facility_id, role)
      VALUES (${org.adminId}, ${facilityId}, 'auditor')
      RETURNING organization_id`;
    expect(rows[0]?.organization_id).toBe(org.organizationId);
  });
});

describe('admin_events is append-only', () => {
  it('rejects UPDATE and DELETE at the database level', async () => {
    const [ev] = await t.db<{ id: string }[]>`
      SELECT id FROM admin_events WHERE organization_id = ${org.organizationId} LIMIT 1`;
    expect(ev).toBeDefined();
    await expect(
      t.db`UPDATE admin_events SET event_type = 'tampered' WHERE id = ${ev?.id ?? ''}`,
    ).rejects.toThrow(/append-only/);
    await expect(t.db`DELETE FROM admin_events WHERE id = ${ev?.id ?? ''}`).rejects.toThrow(
      /append-only/,
    );
    const [still] = await t.db<{ event_type: string }[]>`
      SELECT event_type FROM admin_events WHERE id = ${ev?.id ?? ''}`;
    expect(still?.event_type).not.toBe('tampered');
  });
});

describe('staff_invitations constraints', () => {
  it('allows only facility-scope roles and one open invitation per facility/email/role', async () => {
    await expect(
      t.db`INSERT INTO staff_invitations (organization_id, facility_id, email, role, token_hash, expires_at)
           VALUES (${org.organizationId}, ${facilityId}, 'a@example.test', 'org_admin', ${H1}, NOW() + INTERVAL '1 day')`,
    ).rejects.toMatchObject({ code: '23514' });

    await t.db`INSERT INTO staff_invitations (organization_id, facility_id, email, role, token_hash, expires_at)
               VALUES (${org.organizationId}, ${facilityId}, 'Dup@example.test', 'auditor', ${H2}, NOW() + INTERVAL '1 day')`;
    await expect(
      t.db`INSERT INTO staff_invitations (organization_id, facility_id, email, role, token_hash, expires_at)
           VALUES (${org.organizationId}, ${facilityId}, 'dup@example.test', 'auditor', ${H3}, NOW() + INTERVAL '1 day')`,
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('token hashes are globally unique', async () => {
    await expect(
      t.db`INSERT INTO staff_invitations (organization_id, facility_id, email, role, token_hash, expires_at)
           VALUES (${org.organizationId}, ${facilityId}, 'other@example.test', 'auditor', ${H2}, NOW() + INTERVAL '1 day')`,
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('M0 invariants still hold alongside M1', () => {
  it('queue_events remains append-only (trigger from 0002 intact)', async () => {
    const triggers = await t.db<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger WHERE tgrelid = 'queue_events'::regclass AND NOT tgisinternal`;
    expect(triggers.map((r) => r.tgname)).toContain('queue_events_append_only');
  });

  it('concurrent creation of the same org slug yields exactly one organization', async () => {
    const slug = `race-${Date.now()}`;
    const payload = (i: number): object => ({
      organization_name: 'Race Org',
      organization_slug: slug,
      admin_display_name: 'Racer',
      admin_email: `racer${i}@${slug}.test`,
      admin_password: 'correct-horse-battery-1',
    });
    const { TestClient } = await import('./testing/harness.js');
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => new TestClient(t.app).post('/api/v1/organizations', payload(i))),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await t.db`SELECT 1 FROM organizations WHERE slug = ${slug}`).toHaveLength(1);
    // losers rolled back completely — no orphan staff users
    expect(
      await t.db`SELECT 1 FROM staff_users WHERE email LIKE ${`racer%@${slug}.test`}`,
    ).toHaveLength(1);
  });
});
