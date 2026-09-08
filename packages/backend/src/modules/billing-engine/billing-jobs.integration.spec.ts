import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BillingEngineService } from './billing-engine.service';
import { BillingJobsWorker } from './billing-jobs.worker';
import { BillingJobsService } from './billing-jobs.service';
import { BillingEntryEntity } from './billing-entry.entity';
import { BillingInvoiceEntity } from './invoice.entity';
import { BillingPaymentEntity } from './payment.entity';
import { AssayerPayableEntity } from './payable.entity';
import { BillingHistoryEntity } from './history.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectEntity } from '../project/project.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AuditService } from '../../core/audit/audit.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { TypeOrmUnitOfWork } from '../../infrastructure/persistence/typeorm-unit-of-work';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { OutboxEntity } from '../../infrastructure/persistence/outbox.entity';
import { OutboxRelay } from '../../infrastructure/persistence/outbox.relay';
import { AssignmentStatus, AssayerPayableStatus, BillingState } from '@fapoms/shared';

/**
 * Integrated durability test suite simulating real lifecycle failure boundaries:
 *
 * Test 1: Assignment transaction commits; fast-path fails; OutboxRelay delivers event to BillingJobsService.
 * Test 2: Billing queue enqueue fails temporarily; outbox row remains undispatched and retries successfully.
 * Test 3: Queue job starts, DB transaction commits, worker dies before ack; job is redelivered but DB idempotency prevents duplicate records.
 * Test 4: Two concurrent workers process the same assignment simultaneously; exactly one financial entry and payable survive.
 * Test 5: Exhausted retries leave job in failed state with operator visibility and manual replay capability.
 * Test 6: Replaying the same outbox event multiple times produces exactly one financial result.
 */
describe('Phase 0.1 Financial Durability — End-to-End Boundary & Idempotency Verification', () => {
  let billingService: BillingEngineService;
  let billingWorker: BillingJobsWorker;
  let billingJobsService: BillingJobsService;
  let outboxRelay: OutboxRelay;
  let publisher: DomainEventPublisher;

  // Staged persistence memory store
  const savedEntries: any[] = [];
  const savedPayables: any[] = [];
  const committedRows: any[] = [];
  const outboxStore: Map<string, OutboxEntity> = new Map();

  const mockQueue: any = {
    add: jest.fn(),
    getJob: jest.fn(),
    getJobs: jest.fn().mockResolvedValue([]),
  };

  const defaultManagerQuery = async (sql: string): Promise<any[]> => {
    if (sql.includes('FROM client_configurations')) return [{ default_base_fee: '3000' }];
    if (sql.includes('FROM clients WHERE id')) return [{ planning_preferences: {}, id: 'client-1' }];
    if (sql.includes('FROM client_billing')) return [{ gst_rate: '18', tds_rate: '10', payment_terms: 'NET30' }];
    if (sql.includes('FROM users')) return [{ display_name: 'Priya Menon' }];
    return [];
  };

  const entryRepo: any = {
    create: jest.fn((d) => ({ ...d })),
    save: jest.fn(async (d) => {
      // Check database-level unique invariant: UQ_billing_entries_root_per_assignment
      const existing = savedEntries.find((e) => e.assignmentId === d.assignmentId);
      if (existing) {
        const err: any = new Error('duplicate key value violates unique constraint "UQ_billing_entries_root_per_assignment"');
        err.code = '23505';
        err.constraint = 'UQ_billing_entries_root_per_assignment';
        throw err;
      }
      const r = { id: d.id ?? `entry-${savedEntries.length + 1}`, ...d };
      savedEntries.push(r);
      return r;
    }),
    find: jest.fn(async () => savedEntries),
    findOne: jest.fn(async (opts: any) => savedEntries.find((e) => e.assignmentId === opts?.where?.assignmentId) ?? null),
  };

  const payableRepo: any = {
    create: jest.fn((d) => ({ ...d })),
    save: jest.fn(async (d) => {
      // Check database-level unique invariant: UQ_assayer_payables_fee_per_assignment
      const existing = savedPayables.find((p) => p.assignmentId === d.assignmentId && !p.expenseId);
      if (existing) {
        const err: any = new Error('duplicate key value violates unique constraint "UQ_assayer_payables_fee_per_assignment"');
        err.code = '23505';
        err.constraint = 'UQ_assayer_payables_fee_per_assignment';
        throw err;
      }
      const r = { id: d.id ?? `payable-${savedPayables.length + 1}`, ...d };
      savedPayables.push(r);
      return r;
    }),
    find: jest.fn(async () => savedPayables),
    findOne: jest.fn(async (opts: any) => savedPayables.find((p) => p.assignmentId === opts?.where?.assignmentId && !p.expenseId) ?? null),
  };

  const assignmentRepo: any = {
    findOne: jest.fn(async () => ({
      id: 'asn-fail-test-1',
      assignmentNumber: 'ASN-FAIL-001',
      status: AssignmentStatus.COMPLETED,
      projectId: 'project-1',
      assayerId: 'assayer-1',
      agreedFee: '2000.00',
      quotedTravelFee: '300.00',
      completionDate: new Date('2026-08-10T10:00:00Z'),
    })),
    manager: {
      query: jest.fn(defaultManagerQuery),
    },
  };

  const outboxRepo: any = {
    find: jest.fn(async () => Array.from(outboxStore.values()).filter((r) => r.dispatchedAt === null)),
    update: jest.fn(async (id: any, patch: any) => {
      const ids = Array.isArray(id) ? id : [id];
      for (const singleId of ids) {
        const row = outboxStore.get(singleId);
        if (row) {
          Object.assign(row, patch);
        }
      }
    }),
  };

  const inFlightInserts = new Map<string, { manager: any; promise: Promise<void>; resolve: () => void }>();

  const fakeDataSource: any = {
    transaction: jest.fn(async (iso: any, maybeWork: any) => {
      const work = typeof iso === 'function' ? iso : maybeWork;
      const txEntries: any[] = [];
      const txPayables: any[] = [];
      const manager: any = {
        findOne: jest.fn(async (target: any, opts: any) => {
          if (target === AssignmentEntity) return assignmentRepo.findOne(opts);
          if (target === ProjectEntity) return { id: 'project-1', clientId: 'client-1' };
          if (target === BillingEntryEntity) {
            return txEntries.find((e) => e.assignmentId === opts?.where?.assignmentId)
              ?? savedEntries.find((e) => e.assignmentId === opts?.where?.assignmentId)
              ?? null;
          }
          if (target === AssayerPayableEntity) {
            return txPayables.find((p) => p.assignmentId === opts?.where?.assignmentId && !p.expenseId)
              ?? savedPayables.find((p) => p.assignmentId === opts?.where?.assignmentId && !p.expenseId)
              ?? null;
          }
          return null;
        }),
        save: jest.fn(async (row: any) => {
          if (row.entryNumber !== undefined) {
            // Check UQ_billing_entries_root_per_assignment
            if (savedEntries.some((e) => e.assignmentId === row.assignmentId)) {
              const err: any = new Error('duplicate key value violates unique constraint "UQ_billing_entries_root_per_assignment"');
              err.code = '23505';
              err.constraint = 'UQ_billing_entries_root_per_assignment';
              throw err;
            }
            const inFlight = inFlightInserts.get(`entry:${row.assignmentId}`);
            if (inFlight && inFlight.manager !== manager) {
              // In PostgreSQL, concurrent unique inserts wait for the active transaction to commit
              await inFlight.promise;
              const err: any = new Error('duplicate key value violates unique constraint "UQ_billing_entries_root_per_assignment"');
              err.code = '23505';
              err.constraint = 'UQ_billing_entries_root_per_assignment';
              throw err;
            }
            if (!inFlightInserts.has(`entry:${row.assignmentId}`)) {
              let resolveFn!: () => void;
              const promise = new Promise<void>((res) => { resolveFn = res; });
              inFlightInserts.set(`entry:${row.assignmentId}`, { manager, promise, resolve: resolveFn });
            }

            const r = { id: row.id ?? `entry-${savedEntries.length + txEntries.length + 1}`, ...row };
            txEntries.push(r);
            return r;
          } else if (row.payableNumber !== undefined) {
            // Check UQ_assayer_payables_fee_per_assignment
            if (savedPayables.some((p) => p.assignmentId === row.assignmentId && !p.expenseId)) {
              const err: any = new Error('duplicate key value violates unique constraint "UQ_assayer_payables_fee_per_assignment"');
              err.code = '23505';
              err.constraint = 'UQ_assayer_payables_fee_per_assignment';
              throw err;
            }
            const inFlight = inFlightInserts.get(`payable:${row.assignmentId}`);
            if (inFlight && inFlight.manager !== manager) {
              // In PostgreSQL, concurrent unique inserts wait for the active transaction to commit
              await inFlight.promise;
              const err: any = new Error('duplicate key value violates unique constraint "UQ_assayer_payables_fee_per_assignment"');
              err.code = '23505';
              err.constraint = 'UQ_assayer_payables_fee_per_assignment';
              throw err;
            }
            if (!inFlightInserts.has(`payable:${row.assignmentId}`)) {
              let resolveFn!: () => void;
              const promise = new Promise<void>((res) => { resolveFn = res; });
              inFlightInserts.set(`payable:${row.assignmentId}`, { manager, promise, resolve: resolveFn });
            }

            const r = { id: row.id ?? `payable-${savedPayables.length + txPayables.length + 1}`, ...row };
            txPayables.push(r);
            return r;
          } else {
            return { id: `hist-${Date.now()}`, ...row };
          }
        }),
        insert: jest.fn(async (_target: any, rows: any[]) => ({ identifiers: rows.map((r) => ({ id: r.id })) })),
        query: jest.fn(defaultManagerQuery),
      };
      try {
        const result = await work(manager);
        savedEntries.push(...txEntries);
        savedPayables.push(...txPayables);
        return result;
      } finally {
        for (const [key, d] of inFlightInserts.entries()) {
          if (d.manager === manager) {
            d.resolve();
            inFlightInserts.delete(key);
          }
        }
      }
    }),
    manager: {
      query: jest.fn(defaultManagerQuery),
    },
  };

  beforeEach(async () => {
    savedEntries.length = 0;
    savedPayables.length = 0;
    committedRows.length = 0;
    outboxStore.clear();
    inFlightInserts.clear();
    jest.clearAllMocks();

    publisher = new DomainEventPublisher();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingEngineService,
        BillingJobsWorker,
        BillingJobsService,
        {
          provide: 'BullQueue_billing-jobs',
          useValue: mockQueue,
        },
        { provide: getRepositoryToken(BillingEntryEntity), useValue: entryRepo },
        { provide: getRepositoryToken(BillingInvoiceEntity), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(BillingPaymentEntity), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(AssayerPayableEntity), useValue: payableRepo },
        { provide: getRepositoryToken(BillingHistoryEntity), useValue: { create: jest.fn((d) => ({ ...d })), save: jest.fn(async (d) => d) } },
        { provide: getRepositoryToken(AssignmentEntity), useValue: assignmentRepo },
        { provide: getRepositoryToken(ProjectEntity), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(AssayerEntity), useValue: { findOne: jest.fn() } },
        { provide: getDataSourceToken(), useValue: fakeDataSource },
        { provide: DataSource, useValue: fakeDataSource },
        { provide: DomainEventPublisher, useValue: publisher },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn(), emitSafe: jest.fn() } },
        { provide: AuditService, useValue: { recordEvent: jest.fn(), recordEventSafe: jest.fn() } },
        { provide: RegionGuardService, useValue: { stagedMode: jest.fn(), assertRegionAllowedStaged: jest.fn() } },
        {
          provide: PlatformSettingsService,
          useValue: {
            get: jest.fn(),
            getNumber: jest.fn(async (_k, fallback) => fallback),
            getMany: jest.fn(async () => ({})),
          },
        },
        {
          provide: UnitOfWork,
          useFactory: () => new TypeOrmUnitOfWork(fakeDataSource as DataSource, publisher, outboxRepo),
        },
        {
          provide: CacheService,
          useValue: {
            withLock: jest.fn((_k, _t, fn) => fn()),
          },
        },
      ],
    }).compile();

    billingService = module.get<BillingEngineService>(BillingEngineService);
    billingWorker = module.get<BillingJobsWorker>(BillingJobsWorker);
    billingJobsService = module.get<BillingJobsService>(BillingJobsService);
    billingService.onModuleInit();

    outboxRelay = new OutboxRelay(outboxRepo, publisher, {
      withLock: jest.fn((_k, _t, fn) => fn()),
    } as any);
  });

  it('Test 1: When process crashes before fast-path publish, OutboxRelay delivers event to BillingJobsService', async () => {
    // Stage an undispatched outbox event as if assignment committed and process died before fast-path dispatch
    const outboxRow: OutboxEntity = {
      id: 'outbox-uuid-1',
      eventName: 'assignment:status-changed',
      payload: {
        assignmentId: 'asn-fail-test-1',
        newState: AssignmentStatus.COMPLETED,
        userId: 'admin-1',
        outboxEventId: 'outbox-uuid-1',
      },
      occurredAt: new Date(Date.now() - 60_000),
      dispatchedAt: null,
      attempts: 0,
      lastError: null,
    };
    outboxStore.set(outboxRow.id, outboxRow);

    mockQueue.add.mockResolvedValueOnce({ id: 'book-assignment:asn-fail-test-1' });

    // Relay runs on next tick
    const relayResult = await outboxRelay.drain();

    expect(relayResult.dispatched).toBe(1);
    expect(mockQueue.add).toHaveBeenCalledWith(
      'book-assignment',
      { assignmentId: 'asn-fail-test-1', userId: 'admin-1', outboxEventId: 'outbox-uuid-1' },
      expect.objectContaining({ jobId: 'book-assignment:asn-fail-test-1' }),
    );
    expect(outboxStore.get('outbox-uuid-1')?.dispatchedAt).toBeInstanceOf(Date);
  });

  it('Test 2: When BullMQ enqueue fails temporarily, outbox remains undispatched and retries successfully', async () => {
    const outboxRow: OutboxEntity = {
      id: 'outbox-uuid-2',
      eventName: 'assignment:status-changed',
      payload: {
        assignmentId: 'asn-fail-test-2',
        newState: AssignmentStatus.COMPLETED,
        userId: 'admin-1',
        outboxEventId: 'outbox-uuid-2',
      },
      occurredAt: new Date(Date.now() - 60_000),
      dispatchedAt: null,
      attempts: 0,
      lastError: null,
    };
    outboxStore.set(outboxRow.id, outboxRow);

    // Redis queue is temporarily unreachable
    mockQueue.add.mockRejectedValueOnce(new Error('Redis ECONNREFUSED'));

    const failRelay = await outboxRelay.drain();
    expect(failRelay.failed).toBe(1);
    expect(failRelay.dispatched).toBe(0);
    // Row remains undispatched with attempt incremented
    expect(outboxStore.get('outbox-uuid-2')?.dispatchedAt).toBeNull();
    expect(outboxStore.get('outbox-uuid-2')?.attempts).toBe(1);
    expect(outboxStore.get('outbox-uuid-2')?.lastError).toContain('Redis ECONNREFUSED');

    // On subsequent tick, Redis is back
    mockQueue.add.mockResolvedValueOnce({ id: 'book-assignment:asn-fail-test-2' });
    const successRelay = await outboxRelay.drain();

    expect(successRelay.dispatched).toBe(1);
    expect(outboxStore.get('outbox-uuid-2')?.dispatchedAt).toBeInstanceOf(Date);
  });

  it('Test 3: Worker crashes before acking; redelivered job is safe against financial duplicates', async () => {
    // First delivery runs bookAssignment and commits
    const jobStub = {
      id: 'book-assignment:asn-fail-test-1',
      data: { assignmentId: 'asn-fail-test-1', userId: 'system' },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as any;

    const firstRun = await billingWorker.bookAssignment(jobStub);
    expect(firstRun.booked).toBe(true);
    expect(savedEntries).toHaveLength(1);
    expect(savedPayables).toHaveLength(1);

    // Worker crashed without acking, so Bull re-delivers the job (attemptsMade = 1)
    const redeliveredJob = { ...jobStub, attemptsMade: 1 };
    const secondRun = await billingWorker.bookAssignment(redeliveredJob);

    expect(secondRun.booked).toBe(false);
    expect(secondRun.reason).toBe('already booked');
    // Financial rows were NOT duplicated
    expect(savedEntries).toHaveLength(1);
    expect(savedPayables).toHaveLength(1);
  });

  it('Test 4: Concurrent workers race to book same assignment; DB uniqueness prevents double-billing', async () => {
    const job1 = {
      id: 'book-assignment:asn-fail-test-1',
      data: { assignmentId: 'asn-fail-test-1', userId: 'worker-1' },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as any;
    const job2 = {
      id: 'book-assignment:asn-fail-test-1',
      data: { assignmentId: 'asn-fail-test-1', userId: 'worker-2' },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as any;

    // Both workers execute concurrently
    const [res1, res2] = await Promise.all([
      billingWorker.bookAssignment(job1),
      billingWorker.bookAssignment(job2),
    ]);

    // Exactly one booked, the other completed cleanly as already booked
    const bookedCount = [res1, res2].filter((r) => r.booked).length;
    const skippedCount = [res1, res2].filter((r) => !r.booked && r.reason?.startsWith('already booked')).length;

    expect(bookedCount).toBe(1);
    expect(skippedCount).toBe(1);
    expect(savedEntries).toHaveLength(1);
    expect(savedPayables).toHaveLength(1);
  });

  it('Test 5: Exhausted retries are retained in Bull and can be manually replayed after dead job cleanup', async () => {
    // 5 transient failures occurred
    const deadJob = {
      id: 'book-assignment:asn-deadlock',
      getState: jest.fn().mockResolvedValue('failed'),
      failedReason: 'deadlock after 5 attempts',
      remove: jest.fn().mockResolvedValue(undefined),
    };
    mockQueue.getJob.mockResolvedValueOnce(deadJob);
    mockQueue.add.mockResolvedValueOnce({ id: 'book-assignment:asn-deadlock' });

    // Operator triggers manual replay of failed assignment
    const replayJob = await billingJobsService.enqueueBookAssignment('asn-deadlock', 'operator-replay');

    expect(mockQueue.getJob).toHaveBeenCalledWith('book-assignment:asn-deadlock');
    expect(deadJob.remove).toHaveBeenCalled();
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
    expect(replayJob.id).toBe('book-assignment:asn-deadlock');
  });

  it('Test 6: Outbox event replayed N times produces exactly one financial result', async () => {
    const job = {
      id: 'book-assignment:asn-fail-test-1',
      data: { assignmentId: 'asn-fail-test-1', userId: 'replay' },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as any;

    for (let i = 0; i < 5; i++) {
      const res = await billingWorker.bookAssignment(job);
      if (i === 0) {
        expect(res.booked).toBe(true);
      } else {
        expect(res.booked).toBe(false);
        expect(res.reason).toBe('already booked');
      }
    }

    expect(savedEntries).toHaveLength(1);
    expect(savedPayables).toHaveLength(1);
  });

  it('Test 7: COMPLETED assignment with missing prerequisites (no assayer/client) throws to fail visibly in operational failure queue', async () => {
    // Missing assayer
    assignmentRepo.findOne.mockResolvedValueOnce({
      id: 'asn-no-assayer',
      assignmentNumber: 'ASN-NO-ASSAYER',
      status: AssignmentStatus.COMPLETED,
      projectId: 'project-1',
      assayerId: null, // MISSING ASSAYER
      agreedFee: '2000.00',
    });

    const job = {
      id: 'book-assignment:asn-no-assayer',
      data: { assignmentId: 'asn-no-assayer', userId: 'system' },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as any;

    // Must NOT return clean success! Must throw to trigger retry / durable failure in Bull
    await expect(billingWorker.bookAssignment(job)).rejects.toThrow(
      'Billing booking prerequisite failed: no assayer on assignment',
    );

    // Ensure no partial or orphan entries were created
    expect(savedEntries.find((e) => e.assignmentId === 'asn-no-assayer')).toBeUndefined();
    expect(savedPayables.find((p) => p.assignmentId === 'asn-no-assayer')).toBeUndefined();
  });

  it('Test 8: COMPLETED assignment with NO_FEE is cleanly acknowledged as explicit non-billable outcome', async () => {
    assignmentRepo.findOne.mockResolvedValueOnce({
      id: 'asn-no-fee',
      assignmentNumber: 'ASN-NO-FEE',
      status: AssignmentStatus.COMPLETED,
      projectId: 'project-1',
      assayerId: 'assayer-1',
      agreedFee: '0.00',
      proposedFee: null, // source: 'NONE'
    });

    const job = {
      id: 'book-assignment:asn-no-fee',
      data: { assignmentId: 'asn-no-fee', userId: 'system' },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as any;

    const res = await billingWorker.bookAssignment(job);
    expect(res.booked).toBe(false);
    expect(res.reason).toBe('NO_FEE');

    // No financial entries created, cleanly acknowledged
    expect(savedEntries.find((e) => e.assignmentId === 'asn-no-fee')).toBeUndefined();
    expect(savedPayables.find((p) => p.assignmentId === 'asn-no-fee')).toBeUndefined();
  });

  it('Test 9: Financial Atomicity — If insertion of second leg fails, entire transaction rolls back (both or neither)', async () => {
    // Stage an assignment
    assignmentRepo.findOne.mockResolvedValueOnce({
      id: 'asn-atomic-fail',
      assignmentNumber: 'ASN-ATOMIC-FAIL',
      status: AssignmentStatus.COMPLETED,
      projectId: 'project-1',
      assayerId: 'assayer-1',
      agreedFee: '2000.00',
      quotedTravelFee: '300.00',
    });

    // Mock entryRepo.save or manager to fail when inserting the client entry (second leg)
    const originalSave = fakeDataSource.transaction;
    fakeDataSource.transaction.mockImplementationOnce(async (iso: any, maybeWork: any) => {
      const work = typeof iso === 'function' ? iso : maybeWork;
      const txEntries: any[] = [];
      const txPayables: any[] = [];
      const manager: any = {
        findOne: jest.fn(async (target: any, opts: any) => {
          if (target === AssignmentEntity) return assignmentRepo.findOne(opts);
          if (target === ProjectEntity) return { id: 'project-1', clientId: 'client-1' };
          if (target === BillingEntryEntity) return null;
          if (target === AssayerPayableEntity) return null;
          return null;
        }),
        save: jest.fn(async (row: any) => {
          if (row.payableNumber !== undefined) {
            // Payable leg succeeds
            const r = { id: 'payable-atomic-1', ...row };
            txPayables.push(r);
            return r;
          }
          if (row.entryNumber !== undefined) {
            // Client line leg crashes / fails!
            throw new Error('Disk error writing client billing entry');
          }
          return row;
        }),
        insert: jest.fn(async (_target: any, rows: any[]) => ({ identifiers: rows.map((r: any) => ({ id: r.id })) })),
        query: jest.fn(defaultManagerQuery),
      };
      // When work(manager) runs, the second leg throws. Transaction rolls back!
      try {
        await work(manager);
        savedEntries.push(...txEntries);
        savedPayables.push(...txPayables);
      } catch (txErr) {
        // Rollback occurred: txEntries and txPayables are dropped.
        throw txErr;
      }
    });

    const job = {
      id: 'book-assignment:asn-atomic-fail',
      data: { assignmentId: 'asn-atomic-fail', userId: 'system' },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as any;

    await expect(billingWorker.bookAssignment(job)).rejects.toThrow('Disk error writing client billing entry');

    // CRITICAL: Verify neither leg was persisted (payable was rolled back with entry)
    expect(savedPayables.find((p) => p.assignmentId === 'asn-atomic-fail')).toBeUndefined();
    expect(savedEntries.find((e) => e.assignmentId === 'asn-atomic-fail')).toBeUndefined();
  });

  describe('Partial Financial State & Database Inconsistency Recovery', () => {
    it('Test 10 (Test A & B): Partial State Recovery — Entry-only or Payable-only converges to both legs without duplicates', async () => {
      // Setup assignment
      assignmentRepo.findOne.mockResolvedValue({
        id: 'asn-partial-recovery',
        assignmentNumber: 'ASN-PARTIAL-001',
        status: AssignmentStatus.COMPLETED,
        projectId: 'project-1',
        assayerId: 'assayer-1',
        agreedFee: '2500.00',
        quotedTravelFee: '400.00',
        completionDate: new Date('2026-08-10T10:00:00Z'),
      });

      // --- Scenario 1: Pre-existing entry only (payable missing due to legacy glitch) ---
      savedEntries.push({
        id: 'legacy-entry-1',
        entryNumber: 'BE-LEGACY-001',
        assignmentId: 'asn-partial-recovery',
        clientId: 'client-1',
        totalAmount: 2950,
      });

      expect(savedEntries).toHaveLength(1);
      expect(savedPayables).toHaveLength(0);

      // Book the assignment: must repair missing payable, not duplicate entry
      const repairRes1 = await billingService.bookAssignment('asn-partial-recovery', 'system');
      expect(repairRes1.booked).toBe(true);
      expect(repairRes1.entryId).toBe('legacy-entry-1');
      expect(repairRes1.payableId).toBeDefined();

      // Invariant check: exactly one entry and one payable exist
      expect(savedEntries).toHaveLength(1);
      expect(savedPayables).toHaveLength(1);
      expect(savedEntries[0].id).toBe('legacy-entry-1');

      // --- Scenario 2: Second booking when both exist (Scenario C: Both exist) ---
      const idempotentRes = await billingService.bookAssignment('asn-partial-recovery', 'system');
      expect(idempotentRes.booked).toBe(false);
      expect(idempotentRes.reason).toBe('already booked');
      expect(idempotentRes.entryId).toBe('legacy-entry-1');
      expect(idempotentRes.payableId).toBe(repairRes1.payableId);
      expect(savedEntries).toHaveLength(1);
      expect(savedPayables).toHaveLength(1);

      // --- Scenario 3: Pre-existing payable only (entry missing) ---
      savedEntries.length = 0;
      savedPayables.length = 0;
      savedPayables.push({
        id: 'legacy-payable-1',
        payableNumber: 'PY-LEGACY-001',
        assignmentId: 'asn-partial-recovery',
        assayerId: 'assayer-1',
        totalAmount: 2610,
        expenseId: null,
      });

      expect(savedEntries).toHaveLength(0);
      expect(savedPayables).toHaveLength(1);

      const repairRes2 = await billingService.bookAssignment('asn-partial-recovery', 'system');
      expect(repairRes2.booked).toBe(true);
      expect(repairRes2.entryId).toBeDefined();
      expect(repairRes2.payableId).toBe('legacy-payable-1');

      // Invariant check: exactly one entry and one payable exist
      expect(savedEntries).toHaveLength(1);
      expect(savedPayables).toHaveLength(1);
      expect(savedPayables[0].id).toBe('legacy-payable-1');
    });

    it('Test 11 (Test E): Concurrent workers repairing a partial state converge to both legs without duplicate records', async () => {
      assignmentRepo.findOne.mockResolvedValue({
        id: 'asn-concurrent-repair',
        assignmentNumber: 'ASN-CONC-001',
        status: AssignmentStatus.COMPLETED,
        projectId: 'project-1',
        assayerId: 'assayer-1',
        agreedFee: '3000.00',
        quotedTravelFee: '200.00',
        completionDate: new Date('2026-08-10T10:00:00Z'),
      });

      // Pre-existing state: entry exists, payable missing
      savedEntries.push({
        id: 'entry-seed-1',
        entryNumber: 'BE-SEED-001',
        assignmentId: 'asn-concurrent-repair',
        clientId: 'client-1',
        totalAmount: 3540,
      });

      const job1 = {
        id: 'book-assignment:asn-concurrent-repair',
        data: { assignmentId: 'asn-concurrent-repair', userId: 'worker-A' },
        attemptsMade: 0,
        opts: { attempts: 5 },
      } as any;
      const job2 = {
        id: 'book-assignment:asn-concurrent-repair',
        data: { assignmentId: 'asn-concurrent-repair', userId: 'worker-B' },
        attemptsMade: 0,
        opts: { attempts: 5 },
      } as any;

      // Two workers attempt to book / repair concurrently
      const [res1, res2] = await Promise.all([
        billingWorker.bookAssignment(job1),
        billingWorker.bookAssignment(job2),
      ]);

      const bookedCount = [res1, res2].filter((r) => r.booked).length;
      const alreadyBookedCount = [res1, res2].filter((r) => !r.booked && r.reason?.startsWith('already booked')).length;

      expect(bookedCount).toBe(1);
      expect(alreadyBookedCount).toBe(1);

      // Invariant: Both legs exist, and neither was duplicated
      expect(savedEntries).toHaveLength(1);
      expect(savedPayables).toHaveLength(1);
      expect(savedEntries[0].id).toBe('entry-seed-1');
    });

    it('Test 12 (Test F): Unique constraint violation on UQ_billing_entries_root_per_assignment or UQ_assayer_payables_fee_per_assignment never acknowledges partial state', async () => {
      assignmentRepo.findOne.mockResolvedValue({
        id: 'asn-uq-violation',
        assignmentNumber: 'ASN-UQ-001',
        status: AssignmentStatus.COMPLETED,
        projectId: 'project-1',
        assayerId: 'assayer-1',
        agreedFee: '1500.00',
        quotedTravelFee: '100.00',
      });

      // Case 1: When UQ_billing_entries_root_per_assignment fires, but payable is missing in DB
      // The worker must rethrow, NOT acknowledge as already booked!
      const originalTransaction = fakeDataSource.transaction;
      fakeDataSource.transaction.mockImplementationOnce(async (iso: any, maybeWork: any) => {
        const err: any = new Error('duplicate key value violates unique constraint "UQ_billing_entries_root_per_assignment"');
        err.code = '23505';
        err.constraint = 'UQ_billing_entries_root_per_assignment';
        throw err;
      });

      // Only entry exists in DB; payable missing
      savedEntries.push({
        id: 'entry-only-1',
        assignmentId: 'asn-uq-violation',
      });

      await expect(billingService.bookAssignment('asn-uq-violation', 'system')).rejects.toThrow(
        'duplicate key value violates unique constraint "UQ_billing_entries_root_per_assignment"',
      );

      // Case 2: When both exist, 23505 safely returns already booked (concurrent)
      savedPayables.push({
        id: 'payable-now-exists-1',
        assignmentId: 'asn-uq-violation',
        expenseId: null,
      });

      fakeDataSource.transaction.mockImplementationOnce(async (iso: any, maybeWork: any) => {
        const err: any = new Error('duplicate key value violates unique constraint "UQ_assayer_payables_fee_per_assignment"');
        err.code = '23505';
        err.constraint = 'UQ_assayer_payables_fee_per_assignment';
        throw err;
      });

      const res = await billingService.bookAssignment('asn-uq-violation', 'system');
      expect(res.booked).toBe(false);
      expect(res.reason).toBe('already booked (concurrent)');
      expect(res.entryId).toBe('entry-only-1');
      expect(res.payableId).toBe('payable-now-exists-1');
    });

    it('Test 13 (Property Convergence): bookAssignment converges to exactly 1 entry and 1 payable across all initial states (NONE, ENTRY_ONLY, PAYABLE_ONLY, BOTH)', async () => {
      const states = ['NONE', 'ENTRY_ONLY', 'PAYABLE_ONLY', 'BOTH'] as const;

      for (const initialState of states) {
        const asnId = `asn-prop-${initialState}`;
        savedEntries.length = 0;
        savedPayables.length = 0;

        assignmentRepo.findOne.mockResolvedValue({
          id: asnId,
          assignmentNumber: `ASN-PROP-${initialState}`,
          status: AssignmentStatus.COMPLETED,
          projectId: 'project-1',
          assayerId: 'assayer-1',
          agreedFee: '2000.00',
          quotedTravelFee: '200.00',
          completionDate: new Date('2026-08-10T10:00:00Z'),
        });

        if (initialState === 'ENTRY_ONLY' || initialState === 'BOTH') {
          savedEntries.push({
            id: `entry-${asnId}`,
            entryNumber: `BE-${asnId}`,
            assignmentId: asnId,
            clientId: 'client-1',
            totalAmount: 2360,
          });
        }

        if (initialState === 'PAYABLE_ONLY' || initialState === 'BOTH') {
          savedPayables.push({
            id: `payable-${asnId}`,
            payableNumber: `PY-${asnId}`,
            assignmentId: asnId,
            assayerId: 'assayer-1',
            totalAmount: 2090,
            expenseId: null,
          });
        }

        // Call bookAssignment 3 times in a row
        for (let iteration = 0; iteration < 3; iteration++) {
          const res = await billingService.bookAssignment(asnId, 'system');
          expect(res.entryId).toBeDefined();
          expect(res.payableId).toBeDefined();
        }

        // Invariant: At the end of repeated calls, exactly 1 root entry and 1 fee payable exist
        const entries = savedEntries.filter((e) => e.assignmentId === asnId);
        const payables = savedPayables.filter((p) => p.assignmentId === asnId && !p.expenseId);

        expect(entries).toHaveLength(1);
        expect(payables).toHaveLength(1);
      }
    });

    it('Test 14: partialFinancialStates correctly identifies assignments with exactly one leg missing', async () => {
      // Mock assignmentRepository.manager.query to return one entry-only and one payable-only
      const mockQuery = jest.spyOn(assignmentRepo.manager ?? (fakeDataSource as any), 'query').mockResolvedValueOnce([
        { id: 'asn-entry-only', has_entry: true, has_payable: false },
        { id: 'asn-payable-only', has_entry: false, has_payable: true },
      ]);

      const partials = await billingService.partialFinancialStates();
      expect(partials).toEqual([
        { assignmentId: 'asn-entry-only', hasEntry: true, hasPayable: false },
        { assignmentId: 'asn-payable-only', hasEntry: false, hasPayable: true },
      ]);
    });
  });
});

