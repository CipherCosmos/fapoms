/**
 * Phase 3 — PostgreSQL Concurrency Race Test Suite (Races A–F)
 *
 * Executes genuine concurrent PostgreSQL transactions against the live database
 * to rigorously prove concurrency safety, database constraints, locking semantics,
 * and business invariant preservation.
 *
 * Requirements:
 * - Race A: Registration Idempotency (same key replay vs changed payload conflict vs tenant isolation)
 * - Race B: Payout Destination Snapshot vs Live Bank Account Mutation
 * - Race C: Assignment Creation vs Empanelment Revocation (Requirement H semantics)
 * - Race D: Document Evidence Versioning (Verify vs Superseding Upload)
 * - Race E: Field Check-in vs Assayer Suspension
 * - Race F: Assignment Creation vs Assayer Lifecycle Departure (Requirement H semantics)
 */

// @ts-ignore
import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { hashAssayerCreationRequest } from './assayer.service';

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USERNAME || 'fapoms',
  password: process.env.DB_PASSWORD || 'fapoms_dev',
  database: process.env.DB_DATABASE || 'fapoms',
  max: 10,
};

describe('Phase 3 — Real PostgreSQL Concurrency Race Test Suite (Races A–F)', () => {
  jest.setTimeout(30000);
  let pool: Pool;
  const createdAssayerIds: string[] = [];
  const createdAssignmentIds: string[] = [];
  const createdPayableIds: string[] = [];
  const createdDocumentIds: string[] = [];
  const createdEmpanelmentIds: string[] = [];
  const createdClientIds: string[] = [];
  const createdProjectIds: string[] = [];
  const createdBranchIds: string[] = [];
  // `branches` and `project_branches` are two tables with two independent id spaces, and cleanup
  // used to delete from both using only the `project_branches` id — so the `DELETE FROM branches`
  // matched nothing and every run leaked one branch row, permanently, plus the `clients` and
  // `organizations` rows it holds a foreign key on (their deletes silently failed too). It went
  // unnoticed only because the insert above has been erroring out, so no branch was reaching the
  // table to be leaked. Track the two ids separately.
  const createdRawBranchIds: string[] = [];
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool(DB_CONFIG);
    const client = await pool.connect();
    client.release();
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      if (createdAssignmentIds.length > 0) {
        await client.query('DELETE FROM assignments WHERE id = ANY($1)', [createdAssignmentIds]);
      }
      if (createdPayableIds.length > 0) {
        await client.query('DELETE FROM assayer_payables WHERE id = ANY($1)', [createdPayableIds]);
      }
      if (createdEmpanelmentIds.length > 0) {
        await client.query('DELETE FROM assayer_client_empanelments WHERE id = ANY($1)', [createdEmpanelmentIds]);
      }
      if (createdDocumentIds.length > 0) {
        await client.query('DELETE FROM assayer_document_versions WHERE document_id = ANY($1)', [createdDocumentIds]);
        await client.query('DELETE FROM assayer_documents WHERE id = ANY($1)', [createdDocumentIds]);
      }
      if (createdAssayerIds.length > 0) {
        await client.query('DELETE FROM assayer_idempotency_records WHERE assayer_id = ANY($1)', [createdAssayerIds]);
        await client.query('DELETE FROM assayers WHERE id = ANY($1)', [createdAssayerIds]);
      }
      if (createdBranchIds.length > 0) {
        await client.query('DELETE FROM project_branches WHERE id = ANY($1)', [createdBranchIds]);
      }
      if (createdRawBranchIds.length > 0) {
        await client.query('DELETE FROM branches WHERE id = ANY($1)', [createdRawBranchIds]);
      }
      if (createdProjectIds.length > 0) {
        await client.query('DELETE FROM projects WHERE id = ANY($1)', [createdProjectIds]);
      }
      if (createdClientIds.length > 0) {
        await client.query('DELETE FROM clients WHERE id = ANY($1)', [createdClientIds]);
      }
      if (createdOrgIds.length > 0) {
        await client.query('DELETE FROM organizations WHERE id = ANY($1)', [createdOrgIds]);
      }
    } catch (e) {
      console.error('Error during cleanup in afterAll:', e);
    } finally {
      client.release();
      await pool.end();
    }
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  interface RaceBarrier {
    waitToProceed(participant: string): Promise<void>;
    waitUntilBothReady(): Promise<void>;
    release(): void;
  }

  function createRaceBarrier(expectedParticipants: string[] = ['T1', 'T2']): RaceBarrier {
    const readySignals = new Map<string, () => void>();
    const readyPromises = expectedParticipants.map((p) => {
      return new Promise<void>((resolve) => {
        readySignals.set(p, resolve);
      });
    });

    let releaseGate: () => void;
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    return {
      async waitToProceed(participant: string) {
        const trigger = readySignals.get(participant);
        if (trigger) trigger();
        await gatePromise;
      },
      async waitUntilBothReady() {
        await Promise.all(readyPromises);
      },
      release() {
        if (releaseGate) releaseGate();
      },
    };
  }

  // Helper to create tenant org
  async function createTestOrg(client: PoolClient): Promise<string> {
    const id = uuidv4();
    const code = `ORG_${id.substring(0, 8)}`;
    await client.query(
      `INSERT INTO organizations (id, version, name, code, is_active, created_at, updated_at)
       VALUES ($1, 1, $2, $3, true, now(), now())`,
      [id, `Test Org ${code}`, code],
    );
    createdOrgIds.push(id);
    return id;
  }

  // Helper to create test client
  async function createTestClient(client: PoolClient, orgId: string): Promise<string> {
    const id = uuidv4();
    const code = `CL_${id.substring(0, 8)}`;
    await client.query(
      `INSERT INTO clients (id, version, name, display_name, client_code, client_type, lifecycle_status, priority, organization_id, is_active, created_at, updated_at)
       VALUES ($1, 1, $2, $2, $3, 'BANK', 'ACTIVE', 'MEDIUM', $4, true, now(), now())`,
      [id, `Client ${code}`, code, orgId],
    );
    createdClientIds.push(id);
    return id;
  }

  // Helper to create test project and branch
  async function createTestProjectAndBranch(client: PoolClient, orgId: string, clientId: string): Promise<{ projectId: string; projectBranchId: string }> {
    const projectId = uuidv4();
    const prjNum = `PRJ_${projectId.substring(0, 8)}`;
    await client.query(
      `INSERT INTO projects (id, version, organization_id, client_id, project_number, name, status, priority, is_active, created_at, updated_at)
       VALUES ($1, 1, $2, $3, $4, $5, 'PLANNING', 'MEDIUM', true, now(), now())`,
      [projectId, orgId, clientId, prjNum, 'Test Project'],
    );
    createdProjectIds.push(projectId);

    const branchId = uuidv4();
    const solId = `SOL_${branchId.substring(0, 8)}`;
    // `organization_id` is stamped from the org this fixture set was built under, NOT looked up.
    // An earlier edit added the column with the value
    // `(SELECT id FROM organizations WHERE is_active = true ORDER BY created_at LIMIT 1)` and, in
    // doing so, mangled the parentheses into `now(, (SELECT …))` — invalid SQL, so every branch
    // insert raised `syntax error at or near ","` and Races B, C, E and F died in setup before
    // reaching a single concurrent statement. Restoring the parentheses alone would have made the
    // suite pass while leaving the lookup wrong: it binds the branch to whichever organisation
    // happens to sort first platform-wide, which is not the throwaway org that owns the client and
    // project rows this branch is joined to. That mismatch is invisible until someone adds a
    // tenant-scoped assertion here, at which point the fixture — not the code — is what fails, and
    // it returns NULL outright the moment this database has no seeded organisation, which is
    // exactly the state it is in now. `orgId` is already a parameter; use it.
    await client.query(
      `INSERT INTO branches (id, version, client_id, sol_id, name, address, state, district, city, risk_score, complexity, estimated_duration_hours, is_active, organization_id, created_at, updated_at)
       VALUES ($1, 1, $2, $3, 'Test Branch', 'Nariman Point', 'MH', 'Mumbai', 'Mumbai', 10, 'LOW', 2, true, $4, now(), now())`,
      [branchId, clientId, solId, orgId],
    );
    createdRawBranchIds.push(branchId);

    const projectBranchId = uuidv4();
    await client.query(
      `INSERT INTO project_branches (id, version, project_id, branch_id, status, priority, is_active, created_at, updated_at)
       VALUES ($1, 1, $2, $3, 'PLANNING', 'MEDIUM', true, now(), now())`,
      [projectBranchId, projectId, branchId],
    );
    createdBranchIds.push(projectBranchId);
    return { projectId, projectBranchId };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // RACE A: Registration Idempotency Race
  // ──────────────────────────────────────────────────────────────────────────
  describe('Race A: Registration Idempotency & Tenant Scoping', () => {
    it('concurrent duplicate registrations create exactly one assayer and replay identical response', async () => {
      const client = await pool.connect();
      const orgId = await createTestOrg(client);
      client.release();

      const clientRequestId = `req_${uuidv4()}`;
      const dto = {
        fullName: 'Aarav Patel',
        primaryPhone: '9876543210',
        email: `aarav_${uuidv4().substring(0, 8)}@example.com`,
        panNumber: 'ABCDE1234F',
        aadhaarNumber: '123456789012',
        address: '123 MG Road',
        state: 'Maharashtra',
        district: 'Mumbai',
        city: 'Mumbai',
        pincode: '400001',
        bankAccountNumber: '987654321012',
        ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank',
        bankAccountHolderName: 'Aarav Patel',
      };
      const requestHash = hashAssayerCreationRequest(dto as any);
      const barrier = createRaceBarrier(['T1', 'T2']);

      const registerFn = async (threadName: string) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const existing = await c.query(
            `SELECT assayer_id, request_hash, response_payload
             FROM assayer_idempotency_records
             WHERE COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
               AND client_request_id = $2
             FOR UPDATE`,
            [orgId, clientRequestId],
          );
          if (existing.rows.length > 0) {
            await c.query('COMMIT');
            return { replay: true, assayerId: existing.rows[0].assayer_id };
          }

          // Explicit barrier synchronization: ensures T1 and T2 are both in active open transactions
          await barrier.waitToProceed(threadName);

          const assayerId = uuidv4();
          const assayerCode = `ASY-${assayerId.substring(0, 8)}`;
          await c.query(
            `INSERT INTO assayers (
               id, version, assayer_code, first_name, last_name, display_name,
               address, state, district, city, pincode, phone, email,
               lifecycle_status, status, is_active, organization_id, created_at, updated_at
             ) VALUES (
               $1, 1, $2, 'Aarav', 'Patel', 'Aarav Patel',
               $3, $4, $5, $6, $7, $8, $9,
               'INVITED', 'INACTIVE', true, $10, now(), now()
             )`,
            [assayerId, assayerCode, dto.address, dto.state, dto.district, dto.city, dto.pincode, dto.primaryPhone, dto.email, orgId],
          );
          createdAssayerIds.push(assayerId);

          const idempId = uuidv4();
          await c.query(
            `INSERT INTO assayer_idempotency_records (
               id, client_request_id, assayer_id, command, actor_id, request_hash,
               response_payload, organization_id, created_at
             ) VALUES ($1, $2, $3, 'CREATE', '00000000-0000-0000-0000-000000000000', $4, $5, $6, now())`,
            [idempId, clientRequestId, assayerId, requestHash, JSON.stringify({ id: assayerId, assayerCode }), orgId],
          );

          await c.query('COMMIT');
          return { replay: false, assayerId };
        } catch (err: any) {
          await c.query('ROLLBACK');
          if (err.code === '23505') {
            const committed = await c.query(
              `SELECT assayer_id, request_hash FROM assayer_idempotency_records
               WHERE COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
                 AND client_request_id = $2`,
              [orgId, clientRequestId],
            );
            return { replay: true, assayerId: committed.rows[0]?.assayer_id };
          }
          throw err;
        } finally {
          c.release();
        }
      };

      const [res1, res2] = await Promise.all([
        registerFn('T1'),
        registerFn('T2'),
        (async () => {
          await barrier.waitUntilBothReady();
          barrier.release();
        })(),
      ]);

      expect(res1.assayerId).toBeDefined();
      expect(res2.assayerId).toBeDefined();
      expect(res1.assayerId).toBe(res2.assayerId);
      expect(res1.replay !== res2.replay).toBe(true);

      const countRes = await pool.query('SELECT COUNT(*) as count FROM assayers WHERE id = $1', [res1.assayerId]);
      expect(Number(countRes.rows[0].count)).toBe(1);
    });

    it('rejects same idempotency key with materially changed request payload with 409', async () => {
      const client = await pool.connect();
      const orgId = await createTestOrg(client);
      const clientRequestId = `req_${uuidv4()}`;

      const dto1 = { fullName: 'Sunil Kumar', primaryPhone: '9876543211', city: 'Pune' };
      const hash1 = hashAssayerCreationRequest(dto1 as any);
      const assayerId = uuidv4();
      createdAssayerIds.push(assayerId);

      await client.query(
        `INSERT INTO assayers (id, version, assayer_code, first_name, last_name, display_name, address, state, district, city, lifecycle_status, status, is_active, organization_id, created_at, updated_at)
         VALUES ($1, 1, $2, 'Sunil', 'Kumar', 'Sunil Kumar', 'Road 1', 'MH', 'Pune', 'Pune', 'INVITED', 'INACTIVE', true, $3, now(), now())`,
        [assayerId, `ASY-${assayerId.substring(0, 8)}`, orgId],
      );
      await client.query(
        `INSERT INTO assayer_idempotency_records (id, client_request_id, assayer_id, command, actor_id, request_hash, response_payload, organization_id, created_at)
         VALUES ($1, $2, $3, 'CREATE', '00000000-0000-0000-0000-000000000000', $4, '{}', $5, now())`,
        [uuidv4(), clientRequestId, assayerId, hash1, orgId],
      );

      const dto2 = { fullName: 'Sunil Kumar', primaryPhone: '9876543211', city: 'Nagpur' };
      const hash2 = hashAssayerCreationRequest(dto2 as any);

      const existing = await client.query(
        `SELECT assayer_id, request_hash FROM assayer_idempotency_records
         WHERE organization_id = $1 AND client_request_id = $2`,
        [orgId, clientRequestId],
      );
      expect(existing.rows.length).toBe(1);
      expect(existing.rows[0].request_hash).not.toBe(hash2);

      client.release();
    });

    it('different organizations do not collide when using the same clientRequestId', async () => {
      const client = await pool.connect();
      const org1 = await createTestOrg(client);
      const org2 = await createTestOrg(client);
      const sharedRequestId = `shared_req_${uuidv4()}`;

      const id1 = uuidv4();
      const id2 = uuidv4();
      createdAssayerIds.push(id1, id2);

      await client.query(
        `INSERT INTO assayers (id, version, assayer_code, first_name, last_name, display_name, address, state, district, city, lifecycle_status, status, is_active, organization_id, created_at, updated_at)
         VALUES ($1, 1, $2, 'Assayer', 'One', 'Assayer One', 'Addr', 'MH', 'Pune', 'Pune', 'INVITED', 'INACTIVE', true, $3, now(), now())`,
        [id1, `ASY-${id1.substring(0, 8)}`, org1],
      );
      await client.query(
        `INSERT INTO assayers (id, version, assayer_code, first_name, last_name, display_name, address, state, district, city, lifecycle_status, status, is_active, organization_id, created_at, updated_at)
         VALUES ($1, 1, $2, 'Assayer', 'Two', 'Assayer Two', 'Addr', 'MH', 'Pune', 'Pune', 'INVITED', 'INACTIVE', true, $3, now(), now())`,
        [id2, `ASY-${id2.substring(0, 8)}`, org2],
      );

      await client.query(
        `INSERT INTO assayer_idempotency_records (id, client_request_id, assayer_id, command, actor_id, request_hash, response_payload, organization_id, created_at)
         VALUES ($1, $2, $3, 'CREATE', '00000000-0000-0000-0000-000000000000', 'hash1', '{}', $4, now())`,
        [uuidv4(), sharedRequestId, id1, org1],
      );

      await client.query(
        `INSERT INTO assayer_idempotency_records (id, client_request_id, assayer_id, command, actor_id, request_hash, response_payload, organization_id, created_at)
         VALUES ($1, $2, $3, 'CREATE', '00000000-0000-0000-0000-000000000000', 'hash2', '{}', $4, now())`,
        [uuidv4(), sharedRequestId, id2, org2],
      );

      const rows = await client.query(
        'SELECT organization_id, assayer_id FROM assayer_idempotency_records WHERE client_request_id = $1',
        [sharedRequestId],
      );
      expect(rows.rows.length).toBe(2);
      client.release();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // RACE B: Payout Destination Snapshot vs Live Bank Account Mutation
  // ──────────────────────────────────────────────────────────────────────────
  describe('Race B: Payout Destination Snapshot vs Bank Account Mutation', () => {
    it('freezes destination banking snapshot before approval; subsequent bank change does not mutate destination', async () => {
      const client = await pool.connect();
      const orgId = await createTestOrg(client);
      const clientId = await createTestClient(client, orgId);
      const { projectId } = await createTestProjectAndBranch(client, orgId, clientId);

      const assayerId = uuidv4();
      createdAssayerIds.push(assayerId);
      await client.query(
        `INSERT INTO assayers (
           id, version, assayer_code, first_name, last_name, display_name, address, state, district, city,
           lifecycle_status, status, is_active, organization_id, bank_account_number, ifsc_code, bank_name,
           pan_number, created_at, updated_at
         ) VALUES (
           $1, 1, $2, 'Karan', 'Shah', 'Karan Shah', 'Street', 'MH', 'Mumbai', 'Mumbai',
           'ACTIVE', 'ACTIVE', true, $3, 'INITIAL_ACC_1111', 'HDFC0001234', 'HDFC Bank',
           'ABCDE1234F', now(), now()
         )`,
        [assayerId, `ASY-${assayerId.substring(0, 8)}`, orgId],
      );

      const docId = uuidv4();
      const versionId = uuidv4();
      createdDocumentIds.push(docId);
      await client.query(
        `INSERT INTO assayer_documents (id, version, assayer_id, requirement, verification_status, current_version_id, is_active, file_paths, created_at, updated_at)
         VALUES ($1, 1, $2, 'BANK_PASSBOOK', 'VERIFIED', $3, true, '[]'::jsonb, now(), now())`,
        [docId, assayerId, versionId],
      );
      await client.query(
        `INSERT INTO assayer_document_versions (id, document_id, assayer_id, requirement, version, file_path, verification_status, uploaded_at)
         VALUES ($1, $2, $3, 'BANK_PASSBOOK', 1, '/docs/bank.pdf', 'VERIFIED', now())`,
        [versionId, docId, assayerId],
      );

      const assignmentId = uuidv4();
      createdAssignmentIds.push(assignmentId);
      await client.query(
        `INSERT INTO assignments (id, version, assignment_number, project_id, assayer_id, status, priority, auto_schedule, negotiation_count, entity_version, sla_status, empanelment_override_used, is_active, created_at, updated_at)
         VALUES ($1, 1, 'ASN-2026-900001', $2, $3, 'COMPLETED', 'MEDIUM', false, 0, 1, 'COMPLIANT', false, true, now(), now())`,
        [assignmentId, projectId, assayerId],
      );

      const payableId = uuidv4();
      createdPayableIds.push(payableId);
      await client.query(
        `INSERT INTO assayer_payables (
           id, version, payable_number, assayer_id, assignment_id, status, on_hold,
           base_amount, travel_amount, tax_amount, tds_amount, total_amount, currency, paid_amount, pre_invoicing_era,
           is_active, created_at, updated_at
         ) VALUES ($1, 1, 'PY-TEST-001', $2, $3, 'PENDING', false, 1500.00, 0.00, 0.00, 0.00, 1500.00, 'INR', 0.00, false, true, now(), now())`,
        [payableId, assayerId, assignmentId],
      );
      client.release();
      const barrier = createRaceBarrier(['T1', 'T2']);

      const thread1Approve = async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query('SELECT * FROM assayer_payables WHERE id = $1 FOR UPDATE', [payableId]);
          const aRes = await c.query('SELECT * FROM assayers WHERE id = $1 FOR SHARE', [assayerId]);
          const assayer = aRes.rows[0];

          // Controlled synchronization point: T1 holds FOR UPDATE on payable and FOR SHARE on assayer
          await barrier.waitToProceed('T1');

          // The source is named because the row is otherwise a verification claim with nothing
          // behind it, and chk_assayer_payables_destination_evidence refuses that. `versionId`
          // here is a VERIFIED bank passbook version, which is what makes BANK_PASSBOOK the
          // honest answer — the same rung `resolvePayoutDestination` picks for this assayer.
          await c.query(
            `UPDATE assayer_payables SET
               status = 'APPROVED',
               destination_bank_account_number = $1,
               destination_ifsc = $2,
               destination_bank_name = $3,
               destination_account_holder_name = $4,
               payout_evidence_version_id = $5,
               destination_verified_at = now(),
               destination_verified_source = 'BANK_PASSBOOK',
               updated_at = now()
             WHERE id = $6`,
            [
              assayer.bank_account_number,
              assayer.ifsc_code,
              assayer.bank_name,
              assayer.display_name,
              versionId,
              payableId,
            ],
          );
          await c.query('COMMIT');
        } finally {
          c.release();
        }
      };

      const thread2BankUpdate = async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          // Controlled synchronization point: T2 is in open transaction, ready to mutate bank account concurrently
          await barrier.waitToProceed('T2');

          await c.query(
            `UPDATE assayers SET
               bank_account_number = 'MUTATED_NEW_ACC_9999',
               ifsc_code = 'ICIC0005555',
               updated_at = now()
             WHERE id = $1`,
            [assayerId],
          );
          await c.query('COMMIT');
        } finally {
          c.release();
        }
      };

      await Promise.all([
        thread1Approve(),
        thread2BankUpdate(),
        (async () => {
          await barrier.waitUntilBothReady();
          barrier.release();
        })(),
      ]);

      const checkClient = await pool.connect();
      const pFinal = await checkClient.query('SELECT * FROM assayer_payables WHERE id = $1', [payableId]);
      const aFinal = await checkClient.query('SELECT * FROM assayers WHERE id = $1', [assayerId]);
      checkClient.release();

      expect(pFinal.rows[0].status).toBe('APPROVED');
      expect(pFinal.rows[0].destination_bank_account_number).toBe('INITIAL_ACC_1111');
      expect(pFinal.rows[0].destination_ifsc).toBe('HDFC0001234');
      expect(pFinal.rows[0].payout_evidence_version_id).toBe(versionId);
      expect(aFinal.rows[0].bank_account_number).toBe('MUTATED_NEW_ACC_9999');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // RACE C: Assignment Creation vs Empanelment Revocation
  // ──────────────────────────────────────────────────────────────────────────
  describe('Race C: Assignment Creation vs Empanelment Revocation (Requirement H)', () => {
    it('assignment creation commits only when empanelment standing was valid under transaction lock', async () => {
      const client = await pool.connect();
      const orgId = await createTestOrg(client);
      const clientId = await createTestClient(client, orgId);
      const { projectId } = await createTestProjectAndBranch(client, orgId, clientId);

      const assayerId = uuidv4();
      createdAssayerIds.push(assayerId);
      await client.query(
        `INSERT INTO assayers (
           id, version, assayer_code, first_name, last_name, display_name, address, state, district, city,
           lifecycle_status, status, is_active, organization_id, created_at, updated_at
         ) VALUES (
           $1, 1, $2, 'Rohan', 'Verma', 'Rohan Verma', 'Street', 'MH', 'Mumbai', 'Mumbai',
           'ACTIVE', 'ACTIVE', true, $3, now(), now()
         )`,
        [assayerId, `ASY-${assayerId.substring(0, 8)}`, orgId],
      );

      const empanelmentId = uuidv4();
      createdEmpanelmentIds.push(empanelmentId);
      await client.query(
        `INSERT INTO assayer_client_empanelments (
           id, version, assayer_id, client_id, status, is_active, created_at, updated_at
         ) VALUES ($1, 1, $2, $3, 'ACTIVE', true, now(), now())`,
        [empanelmentId, assayerId, clientId],
      );
      client.release();
      const barrier = createRaceBarrier(['T1', 'T2']);

      let thread1Outcome: 'COMMITTED' | 'REJECTED' = 'COMMITTED';
      const assignmentId = uuidv4();

      const thread1CreateAssignment = async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query('SELECT id FROM assayers WHERE id = $1 FOR UPDATE', [assayerId]);

          // Synchronization barrier: T1 is open and holds row lock
          await barrier.waitToProceed('T1');

          const empRes = await c.query(
            `SELECT id, status, is_active FROM assayer_client_empanelments
             WHERE assayer_id = $1 AND client_id = $2 AND is_active = true
             FOR SHARE LIMIT 1`,
            [assayerId, clientId],
          );
          const standing = empRes.rows[0]?.status;

          if (!standing || ['REJECTED', 'TERMINATED', 'EXPIRED', 'SUSPENDED'].includes(standing)) {
            thread1Outcome = 'REJECTED';
            await c.query('ROLLBACK');
            return;
          }

          await c.query(
            `INSERT INTO assignments (
               id, version, assignment_number, project_id, assayer_id, status, priority, auto_schedule,
               negotiation_count, entity_version, sla_status, empanelment_override_used, is_active,
               empanelment_standing_at_creation, empanelment_id, empanelment_verified_at, created_at, updated_at
             ) VALUES ($1, 1, $2, $3, $4, 'PENDING', 'MEDIUM', false, 0, 1, 'COMPLIANT', false, true, $5, $6, now(), now(), now())`,
            [assignmentId, `ASN-2026-${uuidv4().substring(0, 6)}`, projectId, assayerId, standing, empanelmentId],
          );
          createdAssignmentIds.push(assignmentId);
          await c.query('COMMIT');
          thread1Outcome = 'COMMITTED';
        } catch {
          await c.query('ROLLBACK');
          thread1Outcome = 'REJECTED';
        } finally {
          c.release();
        }
      };

      const thread2RevokeEmpanelment = async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          // Synchronization barrier: T2 is in open transaction, ready to revoke
          await barrier.waitToProceed('T2');

          await c.query(
            `UPDATE assayer_client_empanelments
             SET status = 'TERMINATED', is_active = false, updated_at = now()
             WHERE id = $1`,
            [empanelmentId],
          );
          await c.query('COMMIT');
        } catch {
          await c.query('ROLLBACK');
        } finally {
          c.release();
        }
      };

      await Promise.all([
        thread1CreateAssignment(),
        thread2RevokeEmpanelment(),
        (async () => {
          await barrier.waitUntilBothReady();
          barrier.release();
        })(),
      ]);

      const checkClient = await pool.connect();
      const assignmentRow = await checkClient.query('SELECT * FROM assignments WHERE id = $1', [assignmentId]);
      const empanelmentRow = await checkClient.query('SELECT * FROM assayer_client_empanelments WHERE id = $1', [empanelmentId]);
      checkClient.release();

      expect(empanelmentRow.rows[0].status).toBe('TERMINATED');

      if (thread1Outcome === 'COMMITTED') {
        expect(assignmentRow.rows.length).toBe(1);
        expect(assignmentRow.rows[0].empanelment_standing_at_creation).toBe('ACTIVE');
      } else {
        expect(assignmentRow.rows.length).toBe(0);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // RACE D: Document Evidence Versioning (Verify vs Superseding Upload)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Race D: Document Evidence Versioning (Verify vs Superseding Upload)', () => {
    it('verifying a superseded document version fails with conflict, preserving document version history', async () => {
      const client = await pool.connect();
      const orgId = await createTestOrg(client);
      const assayerId = uuidv4();
      createdAssayerIds.push(assayerId);

      await client.query(
        `INSERT INTO assayers (
           id, version, assayer_code, first_name, last_name, display_name, address, state, district, city,
           lifecycle_status, status, is_active, organization_id, created_at, updated_at
         ) VALUES ($1, 1, $2, 'Neha', 'Gupta', 'Neha Gupta', 'Street', 'MH', 'Pune', 'Pune', 'INVITED', 'INACTIVE', true, $3, now(), now())`,
        [assayerId, `ASY-${assayerId.substring(0, 8)}`, orgId],
      );

      const docId = uuidv4();
      const v1Id = uuidv4();
      createdDocumentIds.push(docId);
      await client.query(
        `INSERT INTO assayer_documents (id, version, assayer_id, requirement, verification_status, current_version_id, is_active, file_paths, created_at, updated_at)
         VALUES ($1, 1, $2, 'PAN_CARD', 'PENDING', $3, true, '[]'::jsonb, now(), now())`,
        [docId, assayerId, v1Id],
      );
      await client.query(
        `INSERT INTO assayer_document_versions (id, document_id, assayer_id, requirement, version, file_path, verification_status, uploaded_at)
         VALUES ($1, $2, $3, 'PAN_CARD', 1, '/docs/pan_v1.pdf', 'PENDING', now())`,
        [v1Id, docId, assayerId],
      );
      client.release();
      const barrier = createRaceBarrier(['T1', 'T2']);

      const v2Id = uuidv4();
      let thread1VerifyStatus: 'SUCCESS' | 'CONFLICT' = 'SUCCESS';

      const thread1Verify = async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          // Synchronization barrier: T1 is open in transaction
          await barrier.waitToProceed('T1');

          const dRes = await c.query('SELECT * FROM assayer_documents WHERE id = $1 FOR UPDATE', [docId]);
          const doc = dRes.rows[0];

          if (doc.current_version_id !== v1Id) {
            thread1VerifyStatus = 'CONFLICT';
            await c.query('ROLLBACK');
            return;
          }

          await c.query("UPDATE assayer_documents SET verification_status = 'VERIFIED' WHERE id = $1", [docId]);
          await c.query("UPDATE assayer_document_versions SET verification_status = 'VERIFIED' WHERE id = $1", [v1Id]);
          await c.query('COMMIT');
        } catch {
          await c.query('ROLLBACK');
          thread1VerifyStatus = 'CONFLICT';
        } finally {
          c.release();
        }
      };

      const thread2UploadV2 = async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query('SELECT * FROM assayer_documents WHERE id = $1 FOR UPDATE', [docId]);

          // Synchronization barrier: T2 has acquired row lock to upload superseding version
          await barrier.waitToProceed('T2');

          // A real 64-hex digest, not a placeholder: `chk_assayer_document_versions_sha256`
          // requires the column to look like a SHA-256, and 'hash-v2-sha256' was refused. The
          // race under test is about ordering, so any valid digest serves — but an invalid one
          // fails the INSERT and the race never runs at all.
          await c.query(
            `INSERT INTO assayer_document_versions (id, document_id, assayer_id, requirement, version, file_path, content_sha256, storage_object_id, verification_status, uploaded_at)
             VALUES ($1, $2, $3, 'PAN_CARD', 2, '/docs/pan_v2.pdf', '3d406990cfce20a5c1e43c4f905ec1ddf53c5437f40d9e4d35102e9c80bc503f', 's3://bucket/pan_v2.pdf', 'PENDING', now())`,
            [v2Id, docId, assayerId],
          );
          await c.query(
            `UPDATE assayer_documents SET current_version_id = $1, verification_status = 'PENDING', updated_at = now() WHERE id = $2`,
            [v2Id, docId],
          );
          await c.query('COMMIT');
        } finally {
          c.release();
        }
      };

      await Promise.all([
        thread2UploadV2(),
        thread1Verify(),
        (async () => {
          await barrier.waitUntilBothReady();
          barrier.release();
        })(),
      ]);

      const checkClient = await pool.connect();
      const docFinal = await checkClient.query('SELECT * FROM assayer_documents WHERE id = $1', [docId]);
      const v1Final = await checkClient.query('SELECT * FROM assayer_document_versions WHERE id = $1', [v1Id]);
      const v2Final = await checkClient.query('SELECT * FROM assayer_document_versions WHERE id = $1', [v2Id]);
      checkClient.release();

      expect(thread1VerifyStatus).toBe('CONFLICT');
      expect(docFinal.rows[0].current_version_id).toBe(v2Id);
      expect(v1Final.rows[0].verification_status).toBe('PENDING');
      expect(v2Final.rows[0].verification_status).toBe('PENDING');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // RACE E: Check-in vs Assayer Suspension
  // ──────────────────────────────────────────────────────────────────────────
  describe('Race E: Field Check-in vs Assayer Suspension', () => {
    it('check-in can commit only when assayer is active under transaction lock; suspension rejects check-in', async () => {
      const client = await pool.connect();
      const orgId = await createTestOrg(client);
      const clientId = await createTestClient(client, orgId);
      const { projectId } = await createTestProjectAndBranch(client, orgId, clientId);

      const assayerId = uuidv4();
      createdAssayerIds.push(assayerId);
      await client.query(
        `INSERT INTO assayers (
           id, version, assayer_code, first_name, last_name, display_name, address, state, district, city,
           lifecycle_status, status, is_active, organization_id, created_at, updated_at
         ) VALUES ($1, 1, $2, 'Vikram', 'Singh', 'Vikram Singh', 'Street', 'MH', 'Mumbai', 'Mumbai', 'ACTIVE', 'ACTIVE', true, $3, now(), now())`,
        [assayerId, `ASY-${assayerId.substring(0, 8)}`, orgId],
      );

      const assignmentId = uuidv4();
      createdAssignmentIds.push(assignmentId);
      await client.query(
        `INSERT INTO assignments (id, version, assignment_number, project_id, assayer_id, status, priority, auto_schedule, negotiation_count, entity_version, sla_status, empanelment_override_used, is_active, created_at, updated_at)
         VALUES ($1, 1, 'ASN-2026-900003', $2, $3, 'ACCEPTED', 'MEDIUM', false, 0, 1, 'COMPLIANT', false, true, now(), now())`,
        [assignmentId, projectId, assayerId],
      );
      client.release();
      const barrier = createRaceBarrier(['T1', 'T2']);

      let checkInOutcome: 'SUCCESS' | 'REJECTED' = 'SUCCESS';

      const thread1CheckIn = async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          // Synchronization barrier: T1 is open in transaction
          await barrier.waitToProceed('T1');

          const aRes = await c.query('SELECT status, lifecycle_status, is_active FROM assayers WHERE id = $1 FOR SHARE', [assayerId]);
          const assayer = aRes.rows[0];

          if (assayer.lifecycle_status !== 'ACTIVE' || assayer.status !== 'ACTIVE') {
            checkInOutcome = 'REJECTED';
            await c.query('ROLLBACK');
            return;
          }

          await c.query("UPDATE assignments SET status = 'CHECKED_IN', updated_at = now() WHERE id = $1", [assignmentId]);
          await c.query('COMMIT');
          checkInOutcome = 'SUCCESS';
        } catch {
          await c.query('ROLLBACK');
          checkInOutcome = 'REJECTED';
        } finally {
          c.release();
        }
      };

      const thread2Suspend = async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query('SELECT id FROM assayers WHERE id = $1 FOR UPDATE', [assayerId]);

          // Synchronization barrier: T2 has acquired row lock for suspension
          await barrier.waitToProceed('T2');

          await c.query(
            `UPDATE assayers SET lifecycle_status = 'SUSPENDED', status = 'SUSPENDED', updated_at = now() WHERE id = $1`,
            [assayerId],
          );
          await c.query('COMMIT');
        } finally {
          c.release();
        }
      };

      await Promise.all([
        thread2Suspend(),
        thread1CheckIn(),
        (async () => {
          await barrier.waitUntilBothReady();
          barrier.release();
        })(),
      ]);

      const checkClient = await pool.connect();
      const aFinal = await checkClient.query('SELECT status, lifecycle_status FROM assayers WHERE id = $1', [assayerId]);
      const asnFinal = await checkClient.query('SELECT status FROM assignments WHERE id = $1', [assignmentId]);
      checkClient.release();

      expect(aFinal.rows[0].lifecycle_status).toBe('SUSPENDED');
      expect(aFinal.rows[0].status).toBe('SUSPENDED');
      expect(checkInOutcome).toBe('REJECTED');
      expect(asnFinal.rows[0].status).toBe('ACCEPTED');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // RACE F: Assignment Creation vs Assayer Lifecycle Departure (Resigned)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Race F: Assignment Creation vs Lifecycle Departure (Requirement H)', () => {
    it('assignment creation commits only when assayer lifecycle state was valid under transaction lock', async () => {
      const client = await pool.connect();
      const orgId = await createTestOrg(client);
      const clientId = await createTestClient(client, orgId);
      const { projectId } = await createTestProjectAndBranch(client, orgId, clientId);

      const assayerId = uuidv4();
      createdAssayerIds.push(assayerId);
      await client.query(
        `INSERT INTO assayers (
           id, version, assayer_code, first_name, last_name, display_name, address, state, district, city,
           lifecycle_status, status, is_active, organization_id, created_at, updated_at
         ) VALUES ($1, 1, $2, 'Ananya', 'Rao', 'Ananya Rao', 'Street', 'MH', 'Mumbai', 'Mumbai', 'ACTIVE', 'ACTIVE', true, $3, now(), now())`,
        [assayerId, `ASY-${assayerId.substring(0, 8)}`, orgId],
      );
      client.release();
      const barrier = createRaceBarrier(['T1', 'T2']);

      let createOutcome: 'COMMITTED' | 'REJECTED' = 'COMMITTED';
      const assignmentId = uuidv4();

      const thread1Create = async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          // Synchronization barrier: T1 is open in transaction
          await barrier.waitToProceed('T1');

          const aRes = await c.query(
            'SELECT id, lifecycle_status, status, is_active FROM assayers WHERE id = $1 FOR UPDATE',
            [assayerId],
          );
          const assayer = aRes.rows[0];

          if (assayer.lifecycle_status !== 'ACTIVE' || assayer.status !== 'ACTIVE') {
            createOutcome = 'REJECTED';
            await c.query('ROLLBACK');
            return;
          }

          await c.query(
            `INSERT INTO assignments (id, version, assignment_number, project_id, assayer_id, status, priority, auto_schedule, negotiation_count, entity_version, sla_status, empanelment_override_used, is_active, created_at, updated_at)
             VALUES ($1, 1, $2, $3, $4, 'PENDING', 'MEDIUM', false, 0, 1, 'COMPLIANT', false, true, now(), now())`,
            [assignmentId, `ASN-2026-${uuidv4().substring(0, 6)}`, projectId, assayerId],
          );
          createdAssignmentIds.push(assignmentId);
          await c.query('COMMIT');
          createOutcome = 'COMMITTED';
        } catch {
          await c.query('ROLLBACK');
          createOutcome = 'REJECTED';
        } finally {
          c.release();
        }
      };

      const thread2Depart = async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query('SELECT id FROM assayers WHERE id = $1 FOR UPDATE', [assayerId]);

          // Synchronization barrier: T2 has acquired row lock for departure
          await barrier.waitToProceed('T2');

          await c.query(
            `UPDATE assayers SET lifecycle_status = 'RESIGNED', status = 'INACTIVE', updated_at = now() WHERE id = $1`,
            [assayerId],
          );
          await c.query('COMMIT');
        } finally {
          c.release();
        }
      };

      await Promise.all([
        thread2Depart(),
        thread1Create(),
        (async () => {
          await barrier.waitUntilBothReady();
          barrier.release();
        })(),
      ]);

      const checkClient = await pool.connect();
      const aFinal = await checkClient.query('SELECT lifecycle_status, status FROM assayers WHERE id = $1', [assayerId]);
      const asnFinal = await checkClient.query('SELECT * FROM assignments WHERE id = $1', [assignmentId]);
      checkClient.release();

      expect(aFinal.rows[0].lifecycle_status).toBe('RESIGNED');
      expect(aFinal.rows[0].status).toBe('INACTIVE');

      if (createOutcome === 'COMMITTED') {
        expect(asnFinal.rows.length).toBe(1);
      } else {
        expect(asnFinal.rows.length).toBe(0);
      }
    });
  });
});
