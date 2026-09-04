import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The DPDP data-principal rights-request register (access / correction / erasure / grievance /
 * nomination), tracked against a response SLA. Indexed by status and receipt time for the queue and
 * the overdue count.
 */
export class DataRightsRequests1795500000000 implements MigrationInterface {
  name = 'DataRightsRequests1795500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "data_rights_requests" (
        "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "request_type"       varchar(24) NOT NULL,
        "subject_type"       varchar(16) NOT NULL DEFAULT 'ASSAYER',
        "subject_ref"        varchar(160),
        "subject_id"         uuid,
        "requester_name"     varchar(160),
        "requester_contact"  varchar(200),
        "details"            text,
        "status"             varchar(24) NOT NULL DEFAULT 'RECEIVED',
        "received_at"        timestamptz NOT NULL,
        "completed_at"       timestamptz,
        "legal_hold_applied" boolean NOT NULL DEFAULT false,
        "resolution_notes"   text,
        "created_by"         uuid,
        "created_at"         timestamptz NOT NULL DEFAULT now(),
        "updated_at"         timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_data_rights_status" ON "data_rights_requests" ("status");`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_data_rights_received" ON "data_rights_requests" ("received_at");`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_data_rights_received";`);
    await q.query(`DROP INDEX IF EXISTS "IDX_data_rights_status";`);
    await q.query(`DROP TABLE IF EXISTS "data_rights_requests";`);
  }
}
