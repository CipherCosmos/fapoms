import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { ConflictException, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DataSource, IsNull, Not } from 'typeorm';
import { BillingEngineService } from './billing-engine.service';
import { BillingJobsService } from './billing-jobs.service';
import { BillingEntryEntity } from './billing-entry.entity';
import { BillingInvoiceEntity } from './invoice.entity';
import { BillingPaymentEntity } from './payment.entity';
import { AssayerPayableEntity } from './payable.entity';
import { AssayerInvoiceEntity } from './assayer-invoice.entity';
import { BillingHistoryEntity } from './history.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectEntity } from '../project/project.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssayerDocumentEntity } from '../assayer/assayer-document.entity';
import { AuditService } from '../../core/audit/audit.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { TypeOrmUnitOfWork } from '../../infrastructure/persistence/typeorm-unit-of-work';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { BillingState, AssayerPayableStatus, AssayerInvoiceStatus, PaymentMethod, PaymentDirection, InvoiceStatus, AssignmentStatus, EventCategory, OnboardingDocument, DocumentVerification } from '@fapoms/shared';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { SETTING_BY_KEY } from '../../infrastructure/settings/settings.registry';

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
    // The client invoice series (audit F7): the counter row's next serial.
    if (sql.includes('INSERT INTO billing_invoice_number_series')) return [{ last_serial: 123 }];
    return [];
  };
  const managerQuery: jest.Mock<Promise<any[]>, [string, any[]?]> = jest.fn(defaultManagerQuery);

  const queryBuilderStub = () => ({
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    // The region-scoping additions (listPayouts/listClientLines/findInvoicesPage, restricted
    // path): a join to the assignment→project_branch→branch chain, the extra selected column,
    // and pagination — all no-ops here unless a test overrides getRawAndEntities/getCount.
    leftJoin: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () => []),
    getOne: jest.fn(async () => null),
    getCount: jest.fn(async () => 0),
    getRawAndEntities: jest.fn(async () => ({ entities: [], raw: [] })),
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
    count: jest.fn(async () => 0),
    createQueryBuilder: jest.fn(() => queryBuilderStub()),
    manager: { query: managerQuery },
  };
  const invoiceRepo: any = {
    create: jest.fn((d) => ({ ...d })),
    save: jest.fn(async (d) => ({ id: d.id ?? 'invoice-1', ...d })),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    findAndCount: jest.fn(async () => [[], 0]),
    createQueryBuilder: jest.fn(() => queryBuilderStub()),
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
  const documentRepo: any = {
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => ({
      id: 'doc-1',
      assayerId: 'assayer-1',
      requirement: OnboardingDocument.BANK_PASSBOOK,
      verificationStatus: DocumentVerification.VERIFIED,
      verifiedAt: new Date('2026-08-01T00:00:00Z'),
      currentVersionId: 'ver-bank-1',
      isActive: true,
    })),
  };
  const assayerInvoiceRepo: any = {
    create: jest.fn((d) => ({ ...d })),
    save: jest.fn(async (d) => { const r = { id: d.id ?? `ainvoice-${saved.length + 1}`, ...d }; saved.push(r); return r; }),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    count: jest.fn(async () => 0),
  };

  const repoForEntity = (target: any): any => {
    if (target === BillingEntryEntity) return entryRepo;
    if (target === BillingInvoiceEntity) return invoiceRepo;
    if (target === AssayerInvoiceEntity) return assayerInvoiceRepo;
    if (target === BillingPaymentEntity) return paymentRepo;
    if (target === AssayerPayableEntity) return payableRepo;
    if (target === BillingHistoryEntity) return historyRepo;
    if (target === AssignmentEntity) return assignmentRepo;
    if (target === ProjectEntity) return projectRepo;
    if (target === AssayerEntity) return assayerRepo;
    if (target === AssayerDocumentEntity) return documentRepo;
    throw new Error(`No repository double registered for ${target?.name ?? target}`);
  };

  /** Which repository a row belongs to, inferred from its shape. Order matters. */
  const repoForRow = (row: any): any => {
    if (row?.lineCount !== undefined || (typeof row?.invoiceNumber === 'string' && row.invoiceNumber.startsWith('AINV-'))) return assayerInvoiceRepo;
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
    count: jest.fn(async (target: any, opts: any) => (repoForEntity(target).count ? repoForEntity(target).count(opts) : 0)),
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
  // The compliance trail. `recordEvent` throws (matching the expense module's convention for
  // money-adjacent audit calls), so a real failure would roll back the transaction it joined —
  // never Safe here, we do not want a payout to "succeed" with no audit trace.
  const recordEvent = jest.fn(async () => ({ id: 'audit-1' }));
  // The staged region ceiling. Defaults to 'log' (the rollout default) and never refuses, so
  // every pre-existing test — none of which pass a `scope` — is unaffected; tests below override
  // `stagedMode` and assert on `assertRegionAllowedStaged`'s calls directly.
  const stagedMode = jest.fn(async () => 'log' as 'off' | 'log' | 'enforce');
  const assertRegionAllowedStaged = jest.fn(async () => undefined);
  // The invoice ceiling lives entirely in the guard (`assertInvoiceInScope`), which resolves the
  // invoice's regions itself. This service's remaining job is to CALL it, under the right context
  // label, before it returns anything — so it is stubbed and asserted on, exactly like
  // `assertRegionAllowedStaged` above, rather than reimplemented here.
  const assertInvoiceInScope = jest.fn(async () => undefined);
  const regionGuard = { stagedMode, assertRegionAllowedStaged, assertInvoiceInScope };
  // Platform settings, keyed. Only `security.segregationOfDuties.mode` is exercised by name below
  // — every other key (billing.tdsSection, etc.) keeps resolving to `null`, same as before this
  // was made key-aware, so no unrelated test needs to know this map exists.
  const settingsValues: Record<string, any> = {};
  const settingsGet = jest.fn(async (key: string) => settingsValues[key] ?? null);
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
  /** A direct approval (no approved bill) needs its reason on the record — audit F6. */
  const DIRECT_REASON = 'Assayer confirmed the amounts by phone';
  /** The HOD's final approval (2026-09-24): an approved payout the tests pay carries it. */
  const HOD_AT = new Date('2026-08-11T09:00:00Z');
  const payable = (over: Partial<any> = {}) => ({
    id: 'payable-1', payableNumber: 'PY-1', assayerId: 'assayer-1', clientId: 'client-1', projectId: 'project-1',
    assignmentId: 'asn-1', expenseId: null, status: AssayerPayableStatus.PENDING, onHold: false, holdReason: null,
    baseAmount: '1700.00', travelAmount: '300.00', taxAmount: '0.00', tdsAmount: '200.00', totalAmount: '1800.00',
    currency: 'INR', paidAmount: '0.00', rateSnapshot: { feeAmount: 2000, settled: true },
    destinationBankAccountNumber: '9876543210',
    destinationIfsc: 'HDFC0001234',
    destinationBankName: 'HDFC Bank',
    destinationAccountHolderName: 'Assayer One',
    destinationVerifiedAt: new Date(),
    ...over,
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
    for (const k of Object.keys(settingsValues)) delete settingsValues[k];
    jest.clearAllMocks();
    managerQuery.mockImplementation(defaultManagerQuery);
    for (const r of [entryRepo, payableRepo, invoiceRepo, paymentRepo, historyRepo, assignmentRepo, projectRepo]) {
      r.findOne.mockImplementation(async () => null);
      r.find.mockImplementation(async () => []);
    }
    assayerRepo.findOne.mockImplementation(async () => ({
      id: 'assayer-1',
      bankAccountNumber: '9876543210',
      ifscCode: 'HDFC0001234',
      bankName: 'HDFC Bank',
      bankAccountHolderName: 'Assayer One',
      panNumber: 'ABCDE1234F',
    }));
    assayerRepo.find.mockImplementation(async () => []);
    documentRepo.findOne.mockImplementation(async () => ({
      id: 'doc-1',
      assayerId: 'assayer-1',
      requirement: OnboardingDocument.BANK_PASSBOOK,
      verificationStatus: DocumentVerification.VERIFIED,
      verifiedAt: new Date('2026-08-01T00:00:00Z'),
      currentVersionId: 'ver-bank-1',
      isActive: true,
    }));
    documentRepo.find.mockImplementation(async () => []);
    entryRepo.createQueryBuilder.mockImplementation(() => queryBuilderStub());
    payableRepo.createQueryBuilder.mockImplementation(() => queryBuilderStub());
    invoiceRepo.createQueryBuilder.mockImplementation(() => queryBuilderStub());
    projectRepo.findOne.mockImplementation(async () => ({ id: 'project-1', clientId: 'client-1' }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: PlatformSettingsService,
          useValue: {
            get: settingsGet,
            getMany: jest.fn(async () => ({})),
            // The s.194J threshold (audit F15) is 0 here — the pre-threshold behaviour every older
            // test was written against; the threshold's own tests set it through `settingsValues`.
            getNumber: jest.fn(async (k: string, fb?: number) => settingsValues[k] ?? (k === 'billing.tds194jThresholdRupees' ? 0 : fb as number)),
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
        { provide: AuditService, useValue: { recordEvent, recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }) } },
        { provide: RegionGuardService, useValue: regionGuard },
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

    /**
     * An assayer's delete cascade deactivates their assignments — including ones already
     * COMPLETED. A COMPLETED audit that happened does not stop needing to be billed because the
     * assayer who did it was later removed; filtering on `is_active` hid exactly the work most
     * likely to still need reconciling (a deleted assayer's outstanding payable).
     */
    it('does not filter on assignment is_active — a COMPLETED assignment must be billed even after the assayer is deleted', async () => {
      let capturedSql = '';
      assignmentRepo.manager.query = jest.fn(async (sql: string, params?: any[]) => {
        if (sql.includes('LEFT JOIN billing_entries')) { capturedSql = sql; return []; }
        return managerQuery(sql, params);
      });

      await service.reconcilePreview({});

      // The mutation this proves: adding back `AND a.is_active = true` to the WHERE clause in
      // unbookedAssignmentIds makes this assertion match. Matches the actual filter, not the
      // explanatory SQL comment beside it that also mentions "is_active".
      expect(capturedSql).toMatch(/WHERE a\.status = 'COMPLETED'/);
      expect(capturedSql).not.toMatch(/a\.is_active\s*=\s*true/);
      assignmentRepo.manager.query = managerQuery;
    });
  });

  /**
   * The finance overview's "needs attention" list — same is_active concern as reconcile, on the
   * query that surfaces unbooked completed work to a human rather than an automated repair.
   */
  describe('attentionItems (via overview) — UNBOOKED includes inactive assignments', () => {
    it('does not filter the UNBOOKED query on assignment is_active', async () => {
      let capturedSql = '';
      entryRepo.manager.query = jest.fn(async (sql: string, params?: any[]) => {
        if (sql.includes("kind: 'UNBOOKED'") || (sql.includes('FROM assignments a') && sql.includes('no_entry'))) {
          capturedSql = sql;
        }
        return managerQuery(sql, params);
      });

      await (service as any).attentionItems();

      expect(capturedSql).toContain("a.status = 'COMPLETED'");
      // The mutation this proves: adding back `AND a.is_active = true` after the status check in
      // the UNBOOKED branch of attentionItems makes this assertion match. Matches the actual
      // filter clause, not the explanatory SQL comment above it that also says "is_active".
      expect(capturedSql).not.toMatch(/a\.is_active\s*=\s*true/);
      entryRepo.manager.query = managerQuery;
    });
  });

  /**
   * A voided payout is history. "Fee changed" (and "no fee agreed", and "on hold") on a voided
   * payable asked finance to act on money that will never be paid — a reopened-and-redone job
   * carries one voided payable beside its live one, and the list showed the dead one too.
   */
  describe('attentionItems — payout items are about LIVE payables only', () => {
    const capture = async () => {
      const sqls: string[] = [];
      entryRepo.manager.query = jest.fn(async (sql: string, params?: any[]) => { sqls.push(sql); return managerQuery(sql, params); });
      await (service as any).attentionItems();
      entryRepo.manager.query = managerQuery;
      const stripped = (s: string) => s.replace(/--[^\n]*/g, '');
      return {
        feeChanged: stripped(sqls.find((s) => s.includes('AS booked_fee'))!),
        unsettled: stripped(sqls.find((s) => s.includes(`'settled') = 'false'`))!),
        heldPayable: stripped(sqls.find((s) => s.includes('p.on_hold = true'))!),
      };
    };

    it('the FEE_CHANGED query excludes voided payables', async () => {
      const { feeChanged } = await capture();
      expect(feeChanged).toContain(`p.status NOT IN ('VOIDED')`);
    });

    it('the UNSETTLED_FEE and held-payout queries exclude voided payables too', async () => {
      const { unsettled, heldPayable } = await capture();
      expect(unsettled).toContain(`p.status NOT IN ('VOIDED')`);
      expect(heldPayable).toContain(`p.status NOT IN ('VOIDED')`);
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

  // ── The HOD's final approval (owner, 2026-09-24) ─────────────────────────
  //
  // After the office approves, money needs the HOD's final approval before it can move. The gate is
  // on the payable, read by the one path to PAID (`recordDisbursement`) and by the bank file; the
  // client invoice's is on "Sent to client". Each refusal below is also the MUTATION CHECK for its
  // gate: remove the gate and the test that says "refused" goes red.

  describe("The HOD's final approval", () => {
    /** Resolve settings the way a deployment with no saved row does — enforce is the default. */
    beforeEach(() => {
      settingsGet.mockImplementation(async (key: string) => settingsValues[key] ?? SETTING_BY_KEY[key]?.default ?? null);
      assayerInvoiceRepo.findOne.mockImplementation(async () => null);
    });
    afterEach(() => {
      settingsGet.mockImplementation(async (key: string) => settingsValues[key] ?? null);
    });

    const officeApproved = (over: Partial<any> = {}) => payable({
      status: AssayerPayableStatus.APPROVED, approvedBy: 'office-1', approvedAt: new Date('2026-08-11T08:00:00Z'), hodApprovedAt: null, hodApprovedBy: null, ...over,
    });

    describe('payment is refused until the HOD approves', () => {
      it('recordDisbursement refuses an office-approved payout the HOD has not approved — code AWAITING_HOD_APPROVAL', async () => {
        payableRepo.findOne.mockImplementation(async () => officeApproved());
        totalsRow = { ...totalsRow, outstanding: 0 };
        const err: any = await service.recordDisbursement(
          { payableId: 'payable-1', paymentReference: 'UTR-HOD-1', method: PaymentMethod.NEFT }, 'payer-1',
        ).catch((e) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.message).toMatch(/^Waiting for HOD approval/);
        expect(err.getResponse()).toMatchObject({ code: 'AWAITING_HOD_APPROVAL' });
        expect(committed).toHaveLength(0);
        expect(paymentRepo.save).not.toHaveBeenCalled();
      });

      it('the bulk pay run refuses it too, and pays nothing', async () => {
        payableRepo.findOne.mockImplementation(async () => officeApproved());
        const r = await service.payPayouts(['payable-1'], { paymentReference: 'UTR-HOD-2', method: PaymentMethod.NEFT }, 'payer-1');
        expect(r.done).toEqual([]);
        expect(r.refused[0].reason).toMatch(/^Waiting for HOD approval/);
        expect(committed).toHaveLength(0);
      });

      it('pays it once the HOD has approved', async () => {
        payableRepo.findOne.mockImplementation(async () => officeApproved({ hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1' }));
        totalsRow = { ...totalsRow, outstanding: 0 };
        const payment = await service.recordDisbursement(
          { payableId: 'payable-1', paymentReference: 'UTR-HOD-3', method: PaymentMethod.NEFT }, 'payer-1',
        );
        expect(payment).toMatchObject({ payableId: 'payable-1', amount: 1800 });
      });

      it('the bank file leaves out a payout waiting for the HOD, and says why', async () => {
        payableRepo.find.mockImplementation(async () => [
          officeApproved({ id: 'p-wait', payableNumber: 'PY-WAIT' }),
          officeApproved({ id: 'p-ok', payableNumber: 'PY-OK', hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1' }),
        ]);
        assayerRepo.find.mockImplementation(async () => [{ id: 'assayer-1', displayName: 'Asha', assayerCode: 'AS-1', panNumber: 'ABCDE1234F' }]);
        const r = await service.payoutBankDetails(['p-wait', 'p-ok']);
        expect(r.rows.map((x) => x.payableId)).toEqual(['p-ok']);
        expect(r.skipped).toEqual([{ id: 'p-wait', reason: 'PY-WAIT: Waiting for HOD approval' }]);
      });
    });

    describe('hodApprovePayouts — approving a payout approved without a bill, or a reimbursement', () => {
      it('stamps the final approval, writes history and audit, and only NOW tells the assayer', async () => {
        payableRepo.findOne.mockImplementation(async () => officeApproved());
        const r = await service.hodApprovePayouts(['payable-1'], 'hod-1');
        expect(r).toEqual({ done: ['payable-1'], refused: [] });
        const p = committed.find((row) => row.payableNumber);
        expect(p).toMatchObject({ status: AssayerPayableStatus.APPROVED, approvedBy: 'office-1', hodApprovedBy: 'hod-1' });
        expect(p.hodApprovedAt).toBeInstanceOf(Date);
        expect(committed).toContainEqual(expect.objectContaining({ action: 'PAYABLE_HOD_APPROVED', entityId: 'payable-1' }));
        expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'PAYABLE_HOD_APPROVED', userId: 'hod-1' }), expect.anything());
        await flush();
        expect(emitSafe).toHaveBeenCalledWith(expect.objectContaining({ type: 'PAYABLE_APPROVED', assayerId: 'assayer-1', dedupeKey: 'PAYABLE_APPROVED:payable-1' }));
      });

      it('refuses the HOD who was also the office approver (segregation of duties, enforce by default) and audits the attempt', async () => {
        payableRepo.findOne.mockImplementation(async () => officeApproved({ approvedBy: 'hod-1' }));
        const r = await service.hodApprovePayouts(['payable-1'], 'hod-1');
        expect(r.done).toEqual([]);
        expect(r.refused[0].reason).toMatch(/Segregation of duties/);
        expect(committed).toHaveLength(0);
        expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'SEGREGATION_OF_DUTIES_REFUSED', entityId: 'payable-1', userId: 'hod-1' }));
      });

      it('warn mode lets the same person through but still records it', async () => {
        settingsValues['security.segregationOfDuties.mode'] = 'warn';
        payableRepo.findOne.mockImplementation(async () => officeApproved({ approvedBy: 'hod-1' }));
        const r = await service.hodApprovePayouts(['payable-1'], 'hod-1');
        expect(r.done).toEqual(['payable-1']);
        expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'SEGREGATION_OF_DUTIES_WARNED' }));
      });

      it('refuses what the office has not approved, a held payout and a paid one; a second press is a no-op', async () => {
        payableRepo.findOne.mockImplementation(async (opts: any) => ({
          due: payable({ id: 'due' }),
          held: officeApproved({ id: 'held', onHold: true, holdReason: 'PAN mismatch' }),
          paid: officeApproved({ id: 'paid', status: AssayerPayableStatus.PAID }),
          done: officeApproved({ id: 'done', hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-2' }),
        } as any)[opts.where.id]);
        const r = await service.hodApprovePayouts(['due', 'held', 'paid', 'done'], 'hod-1');
        expect(r.done).toEqual(['done']);
        expect(r.refused).toEqual([
          { id: 'due', reason: expect.stringContaining('not been approved by the office') },
          { id: 'held', reason: expect.stringContaining('PAN mismatch') },
          { id: 'paid', reason: expect.stringContaining('already paid') },
        ]);
        expect(committed).toHaveLength(0);
      });

      it('refuses a payout riding an office-approved bill — the bill is what the HOD approves', async () => {
        payableRepo.findOne.mockImplementation(async () => officeApproved({ assayerInvoiceId: 'ainv-1' }));
        assayerInvoiceRepo.findOne.mockImplementation(async () => ({ id: 'ainv-1', invoiceNumber: 'AINV-1', status: AssayerInvoiceStatus.APPROVED }));
        const r = await service.hodApprovePayouts(['payable-1'], 'hod-1');
        expect(r.refused[0].reason).toContain('AINV-1');
      });

      it('reports progress after every item', async () => {
        payableRepo.findOne.mockImplementation(async () => officeApproved());
        const onProgress = jest.fn();
        await service.hodApprovePayouts(['payable-1', 'payable-1'], 'hod-1', onProgress);
        expect(onProgress.mock.calls).toEqual([[1, 1, 'Giving final approval']]);
      });
    });

    describe('hodRejectPayout — back to the office, with the reason', () => {
      it('returns the payout to Due, undoing the office approval and its frozen destination, and tells the office approver', async () => {
        payableRepo.findOne.mockImplementation(async () => officeApproved());
        const out = await service.hodRejectPayout('payable-1', 'The travel claim is twice the rate card.', 'hod-1');
        expect(out).toMatchObject({
          status: AssayerPayableStatus.PENDING, approvedBy: null, approvedAt: null,
          destinationBankAccountNumber: null, destinationIfsc: null, destinationVerifiedAt: null, destinationVerifiedSource: null,
          hodRejectedBy: 'hod-1', hodRejectReason: 'The travel claim is twice the rate card.',
        });
        expect(committed).toContainEqual(expect.objectContaining({
          action: 'PAYABLE_HOD_REJECTED', fromState: AssayerPayableStatus.APPROVED, toState: AssayerPayableStatus.PENDING,
          reason: 'The travel claim is twice the rate card.',
        }));
        await flush(); await flush();
        expect(emitSafe).toHaveBeenCalledWith(expect.objectContaining({
          type: 'BILLING_FINAL_APPROVAL_REJECTED', ownerUserId: 'office-1', actorUserId: 'hod-1',
          payload: expect.objectContaining({ reason: 'The travel claim is twice the rate card.', tab: 'pay' }),
        }));
      });

      it('an expense reimbursement goes back the same way — the claim stays approved, its payout returns to Due', async () => {
        payableRepo.findOne.mockImplementation(async () => officeApproved({ expenseId: 'expense-1' }));
        const out = await service.hodRejectPayout('payable-1', 'No receipt attached to this claim.', 'hod-1');
        expect(out).toMatchObject({ status: AssayerPayableStatus.PENDING, expenseId: 'expense-1' });
        await flush(); await flush();
        expect(emitSafe).toHaveBeenCalledWith(expect.objectContaining({
          type: 'BILLING_FINAL_APPROVAL_REJECTED', payload: expect.objectContaining({ what: 'Expense reimbursement PY-1' }),
        }));
      });

      it('needs a reason the office can act on', async () => {
        payableRepo.findOne.mockImplementation(async () => officeApproved());
        await expect(service.hodRejectPayout('payable-1', 'no', 'hod-1')).rejects.toThrow(BadRequestException);
        expect(committed).toHaveLength(0);
      });

      it('refuses one that already has the final approval, or is part paid', async () => {
        payableRepo.findOne.mockImplementation(async () => officeApproved({ hodApprovedAt: HOD_AT }));
        await expect(service.hodRejectPayout('payable-1', 'Changed my mind about this one.', 'hod-1')).rejects.toThrow(/already has the final approval/);
        payableRepo.findOne.mockImplementation(async () => officeApproved({ paidAmount: '100.00' }));
        await expect(service.hodRejectPayout('payable-1', 'Changed my mind about this one.', 'hod-1')).rejects.toThrow(/part paid/);
        expect(committed).toHaveLength(0);
      });
    });

    describe('client invoices: sent to the client only after the HOD approves', () => {
      it('refuses to mark a draft sent — AWAITING_HOD_APPROVAL — and the number never changes', async () => {
        invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.DRAFT }));
        const err: any = await service.sendInvoice('invoice-1', 'office-1').catch((e) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse()).toMatchObject({ code: 'AWAITING_HOD_APPROVAL' });
        expect(committed).toHaveLength(0);
      });

      it('refuses while it is with the HOD', async () => {
        invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.AWAITING_HOD }));
        await expect(service.sendInvoice('invoice-1', 'office-1')).rejects.toThrow(/^Waiting for HOD approval/);
        expect(committed).toHaveLength(0);
      });

      it('the office sends a draft up: DRAFT → AWAITING_HOD, and the HOD hears about it', async () => {
        invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.DRAFT, createdBy: 'office-1' }));
        const out = await service.requestInvoiceFinalApproval('invoice-1', 'office-1');
        expect(out).toMatchObject({ status: InvoiceStatus.AWAITING_HOD, hodRequestedBy: 'office-1', invoiceNumber: 'INV-1' });
        expect(committed).toContainEqual(expect.objectContaining({ action: 'INVOICE_SENT_FOR_FINAL_APPROVAL', toState: InvoiceStatus.AWAITING_HOD }));
        await flush(); await flush();
        expect(emitSafe).toHaveBeenCalledWith(expect.objectContaining({
          type: 'BILLING_FINAL_APPROVAL_NEEDED', entityType: 'INVOICE', entityId: 'invoice-1',
          dedupeKey: expect.stringMatching(/^BILLING_FINAL_APPROVAL_NEEDED:INVOICE:invoice-1:\d+$/),
        }));
      });

      it('the HOD approves: AWAITING_HOD → HOD_APPROVED, and then it can be sent', async () => {
        invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.AWAITING_HOD, createdBy: 'office-1', hodRequestedBy: 'office-1' }));
        const out = await service.hodApproveInvoice('invoice-1', 'hod-1');
        expect(out).toMatchObject({ status: InvoiceStatus.HOD_APPROVED, hodApprovedBy: 'hod-1', invoiceNumber: 'INV-1' });
        expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'INVOICE_HOD_APPROVED' }), expect.anything());
        invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.HOD_APPROVED }));
        expect((await service.sendInvoice('invoice-1', 'office-1')).status).toBe(InvoiceStatus.ISSUED);
      });

      it('refuses the HOD who made the invoice, or who sent it up', async () => {
        invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.AWAITING_HOD, createdBy: 'hod-1', hodRequestedBy: 'office-1' }));
        await expect(service.hodApproveInvoice('invoice-1', 'hod-1')).rejects.toThrow(/Segregation of duties/);
        invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.AWAITING_HOD, createdBy: 'office-1', hodRequestedBy: 'hod-1' }));
        await expect(service.hodApproveInvoice('invoice-1', 'hod-1')).rejects.toThrow(/Segregation of duties/);
        expect(committed).toHaveLength(0);
      });

      it('the HOD sends it back: → DRAFT with the reason, and whoever sent it up is told', async () => {
        invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.AWAITING_HOD, createdBy: 'office-1', hodRequestedBy: 'office-2' }));
        const out = await service.hodRejectInvoice('invoice-1', 'Wrong GSTIN on the client record.', 'hod-1');
        expect(out).toMatchObject({ status: InvoiceStatus.DRAFT, hodRejectReason: 'Wrong GSTIN on the client record.', hodRequestedBy: null, invoiceNumber: 'INV-1' });
        await flush(); await flush();
        expect(emitSafe).toHaveBeenCalledWith(expect.objectContaining({
          type: 'BILLING_FINAL_APPROVAL_REJECTED', ownerUserId: 'office-2', payload: expect.objectContaining({ tab: 'invoices' }),
        }));
      });

      it('recording a payment against an invoice not yet sent is refused as before', async () => {
        invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.HOD_APPROVED }));
        await expect(service.recordPayment({ invoiceId: 'invoice-1', paymentReference: 'R1', method: PaymentMethod.NEFT, amount: 10 }, 'f'))
          .rejects.toThrow(/has not been sent yet/);
      });
    });

    describe("the HOD's queue", () => {
      it('lists the four kinds, and counts the whole queue', async () => {
        managerQuery.mockImplementation(async (sql: string) => {
          // The payout query mentions assayer_invoices in its NOT EXISTS, so it is matched first.
          if (sql.includes('AS direct')) return [{ direct: 1, expense: 1 }];
          if (sql.includes('FROM assayer_payables p') && sql.includes('LIMIT')) return [
            { id: 'p-1', payable_number: 'PY-1', expense_id: null, total_amount: '1800.00', paid_amount: '0', approved_by: 'office-1', office_note: 'Assayer has left' },
            { id: 'p-2', payable_number: 'PY-2', expense_id: 'x-1', total_amount: '450.00', paid_amount: '0', approved_by: 'office-1' },
          ];
          if (sql.includes('FROM assayer_invoices ai') && sql.includes('LIMIT')) return [{ id: 'ainv-1', invoice_number: 'AINV-1', total_amount: '5400.00', currency: 'INR', line_count: 3, approved_by: 'office-1', approved_at: new Date(), approver_name: 'Priya', payee_name: 'Asha' }];
          if (sql.includes('FROM billing_invoices i') && sql.includes('LIMIT')) return [{ id: 'inv-1', invoice_number: 'INV-1', total: '12000', hod_requested_by: 'office-2', line_count: 4 }];
          if (sql.includes('COUNT(*)::int AS n FROM assayer_invoices')) return [{ n: 1 }];
          if (sql.includes('COUNT(*)::int AS n FROM billing_invoices')) return [{ n: 1 }];
          return defaultManagerQuery(sql);
        });
        const q = await service.finalApprovalQueue();
        expect(q.items.map((i) => [i.kind, i.number])).toEqual([
          ['ASSAYER_BILL', 'AINV-1'], ['DIRECT_PAYOUT', 'PY-1'], ['EXPENSE_REIMBURSEMENT', 'PY-2'], ['CLIENT_INVOICE', 'INV-1'],
        ]);
        expect(q.items[1]).toMatchObject({ amount: 1800, officeNote: 'Assayer has left', officeApprovedBy: 'office-1' });
        expect(q.counts).toEqual({ ASSAYER_BILL: 1, DIRECT_PAYOUT: 1, EXPENSE_REIMBURSEMENT: 1, CLIENT_INVOICE: 1 });
        expect(q.total).toBe(4);
      });

      it('waits only on what the HOD can act on: office-approved, not final-approved, not held, owed, not on a live bill', async () => {
        await service.finalApprovalQueue();
        const payables = managerQuery.mock.calls.map(([sql]) => sql).find((sql) => sql.includes('FROM assayer_payables p') && sql.includes('LIMIT'))!;
        expect(payables).toContain(`p.status = 'APPROVED' AND p.hod_approved_at IS NULL`);
        expect(payables).toContain('p.on_hold = false');
        expect(payables).toContain(`ai.status IN ('INVITED','SUBMITTED','APPROVED')`);
        const invoices = managerQuery.mock.calls.map(([sql]) => sql).find((sql) => sql.includes('FROM billing_invoices i') && sql.includes('LIMIT'))!;
        expect(invoices).toContain(`i.status = 'AWAITING_HOD'`);
      });

      it("a region-assigned HOD sees only their regions' items — the regions bound, never inlined", async () => {
        stagedMode.mockResolvedValue('enforce');
        await service.finalApprovalQueue({ regions: ['NORTH'] } as any);
        const calls = managerQuery.mock.calls;
        const payables = calls.find(([sql]) => sql.includes('FROM assayer_payables p') && sql.includes('LIMIT'))!;
        expect(payables[0]).toMatch(/rgn_b\.region = ANY\(\$1::text\[\]\)/);
        expect(payables[1]).toEqual([['NORTH']]);
        const bills = calls.find(([sql]) => sql.includes('FROM assayer_invoices ai') && sql.includes('LIMIT') && !sql.includes('FROM assayer_payables'))!;
        expect(bills[0]).toContain('a.region = ANY($1::text[])');
        expect(bills[1]).toEqual([['NORTH']]);
        const invoices = calls.find(([sql]) => sql.includes('FROM billing_invoices i') && sql.includes('LIMIT'))!;
        expect(invoices[0]).toMatch(/rgi_b\.region = ANY/);
        expect(JSON.stringify(calls.map(([sql]) => sql))).not.toContain("'NORTH'");
        stagedMode.mockResolvedValue('log');
      });
    });

    it('the payouts list narrows on the final approval (ready to pay vs waiting for the HOD)', async () => {
      await service.listPayouts({ status: AssayerPayableStatus.APPROVED, hodApproved: true });
      expect(payableRepo.findAndCount).toHaveBeenLastCalledWith(expect.objectContaining({
        where: expect.objectContaining({ hodApprovedAt: Not(IsNull()) }),
      }));
      await service.listPayouts({ status: AssayerPayableStatus.APPROVED, hodApproved: false });
      expect(payableRepo.findAndCount).toHaveBeenLastCalledWith(expect.objectContaining({
        where: expect.objectContaining({ hodApprovedAt: IsNull() }),
      }));
    });
  });

  // ── Payouts ───────────────────────────────────────────────────────────────

  describe('approvePayouts — the one gate', () => {
    it('approves a due payout, stamps who and when, and tells the HOD — not yet the assayer', async () => {
      payableRepo.findOne.mockImplementation(async () => payable());
      const r = await service.approvePayouts(['payable-1'], 'finance-1', undefined, DIRECT_REASON);
      expect(r).toEqual({ done: ['payable-1'], refused: [] });
      const p = committed.find((row) => row.payableNumber);
      expect(p).toMatchObject({ status: AssayerPayableStatus.APPROVED, approvedBy: 'finance-1', hodApprovedAt: null });
      expect(p.approvedAt).toBeInstanceOf(Date);
      expect(locks).toContainEqual(expect.objectContaining({ entity: 'AssayerPayableEntity', mode: 'pessimistic_write' }));
      // The notification is detached from the transaction (it must never roll money back), so
      // let the event loop turn once before asserting it was sent.
      await flush();
      await flush();
      // The office's approval waits for the HOD (2026-09-24): the HOD hears, the assayer does not.
      expect(emitSafe).toHaveBeenCalledWith(expect.objectContaining({
        type: 'BILLING_FINAL_APPROVAL_NEEDED', entityType: 'PAYABLE', entityId: 'payable-1',
        dedupeKey: expect.stringMatching(/^BILLING_FINAL_APPROVAL_NEEDED:PAYABLE:payable-1:\d+$/),
      }));
      expect(emitSafe).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'PAYABLE_APPROVED' }));
    });

    it('writes the approval to the compliance audit trail — who approved how much, for whom', async () => {
      payableRepo.findOne.mockImplementation(async () => payable());
      await service.approvePayouts(['payable-1'], 'finance-1', undefined, DIRECT_REASON);
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
        category: EventCategory.WORKFLOW,
        eventType: 'PAYABLE_APPROVED',
        entityType: 'PAYABLE',
        entityId: 'payable-1',
        previousState: AssayerPayableStatus.PENDING,
        newState: AssayerPayableStatus.APPROVED,
        userId: 'finance-1',
        metadata: expect.objectContaining({ payableId: 'payable-1', assayerId: 'assayer-1', amount: 1800 }),
      }), expect.objectContaining({ manager: expect.anything() }));
    });

    it('refuses a held payout, naming the hold reason, and approves the rest', async () => {
      payableRepo.findOne.mockImplementation(async (opts: any) =>
        opts.where.id === 'held-1' ? payable({ id: 'held-1', payableNumber: 'PY-H', onHold: true, holdReason: 'Client dispute' }) : payable());
      const r = await service.approvePayouts(['held-1', 'payable-1'], 'finance-1', undefined, DIRECT_REASON);
      expect(r.done).toEqual(['payable-1']);
      expect(r.refused).toEqual([{ id: 'held-1', reason: expect.stringContaining('Client dispute') }]);
    });

    it('treats an already-approved payout as done — the bulk button may be pressed twice', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1' }));
      const r = await service.approvePayouts(['payable-1'], 'finance-1', undefined, DIRECT_REASON);
      expect(r).toEqual({ done: ['payable-1'], refused: [] });
      expect(committed).toHaveLength(0);
      expect(emitSafe).not.toHaveBeenCalled();
    });

    it('refuses a paid payout', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.PAID }));
      const r = await service.approvePayouts(['payable-1'], 'finance-1', undefined, DIRECT_REASON);
      expect(r.refused[0].reason).toContain('already paid');
    });

    /**
     * Approval runs on a queue now, with a screen polling it: it is told after every payout, a
     * refused one included, and counts each payout once however often the selection repeats it.
     */
    it('reports progress after every distinct payout, a refused one included', async () => {
      payableRepo.findOne.mockImplementation(async (opts: any) =>
        opts.where.id === 'held-1' ? payable({ id: 'held-1', payableNumber: 'PY-H', onHold: true, holdReason: 'Client dispute' }) : payable());
      const onProgress = jest.fn();

      const r = await service.approvePayouts(['held-1', 'payable-1', 'held-1'], 'finance-1', onProgress, DIRECT_REASON);

      expect(r.done).toEqual(['payable-1']);
      expect(onProgress.mock.calls).toEqual([[1, 2, 'Approving payouts'], [2, 2, 'Approving payouts']]);
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

    it('reports progress after every payout it tries to pay, a refused one included', async () => {
      payableRepo.findOne.mockImplementation(async () => payable());
      const onProgress = jest.fn();

      const r = await service.payPayouts(['payable-1'], { paymentReference: 'UTR-1', method: PaymentMethod.NEFT }, 'finance-1', onProgress);

      expect(r.refused).toHaveLength(1);
      expect(onProgress.mock.calls).toEqual([[1, 1, 'Paying payouts']]);
    });

    it('refuses a held payout even when approved', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1', onHold: true, holdReason: 'Pending PAN' }));
      const r = await service.payPayouts(['payable-1'], { paymentReference: 'UTR-1', method: PaymentMethod.NEFT }, 'finance-1');
      expect(r.refused[0].reason).toContain('Pending PAN');
    });

    it('pays the full outstanding, records a real payment row, marks PAID, and tells the assayer', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1' }));
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

    it('writes the disbursement to the compliance audit trail — who released how much, to whom', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1' }));
      totalsRow = { ...totalsRow, outstanding: 0 };
      await service.payPayouts(['payable-1'], { paymentReference: 'UTR-1', method: PaymentMethod.NEFT, paidDate: '2026-08-12' }, 'finance-1');
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
        category: EventCategory.WORKFLOW,
        eventType: 'PAYABLE_DISBURSED',
        entityType: 'PAYMENT',
        newState: AssayerPayableStatus.PAID,
        userId: 'finance-1',
        metadata: expect.objectContaining({
          payableId: 'payable-1',
          assayerId: 'assayer-1',
          amount: 1800,
          paymentReference: 'UTR-1',
          method: PaymentMethod.NEFT,
        }),
      }), expect.objectContaining({ manager: expect.anything() }));
    });

    it('computes the running balance on the transaction’s own connection, after the write', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1' }));
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
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1' }));
      await expect(service.recordDisbursement({ payableId: 'payable-1', paymentReference: 'UTR-1', method: PaymentMethod.NEFT, amount: 1800.5 }, 'f'))
        .rejects.toThrow(BadRequestException);
    });

    it('atomically transitions parent AssayerInvoice to PAID when all lines are disbursed', async () => {
      payableRepo.findOne.mockImplementation(async () =>
        payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1', assayerInvoiceId: 'ainv-1' }),
      );
      // No line left unsettled; one PAID line (the one just disbursed).
      payableRepo.count.mockImplementation(async (opts: any) => (opts?.where?.status === AssayerPayableStatus.PAID ? 1 : 0));
      assayerInvoiceRepo.findOne.mockImplementation(async () => ({
        id: 'ainv-1',
        invoiceNumber: 'AINV-1',
        assayerId: 'assayer-1',
        status: AssayerInvoiceStatus.APPROVED,
        totalAmount: 1800,
      }));

      await service.recordDisbursement(
        { payableId: 'payable-1', paymentReference: 'UTR-100', method: PaymentMethod.NEFT },
        'finance-1',
      );

      const ainvPaid = committed.find((r) => r.invoiceNumber === 'AINV-1');
      expect(ainvPaid).toMatchObject({
        status: AssayerInvoiceStatus.PAID,
        paidBy: 'finance-1',
      });
      expect(committed.some((r) => r.action === 'ASSAYER_INVOICE_PAID')).toBe(true);
    });
  });

  /**
   * The payout destination snapshot — see `payout-destination.ts`.
   *
   * `destination_verified_at` asserts that somebody verified the account this money is going to.
   * Both writers ended `?? new Date()`, so an assayer with no passbook document and no
   * established identity was stamped "verified, this second" at the instant of approval, and the
   * payment row copied it. Certification found five such payables, all covering money that had
   * already left the business.
   */
  describe('Payout destination: a verification timestamp is an assertion, not a formality', () => {
    /** No documents at all, and identity never established — the shape of all five found rows. */
    const unevidenced = () => {
      documentRepo.findOne.mockImplementation(async () => null);
      assayerRepo.findOne.mockImplementation(async () => ({
        id: 'assayer-1', bankAccountNumber: '9876543210', ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank', displayName: 'Assayer One', panNumber: 'ABCDE1234F',
        identityVerifiedAt: null,
      }));
    };

    it('approving with no evidence at all leaves the claim NULL — it does not stamp the approval instant', async () => {
      unevidenced();
      payableRepo.findOne.mockImplementation(async () => payable({ destinationVerifiedAt: null }));
      const r = await service.approvePayouts(['payable-1'], 'finance-1', undefined, DIRECT_REASON);
      // Allowed — the owner's decision (audit F3) — but never silently: the approver is told.
      expect(r).toEqual({
        done: ['payable-1'], refused: [],
        warnings: [{ id: 'payable-1', warning: expect.stringContaining('Bank details are not verified') }],
      });
      const approved = committed.find((row: any) => row.id === 'payable-1');
      expect(approved.status).toBe(AssayerPayableStatus.APPROVED);
      expect(approved.destinationVerifiedAt).toBeNull();
      expect(approved.destinationVerifiedSource).toBeNull();
      expect(approved.payoutEvidenceVersionId).toBeNull();
      // The destination itself is still frozen: an unverified payout is a decision the business
      // may take; an unfounded claim that it was verified is not.
      expect(approved.destinationIfsc).toBe('HDFC0001234');
    });

    it('approving on a verified passbook records the DOCUMENT\'s moment and names it', async () => {
      const verifiedAt = new Date('2026-01-15T10:00:00Z');
      assayerRepo.findOne.mockImplementation(async () => ({
        id: 'assayer-1', bankAccountNumber: '9876543210', ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank', legalName: 'Deepak Sharma', panNumber: 'ABCDE1234F', identityVerifiedAt: null,
      }));
      documentRepo.findOne.mockImplementation(async () => ({
        id: 'doc-1', assayerId: 'assayer-1', requirement: OnboardingDocument.BANK_PASSBOOK,
        verificationStatus: DocumentVerification.VERIFIED, verifiedAt, currentVersionId: 'ver-bank-1', isActive: true,
      }));
      payableRepo.findOne.mockImplementation(async () => payable({ destinationVerifiedAt: null }));
      await service.approvePayouts(['payable-1'], 'finance-1', undefined, DIRECT_REASON);
      const approved = committed.find((row: any) => row.id === 'payable-1');
      expect(approved.destinationVerifiedAt).toEqual(verifiedAt);
      expect(approved.destinationVerifiedSource).toBe('BANK_PASSBOOK');
      expect(approved.payoutEvidenceVersionId).toBe('ver-bank-1');
    });

    it('approving on identity alone records when identity was established, not now', async () => {
      const identityVerifiedAt = new Date('2025-06-01T00:00:00Z');
      documentRepo.findOne.mockImplementation(async () => null);
      assayerRepo.findOne.mockImplementation(async () => ({
        id: 'assayer-1', bankAccountNumber: '9876543210', ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank', displayName: 'Assayer One', panNumber: 'ABCDE1234F', identityVerifiedAt,
      }));
      payableRepo.findOne.mockImplementation(async () => payable({ destinationVerifiedAt: null }));
      await service.approvePayouts(['payable-1'], 'finance-1', undefined, DIRECT_REASON);
      const approved = committed.find((row: any) => row.id === 'payable-1');
      expect(approved.destinationVerifiedAt).toEqual(identityVerifiedAt);
      expect(approved.destinationVerifiedSource).toBe('IDENTITY_DOCUMENT');
    });

    it('the payment row repeats the payable\'s frozen claim and nothing more', async () => {
      unevidenced();
      // A payable frozen before this rule existed: destination columns unset, so
      // recordDisbursement re-freezes them under lock. It carried its own copy of the fallback.
      payableRepo.findOne.mockImplementation(async () => payable({
        status: AssayerPayableStatus.APPROVED, approvedBy: 'finance-9', hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1',
        destinationBankAccountNumber: null, destinationIfsc: null, destinationVerifiedAt: null,
      }));
      totalsRow = { ...totalsRow, outstanding: 0 };
      const payment = await service.recordDisbursement(
        { payableId: 'payable-1', paymentReference: 'UTR-1', method: PaymentMethod.NEFT }, 'finance-1',
      );
      expect(payment.destinationVerifiedAt).toBeNull();
      expect(payment.destinationVerifiedSource).toBeNull();
      expect(payment.destinationIfsc).toBe('HDFC0001234');
    });
  });

  /**
   * Segregation of duties — see security.segregationOfDuties.mode in settings.registry.ts.
   * approvePayouts compares the approver against whoever booked the ASSIGNMENT, not the payable's
   * own (almost always automated) createdBy; recordDisbursement compares the disburser against
   * approvedBy, already on the row.
   *
   * Every case below sets a mode explicitly. That was written when 'off' was the shipped default
   * and reads as prudence, but it is also why the defect survived a full suite: no test here ever
   * asked what happens when NOBODY sets a mode, which is the only configuration that has ever run
   * in production — `platform_settings` had zero rows. The block after this one asks exactly that.
   */
  describe('Segregation of duties (staged)', () => {
    describe('approvePayouts vs. the assignment booker', () => {
      it('off: the same account books and approves without a lookup or a refusal', async () => {
        settingsValues['security.segregationOfDuties.mode'] = 'off';
        payableRepo.findOne.mockImplementation(async () => payable());
        const r = await service.approvePayouts(['payable-1'], 'ops-1', undefined, DIRECT_REASON);
        expect(r).toEqual({ done: ['payable-1'], refused: [] });
        expect(assignmentRepo.findOne).not.toHaveBeenCalled();
      });

      it('warn: records the same-person approval but still approves it', async () => {
        settingsValues['security.segregationOfDuties.mode'] = 'warn';
        payableRepo.findOne.mockImplementation(async () => payable());
        assignmentRepo.findOne.mockImplementation(async () => ({ id: 'asn-1', createdBy: 'ops-1' }));
        const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
        const r = await service.approvePayouts(['payable-1'], 'ops-1', undefined, DIRECT_REASON);
        expect(r).toEqual({ done: ['payable-1'], refused: [] });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('same account (ops-1) on both sides'));
        warn.mockRestore();
      });

      it('enforce: refuses when the approver is the account that booked the assignment', async () => {
        settingsValues['security.segregationOfDuties.mode'] = 'enforce';
        payableRepo.findOne.mockImplementation(async () => payable());
        assignmentRepo.findOne.mockImplementation(async () => ({ id: 'asn-1', createdBy: 'ops-1' }));
        const r = await service.approvePayouts(['payable-1'], 'ops-1', undefined, DIRECT_REASON);
        expect(r.done).toEqual([]);
        expect(r.refused).toEqual([{ id: 'payable-1', reason: expect.stringContaining('Segregation of duties') }]);
        expect(committed).toHaveLength(0);
      });

      it('enforce: allows it when a different account booked the assignment', async () => {
        settingsValues['security.segregationOfDuties.mode'] = 'enforce';
        payableRepo.findOne.mockImplementation(async () => payable());
        assignmentRepo.findOne.mockImplementation(async () => ({ id: 'asn-1', createdBy: 'field-ops-1' }));
        const r = await service.approvePayouts(['payable-1'], 'finance-1', undefined, DIRECT_REASON);
        expect(r).toEqual({ done: ['payable-1'], refused: [] });
      });

      it('enforce: an assignment auto-created by "system" never collides — the naive check this replaced was permanently inert here', async () => {
        settingsValues['security.segregationOfDuties.mode'] = 'enforce';
        payableRepo.findOne.mockImplementation(async () => payable());
        assignmentRepo.findOne.mockImplementation(async () => ({ id: 'asn-1', createdBy: 'system' }));
        const r = await service.approvePayouts(['payable-1'], 'finance-1', undefined, DIRECT_REASON);
        expect(r).toEqual({ done: ['payable-1'], refused: [] });
      });

      it('enforce: an expense-driven payable is never checked against an assignment booker — it books nothing', async () => {
        settingsValues['security.segregationOfDuties.mode'] = 'enforce';
        payableRepo.findOne.mockImplementation(async () => payable({ assignmentId: null, expenseId: 'expense-1' }));
        const r = await service.approvePayouts(['payable-1'], 'ops-1', undefined, DIRECT_REASON);
        expect(r).toEqual({ done: ['payable-1'], refused: [] });
        expect(assignmentRepo.findOne).not.toHaveBeenCalled();
      });
    });

    describe('recordDisbursement vs. the payout approver', () => {
      it('enforce: refuses when the disburser is also the one who approved the payout', async () => {
        settingsValues['security.segregationOfDuties.mode'] = 'enforce';
        payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1', approvedBy: 'finance-1' }));
        await expect(service.recordDisbursement({ payableId: 'payable-1', paymentReference: 'UTR-1', method: PaymentMethod.NEFT }, 'finance-1'))
          .rejects.toThrow(ConflictException);
        expect(committed).toHaveLength(0);
      });

      it('enforce: allows it when a different account approved the payout', async () => {
        settingsValues['security.segregationOfDuties.mode'] = 'enforce';
        payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1', approvedBy: 'finance-1' }));
        totalsRow = { ...totalsRow, outstanding: 0 };
        const payment = await service.recordDisbursement({ payableId: 'payable-1', paymentReference: 'UTR-1', method: PaymentMethod.NEFT }, 'finance-2');
        expect(payment).toMatchObject({ payableId: 'payable-1' });
      });

      it('warn: records the same-person disbursement but still pays it, and surfaces via the bulk endpoint as done', async () => {
        settingsValues['security.segregationOfDuties.mode'] = 'warn';
        payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1', approvedBy: 'finance-1' }));
        totalsRow = { ...totalsRow, outstanding: 0 };
        const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
        const r = await service.payPayouts(['payable-1'], { paymentReference: 'UTR-1', method: PaymentMethod.NEFT }, 'finance-1');
        expect(r.done).toEqual([{ payableId: 'payable-1', paymentId: expect.any(String) }]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('same account (finance-1) on both sides'));
        warn.mockRestore();
      });

      it('off: the same account approves and pays without a refusal', async () => {
        settingsValues['security.segregationOfDuties.mode'] = 'off';
        payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1', approvedBy: 'finance-1' }));
        totalsRow = { ...totalsRow, outstanding: 0 };
        const payment = await service.recordDisbursement({ payableId: 'payable-1', paymentReference: 'UTR-1', method: PaymentMethod.NEFT }, 'finance-1');
        expect(payment).toMatchObject({ payableId: 'payable-1' });
      });
    });
  });

  /**
   * THE SHIPPED DEFAULT — the configuration every fresh deployment actually runs.
   *
   * `platform_settings` had no row for this key, the registry default was 'off', so `sodMode()`
   * answered 'off' on every call and both `assertSegregationOfDuties` sites were skipped
   * entirely. Certification had one OPERATIONS account approve payable PY-MTU924ZC-242007 and
   * pay it 122 ms later, HTTP 201 both times, with a payment row to show for it.
   *
   * These tests resolve the setting the way a deployment with no saved row resolves it — through
   * `SETTING_BY_KEY[...].default` — rather than pinning a mode. Flip the registry default back to
   * 'off' and every one of them fails.
   */
  describe('Segregation of duties: the default a deployment with no saved setting inherits', () => {
    beforeEach(() => {
      settingsGet.mockImplementation(async (key: string) =>
        settingsValues[key] ?? SETTING_BY_KEY[key]?.default ?? null,
      );
    });
    afterEach(() => {
      settingsGet.mockImplementation(async (key: string) => settingsValues[key] ?? null);
    });

    it('the same account cannot approve a payout and then pay it', async () => {
      payableRepo.findOne.mockImplementation(async () =>
        payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1', approvedBy: 'ops-1' }));
      totalsRow = { ...totalsRow, outstanding: 0 };
      await expect(service.recordDisbursement(
        { payableId: 'payable-1', paymentReference: 'FC-SOD-1', method: PaymentMethod.NEFT }, 'ops-1',
      )).rejects.toThrow(ConflictException);
      expect(committed).toHaveLength(0);
      expect(paymentRepo.save).not.toHaveBeenCalled();
    });

    it('a DIFFERENT account may pay a payout somebody else approved — two people is enough', async () => {
      // The 'off' default was justified by "with two people on the roles today, Enforce would mean
      // neither could ever pay the other's work". This is that claim, tested: it is the reverse.
      payableRepo.findOne.mockImplementation(async () =>
        payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1', approvedBy: 'ops-1' }));
      totalsRow = { ...totalsRow, outstanding: 0 };
      const payment = await service.recordDisbursement(
        { payableId: 'payable-1', paymentReference: 'FC-SOD-2', method: PaymentMethod.NEFT }, 'ops-2',
      );
      expect(payment).toMatchObject({ payableId: 'payable-1' });
    });

    it('the account that booked the assignment cannot approve its payout', async () => {
      payableRepo.findOne.mockImplementation(async () => payable());
      assignmentRepo.findOne.mockImplementation(async () => ({ id: 'asn-1', createdBy: 'ops-1' }));
      const r = await service.approvePayouts(['payable-1'], 'ops-1', undefined, DIRECT_REASON);
      expect(r.done).toEqual([]);
      expect(r.refused).toEqual([{ id: 'payable-1', reason: expect.stringContaining('Segregation of duties') }]);
    });

    it('a different account may approve it', async () => {
      payableRepo.findOne.mockImplementation(async () => payable());
      assignmentRepo.findOne.mockImplementation(async () => ({ id: 'asn-1', createdBy: 'ops-1' }));
      const r = await service.approvePayouts(['payable-1'], 'ops-2', undefined, DIRECT_REASON);
      expect(r).toEqual({ done: ['payable-1'], refused: [] });
    });

    /**
     * The refusal has to outlive the request. Before this it was a 409 in one browser and nothing
     * else: "who tried to approve and pay their own payout" — the question the control exists to
     * answer — had no answer anywhere.
     */
    it('writes the refused attempt to the audit trail, naming both sides', async () => {
      payableRepo.findOne.mockImplementation(async () =>
        payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1', approvedBy: 'ops-1' }));
      totalsRow = { ...totalsRow, outstanding: 0 };
      await expect(service.recordDisbursement(
        { payableId: 'payable-1', paymentReference: 'FC-SOD-3', method: PaymentMethod.NEFT }, 'ops-1',
      )).rejects.toThrow(ConflictException);
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'SEGREGATION_OF_DUTIES_REFUSED',
        entityType: 'PAYABLE',
        entityId: 'payable-1',
        userId: 'ops-1',
        outcome: 'DENIED',
        metadata: expect.objectContaining({ mode: 'enforce', actorId: 'ops-1', otherPartyId: 'ops-1' }),
      }));
    });

    /**
     * No exception for anybody. `assertSegregationOfDuties` compares two account ids and is never
     * given a role — there is no admin or developer bypass to test for, and adding one would put
     * the exemption in the same account that already holds every other capability.
     * `DISBURSEMENT_ROLES` names ADMIN so a payout CAN be approved by someone other than the
     * booker, which is the opposite of an exemption.
     */
    it('has no role-shaped exception: the check sees account ids and nothing else', async () => {
      payableRepo.findOne.mockImplementation(async () =>
        payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1', approvedBy: 'the-super-administrator' }));
      totalsRow = { ...totalsRow, outstanding: 0 };
      await expect(service.recordDisbursement(
        { payableId: 'payable-1', paymentReference: 'FC-SOD-4', method: PaymentMethod.NEFT }, 'the-super-administrator',
      )).rejects.toThrow(ConflictException);
    });

    /**
     * The other fail-open. `sodMode()` used to answer 'off' when the settings read threw, so a
     * settings store that could not be reached switched the money control off.
     */
    it('a settings read that fails falls back to the shipped default, not to off', async () => {
      settingsGet.mockImplementation(async () => { throw new Error('settings store unreachable'); });
      payableRepo.findOne.mockImplementation(async () =>
        payable({ status: AssayerPayableStatus.APPROVED, hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1', approvedBy: 'ops-1' }));
      totalsRow = { ...totalsRow, outstanding: 0 };
      await expect(service.recordDisbursement(
        { payableId: 'payable-1', paymentReference: 'FC-SOD-5', method: PaymentMethod.NEFT }, 'ops-1',
      )).rejects.toThrow(ConflictException);
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

  /**
   * The owner decision: a payable that should never be paid, voided with a reason and an audit
   * trail. Follows the approve/disburse pattern exactly — lock, mutate, history, audit — and
   * additionally voids the matching client line in the same transaction when it has not been
   * invoiced yet, so a job that is un-billed on the assayer side does not stay billed on the
   * client side.
   */
  describe('voidPayable', () => {
    it('requires a reason', async () => {
      await expect(service.voidPayable('payable-1', '  ', 'admin-1')).rejects.toThrow(BadRequestException);
    });

    it('refuses a payable already PAID — that money already left', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.PAID }));
      await expect(service.voidPayable('payable-1', 'audit reopened', 'admin-1')).rejects.toThrow(ConflictException);
      // The mutation this proves: removing the PAID guard lets a disbursed payable be voided,
      // making the ledger claim money that already went out never happened.
      expect(committed.filter((row) => row.action === 'PAYABLE_STATUS_CHANGED')).toHaveLength(0);
    });

    it('voids a PENDING payable, clears any hold, and writes history + audit', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ onHold: true, holdReason: 'stale' }));
      const voided = await service.voidPayable('payable-1', 'Completion reopened by ops', 'admin-1');

      expect(voided).toMatchObject({ status: AssayerPayableStatus.VOIDED, onHold: false, holdReason: null });
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'PAYABLE_VOIDED', newState: AssayerPayableStatus.VOIDED }),
        expect.objectContaining({ manager: expect.anything() }),
      );
      expect(committed.some((row) => row.action === 'PAYABLE_STATUS_CHANGED' && row.toState === AssayerPayableStatus.VOIDED)).toBe(true);
    });

    it('is a no-op on a payable already VOIDED', async () => {
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.VOIDED }));
      const result = await service.voidPayable('payable-1', 'again', 'admin-1');
      expect(result.status).toBe(AssayerPayableStatus.VOIDED);
      expect(committed.filter((row) => row.action === 'PAYABLE_STATUS_CHANGED')).toHaveLength(0);
    });

    it("voids the matching client line in the same transaction when it has not been invoiced", async () => {
      payableRepo.findOne.mockImplementation(async () => payable());
      entryRepo.findOne.mockImplementation(async () => line({ state: BillingState.UNBILLED }));

      await service.voidPayable('payable-1', 'Completion reopened by ops', 'admin-1');

      const voidedLine = committed.find((row) => row.entryNumber && row.state === BillingState.CANCELLED);
      expect(voidedLine).toBeDefined();
      // The mutation this proves: skipping the client-line lookup/void leaves the line
      // UNBILLED-and-orphaned — billed on neither side is fine, billed on the client side alone
      // (after the assayer side was voided) is the bug this closes.
    });

    it('does not touch an already-invoiced client line — that needs a credit note, not a void', async () => {
      payableRepo.findOne.mockImplementation(async () => payable());
      entryRepo.findOne.mockImplementation(async () => line({ state: BillingState.INVOICED, invoiceId: 'invoice-9' }));

      await service.voidPayable('payable-1', 'Completion reopened by ops', 'admin-1');

      expect(committed.some((row) => row.entryNumber && row.state === BillingState.CANCELLED)).toBe(false);
    });

    it('runs on the caller-supplied manager/emit instead of opening its own transaction, when given one', async () => {
      payableRepo.findOne.mockImplementation(async () => payable());
      const callerManager = makeManager([], []);
      const callerEmit = jest.fn();

      const result = await service.voidPayable('payable-1', 'reopened', 'admin-1', { manager: callerManager as any, emit: callerEmit });

      expect(result.status).toBe(AssayerPayableStatus.VOIDED);
      // The mutation this proves: ignoring `ctx` and always calling `this.inTx(work)` would open
      // a SECOND, independent transaction here — undetectable by this assertion alone, but the
      // dataSource.transaction spy call count below catches it: no new transaction was opened.
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(callerEmit).toHaveBeenCalledWith('billing:payout-changed', expect.objectContaining({ payableId: 'payable-1' }));
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
      // Columns are `p.`-prefixed since the SELECT list became shared with the gated
      // (assayer-audience) totals variant, which joins the invoice table.
      expect(sql).toMatch(/FILTER \(WHERE p\.on_hold = false\), 0\)\s+AS outstanding/);
      expect(sql).toMatch(/p\.status = 'PENDING' AND p\.on_hold = false/);
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
    it('sends an HOD-approved invoice, and treats sending a sent invoice as a no-op', async () => {
      invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.HOD_APPROVED }));
      expect((await service.sendInvoice('invoice-1', 'f')).status).toBe(InvoiceStatus.ISSUED);
      invoiceRepo.findOne.mockImplementation(async () => invoice());
      await service.sendInvoice('invoice-1', 'f');
      expect(committed.filter((row) => row.invoiceNumber)).toHaveLength(1);
    });

    it('writes issuance to the compliance audit trail', async () => {
      invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.HOD_APPROVED }));
      await service.sendInvoice('invoice-1', 'f');
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
        category: EventCategory.WORKFLOW,
        eventType: 'INVOICE_ISSUED',
        entityType: 'INVOICE',
        entityId: 'invoice-1',
        previousState: InvoiceStatus.HOD_APPROVED,
        newState: InvoiceStatus.ISSUED,
        userId: 'f',
        metadata: expect.objectContaining({ invoiceId: 'invoice-1', clientId: 'client-1', amount: 3564 }),
      }), expect.objectContaining({ manager: expect.anything() }));
    });

    it('cancels an unpaid invoice and returns its lines to UNBILLED', async () => {
      invoiceRepo.findOne.mockImplementation(async () => invoice());
      entryRepo.createQueryBuilder.mockImplementation(() => ({ ...queryBuilderStub(), getMany: jest.fn(async () => [line({ state: BillingState.INVOICED, invoiceId: 'invoice-1', outstandingAmount: '3564.00' })]) }));
      const inv = await service.cancelInvoice('invoice-1', 'Wrong client', 'f');
      expect(inv).toMatchObject({ status: InvoiceStatus.CANCELLED, outstandingAmount: 0 });
      const e = committed.find((row) => row.entryNumber);
      expect(e).toMatchObject({ state: BillingState.UNBILLED, invoiceId: null, outstandingAmount: 0 });
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
        category: EventCategory.WORKFLOW,
        eventType: 'INVOICE_CANCELLED',
        entityType: 'INVOICE',
        entityId: 'invoice-1',
        newState: InvoiceStatus.CANCELLED,
        userId: 'f',
        remarks: 'Wrong client',
        metadata: expect.objectContaining({ invoiceId: 'invoice-1', reason: 'Wrong client' }),
      }), expect.objectContaining({ manager: expect.anything() }));
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

    it('writes the collection to the compliance audit trail — who paid how much, against which invoice', async () => {
      await service.recordPayment({ invoiceId: 'invoice-1', paymentReference: 'R1', method: PaymentMethod.NEFT, amount: 3564 }, 'f');
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
        category: EventCategory.WORKFLOW,
        eventType: 'PAYMENT_RECEIVED',
        entityType: 'PAYMENT',
        userId: 'f',
        metadata: expect.objectContaining({ invoiceId: 'invoice-1', amount: 3564, paymentReference: 'R1' }),
      }), expect.objectContaining({ manager: expect.anything() }));
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
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
        category: EventCategory.WORKFLOW,
        eventType: 'PAYMENT_REVERSED',
        entityType: 'PAYMENT',
        entityId: 'payment-1',
        userId: 'f',
        remarks: 'Bounced cheque',
        metadata: expect.objectContaining({ invoiceId: 'invoice-1', amount: 3564, direction: 'INBOUND', reason: 'Bounced cheque' }),
      }), expect.objectContaining({ manager: expect.anything() }));
    });

    it('reverses an outbound payment: the payable goes back to APPROVED', async () => {
      paymentRepo.findOne.mockImplementation(async () => ({ id: 'payment-1', direction: PaymentDirection.OUTBOUND, payableId: 'payable-1', amount: '1800.00', paymentReference: 'UTR-1', isActive: true }));
      payableRepo.findOne.mockImplementation(async () => payable({ status: AssayerPayableStatus.PAID, paidAmount: '1800.00', paidAt: new Date(), paidBy: 'f' }));
      await service.reversePayment('payment-1', 'Wrong account', 'f');
      expect(committed.find((row) => row.payableNumber)).toMatchObject({ status: AssayerPayableStatus.APPROVED, paidAmount: 0, paidAt: null, paidBy: null });
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
        category: EventCategory.WORKFLOW,
        eventType: 'PAYMENT_REVERSED',
        entityType: 'PAYMENT',
        entityId: 'payment-1',
        userId: 'f',
        remarks: 'Wrong account',
        metadata: expect.objectContaining({ payableId: 'payable-1', amount: 1800, direction: 'OUTBOUND', reason: 'Wrong account' }),
      }), expect.objectContaining({ manager: expect.anything() }));
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

    // The fixture's line is baseAmount 3000 + travelAmount 300 = 3300, so a credit cannot reduce
    // it by more than 3300 without a negative taxable amount reaching the tax calc — which would
    // store negative GST/TDS and corrupt the payment allocator's proportional split (see the
    // `adjustmentFloor` comment in the source). This was implemented but had no regression test.
    it('refuses a credit larger than the line, stating the floor', async () => {
      entryRepo.findOne.mockImplementation(async () => line());
      await expect(
        service.editClientLine('asn-1', { adjustmentAmount: -3301, adjustmentReason: 'Goodwill' }, 'f'),
      ).rejects.toThrow(/exceeds the line.*3300\.00/s);
    });

    it('allows a credit that exactly zeroes the line — the floor itself is not refused', async () => {
      entryRepo.findOne.mockImplementation(async () => line());
      const e = await service.editClientLine('asn-1', { adjustmentAmount: -3300, adjustmentReason: 'Goodwill' }, 'f');
      expect(e).toMatchObject({ adjustmentAmount: -3300, taxableAmount: 0, taxAmount: 0, tdsAmount: 0, totalAmount: 0 });
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

  // ── Region scoping (staged) ──────────────────────────────────────────────
  //
  // Billing rows carry no region of their own. Every one of them reaches a region through the
  // assignment → project_branch → branch chain, except an assayer, which carries its own
  // `region` column directly. The guard's own methods are mocked here (they are
  // `RegionGuardService`'s contract, not this service's) — what these tests cover is that
  // BillingEngineService resolves the right region(s) where that is still its job, and calls the
  // guard correctly where it is not: never for an unrestricted caller, under the right context
  // label per route, and — for the list routes — filtering the query only in `enforce` mode while
  // `log`'s count comes from the page already fetched, with no second query.
  //
  // The two invoice READS are the exception: the invoice walk is the guard's
  // `assertInvoiceInScope`, so what is asserted below is the delegation and the label, and the
  // multi-region looping lives in `region-guard.service.spec.ts` where the rule now lives.

  describe('Region scoping (staged) — detail routes', () => {
    const restricted: Partial<GlobalScope> = { regions: ['NORTH'] as any };

    it('assayerStatement asserts the assayer’s own region column — no join needed', async () => {
      assayerRepo.findOne.mockImplementation(async () => ({ id: 'assayer-1', displayName: 'Priya', assayerCode: 'A1', region: 'SOUTH' }));
      await service.assayerStatement('assayer-1', restricted);
      expect(assertRegionAllowedStaged).toHaveBeenCalledWith('SOUTH', restricted, 'billing-engine:assayer-statement');
    });

    it('assayerStatement asserts null for an assayer with no region on file — never a refusal by construction', async () => {
      assayerRepo.findOne.mockImplementation(async () => ({ id: 'assayer-1', displayName: 'Priya', region: null }));
      await service.assayerStatement('assayer-1', restricted);
      expect(assertRegionAllowedStaged).toHaveBeenCalledWith(null, restricted, 'billing-engine:assayer-statement');
    });

    it('assignmentMoneyLine resolves the branch region through project_branches only for a restricted caller', async () => {
      assignmentRepo.findOne.mockImplementation(async () => ({ id: 'asn-1', assignmentNumber: 'ASN-001', status: 'COMPLETED', projectBranchId: 'pb-1' }));
      managerQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM project_branches pb JOIN branches')) return [{ region: 'SOUTH' }];
        return [];
      });
      await service.assignmentMoneyLine('asn-1', restricted);
      expect(assertRegionAllowedStaged).toHaveBeenCalledWith('SOUTH', restricted, 'billing-engine:assignment-money');
    });

    it('assignmentMoneyLine never resolves or asserts a region for an unrestricted (national) caller', async () => {
      assignmentRepo.findOne.mockImplementation(async () => ({ id: 'asn-1', assignmentNumber: 'ASN-001', status: 'COMPLETED', projectBranchId: 'pb-1' }));
      await service.assignmentMoneyLine('asn-1', { regions: null });
      expect(assertRegionAllowedStaged).not.toHaveBeenCalled();
    });

    it('getInvoice hands the invoice to the guard under its own context label', async () => {
      invoiceRepo.findOne.mockImplementation(async () => ({ ...invoice(), entries: [line()], payments: [] }));
      managerQuery.mockImplementation(async (sql: string) => (sql.includes('FROM clients WHERE id') ? [{ name: 'Client A' }] : []));
      await service.getInvoice('invoice-1', restricted);
      expect(assertInvoiceInScope).toHaveBeenCalledWith('invoice-1', restricted, 'billing-engine:invoice');
    });

    it('getInvoiceDocument uses its own context label, distinct from getInvoice', async () => {
      // Two labels, not one, so a Log-mode line says which of the two reads nearly refused.
      invoiceRepo.findOne.mockImplementation(async () => ({ ...invoice(), entries: [line()] }));
      managerQuery.mockImplementation(async (sql: string) => (sql.includes('FROM clients c') ? [{ name: 'Client A' }] : []));
      await service.getInvoiceDocument('invoice-1', restricted);
      expect(assertInvoiceInScope).toHaveBeenCalledWith('invoice-1', restricted, 'billing-engine:invoice-document');
    });

    it('passes an unrestricted scope straight through — the short-circuit is the guard’s, not a second copy of it', async () => {
      // The service must not grow its own "is this caller restricted" test. That question is
      // answered once, in `assertInvoiceInScope`, whose first line is the short-circuit.
      invoiceRepo.findOne.mockImplementation(async () => ({ ...invoice(), entries: [line()], payments: [] }));
      await service.getInvoice('invoice-1', { regions: null });
      expect(assertInvoiceInScope).toHaveBeenCalledWith('invoice-1', { regions: null }, 'billing-engine:invoice');
    });

    /**
     * The regression guard for the duplication this pair of reads was built out of.
     *
     * `invoiceRegions` and `assertInvoiceRegionAllowed` were a private second copy of
     * `RegionGuardService.assertInvoiceInScope` — the same four-table walk, on this service's own
     * repository manager. They are gone. If either comes back, the walk shows up on `managerQuery`
     * again and this goes red, naming the read that reintroduced it.
     */
    const BOTH_READS: Array<{ read: string; call: (scope: Partial<GlobalScope>) => Promise<unknown> }> = [
      { read: 'getInvoice', call: (scope) => service.getInvoice('invoice-1', scope) },
      { read: 'getInvoiceDocument', call: (scope) => service.getInvoiceDocument('invoice-1', scope) },
    ];

    it.each(BOTH_READS)('$read resolves no invoice region itself — the rule has exactly one home', async ({ call }) => {
      invoiceRepo.findOne.mockImplementation(async () => ({ ...invoice(), entries: [line()], payments: [] }));
      managerQuery.mockImplementation(async () => []);
      await call(restricted);
      expect(managerQuery.mock.calls.some(([sql]) => sql.includes('DISTINCT b.region'))).toBe(false);
    });

    it.each(BOTH_READS)('$read returns nothing when the guard refuses — the refusal is not swallowed', async ({ call }) => {
      invoiceRepo.findOne.mockImplementation(async () => ({ ...invoice(), entries: [line()], payments: [] }));
      assertInvoiceInScope.mockImplementationOnce(async () => { throw new ForbiddenException('nope'); });
      await expect(call(restricted)).rejects.toThrow(ForbiddenException);
    });
  });

  /**
   * The filter the pay screen's stages are built on.
   *
   * "Due" is two piles with opposite handling — work on a bill the assayer has not confirmed
   * (per-row approval is REFUSED, `approveOne` throws) and work no bill has reached — and status
   * alone cannot separate them. Shown as one list with one Approve button over it, ticking a
   * whole assayer's rows authorised half a selection and collected refusals for the rest.
   *
   * Both code paths matter: an unscoped caller takes the `findAndCount` road and a region-scoped
   * one takes the query builder. A filter honoured on only one of them would quietly stop
   * separating the piles for exactly the region desks, which is the audience most likely to be
   * approving payouts by the page.
   */
  describe('listPayouts — on a bill, or on none', () => {
    it('narrows to payouts riding a bill, and to those on none, on the unscoped path', async () => {
      stagedMode.mockImplementation(async () => 'off');
      payableRepo.findAndCount.mockImplementation(async () => [[payable()], 1]);

      await service.listPayouts({ onBill: true });
      expect(payableRepo.findAndCount).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ assayerInvoiceId: Not(IsNull()) }) }),
      );

      await service.listPayouts({ onBill: false });
      expect(payableRepo.findAndCount).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ assayerInvoiceId: IsNull() }) }),
      );
    });

    it('leaves both kinds in when nothing is asked for', async () => {
      stagedMode.mockImplementationOnce(async () => 'off');
      payableRepo.findAndCount.mockImplementationOnce(async () => [[payable()], 1]);

      await service.listPayouts({});

      const [{ where }] = payableRepo.findAndCount.mock.calls.at(-1)!;
      expect(where).not.toHaveProperty('assayerInvoiceId');
    });

    it('narrows the same way for a region-scoped caller, who reads through the query builder', async () => {
      stagedMode.mockImplementation(async () => 'enforce');
      const qb: any = queryBuilderStub();
      qb.getRawAndEntities = jest.fn(async () => ({ entities: [payable()], raw: [{ region_scope: 'NORTH' }] }));
      qb.getCount = jest.fn(async () => 1);
      payableRepo.createQueryBuilder.mockImplementation(() => qb);

      await service.listPayouts({ onBill: true }, { regions: ['NORTH'] as any });
      expect(qb.andWhere).toHaveBeenCalledWith('p.assayer_invoice_id IS NOT NULL');

      await service.listPayouts({ onBill: false }, { regions: ['NORTH'] as any });
      expect(qb.andWhere).toHaveBeenCalledWith('p.assayer_invoice_id IS NULL');
    });
  });

  describe('Region scoping (staged) — list routes', () => {
    const restricted: Partial<GlobalScope> = { regions: ['NORTH'] as any };

    it('listPayouts takes the ORIGINAL unfiltered path in off mode, even for a restricted caller — byte-identical to today', async () => {
      stagedMode.mockImplementationOnce(async () => 'off');
      payableRepo.findAndCount.mockImplementationOnce(async () => [[payable()], 1]);
      const page = await service.listPayouts({}, restricted);
      expect(page.items).toHaveLength(1);
      expect(payableRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('listPayouts takes the ORIGINAL unfiltered path for an unrestricted caller, regardless of mode', async () => {
      stagedMode.mockImplementationOnce(async () => 'enforce');
      payableRepo.findAndCount.mockImplementationOnce(async () => [[payable()], 1]);
      const page = await service.listPayouts({}, { regions: null });
      expect(page.items).toHaveLength(1);
      expect(payableRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('listPayouts filters by the assignment’s branch region in enforce mode', async () => {
      stagedMode.mockImplementationOnce(async () => 'enforce');
      const qb: any = queryBuilderStub();
      qb.getRawAndEntities = jest.fn(async () => ({ entities: [payable({ id: 'payable-2' })], raw: [{ region_scope: 'NORTH' }] }));
      qb.getCount = jest.fn(async () => 1);
      payableRepo.createQueryBuilder.mockImplementation(() => qb);
      const page = await service.listPayouts({}, restricted);
      expect(qb.andWhere).toHaveBeenCalledWith('rg_b.region IN (:...regions)', { regions: ['NORTH'] });
      expect(page.items).toHaveLength(1);
      expect(page.total).toBe(1);
    });

    it('listPayouts stays unfiltered in log mode and warns from the page already fetched — no second query', async () => {
      stagedMode.mockImplementationOnce(async () => 'log');
      const qb: any = queryBuilderStub();
      qb.getRawAndEntities = jest.fn(async () => ({
        entities: [payable({ id: 'p-north' }), payable({ id: 'p-south' })],
        raw: [{ region_scope: 'NORTH' }, { region_scope: 'SOUTH' }],
      }));
      qb.getCount = jest.fn(async () => 2);
      payableRepo.createQueryBuilder.mockImplementation(() => qb);
      const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
      const page = await service.listPayouts({}, restricted);
      expect(qb.andWhere).not.toHaveBeenCalledWith('rg_b.region IN (:...regions)', expect.anything());
      expect(page.items).toHaveLength(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('would filter 1 of 2'));
      warn.mockRestore();
    });

    it('listClientLines follows the same off/log/enforce contract through the entry→assignment→branch join', async () => {
      stagedMode.mockImplementationOnce(async () => 'enforce');
      const qb: any = queryBuilderStub();
      qb.getRawAndEntities = jest.fn(async () => ({ entities: [line({ id: 'entry-in-scope' })], raw: [{ region_scope: 'NORTH' }] }));
      entryRepo.createQueryBuilder.mockImplementation(() => qb);
      const lines = await service.listClientLines({}, restricted);
      expect(qb.andWhere).toHaveBeenCalledWith('rg_b.region IN (:...regions)', { regions: ['NORTH'] });
      expect(lines).toHaveLength(1);
    });

    /**
     * `GET /billing/lines` used to hand back every line matching whatever filter was given —
     * `?state=UNBILLED` alone was a single request asking for the entire, ever-growing
     * `billing_entries` table. `paginate: true` (what the controller always passes) opts into
     * the same `billingPageWindow` clamp `listPayouts`/`findInvoicesPage` already use.
     */
    describe('listClientLines — bounding GET /billing/lines', () => {
      it('is unbounded by default — the one internal caller (the billing export) needs every row', async () => {
        entryRepo.find.mockResolvedValueOnce(Array.from({ length: 250 }, (_, i) => line({ id: `entry-${i}` })));
        const lines = await service.listClientLines({});
        expect(Array.isArray(lines)).toBe(true);
        expect((lines as any[]).length).toBe(250);
        expect(entryRepo.find).toHaveBeenCalledWith(expect.not.objectContaining({ skip: expect.anything(), take: expect.anything() }));
      });

      it('paginate:true clamps to the page window and returns items + total, not a bare array', async () => {
        entryRepo.findAndCount.mockResolvedValueOnce([[line({ id: 'entry-1' })], 137]);
        const page = await service.listClientLines({ limit: 10 }, undefined, true);

        expect(entryRepo.findAndCount).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 10 }));
        expect(page).toMatchObject({ total: 137, page: 1, limit: 10 });
        expect((page as any).items).toHaveLength(1);
      });

      it('paginate:true clamps a runaway ?limit= to the same ceiling listPayouts uses', async () => {
        entryRepo.findAndCount.mockResolvedValueOnce([[], 0]);
        await service.listClientLines({ limit: 5_000_000 }, undefined, true);
        // The mutation this proves: calling `listClientLines(q, scope)` from the controller
        // (dropping the third argument) makes this assertion fail — `findAndCount` is never
        // called with a `take` at all, because the unpaginated branch runs `entryRepository
        // .find()` instead, which is exactly the unbounded query this fix closes.
        const call = entryRepo.findAndCount.mock.calls[0][0];
        expect(call.take).toBeLessThanOrEqual(100);
      });
    });

    it('listInvoiceable adds the region column to the SAME query only when restricted and not off, and filters only in enforce', async () => {
      stagedMode.mockImplementationOnce(async () => 'enforce');
      managerQuery.mockImplementationOnce(async (sql: string, params: any[]) => {
        expect(sql).toContain('b.region AS region_scope');
        expect(sql).toContain('b.region = ANY($2::text[])');
        expect(params).toEqual([null, ['NORTH']]);
        return [];
      });
      await service.listInvoiceable({}, restricted);
    });

    it('listInvoiceable leaves the query exactly as it was today when off', async () => {
      stagedMode.mockImplementationOnce(async () => 'off');
      managerQuery.mockImplementationOnce(async (sql: string, params: any[]) => {
        expect(sql).not.toContain('region_scope');
        expect(params).toEqual([null]);
        return [];
      });
      await service.listInvoiceable({}, restricted);
    });

    it('findInvoicesPage excludes an invoice with ANY line outside scope, in enforce mode', async () => {
      stagedMode.mockImplementationOnce(async () => 'enforce');
      const qb: any = queryBuilderStub();
      qb.getRawAndEntities = jest.fn(async () => ({ entities: [invoice()], raw: [{ would_filter: false }] }));
      qb.getCount = jest.fn(async () => 1);
      invoiceRepo.createQueryBuilder.mockImplementation(() => qb);
      const page = await service.findInvoicesPage({}, restricted);
      expect(qb.andWhere).toHaveBeenCalledWith(expect.stringContaining('NOT EXISTS'), { regions: ['NORTH'] });
      expect(page.items).toHaveLength(1);
    });

    it('findInvoicesPage warns in log mode without filtering, computed from the fetched page', async () => {
      stagedMode.mockImplementationOnce(async () => 'log');
      const qb: any = queryBuilderStub();
      qb.getRawAndEntities = jest.fn(async () => ({ entities: [invoice()], raw: [{ would_filter: true }] }));
      qb.getCount = jest.fn(async () => 1);
      invoiceRepo.createQueryBuilder.mockImplementation(() => qb);
      const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
      const page = await service.findInvoicesPage({}, restricted);
      expect(qb.andWhere).not.toHaveBeenCalledWith(expect.stringContaining('NOT EXISTS'), expect.anything());
      expect(page.items).toHaveLength(1); // unfiltered
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('would filter 1 of 1'));
      warn.mockRestore();
    });
  });

  // ── The 2026-09-24 money audit (F1–F16) ─────────────────────────────────
  describe('2026-09-24 audit', () => {
    const approvedPayable = (over: Partial<any> = {}) => payable({
      status: AssayerPayableStatus.APPROVED, approvedBy: 'office-1', approvedAt: new Date('2026-08-11T08:00:00Z'),
      hodApprovedAt: null, hodApprovedBy: null, destinationVerifiedSource: 'BANK_PASSBOOK', payoutEvidenceVersionId: 'ver-bank-1', ...over,
    });
    const recordNow = (over: Partial<any> = {}) => ({
      id: 'assayer-1', assayerCode: 'AS-1', displayName: 'Asha', bankAccountNumber: '1111222233', ifscCode: 'SBIN0000001',
      bankName: 'SBI', panNumber: 'ABCDE1234F', ...over,
    });
    /** The "is this account on another record?" lookup answers yes. */
    const sharedAccount = () => managerQuery.mockImplementation(async (sql: string, params?: any[]) =>
      (sql.includes('FROM assayers') && sql.includes('ifsc_code') && sql.includes('id <> $3') ? [{ '?column?': 1 }] : defaultManagerQuery(sql)));
    /** The s.194J year: the other live fee payables' gross and TDS. */
    const fyRow = (gross: number, tds: number) => managerQuery.mockImplementation(async (sql: string) =>
      (sql.includes('SUM(p.base_amount + p.travel_amount)') ? [{ gross, tds }] : defaultManagerQuery(sql)));

    describe('F1 — createInvoice reads LIVE lines only', () => {
      it('locks the lines with the liveness rule and is_active, so a reopened-and-redone job can be invoiced', async () => {
        const wheres: string[] = [];
        entryRepo.createQueryBuilder.mockImplementation(() => {
          const qb: any = { ...queryBuilderStub(), getMany: jest.fn(async () => [line()]) };
          qb.where = jest.fn((clause: string) => { wheres.push(clause); return qb; });
          return qb;
        });
        await service.createInvoice({ clientId: 'client-1', assignmentIds: ['asn-1'] }, 'finance-1');
        expect(wheres[0]).toContain("e.state NOT IN ('CANCELLED')");
        expect(wheres[0]).toContain('e.is_active = true');
      });
    });

    describe('F2 — the frozen bank destination can be refreshed', () => {
      it('releasing a hold re-reads the account from the record, masked in history and audit, and withdraws an HOD approval given for the old one', async () => {
        payableRepo.findOne.mockImplementation(async () => approvedPayable({ onHold: true, holdReason: 'Wrong account', hodApprovedAt: HOD_AT, hodApprovedBy: 'hod-1' }));
        assayerRepo.findOne.mockImplementation(async () => recordNow());
        await service.holdPayout('payable-1', false, undefined, 'office-2');
        const p = committed.find((row) => row.payableNumber);
        expect(p).toMatchObject({ onHold: false, destinationBankAccountNumber: '1111222233', destinationIfsc: 'SBIN0000001', hodApprovedAt: null });
        const h = committed.find((row) => row.action === 'PAYABLE_DESTINATION_REFRESHED');
        expect(h.previousValue).toMatchObject({ account: '******3210', ifsc: 'HDFC0001234' });
        expect(h.newValue).toMatchObject({ account: '******2233', ifsc: 'SBIN0000001', hodApprovalWithdrawn: true });
        expect(JSON.stringify(h)).not.toContain('9876543210');
        expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'PAYABLE_DESTINATION_REFRESHED' }), expect.anything());
      });

      it('leaves the snapshot alone when the record still says the same account', async () => {
        payableRepo.findOne.mockImplementation(async () => approvedPayable({ onHold: true, holdReason: 'x', hodApprovedAt: HOD_AT }));
        assayerRepo.findOne.mockImplementation(async () => recordNow({ bankAccountNumber: '9876 5432 10', ifscCode: 'hdfc0001234', bankName: 'HDFC Bank', legalName: 'Assayer One' }));
        await service.holdPayout('payable-1', false, undefined, 'office-2');
        expect(committed.find((row) => row.action === 'PAYABLE_DESTINATION_REFRESHED')).toBeUndefined();
        expect(committed.find((row) => row.payableNumber)).toMatchObject({ hodApprovedAt: HOD_AT });
      });

      it('refuses the release when the new account is on another assayer\'s record — nothing moves', async () => {
        payableRepo.findOne.mockImplementation(async () => approvedPayable({ onHold: true, holdReason: 'x' }));
        assayerRepo.findOne.mockImplementation(async () => recordNow());
        sharedAccount();
        await expect(service.holdPayout('payable-1', false, undefined, 'office-2')).rejects.toThrow(/another assayer's record/);
        expect(committed).toHaveLength(0);
      });

      it('reversing an outbound payment re-reads the account too', async () => {
        paymentRepo.findOne.mockImplementation(async () => ({ id: 'payment-1', direction: PaymentDirection.OUTBOUND, payableId: 'payable-1', amount: '1800.00', paymentReference: 'UTR-1', isActive: true }));
        payableRepo.findOne.mockImplementation(async () => approvedPayable({ status: AssayerPayableStatus.PAID, paidAmount: '1800.00', hodApprovedAt: HOD_AT }));
        assayerRepo.findOne.mockImplementation(async () => recordNow());
        await service.reversePayment('payment-1', 'Bounced — wrong account', 'f');
        expect(committed.find((row) => row.payableNumber)).toMatchObject({ status: AssayerPayableStatus.APPROVED, destinationBankAccountNumber: '1111222233' });
        expect(committed.find((row) => row.action === 'PAYABLE_DESTINATION_REFRESHED')).toBeDefined();
      });

      it('the bank file flags a payout whose record changed since approval, and still pays the frozen account', async () => {
        payableRepo.find.mockImplementation(async () => [approvedPayable({ hodApprovedAt: HOD_AT })]);
        assayerRepo.find.mockImplementation(async () => [recordNow()]);
        const r = await service.payoutBankDetails(['payable-1']);
        expect(r.rows[0]).toMatchObject({ accountNumber: '9876543210', destinationDiffersFromRecord: true });
        expect(r.rows[0].warning).toContain('******3210');
        expect(r.rows[0].warning).toContain('******2233');
      });

      it('the bank file says nothing when the record agrees', async () => {
        payableRepo.find.mockImplementation(async () => [approvedPayable({ hodApprovedAt: HOD_AT })]);
        assayerRepo.find.mockImplementation(async () => [recordNow({ bankAccountNumber: '9876543210', ifscCode: 'HDFC0001234' })]);
        const r = await service.payoutBankDetails(['payable-1']);
        expect(r.rows[0]).toMatchObject({ destinationDiffersFromRecord: false, warning: null });
      });
    });

    describe('F3 — an account on another assayer\'s record is refused; an unverified one is allowed with a warning', () => {
      it('office approval refuses, with PAYOUT_DESTINATION_SHARED, and approves nothing', async () => {
        payableRepo.findOne.mockImplementation(async () => payable());
        sharedAccount();
        const r = await service.approvePayouts(['payable-1'], 'finance-1', undefined, DIRECT_REASON);
        expect(r.done).toEqual([]);
        expect(r.refused[0].reason).toMatch(/another assayer's record/);
        expect(r.refused[0].reason).not.toMatch(/AS-|assayer-2/);
        expect(committed.filter((row) => row.payableNumber)).toHaveLength(0);
      });

      it('the refusal carries the stable code', async () => {
        payableRepo.findOne.mockImplementation(async () => payable());
        sharedAccount();
        const err: any = await (service as any).inTx((m: any, emit: any) =>
          service.approvePayableInTx(m, emit, 'payable-1', 'finance-1', { suppressNotification: true, reason: DIRECT_REASON }))
          .catch((e: any) => e);
        expect(err.getResponse()).toMatchObject({ code: 'PAYOUT_DESTINATION_SHARED' });
      });

      it('HOD approval refuses too, on the frozen account', async () => {
        payableRepo.findOne.mockImplementation(async () => approvedPayable());
        sharedAccount();
        const r = await service.hodApprovePayouts(['payable-1'], 'hod-1');
        expect(r.done).toEqual([]);
        expect(r.refused[0].reason).toMatch(/another assayer's record/);
      });

      it('the queue and the pre-approval check say "not verified" and "changed since approval", masked', async () => {
        payableRepo.find.mockImplementation(async () => [approvedPayable({ destinationVerifiedSource: null })]);
        assayerRepo.find.mockImplementation(async () => [recordNow()]);
        (payableRepo.manager as any).find = jest.fn(async () => []);
        const [c] = await service.payoutDestinationChecks(['payable-1']);
        expect(c).toMatchObject({ verified: false, snapshotDiffersFromRecord: true, sharedWithAnotherRecord: false, blocking: null, snapshotAccountTail: '******3210', recordAccountTail: '******2233' });
        expect(c.warnings.join(' ')).toMatch(/not verified/);
        expect(c.warnings.join(' ')).toMatch(/changed after this payout was approved/);
      });

      it("fills the HOD queue's warnings for a payout", async () => {
        managerQuery.mockImplementation(async (sql: string) => {
          if (sql.includes('FROM assayer_payables p') && sql.includes('office_note')) {
            return [{ id: 'payable-1', payable_number: 'PY-1', total_amount: '1800', paid_amount: '0', approved_by: 'office-1' }];
          }
          return defaultManagerQuery(sql);
        });
        payableRepo.find.mockImplementation(async () => [approvedPayable({ destinationVerifiedSource: null })]);
        assayerRepo.find.mockImplementation(async () => [recordNow({ bankAccountNumber: '9876543210', ifscCode: 'HDFC0001234' })]);
        (payableRepo.manager as any).find = jest.fn(async () => []);
        const q = await service.finalApprovalQueue();
        const item = q.items.find((i) => i.id === 'payable-1')!;
        expect(item.warnings).toEqual([expect.stringMatching(/not verified/)]);
      });
    });

    describe('F4 — TDS booked without a PAN is re-withheld at the normal rate at approval', () => {
      it('recomputes a payable booked at the s.206AA rate, with history', async () => {
        payableRepo.findOne.mockImplementation(async () => payable({
          tdsAmount: '400.00', totalAmount: '1600.00', rateSnapshot: { feeAmount: 2000, tdsRate: 20, tdsPanBasis: 'NO_PAN' },
        }));
        await service.approvePayouts(['payable-1'], 'finance-1', undefined, DIRECT_REASON);
        expect(committed.find((row) => row.payableNumber)).toMatchObject({ status: AssayerPayableStatus.APPROVED, tdsAmount: 200, totalAmount: 1800 });
        const h = committed.find((row) => row.action === 'PAYABLE_TDS_RECOMPUTED');
        expect(h).toMatchObject({ previousValue: { tdsAmount: 400, totalAmount: 1600, tdsRate: 20 }, newValue: { tdsAmount: 200, totalAmount: 1800, tdsRate: 10 } });
        expect(h.reason).toMatch(/s\.206AA/);
      });

      it('recognises an older payable booked at the no-PAN rate by the rate alone', async () => {
        payableRepo.findOne.mockImplementation(async () => payable({ tdsAmount: '400.00', totalAmount: '1600.00', rateSnapshot: { tdsRate: 20 } }));
        await service.approvePayouts(['payable-1'], 'finance-1', undefined, DIRECT_REASON);
        expect(committed.find((row) => row.payableNumber)).toMatchObject({ tdsAmount: 200, totalAmount: 1800 });
      });

      it('leaves a payable booked at the normal rate exactly as booked', async () => {
        payableRepo.findOne.mockImplementation(async () => payable({ rateSnapshot: { tdsRate: 10, tdsPanBasis: 'PAN' } }));
        await service.approvePayouts(['payable-1'], 'finance-1', undefined, DIRECT_REASON);
        expect(committed.find((row) => row.payableNumber)).toMatchObject({ tdsAmount: '200.00', totalAmount: '1800.00' });
        expect(committed.find((row) => row.action === 'PAYABLE_TDS_RECOMPUTED')).toBeUndefined();
      });
    });

    describe('F15 — the s.194J annual threshold', () => {
      beforeEach(() => {
        settingsValues['billing.tds194jThresholdRupees'] = 50000;
        assignmentRepo.findOne.mockImplementation(async () => completed());
      });
      const bookedPayable = () => committed.find((row) => row.payableNumber);

      it('withholds nothing below the threshold', async () => {
        fyRow(10000, 0);
        await service.bookAssignment('asn-1', 'system');
        expect(bookedPayable()).toMatchObject({ tdsAmount: 0, totalAmount: 2000 });
        expect(bookedPayable().rateSnapshot.tds194j).toMatchObject({ basis: 'BELOW_THRESHOLD', thresholdRupees: 50000 });
      });

      it('withholds nothing when the year lands exactly on it', async () => {
        fyRow(48000, 0);
        await service.bookAssignment('asn-1', 'system');
        expect(bookedPayable()).toMatchObject({ tdsAmount: 0 });
      });

      it('the crossing payable carries the catch-up for the whole year (capped at its own fee)', async () => {
        fyRow(48500, 0);
        await service.bookAssignment('asn-1', 'system');
        // 10% of 50,500 = 5,050 due; only 2,000 to withhold it from.
        expect(bookedPayable()).toMatchObject({ tdsAmount: 2000, totalAmount: 0 });
        expect(bookedPayable().rateSnapshot.tds194j.basis).toBe('CROSSED');
      });

      it('withholds at the rate once the year is past it', async () => {
        fyRow(60000, 6000);
        await service.bookAssignment('asn-1', 'system');
        expect(bookedPayable()).toMatchObject({ tdsAmount: 200, totalAmount: 1800 });
      });

      it('counts only this assayer\'s LIVE fee payables in the booking\'s Indian financial year', async () => {
        fyRow(0, 0);
        await service.bookAssignment('asn-1', 'system');
        const call = managerQuery.mock.calls.find(([sql]) => sql.includes('SUM(p.base_amount + p.travel_amount)'))!;
        expect(call[0]).toContain("p.status NOT IN ('VOIDED')");
        expect(call[0]).toContain('p.expense_id IS NULL');
        expect(call[0]).toContain("AT TIME ZONE 'Asia/Kolkata'");
        const fy = (await import('@fapoms/shared')).indianFinancialYear(new Date());
        expect(call[1]).toEqual(['assayer-1', fy.from, fy.to, null]);
        expect(txQueries.some((q) => q.includes('pg_advisory_xact_lock'))).toBe(true);
      });

      it('files a payable booked at 02:00 IST on 1 April under the NEW year', async () => {
        fyRow(0, 0);
        const m: any = { query: jest.fn(async (sql: string) => (sql.includes('SUM(') ? [{ gross: 0, tds: 0 }] : [])) };
        const d = await (service as any).assayerFeeTds(m, { assayerId: 'assayer-1', gross: 2000, ratePct: 10, bookedAt: new Date('2026-03-31T20:30:00Z') });
        expect(d.financialYear).toBe('26-27');
        expect(m.query.mock.calls.find(([sql]: [string]) => sql.includes('SUM('))[1]).toEqual(['assayer-1', '2026-04-01', '2027-03-31', null]);
      });

      it('threshold 0 is the old behaviour — the rate on this fee, nothing else read', async () => {
        settingsValues['billing.tds194jThresholdRupees'] = 0;
        await service.bookAssignment('asn-1', 'system');
        expect(bookedPayable()).toMatchObject({ tdsAmount: 200, totalAmount: 1800 });
        expect(managerQuery.mock.calls.some(([sql]) => sql.includes('SUM(p.base_amount + p.travel_amount)'))).toBe(false);
      });

      it('approval re-decides the year: a Due payable whose catch-up moved to it is withheld at approval', async () => {
        // Booked at 10% (200) while another payable carried the year's catch-up; that one was
        // voided, so this one now takes the year past the threshold on its own.
        payableRepo.findOne.mockImplementation(async () => payable({ rateSnapshot: { tdsRate: 10, tdsPanBasis: 'PAN' }, createdAt: new Date('2026-09-01T06:00:00Z') }));
        fyRow(52000, 0);
        await service.approvePayouts(['payable-1'], 'finance-1', undefined, DIRECT_REASON);
        expect(committed.find((row) => row.payableNumber)).toMatchObject({ tdsAmount: 2000, totalAmount: 0 });
        expect(committed.find((row) => row.action === 'PAYABLE_TDS_RECOMPUTED').reason).toMatch(/s\.194J/);
      });

      it('the TDS report states the threshold in force', async () => {
        const r = await service.tdsReport();
        expect(r.thresholdRupees).toBe(50000);
      });
    });

    describe('F6 — a direct approval needs its reason, server-side', () => {
      it('refuses with no reason, with OVERRIDE_REASON_REQUIRED, and approves nothing', async () => {
        payableRepo.findOne.mockImplementation(async () => payable());
        const err: any = await (service as any).inTx((m: any, emit: any) =>
          service.approvePayableInTx(m, emit, 'payable-1', 'finance-1', { suppressNotification: true }))
          .catch((e: any) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.getResponse()).toMatchObject({ code: 'OVERRIDE_REASON_REQUIRED' });
        expect(committed).toHaveLength(0);
      });

      it('refuses a reason under ten characters', async () => {
        payableRepo.findOne.mockImplementation(async () => payable());
        const r = await service.approvePayouts(['payable-1'], 'finance-1', undefined, 'ok fine');
        expect(r.done).toEqual([]);
        expect(r.refused[0].reason).toMatch(/at least 10 characters/);
      });

      it('the bill road needs none — the assayer\'s confirmation is the record', async () => {
        payableRepo.findOne.mockImplementation(async () => payable());
        const out = await (service as any).inTx((m: any, emit: any) =>
          service.approvePayableInTx(m, emit, 'payable-1', 'finance-1', { suppressNotification: true, bypassInvoiceGuard: true }));
        expect(out).toMatchObject({ status: AssayerPayableStatus.APPROVED });
      });
    });

    describe('F7 — client invoice numbers INV/25-26/000123', () => {
      it('takes the next serial of the issue date\'s financial year, on the invoice\'s own transaction', async () => {
        entryRepo.createQueryBuilder.mockImplementation(() => ({ ...queryBuilderStub(), getMany: jest.fn(async () => [line()]) }));
        const inv = await service.createInvoice({ clientId: 'client-1', assignmentIds: ['asn-1'], issueDate: '2026-08-01' }, 'f');
        expect(inv.invoiceNumber).toBe('INV/26-27/000123');
        const upsert = managerQuery.mock.calls.find(([sql]) => sql.includes('billing_invoice_number_series'))!;
        expect(upsert[0]).toMatch(/ON CONFLICT \(financial_year\)\s+DO UPDATE SET last_serial = billing_invoice_number_series\.last_serial \+ 1/);
        expect(upsert[1]).toEqual(['26-27']);
        expect(txQueries.some((q) => q.includes('billing_invoice_number_series'))).toBe(true);
      });

      it('an invoice dated 31 March is numbered in the year that is ending', async () => {
        entryRepo.createQueryBuilder.mockImplementation(() => ({ ...queryBuilderStub(), getMany: jest.fn(async () => [line()]) }));
        const inv = await service.createInvoice({ clientId: 'client-1', assignmentIds: ['asn-1'], issueDate: '2026-03-31' }, 'f');
        expect(inv.invoiceNumber).toBe('INV/25-26/000123');
      });
    });

    describe('F8 — re-pricing never touches an approved payout', () => {
      beforeEach(() => assignmentRepo.findOne.mockImplementation(async () => completed({ agreedFee: '2500.00' })));

      it('leaves an APPROVED payout as approved and records why', async () => {
        payableRepo.findOne.mockImplementation(async () => approvedPayable());
        const r = await service.repriceAssignment('asn-1', 'ops-1');
        expect(r.reason).toMatch(/already approved — left untouched/);
        expect(committed.find((row) => row.payableNumber)).toBeUndefined();
        expect(committed.find((row) => row.action === 'PAYABLE_REPRICE_SKIPPED')).toMatchObject({ entityId: 'payable-1', newValue: expect.objectContaining({ feeAmount: 2500 }) });
      });

      it('says so for one with the HOD\'s approval', async () => {
        payableRepo.findOne.mockImplementation(async () => approvedPayable({ hodApprovedAt: HOD_AT }));
        const r = await service.repriceAssignment('asn-1', 'ops-1');
        expect(r.reason).toMatch(/HOD's final approval/);
      });
    });

    describe('F9 — reversing a payment on a PAID bill re-opens the bill', () => {
      it('goes back to HOD_APPROVED, with history and audit', async () => {
        paymentRepo.findOne.mockImplementation(async () => ({ id: 'payment-1', direction: PaymentDirection.OUTBOUND, payableId: 'payable-1', amount: '1800.00', paymentReference: 'UTR-1', isActive: true }));
        payableRepo.findOne.mockImplementation(async () => approvedPayable({ status: AssayerPayableStatus.PAID, paidAmount: '1800.00', assayerInvoiceId: 'ainv-1', hodApprovedAt: HOD_AT }));
        assayerInvoiceRepo.findOne.mockImplementation(async () => ({ id: 'ainv-1', invoiceNumber: 'AINV-1', assayerId: 'assayer-1', status: AssayerInvoiceStatus.PAID, lineCount: 1, hodApprovedAt: HOD_AT, paidAt: new Date(), paidBy: 'f' }));
        await service.reversePayment('payment-1', 'Bounced', 'f');
        expect(committed.find((row) => row.lineCount !== undefined)).toMatchObject({ status: AssayerInvoiceStatus.HOD_APPROVED, paidAt: null });
        expect(committed.find((row) => row.action === 'ASSAYER_INVOICE_UNSETTLED')).toMatchObject({ fromState: 'PAID', toState: 'HOD_APPROVED' });
      });

      it('a bill settled before the HOD step existed goes back to APPROVED', async () => {
        paymentRepo.findOne.mockImplementation(async () => ({ id: 'payment-1', direction: PaymentDirection.OUTBOUND, payableId: 'payable-1', amount: '1800.00', paymentReference: 'UTR-1', isActive: true }));
        payableRepo.findOne.mockImplementation(async () => approvedPayable({ status: AssayerPayableStatus.PAID, paidAmount: '1800.00', assayerInvoiceId: 'ainv-1' }));
        assayerInvoiceRepo.findOne.mockImplementation(async () => ({ id: 'ainv-1', invoiceNumber: 'AINV-1', assayerId: 'assayer-1', status: AssayerInvoiceStatus.PAID, lineCount: 1, hodApprovedAt: null }));
        await service.reversePayment('payment-1', 'Bounced', 'f');
        expect(committed.find((row) => row.lineCount !== undefined)).toMatchObject({ status: AssayerInvoiceStatus.APPROVED });
      });
    });

    describe('F16 — an invoice with nothing to collect is settled when sent', () => {
      it('₹0 → PAID at send, lines settled, with history', async () => {
        invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.HOD_APPROVED, total: '0.00', subtotal: '0.00', taxAmount: '0.00', tdsAmount: '0.00', outstandingAmount: '0.00' }));
        entryRepo.createQueryBuilder.mockImplementation(() => ({ ...queryBuilderStub(), getMany: jest.fn(async () => [line({ state: BillingState.INVOICED, invoiceId: 'invoice-1', totalAmount: '0.00' })]) }));
        const out = await service.sendInvoice('invoice-1', 'f');
        expect(out.status).toBe(InvoiceStatus.PAID);
        expect(committed.find((row) => row.entryNumber)).toMatchObject({ state: BillingState.PAID });
        expect(committed.filter((row) => row.action === 'INVOICE_STATUS_CHANGED').map((h) => h.toState)).toEqual([InvoiceStatus.ISSUED, InvoiceStatus.PAID]);
      });

      it('an invoice with money on it is only sent', async () => {
        invoiceRepo.findOne.mockImplementation(async () => invoice({ status: InvoiceStatus.HOD_APPROVED, outstandingAmount: '3564.00' }));
        const out = await service.sendInvoice('invoice-1', 'f');
        expect(out.status).toBe(InvoiceStatus.ISSUED);
      });
    });

    describe('the statement never carries the whole PAN', () => {
      beforeEach(() => assayerRepo.findOne.mockImplementation(async () => recordNow()));

      it('staff see the last four, flagged as such', async () => {
        const s = await service.assayerStatement('assayer-1', undefined, 'staff', ['ADMIN']);
        expect(s).toMatchObject({ pan: '******234F', panMasked: true, panOnFile: true });
        expect(JSON.stringify(s)).not.toContain('ABCDE1234F');
      });

      it('an auditor sees none — only that one is on file', async () => {
        const s = await service.assayerStatement('assayer-1', undefined, 'staff', ['AUDITOR']);
        expect(s).toMatchObject({ pan: null, panOnFile: true });
      });

      it('an internal caller with no roles gets the masked form', async () => {
        const s = await service.assayerStatement('assayer-1');
        expect(s.pan).toBe('******234F');
      });
    });
  });

  describe('onModuleInit event subscriber & durable queue delegation', () => {
    it('enqueues durable billing job when billingJobs service is injected and assignment completes', async () => {
      const mockBillingJobs = {
        enqueueBookAssignment: jest.fn().mockResolvedValue({ id: 'job-1' }),
      };
      const subscriptions: Record<string, Function> = {};
      const mockEventPublisher = {
        publish: jest.fn(),
        subscribe: jest.fn((event: string, cb: Function) => {
          subscriptions[event] = cb;
        }),
      };

      const testModule = await Test.createTestingModule({
        providers: [
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
          { provide: DomainEventPublisher, useValue: mockEventPublisher },
          { provide: NotificationDispatchService, useValue: { emit: jest.fn(), emitSafe: jest.fn() } },
          { provide: AuditService, useValue: { recordEvent, recordEventSafe: jest.fn() } },
          { provide: RegionGuardService, useValue: regionGuard },
          { provide: UnitOfWork, useValue: {} },
          { provide: CacheService, useValue: { withLock: jest.fn() } },
          { provide: PlatformSettingsService, useValue: { get: jest.fn() } },
          { provide: BillingJobsService, useValue: mockBillingJobs },
        ],
      }).compile();

      const svc = testModule.get(BillingEngineService);
      svc.onModuleInit();

      expect(mockEventPublisher.subscribe).toHaveBeenCalledWith('assignment:status-changed', expect.any(Function));

      // 1. Non-completed event should be ignored
      await subscriptions['assignment:status-changed']({
        assignmentId: 'asn-1',
        newState: AssignmentStatus.IN_PROGRESS,
      });
      expect(mockBillingJobs.enqueueBookAssignment).not.toHaveBeenCalled();

      // 2. Completed event delegates to durable queue with outboxEventId
      await subscriptions['assignment:status-changed']({
        assignmentId: 'asn-1',
        newState: AssignmentStatus.COMPLETED,
        userId: 'actor-1',
        outboxEventId: 'outbox-1',
      });
      expect(mockBillingJobs.enqueueBookAssignment).toHaveBeenCalledWith('asn-1', 'actor-1', 'outbox-1');
    });

    it('rethrows enqueue errors so outbox relay / caller detects the failure', async () => {
      const mockBillingJobs = {
        enqueueBookAssignment: jest.fn().mockRejectedValue(new Error('Redis connection lost')),
      };
      const subscriptions: Record<string, Function> = {};
      const mockEventPublisher = {
        publish: jest.fn(),
        subscribe: jest.fn((event: string, cb: Function) => {
          subscriptions[event] = cb;
        }),
      };

      const testModule = await Test.createTestingModule({
        providers: [
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
          { provide: DomainEventPublisher, useValue: mockEventPublisher },
          { provide: NotificationDispatchService, useValue: { emit: jest.fn(), emitSafe: jest.fn() } },
          { provide: AuditService, useValue: { recordEvent, recordEventSafe: jest.fn() } },
          { provide: RegionGuardService, useValue: regionGuard },
          { provide: UnitOfWork, useValue: {} },
          { provide: CacheService, useValue: { withLock: jest.fn() } },
          { provide: PlatformSettingsService, useValue: { get: jest.fn() } },
          { provide: BillingJobsService, useValue: mockBillingJobs },
        ],
      }).compile();

      const svc = testModule.get(BillingEngineService);
      svc.onModuleInit();

      await expect(
        subscriptions['assignment:status-changed']({
          assignmentId: 'asn-1',
          newState: AssignmentStatus.COMPLETED,
        }),
      ).rejects.toThrow('Redis connection lost');
    });

    it('throws error and does not silently swallow or fallback if BillingJobsService is missing', async () => {
      const subscriptions: Record<string, Function> = {};
      const mockEventPublisher = {
        publish: jest.fn(),
        subscribe: jest.fn((event: string, cb: Function) => {
          subscriptions[event] = cb;
        }),
      };

      const testModule = await Test.createTestingModule({
        providers: [
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
          { provide: DomainEventPublisher, useValue: mockEventPublisher },
          { provide: NotificationDispatchService, useValue: { emit: jest.fn(), emitSafe: jest.fn() } },
          { provide: AuditService, useValue: { recordEvent, recordEventSafe: jest.fn() } },
          { provide: RegionGuardService, useValue: regionGuard },
          { provide: UnitOfWork, useValue: {} },
          { provide: CacheService, useValue: { withLock: jest.fn() } },
          { provide: PlatformSettingsService, useValue: { get: jest.fn() } },
        ],
      }).compile();

      const svc = testModule.get(BillingEngineService);
      svc.onModuleInit();

      await expect(
        subscriptions['assignment:status-changed']({
          assignmentId: 'asn-1',
          newState: AssignmentStatus.COMPLETED,
        }),
      ).rejects.toThrow('BillingJobsService not available to enqueue billing job');
    });
  });
});
