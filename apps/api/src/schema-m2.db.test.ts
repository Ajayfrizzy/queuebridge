import { describe, expect, it } from 'vitest';
import { migrationFiles, readMigration, withIsolatedDatabase } from './testing/isolated-db.js';

/** Database contract checks for migration 0004 (M2 queue core), in a throwaway database. */
describe('migration 0004_queue_core', () => {
  it('applies on a fresh database, then every migration re-applies cleanly (idempotent)', async () => {
    await withIsolatedDatabase(async (sql) => {
      const files = await migrationFiles();
      expect(files).toContain('0004_queue_core.sql');
      for (const f of files) await sql.unsafe(await readMigration(f));
      for (const f of files) await sql.unsafe(await readMigration(f)); // second pass
      await sql.unsafe(await readMigration('0004_queue_core.sql')); // and once more

      const indexes = (
        await sql<
          { indexname: string }[]
        >`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
      ).map((r) => r.indexname);
      for (const idx of [
        'tickets_session_issued_sequence_idx',
        'tickets_one_active_per_counter_idx',
        'tickets_transferred_from_idx',
        'services_facility_ticket_prefix_idx',
        'ticket_recovery_creds_hash_idx',
        'queue_events_session_seq_idx',
        'client_operations_org_op_idx',
      ]) {
        expect(indexes, idx).toContain(idx);
      }
      const constraints = (await sql<{ conname: string }[]>`SELECT conname FROM pg_constraint`).map(
        (r) => r.conname,
      );
      for (const c of [
        'client_operations_source_chk',
        'client_operations_device_required_chk',
        'services_ticket_prefix_chk',
        'tickets_created_channel_chk',
        'queue_sessions_facility_org_fk',
        'queue_events_actor_fk',
      ]) {
        expect(constraints, c).toContain(c);
      }
      // queue_events actor FK no longer uses ON DELETE SET NULL (which would UPDATE an
      // append-only row)
      const fk = await sql<{ confdeltype: string }[]>`
        SELECT confdeltype FROM pg_constraint WHERE conname = 'queue_events_actor_fk'`;
      expect(fk[0]?.confdeltype).toBe('r');
      // append-only trigger still present after 0004
      const trg = await sql`SELECT 1 FROM pg_trigger WHERE tgname = 'queue_events_append_only'`;
      expect(trg).toHaveLength(1);
    });
  });

  it('enforces session/service facility consistency and ticket-prefix format', async () => {
    await withIsolatedDatabase(async (sql) => {
      for (const f of await migrationFiles()) await sql.unsafe(await readMigration(f));
      const [org] = await sql<
        { id: string }[]
      >`INSERT INTO organizations (name, slug) VALUES ('O', 'o-org') RETURNING id`;
      const [f1] = await sql<
        { id: string }[]
      >`INSERT INTO facilities (organization_id, name, slug) VALUES (${org!.id}, 'F1', 'f-one') RETURNING id`;
      const [f2] = await sql<
        { id: string }[]
      >`INSERT INTO facilities (organization_id, name, slug) VALUES (${org!.id}, 'F2', 'f-two') RETURNING id`;
      const [svc] = await sql<
        { id: string }[]
      >`INSERT INTO services (facility_id, organization_id, name) VALUES (${f1!.id}, ${org!.id}, 'S') RETURNING id`;
      await expect(
        sql`INSERT INTO queue_sessions (facility_id, organization_id, service_id, operational_date)
            VALUES (${f2!.id}, ${org!.id}, ${svc!.id}, CURRENT_DATE)`,
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        sql`UPDATE services SET ticket_prefix = 'ab1' WHERE id = ${svc!.id}`,
      ).rejects.toMatchObject({ code: '23514' });
      await sql`UPDATE services SET ticket_prefix = 'AB' WHERE id = ${svc!.id}`;
      const [svc2] = await sql<
        { id: string }[]
      >`INSERT INTO services (facility_id, organization_id, name) VALUES (${f1!.id}, ${org!.id}, 'T') RETURNING id`;
      await expect(
        sql`UPDATE services SET ticket_prefix = 'AB' WHERE id = ${svc2!.id}`,
      ).rejects.toMatchObject({ code: '23505' });
    });
  });
});
