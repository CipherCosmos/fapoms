import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GIVE NOTIFICATIONS A TENANT, so the bell can be scoped like everything else.
 *
 * ## Why this exists
 *
 * `notifications` had 35 columns and not one of them said whose data the row carried. Fan-out was
 * by role alone — `NotificationDispatchService` contained no reference to `organizationId`
 * anywhere — so "New assayer onboarded" for an assayer in one organisation was written into the
 * bell of every active OPERATIONS user on the deployment, whichever organisation they belonged
 * to, carrying the person's name and a working link to their roster record. Reproduced live as
 * finding F-07. The defect was in the shared fan-out, not in one catalog entry, so every type
 * with a non-empty `roles` list had it.
 *
 * Recipient selection is now narrowed to the event's organisation, and the reads are narrowed to
 * the viewer's — but neither is possible until the row itself records which organisation it
 * belongs to. That column is what this adds.
 *
 * The predecessor migration (1796500000000-BackfillTenantOwnership) is the precondition: it gave
 * every `assayers`, `branches`, `clients`, `projects` and `users` row a non-null
 * `organization_id`, which is what the derivations below join through.
 *
 * ## What the column means, and what a NULL means
 *
 * `organization_id` is the organisation of the EVENT, never of the recipient. A row that reached
 * the wrong bell still says which tenant it belongs to, which is precisely what lets the read
 * side decline to show it.
 *
 * NULL is legitimate and means one of two things:
 *  - a platform-scoped type (`NotificationTypeDef.scope === 'PLATFORM'`) — a data-wipe approval,
 *    a CERT-In clock, a support-desk reply — which belongs to no tenant by design; or
 *  - a legacy row this backfill could not attribute (see below).
 * Both remain visible to the one recipient they are addressed to. The column is deliberately NOT
 * made NOT NULL, for the first reason above and for the second reason 1796500000000 gives about
 * every other tenant column: an insert path that forgets to stamp it should write an
 * unattributed row, not throw at runtime.
 *
 * ## What the backfill does, and what it refuses to do
 *
 * Each pass derives the organisation from the entity the notification is ABOUT, joining exactly
 * the way `ENTITY_ORGANIZATION_SQL` in `notification-tenancy.ts` does at dispatch time — history
 * and future rows are then attributed by the same rule rather than by two rules that can drift.
 *
 * It deliberately does NOT fall back to the RECIPIENT's organisation, even though that would
 * leave zero unattributed rows. On a leaked row the recipient's organisation is the wrong answer:
 * stamping it would declare the leak correct, make it pass the new read filter for ever, and
 * erase the only evidence that it happened. An unattributed row is honest and harmless — it is
 * still shown only to its addressee — where a confidently wrong one is neither.
 *
 * What it actually did on this deployment, run 2026-09-09: 8 of 19 rows attributed. The other 11
 * are ASSAYER_ONBOARDED and ASSIGNMENT_ACCEPTED rows whose `entity_id` names an assayer or an
 * assignment that no longer exists — synthetic records from the lifecycle certification, since
 * removed — so there is genuinely nothing left to derive from. They stay null rather than being
 * attributed from the administrator whose bell they are sitting in, for the reason above. Every
 * row whose subject still exists resolved.
 *
 * The passes for entity types the table has not seen yet are here because it will accumulate
 * them, and each was checked against live data before being written down: project_branches
 * 100/100 rows resolve, validation_cases 2/2, assayer_payables 1/1, assignments 2/2, schedules
 * 2/2, and so on.
 *
 * FEEDBACK, SECURITY_INCIDENT, DATA_RIGHTS_REQUEST and DESTRUCTIVE_ACTION_REQUEST have no pass
 * on purpose rather than by omission: those are the platform-scoped types, and dispatch writes
 * them with a null organisation from now on. Attributing the historical ones would leave history
 * and new rows disagreeing about the same event type.
 */
export class NotificationTenantScope1796600000000 implements MigrationInterface {
  name = 'NotificationTenantScope1796600000000';

  /**
   * How each `entity_type` reaches an owning organisation. Mirrors `ENTITY_ORGANIZATION_SQL`.
   *
   * `COALESCE` orders the sources the same way it does there: the work's own project first (a
   * project belongs to exactly one organisation by definition), the person second.
   */
  private static readonly BACKFILL: Array<[entityType: string, sql: string]> = [
    ['ASSAYER', `
      UPDATE notifications n SET organization_id = a.organization_id
        FROM assayers a
       WHERE n.organization_id IS NULL AND n.entity_type = 'ASSAYER' AND a.id = n.entity_id`],

    ['BRANCH', `
      UPDATE notifications n SET organization_id = b.organization_id
        FROM branches b
       WHERE n.organization_id IS NULL AND n.entity_type = 'BRANCH' AND b.id = n.entity_id`],

    ['CLIENT', `
      UPDATE notifications n SET organization_id = c.organization_id
        FROM clients c
       WHERE n.organization_id IS NULL AND n.entity_type = 'CLIENT' AND c.id = n.entity_id`],

    ['PROJECT', `
      UPDATE notifications n SET organization_id = p.organization_id
        FROM projects p
       WHERE n.organization_id IS NULL AND n.entity_type = 'PROJECT' AND p.id = n.entity_id`],

    ['USER', `
      UPDATE notifications n SET organization_id = u.organization_id
        FROM users u
       WHERE n.organization_id IS NULL AND n.entity_type = 'USER' AND u.id = n.entity_id`],

    ['ASSIGNMENT', `
      UPDATE notifications n SET organization_id = src.org
        FROM (
          SELECT a.id, COALESCE(p.organization_id, asy.organization_id) AS org
            FROM assignments a
            LEFT JOIN projects p ON p.id = a.project_id
            LEFT JOIN assayers asy ON asy.id = a.assayer_id
        ) src
       WHERE n.organization_id IS NULL AND n.entity_type = 'ASSIGNMENT'
         AND src.id = n.entity_id AND src.org IS NOT NULL`],

    ['SCHEDULE', `
      UPDATE notifications n SET organization_id = src.org
        FROM (
          SELECT s.id, COALESCE(p.organization_id, p2.organization_id, asy.organization_id) AS org
            FROM schedules s
            LEFT JOIN projects p ON p.id = s.project_id
            LEFT JOIN assignments a ON a.id = s.assignment_id
            LEFT JOIN projects p2 ON p2.id = a.project_id
            LEFT JOIN assayers asy ON asy.id = s.assayer_id
        ) src
       WHERE n.organization_id IS NULL AND n.entity_type = 'SCHEDULE'
         AND src.id = n.entity_id AND src.org IS NOT NULL`],

    ['PROJECT_BRANCH', `
      UPDATE notifications n SET organization_id = src.org
        FROM (
          SELECT pb.id, COALESCE(p.organization_id, b.organization_id) AS org
            FROM project_branches pb
            LEFT JOIN projects p ON p.id = pb.project_id
            LEFT JOIN branches b ON b.id = pb.branch_id
        ) src
       WHERE n.organization_id IS NULL AND n.entity_type = 'PROJECT_BRANCH'
         AND src.id = n.entity_id AND src.org IS NOT NULL`],

    ['DOCUMENT', `
      UPDATE notifications n SET organization_id = src.org
        FROM (
          SELECT d.id, COALESCE(p1.organization_id, p2.organization_id) AS org
            FROM documents d
            LEFT JOIN project_branches pb ON pb.id = d.project_branch_id
            LEFT JOIN projects p1 ON p1.id = pb.project_id
            LEFT JOIN assessments ass ON ass.id = d.assessment_id
            LEFT JOIN projects p2 ON p2.id = ass.project_id
        ) src
       WHERE n.organization_id IS NULL AND n.entity_type = 'DOCUMENT'
         AND src.id = n.entity_id AND src.org IS NOT NULL`],

    ['VALIDATION', `
      UPDATE notifications n SET organization_id = src.org
        FROM (
          SELECT vc.id, COALESCE(p.organization_id, p2.organization_id) AS org
            FROM validation_cases vc
            LEFT JOIN project_branches pb ON pb.id = vc.project_branch_id
            LEFT JOIN projects p ON p.id = pb.project_id
            LEFT JOIN assessments ass ON ass.id = vc.assessment_id
            LEFT JOIN projects p2 ON p2.id = ass.project_id
        ) src
       WHERE n.organization_id IS NULL AND n.entity_type = 'VALIDATION'
         AND src.id = n.entity_id AND src.org IS NOT NULL`],

    ['VALIDATION_QUERY', `
      UPDATE notifications n SET organization_id = src.org
        FROM (
          SELECT q.id, COALESCE(p.organization_id, asy.organization_id) AS org
            FROM validation_queries q
            LEFT JOIN validation_cases vc ON vc.id = q.validation_case_id
            LEFT JOIN project_branches pb ON pb.id = vc.project_branch_id
            LEFT JOIN projects p ON p.id = pb.project_id
            LEFT JOIN assayers asy ON asy.id = q.assayer_id
        ) src
       WHERE n.organization_id IS NULL AND n.entity_type = 'VALIDATION_QUERY'
         AND src.id = n.entity_id AND src.org IS NOT NULL`],

    ['EXPENSE', `
      UPDATE notifications n SET organization_id = src.org
        FROM (
          SELECT e.id, COALESCE(p.organization_id, asy.organization_id) AS org
            FROM assignment_expenses e
            LEFT JOIN assignments a ON a.id = e.assignment_id
            LEFT JOIN projects p ON p.id = a.project_id
            LEFT JOIN assayers asy ON asy.id = e.assayer_id
        ) src
       WHERE n.organization_id IS NULL AND n.entity_type = 'EXPENSE'
         AND src.id = n.entity_id AND src.org IS NOT NULL`],

    ['PAYABLE', `
      UPDATE notifications n SET organization_id = src.org
        FROM (
          SELECT pay.id, COALESCE(p.organization_id, asy.organization_id) AS org
            FROM assayer_payables pay
            LEFT JOIN projects p ON p.id = pay.project_id
            LEFT JOIN assayers asy ON asy.id = pay.assayer_id
        ) src
       WHERE n.organization_id IS NULL AND n.entity_type = 'PAYABLE'
         AND src.id = n.entity_id AND src.org IS NOT NULL`],

    ['ASSAYER_INVOICE', `
      UPDATE notifications n SET organization_id = asy.organization_id
        FROM assayer_invoices i
        JOIN assayers asy ON asy.id = i.assayer_id
       WHERE n.organization_id IS NULL AND n.entity_type = 'ASSAYER_INVOICE' AND i.id = n.entity_id`],

    /**
     * `ACCOUNT_LOCKED` passes the locked account's id, which is a `users` row for staff and an
     * `assayers` row for the field — the emitter genuinely does not distinguish them. This is the
     * account the event is about, not the account being told about it.
     */
    ['ACCOUNT', `
      UPDATE notifications n SET organization_id = src.org
        FROM (
          SELECT id, organization_id AS org FROM users
          UNION ALL
          SELECT id, organization_id AS org FROM assayers
        ) src
       WHERE n.organization_id IS NULL AND n.entity_type = 'ACCOUNT'
         AND src.id = n.entity_id AND src.org IS NOT NULL`],
  ];

  /**
   * The payload sweep, for rows whose `entity_type` named nothing this could join through.
   *
   * Same identifiers the dispatcher falls back to when the declared entity does not resolve.
   * The `~` guard is not decoration: `payload` is jsonb written by ~50 call sites and a cast of
   * a non-uuid string to `uuid` aborts the whole statement, taking the migration with it.
   */
  private static readonly UUID_TEXT = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "organization_id" uuid NULL`);

    /**
     * Indexed because every recipient-facing read now carries an organisation predicate, and
     * because "everything organisation X was told" is the question an incident review asks
     * first. No foreign key to `organizations`: not one of the six tables already carrying
     * `organization_id` has one, and this migration is not the place to introduce a different
     * convention for the same column.
     */
    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_notifications_organization_id" ON "notifications" ("organization_id")`,
    );

    for (const [, sql] of NotificationTenantScope1796600000000.BACKFILL) {
      await q.query(sql);
    }

    const uuidText = NotificationTenantScope1796600000000.UUID_TEXT;
    await q.query(`
      UPDATE notifications n SET organization_id = a.organization_id
        FROM assayers a
       WHERE n.organization_id IS NULL
         AND n.payload->>'assayerId' ~ '${uuidText}'
         AND a.id = (n.payload->>'assayerId')::uuid`);
    await q.query(`
      UPDATE notifications n SET organization_id = src.org
        FROM (
          SELECT a.id, COALESCE(p.organization_id, asy.organization_id) AS org
            FROM assignments a
            LEFT JOIN projects p ON p.id = a.project_id
            LEFT JOIN assayers asy ON asy.id = a.assayer_id
        ) src
       WHERE n.organization_id IS NULL
         AND n.payload->>'assignmentId' ~ '${uuidText}'
         AND src.id = (n.payload->>'assignmentId')::uuid
         AND src.org IS NOT NULL`);

    /**
     * Says what was left behind, because "some rows could not be attributed" is exactly the kind
     * of thing that is true, harmless, and impossible to discover six months later. The residue
     * is expected to be the platform-scoped types listed in the class comment plus anything whose
     * subject has since been hard-deleted.
     */
    const [{ unattributed, total }]: Array<{ unattributed: string; total: string }> = await q.query(
      `SELECT COUNT(*) FILTER (WHERE organization_id IS NULL) AS unattributed, COUNT(*) AS total
         FROM notifications`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[NotificationTenantScope] ${Number(total) - Number(unattributed)}/${total} notification row(s) `
      + `attributed to an organisation; ${unattributed} left null (platform-scoped types and rows whose `
      + 'subject no longer exists). Null rows stay visible to the recipient they are addressed to and '
      + 'are never widened to anybody else.',
    );
  }

  /**
   * Reverting drops the column outright, and with it the attributions.
   *
   * There is nothing to preserve: the values were derived, not entered, so `up` reproduces them
   * exactly. Worth stating plainly that reverting re-opens F-07 — without this column the bell
   * has nothing to filter on and dispatch has nothing to stamp — so this is a rollback of the
   * fix, not merely of a schema change.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_notifications_organization_id"`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN IF EXISTS "organization_id"`);
  }
}
