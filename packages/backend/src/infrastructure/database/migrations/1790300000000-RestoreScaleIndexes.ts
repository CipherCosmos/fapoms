import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The scale indexes — restored, plus the hot-path indexes the audit of 2026-08-16 found missing.
 *
 * ## Why this migration exists
 *
 * When the migration chain was collapsed into `1784000000000-BaselineSchema` (generated from the
 * entity classes), every index that lived only in raw-SQL migrations moved to `_historical/` and
 * stopped being applied. Only the trigram set was consciously carried forward
 * (`1790000000000-RestoreSearchTrigramIndexes`). These were not:
 *
 *   - `1789000000000-AssignmentAndGeoScaleIndexes` — the five indexes measured against the 200k
 *     assignment scale database (list page 29 ms → 0.07 ms, geo prefilter 89 ms → 3.7 ms).
 *   - `1788100000000-IndexAssignmentHotFilters`, `1788000000000-IndexProjectBranchScheduledDate`,
 *     `1787400000000-AppendTableIndexes`, `1787500000000-ReferenceDataIndexes`.
 *
 * Verified 2026-08-16: the baseline contains none of them, the dev database lost four of five to
 * `synchronize`, and **the live server has zero of them**. Every "already fixed" hot query — the
 * operations list, the inbox, the dashboard tiles, the auto-decline sweep, the recommendation
 * geo prefilter — has been a sequential scan in production since the baseline shipped. Re-measured
 * on the current schema at 200k rows: restoring them takes the status-filtered list 68 → 17 ms,
 * the inbox 94 → 49 ms and a recommendation 434 → 234 ms.
 *
 * ## Why it cannot happen again
 *
 * Every btree here is ALSO declared as an `@Index` on its entity, so a future entity-generated
 * baseline (or a careless `migration:generate`) carries it. The one exception is the functional
 * GiST index on `assayers (location::geography)`, which TypeORM cannot express; it is deliberately
 * migration-only and its absence is caught by `scale-indexes.spec.ts`.
 *
 * ## What is deliberately NOT here
 *
 * `1788500000000-SoftDeletePartialUniqueIndexes` swapped the plain UNIQUE constraints on
 * `clients.client_code`, `projects.project_number` and `assayers.assayer_code` for
 * `WHERE is_active` partial uniques. That is a behaviour change (a soft-deleted code becomes
 * reusable) that needs every by-code lookup reviewed first, so it stays out of an index-restore.
 *
 * `IF NOT EXISTS` throughout: the dev database still carries the geography index and a hand-made
 * copy of the assignment set, and this must be re-runnable against either.
 */
export class RestoreScaleIndexes1790300000000 implements MigrationInterface {
  name = 'RestoreScaleIndexes1790300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── assignments ──────────────────────────────────────────────────────────────────────────
    // The main operations list and dashboard tiles: `WHERE is_active AND status = … ORDER BY
    // created_at`. Declared ascending to match the entity decorator; Postgres walks it backward
    // for the DESC order the list uses, at the same cost.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assignments_active_status_created"
      ON "assignments" ("is_active", "status", "created_at")
    `);
    // The open-offer sweep (autoDeclineExpiredOffers, every 15 minutes).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assignments_open_offers"
      ON "assignments" ("sla_due_date")
      WHERE "status" = 'PENDING' AND "is_active" = true
    `);
    // "Is this assayer already committed that day?" — double-booking guard and workload.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assignments_assayer_day"
      ON "assignments" ("assayer_id", "scheduled_date", "status")
      WHERE "is_active" = true
    `);
    // "Latest assignment for this branch" — read on every assignment create.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assignments_branch_recent"
      ON "assignments" ("project_branch_id", "created_at")
    `);
    // The SLA breach scanner: `sla_status = 'COMPLIANT' AND status IN (…) AND is_active`.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assignments_sla_status_status_active"
      ON "assignments" ("sla_status", "status")
      WHERE "is_active" = true
    `);

    // ── assayers — the candidate prefilter's radius search ───────────────────────────────────
    // `ST_DWithin(a.location::geography, …)` in recommendation.engine.ts is written to match this
    // exact expression; without it the prefilter is a full scan of every active assayer.
    // Migration-only: TypeORM has no way to declare a functional index.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assayers_location_geography"
      ON "assayers" USING gist (("location"::geography))
    `);

    // ── project_branches — the dashboard "due this week" window ─────────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_project_branches_scheduled_date_active"
      ON "project_branches" ("scheduled_date")
      WHERE "is_active" = true AND "scheduled_date" IS NOT NULL
    `);

    // ── notifications ────────────────────────────────────────────────────────────────────────
    // The assayer side of the inbox had only `(assayer_id)`; the list orders by created_at.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_notifications_assayer_created"
      ON "notifications" ("assayer_id", "created_at")
    `);
    // Every emit reads back its own rows by group_key (notification-dispatch.service.ts) — a
    // sequential scan of the whole table per notification without this.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_notifications_group_key"
      ON "notifications" ("group_key")
      WHERE "group_key" IS NOT NULL
    `);

    // ── audit_events — the inbox's field-issue list ──────────────────────────────────────────
    // `getByEventType('ASSIGNMENT_ISSUE_REPORTED')` runs on every Operations Inbox load; the
    // table was indexed on everything except event_type, so it was two full scans of the widest
    // table in the schema per page view.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_audit_events_event_type_occurred"
      ON "audit_events" ("event_type", "occurred_at")
    `);

    // ── refresh_tokens — looked up by hash on every token refresh ────────────────────────────
    // Indexed only on user_id and expires_at; every refresh was a sequential scan of a table
    // that grows with sessions × refreshes and is never pruned. Unique because a hash is one.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_refresh_tokens_token_hash"
      ON "refresh_tokens" ("token_hash")
    `);

    // ── billing_entries — `SELECT … FOR UPDATE WHERE invoice_id = …` ─────────────────────────
    // A sequential scan taken under a row lock in createInvoice/recordPayment.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_billing_entries_invoice_id"
      ON "billing_entries" ("invoice_id")
    `);

    // ── documents — the data-entry desk queue ────────────────────────────────────────────────
    // `type = AUDITED_RETURN_PDF AND status IN (…) AND assigned_to_user_id … ORDER BY received_at`.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_documents_type_status_received"
      ON "documents" ("type", "status", "received_at")
      WHERE "is_active" = true
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_documents_assigned_to_user"
      ON "documents" ("assigned_to_user_id")
      WHERE "is_active" = true AND "assigned_to_user_id" IS NOT NULL
    `);

    // ── history tables read by the unified audit trail ───────────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_workflow_history_entity_timestamp"
      ON "workflow_history" ("entityId", "timestamp")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_billing_history_entity_created"
      ON "billing_history" ("entity_type", "entity_id", "created_at")
    `);

    // ── reference data ───────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_client_configurations_client_effective"
      ON "client_configurations" ("client_id", "effective_from")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_clients_organization"
      ON "clients" ("organization_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_clients_lifecycle_status"
      ON "clients" ("lifecycle_status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_clients_lifecycle_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_clients_organization"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_client_configurations_client_effective"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_billing_history_entity_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_workflow_history_entity_timestamp"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_documents_assigned_to_user"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_documents_type_status_received"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_billing_entries_invoice_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_refresh_tokens_token_hash"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_events_event_type_occurred"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notifications_group_key"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notifications_assayer_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_project_branches_scheduled_date_active"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assayers_location_geography"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assignments_sla_status_status_active"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assignments_branch_recent"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assignments_assayer_day"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assignments_open_offers"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assignments_active_status_created"`);
  }
}
