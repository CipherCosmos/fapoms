import { DataSource, EntityManager, IsNull } from 'typeorm';
import { AssignmentStatus } from '@fapoms/shared';
import * as crypto from 'crypto';
import { AppDataSource } from '../../infrastructure/database/data-source';
import { AssignmentReassignmentEntity } from './assignment-reassignment.entity';

/**
 * `POST /assignments/:id/reassign` returned 500 to every caller who was allowed to make the call,
 * and no test in the repository could have seen it.
 *
 * `AssignmentReassignmentEntity` extended `BaseEntity`, which declares `@VersionColumn() version`.
 * `assignment_reassignments` has no such column and never has — 1796200000000-Phase2OperationalIntegrity
 * created it with created_by/updated_by/created_at/updated_at/is_active and nothing else. So every
 * statement TypeORM built from that mapping named a column that does not exist, starting with the
 * lookup for the currently-open ownership interval:
 *
 *   QueryFailedError: column AssignmentReassignmentEntity.version does not exist
 *
 * It fired inside the transaction, after the region check, the assayer lookup, the double-booking
 * check and the optimistic-lock check had all passed — so the operator who filled the form in
 * correctly got a 500 and the one who asked for something illegal got a clean 409. The lineage
 * table has 0 rows to show for it, and `GET :id/reassignments` and the audit trail have been
 * reading an empty history since the day the table was introduced.
 *
 * The reason no unit test caught it is worth naming, because it is the reason this file has to be
 * a `.db.spec.ts`: `assignment-phase2-concurrency.spec.ts` covers reassignment thoroughly, and its
 * `mockEntityManager.create()` is `(cls, dto) => ({ ...dto })` and its `save()` returns whatever it
 * is handed. A mapping that cannot produce valid SQL is invisible to a mock that never produces
 * SQL. Nothing short of a real Postgres connection can tell an entity from a table.
 *
 * So this drives the real `EntityManager` through the exact sequence `reassignAssignment()`
 * performs — find the open interval, close it, open the next — against real rows, plus a sweep
 * asserting no entity ANYWHERE maps a column its table lacks, because the next drift of this kind
 * will not be in this file.
 *
 * Every row it creates is identified by an `RFIX-` code and deleted in `afterAll`. It touches
 * nothing it did not write.
 */
describe('assignment reassignment lineage against the real schema', () => {
  jest.setTimeout(60000);

  let ds: DataSource;

  const createdAssignmentIds: string[] = [];
  const createdProjectBranchIds: string[] = [];
  const createdBranchIds: string[] = [];
  const createdProjectIds: string[] = [];
  const createdClientIds: string[] = [];
  const createdAssayerIds: string[] = [];

  /** Distinct per run so a crashed run cannot collide with the next one's unique codes. */
  const RUN = `RFIX-${Date.now().toString().slice(-8)}`;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    ds = AppDataSource;
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    try {
      // Child-first, so no FK ever refuses a delete and leaves fixtures behind.
      if (createdAssignmentIds.length) {
        await ds.query('DELETE FROM assignment_reassignments WHERE assignment_id = ANY($1)', [createdAssignmentIds]);
        await ds.query('DELETE FROM assignments WHERE id = ANY($1)', [createdAssignmentIds]);
      }
      if (createdProjectBranchIds.length) await ds.query('DELETE FROM project_branches WHERE id = ANY($1)', [createdProjectBranchIds]);
      if (createdProjectIds.length) await ds.query('DELETE FROM projects WHERE id = ANY($1)', [createdProjectIds]);
      if (createdBranchIds.length) await ds.query('DELETE FROM branches WHERE id = ANY($1)', [createdBranchIds]);
      if (createdAssayerIds.length) await ds.query('DELETE FROM assayers WHERE id = ANY($1)', [createdAssayerIds]);
      if (createdClientIds.length) await ds.query('DELETE FROM clients WHERE id = ANY($1)', [createdClientIds]);
    } finally {
      await ds.destroy();
    }
  });

  /**
   * Fixtures are raw SQL on purpose: this file is testing the reassignment *mapping*, so every
   * other table it needs should be set up by something that cannot itself be the thing under test.
   * Column lists match assignment-postgres-concurrency.db.spec.ts, which these tables' NOT NULLs
   * have already been reconciled against.
   */
  async function makeAssayer(tag: string): Promise<string> {
    const id = crypto.randomUUID();
    await ds.query(
      `INSERT INTO assayers (id, assayer_code, first_name, last_name, display_name, phone, status, lifecycle_status, is_active, address, state, district, city, version)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', 'ACTIVE', true, '1 Remediation Road', 'Maharashtra', 'Mumbai', 'Mumbai', 1)`,
      [id, `${RUN}-ASR-${tag}`, `Fix${tag}`, 'Fixture', `Fixture Assayer ${tag}`, `98${Math.floor(10000000 + Math.random() * 89999999)}`],
    );
    createdAssayerIds.push(id);
    return id;
  }

  /** `tag` keeps the client/project/branch/assignment codes unique across calls within one run. */
  async function makeAssignment(assayerId: string, tag: string): Promise<string> {
    const clientId = crypto.randomUUID();
    await ds.query(
      `INSERT INTO clients (id, client_code, name, display_name, is_active, version) VALUES ($1, $2, $3, $3, true, 1)`,
      [clientId, `${RUN}-CLI-${tag}`, `${RUN} Client ${tag}`],
    );
    createdClientIds.push(clientId);

    const projectId = crypto.randomUUID();
    await ds.query(
      `INSERT INTO projects (id, client_id, project_number, name, status, is_active, version) VALUES ($1, $2, $3, $4, 'PLANNING', true, 1)`,
      [projectId, clientId, `${RUN}-PRJ-${tag}`, `${RUN} Project ${tag}`],
    );
    createdProjectIds.push(projectId);

    const branchId = crypto.randomUUID();
    await ds.query(
      `INSERT INTO branches (id, client_id, sol_id, name, address, state, district, city, is_active, version, organization_id)
       VALUES ($1, $2, $3, $4, '2 Remediation Road', 'Maharashtra', 'Mumbai', 'Mumbai', true, 1, (SELECT id FROM organizations WHERE is_active = true ORDER BY created_at LIMIT 1))`,
      [branchId, clientId, `${RUN}-SOL-${tag}`, `${RUN} Branch ${tag}`],
    );
    createdBranchIds.push(branchId);

    const projectBranchId = crypto.randomUUID();
    await ds.query(
      `INSERT INTO project_branches (id, project_id, branch_id, status, is_active, version) VALUES ($1, $2, $3, 'PLANNING', true, 1)`,
      [projectBranchId, projectId, branchId],
    );
    createdProjectBranchIds.push(projectBranchId);

    const assignmentId = crypto.randomUUID();
    await ds.query(
      `INSERT INTO assignments (id, assignment_number, assayer_id, project_id, project_branch_id, status, is_active, entity_version, version)
       VALUES ($1, $2, $3, $4, $5, $6, true, 1, 1)`,
      [assignmentId, `${RUN}-ASG-${tag}`, assayerId, projectId, projectBranchId, AssignmentStatus.PENDING],
    );
    createdAssignmentIds.push(assignmentId);
    return assignmentId;
  }

  /**
   * The general form of the defect, not the instance.
   *
   * One entity inherited a column its table did not have, and the endpoint that used it was dead.
   * Any other entity in the same state is another dead endpoint waiting for its first caller, and
   * the only way to know is to ask the database. 86 entities, every mapped column, one query.
   */
  it('maps no column that the database does not have — for any entity, not just this one', async () => {
    const rows: Array<{ table_name: string; column_name: string }> = await ds.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`,
    );
    const columnsOf = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!columnsOf.has(r.table_name)) columnsOf.set(r.table_name, new Set());
      columnsOf.get(r.table_name)!.add(r.column_name);
    }

    expect(ds.entityMetadatas.length).toBeGreaterThan(50);

    const unmapped: string[] = [];
    for (const md of ds.entityMetadatas) {
      if (md.tableType !== 'regular') continue;
      const columns = columnsOf.get(md.tableName);
      if (!columns) { unmapped.push(`${md.name}: table "${md.tableName}" does not exist`); continue; }
      for (const c of md.columns) {
        if (c.isVirtual) continue;
        if (!columns.has(c.databaseName)) {
          unmapped.push(`${md.name}.${c.propertyName} -> ${md.tableName}."${c.databaseName}" does not exist`);
        }
      }
    }

    // Either add the column in a migration or stop mapping it. Both are one small change; what is
    // not acceptable is leaving it, because TypeORM names the column in every statement it builds
    // for the entity and the route is a 500 from its first request onwards.
    expect({ unmapped }).toEqual({ unmapped: [] });
  });

  /**
   * The decision this table was fixed by, written down where a future edit will trip over it.
   *
   * Optimistic locking was removed from the entity rather than added to the table: a lineage row
   * is inserted once and closed once, from inside the transaction that already holds the parent
   * assignment under `SELECT ... FOR UPDATE`, and "at most one open interval" is enforced by the
   * partial unique index rather than by a counter. Re-extending `BaseEntity` would reintroduce the
   * outage; adding a `version` column would answer a concurrency question nothing is asking.
   */
  it('tracks no row version on the lineage, in neither the entity nor the table', async () => {
    const md = ds.getMetadata(AssignmentReassignmentEntity);
    expect(md.versionColumn).toBeUndefined();
    expect(md.columns.map((c) => c.databaseName)).not.toContain('version');

    const versionColumn = await ds.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'assignment_reassignments' AND column_name = 'version'`,
    );
    expect(versionColumn).toEqual([]);
  });

  /**
   * The reassign transaction, run for real.
   *
   * Each step below is the statement `AssignmentService.reassignAssignment()` issues, in its
   * order, through the same `EntityManager` API. The first `findOne` is where the 500 came from.
   */
  it('finds, closes and opens ownership intervals the way a reassignment does', async () => {
    const first = await makeAssayer('A');
    const second = await makeAssayer('B');
    const third = await makeAssayer('C');
    const assignmentId = await makeAssignment(first, 'LINEAGE');

    const history = await ds.transaction(async (manager: EntityManager) => {
      const opened = await manager.save(manager.create(AssignmentReassignmentEntity, {
        assignmentId,
        previousAssayerId: null,
        newAssayerId: first,
        reassignedBy: first,
        reason: 'Initial ownership',
        requestId: `${RUN}-REQ-0`,
        ownershipStartedAt: new Date(Date.now() - 7200_000),
        ownershipEndedAt: null,
      }));
      // Nothing named `version` was inserted, and the row came back with a real id.
      expect(opened.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(opened).not.toHaveProperty('version');

      // THE query that used to throw `column AssignmentReassignmentEntity.version does not exist`.
      const currentActiveOwner = await manager.findOne(AssignmentReassignmentEntity, {
        where: { assignmentId, ownershipEndedAt: IsNull(), isActive: true },
      });
      expect(currentActiveOwner?.id).toBe(opened.id);
      expect(currentActiveOwner!.newAssayerId).toBe(first);

      // Close it — the UPDATE, which under a @VersionColumn would also have carried
      // `SET version = version + 1 WHERE version = ...`.
      const now = new Date();
      currentActiveOwner!.ownershipEndedAt = now;
      await manager.save(currentActiveOwner!);

      // Open the next contiguous interval, exactly as the service does.
      await manager.save(manager.create(AssignmentReassignmentEntity, {
        assignmentId,
        previousAssayerId: first,
        newAssayerId: second,
        reassignedBy: first,
        reason: 'Reassigned: first assayer unavailable',
        requestId: `${RUN}-REQ-1`,
        ownershipStartedAt: now,
        ownershipEndedAt: null,
      }));

      // And once more, so the history has a shape rather than a single hop.
      const handover = new Date(now.getTime() + 1000);
      const open = await manager.findOne(AssignmentReassignmentEntity, {
        where: { assignmentId, ownershipEndedAt: IsNull(), isActive: true },
      });
      open!.ownershipEndedAt = handover;
      await manager.save(open!);
      await manager.save(manager.create(AssignmentReassignmentEntity, {
        assignmentId,
        previousAssayerId: second,
        newAssayerId: third,
        reassignedBy: first,
        reason: 'Reassigned: branch moved region',
        requestId: `${RUN}-REQ-2`,
        ownershipStartedAt: handover,
        ownershipEndedAt: null,
      }));

      // What `getReassignmentHistory()` returns, relations and ordering included — the read side
      // of the same mapping, which selects every column the entity declares.
      return manager.find(AssignmentReassignmentEntity, {
        where: { assignmentId },
        relations: ['previousAssayer', 'newAssayer'],
        order: { ownershipStartedAt: 'ASC' },
      });
    });

    expect(history).toHaveLength(3);
    expect(history.map((r) => [r.previousAssayerId, r.newAssayerId])).toEqual([
      [null, first],
      [first, second],
      [second, third],
    ]);
    // Contiguous: each interval starts where the previous one ended, and only the last is open.
    expect(history[0].ownershipEndedAt).toEqual(history[1].ownershipStartedAt);
    expect(history[1].ownershipEndedAt).toEqual(history[2].ownershipStartedAt);
    expect(history[2].ownershipEndedAt).toBeNull();
    // The relations resolve, which is what the reassignment history endpoint renders.
    expect(history[2].newAssayer?.id).toBe(third);
    expect(history[0].previousAssayer).toBeNull();
    // The audit columns the entity re-declares are populated by the database, not left null.
    expect(history[0].createdAt).toBeInstanceOf(Date);
    expect(history[0].isActive).toBe(true);
  });

  /**
   * The invariant that made a version column unnecessary, proved rather than asserted.
   *
   * `idx_assignment_reassignments_active_owner` is a partial unique index on (assignment_id) WHERE
   * ownership_ended_at IS NULL AND is_active — so "two people own this assignment right now" is
   * refused by Postgres, not by a counter in the application.
   */
  it('refuses a second open ownership interval on the same assignment', async () => {
    const owner = await makeAssayer('D');
    const other = await makeAssayer('E');
    const assignmentId = await makeAssignment(owner, 'UNIQUE');
    const repo = ds.getRepository(AssignmentReassignmentEntity);

    await repo.save(repo.create({
      assignmentId,
      previousAssayerId: null,
      newAssayerId: owner,
      reassignedBy: owner,
      reason: 'Initial ownership',
      requestId: `${RUN}-REQ-D0`,
      ownershipStartedAt: new Date(),
      ownershipEndedAt: null,
    }));

    let refusal: any;
    try {
      await repo.save(repo.create({
        assignmentId,
        previousAssayerId: owner,
        newAssayerId: other,
        reassignedBy: owner,
        reason: 'Second open interval, which must not be possible',
        requestId: `${RUN}-REQ-D1`,
        ownershipStartedAt: new Date(),
        ownershipEndedAt: null,
      }));
    } catch (e) {
      refusal = e;
    }

    expect(refusal).toBeDefined();
    expect(refusal.code ?? refusal.driverError?.code).toBe('23505');
    expect(String(refusal.message)).toContain('idx_assignment_reassignments_active_owner');
  });

  it('leaves nothing behind but the rows it created', async () => {
    /**
     * Scoped to THIS run's writes, which is the only question this suite can honestly answer.
     *
     * It used to count every row in `assignment_reassignments` whose assignment was not an
     * `RFIX-` fixture and require that to be zero — an assertion about the whole table, on a
     * database this suite shares. It passed for as long as nothing else had ever written a
     * lineage row, and then failed the moment something did: found here with two rows reading
     * `reason: 'BBX certification reassign reason'` against `ASN-2026-000029` and
     * `ASN-2026-000033`, from a certification run happening alongside it. Neither row was this
     * suite's, neither was a defect, and the failure said nothing about the code under test.
     *
     * Worse than the false alarm is what it invites: the obvious way to make a global cleanliness
     * assertion pass is to delete the rows making it fail, and those rows belong to somebody else.
     * The file's own header states the rule this restores — "It touches nothing it did not write."
     *
     * Every lineage row this suite writes carries `request_id` beginning with `RUN`, and every
     * assignment it creates is numbered `RFIX-…`, so the intent stated below is exactly expressible:
     * of the rows THIS RUN wrote, none landed on an assignment this run does not own.
     */
    const strays = await ds.query(
      `SELECT count(*)::int AS n FROM assignment_reassignments r
       JOIN assignments a ON a.id = r.assignment_id
       WHERE r.request_id LIKE $1
         AND a.assignment_number NOT LIKE 'RFIX-%'`,
      [`${RUN}-%`],
    );
    // Read as: this suite has written into no assignment's lineage but its own fixtures'.
    expect(strays[0].n).toBe(0);

    /**
     * The other half of the same promise, and the half the global count could not express at all:
     * every lineage row this run wrote sits on an assignment this run is tracking for deletion.
     *
     * That is what makes `afterAll` sufficient. It deletes lineage by `assignment_id = ANY(...)`
     * over `createdAssignmentIds`, so a row written against an assignment that never made it into
     * that array is a permanent leak — and it is a leak the old assertion could not have seen,
     * because the leaked row would be attached to an `RFIX-` assignment and therefore excluded by
     * the very `NOT LIKE` it was built on.
     */
    const untracked = await ds.query(
      `SELECT count(*)::int AS n FROM assignment_reassignments
        WHERE request_id LIKE $1 AND NOT (assignment_id = ANY($2))`,
      [`${RUN}-%`, createdAssignmentIds],
    );
    expect(untracked[0].n).toBe(0);
  });
});
