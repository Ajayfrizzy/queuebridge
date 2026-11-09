import { describe, expect, it } from 'vitest';
import { migrationFiles, readMigration, withIsolatedDatabase } from './testing/isolated-db.js';

/** Database contract checks for migration 0005 (M3 continuity engine), in a throwaway database. */
describe('migration 0005_continuity_engine', () => {
  it('applies on a fresh database and every migration re-applies cleanly (idempotent)', async () => {
    await withIsolatedDatabase(async (sql) => {
      const files = await migrationFiles();
      expect(files).toContain('0005_continuity_engine.sql');
      for (const f of files) await sql.unsafe(await readMigration(f));
      for (const f of files) await sql.unsafe(await readMigration(f));
      await sql.unsafe(await readMigration('0005_continuity_engine.sql'));

      const constraints = (await sql<{ conname: string }[]>`SELECT conname FROM pg_constraint`).map(
        (r) => r.conname,
      );
      for (const c of [
        'devices_pending_nonneg_chk',
        'devices_facility_org_fk',
        'queue_sessions_coordinator_expiry_chk',
        'client_operations_resolution_chk',
        'client_operations_resolution_complete_chk',
      ]) {
        expect(constraints, c).toContain(c);
      }
      const indexes = (
        await sql<
          { indexname: string }[]
        >`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
      ).map((r) => r.indexname);
      for (const i of [
        'client_operations_open_review_idx',
        'client_operations_temp_ref_idx',
        'client_operations_org_op_idx',
        'queue_events_session_seq_idx',
      ]) {
        expect(indexes, i).toContain(i);
      }
      // append-only protection of the audit log is untouched by 0005
      expect(
        await sql`SELECT 1 FROM pg_trigger WHERE tgname = 'queue_events_append_only'`,
      ).toHaveLength(1);
      expect(
        await sql`SELECT 1 FROM pg_trigger WHERE tgname = 'queue_session_epoch_monotonic_trg'`,
      ).toHaveLength(1);
    });
  });

  it('enforces authority and review invariants in the database itself', async () => {
    await withIsolatedDatabase(async (sql) => {
      for (const f of await migrationFiles()) await sql.unsafe(await readMigration(f));
      const [org] = await sql<
        { id: string }[]
      >`INSERT INTO organizations (name, slug) VALUES ('O', 'o-org') RETURNING id`;
      const [fac] = await sql<{ id: string }[]>`
        INSERT INTO facilities (organization_id, name, slug, timezone) VALUES (${org?.id ?? ''}, 'F', 'f', 'UTC') RETURNING id`;
      const [user] = await sql<{ id: string }[]>`
        INSERT INTO staff_users (organization_id, email, display_name, password_hash)
        VALUES (${org?.id ?? ''}, 'u@example.test', 'U', 'x') RETURNING id`;
      const [svc] = await sql<{ id: string }[]>`
        INSERT INTO services (organization_id, facility_id, name) VALUES (${org?.id ?? ''}, ${fac?.id ?? ''}, 'S') RETURNING id`;
      const [dev] = await sql<{ id: string }[]>`
        INSERT INTO devices (facility_id, organization_id, staff_user_id, public_key_or_session)
        VALUES (${fac?.id ?? ''}, ${org?.id ?? ''}, ${user?.id ?? ''}, 'session-bound') RETURNING id`;
      const [qs] = await sql<{ id: string }[]>`
        INSERT INTO queue_sessions (facility_id, organization_id, service_id, operational_date)
        VALUES (${fac?.id ?? ''}, ${org?.id ?? ''}, ${svc?.id ?? ''}, CURRENT_DATE) RETURNING id`;

      // a coordinator device must come with an expiry
      await expect(
        sql`UPDATE queue_sessions SET coordinator_device_id = ${dev?.id ?? ''} WHERE id = ${qs?.id ?? ''}`,
      ).rejects.toThrow(/queue_sessions_coordinator_expiry_chk/);
      await sql`UPDATE queue_sessions SET coordinator_epoch = 2, coordinator_device_id = ${dev?.id ?? ''},
                coordinator_expires_at = NOW() + interval '1 hour' WHERE id = ${qs?.id ?? ''}`;
      // epoch is monotonic
      await expect(
        sql`UPDATE queue_sessions SET coordinator_epoch = 1 WHERE id = ${qs?.id ?? ''}`,
      ).rejects.toThrow(/must never decrease/);
      await sql`UPDATE queue_sessions SET coordinator_epoch = 2 WHERE id = ${qs?.id ?? ''}`; // equal is fine

      // a resolution must name resolver, time and reason
      await sql`INSERT INTO client_operations (organization_id, queue_session_id, device_id, operation_id, client_sequence, action, status)
                VALUES (${org?.id ?? ''}, ${qs?.id ?? ''}, ${dev?.id ?? ''}, '01a1bc63-be77-7b74-afe1-c8cba0f490f4', 1, 'ticket.create', 'needs_review')`;
      await expect(
        sql`UPDATE client_operations SET resolution = 'applied' WHERE operation_id = '01a1bc63-be77-7b74-afe1-c8cba0f490f4'`,
      ).rejects.toThrow(/client_operations_resolution_complete_chk/);
      await expect(
        sql`UPDATE client_operations SET resolution = 'maybe', resolved_by = ${user?.id ?? ''}, resolved_at = NOW(), resolution_reason_code = 'x'
             WHERE operation_id = '01a1bc63-be77-7b74-afe1-c8cba0f490f4'`,
      ).rejects.toThrow(/client_operations_resolution_chk/);
      // the (organization_id, operation_id) uniqueness invariant still holds
      await expect(
        sql`INSERT INTO client_operations (organization_id, queue_session_id, device_id, operation_id, client_sequence, action, status)
            VALUES (${org?.id ?? ''}, ${qs?.id ?? ''}, ${dev?.id ?? ''}, '01a1bc63-be77-7b74-afe1-c8cba0f490f4', 2, 'ticket.create', 'committed')`,
      ).rejects.toThrow(/client_operations_org_op_idx/);
    });
  });
});
