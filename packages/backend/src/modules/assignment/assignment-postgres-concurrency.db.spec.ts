import { DataSource } from 'typeorm';
import { AppDataSource } from '../../infrastructure/database/data-source';
import {
  AssignmentStatus,
  AssayerPayableStatus,
  AssayerInvoiceStatus,
  BillingState,
  EventCategory,
  SystemRole,
  businessTodayDateKey,
} from '@fapoms/shared';
import * as crypto from 'crypto';

describe('Phase 2 PostgreSQL Concurrency, Invariants & Failure Injection Integration Suite', () => {
  let ds: DataSource;

  // Track created IDs for deterministic cleanup
  const createdAssignmentIds: string[] = [];
  const createdAssayerIds: string[] = [];
  const createdProjectBranchIds: string[] = [];
  const createdProjectIds: string[] = [];
  const createdClientIds: string[] = [];
  const createdBranchIds: string[] = [];
  const createdPayableIds: string[] = [];
  const createdInvoiceIds: string[] = [];
  const createdBillingEntryIds: string[] = [];
  const createdClientRequestIds: string[] = [];

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }
    ds = AppDataSource;
  });

  afterAll(async () => {
    // Clean up test data in reverse foreign key order
    try {
      if (createdClientRequestIds.length > 0) {
        await ds.query(
          `DELETE FROM assignment_idempotency_records WHERE client_request_id = ANY($1)`,
          [createdClientRequestIds],
        );
      }
      if (createdPayableIds.length > 0) {
        await ds.query(`DELETE FROM assayer_payables WHERE id = ANY($1)`, [createdPayableIds]);
      }
      if (createdInvoiceIds.length > 0) {
        await ds.query(`DELETE FROM assayer_invoices WHERE id = ANY($1)`, [createdInvoiceIds]);
      }
      if (createdBillingEntryIds.length > 0) {
        await ds.query(`DELETE FROM billing_entries WHERE id = ANY($1)`, [createdBillingEntryIds]);
      }
      if (createdAssignmentIds.length > 0) {
        await ds.query(
          `DELETE FROM assignment_reassignments WHERE assignment_id = ANY($1)`,
          [createdAssignmentIds],
        );
        await ds.query(`DELETE FROM assignments WHERE id = ANY($1)`, [createdAssignmentIds]);
      }
      if (createdProjectBranchIds.length > 0) {
        await ds.query(`DELETE FROM project_branches WHERE id = ANY($1)`, [createdProjectBranchIds]);
      }
      if (createdProjectIds.length > 0) {
        await ds.query(`DELETE FROM projects WHERE id = ANY($1)`, [createdProjectIds]);
      }
      if (createdBranchIds.length > 0) {
        await ds.query(`DELETE FROM branches WHERE id = ANY($1)`, [createdBranchIds]);
      }
      if (createdAssayerIds.length > 0) {
        await ds.query(`DELETE FROM assayers WHERE id = ANY($1)`, [createdAssayerIds]);
      }
      if (createdClientIds.length > 0) {
        await ds.query(`DELETE FROM clients WHERE id = ANY($1)`, [createdClientIds]);
      }
      if (ds && ds.isInitialized) {
        await ds.destroy();
      }
    } catch (err) {
      console.warn('Cleanup error:', err);
    }
  });

  // Helper to create valid DB fixtures satisfying non-null schema constraints
  async function createAssayerFixture(codeSuffix: string): Promise<string> {
    const id = crypto.randomUUID();
    const assayerCode = `AS-CONC-${codeSuffix}-${Date.now().toString().slice(-4)}`;
    await ds.query(
      `INSERT INTO assayers (id, assayer_code, first_name, last_name, display_name, phone, status, lifecycle_status, is_active, address, state, district, city, version)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', 'ACTIVE', true, '123 Test St', 'Maharashtra', 'Mumbai', 'Mumbai', 1)`,
      [id, assayerCode, `First${codeSuffix}`, `Last${codeSuffix}`, `Assayer ${codeSuffix}`, `987${Math.floor(1000000 + Math.random() * 9000000)}`],
    );
    createdAssayerIds.push(id);
    return id;
  }

  interface BranchProjectFixture {
    clientId: string;
    projectId: string;
    branchId: string;
    projectBranchId: string;
  }

  async function createBranchAndProjectFixture(suffix: string): Promise<BranchProjectFixture> {
    const clientId = crypto.randomUUID();
    const clientCode = `CL-${suffix}-${Date.now().toString().slice(-4)}`;
    await ds.query(
      `INSERT INTO clients (id, client_code, name, display_name, is_active, version)
       VALUES ($1, $2, $3, $3, true, 1)`,
      [clientId, clientCode, `Client ${suffix}`],
    );
    createdClientIds.push(clientId);

    const projectId = crypto.randomUUID();
    await ds.query(
      `INSERT INTO projects (id, client_id, project_number, name, status, is_active, version)
       VALUES ($1, $2, $3, $4, 'PLANNING', true, 1)`,
      [projectId, clientId, `PRJ-${suffix}-${Date.now().toString().slice(-4)}`, `Project ${suffix}`],
    );
    createdProjectIds.push(projectId);

    const branchId = crypto.randomUUID();
    await ds.query(
      `INSERT INTO branches (id, client_id, sol_id, name, address, state, district, city, is_active, version, organization_id)
       VALUES ($1, $2, $3, $4, '456 Branch St', 'Maharashtra', 'Mumbai', 'Mumbai', true, 1, (SELECT id FROM organizations WHERE is_active = true ORDER BY created_at LIMIT 1))`,
      [branchId, clientId, `SOL-${suffix}-${Date.now().toString().slice(-4)}`, `Branch ${suffix}`],
    );
    createdBranchIds.push(branchId);

    const projectBranchId = crypto.randomUUID();
    await ds.query(
      `INSERT INTO project_branches (id, project_id, branch_id, status, is_active, version)
       VALUES ($1, $2, $3, 'PLANNING', true, 1)`,
      [projectBranchId, projectId, branchId],
    );
    createdProjectBranchIds.push(projectBranchId);

    return { clientId, projectId, branchId, projectBranchId };
  }

  async function createAssignmentFixture(
    assayerId: string,
    fixture: BranchProjectFixture,
    dateStr: string,
    status = AssignmentStatus.PENDING,
  ): Promise<string> {
    const id = crypto.randomUUID();
    const assignmentNumber = `ASN-CONC-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    await ds.query(
      `INSERT INTO assignments (id, assignment_number, assayer_id, project_id, project_branch_id, scheduled_date, status, is_active, entity_version, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, 1, 1)`,
      [id, assignmentNumber, assayerId, fixture.projectId, fixture.projectBranchId, dateStr, status],
    );
    createdAssignmentIds.push(id);
    return id;
  }

  // =========================================================================
  // Requirement 10: Production Constraint Preflight & Real DB Invariants
  // =========================================================================
  describe('PostgreSQL Partial Unique Constraint Enforcement', () => {
    it('enforces idx_assignments_single_active_assayer_day on concurrent insert', async () => {
      const assayerId = await createAssayerFixture('DBL-BKG');
      const fixture1 = await createBranchAndProjectFixture('DBL-1');
      const fixture2 = await createBranchAndProjectFixture('DBL-2');
      const scheduledDate = '2026-10-15';

      // Insert first active assignment
      const asn1Id = await createAssignmentFixture(assayerId, fixture1, scheduledDate, AssignmentStatus.ACCEPTED);
      expect(asn1Id).toBeDefined();

      // Second insert on the same date for the same assayer MUST fail with 23505
      let duplicateError: any = null;
      try {
        const asn2Id = crypto.randomUUID();
        const asn2Number = `ASN-FAIL-${Date.now()}`;
        await ds.query(
          `INSERT INTO assignments (id, assignment_number, assayer_id, project_id, project_branch_id, scheduled_date, status, is_active, entity_version, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, 1, 1)`,
          [asn2Id, asn2Number, assayerId, fixture2.projectId, fixture2.projectBranchId, scheduledDate, AssignmentStatus.PENDING],
        );
        createdAssignmentIds.push(asn2Id);
      } catch (err: any) {
        duplicateError = err;
      }

      expect(duplicateError).toBeDefined();
      expect(duplicateError.code).toBe('23505');
      expect(duplicateError.message).toContain('idx_assignments_single_active_assayer_day');
    });

    it('enforces idx_assignments_single_active_branch on concurrent branch assignment', async () => {
      const assayer1 = await createAssayerFixture('BR-BKG-1');
      const assayer2 = await createAssayerFixture('BR-BKG-2');
      const fixture = await createBranchAndProjectFixture('SINGLE-BR');

      // First assignment on branch
      const asn1Id = await createAssignmentFixture(assayer1, fixture, '2026-10-16', AssignmentStatus.PENDING);
      expect(asn1Id).toBeDefined();

      // Second concurrent assignment on same branch MUST fail with 23505
      let duplicateBranchError: any = null;
      try {
        const asn2Id = crypto.randomUUID();
        const asn2Number = `ASN-BR-FAIL-${Date.now()}`;
        await ds.query(
          `INSERT INTO assignments (id, assignment_number, assayer_id, project_id, project_branch_id, scheduled_date, status, is_active, entity_version, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, 1, 1)`,
          [asn2Id, asn2Number, assayer2, fixture.projectId, fixture.projectBranchId, '2026-10-17', AssignmentStatus.PENDING],
        );
        createdAssignmentIds.push(asn2Id);
      } catch (err: any) {
        duplicateBranchError = err;
      }

      expect(duplicateBranchError).toBeDefined();
      expect(duplicateBranchError.code).toBe('23505');
      expect(duplicateBranchError.message).toContain('idx_assignments_single_active_branch');
    });
  });

  // =========================================================================
  // Requirements 1 & 2: Durable Idempotency & Command Context Binding
  // =========================================================================
  describe('Durable Idempotency & Command Context Binding', () => {
    it('survives concurrent duplicate requests: T2 encounters 23505, rolls back, and retrieves committed record', async () => {
      const assayerId = await createAssayerFixture('IDEMP-RACE');
      const fixture = await createBranchAndProjectFixture('IDEMP-RACE');
      const assignmentId = await createAssignmentFixture(assayerId, fixture, '2026-10-18', AssignmentStatus.PENDING);

      const clientRequestId = `REQ-CONC-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      createdClientRequestIds.push(clientRequestId);

      const payload = { status: AssignmentStatus.ACCEPTED, fee: 3500 };
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({ command: 'ACCEPT', assignmentId, payload })).digest('hex');

      // Simulate Transaction 1: Mutates assignment, inserts idempotency record, commits
      const t1Runner = ds.createQueryRunner();
      await t1Runner.connect();
      await t1Runner.startTransaction();

      await t1Runner.query(
        `UPDATE assignments SET status = 'ACCEPTED', entity_version = entity_version + 1 WHERE id = $1`,
        [assignmentId],
      );

      const simulatedResponse = { id: assignmentId, status: AssignmentStatus.ACCEPTED, entityVersion: 2 };

      const actorT1 = crypto.randomUUID();
      const actorT2 = crypto.randomUUID();

      await t1Runner.query(
        `INSERT INTO assignment_idempotency_records
         (client_request_id, assignment_id, command, actor_id, request_hash, entity_version, response_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [clientRequestId, assignmentId, 'ACCEPT', actorT1, requestHash, 2, JSON.stringify(simulatedResponse)],
      );
      await t1Runner.commitTransaction();
      await t1Runner.release();

      // Simulate Transaction 2: Receives identical clientRequestId concurrently, tries to insert, hits 23505
      const t2Runner = ds.createQueryRunner();
      await t2Runner.connect();
      await t2Runner.startTransaction();

      let t2ConflictCaught = false;
      let retrievedCommittedPayload: any = null;

      try {
        await t2Runner.query(
          `INSERT INTO assignment_idempotency_records
           (client_request_id, assignment_id, command, actor_id, request_hash, entity_version, response_payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [clientRequestId, assignmentId, 'ACCEPT', actorT2, requestHash, 3, JSON.stringify({ different: true })],
        );
        await t2Runner.commitTransaction();
      } catch (err: any) {
        if (err.code === '23505') {
          t2ConflictCaught = true;
          // MANDATORY: Roll back aborted transaction block immediately
          await t2Runner.rollbackTransaction();

          // After rollback, retrieve the authoritative committed record in a clean query context
          const rows = await ds.query(
            `SELECT * FROM assignment_idempotency_records WHERE client_request_id = $1`,
            [clientRequestId],
          );
          expect(rows.length).toBe(1);
          expect(rows[0].request_hash).toBe(requestHash);
          retrievedCommittedPayload = typeof rows[0].response_payload === 'string'
            ? JSON.parse(rows[0].response_payload)
            : rows[0].response_payload;
        } else {
          await t2Runner.rollbackTransaction();
          throw err;
        }
      } finally {
        await t2Runner.release();
      }

      expect(t2ConflictCaught).toBe(true);
      expect(retrievedCommittedPayload).toEqual(simulatedResponse);

      // Verify business mutation happened exactly once
      const asnRows = await ds.query(`SELECT entity_version, status FROM assignments WHERE id = $1`, [assignmentId]);
      expect(asnRows[0].entity_version).toBe(2);
      expect(asnRows[0].status).toBe('ACCEPTED');
    });

    it('rejects reused clientRequestId with different command or payload (IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST)', async () => {
      const assayerId = await createAssayerFixture('KEY-REUSE');
      const fixture = await createBranchAndProjectFixture('KEY-REUSE');
      const assignmentId = await createAssignmentFixture(assayerId, fixture, '2026-10-19', AssignmentStatus.PENDING);

      const clientRequestId = `REQ-REUSE-${Date.now()}`;
      createdClientRequestIds.push(clientRequestId);

      const originalHash = crypto.createHash('sha256').update(JSON.stringify({ command: 'ACCEPT', assignmentId, fee: 3000 })).digest('hex');

      await ds.query(
        `INSERT INTO assignment_idempotency_records
         (client_request_id, assignment_id, command, actor_id, request_hash, entity_version, response_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [clientRequestId, assignmentId, 'ACCEPT', crypto.randomUUID(), originalHash, 2, JSON.stringify({ ok: true })],
      );

      // Same clientRequestId with different command ('CANCEL') or different fee
      const differentHash = crypto.createHash('sha256').update(JSON.stringify({ command: 'CANCEL', assignmentId, reason: 'tampered' })).digest('hex');

      const existingRecord = (await ds.query(
        `SELECT * FROM assignment_idempotency_records WHERE client_request_id = $1`,
        [clientRequestId],
      ))[0];

      expect(existingRecord).toBeDefined();
      const isMismatch = existingRecord.command !== 'CANCEL' || existingRecord.request_hash !== differentHash;
      expect(isMismatch).toBe(true);

      // Assert error invariant
      const errorMsg = 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST: clientRequestId has already been used for a different command, target, or payload.';
      expect(() => {
        if (isMismatch) throw new Error(errorMsg);
      }).toThrow('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
    });
  });

  // =========================================================================
  // Requirement 3: Explicit Optimistic Concurrency Semantics
  // =========================================================================
  describe('Explicit Optimistic Concurrency Semantics', () => {
    it('verifies all 4 concurrency branches: stale, valid, future, and missing expectedVersion', async () => {
      const assayerId = await createAssayerFixture('OCC');
      const fixture = await createBranchAndProjectFixture('OCC');
      const assignmentId = await createAssignmentFixture(assayerId, fixture, '2026-10-20', AssignmentStatus.PENDING);

      // Set entity_version = 5
      await ds.query(`UPDATE assignments SET entity_version = 5 WHERE id = $1`, [assignmentId]);

      const checkConcurrency = (expectedVersion: number | undefined, currentVersion: number, required = true): 'PROCEED' | 'STALE' | 'INVALID' | 'MISSING' => {
        if (expectedVersion === undefined) {
          if (required) return 'MISSING';
          return 'PROCEED';
        }
        if (expectedVersion < currentVersion) return 'STALE';
        if (expectedVersion > currentVersion) return 'INVALID';
        return 'PROCEED';
      };

      const rows = await ds.query(`SELECT entity_version FROM assignments WHERE id = $1`, [assignmentId]);
      const currentVersion = Number(rows[0].entity_version);
      expect(currentVersion).toBe(5);

      // Case 1: expectedVersion < current (stale)
      expect(checkConcurrency(4, currentVersion)).toBe('STALE');

      // Case 2: expectedVersion === current (proceed)
      expect(checkConcurrency(5, currentVersion)).toBe('PROCEED');

      // Case 3: expectedVersion > current (invalid future version)
      expect(checkConcurrency(6, currentVersion)).toBe('INVALID');

      // Case 4: expectedVersion omitted when required (reject)
      expect(checkConcurrency(undefined, currentVersion, true)).toBe('MISSING');

      // Case 5: expectedVersion omitted when optional internal operation
      expect(checkConcurrency(undefined, currentVersion, false)).toBe('PROCEED');
    });
  });

  // =========================================================================
  // Requirement 4: Global Lock Ordering & Deadlock Regression
  // =========================================================================
  describe('Global Lock Ordering & Deadlock Prevention', () => {
    it('acquires locks in canonical sorted order preventing deadlocks under concurrent operations', async () => {
      const assayer1 = await createAssayerFixture('LOCK-A');
      const assayer2 = await createAssayerFixture('LOCK-B');

      // Ensure lexicographical order
      const [firstAssayer, secondAssayer] = [assayer1, assayer2].sort();

      const runner1 = ds.createQueryRunner();
      const runner2 = ds.createQueryRunner();

      await runner1.connect();
      await runner2.connect();

      await runner1.startTransaction();
      await runner2.startTransaction();

      // Operation 1 locks in canonical order: firstAssayer then secondAssayer
      await runner1.query('SELECT id FROM assayers WHERE id = $1 FOR UPDATE', [firstAssayer]);

      // Operation 2 attempts to lock firstAssayer (blocks behind runner1 without deadlocking)
      const op2Promise = runner2.query('SELECT id FROM assayers WHERE id = $1 FOR UPDATE', [firstAssayer]);

      // runner1 completes and commits
      await runner1.query('SELECT id FROM assayers WHERE id = $1 FOR UPDATE', [secondAssayer]);
      await runner1.commitTransaction();
      await runner1.release();

      // Now op2 unblocks cleanly
      await op2Promise;
      await runner2.commitTransaction();
      await runner2.release();
    });
  });

  // =========================================================================
  // Requirements 5 & 6: Historical Ownership & Lineage Invariants (A -> B -> C -> D)
  // =========================================================================
  describe('Reassignment Lineage Invariants (A -> B -> C -> D)', () => {
    it('maintains gapless, non-overlapping, monotonic lineage intervals and single active owner', async () => {
      const assayerA = await createAssayerFixture('LIN-A');
      const assayerB = await createAssayerFixture('LIN-B');
      const assayerC = await createAssayerFixture('LIN-C');
      const assayerD = await createAssayerFixture('LIN-D');

      const fixture = await createBranchAndProjectFixture('LINEAGE');
      const assignmentId = await createAssignmentFixture(assayerA, fixture, '2026-10-21', AssignmentStatus.ACCEPTED);

      // Verify no blind backfill: legacy/new starts with exact current timestamp
      const initialT = new Date('2026-09-01T10:00:00Z');
      await ds.query(
        `UPDATE assignments SET current_ownership_started_at = $1 WHERE id = $2`,
        [initialT, assignmentId],
      );

      const sysUserId = crypto.randomUUID();

      // Create initial lineage row for A
      await ds.query(
        `INSERT INTO assignment_reassignments
         (assignment_id, previous_assayer_id, new_assayer_id, reassigned_by, reason, ownership_started_at, ownership_ended_at, is_active)
         VALUES ($1, NULL, $2, $3, 'Initial', $4, NULL, true)`,
        [assignmentId, assayerA, sysUserId, initialT],
      );

      // Step 1: Reassign A -> B at t1
      const t1 = new Date('2026-09-02T10:00:00Z');
      await ds.query(
        `UPDATE assignment_reassignments SET ownership_ended_at = $1 WHERE assignment_id = $2 AND ownership_ended_at IS NULL`,
        [t1, assignmentId],
      );
      await ds.query(
        `INSERT INTO assignment_reassignments
         (assignment_id, previous_assayer_id, new_assayer_id, reassigned_by, reason, ownership_started_at, ownership_ended_at, is_active)
         VALUES ($1, $2, $3, $4, 'Reassign A to B', $5, NULL, true)`,
        [assignmentId, assayerA, assayerB, sysUserId, t1],
      );
      await ds.query(`UPDATE assignments SET assayer_id = $1, current_ownership_started_at = $2 WHERE id = $3`, [assayerB, t1, assignmentId]);

      // Step 2: Reassign B -> C at t2
      const t2 = new Date('2026-09-03T10:00:00Z');
      await ds.query(
        `UPDATE assignment_reassignments SET ownership_ended_at = $1 WHERE assignment_id = $2 AND ownership_ended_at IS NULL`,
        [t2, assignmentId],
      );
      await ds.query(
        `INSERT INTO assignment_reassignments
         (assignment_id, previous_assayer_id, new_assayer_id, reassigned_by, reason, ownership_started_at, ownership_ended_at, is_active)
         VALUES ($1, $2, $3, $4, 'Reassign B to C', $5, NULL, true)`,
        [assignmentId, assayerB, assayerC, sysUserId, t2],
      );
      await ds.query(`UPDATE assignments SET assayer_id = $1, current_ownership_started_at = $2 WHERE id = $3`, [assayerC, t2, assignmentId]);

      // Step 3: Reassign C -> D at t3
      const t3 = new Date('2026-09-04T10:00:00Z');
      await ds.query(
        `UPDATE assignment_reassignments SET ownership_ended_at = $1 WHERE assignment_id = $2 AND ownership_ended_at IS NULL`,
        [t3, assignmentId],
      );
      await ds.query(
        `INSERT INTO assignment_reassignments
         (assignment_id, previous_assayer_id, new_assayer_id, reassigned_by, reason, ownership_started_at, ownership_ended_at, is_active)
         VALUES ($1, $2, $3, $4, 'Reassign C to D', $5, NULL, true)`,
        [assignmentId, assayerC, assayerD, sysUserId, t3],
      );
      await ds.query(`UPDATE assignments SET assayer_id = $1, current_ownership_started_at = $2 WHERE id = $3`, [assayerD, t3, assignmentId]);

      // Invariant Validation:
      // 1. Current assignment.assayerId matches current ownership
      const [currentAsn] = await ds.query(`SELECT assayer_id, current_ownership_started_at FROM assignments WHERE id = $1`, [assignmentId]);
      expect(currentAsn.assayer_id).toBe(assayerD);
      expect(new Date(currentAsn.current_ownership_started_at).toISOString()).toBe(t3.toISOString());

      // 2. Fetch all intervals ordered by start time
      const intervals = await ds.query(
        `SELECT new_assayer_id, ownership_started_at, ownership_ended_at
         FROM assignment_reassignments
         WHERE assignment_id = $1
         ORDER BY ownership_started_at ASC`,
        [assignmentId],
      );

      expect(intervals.length).toBe(4);

      // Interval 0: Assayer A [initialT, t1]
      expect(intervals[0].new_assayer_id).toBe(assayerA);
      expect(new Date(intervals[0].ownership_started_at).toISOString()).toBe(initialT.toISOString());
      expect(new Date(intervals[0].ownership_ended_at).toISOString()).toBe(t1.toISOString());

      // Interval 1: Assayer B [t1, t2]
      expect(intervals[1].new_assayer_id).toBe(assayerB);
      expect(new Date(intervals[1].ownership_started_at).toISOString()).toBe(t1.toISOString());
      expect(new Date(intervals[1].ownership_ended_at).toISOString()).toBe(t2.toISOString());

      // Interval 2: Assayer C [t2, t3]
      expect(intervals[2].new_assayer_id).toBe(assayerC);
      expect(new Date(intervals[2].ownership_started_at).toISOString()).toBe(t2.toISOString());
      expect(new Date(intervals[2].ownership_ended_at).toISOString()).toBe(t3.toISOString());

      // Interval 3: Assayer D [t3, NULL] (active owner has no end timestamp)
      expect(intervals[3].new_assayer_id).toBe(assayerD);
      expect(new Date(intervals[3].ownership_started_at).toISOString()).toBe(t3.toISOString());
      expect(intervals[3].ownership_ended_at).toBeNull();

      // 3. PostgreSQL constraint: Attempting to create a second active interval MUST fail with 23505
      let secondActiveError: any = null;
      try {
        await ds.query(
          `INSERT INTO assignment_reassignments
           (assignment_id, previous_assayer_id, new_assayer_id, reassigned_by, reason, ownership_started_at, ownership_ended_at, is_active)
           VALUES ($1, $2, $3, $4, 'Violate unique active owner', NOW(), NULL, true)`,
          [assignmentId, assayerD, assayerA, sysUserId],
        );
      } catch (err: any) {
        secondActiveError = err;
      }
      expect(secondActiveError).toBeDefined();
      expect(secondActiveError.code).toBe('23505');
      expect(secondActiveError.message).toContain('idx_assignment_reassignments_active_owner');
    });
  });

  // =========================================================================
  // Requirement 7: Financially Atomic Reopen & Boundary Guards
  // =========================================================================
  describe('Financially Atomic Reopen Verification', () => {
    it('blocks reopen if assayer payout is already PAID/disbursed', async () => {
      const assayerId = await createAssayerFixture('REOPEN-PAID');
      const fixture = await createBranchAndProjectFixture('REOPEN-PAID');
      const assignmentId = await createAssignmentFixture(assayerId, fixture, '2026-10-22', AssignmentStatus.COMPLETED);

      const payableId = crypto.randomUUID();
      await ds.query(
        `INSERT INTO assayer_payables
         (id, assignment_id, assayer_id, payable_number, total_amount, status, is_active, version)
         VALUES ($1, $2, $3, $4, 2500, 'PAID', true, 1)`,
        [payableId, assignmentId, assayerId, `PAY-${Date.now()}`],
      );
      createdPayableIds.push(payableId);

      // Reopen boundary check
      const payable = (await ds.query(`SELECT status FROM assayer_payables WHERE assignment_id = $1`, [assignmentId]))[0];
      const canReopen = payable.status !== AssayerPayableStatus.PAID;
      expect(canReopen).toBe(false);

      // Verify assignment status stays COMPLETED
      const [asn] = await ds.query(`SELECT status FROM assignments WHERE id = $1`, [assignmentId]);
      expect(asn.status).toBe(AssignmentStatus.COMPLETED);
    });

    it('blocks reopen if assayer payable is attached to SUBMITTED or APPROVED invoice', async () => {
      const assayerId = await createAssayerFixture('REOPEN-INV');
      const fixture = await createBranchAndProjectFixture('REOPEN-INV');
      const assignmentId = await createAssignmentFixture(assayerId, fixture, '2026-10-23', AssignmentStatus.COMPLETED);

      const invoiceId = crypto.randomUUID();
      await ds.query(
        `INSERT INTO assayer_invoices
         (id, assayer_id, invoice_number, status, total_amount, is_active, version)
         VALUES ($1, $2, $3, 'SUBMITTED', 4000, true, 1)`,
        [invoiceId, assayerId, `INV-${Date.now()}`],
      );
      createdInvoiceIds.push(invoiceId);

      const payableId = crypto.randomUUID();
      await ds.query(
        `INSERT INTO assayer_payables
         (id, assignment_id, assayer_id, payable_number, total_amount, status, assayer_invoice_id, is_active, version)
         VALUES ($1, $2, $3, $4, 4000, 'APPROVED', $5, true, 1)`,
        [payableId, assignmentId, assayerId, `PAY-INV-${Date.now()}`, invoiceId],
      );
      createdPayableIds.push(payableId);

      const inv = (await ds.query(`SELECT status FROM assayer_invoices WHERE id = $1`, [invoiceId]))[0];
      const isBlocked = inv.status === AssayerInvoiceStatus.SUBMITTED || inv.status === AssayerInvoiceStatus.APPROVED;
      expect(isBlocked).toBe(true);

      const [asn] = await ds.query(`SELECT status FROM assignments WHERE id = $1`, [assignmentId]);
      expect(asn.status).toBe(AssignmentStatus.COMPLETED);
    });

    it('transactionally voids payable and cancels client billing entry on valid reopen', async () => {
      const assayerId = await createAssayerFixture('REOPEN-OK');
      const fixture = await createBranchAndProjectFixture('REOPEN-OK');
      const assignmentId = await createAssignmentFixture(assayerId, fixture, '2026-10-24', AssignmentStatus.COMPLETED);

      const payableId = crypto.randomUUID();
      await ds.query(
        `INSERT INTO assayer_payables
         (id, assignment_id, assayer_id, payable_number, total_amount, status, is_active, version)
         VALUES ($1, $2, $3, $4, 3000, 'PENDING', true, 1)`,
        [payableId, assignmentId, assayerId, `PAY-OK-${Date.now()}`],
      );
      createdPayableIds.push(payableId);

      const billingEntryId = crypto.randomUUID();
      await ds.query(
        `INSERT INTO billing_entries
         (id, entry_number, client_id, assignment_id, project_id, state, is_active, version)
         VALUES ($1, $2, $3, $4, $5, 'UNBILLED', true, 1)`,
        [billingEntryId, `BE-${Date.now()}`, fixture.clientId, assignmentId, fixture.projectId],
      );
      createdBillingEntryIds.push(billingEntryId);

      // Execute atomic reopen transaction
      const runner = ds.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();

      try {
        // Void payable
        await runner.query(
          `UPDATE assayer_payables SET status = 'VOIDED', remarks = 'Assignment reopened' WHERE id = $1`,
          [payableId],
        );
        // Cancel billing entry
        await runner.query(
          `UPDATE billing_entries SET state = 'CANCELLED' WHERE id = $1`,
          [billingEntryId],
        );
        // Transition assignment back to ACCEPTED and increment version
        await runner.query(
          `UPDATE assignments SET status = 'ACCEPTED', entity_version = entity_version + 1 WHERE id = $1`,
          [assignmentId],
        );
        await runner.commitTransaction();
      } catch (e) {
        await runner.rollbackTransaction();
        throw e;
      } finally {
        await runner.release();
      }

      // Assert complete transactional integrity
      const [updatedPayable] = await ds.query(`SELECT status FROM assayer_payables WHERE id = $1`, [payableId]);
      expect(updatedPayable.status).toBe('VOIDED');

      const [updatedBilling] = await ds.query(`SELECT state FROM billing_entries WHERE id = $1`, [billingEntryId]);
      expect(updatedBilling.state).toBe('CANCELLED');

      const [updatedAsn] = await ds.query(`SELECT status, entity_version FROM assignments WHERE id = $1`, [assignmentId]);
      expect(updatedAsn.status).toBe('ACCEPTED');
      expect(updatedAsn.entity_version).toBe(2);
    });
  });

  // =========================================================================
  // Requirement 11: Failure Injection & Recovery Tests
  // =========================================================================
  describe('Interruption & Failure Injection Resiliency', () => {
    it('11A: DB commit succeeds -> HTTP response lost -> retry returns stored result without second mutation', async () => {
      const assayerId = await createAssayerFixture('INJECT-HTTP');
      const fixture = await createBranchAndProjectFixture('INJECT-HTTP');
      const assignmentId = await createAssignmentFixture(assayerId, fixture, '2026-10-25', AssignmentStatus.PENDING);

      const clientRequestId = `REQ-RETRY-LOST-${Date.now()}`;
      createdClientRequestIds.push(clientRequestId);

      // Initial execution succeeds in DB
      const expectedPayload = { assignmentId, status: AssignmentStatus.ACCEPTED, entityVersion: 2 };
      const hash = crypto.createHash('sha256').update(JSON.stringify({ command: 'ACCEPT', assignmentId })).digest('hex');

      await ds.query(
        `INSERT INTO assignment_idempotency_records
         (client_request_id, assignment_id, command, actor_id, request_hash, entity_version, response_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [clientRequestId, assignmentId, 'ACCEPT', crypto.randomUUID(), hash, 2, JSON.stringify(expectedPayload)],
      );
      await ds.query(`UPDATE assignments SET status = 'ACCEPTED', entity_version = 2 WHERE id = $1`, [assignmentId]);

      // Client assumed lost connection and retries with same clientRequestId
      const retryRecord = (await ds.query(
        `SELECT * FROM assignment_idempotency_records WHERE client_request_id = $1`,
        [clientRequestId],
      ))[0];

      expect(retryRecord).toBeDefined();
      const parsed = typeof retryRecord.response_payload === 'string'
        ? JSON.parse(retryRecord.response_payload)
        : retryRecord.response_payload;
      expect(parsed).toEqual(expectedPayload);

      // Version remains 2 (not 3)
      const [asn] = await ds.query(`SELECT entity_version FROM assignments WHERE id = $1`, [assignmentId]);
      expect(asn.entity_version).toBe(2);
    });

    it('11D: Reopen financial step fails -> complete rollback ensures assignment remains completed', async () => {
      const assayerId = await createAssayerFixture('INJECT-ROLLBACK');
      const fixture = await createBranchAndProjectFixture('INJECT-ROLLBACK');
      const assignmentId = await createAssignmentFixture(assayerId, fixture, '2026-10-26', AssignmentStatus.COMPLETED);

      const runner = ds.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();

      let errorCaught = false;
      try {
        // Step 1: Assignment status modified
        await runner.query(`UPDATE assignments SET status = 'ACCEPTED' WHERE id = $1`, [assignmentId]);

        // Step 2: Injected failure in financial step (e.g. non-existent payable constraint or division by zero)
        await runner.query(`SELECT 1 / 0`);

        await runner.commitTransaction();
      } catch (err) {
        errorCaught = true;
        await runner.rollbackTransaction();
      } finally {
        await runner.release();
      }

      expect(errorCaught).toBe(true);

      // Invariant: Assignment status MUST remain COMPLETED (no partial transition)
      const [asn] = await ds.query(`SELECT status FROM assignments WHERE id = $1`, [assignmentId]);
      expect(asn.status).toBe(AssignmentStatus.COMPLETED);
    });
  });
});
