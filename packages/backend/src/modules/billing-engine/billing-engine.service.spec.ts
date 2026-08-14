import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BillingEngineService } from './billing-engine.service';
import { BillingEntryEntity } from './billing-entry.entity';
import { BillingInvoiceEntity } from './invoice.entity';
import { BillingPaymentEntity } from './payment.entity';
import { AssayerPayableEntity } from './payable.entity';
import { BillingConflictEntity } from './conflict.entity';
import { BillingHistoryEntity } from './history.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectEntity } from '../project/project.entity';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { TypeOrmUnitOfWork } from '../../infrastructure/persistence/typeorm-unit-of-work';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import {
  BillingLevel, BillingState, AssayerPayableStatus, PaymentMethod, PaymentDirection,
  InvoiceStatus, InvoiceType, PaymentState,
} from '@fapoms/shared';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';

/**
 * Covers the money math, the guards that decide whether money may move, and — since
 * Track B — the transaction and locking behaviour that decides whether a half-finished
 * money movement can survive.
 *
 * The DataSource double below is the part that makes the second group testable. It buffers
 * everything written through a transaction's EntityManager and only flushes it to
 * `committed` when the callback resolves. So `committed` answers "what would still be in
 * the database afterwards?", which is the only question a rollback test is really asking.
 * `saved` is the older array and means something different — "what was written at all",
 * successfully or not — and both are useful: a rollback test asserts a row appears in one
 * and not the other.
 */
describe('BillingEngineService', () => {
  let service: BillingEngineService;

  const saved: any[] = [];
  /** Rows that survived a COMMIT. Empty for any transaction whose callback threw. */
  let committed: any[] = [];
  /** Every lock the service asked for, in acquisition order. */
  let locks: Array<{ entity: string; mode: string; ids?: string[]; orderBy?: string }> = [];
  /** SQL run on a transaction's own connection (as opposed to a repository's). */
  let txQueries: string[] = [];
  /** Outbox rows written inside a transaction — the durable record of each domain event. */
  let outboxWrites: any[] = [];

  // Client contract used by every test: 18% GST, 10% TDS, NET30. Typed loosely because
  // individual tests swap in their own row shapes for the same query surface.
  const managerQuery: jest.Mock<Promise<any[]>, [string, any[]?]> = jest.fn(
    async (sql: string, _params?: any[]) => {
      if (sql.includes('FROM client_billing')) return [{ gst_rate: '18', tds_rate: '10', payment_terms: 'NET30' }];
      if (sql.includes('FROM users')) return [{ display_name: 'Priya Menon' }];
      if (sql.includes('FROM clients WHERE id')) return [{ id: 'client-1' }];
      return [];
    },
  );

  /** Restores the default contract rows after a test swaps in its own. */
  const defaultManagerQuery = async (sql: string): Promise<any[]> => {
    if (sql.includes('FROM client_billing')) return [{ gst_rate: '18', tds_rate: '10', payment_terms: 'NET30' }];
    if (sql.includes('FROM users')) return [{ display_name: 'Priya Menon' }];
    if (sql.includes('FROM clients WHERE id')) return [{ id: 'client-1' }];
    return [];
  };

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
    createQueryBuilder: jest.fn(() => queryBuilderStub()),
    manager: { query: managerQuery },
  };

  const conflictRepo: any = {
    create: jest.fn((d) => d),
    save: jest.fn(async (d) => ({ id: 'conflict-1', ...d })),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    count: jest.fn(async () => 0),
    createQueryBuilder: jest.fn(() => queryBuilderStub()),
  };

  const paymentRepo: any = {
    create: jest.fn((d) => ({ ...d })),
    save: jest.fn(async (d) => ({ id: 'payment-1', ...d })),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
  };

  const payableRepo: any = {
    create: jest.fn((d) => d),
    save: jest.fn(async (d) => ({ id: 'payable-1', ...d })),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    manager: { query: managerQuery },
  };

  const invoiceRepo: any = {
    create: jest.fn((d) => ({ ...d })),
    save: jest.fn(async (d) => ({ id: d.id ?? 'invoice-1', ...d })),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    createQueryBuilder: jest.fn(() => queryBuilderStub()),
  };

  const historyRepo: any = {
    create: jest.fn((d) => ({ ...d })),
    save: jest.fn(async (d) => ({ id: 'history-1', ...d })),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
  };

  const assignmentRepo: any = {
    create: jest.fn((d) => d), save: jest.fn(async (d) => ({ id: 'x', ...d })),
    find: jest.fn(async () => []), findOne: jest.fn(async () => null),
  };

  const projectRepo: any = {
    create: jest.fn((d) => d), save: jest.fn(async (d) => ({ id: 'x', ...d })),
    find: jest.fn(async () => []), findOne: jest.fn(async () => null),
  };

  /** Repository double for an entity class, for `manager.findOne` / `manager.createQueryBuilder`. */
  const repoForEntity = (target: any): any => {
    if (target === BillingEntryEntity) return entryRepo;
    if (target === BillingInvoiceEntity) return invoiceRepo;
    if (target === BillingPaymentEntity) return paymentRepo;
    if (target === AssayerPayableEntity) return payableRepo;
    if (target === BillingConflictEntity) return conflictRepo;
    if (target === BillingHistoryEntity) return historyRepo;
    throw new Error(`No repository double registered for ${target?.name ?? target}`);
  };

  /**
   * Which repository a row belongs to, inferred from its shape.
   *
   * `EntityManager.save(entity)` carries no entity class, so the double has to work it out.
   * Each billing table has a distinctive identifying column and the fixtures set them, so
   * the mapping is unambiguous here. Order matters: a payable and a conflict both carry
   * `status`, so the number columns are checked first.
   */
  const repoForRow = (row: any): any => {
    if (row?.payableNumber !== undefined) return payableRepo;
    if (row?.invoiceNumber !== undefined) return invoiceRepo;
    if (row?.conflictNumber !== undefined) return conflictRepo;
    if (row?.direction !== undefined) return paymentRepo;
    if (row?.action !== undefined && row?.entityType !== undefined) return historyRepo;
    if (row?.entryNumber !== undefined || row?.level !== undefined || row?.state !== undefined) return entryRepo;
    return historyRepo;
  };

  const entityName = (target: any) => target?.name ?? String(target);

  /**
   * An EntityManager double scoped to one transaction.
   *
   * Writes go to `pending` as well as to the underlying repository double, so a test can
   * distinguish "this was written" from "this survived the commit".
   */
  const makeManager = (pending: any[], stagedOutbox: any[]) => ({
    findOne: jest.fn(async (target: any, opts: any) => {
      if (opts?.lock) {
        locks.push({
          entity: entityName(target),
          mode: opts.lock.mode,
          ids: opts.where?.id ? [opts.where.id] : undefined,
        });
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
      // Record the lock the builder asks for, and the ids it was scoped to, so the
      // deadlock-ordering guarantee is assertable.
      const originalSetLock = qb.setLock;
      qb.setLock = jest.fn((mode: string) => {
        locks.push({ entity: entityName(target), mode });
        originalSetLock(mode);
        return qb;
      });
      const originalWhere = qb.where;
      qb.where = jest.fn((clause: string, params: any) => {
        const last = locks[locks.length - 1];
        if (last && params?.entryIds) last.ids = params.entryIds;
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
    query: jest.fn(async (sql: string, params?: any[]) => {
      txQueries.push(sql);
      return managerQuery(sql, params);
    }),
    // Outbox rows. Kept out of `pending` deliberately: `committed` is asserted against as the
    // set of *business* rows that survived, and the event log is not one of them.
    insert: jest.fn(async (_target: any, rows: any[]) => {
      stagedOutbox.push(...rows);
      return { identifiers: rows.map((r) => ({ id: r.id })) };
    }),
  });

  /**
   * DataSource double. Runs the callback against a fresh transaction-scoped manager and
   * flushes its writes to `committed` only if the callback resolves — so a throw models a
   * ROLLBACK rather than merely propagating an error.
   */
  const dataSource: any = {
    transaction: jest.fn(async (isolationOrWork: any, maybeWork?: any) => {
      const work = typeof isolationOrWork === 'function' ? isolationOrWork : maybeWork;
      const pending: any[] = [];
      const stagedOutbox: any[] = [];
      const result = await work(makeManager(pending, stagedOutbox));
      // Outbox rows are written inside the transaction, so a rollback must take them with it —
      // otherwise a discarded event would still be relayed a minute later.
      committed.push(...pending);
      outboxWrites.push(...stagedOutbox);
      return result;
    }),
  };

  const publish = jest.fn();
  const emitSafe = jest.fn();

  /** Marks outbox rows dispatched once the immediate publish has succeeded. */
  const outboxRepo: any = { update: jest.fn(async () => undefined) };

  beforeEach(async () => {
    saved.length = 0;
    committed = [];
    locks = [];
    txQueries = [];
    outboxWrites = [];
    jest.clearAllMocks();
    managerQuery.mockImplementation(defaultManagerQuery);
    entryRepo.manager.query = managerQuery;
    payableRepo.manager.query = managerQuery;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: PlatformSettingsService,
          // Nothing configured in tests: every lookup falls through to the caller's fallback,
          // which is the shipped constant.
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
        { provide: getRepositoryToken(BillingConflictEntity), useValue: conflictRepo },
        { provide: getRepositoryToken(BillingHistoryEntity), useValue: historyRepo },
        { provide: getRepositoryToken(AssignmentEntity), useValue: assignmentRepo },
        { provide: getRepositoryToken(ProjectEntity), useValue: projectRepo },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: DataSource, useValue: dataSource },
        { provide: DomainEventPublisher, useValue: { publish, subscribe: jest.fn() } },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn(), emitSafe } },
        // The real UnitOfWork over the same DataSource double, rather than a stub that just
        // calls the callback. The transaction-boundary and post-commit-event assertions below
        // are assertions about the boundary, so they have to run the code that implements it —
        // a stub would let `inTx` degrade to a passthrough and every one of them would still
        // pass.
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
            // Run the guarded work immediately, unlocked — the guards themselves are
            // what these tests exercise.
            withLock: jest.fn((_key: string, _ttl: number, fn: () => any) => fn()),
            getJson: jest.fn().mockResolvedValue(null),
            setJson: jest.fn(),
            del: jest.fn(),
            delByPattern: jest.fn(),
          },
        },
      ],
    }).compile();
    service = module.get(BillingEngineService);
  });

  describe('money math', () => {
    it('withholds TDS at the given rate instead of dropping it', async () => {
      const entry = await service.createEntry(
        { level: BillingLevel.CLIENT, clientId: 'client-1', baseAmount: 1000, taxRate: 18, tdsRate: 10 },
        'user-1',
      );
      // 1000 taxable, +18% GST, −10% TDS. TDS used to be read off `tdsAmount`
      // (a rupee figure) as though it were a percentage, so it was always 0 and
      // the client was over-billed by the withheld amount.
      expect(Number(entry.taxableAmount)).toBe(1000);
      expect(Number(entry.taxAmount)).toBe(180);
      expect(Number(entry.tdsAmount)).toBe(100);
      expect(Number(entry.totalAmount)).toBe(1080);
    });

    it("falls back to the client's contracted rates when none are supplied", async () => {
      const entry = await service.createEntry(
        { level: BillingLevel.CLIENT, clientId: 'client-1', baseAmount: 1000 },
        'user-1',
      );
      expect(Number(entry.taxRate)).toBe(18);
      expect(Number(entry.tdsRate)).toBe(10);
      expect(Number(entry.totalAmount)).toBe(1080);
    });

    it('keeps base immutable so a second recompute does not re-add travel', async () => {
      const entry = await service.createEntry(
        { level: BillingLevel.CLIENT, clientId: 'client-1', baseAmount: 1000, travelAmount: 200, taxRate: 0, tdsRate: 0 },
        'user-1',
      );
      expect(Number(entry.baseAmount)).toBe(1000); // not 1200
      expect(Number(entry.taxableAmount)).toBe(1200);

      // Adjusting recomputes; travel must not be folded in a second time.
      entryRepo.findOne.mockResolvedValueOnce({ ...entry, paidAmount: 0 });
      const adjusted = await service.adjustEntry(entry.id, 100, 'scope change', 'user-1');
      expect(Number(adjusted.baseAmount)).toBe(1000);
      expect(Number(adjusted.taxableAmount)).toBe(1300); // 1000 + 200 + 100
    });

    it('separates assayer fee from travel so the columns reconcile', async () => {
      const payable = await service.createPayable(
        { assayerId: 'assayer-1', baseAmount: 2456, travelAmount: 500, tdsRate: 10 },
        'user-1',
      );
      // fee and travel stay distinct; total = (fee + travel) − 10% TDS
      expect(Number(payable.baseAmount)).toBe(2456);
      expect(Number(payable.travelAmount)).toBe(500);
      expect(Number(payable.tdsAmount)).toBe(295.6);
      expect(Number(payable.totalAmount)).toBe(2660.4);
    });
  });

  describe('guards on money movement', () => {
    it('blocks a transition only when a conflict names that entry', async () => {
      const entry = { id: 'entry-1', state: BillingState.READY_FOR_BILLING, clientId: 'client-1' };
      entryRepo.findOne.mockResolvedValue(entry);

      // No conflict references this entry → the transition proceeds. Previously any
      // blocking conflict anywhere in the system froze billing for every client.
      await expect(service.transitionEntry('entry-1', BillingState.DRAFT, 'user-1')).resolves.toBeDefined();

      conflictRepo.createQueryBuilder.mockReturnValueOnce({
        ...queryBuilderStub(),
        getOne: jest.fn(async () => ({ conflictNumber: 'BC-1', description: 'Duplicate suspected' })),
      });
      entryRepo.findOne.mockResolvedValue({ ...entry, state: BillingState.READY_FOR_BILLING });
      await expect(service.transitionEntry('entry-1', BillingState.DRAFT, 'user-1')).rejects.toThrow(ConflictException);
    });

    it('refuses to re-price an entry that already has money collected', async () => {
      entryRepo.findOne.mockResolvedValue({ id: 'entry-1', entryNumber: 'BE-1', paidAmount: 500, state: BillingState.INVOICED });
      await expect(service.adjustEntry('entry-1', -100, 'discount', 'user-1')).rejects.toThrow(ConflictException);
    });

    it('refuses to merge entries belonging to different clients', async () => {
      entryRepo.createQueryBuilder.mockReturnValueOnce({
        ...queryBuilderStub(),
        getMany: jest.fn(async () => [
          { id: 'a', clientId: 'client-1', entryNumber: 'BE-A', paidAmount: 0, invoiceId: null },
          { id: 'b', clientId: 'client-2', entryNumber: 'BE-B', paidAmount: 0, invoiceId: null },
        ]),
      });
      await expect(service.mergeEntries(['a', 'b'], 'user-1')).rejects.toThrow(BadRequestException);
    });

    it('refuses to merge entries already invoiced or part-paid', async () => {
      entryRepo.createQueryBuilder.mockReturnValueOnce({
        ...queryBuilderStub(),
        getMany: jest.fn(async () => [
          { id: 'a', clientId: 'client-1', entryNumber: 'BE-A', paidAmount: 0, invoiceId: 'inv-1' },
          { id: 'b', clientId: 'client-1', entryNumber: 'BE-B', paidAmount: 0, invoiceId: null },
        ]),
      });
      await expect(service.mergeEntries(['a', 'b'], 'user-1')).rejects.toThrow(ConflictException);
    });

    it('refuses to split an entry that is already invoiced', async () => {
      // `mergeEntries` has always refused this; the split path did not, so the same line
      // could be split out from under an invoice that referenced it.
      entryRepo.findOne.mockResolvedValueOnce({
        id: 'entry-1', entryNumber: 'BE-1', totalAmount: 1000, paidAmount: 0, invoiceId: 'inv-1',
        state: BillingState.INVOICED, parentEntryId: null,
      });
      await expect(
        service.splitEntry('entry-1', { amounts: [400, 600] }, 'user-1'),
      ).rejects.toThrow(ConflictException);
    });
  });

  // =========================================================================
  // Track B — transactional boundaries and row locking
  // =========================================================================

  describe('transaction boundaries', () => {
    const issuedInvoice = () => ({
      id: 'inv-1', invoiceNumber: 'INV-1', clientId: 'client-1', projectId: 'proj-1',
      currency: 'INR', status: InvoiceStatus.ISSUED,
      total: 1000, paidAmount: 0, outstandingAmount: 1000,
    });

    const invoiceEntries = () => [
      { id: 'entry-a', entryNumber: 'BE-A', state: BillingState.INVOICED, clientId: 'client-1', paidAmount: 0, outstandingAmount: 600 },
      { id: 'entry-b', entryNumber: 'BE-B', state: BillingState.INVOICED, clientId: 'client-1', paidAmount: 0, outstandingAmount: 400 },
    ];

    const arrangePayment = (entries = invoiceEntries()) => {
      invoiceRepo.findOne.mockResolvedValue(issuedInvoice());
      entryRepo.createQueryBuilder.mockReturnValue({
        ...queryBuilderStub(),
        getMany: jest.fn(async () => entries),
      });
    };

    it('writes the payment, the invoice and every entry in one transaction', async () => {
      arrangePayment();

      await service.recordPayment(
        { invoiceId: 'inv-1', paymentReference: 'NEFT-1', method: PaymentMethod.NEFT, amount: 1000 },
        'user-1',
      );

      // One transaction, not the 2+N autocommits this used to be.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      // READ COMMITTED is explicit: the FOR UPDATE locks below rely on the second writer
      // re-reading at the new committed value rather than aborting.
      expect(dataSource.transaction.mock.calls[0][0]).toBe('READ COMMITTED');

      // Payment + invoice + 2 entries + history all survived the same commit.
      expect(committed.some((r) => r.direction === PaymentDirection.INBOUND)).toBe(true);
      expect(committed.some((r) => r.id === 'inv-1' && r.status === InvoiceStatus.PAID)).toBe(true);
      expect(committed.filter((r) => r.id === 'entry-a' || r.id === 'entry-b')).toHaveLength(2);
    });

    it('rolls the payment back when applying it to an entry fails', async () => {
      arrangePayment();
      // The DB rejects the second entry write — a constraint violation, a statement
      // timeout, a dropped connection. Before Track B the payment row and the invoice
      // update had already committed by this point and stayed committed.
      entryRepo.save.mockImplementationOnce(async (d: any) => { saved.push(d); return d; })
                    .mockImplementationOnce(async () => { throw new Error('deadlock detected'); });

      await expect(
        service.recordPayment(
          { invoiceId: 'inv-1', paymentReference: 'NEFT-2', method: PaymentMethod.NEFT, amount: 1000 },
          'user-1',
        ),
      ).rejects.toThrow('deadlock detected');

      // Nothing survives: no payment, no invoice adjustment, no partial entry allocation.
      expect(committed).toHaveLength(0);
      // The payment row was attempted — proving the failure happened mid-sequence and the
      // rollback is what removed it, not an early guard that stopped before writing.
      expect(paymentRepo.save).toHaveBeenCalled();
    });

    it('publishes payment-received only after the transaction commits', async () => {
      arrangePayment();
      entryRepo.save.mockImplementationOnce(async () => { throw new Error('write conflict'); });

      await expect(
        service.recordPayment(
          { invoiceId: 'inv-1', paymentReference: 'NEFT-3', method: PaymentMethod.NEFT, amount: 1000 },
          'user-1',
        ),
      ).rejects.toThrow('write conflict');

      // The bus is synchronous and in-process. Publishing inside the transaction would have
      // told every subscriber that money had arrived, and then rolled it back underneath them.
      expect(publish).not.toHaveBeenCalledWith('billing:payment-received', expect.anything());
    });

    it('records the invoice status the payment actually moved from', async () => {
      arrangePayment();

      await service.recordPayment(
        { invoiceId: 'inv-1', paymentReference: 'NEFT-4', method: PaymentMethod.NEFT, amount: 1000 },
        'user-1',
      );

      const history = historyRepo.create.mock.calls
        .map((c: any[]) => c[0])
        .find((h: any) => h.action === 'PAYMENT_RECEIVED');
      // A single payment settling an ISSUED invoice outright is the common case, and the
      // trail used to infer the prior status backwards from the new one and call it
      // PARTIALLY_PAID — a state this invoice was never in.
      expect(history.fromState).toBe(InvoiceStatus.ISSUED);
      expect(history.toState).toBe(InvoiceStatus.PAID);
    });

    it('refuses a payment larger than the invoice outstanding', async () => {
      arrangePayment();
      await expect(
        service.recordPayment(
          { invoiceId: 'inv-1', paymentReference: 'NEFT-5', method: PaymentMethod.NEFT, amount: 1500 },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(committed).toHaveLength(0);
    });

    it('returns the original payment when the same reference is submitted twice', async () => {
      // The invoice is already PAID because the first call settled it. A retry carries the
      // same paymentReference; without idempotency it would either record a second payment or,
      // here, be rejected by the overpayment guard for a payment that already succeeded. The
      // existing-payment check runs before that guard, so the retry is a no-op that returns
      // the first result.
      invoiceRepo.findOne.mockResolvedValue({
        ...issuedInvoice(), status: InvoiceStatus.PAID, paidAmount: 1000, outstandingAmount: 0,
      });
      const original = {
        id: 'payment-first', direction: PaymentDirection.INBOUND, paymentReference: 'NEFT-DUP', amount: 1000,
      };
      paymentRepo.findOne.mockResolvedValueOnce(original);

      const result = await service.recordPayment(
        { invoiceId: 'inv-1', paymentReference: 'NEFT-DUP', method: PaymentMethod.NEFT, amount: 1000 },
        'user-1',
      );

      expect(result).toBe(original);
      // No second payment, no invoice mutation, no history — nothing committed at all.
      expect(committed).toHaveLength(0);
      expect(paymentRepo.save).not.toHaveBeenCalled();
    });

    it('refuses to commit an allocation that credits more than was received', async () => {
      arrangePayment(); // entries outstanding 600 + 400 against a 1000 invoice
      // A ₹500 part-payment allocated to only one of the two entries. entry-a takes the
      // whole 500 because it is named; entry-b still takes its pro-rata slice of the same
      // 500 (400/1000 × 500 = 200) because it is not. 700 credited for 500 received.
      await expect(
        service.recordPayment(
          {
            invoiceId: 'inv-1', paymentReference: 'NEFT-6', method: PaymentMethod.NEFT,
            amount: 500, allocatedToEntryIds: ['entry-a'],
          },
          'user-1',
        ),
      ).rejects.toThrow(ConflictException);
      // The point of raising it rather than clamping: the money is still intact and the
      // caller finds out, instead of the ledger quietly ceasing to reconcile.
      expect(committed).toHaveLength(0);
    });

    it('allocates a full payment across every entry without tripping the guard', async () => {
      arrangePayment();
      // The `Math.min(share, outstanding)` clamp means a payment that settles the invoice
      // outright cannot over-credit even when partially allocated — each entry absorbs at
      // most its own balance and those sum to the invoice. The guard must not fire here.
      const payment = await service.recordPayment(
        {
          invoiceId: 'inv-1', paymentReference: 'NEFT-6b', method: PaymentMethod.NEFT,
          amount: 1000, allocatedToEntryIds: ['entry-a'],
        },
        'user-1',
      );
      expect(Number(payment.amount)).toBe(1000);
      expect(committed.some((r) => r.id === 'entry-a' && r.paymentState === PaymentState.PAID)).toBe(true);
      expect(committed.some((r) => r.id === 'entry-b' && r.paymentState === PaymentState.PAID)).toBe(true);
    });

    it('rolls a state transition back when its history row cannot be written', async () => {
      entryRepo.findOne.mockResolvedValue({
        id: 'entry-1', entryNumber: 'BE-1', state: BillingState.READY_FOR_BILLING, clientId: 'client-1',
      });
      historyRepo.save.mockImplementationOnce(async () => { throw new Error('history insert failed'); });

      await expect(
        service.transitionEntry('entry-1', BillingState.DRAFT, 'user-1'),
      ).rejects.toThrow('history insert failed');

      // A state change with no record of who made it is exactly what an audit trail for a
      // bank cannot contain, so the change goes back rather than the record being optional.
      expect(committed).toHaveLength(0);
      expect(publish).not.toHaveBeenCalledWith('billing:entry-state-changed', expect.anything());
    });

    it('keeps each row in a bulk transition independent', async () => {
      const rows: Record<string, any> = {
        'entry-ok': { id: 'entry-ok', entryNumber: 'BE-OK', state: BillingState.READY_FOR_BILLING, clientId: 'client-1' },
        'entry-bad': { id: 'entry-bad', entryNumber: 'BE-BAD', state: BillingState.PAID, clientId: 'client-1' },
      };
      entryRepo.findOne.mockImplementation(async (opts: any) => rows[opts.where.id] ?? null);

      const result = await service.bulkTransitionEntries(
        ['entry-ok', 'entry-bad'], BillingState.DRAFT, 'user-1',
      );

      // One transaction per row, so the invalid row rolls back alone.
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(result.succeeded).toEqual([{ id: 'entry-ok', from: BillingState.READY_FOR_BILLING, to: BillingState.DRAFT }]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].id).toBe('entry-bad');
      // The good row is still committed — an operator selecting two hundred lines expects
      // the valid ones to move.
      expect(committed.some((r) => r.id === 'entry-ok')).toBe(true);
    });

    it('reports the from-state read under the lock, not one glanced at beforehand', async () => {
      // First read (were it unlocked) would say SUBMITTED; the value seen under the lock
      // is APPROVED, because another writer got there first.
      entryRepo.findOne.mockResolvedValue({
        id: 'entry-1', entryNumber: 'BE-1', state: BillingState.APPROVED, clientId: 'client-1',
      });

      const result = await service.bulkTransitionEntries(['entry-1'], BillingState.INVOICED, 'user-1');
      expect(result.succeeded[0].from).toBe(BillingState.APPROVED);
    });

    it('treats "already in the target state" as skipped, not failed', async () => {
      entryRepo.findOne.mockResolvedValue({
        id: 'entry-1', entryNumber: 'BE-1', state: BillingState.DRAFT, clientId: 'client-1',
      });
      const result = await service.bulkTransitionEntries(['entry-1'], BillingState.DRAFT, 'user-1');
      expect(result.skipped).toEqual([{ id: 'entry-1', current: BillingState.DRAFT, reason: 'Already DRAFT' }]);
      expect(result.failed).toHaveLength(0);
    });

    it('rolls an invoice back rather than leaving some entries marked INVOICED', async () => {
      const entries = [
        { id: 'entry-a', entryNumber: 'BE-A', state: BillingState.APPROVED, clientId: 'client-1', invoiceId: null, currency: 'INR', taxableAmount: 600, taxAmount: 0, tdsAmount: 0, discountAmount: 0, totalAmount: 600 },
        { id: 'entry-b', entryNumber: 'BE-B', state: BillingState.APPROVED, clientId: 'client-1', invoiceId: null, currency: 'INR', taxableAmount: 400, taxAmount: 0, tdsAmount: 0, discountAmount: 0, totalAmount: 400 },
      ];
      entryRepo.createQueryBuilder.mockReturnValue({ ...queryBuilderStub(), getMany: jest.fn(async () => entries) });
      entryRepo.save.mockImplementationOnce(async (d: any) => { saved.push(d); return d; })
                    .mockImplementationOnce(async () => { throw new Error('constraint violation'); });

      await expect(
        service.createInvoice(
          { clientId: 'client-1', type: InvoiceType.CONSOLIDATED, entryIds: ['entry-a', 'entry-b'] },
          'user-1',
        ),
      ).rejects.toThrow('constraint violation');

      // Otherwise: an invoice exists, entry-a points at it and is INVOICED, entry-b is still
      // APPROVED and free to be invoiced again — the same work billed twice.
      expect(committed).toHaveLength(0);
    });
  });

  describe('row locking', () => {
    it('takes a write lock on the entry before evaluating any transition guard', async () => {
      entryRepo.findOne.mockResolvedValue({
        id: 'entry-1', entryNumber: 'BE-1', state: BillingState.READY_FOR_BILLING, clientId: 'client-1',
      });

      await service.transitionEntry('entry-1', BillingState.DRAFT, 'user-1');

      const entryLock = locks.find((l) => l.entity === 'BillingEntryEntity');
      expect(entryLock).toEqual({ entity: 'BillingEntryEntity', mode: 'pessimistic_write', ids: ['entry-1'] });
      // The lock is the first thing the transaction does — guards evaluated before it would
      // be judging a row another writer can still change.
      expect(locks[0]).toBe(entryLock);
    });

    it('locks the invoice before checking whether the payment overpays it', async () => {
      invoiceRepo.findOne.mockResolvedValue({
        id: 'inv-1', invoiceNumber: 'INV-1', clientId: 'client-1', projectId: null,
        currency: 'INR', status: InvoiceStatus.ISSUED, total: 1000, paidAmount: 0, outstandingAmount: 1000,
      });
      entryRepo.createQueryBuilder.mockReturnValue({ ...queryBuilderStub(), getMany: jest.fn(async () => []) });

      await service.recordPayment(
        { invoiceId: 'inv-1', paymentReference: 'NEFT-7', method: PaymentMethod.NEFT, amount: 400 },
        'user-1',
      );

      expect(locks[0]).toEqual({ entity: 'BillingInvoiceEntity', mode: 'pessimistic_write', ids: ['inv-1'] });
    });

    it('locks multi-entry operations in a stable id order', async () => {
      const entries = [
        { id: 'entry-a', entryNumber: 'BE-A', state: BillingState.APPROVED, clientId: 'client-1', invoiceId: null, paidAmount: 0, totalAmount: 600, baseAmount: 600, taxAmount: 0, tdsAmount: 0 },
        { id: 'entry-b', entryNumber: 'BE-B', state: BillingState.APPROVED, clientId: 'client-1', invoiceId: null, paidAmount: 0, totalAmount: 400, baseAmount: 400, taxAmount: 0, tdsAmount: 0 },
      ];
      entryRepo.createQueryBuilder.mockReturnValue({ ...queryBuilderStub(), getMany: jest.fn(async () => entries) });

      await service.mergeEntries(['entry-b', 'entry-a'], 'user-1');

      const lock = locks.find((l) => l.entity === 'BillingEntryEntity');
      expect(lock?.mode).toBe('pessimistic_write');
      // Ordering is what stops a merge and a payment over the same lines from deadlocking:
      // both acquire entry-a before entry-b and one simply waits.
      expect(lock?.orderBy).toBe('e.id ASC');
    });

    it('inherits the source line from the caller order, not the lock order', async () => {
      const entries = [
        { id: 'entry-a', entryNumber: 'BE-A', state: BillingState.APPROVED, clientId: 'client-1', projectId: 'proj-a', invoiceId: null, paidAmount: 0, totalAmount: 600, baseAmount: 600, taxAmount: 0, tdsAmount: 0, level: BillingLevel.ASSIGNMENT },
        { id: 'entry-b', entryNumber: 'BE-B', state: BillingState.APPROVED, clientId: 'client-1', projectId: 'proj-b', invoiceId: null, paidAmount: 0, totalAmount: 400, baseAmount: 400, taxAmount: 0, tdsAmount: 0, level: BillingLevel.ASSIGNMENT },
      ];
      entryRepo.createQueryBuilder.mockReturnValue({ ...queryBuilderStub(), getMany: jest.fn(async () => entries) });

      // Caller names entry-b first, so the merged line is entry-b's. Rows are still locked
      // a-then-b; the two orders are deliberately independent.
      const merged = await service.mergeEntries(['entry-b', 'entry-a'], 'user-1');
      expect(merged.projectId).toBe('proj-b');
    });

    it('locks the payable before deciding how much is still owed', async () => {
      payableRepo.findOne.mockResolvedValue({
        id: 'payable-1', payableNumber: 'PY-1', assayerId: 'assayer-1', clientId: 'client-1',
        projectId: null, assignmentId: 'asn-1', status: AssayerPayableStatus.APPROVED,
        totalAmount: 1000, paidAmount: 0, currency: 'INR',
      });

      await service.recordDisbursement(
        { payableId: 'payable-1', paymentReference: 'NEFT-8', method: PaymentMethod.NEFT }, 'user-1',
      );

      expect(locks[0]).toEqual({ entity: 'AssayerPayableEntity', mode: 'pessimistic_write', ids: ['payable-1'] });
    });

    it("computes the assayer's running balance on the transaction's own connection", async () => {
      payableRepo.findOne.mockResolvedValue({
        id: 'payable-1', payableNumber: 'PY-1', assayerId: 'assayer-1', clientId: 'client-1',
        projectId: null, assignmentId: 'asn-1', status: AssayerPayableStatus.APPROVED,
        totalAmount: 1000, paidAmount: 0, currency: 'INR',
      });

      await service.recordDisbursement(
        { payableId: 'payable-1', paymentReference: 'NEFT-11', method: PaymentMethod.NEFT }, 'user-1',
      );

      // On a separate connection this SUM would not see the paidAmount written moments
      // earlier, and the balance stamped on the payment row would be stale on arrival.
      expect(txQueries.some((sql) => sql.includes('FROM assayer_payables'))).toBe(true);
    });
  });

  describe('billing the client at their contracted rate (margin)', () => {
    const completedAssignment = {
      id: 'asn-1', assignmentNumber: 'ASN-1', status: 'COMPLETED',
      assayerId: 'as-1', projectId: 'proj-1', agreedFee: 2000, completionDate: new Date('2026-08-20'),
    };

    beforeEach(() => {
      assignmentRepo.find.mockResolvedValue([completedAssignment]);
      assignmentRepo.findOne.mockResolvedValue(completedAssignment);
      // No existing entries or payables, so both legs are created fresh.
      entryRepo.find.mockResolvedValue([]);
      payableRepo.findOne.mockResolvedValue(null);
    });

    it('bills the client the contracted base fee, not the assayer fee, creating margin', async () => {
      const q = async (sql: string): Promise<any[]> => {
        if (sql.includes('default_base_fee')) return [{ default_base_fee: '3000' }];
        if (sql.includes('planning_preferences')) return [{ planning_preferences: {} }];
        if (sql.includes('assayer_commercial_profiles')) return [{ base_fee: '2000', travel_reimbursement: '0', daily_rate: '0' }];
        if (sql.includes('FROM clients WHERE id')) return [{ id: 'client-1' }];
        if (sql.includes('FROM client_billing')) return [{ gst_rate: '18', tds_rate: '10', payment_terms: 'NET30' }];
        return [];
      };
      entryRepo.manager.query = q;
      payableRepo.manager.query = q;
      managerQuery.mockImplementation(q);
      projectRepo.find = jest.fn(async () => [{ id: 'proj-1', clientId: 'client-1' }]);

      await service.syncFromAssignments('user-1');

      // The entry (what the client pays) is booked at the client rate 3000; the payable (what
      // the assayer is paid) stays at the agreed fee 2000. Margin = 1000, no longer zero.
      const entry = saved.find((r) => r.level === 'ASSIGNMENT' && r.clientId === 'client-1');
      expect(entry).toBeDefined();
      expect(Number(entry.baseAmount)).toBe(3000);
    });

    it('falls back to the assayer fee when the client has set no rate', async () => {
      const q = async (sql: string): Promise<any[]> => {
        if (sql.includes('default_base_fee')) return [{ default_base_fee: null }];
        if (sql.includes('planning_preferences')) return [{ planning_preferences: {} }];
        if (sql.includes('assayer_commercial_profiles')) return [{ base_fee: '2000', travel_reimbursement: '0', daily_rate: '0' }];
        if (sql.includes('FROM clients WHERE id')) return [{ id: 'client-1' }];
        if (sql.includes('FROM client_billing')) return [{ gst_rate: '18', tds_rate: '10', payment_terms: 'NET30' }];
        return [];
      };
      entryRepo.manager.query = q;
      payableRepo.manager.query = q;
      managerQuery.mockImplementation(q);
      projectRepo.find = jest.fn(async () => [{ id: 'proj-1', clientId: 'client-1' }]);

      await service.syncFromAssignments('user-1');

      const entry = saved.find((r) => r.level === 'ASSIGNMENT' && r.clientId === 'client-1');
      expect(Number(entry.baseAmount)).toBe(2000);
    });
  });

  describe('payable rate snapshot', () => {
    it('records the agreed fee it actually booked, not the profile standard rate', async () => {
      // Completed assignment agreed at 2000; the assayer's standard profile rate is 3406.
      assignmentRepo.findOne.mockResolvedValue({
        id: 'asn-1', assignmentNumber: 'ASN-1', status: 'COMPLETED',
        assayerId: 'as-1', projectId: 'proj-1', agreedFee: 2000, proposedFee: 2100,
      });
      payableRepo.findOne.mockResolvedValue(null);
      // The commercial-profile lookup (via manager.query) returns the standard rate.
      const q = payableRepo.manager.query as jest.Mock;
      q.mockImplementation(async (sql: string): Promise<any[]> => {
        if (sql.includes('assayer_commercial_profiles')) return [{ base_fee: '3406', travel_reimbursement: '313', daily_rate: '5000' }];
        if (sql.includes('FROM clients WHERE id')) return [{ id: 'client-1' }];
        return [];
      });
      let captured: any = null;
      payableRepo.save.mockImplementation(async (d: any) => { captured = d; return { id: 'payable-1', ...d }; });

      await service.syncPayableForAssignment('asn-1', 'user-1');

      // The payable is booked at the agreed fee, and the snapshot must justify that number.
      expect(Number(captured.baseAmount)).toBe(2000);
      expect(Number(captured.rateSnapshot.baseFee)).toBe(2000);
      // The profile's standard rate is kept for context, clearly separated, never conflated
      // with the amount actually paid.
      expect(Number(captured.rateSnapshot.profileStandardBaseFee)).toBe(3406);
    });
  });

  describe('assayer disbursement', () => {
    const approved = {
      id: 'payable-1', payableNumber: 'PY-1', assayerId: 'assayer-1', clientId: 'client-1',
      projectId: null, assignmentId: 'asn-1', status: AssayerPayableStatus.APPROVED,
      totalAmount: 2660.4, paidAmount: 0, currency: 'INR',
    };

    it('refuses to pay out a payable that has not been approved', async () => {
      payableRepo.findOne.mockResolvedValueOnce({ ...approved, status: AssayerPayableStatus.PENDING });
      await expect(
        service.recordDisbursement({ payableId: 'payable-1', paymentReference: 'NEFT-1', method: PaymentMethod.NEFT }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
      expect(committed).toHaveLength(0);
    });

    it('refuses to pay out more than is owed', async () => {
      payableRepo.findOne.mockResolvedValueOnce({ ...approved });
      await expect(
        service.recordDisbursement(
          { payableId: 'payable-1', paymentReference: 'NEFT-1', method: PaymentMethod.NEFT, amount: 5000 },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(committed).toHaveLength(0);
    });

    it('settles the full balance by default and marks the payable PAID', async () => {
      const row = { ...approved };
      payableRepo.findOne.mockResolvedValueOnce(row);
      payableRepo.save.mockImplementationOnce(async (d: any) => d);

      const payment = await service.recordDisbursement(
        { payableId: 'payable-1', paymentReference: 'NEFT-9', method: PaymentMethod.NEFT }, 'user-1',
      );

      // Recorded as an ordinary payment row, just outbound — this is what makes
      // cash-flow answerable from one table instead of a separate ledger module.
      expect(payment.direction).toBe(PaymentDirection.OUTBOUND);
      expect(Number(payment.amount)).toBe(2660.4);
      expect(payment.assayerId).toBe('assayer-1');
      expect(row.status).toBe(AssayerPayableStatus.PAID);
      expect(Number(row.paidAmount)).toBe(2660.4);
    });

    it('returns the original disbursement when the same reference is submitted twice', async () => {
      // A retried disbursement must not pay the assayer a second time. The payable is already
      // PAID from the first call, which would trip the "already fully paid" guard on a naive
      // retry; the existing-disbursement check runs first and returns the original.
      payableRepo.findOne.mockResolvedValueOnce({
        ...approved, status: AssayerPayableStatus.PAID, paidAmount: 2660.4,
      });
      const original = {
        id: 'disb-first', direction: PaymentDirection.OUTBOUND, paymentReference: 'NEFT-DUP',
        payableId: 'payable-1', amount: 2660.4,
      };
      paymentRepo.findOne.mockResolvedValueOnce(original);

      const result = await service.recordDisbursement(
        { payableId: 'payable-1', paymentReference: 'NEFT-DUP', method: PaymentMethod.NEFT, amount: 2660.4 },
        'user-1',
      );

      expect(result).toBe(original);
      expect(committed).toHaveLength(0);
      expect(payableRepo.save).not.toHaveBeenCalled();
    });

    it('records the status the payable actually moved from on a settling top-up', async () => {
      // Second disbursement against a payable already marked PAID by the first. The trail
      // hardcoded APPROVED here, so a top-up was indistinguishable from a first payment.
      payableRepo.findOne.mockResolvedValueOnce({
        ...approved, status: AssayerPayableStatus.PAID, paidAmount: 2000,
      });
      payableRepo.save.mockImplementationOnce(async (d: any) => d);

      await service.recordDisbursement(
        { payableId: 'payable-1', paymentReference: 'NEFT-12', method: PaymentMethod.NEFT, amount: 660.4 },
        'user-1',
      );

      const history = historyRepo.create.mock.calls
        .map((c: any[]) => c[0])
        .find((h: any) => h.action === 'DISBURSEMENT_PAID');
      expect(history.fromState).toBe(AssayerPayableStatus.PAID);
    });

    it('rejects an unknown entity type on the universal ledger', async () => {
      await expect(service.entityLedger('warehouse' as any, 'id-1')).rejects.toThrow(BadRequestException);
    });

    it('leaves a part-paid payable APPROVED so the remainder stays visible', async () => {
      const row = { ...approved };
      payableRepo.findOne.mockResolvedValueOnce(row);
      payableRepo.save.mockImplementationOnce(async (d: any) => d);

      await service.recordDisbursement(
        { payableId: 'payable-1', paymentReference: 'NEFT-10', method: PaymentMethod.NEFT, amount: 1000 },
        'user-1',
      );

      expect(Number(row.paidAmount)).toBe(1000);
      expect(row.status).toBe(AssayerPayableStatus.APPROVED);
    });

    it('surfaces a missing payable as NotFound rather than a null dereference', async () => {
      payableRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.recordDisbursement({ payableId: 'nope', paymentReference: 'X', method: PaymentMethod.NEFT }, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
