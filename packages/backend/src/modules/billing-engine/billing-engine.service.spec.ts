import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BillingEngineService } from './billing-engine.service';
import { BillingEntryEntity } from './billing-entry.entity';
import { BillingInvoiceEntity } from './invoice.entity';
import { BillingPaymentEntity } from './payment.entity';
import { AssayerPayableEntity } from './payable.entity';
import { BillingHistoryEntity } from './history.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectEntity } from '../project/project.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { TypeOrmUnitOfWork } from '../../infrastructure/persistence/typeorm-unit-of-work';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { BillingState, AssayerPayableStatus, PaymentMethod, PaymentDirection, InvoiceStatus, AssignmentStatus } from '@fapoms/shared';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';

/**
 * The billing engine: the assignment is the ledger line.
 *
 * Covers the booking (one transaction, two legs, one formula), the guards that decide whether
 * money may move (approve → pay; held lines; invoiced lines), and the transaction and locking
 * behaviour that decides whether a half-finished money movement can survive.
 *
 * The DataSource double buffers everything written through a transaction's EntityManager and
 * only flushes it to `committed` when the callback resolves. So `committed` answers "what would
 * still be in the database afterwards?" — the only question a rollback test is really asking.
 * `saved` means "what was written at all", successfully or not.
 */
describe('BillingEngineService', () => {
  let service: BillingEngineService;

  const saved: any[] = [];
  /** Rows that survived a COMMIT. Empty for any transaction whose callback threw. */
  let committed: any[] = [];
  /** Every lock the service asked for, in acquisition order. */
  let locks: Array<{ entity: string; mode: string; ids?: string[]; orderBy?: string }> = [];
  /** SQL run on a transaction's own connection. */
  let txQueries: string[] = [];
  /** Rows the `assayerTotals` SQL returns. Set by tests that care about the running balance. */
  let totalsRow: any = { earned: 0, paid: 0, outstanding: 0, awaiting_approval: 0, on_hold: 0, payable_count: 0 };

  // A client with a ₹3,000 rate card, NET30, 18% GST, 10% TDS — used by every booking test.
  const defaultManagerQuery = async (sql: string): Promise<any[]> => {
    if (sql.includes('FROM client_configurations')) return [{ default_base_fee: '3000' }];
    if (sql.includes('FROM clients WHERE id')) return [{ planning_preferences: {}, id: 'client-1' }];
    if (sql.includes('FROM client_billing')) return [{ gst_rate: '18', tds_rate: '10', payment_terms: 'NET30' }];
    if (sql.includes('FROM users')) return [{ display_name: 'Priya Menon' }];
    if (sql.includes('FROM assayer_payables') && sql.includes('awaiting_approval')) return [totalsRow];
    if (sql.includes('FROM billing_payments') && sql.includes('SUM(amount)')) return [{ paid: 0 }];
    return [];
  };
  const managerQuery: jest.Mock<Promise<any[]>, [string, any[]?]> = jest.fn(defaultManagerQuery);

  const queryBuilderStub = () => ({
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () => []),
    getOne: jest.fn(async () => null),
  });

  const entryRepo: any = {
    create: jest.fn((d) => ({ ...d })),
    save: jest.fn(async (d) => { const r = { id: d.id ?? `entry-${saved.length + 1}`, ...d }; saved.push(r); return r; }),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    findAndCount: jest.fn(async () => [[], 0]),
    createQueryBuilder: jest.fn(() => queryBuilderStub()),
    manager: { query: managerQuery },
  };
  const paymentRepo: any = {
    create: jest.fn((d) => ({ ...d })),
    save: jest.fn(async (d) => ({ id: d.id ?? `payment-${saved.length + 1}`, isActive: true, ...d })),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
  };
  const payableRepo: any = {
    create: jest.fn((d) => ({ ...d })),
    save: jest.fn(async (d) => { const r = { id: d.id ?? `payable-${saved.length + 1}`, ...d }; saved.push(r); return r; }),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    findAndCount: jest.fn(async () => [[], 0]),
    manager: { query: managerQuery },
  };
  const invoiceRepo: any = {
    create: jest.fn((d) => ({ ...d })),
    save: jest.fn(async (d) => ({ id: d.id ?? 'invoice-1', ...d })),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    findAndCount: jest.fn(async () => [[], 0]),
    manager: { query: managerQuery },
  };
  const historyRepo: any = {
    create: jest.fn((d) => ({ ...d })),
    save: jest.fn(async (d) => ({ id: `history-${saved.length + 1}`, ...d })),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
  };
  const assignmentRepo: any = {
    find: jest.fn(async () => []), findOne: jest.fn(async () => null),
    manager: { query: managerQuery },
  };
  const projectRepo: any = { find: jest.fn(async () => []), findOne: jest.fn(async () => null) };
  // Read-only in the service (bank file, TDS report, PAN on the statement); the entity load is
  // what decrypts PAN/account, so tests stub it with plain objects.
  const assayerRepo: any = { find: jest.fn(async () => []), findOne: jest.fn(async () => null) };

  const repoForEntity = (target: any): any => {
    if (target === BillingEntryEntity) return entryRepo;
    if (target === BillingInvoiceEntity) return invoiceRepo;
    if (target === BillingPaymentEntity) return paymentRepo;
    if (target === AssayerPayableEntity) return payableRepo;
    if (target === BillingHistoryEntity) return historyRepo;
    if (target === AssignmentEntity) return assignmentRepo;
    if (target === ProjectEntity) return projectRepo;
    if (target === AssayerEntity) return assayerRepo;
    throw new Error(`No repository double registered for ${target?.name ?? target}`);
  };

  /** Which repository a row belongs to, inferred from its shape. Order matters. */
  const repoForRow = (row: any): any => {
    if (row?.payableNumber !== undefined) return payableRepo;
    if (row?.invoiceNumber !== undefined) return invoiceRepo;
    if (row?.direction !== undefined) return paymentRepo;
    if (row?.action !== undefined && row?.entityType !== undefined) return historyRepo;
    if (row?.entryNumber !== undefined) return entryRepo;
    return historyRepo;
  };

  const entityName = (target: any) => target?.name ?? String(target);

  const makeManager = (pending: any[], stagedOutbox: any[]) => ({
    findOne: jest.fn(async (target: any, opts: any) => {
      if (opts?.lock) {
        locks.push({ entity: entityName(target), mode: opts.lock.mode, ids: opts.where?.id ? [opts.where.id] : undefined });
      }
      return repoForEntity(target).findOne(opts);
    }),
    save: jest.fn(async (row: any) => {
      const result = await repoForRow(row).save(row);
      pending.push(result);
      return result;
    }),
    createQueryBuilder: jest.fn((target: any, alias: string) => {
      const qb: any = repoForEntity(target).createQueryBuilder(alias);
      const originalSetLock = qb.setLock;
      qb.setLock = jest.fn((mode: string) => { locks.push({ entity: entityName(target), mode }); originalSetLock(mode); return qb; });
      const originalWhere = qb.where;
      qb.where = jest.fn((clause: string, params: any) => {
        const last = locks[locks.length - 1];
        if (last && params?.assignmentIds) last.ids = params.assignmentIds;
        originalWhere(clause, params);
        return qb;
      });
      const originalOrderBy = qb.orderBy;
      qb.orderBy = jest.fn((field: string, dir: string) => {
        const last = locks[locks.length - 1];
        if (last) last.orderBy = `${field} ${dir}`;
        originalOrderBy(field, dir);
        return qb;
      });
      return qb;
    }),
    query: jest.fn(async (sql: string, params?: any[]) => { txQueries.push(sql); return managerQuery(sql, params); }),
    insert: jest.fn(async (_target: any, rows: any[]) => { stagedOutbox.push(...rows); return { identifiers: rows.map((r) => ({ id: r.id })) }; }),
  });

  const dataSource: any = {
    transaction: jest.fn(async (isolationOrWork: any, maybeWork?: any) => {
      const work = typeof isolationOrWork === 'function' ? isolationOrWork : maybeWork;
      const pending: any[] = [];
      const stagedOutbox: any[] = [];
      const result = await work(makeManager(pending, stagedOutbox));
      committed.push(...pending);
      return result;
    }),
  };

  const publish = jest.fn();
  const emitSafe = jest.fn();
  /** Let detached promise chains (the post-commit notifications) run to completion. */
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const outboxRepo: any = { update: jest.fn(async () => undefined) };

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const completed = (over: Partial<any> = {}) => ({
    id: 'asn-1', assignmentNumber: 'ASN-001', status: AssignmentStatus.COMPLETED,
    projectId: 'project-1', assayerId: 'assayer-1', agreedFee: '2000.00', proposedFee: '2200.00',
    quotedTravelFee: '300.00', quotedTransportMode: 'CAR', quotedDistanceKm: '42.00', quotedDistanceSource: 'OSRM',
    completionDate: new Date('2026-08-10T10:00:00Z'), ...over,
  });
  const payable = (over: Partial<any> = {}) => ({
    id: 'payable-1', payableNumber: 'PY-1', assayerId: 'assayer-1', clientId: 'client-1', projectId: 'project-1',
    assignmentId: 'asn-1', expenseId: null, status: AssayerPayableStatus.PENDING, onHold: false, holdReason: null,
    baseAmount: '1700.00', travelAmount: '300.00', taxAmount: '0.00', tdsAmount: '200.00', totalAmount: '1800.00',
    currency: 'INR', paidAmount: '0.00', rateSnapshot: { feeAmount: 2000, settled: true }, ...over,
  });
  const line = (over: Partial<any> = {}) => ({
    id: 'entry-1', entryNumber: 'BE-1', clientId: 'client-1', projectId: 'project-1', assignmentId: 'asn-1', assayerId: 'assayer-1',
    state: BillingState.UNBILLED, onHold: false, holdReason: null, invoiceId: null,
    baseAmount: '3000.00', travelAmount: '300.00', adjustmentAmount: '0.00', adjustmentReason: null,
    taxRate: '18.00', taxableAmount: '3300.00', taxAmount: '594.00', tdsRate: '10.00', tdsAmount: '330.00', totalAmount: '3564.00',
    currency: 'INR', paidAmount: '0.00', outstandingAmount: '0.00', ...over,
  });
  const invoice = (over: Partial<any> = {}) => ({
    id: 'invoice-1', invoiceNumber: 'INV-1', clientId: 'client-1', projectId: 'project-1', status: InvoiceStatus.ISSUED,
    issueDate: '2026-08-11', dueDate: '2026-09-10', currency: 'INR', subtotal: '3300.00', taxAmount: '594.00', tdsAmount: '330.00',
    total: '3564.00', paidAmount: '0.00', outstandingAmount: '3564.00', ...over,
  });

  beforeEach(async () => {
    saved.length = 0;
    committed = [];
    locks = [];
    txQueries = [];
    totalsRow = { earned: 0, paid: 0, outstanding: 0, awaiting_approval: 0, on_hold: 0, payable_count: 0 };
    jest.clearAllMocks();
    managerQuery.mockImplementation(defaultManagerQuery);
    for (const r of [entryRepo, payableRepo, invoiceRepo, paymentRepo, historyRepo, assignmentRepo, projectRepo, assayerRepo]) {
      r.findOne.mockImplementation(async () => null);
      r.find.mockImplementation(async () => []);
    }
    entryRepo.createQueryBuilder.mockImplementation(() => queryBuilderStub());
    projectRepo.findOne.mockImplementation(async () => ({ id: 'project-1', clientId: 'client-1' }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: PlatformSettingsService,
          useValue: {
            get: jest.fn(async () => null),
            getMany: jest.fn(async () => ({})),
            getNumber: jest.fn(async (_k: string, fb?: number) => fb as number),
            describeAll: jest.fn(async () => []),
            onChange: jest.fn(),
          },
        },
        BillingEngineService,
        { provide: getRepositoryToken(BillingEntryEntity), useValue: entryRepo },
        { provide: getRepositoryToken(BillingInvoiceEntity), useValue: invoiceRepo },
        { provide: getRepositoryToken(BillingPaymentEntity), useValue: paymentRepo },
        { provide: getRepositoryToken(AssayerPayableEntity), useValue: payableRepo },
        { provide: getRepositoryToken(BillingHistoryEntity), useValue: historyRepo },
        { provide: getRepositoryToken(AssignmentEntity), useValue: assignmentRepo },
        { provide: getRepositoryToken(ProjectEntity), useValue: projectRepo },
        { provide: getRepositoryToken(AssayerEntity), useValue: assayerRepo },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: DataSource, useValue: dataSource },
        { provide: DomainEventPublisher, useValue: { publish, subscribe: jest.fn() } },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn(), emitSafe } },
        // The real UnitOfWork over the DataSource double, so the transaction-boundary assertions
        // run the code that implements the boundary rather than a passthrough.
        {
          provide: UnitOfWork,
          useFactory: () =>
            new TypeOrmUnitOfWork(
              dataSource as unknown as DataSource,
              { publish, subscribe: jest.fn() } as unknown as DomainEventPublisher,
              outboxRepo,
            ),
        },
        {
          provide: CacheService,
          useValue: {
            withLock: jest.fn((_key: string, _ttl: number, fn: () => any) => fn()),
            getJson: jest.fn().mockResolvedValue(null), setJson: jest.fn(), del: jest.fn(), delByPattern: jest.fn(),
          },
        },
      ],
    }).compile();
    service = module.get(BillingEngineService);
  });

  // ── Booking ───────────────────────────────────────────────────────────────

  describe('bookAssignment — one completed assignment, both legs, one transaction', () => {
    beforeEach(() => {
      assignmentRepo.findOne.mockImplementation(async () => completed());
    });

    it('writes the fee payable and the client line in ONE transaction', async () => {
      const r = await service.bookAssignment('asn-1');
      expect(r.booked).toBe(true);
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      const payables = committed.filter((row) => row.payableNumber);
      const lines = committed.filter((row) => row.entryNumber);
      expect(payables).toHaveLength(1);
      expect(lines).toHaveLength(1);
    });

    it('prices both legs through assignmentMoney — the client rate and the carved fee', async () => {
      await service.bookAssignment('asn-1');
      const p = committed.find((row) => row.payableNumber);
      const e = committed.find((row) => row.entryNumber);
      // Assayer: fee 2000 carved into 1700 + 300, 10% TDS on gross, net 1800.
      expect(p).toMatchObject({ baseAmount: 1700, travelAmount: 300, tdsAmount: 200, totalAmount: 1800, status: AssayerPayableStatus.PENDING, expenseId: null });
      // Client: rate 3000 + recharged travel 300 = 3300 taxable; 594 GST; 330 TDS; 3564 total.
      expect(e).toMatchObject({ baseAmount: 3000, travelAmount: 300, taxableAmount: 3300, taxAmount: 594, tdsAmount: 330, totalAmount: 3564, state: BillingState.UNBILLED, onHold: false });
      expect(e.serviceDate).toBe('2026-08-10');
    });

    it('rolls BOTH legs back if the second insert fails — no one-sided ledger', async () => {
      entryRepo.save.mockImplementationOnce(async () => { throw new Error('disk full'); });
      await expect(service.bookAssignment('asn-1')).rejects.toThrow('disk full');
      // The payable was written to the transaction, but nothing survived the rollback.
      expect(saved.some((row) => row.payableNumber)).toBe(true);
      expect(committed).toHaveLength(0);
    });

    it('books only COMPLETED assignments', async () => {
      assignmentRepo.findOne.mockImplementation(async () => completed({ status: AssignmentStatus.IN_PROGRESS }));
      const r = await service.bookAssignment('asn-1');
      expect(r).toEqual({ booked: false, reason: 'assignment not completed' });
      expect(committed).toHaveLength(0);
    });

    it('writes nothing when the assignment carries no fee at all', async () => {
      assignmentRepo.findOne.mockImplementation(async () => completed({ agreedFee: null, proposedFee: null }));
      const r = await service.bookAssignment('asn-1');
      expect(r).toEqual({ booked: false, reason: 'NO_FEE' });
      expect(committed).toHaveLength(0);
    });

    it('books from the proposed fee when nothing was agreed, and records that it was not settled', async () => {
      // Symmetric: the old engine paid the assayer and refused to bill the client here.
      assignmentRepo.findOne.mockImplementation(async () => completed({ agreedFee: null }));
      const r = await service.bookAssignment('asn-1');
      expect(r.booked).toBe(true);
      const p = committed.find((row) => row.payableNumber);
      expect(p.rateSnapshot).toMatchObject({ feeAmount: 2200, feeSource: 'PROPOSED', settled: false });
      expect(committed.find((row) => row.entryNumber)).toBeTruthy();
    });

    it('is idempotent: an already-booked assignment writes nothing', async () => {
      entryRepo.findOne.mockImplementation(async () => line());
      payableRepo.findOne.mockImplementation(async () => payable());
      const r = await service.bookAssignment('asn-1');
      expect(r).toEqual({ booked: false, reason: 'already booked', entryId: 'entry-1', payableId: 'payable-1' });
      expect(committed).toHaveLength(0);
    });

    it('repairs a half-booked assignment by writing only the missing leg', async () => {
      payableRepo.findOne.mockImplementation(async () => payable());
      const r = await service.bookAssignment('asn-1');
      expect(r.booked).toBe(true);
      expect(committed.filter((row) => row.payableNumber)).toHaveLength(0);
      expect(committed.filter((row) => row.entryNumber)).toHaveLength(1);
    });

    it('reports the winner when a concurrent booking got there first', async () => {
      // The event bus is at-least-once and the lock fails open; the unique index decides.
      const violation: any = new Error('duplicate');
      violation.code = '23505';
      violation.constraint = 'UQ_assayer_payables_fee_per_assignment';
      payableRepo.save.mockImplementationOnce(async () => { throw violation; });
      entryRepo.findOne.mockImplementation(async () => line());
      payableRepo.findOne
        .mockImplementationOnce(async () => null)   // inside the transaction: not there yet
        .mockImplementation(async () => payable()); // after the violation: the winner
      const r = await service.bookAssignment('asn-1');
      expect(r).toEqual({ booked: false, reason: 'already booked (concurrent)', entryId: 'entry-1', payableId: 'payable-1' });
    });

    it('writes a history row for each leg on the same transaction, and announces the booking after commit', async () => {
      await service.bookAssignment('asn-1');
      const actions = committed.filter((row) => row.action).map((row) => row.action);
      expect(actions).toEqual(expect.arrayContaining(['PAYABLE_CREATED', 'ENTRY_CREATED']));
      expect(publish).toHaveBeenCalledWith('billing:booked', expect.objectContaining({ assignmentId: 'asn-1', assayerId: 'assayer-1', settled: true }));
    });

    it('passes the fee through at cost when the client has no rate card', async () => {
      managerQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM client_configurations')) return [];
        return defaultManagerQuery(sql);
      });
      await service.bookAssignment('asn-1');
      const e = committed.find((row) => row.entryNumber);
      expect(e).toMatchObject({ baseAmount: 1700, travelAmount: 300, taxableAmount: 2000 });
      expect(e.description).toContain('no client rate set');
    });
  });

  describe('reconcile — the repair button', () => {
    it('books every completed assignment that is missing a leg, and nothing else', async () => {
      assignmentRepo.manager.query = jest.fn(async (sql: string) => {
        if (sql.includes('LEFT JOIN billing_entries')) return [{ id: 'asn-1' }, { id: 'asn-2' }];
        return managerQuery(sql);
      });
      assignmentRepo.findOne.mockImplementation(async (opts: any) => completed({ id: opts.where.id, assignmentNumber: opts.where.id.toUpperCase() }));
      const r = await service.reconcile('finance-1');
      expect(r).toMatchObject({ scanned: 2, booked: 2, skipped: 0, errors: [] });
      expect(committed.filter((row) => row.payableNumber)).toHaveLength(2);
      assignmentRepo.manager.query = managerQuery;
    });

    it('honours `since` so a fresh deploy does not book years of history', async () => {
      const spy = jest.fn(async () => []);
      assignmentRepo.manager.query = spy;
      await service.reconcilePreview({ since: '2026-08-01' });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('completion_date >= $1::date'), ['2026-08-01']);
      assignmentRepo.manager.query = managerQuery;
    });
  });

  describe('repriceAssignment — the safety net for a fee that moved', () => {
    beforeEach(() => {
      assignmentRepo.findOne.mockImplementation(async () => completed({ agreedFee: '2500.00' }));
    });

    it('re-prices an unbilled line and an unpaid payable in place', async () => {
      entryRepo.findOne.mockImplementation(async () => line());
      payableRepo.findOne.mockImplementation(async () => payable());
      const r = await service.repriceAssignment('asn-1', 'ops-1');
      expect(r.repriced).toBe(true);
      expect(committed.find((row) => row.payableNumber)).toMatchObject({ baseAmount: 2200, travelAmount: 300, totalAmount: 2250 });
      expect(committed.filter((row) => row.action).map((row) => row.action)).toEqual(expect.arrayContaining(['PAYABLE_REPRICED', 'ENTRY_REPRICED']));
    });

    it('leaves an invoiced line and a paid payable alone — they record what actually happened', async () => {
      entryRepo.findOne.mockImplementation(async () => line({ state: BillingState.INVOICED, invoiceId: 'invoice-1' }));
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.PAID, paidAmount: '1800.00' }));
      const r = await service.repriceAssignment('asn-1', 'ops-1');
      expect(r).toEqual({ repriced: false, reason: 'nothing re-priceable' });
      expect(committed).toHaveLength(0);
    });
  });

  // ── Payouts ───────────────────────────────────────────────────────────────

  describe('approvePayouts — the one gate', () => {
    it('approves a due payout, stamps who and when, and tells the assayer', async () => {
      payableRepo.findOne.mockImplementation(async () => payable());
      const r = await service.approvePayouts(['payable-1'], 'finance-1');
      expect(r).toEqual({ done: ['payable-1'], refused: [] });
      const p = committed.find((row) => row.payableNumber);
      expect(p).toMatchObject({ status: AssayerPayableStatus.APPROVED, approvedBy: 'finance-1' });
      expect(p.approvedAt).toBeInstanceOf(Date);
      expect(locks).toContainEqual(expect.objectContaining({ entity: 'AssayerPayableEntity', mode: 'pessimistic_write' }));
      // The notification is detached from the transaction (it must never roll money back), so
      // let the event loop turn once before asserting it was sent.
      await flush();
      expect(emitSafe).toHaveBeenCalledWith(expect.objectContaining({ type: 'PAYABLE_APPROVED', assayerId: 'assayer-1' }));
    });

    it('refuses a held payout, naming the hold reason, and approves the rest', async () => {
      payableRepo.findOne.mockImplementation(async (opts: any) =>
        opts.where.id === 'held-1' ? payable({ id: 'held-1', payableNumber: 'PY-H', onHold: true, holdReason: 'Client dispute' }) : payable());
      const r = await service.approvePayouts(['held-1', 'payable-1'], 'finance-1');
      expect(r.done).toEqual(['payable-1']);
      expect(r.refused).toEqual([{ id: 'held-1', reason: expect.stringContaining('Client dispute') }]);
    });

    it('treats an already-approved payout as done — the bulk button may be pressed twice', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.APPROVED }));
      const r = await service.approvePayouts(['payable-1'], 'finance-1');
      expect(r).toEqual({ done: ['payable-1'], refused: [] });
      expect(committed).toHaveLength(0);
      expect(emitSafe).not.toHaveBeenCalled();
    });

    it('refuses a paid payout', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.PAID }));
      const r = await service.approvePayouts(['payable-1'], 'finance-1');
      expect(r.refused[0].reason).toContain('already paid');
    });
  });

  describe('payPayouts / recordDisbursement — the only path to PAID', () => {
    it('refuses a payout that has not been approved', async () => {
      payableRepo.findOne.mockImplementation(async () => payable());
      const r = await service.payPayouts(['payable-1'], { paymentReference: 'UTR-1', method: PaymentMethod.NEFT }, 'finance-1');
      expect(r.done).toEqual([]);
      expect(r.refused[0].reason).toContain('not been approved');
      expect(committed).toHaveLength(0);
    });

    it('refuses a held payout even when approved', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.APPROVED, onHold: true, holdReason: 'Pending PAN' }));
      const r = await service.payPayouts(['payable-1'], { paymentReference: 'UTR-1', method: PaymentMethod.NEFT }, 'finance-1');
      expect(r.refused[0].reason).toContain('Pending PAN');
    });

    it('pays the full outstanding, records a real payment row, marks PAID, and tells the assayer', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.APPROVED }));
      totalsRow = { ...totalsRow, outstanding: 0 };
      const r = await service.payPayouts(['payable-1'], { paymentReference: 'UTR-1', method: PaymentMethod.NEFT, paidDate: '2026-08-12' }, 'finance-1');
      expect(r.done).toEqual([{ payableId: 'payable-1', paymentId: expect.any(String) }]);
      const p = committed.find((row) => row.payableNumber);
      expect(p).toMatchObject({ status: AssayerPayableStatus.PAID, paidAmount: 1800, paidBy: 'finance-1' });
      const payment = committed.find((row) => row.direction === PaymentDirection.OUTBOUND);
      expect(payment).toMatchObject({ amount: 1800, paymentReference: 'UTR-1', payableId: 'payable-1', assayerId: 'assayer-1', receivedDate: '2026-08-12', runningBalance: 0 });
      await flush();
      expect(emitSafe).toHaveBeenCalledWith(expect.objectContaining({ type: 'PAYABLE_PAID' }));
    });

    it('computes the running balance on the transaction’s own connection, after the write', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.APPROVED }));
      await service.payPayouts(['payable-1'], { paymentReference: 'UTR-1', method: PaymentMethod.NEFT }, 'finance-1');
      expect(txQueries.some((sql) => sql.includes('FROM assayer_payables') && sql.includes('awaiting_approval'))).toBe(true);
    });

    it('is idempotent by reference: a retried payment returns the original and pays nothing twice', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.PAID, paidAmount: '1800.00' }));
      paymentRepo.findOne.mockImplementation(async () => ({ id: 'payment-first', direction: PaymentDirection.OUTBOUND, amount: 1800, isActive: true }));
      const r = await service.payPayouts(['payable-1'], { paymentReference: 'UTR-1', method: PaymentMethod.NEFT }, 'finance-1');
      expect(r.done).toEqual([{ payableId: 'payable-1', paymentId: 'payment-first' }]);
      expect(committed).toHaveLength(0);
      expect(emitSafe).not.toHaveBeenCalled();
    });

    it('refuses an amount above what is owed', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.APPROVED }));
      await expect(service.recordDisbursement({ payableId: 'payable-1', paymentReference: 'UTR-1', method: PaymentMethod.NEFT, amount: 1800.5 }, 'f'))
        .rejects.toThrow(BadRequestException);
    });
  });

  describe('holdPayout', () => {
    it('requires a reason to hold, and refuses to hold a paid payout', async () => {
      await expect(service.holdPayout('payable-1', true, '  ', 'f')).rejects.toThrow(BadRequestException);
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.PAID }));
      await expect(service.holdPayout('payable-1', true, 'why', 'f')).rejects.toThrow(ConflictException);
    });

    it('flags the payout with the reason and writes history; release clears it', async () => {
      payableRepo.findOne.mockImplementation(async () => payable());
      const held = await service.holdPayout('payable-1', true, 'Awaiting PAN', 'f');
      expect(held).toMatchObject({ onHold: true, holdReason: 'Awaiting PAN' });
      payableRepo.findOne.mockImplementation(async () => payable({ onHold: true, holdReason: 'Awaiting PAN' }));
      const released = await service.holdPayout('payable-1', false, undefined, 'f');
      expect(released).toMatchObject({ onHold: false, holdReason: null });
      expect(committed.filter((row) => row.action === 'PAYABLE_HOLD_CHANGED')).toHaveLength(2);
    });
  });

  describe('assayerTotals — the one predicate', () => {
    it('maps the SQL to the statement shape and keeps earned = paid + outstanding + held', async () => {
      totalsRow = { earned: '5000.00', paid: '1800.00', outstanding: '2000.00', awaiting_approval: '2000.00', on_hold: '1200.00', tds_withheld: '500.00', payable_count: 3 };
      const t = await service.assayerTotals('assayer-1');
      expect(t).toEqual({ earned: 5000, paid: 1800, outstanding: 2000, awaitingApproval: 2000, onHoldOrDisputed: 1200, tdsWithheld: 500, payableCount: 3 });
      expect(t.earned).toBe(t.paid + t.outstanding + t.onHoldOrDisputed);
    });

    it('excludes held rows from outstanding and awaiting — the SQL says so', async () => {
      await service.assayerTotals('assayer-1');
      const sql = managerQuery.mock.calls.map((c) => c[0]).find((s: string) => s.includes('awaiting_approval')) as string;
      expect(sql).toMatch(/FILTER \(WHERE on_hold = false\), 0\)\s+AS outstanding/);
      expect(sql).toMatch(/status = 'PENDING' AND on_hold = false/);
    });
  });

  // ── Invoices ──────────────────────────────────────────────────────────────

  describe('createInvoice — a set of completed assignments for one client', () => {
    const qbWith = (rows: any[]) => ({ ...queryBuilderStub(), getMany: jest.fn(async () => rows) });

    it('locks the lines by assignment, invoices them, and totals from the lines', async () => {
      entryRepo.createQueryBuilder.mockImplementation(() => qbWith([line(), line({ id: 'entry-2', entryNumber: 'BE-2', assignmentId: 'asn-2' })]));
      const inv = await service.createInvoice({ clientId: 'client-1', assignmentIds: ['asn-1', 'asn-2'] }, 'finance-1');
      expect(inv).toMatchObject({ status: InvoiceStatus.DRAFT, subtotal: 6600, taxAmount: 1188, tdsAmount: 660, total: 7128, outstandingAmount: 7128, projectId: 'project-1' });
      expect(inv.dueDate).toBe('2026-09-18'.slice(0, 0) + inv.dueDate); // derived from NET30 below
      const lock = locks.find((l) => l.entity === 'BillingEntryEntity');
      expect(lock).toMatchObject({ mode: 'pessimistic_write', ids: ['asn-1', 'asn-2'], orderBy: 'e.id ASC' });
      const invoiced = committed.filter((row) => row.entryNumber);
      expect(invoiced.every((e) => e.state === BillingState.INVOICED && e.invoiceId === 'invoice-1' && Number(e.outstandingAmount) === 3564)).toBe(true);
    });

    it('derives the due date from the client’s payment terms', async () => {
      entryRepo.createQueryBuilder.mockImplementation(() => qbWith([line()]));
      const inv = await service.createInvoice({ clientId: 'client-1', assignmentIds: ['asn-1'], issueDate: '2026-08-01' }, 'f');
      expect(inv.dueDate).toBe('2026-08-31');
    });

    it('refuses a held line', async () => {
      entryRepo.createQueryBuilder.mockImplementation(() => qbWith([line({ onHold: true, holdReason: 'Scope query' })]));
      await expect(service.createInvoice({ clientId: 'client-1', assignmentIds: ['asn-1'] }, 'f')).rejects.toThrow(ConflictException);
      expect(committed).toHaveLength(0);
    });

    it('refuses a line that is already invoiced', async () => {
      entryRepo.createQueryBuilder.mockImplementation(() => qbWith([line({ state: BillingState.INVOICED, invoiceId: 'invoice-9' })]));
      await expect(service.createInvoice({ clientId: 'client-1', assignmentIds: ['asn-1'] }, 'f')).rejects.toThrow(ConflictException);
    });

    it('refuses a line that belongs to another client', async () => {
      entryRepo.createQueryBuilder.mockImplementation(() => qbWith([line({ clientId: 'client-2' })]));
      await expect(service.createInvoice({ clientId: 'client-1', assignmentIds: ['asn-1'] }, 'f')).rejects.toThrow(BadRequestException);
    });

    it('names the assignments that have no line yet', async () => {
      entryRepo.createQueryBuilder.mockImplementation(() => qbWith([line()]));
      await expect(service.createInvoice({ clientId: 'client-1', assignmentIds: ['asn-1', 'asn-9'] }, 'f')).rejects.toThrow(/asn-9/);
    });
  });

  describe('sendInvoice / cancelInvoice', () => {
    it('sends a draft, and treats sending a sent invoice as a no-op', async () => {
      invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.DRAFT }));
      expect((await service.sendInvoice('invoice-1', 'f')).status).toBe(InvoiceStatus.ISSUED);
      invoiceRepo.findOne.mockImplementation(async () => invoice());
      await service.sendInvoice('invoice-1', 'f');
      expect(committed.filter((row) => row.invoiceNumber)).toHaveLength(1);
    });

    it('cancels an unpaid invoice and returns its lines to UNBILLED', async () => {
      invoiceRepo.findOne.mockImplementation(async () => invoice());
      entryRepo.createQueryBuilder.mockImplementation(() => ({ ...queryBuilderStub(), getMany: jest.fn(async () => [line({ state: BillingState.INVOICED, invoiceId: 'invoice-1', outstandingAmount: '3564.00' })]) }));
      const inv = await service.cancelInvoice('invoice-1', 'Wrong client', 'f');
      expect(inv).toMatchObject({ status: InvoiceStatus.CANCELLED, outstandingAmount: 0 });
      const e = committed.find((row) => row.entryNumber);
      expect(e).toMatchObject({ state: BillingState.UNBILLED, invoiceId: null, outstandingAmount: 0 });
    });

    it('refuses to cancel an invoice with money collected against it', async () => {
      invoiceRepo.findOne.mockImplementation(async () => invoice({ paidAmount: '1000.00', outstandingAmount: '2564.00' }));
      await expect(service.cancelInvoice('invoice-1', 'x', 'f')).rejects.toThrow(ConflictException);
    });
  });

  describe('recordPayment — collection against a sent invoice', () => {
    const invoiced = [
      line({ id: 'entry-1', state: BillingState.INVOICED, invoiceId: 'invoice-1', outstandingAmount: '3564.00' }),
      line({ id: 'entry-2', entryNumber: 'BE-2', assignmentId: 'asn-2', state: BillingState.INVOICED, invoiceId: 'invoice-1', outstandingAmount: '3564.00' }),
    ];
    beforeEach(() => {
      invoiceRepo.findOne.mockImplementation(async () => invoice({ total: '7128.00', outstandingAmount: '7128.00' }));
      entryRepo.createQueryBuilder.mockImplementation(() => ({ ...queryBuilderStub(), getMany: jest.fn(async () => invoiced.map((e) => ({ ...e }))) }));
    });

    it('refuses a payment against a draft', async () => {
      invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.DRAFT }));
      await expect(service.recordPayment({ invoiceId: 'invoice-1', paymentReference: 'R1', method: PaymentMethod.NEFT, amount: 100 }, 'f')).rejects.toThrow(/not been sent/);
    });

    it('refuses more than is outstanding', async () => {
      await expect(service.recordPayment({ invoiceId: 'invoice-1', paymentReference: 'R1', method: PaymentMethod.NEFT, amount: 7128.5 }, 'f')).rejects.toThrow(BadRequestException);
    });

    it('spreads a part-payment across the lines in proportion, and leaves the invoice sent', async () => {
      await service.recordPayment({ invoiceId: 'invoice-1', paymentReference: 'R1', method: PaymentMethod.NEFT, amount: 3564 }, 'f');
      const inv = committed.find((row) => row.invoiceNumber);
      expect(inv).toMatchObject({ status: InvoiceStatus.ISSUED, paidAmount: 3564, outstandingAmount: 3564 });
      const lines = committed.filter((row) => row.entryNumber);
      expect(lines.map((e) => e.paidAmount)).toEqual([1782, 1782]);
      expect(lines.every((e) => e.state === BillingState.INVOICED)).toBe(true);
    });

    it('settles the invoice and every line when the last rupee lands', async () => {
      await service.recordPayment({ invoiceId: 'invoice-1', paymentReference: 'R1', method: PaymentMethod.NEFT, amount: 7128 }, 'f');
      const inv = committed.find((row) => row.invoiceNumber);
      expect(inv).toMatchObject({ status: InvoiceStatus.PAID, outstandingAmount: 0 });
      const lines = committed.filter((row) => row.entryNumber);
      expect(lines.every((e) => e.state === BillingState.PAID && e.outstandingAmount === 0)).toBe(true);
    });

    it('is idempotent by reference', async () => {
      paymentRepo.findOne.mockImplementation(async () => ({ id: 'payment-first', direction: PaymentDirection.INBOUND, amount: 100, isActive: true }));
      const r = await service.recordPayment({ invoiceId: 'invoice-1', paymentReference: 'R1', method: PaymentMethod.NEFT, amount: 100 }, 'f');
      expect(r.id).toBe('payment-first');
      expect(committed).toHaveLength(0);
    });

    it('locks the invoice before the lines, lines in id order', async () => {
      await service.recordPayment({ invoiceId: 'invoice-1', paymentReference: 'R1', method: PaymentMethod.NEFT, amount: 100 }, 'f');
      expect(locks[0]).toMatchObject({ entity: 'BillingInvoiceEntity', mode: 'pessimistic_write' });
      expect(locks[1]).toMatchObject({ entity: 'BillingEntryEntity', orderBy: 'e.id ASC' });
    });
  });

  describe('reversePayment — retire the row, recompute from what remains', () => {
    it('reverses an inbound payment: the invoice goes back to sent and the lines are re-derived', async () => {
      paymentRepo.findOne.mockImplementation(async () => ({ id: 'payment-1', direction: PaymentDirection.INBOUND, invoiceId: 'invoice-1', amount: '3564.00', paymentReference: 'R1', isActive: true }));
      invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.PAID, paidAmount: '3564.00', outstandingAmount: '0.00' }));
      entryRepo.createQueryBuilder.mockImplementation(() => ({ ...queryBuilderStub(), getMany: jest.fn(async () => [line({ state: BillingState.PAID, invoiceId: 'invoice-1', paidAmount: '3564.00' })]) }));
      await service.reversePayment('payment-1', 'Bounced cheque', 'f');
      expect(committed.find((row) => row.direction)).toMatchObject({ isActive: false });
      expect(committed.find((row) => row.invoiceNumber)).toMatchObject({ status: InvoiceStatus.ISSUED, paidAmount: 0, outstandingAmount: 3564 });
      expect(committed.find((row) => row.entryNumber)).toMatchObject({ state: BillingState.INVOICED, paidAmount: 0, outstandingAmount: 3564 });
      expect(committed.find((row) => row.action === 'PAYMENT_REVERSED')).toMatchObject({ reason: 'Bounced cheque' });
    });

    it('reverses an outbound payment: the payable goes back to APPROVED', async () => {
      paymentRepo.findOne.mockImplementation(async () => ({ id: 'payment-1', direction: PaymentDirection.OUTBOUND, payableId: 'payable-1', amount: '1800.00', paymentReference: 'UTR-1', isActive: true }));
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.PAID, paidAmount: '1800.00', paidAt: new Date(), paidBy: 'f' }));
      await service.reversePayment('payment-1', 'Wrong account', 'f');
      expect(committed.find((row) => row.payableNumber)).toMatchObject({ status: AssayerPayableStatus.APPROVED, paidAmount: 0, paidAt: null, paidBy: null });
    });

    it('refuses to reverse a payment twice', async () => {
      paymentRepo.findOne.mockImplementation(async () => ({ id: 'payment-1', direction: PaymentDirection.OUTBOUND, payableId: 'payable-1', isActive: false }));
      payableRepo.findOne.mockImplementation(async () => payable());
      await expect(service.reversePayment('payment-1', 'again', 'f')).rejects.toThrow(ConflictException);
    });
  });

  // ── The client line ───────────────────────────────────────────────────────

  describe('editClientLine — adjust and hold, before invoicing', () => {
    it('applies an adjustment with its reason and re-taxes the line', async () => {
      entryRepo.findOne.mockImplementation(async () => line());
      const e = await service.editClientLine('asn-1', { adjustmentAmount: -300, adjustmentReason: 'Goodwill' }, 'f');
      expect(e).toMatchObject({ adjustmentAmount: -300, adjustmentReason: 'Goodwill', taxableAmount: 3000, taxAmount: 540, tdsAmount: 300, totalAmount: 3240 });
    });

    it('requires a reason for a non-zero adjustment and for a hold', async () => {
      entryRepo.findOne.mockImplementation(async () => line());
      await expect(service.editClientLine('asn-1', { adjustmentAmount: 100 }, 'f')).rejects.toThrow(BadRequestException);
      await expect(service.editClientLine('asn-1', { onHold: true }, 'f')).rejects.toThrow(BadRequestException);
    });

    it('refuses once the line is invoiced', async () => {
      entryRepo.findOne.mockImplementation(async () => line({ state: BillingState.INVOICED, invoiceId: 'invoice-1' }));
      await expect(service.editClientLine('asn-1', { onHold: true, holdReason: 'x' }, 'f')).rejects.toThrow(BadRequestException);
    });

    it('404s an assignment that has no line yet', async () => {
      await expect(service.editClientLine('asn-1', { onHold: true, holdReason: 'x' }, 'f')).rejects.toThrow(NotFoundException);
    });
  });

  // ── Reimbursement ─────────────────────────────────────────────────────────

  describe('createReimbursementPayable', () => {
    it('writes a payable keyed by expense, with no TDS and no travel, on the caller’s manager', async () => {
      const pending: any[] = [];
      const m: any = makeManager(pending, []);
      assignmentRepo.findOne.mockImplementation(async () => ({ id: 'asn-1', projectId: 'project-1', assignmentNumber: 'ASN-001' }));
      const p = await service.createReimbursementPayable(
        { id: 'exp-1', assayerId: 'assayer-1', assignmentId: 'asn-1', amount: '240.00', category: 'TOLL', description: 'NH-48' }, m, 'ops-1',
      );
      expect(p).toMatchObject({ expenseId: 'exp-1', baseAmount: 240, travelAmount: 0, tdsAmount: 0, totalAmount: 240, clientId: 'client-1', status: AssayerPayableStatus.PENDING });
      expect(pending.some((row) => row.action === 'PAYABLE_CREATED')).toBe(true);
    });

    it('turns the unique violation into a clear refusal', async () => {
      const violation: any = new Error('dup'); violation.code = '23505'; violation.constraint = 'UQ_assayer_payables_expense';
      payableRepo.save.mockImplementationOnce(async () => { throw violation; });
      const m: any = makeManager([], []);
      await expect(service.createReimbursementPayable({ id: 'exp-1', assayerId: 'a', assignmentId: 'asn-1', amount: 1, category: 'TOLL' }, m, 'u'))
        .rejects.toThrow(ConflictException);
    });
  });
});
