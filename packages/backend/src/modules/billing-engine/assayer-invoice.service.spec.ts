import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AssayerInvoiceService } from './assayer-invoice.service';
import { BillingEngineService } from './billing-engine.service';
import { ASSAYER_INVOICE_ELIGIBLE_SQL } from './assayer-invoice-eligibility';
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
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { TypeOrmUnitOfWork } from '../../infrastructure/persistence/typeorm-unit-of-work';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { AssayerInvoiceStatus, AssayerPayableStatus, AssignmentStatus } from '@fapoms/shared';

/**
 * Assayer invoicing: the consent wrapper over payables.
 *
 * Covers the lifecycle (invite → submit → approve, cancel), the guards that freeze invoiced
 * lines elsewhere in the engine (re-price, void), and the statement fork that decides what an
 * ASSAYER may see. Both REAL services are wired over the same doubles — approve's atomicity
 * claim ("the lines are approved in the invoice's own transaction, through the same gate
 * `approvePayouts` uses") is only worth testing against the real `approvePayableInTx`.
 *
 * The DataSource double buffers everything written through a transaction's EntityManager and
 * flushes to `committed` only when the callback resolves, so `committed` answers "what would
 * still be in the database afterwards?" — same technique as billing-engine.service.spec.ts.
 */
describe('AssayerInvoiceService', () => {
  let service: AssayerInvoiceService;
  let engine: BillingEngineService;

  const saved: any[] = [];
  /** Rows that survived a COMMIT. Empty for any transaction whose callback threw. */
  let committed: any[] = [];
  /** Every `manager.update(...)` a transaction issued: which entity, which criteria, what patch. */
  let managerUpdates: Array<{ entity: string; criteria: any; patch: any; committed: boolean }> = [];
  /** WHERE clauses handed to locked query-builder reads, for the eligibility assertions. */
  let qbWheres: string[] = [];
  /** Rows the next locked payable query-builder read returns (keyed per test). */
  let lockedPayableRows: any[] | ((params: any) => any[]) = [];

  let totalsRow: any = { earned: 0, paid: 0, outstanding: 0, awaiting_approval: 0, on_hold: 0, tds_withheld: 0, payable_count: 0 };
  let narrowedTotalsRow: any = { earned: 0, paid: 0, outstanding: 0, awaiting_approval: 0, on_hold: 0, tds_withheld: 0, payable_count: 0 };
  /** Rows behind `SELECT id, invoice_number, status FROM assayer_invoices` (statement labels). */
  let invoiceLabelRows: any[] = [];
  /**
   * The assayer's bills as the reveal query sees them — id, status, submitted_at and the
   * supersession link. Defaults to the label rows (no revision history) when a test sets none.
   */
  let invoiceChainRows: any[] | null = null;
  /** A JS model of `assayerRevealingInvoiceIds`' SQL, so the tests exercise its meaning. */
  const revealingIds = (): Array<{ id: string }> => {
    const rows = invoiceChainRows ?? invoiceLabelRows;
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    const sent = ['SUBMITTED', 'APPROVED', 'HOD_APPROVED', 'PAID'];
    const out = new Set<string>();
    for (const r of rows) {
      if (sent.includes(r.status)) out.add(r.id);
      let ancestor = r.supersedes_invoice_id ? byId.get(r.supersedes_invoice_id) : undefined;
      while (ancestor) {
        if (ancestor.submitted_at) { out.add(r.id); break; }
        ancestor = ancestor.supersedes_invoice_id ? byId.get(ancestor.supersedes_invoice_id) : undefined;
      }
    }
    return [...out].map((id) => ({ id }));
  };
  /** The recompute SUM the engine runs after a detach/re-price. */
  let recomputeRow: any = { n: 0, base: 0, travel: 0, tds: 0, total: 0 };
  /** The bulk round's grouped eligible-assayer query. */
  let eligibleAssayerRows: any[] = [];
  let awaitingCountRow: any = { n: 0 };
  let invitationRow: any = null;

  const defaultManagerQuery = async (sql: string): Promise<any[]> => {
    // Order matters: the narrowed totals SQL also contains the plain-totals markers.
    if (sql.includes('WITH RECURSIVE chain')) return revealingIds();
    if (sql.includes('assayer_invoice_id = ANY($2::uuid[])') && sql.includes('awaiting_approval')) return [narrowedTotalsRow];
    if (sql.includes('FROM assayer_payables') && sql.includes('awaiting_approval')) return [totalsRow];
    if (sql.includes('SELECT id, invoice_number, status FROM assayer_invoices')) return invoiceLabelRows;
    if (sql.includes('GROUP BY p.assayer_id')) return eligibleAssayerRows;
    if (sql.includes('COUNT(*)::int') && sql.includes('AS n') && sql.includes('pre_invoicing_era = false')) return [awaitingCountRow];
    if (sql.includes(`status IN ('INVITED','SUBMITTED')`) && sql.includes('line_count')) return invitationRow ? [invitationRow] : [];
    if (sql.includes('COUNT(*)::int') && sql.includes('assayer_invoice_id = $1')) return [recomputeRow];
    if (sql.includes('display_name FROM assayers')) return [{ id: 'assayer-1', display_name: 'Asha Verma', assayer_code: 'AS-01' }];
    if (sql.includes('SELECT region FROM assayers')) return [{ region: 'NORTH' }];
    if (sql.includes('FROM users')) return [{ display_name: 'Priya Menon' }];
    if (sql.includes('FROM billing_payments') && sql.includes('SUM(amount)')) return [{ paid: 0 }];
    return [];
  };
  const managerQuery: jest.Mock<Promise<any[]>, [string, any[]?]> = jest.fn(defaultManagerQuery);

  const queryBuilderStub = (rowsFor?: () => any[]) => {
    let capturedParams: any = undefined;
    const qb: any = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn((clause: string, params?: any) => { qbWheres.push(clause); capturedParams = params; return qb; }),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn(async () => {
        if (!rowsFor) return [];
        const rows = rowsFor();
        return typeof rows === 'function' ? (rows as any)(capturedParams) : rows;
      }),
      getOne: jest.fn(async () => null),
      getCount: jest.fn(async () => 0),
      getRawAndEntities: jest.fn(async () => ({ entities: [], raw: [] })),
    };
    return qb;
  };

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
    createQueryBuilder: jest.fn(() => queryBuilderStub(() => lockedPayableRows as any)),
    manager: { query: managerQuery },
  };
  const assayerInvoiceRepo: any = {
    create: jest.fn((d) => ({ ...d })),
    save: jest.fn(async (d) => { const r = { id: d.id ?? `ainvoice-${saved.length + 1}`, ...d }; saved.push(r); return r; }),
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
  const assayerRepo: any = {
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => ({
      id: 'assayer-1',
      assayerCode: 'AS0001',
      bankAccountNumber: '1234567890',
      ifscCode: 'HDFC0001234',
      bankName: 'HDFC Bank',
      panNumber: 'ABCDE1234F',
      accountHolderName: 'Assayer One',
    })),
  };
  const assayerDocRepo: any = {
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => ({
      id: 'doc-1',
      requirement: 'BANK_PASSBOOK',
      verificationStatus: 'VERIFIED',
      currentVersionId: 'v-1',
    })),
  };

  const repoForEntity = (target: any): any => {
    if (target === BillingEntryEntity) return entryRepo;
    if (target === BillingInvoiceEntity) return invoiceRepo;
    if (target === BillingPaymentEntity) return paymentRepo;
    if (target === AssayerPayableEntity) return payableRepo;
    if (target === AssayerInvoiceEntity) return assayerInvoiceRepo;
    if (target === BillingHistoryEntity) return historyRepo;
    if (target === AssignmentEntity) return assignmentRepo;
    if (target === ProjectEntity) return projectRepo;
    if (target === AssayerEntity) return assayerRepo;
    if (target === AssayerDocumentEntity) return assayerDocRepo;
    throw new Error(`No repository double registered for ${target?.name ?? target}`);
  };

  /** Which repository a row belongs to, inferred from its shape. Order matters. */
  const repoForRow = (row: any): any => {
    // An assayer invoice carries lineCount/subtotalBase; check BEFORE the invoiceNumber probe,
    // which would otherwise misfile it with the client invoices.
    if (row?.lineCount !== undefined || row?.subtotalBase !== undefined) return assayerInvoiceRepo;
    if (row?.payableNumber !== undefined) return payableRepo;
    if (row?.invoiceNumber !== undefined) return invoiceRepo;
    if (row?.direction !== undefined) return paymentRepo;
    if (row?.action !== undefined && row?.entityType !== undefined) return historyRepo;
    if (row?.entryNumber !== undefined) return entryRepo;
    return historyRepo;
  };

  const entityName = (target: any) => target?.name ?? String(target);

  const makeManager = (pending: any[], stagedOutbox: any[]) => ({
    findOne: jest.fn(async (target: any, opts: any) => repoForEntity(target).findOne(opts)),
    save: jest.fn(async (row: any) => {
      const result = await repoForRow(row).save(row);
      pending.push(result);
      return result;
    }),
    update: jest.fn(async (target: any, criteria: any, patch: any) => {
      const rec = { entity: entityName(target), criteria, patch, committed: false };
      managerUpdates.push(rec);
      pending.push({ __update: rec });
      return { affected: Array.isArray(criteria) ? criteria.length : 1 };
    }),
    createQueryBuilder: jest.fn((target: any, alias: string) => repoForEntity(target).createQueryBuilder(alias)),
    query: jest.fn(async (sql: string, params?: any[]) => managerQuery(sql, params)),
    insert: jest.fn(async (_target: any, rows: any[]) => { stagedOutbox.push(...rows); return { identifiers: rows.map((r) => ({ id: r.id })) }; }),
    count: jest.fn(async (target: any, opts: any) => (repoForEntity(target).count ? repoForEntity(target).count(opts) : 0)),
  });

  const dataSource: any = {
    transaction: jest.fn(async (isolationOrWork: any, maybeWork?: any) => {
      const work = typeof isolationOrWork === 'function' ? isolationOrWork : maybeWork;
      const pending: any[] = [];
      const stagedOutbox: any[] = [];
      const result = await work(makeManager(pending, stagedOutbox));
      for (const row of pending) {
        if (row.__update) row.__update.committed = true;
        else committed.push(row);
      }
      return result;
    }),
  };

  const publish = jest.fn();
  const emitSafe = jest.fn();
  const recordEvent = jest.fn(async () => ({ id: 'audit-1' }));
  const stagedMode = jest.fn(async () => 'log' as 'off' | 'log' | 'enforce');
  const assertRegionAllowedStaged = jest.fn(async () => undefined);
  const assertAssayerInScope = jest.fn(async () => undefined);
  const regionGuard = { stagedMode, assertRegionAllowedStaged, assertAssayerInScope };
  const settingsValues: Record<string, any> = {};
  const settingsGet = jest.fn(async (key: string) => settingsValues[key] ?? null);
  /** Let detached promise chains (the post-commit notifications) run to completion. */
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const outboxRepo: any = { update: jest.fn(async () => undefined) };

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const feeLine = (over: Partial<any> = {}) => ({
    id: 'payable-fee-1', payableNumber: 'PY-FEE-1', assayerId: 'assayer-1', clientId: 'client-1', projectId: 'project-1',
    assignmentId: 'asn-1', expenseId: null, status: AssayerPayableStatus.PENDING, onHold: false, holdReason: null,
    baseAmount: '1700.00', travelAmount: '300.00', taxAmount: '0.00', tdsAmount: '200.00', totalAmount: '1800.00',
    currency: 'INR', paidAmount: '0.00', assayerInvoiceId: null, preInvoicingEra: false, ...over,
  });
  const expenseLine = (over: Partial<any> = {}) => feeLine({
    id: 'payable-exp-1', payableNumber: 'PY-EXP-1', expenseId: 'expense-1',
    baseAmount: '450.00', travelAmount: '0.00', tdsAmount: '0.00', totalAmount: '450.00', ...over,
  });
  const approvedUnpaidLine = (over: Partial<any> = {}) => feeLine({
    id: 'payable-app-1', payableNumber: 'PY-APP-1', status: AssayerPayableStatus.APPROVED,
    baseAmount: '900.00', travelAmount: '100.00', tdsAmount: '100.00', totalAmount: '900.00', ...over,
  });
  const invoice = (over: Partial<any> = {}) => ({
    id: 'ainv-1', invoiceNumber: 'AINV-1', assayerId: 'assayer-1', status: AssayerInvoiceStatus.INVITED,
    invitedAt: new Date('2026-09-01T05:00:00Z'), invitedBy: 'ops-1', submittedAt: null, submittedRequestId: null,
    approvedAt: null, approvedBy: null, cancelledAt: null, cancelledBy: null, cancelReason: null,
    lineCount: 2, subtotalBase: '2150.00', subtotalTravel: '300.00', tdsAmount: '200.00', totalAmount: '2250.00',
    currency: 'INR', notes: null, isActive: true, ...over,
  });

  beforeEach(async () => {
    saved.length = 0;
    committed = [];
    managerUpdates = [];
    qbWheres = [];
    lockedPayableRows = [];
    totalsRow = { earned: 0, paid: 0, outstanding: 0, awaiting_approval: 0, on_hold: 0, tds_withheld: 0, payable_count: 0 };
    narrowedTotalsRow = { earned: 0, paid: 0, outstanding: 0, awaiting_approval: 0, on_hold: 0, tds_withheld: 0, payable_count: 0 };
    invoiceLabelRows = [];
    invoiceChainRows = null;
    recomputeRow = { n: 0, base: 0, travel: 0, tds: 0, total: 0 };
    eligibleAssayerRows = [];
    awaitingCountRow = { n: 0 };
    invitationRow = null;
    for (const k of Object.keys(settingsValues)) delete settingsValues[k];
    jest.clearAllMocks();
    managerQuery.mockImplementation(defaultManagerQuery);
    for (const r of [entryRepo, payableRepo, invoiceRepo, assayerInvoiceRepo, paymentRepo, historyRepo, assignmentRepo, projectRepo, assayerRepo, assayerDocRepo]) {
      r.findOne.mockImplementation(async () => null);
      r.find.mockImplementation(async () => []);
    }
    assayerRepo.findOne.mockImplementation(async () => ({
      id: 'assayer-1',
      assayerCode: 'AS0001',
      bankAccountNumber: '1234567890',
      ifscCode: 'HDFC0001234',
      bankName: 'HDFC Bank',
      panNumber: 'ABCDE1234F',
      accountHolderName: 'Assayer One',
    }));
    assayerDocRepo.findOne.mockImplementation(async () => ({
      id: 'doc-1',
      requirement: 'BANK_PASSBOOK',
      verificationStatus: 'VERIFIED',
      currentVersionId: 'v-1',
    }));
    payableRepo.createQueryBuilder.mockImplementation(() => queryBuilderStub(() => lockedPayableRows as any));
    assayerInvoiceRepo.save.mockImplementation(async (d: any) => { const r = { id: d.id ?? `ainvoice-${saved.length + 1}`, ...d }; saved.push(r); return r; });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: PlatformSettingsService,
          useValue: {
            get: settingsGet,
            getMany: jest.fn(async () => ({})),
            // s.194J threshold 0: the pre-threshold behaviour these tests were written against.
            getNumber: jest.fn(async (k: string, fb?: number) => (k === 'billing.tds194jThresholdRupees' ? 0 : fb as number)),
            describeAll: jest.fn(async () => []),
            onChange: jest.fn(),
          },
        },
        BillingEngineService,
        AssayerInvoiceService,
        { provide: getRepositoryToken(BillingEntryEntity), useValue: entryRepo },
        { provide: getRepositoryToken(BillingInvoiceEntity), useValue: invoiceRepo },
        { provide: getRepositoryToken(BillingPaymentEntity), useValue: paymentRepo },
        { provide: getRepositoryToken(AssayerPayableEntity), useValue: payableRepo },
        { provide: getRepositoryToken(AssayerInvoiceEntity), useValue: assayerInvoiceRepo },
        { provide: getRepositoryToken(BillingHistoryEntity), useValue: historyRepo },
        { provide: getRepositoryToken(AssignmentEntity), useValue: assignmentRepo },
        { provide: getRepositoryToken(ProjectEntity), useValue: projectRepo },
        { provide: getRepositoryToken(AssayerEntity), useValue: assayerRepo },
        { provide: getRepositoryToken(AssayerDocumentEntity), useValue: assayerDocRepo },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: DataSource, useValue: dataSource },
        { provide: DomainEventPublisher, useValue: { publish, subscribe: jest.fn() } },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn(), emitSafe } },
        { provide: AuditService, useValue: { recordEvent, recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }) } },
        { provide: RegionGuardService, useValue: regionGuard },
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
    service = module.get(AssayerInvoiceService);
    engine = module.get(BillingEngineService);
  });

  // ── Eligibility ───────────────────────────────────────────────────────────

  describe('eligibility — one predicate, every exclusion named', () => {
    it('the shared predicate excludes held, voided/paid, already-invoiced and grandfathered rows', () => {
      // The database applies the predicate; the spec pins its SEMANTICS so an edit that drops
      // an exclusion fails here rather than in production billing.
      const sql = ASSAYER_INVOICE_ELIGIBLE_SQL('p');
      expect(sql).toContain(`p.status IN ('PENDING','APPROVED')`); // fee+expense rows, incl. APPROVED-unpaid; excludes PAID and VOIDED
      expect(sql).toContain('p.on_hold = false');                  // held rows wait
      expect(sql).toContain('p.assayer_invoice_id IS NULL');       // one invoice per line at a time
      expect(sql).toContain('p.pre_invoicing_era = false');        // grandfathered history is never re-billed
      expect(sql).toContain('p.is_active = true');
    });

    it('invite locks its line set through that predicate', async () => {
      lockedPayableRows = [feeLine()];
      await service.invite('assayer-1', 'ops-1');
      expect(qbWheres.some((w) => w.includes(ASSAYER_INVOICE_ELIGIBLE_SQL('p')))).toBe(true);
    });

    it('the bulk round and the statement teaser count by the SAME predicate', async () => {
      await service.inviteAll('ops-1');
      const groupedSql = managerQuery.mock.calls.find(([sql]) => sql.includes('GROUP BY p.assayer_id'))?.[0];
      expect(groupedSql).toContain(ASSAYER_INVOICE_ELIGIBLE_SQL('p'));
    });
  });

  // ── Invite ────────────────────────────────────────────────────────────────

  describe('invite — attach the eligible set to one new invoice', () => {
    it('sums fee, expense and APPROVED-unpaid lines into one INVITED invoice, as stored amounts', async () => {
      lockedPayableRows = [feeLine(), expenseLine(), approvedUnpaidLine()];
      const result = await service.invite('assayer-1', 'ops-1');
      const inv = committed.find((r) => r.lineCount !== undefined);
      expect(inv).toMatchObject({
        assayerId: 'assayer-1',
        status: AssayerInvoiceStatus.INVITED,
        invitedBy: 'ops-1',
        lineCount: 3,
        // 1700 + 450 + 900 / 300 + 0 + 100 / 200 + 0 + 100 / 1800 + 450 + 900 — sums of STORED
        // amounts; assignment-money is never consulted.
        subtotalBase: 3050,
        subtotalTravel: 400,
        tdsAmount: 300,
        totalAmount: 3150,
      });
      expect(inv.invoiceNumber).toMatch(/^AINV-/);
      expect(result.invoiceNumber).toMatch(/^AINV-/);
      // The lines were attached in the same transaction.
      const attach = managerUpdates.find((u) => u.entity === 'AssayerPayableEntity' && u.patch.assayerInvoiceId);
      expect(attach).toBeTruthy();
      expect(attach!.criteria).toEqual(['payable-fee-1', 'payable-exp-1', 'payable-app-1']);
      expect(attach!.committed).toBe(true);
    });

    it('writes the history row, the audit row, and announces the change after commit', async () => {
      lockedPayableRows = [feeLine()];
      await service.invite('assayer-1', 'ops-1');
      expect(committed.map((r) => r.action)).toContain('ASSAYER_INVOICE_INVITED');
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ASSAYER_INVOICE_INVITED' }), expect.anything());
      expect(publish).toHaveBeenCalledWith('billing:assayer-invoice-changed', expect.objectContaining({ assayerId: 'assayer-1', status: AssayerInvoiceStatus.INVITED }));
    });

    it('notifies the assayer with a COUNT and no amounts — the reveal happens in-app, not on a lock screen', async () => {
      lockedPayableRows = [feeLine(), expenseLine()];
      await service.invite('assayer-1', 'ops-1');
      await flush();
      const call = emitSafe.mock.calls.find(([o]) => o.type === 'ASSAYER_INVOICE_INVITED')?.[0];
      expect(call).toMatchObject({ assayerId: 'assayer-1', payload: { count: 2 } });
      expect(Object.keys(call.payload)).toEqual(['count']);
    });

    it('refuses with 400 when nothing is eligible, writing nothing', async () => {
      lockedPayableRows = [];
      await expect(service.invite('assayer-1', 'ops-1')).rejects.toThrow(BadRequestException);
      expect(committed).toHaveLength(0);
    });

    it('409s when an active invoice already exists — the partial unique index is the guard', async () => {
      lockedPayableRows = [feeLine()];
      const violation: any = new Error('duplicate');
      violation.code = '23505';
      violation.constraint = 'UQ_assayer_invoices_one_active_per_assayer';
      assayerInvoiceRepo.save.mockImplementation(async () => { throw violation; });
      assayerInvoiceRepo.findOne.mockImplementation(async () => invoice({ status: AssayerInvoiceStatus.SUBMITTED }));
      const err = await service.invite('assayer-1', 'ops-1').then(
        () => { throw new Error('expected a ConflictException'); },
        (e) => e,
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toContain('AINV-1'); // names the standing invoice for the operator
      expect(committed).toHaveLength(0);
    });
  });

  // ── Bulk invite ───────────────────────────────────────────────────────────

  describe('inviteAll — per-assayer outcomes, never failing as a whole', () => {
    it('reports invited / skipped-active-invoice / nothing-eligible per assayer', async () => {
      eligibleAssayerRows = [{ assayer_id: 'assayer-1' }, { assayer_id: 'assayer-2' }, { assayer_id: 'assayer-3' }];
      lockedPayableRows = ((params: any) =>
        params?.assayerId === 'assayer-1' ? [feeLine()] : params?.assayerId === 'assayer-2' ? [feeLine({ id: 'payable-b', assayerId: 'assayer-2' })] : []) as any;
      const violation: any = new Error('duplicate');
      violation.code = '23505';
      violation.constraint = 'UQ_assayer_invoices_one_active_per_assayer';
      // assayer-2's insert loses to a standing active invoice.
      assayerInvoiceRepo.save
        .mockImplementationOnce(async (d: any) => { const r = { id: 'ainvoice-a1', ...d }; saved.push(r); return r; })
        .mockImplementationOnce(async () => { throw violation; });
      const result = await service.inviteAll('ops-1');
      expect(result.outcomes).toEqual([
        expect.objectContaining({ assayerId: 'assayer-1', outcome: 'invited', invoiceId: 'ainvoice-a1' }),
        expect.objectContaining({ assayerId: 'assayer-2', outcome: 'skipped-active-invoice' }),
        expect.objectContaining({ assayerId: 'assayer-3', outcome: 'nothing-eligible' }),
      ]);
      expect(result.invited).toBe(1);
      expect(result.skipped).toBe(2);
    });

    it('narrows the round to the caller’s regions — a region desk invites only who it can see', async () => {
      await service.inviteAll('ops-1', { regions: ['NORTH'] } as any);
      const grouped = managerQuery.mock.calls.find(([sql]) => sql.includes('GROUP BY p.assayer_id'));
      expect(grouped?.[0]).toContain('s.region = ANY($1::text[])');
      expect(grouped?.[1]).toEqual([['NORTH']]);
    });

    it('an unrestricted caller runs the round nationwide (null region filter)', async () => {
      await service.inviteAll('ops-1');
      const grouped = managerQuery.mock.calls.find(([sql]) => sql.includes('GROUP BY p.assayer_id'));
      expect(grouped?.[1]).toEqual([null]);
    });

    /**
     * The round runs on a queue now, with a screen polling it. It is told after every assayer —
     * whatever that assayer's outcome — so a 1,200-assayer round shows movement rather than a
     * spinner that looks identical whether the run is working or wedged.
     */
    it('reports progress after every assayer in the round, an assayer with nothing eligible included', async () => {
      eligibleAssayerRows = [{ assayer_id: 'assayer-1' }, { assayer_id: 'assayer-3' }];
      lockedPayableRows = ((params: any) => (params?.assayerId === 'assayer-1' ? [feeLine()] : [])) as any;
      const onProgress = jest.fn();

      const result = await service.inviteAll('ops-1', undefined, onProgress);

      expect(result.outcomes.map((o) => o.outcome)).toEqual(['invited', 'nothing-eligible']);
      expect(onProgress.mock.calls).toEqual([[1, 2, 'Inviting assayers'], [2, 2, 'Inviting assayers']]);
    });
  });

  // ── Submit ────────────────────────────────────────────────────────────────

  describe('submit — the assayer’s consent, recorded exactly once', () => {
    it('INVITED → SUBMITTED under lock, recording when and by which request', async () => {
      assayerInvoiceRepo.findOne.mockImplementation(async () => invoice());
      const result = await service.submit('assayer-1', 'req-uuid-1');
      expect(result.status).toBe(AssayerInvoiceStatus.SUBMITTED);
      const inv = committed.find((r) => r.lineCount !== undefined);
      expect(inv).toMatchObject({ status: AssayerInvoiceStatus.SUBMITTED, submittedRequestId: 'req-uuid-1' });
      expect(inv.submittedAt).toBeInstanceOf(Date);
      expect(committed.map((r) => r.action)).toContain('ASSAYER_INVOICE_SUBMITTED');
      expect(publish).toHaveBeenCalledWith('billing:assayer-invoice-changed', expect.objectContaining({ status: AssayerInvoiceStatus.SUBMITTED }));
    });

    it('tells ops, with the figures ops may see (name, number, count, total)', async () => {
      assayerInvoiceRepo.findOne.mockImplementation(async () => invoice());
      await service.submit('assayer-1', 'req-uuid-1');
      await flush();
      const call = emitSafe.mock.calls.find(([o]) => o.type === 'ASSAYER_INVOICE_SUBMITTED')?.[0];
      expect(call?.payload).toMatchObject({ assayerName: 'Asha Verma', invoiceNumber: 'AINV-1', count: 2, total: 2250 });
    });

    it('is idempotent: the SAME requestId against a SUBMITTED invoice returns it unchanged — the mobile retry', async () => {
      assayerInvoiceRepo.findOne.mockImplementation(async () =>
        invoice({ status: AssayerInvoiceStatus.SUBMITTED, submittedRequestId: 'req-uuid-1', submittedAt: new Date() }));
      const result = await service.submit('assayer-1', 'req-uuid-1');
      expect(result.status).toBe(AssayerInvoiceStatus.SUBMITTED);
      expect(committed).toHaveLength(0); // no second write, no second history row
      expect(emitSafe).not.toHaveBeenCalled(); // and no second ops ping
    });

    it('409s on a DIFFERENT requestId — two submissions is a conflict, not a shrug', async () => {
      assayerInvoiceRepo.findOne.mockImplementation(async () =>
        invoice({ status: AssayerInvoiceStatus.SUBMITTED, submittedRequestId: 'req-uuid-1' }));
      await expect(service.submit('assayer-1', 'req-uuid-2')).rejects.toThrow(ConflictException);
      expect(committed).toHaveLength(0);
    });

    it('404s when there is nothing to submit', async () => {
      await expect(service.submit('assayer-1', 'req-uuid-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ── Approve ───────────────────────────────────────────────────────────────

  describe('approve — one transaction approves the invoice AND its lines', () => {
    const submitted = (over: Partial<any> = {}) => invoice({
      status: AssayerInvoiceStatus.SUBMITTED, submittedRequestId: 'req-uuid-1', submittedAt: new Date(),
      lineCount: 2, subtotalBase: '2150.00', subtotalTravel: '300.00', tdsAmount: '200.00', totalAmount: '2250.00', ...over,
    });
    const attachedLines = () => [
      feeLine({ assayerInvoiceId: 'ainv-1' }),
      expenseLine({ assayerInvoiceId: 'ainv-1' }),
    ];
    beforeEach(() => {
      // 1700+450 base, 300+0 travel, 200+0 tds, 1800+450 total — matches the stored figures.
      assayerInvoiceRepo.findOne.mockImplementation(async () => submitted());
      payableRepo.findOne.mockImplementation(async (opts: any) => attachedLines().find((l) => l.id === opts?.where?.id) ?? null);
    });

    it('approves every PENDING line through the engine’s gate, in the SAME transaction as the invoice', async () => {
      lockedPayableRows = attachedLines();
      const result = await service.approve('ainv-1', 'finance-1');
      expect(result.status).toBe(AssayerInvoiceStatus.APPROVED);
      expect(dataSource.transaction).toHaveBeenCalledTimes(1); // atomic: no per-line transactions
      const approvedPayables = committed.filter((r) => r.payableNumber && r.status === AssayerPayableStatus.APPROVED);
      expect(approvedPayables.map((p) => p.id).sort()).toEqual(['payable-exp-1', 'payable-fee-1']);
      expect(approvedPayables.every((p) => p.approvedBy === 'finance-1')).toBe(true);
      // The engine's own trail fired for each line — same gate as approvePayouts.
      expect(committed.filter((r) => r.action === 'PAYABLE_STATUS_CHANGED')).toHaveLength(2);
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'PAYABLE_APPROVED' }), expect.anything());
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ASSAYER_INVOICE_APPROVED' }), expect.anything());
      const inv = committed.find((r) => r.lineCount !== undefined);
      expect(inv).toMatchObject({ status: AssayerInvoiceStatus.APPROVED, approvedBy: 'finance-1' });
    });

    it('suppresses the per-payable pushes; the office approval tells the HOD, not yet the assayer', async () => {
      lockedPayableRows = attachedLines();
      await service.approve('ainv-1', 'finance-1');
      await flush();
      await flush();
      expect(emitSafe.mock.calls.some(([o]) => o.type === 'PAYABLE_APPROVED')).toBe(false);
      // The assayer's "approved for payment" waits for the HOD's final approval (2026-09-24).
      expect(emitSafe.mock.calls.some(([o]) => o.type === 'ASSAYER_INVOICE_APPROVED')).toBe(false);
      const call = emitSafe.mock.calls.find(([o]) => o.type === 'BILLING_FINAL_APPROVAL_NEEDED')?.[0];
      expect(call).toMatchObject({ entityType: 'ASSAYER_INVOICE', entityId: 'ainv-1' });
      expect(call.dedupeKey).toMatch(/^BILLING_FINAL_APPROVAL_NEEDED:ASSAYER_INVOICE:ainv-1:\d+$/);
    });

    it('an already-APPROVED line rides through untouched (approved-unpaid at invite time)', async () => {
      const lines = [
        approvedUnpaidLine({ assayerInvoiceId: 'ainv-1' }),
        feeLine({ assayerInvoiceId: 'ainv-1' }),
      ];
      assayerInvoiceRepo.findOne.mockImplementation(async () => submitted({
        subtotalBase: '2600.00', subtotalTravel: '400.00', tdsAmount: '300.00', totalAmount: '2700.00',
      }));
      lockedPayableRows = lines;
      await service.approve('ainv-1', 'finance-1');
      // Only the PENDING line was pushed through the gate; the APPROVED one was not re-approved.
      expect(committed.filter((r) => r.action === 'PAYABLE_STATUS_CHANGED')).toHaveLength(1);
    });

    it('refuses while any line is on hold', async () => {
      lockedPayableRows = [feeLine({ assayerInvoiceId: 'ainv-1', onHold: true, holdReason: 'bank mismatch' }), expenseLine({ assayerInvoiceId: 'ainv-1' })];
      await expect(service.approve('ainv-1', 'finance-1')).rejects.toThrow(/on hold/);
      expect(committed).toHaveLength(0);
    });

    it('409s on drift — the stored totals must equal the lines, to the paisa, or a human looks', async () => {
      lockedPayableRows = [feeLine({ assayerInvoiceId: 'ainv-1', totalAmount: '9999.00' }), expenseLine({ assayerInvoiceId: 'ainv-1' })];
      await expect(service.approve('ainv-1', 'finance-1')).rejects.toThrow(ConflictException);
      expect(committed).toHaveLength(0);
    });

    it('rolls the WHOLE approval back if the invoice save fails after the lines were approved', async () => {
      lockedPayableRows = attachedLines();
      assayerInvoiceRepo.save.mockImplementationOnce(async () => { throw new Error('disk full'); });
      await expect(service.approve('ainv-1', 'finance-1')).rejects.toThrow('disk full');
      expect(saved.some((r) => r.payableNumber && r.status === AssayerPayableStatus.APPROVED)).toBe(true); // written…
      expect(committed).toHaveLength(0); // …but nothing survived
    });

    describe('the tax moved at approval — the bill goes back to the assayer, never approved silently', () => {
      // The fee line was booked with no PAN at 20% (s.206AA): TDS 400, net 1600. The PAN is on file
      // now, so approval re-withholds at 10%: TDS 200, net 1800 — the bill's net moves 2050 → 2250.
      const pristine = () => [
        feeLine({ assayerInvoiceId: 'ainv-1', tdsAmount: '400.00', totalAmount: '1600.00', rateSnapshot: { feeAmount: 2000, tdsRate: 20, tdsPanBasis: 'NO_PAN' } }),
        expenseLine({ assayerInvoiceId: 'ainv-1' }),
      ];
      beforeEach(() => {
        // Fresh copies on every read, so the rolled-back first transaction's in-memory edits do
        // not leak into the second, exactly as a real rollback would not.
        payableRepo.findOne.mockImplementation(async (opts: any) => pristine().find((l) => l.id === opts?.where?.id) ?? null);
        lockedPayableRows = (() => pristine()) as any;
        assayerInvoiceRepo.findOne.mockImplementation(async (opts: any) => (opts?.where?.id === 'ainv-1'
          ? submitted({ tdsAmount: '400.00', totalAmount: '2050.00', revision: 1, confirmedVersion: 1 })
          : null));
      });

      it('refuses with BILL_TAX_RECALCULATED and the owner\'s message, and approves nothing', async () => {
        const err: any = await service.approve('ainv-1', 'finance-1').catch((e) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.message).toContain('The bill amount changed because tax was recalculated — sent back to the assayer to confirm');
        expect(err.getResponse()).toMatchObject({ code: 'BILL_TAX_RECALCULATED' });
        expect(committed.some((r) => r.payableNumber && r.status === AssayerPayableStatus.APPROVED)).toBe(false);
        expect(committed.some((r) => r.status === AssayerInvoiceStatus.APPROVED)).toBe(false);
        expect(committed.some((r) => r.action === 'ASSAYER_INVOICE_APPROVED')).toBe(false);
      });

      it('revises the bill (same mechanism as revise): old SUPERSEDED, a new revision INVITED at the new figure', async () => {
        await service.approve('ainv-1', 'finance-1').catch(() => undefined);
        expect(committed.find((r) => r.id === 'ainv-1')).toMatchObject({ status: AssayerInvoiceStatus.SUPERSEDED });
        const rev = committed.find((r) => r.lineCount !== undefined && r.status === AssayerInvoiceStatus.INVITED);
        expect(rev).toMatchObject({ invoiceNumber: 'AINV-1-R2', revision: 2, supersedesInvoiceId: 'ainv-1', tdsAmount: 200, totalAmount: 2250 });
        // The line took its new TDS (still Due), with its own history row saying why.
        expect(committed.find((r) => r.payableNumber === 'PY-FEE-1')).toMatchObject({ status: AssayerPayableStatus.PENDING, tdsAmount: 200, totalAmount: 1800 });
        expect(committed.find((r) => r.action === 'PAYABLE_TDS_RECOMPUTED')?.reason).toMatch(/s\.206AA/);
        expect(committed.find((r) => r.action === 'ASSAYER_INVOICE_SUPERSEDED')?.reason).toMatch(/tax was recalculated/);
      });

      it('asks the assayer to confirm the new amount (no rupee figure on the push), and does not ping the HOD', async () => {
        await service.approve('ainv-1', 'finance-1').catch(() => undefined);
        await flush();
        const push = emitSafe.mock.calls.find(([o]) => o.type === 'ASSAYER_INVOICE_INVITED')?.[0];
        expect(push).toMatchObject({ assayerId: 'assayer-1', payload: { isRevision: true, revision: 2, reason: 'TAX_RECALCULATED' } });
        expect(JSON.stringify(push.payload)).not.toMatch(/2250|2050/);
        expect(emitSafe.mock.calls.some(([o]) => o.type === 'BILLING_FINAL_APPROVAL_NEEDED')).toBe(false);
      });

      it('approves as normal when the re-decided tax leaves the net where the assayer confirmed it', async () => {
        payableRepo.findOne.mockImplementation(async (opts: any) => attachedLines().find((l) => l.id === opts?.where?.id) ?? null);
        lockedPayableRows = (() => attachedLines()) as any;
        assayerInvoiceRepo.findOne.mockImplementation(async () => submitted());
        const result = await service.approve('ainv-1', 'finance-1');
        expect(result.status).toBe(AssayerInvoiceStatus.APPROVED);
      });
    });

    it('refuses an invoice the assayer has not submitted', async () => {
      assayerInvoiceRepo.findOne.mockImplementation(async () => invoice()); // still INVITED
      await expect(service.approve('ainv-1', 'finance-1')).rejects.toThrow(/not been submitted/);
    });
  });

  // ── Cancel, and the void-detach path ─────────────────────────────────────

  // ── The HOD's final approval of a bill (owner, 2026-09-24) ────────────────
  describe("hodApprove / hodReject — the HOD's final approval of a bill", () => {
    const officeApprovedBill = (over: Partial<any> = {}) => invoice({
      status: AssayerInvoiceStatus.APPROVED, submittedAt: new Date(), submittedRequestId: 'req-uuid-1',
      approvedAt: new Date('2026-09-02T05:00:00Z'), approvedBy: 'office-1', revision: 1, confirmedVersion: 1,
      hodApprovedAt: null, hodApprovedBy: null, ...over,
    });
    const approvedLines = () => [
      feeLine({ assayerInvoiceId: 'ainv-1', status: AssayerPayableStatus.APPROVED, approvedBy: 'office-1', approvedAt: new Date(), destinationIfsc: 'HDFC0001234', destinationBankAccountNumber: '1234567890' }),
      expenseLine({ assayerInvoiceId: 'ainv-1', status: AssayerPayableStatus.APPROVED, approvedBy: 'office-1', approvedAt: new Date() }),
    ];
    beforeEach(() => {
      assayerInvoiceRepo.findOne.mockImplementation(async () => officeApprovedBill());
      payableRepo.findOne.mockImplementation(async (opts: any) => approvedLines().find((l) => l.id === opts?.where?.id) ?? null);
      lockedPayableRows = approvedLines();
    });

    it('APPROVED → HOD_APPROVED, every approved line gets the final approval in the SAME transaction, and the assayer hears', async () => {
      const out = await service.hodApprove('ainv-1', 'hod-1');
      expect(out).toMatchObject({ status: AssayerInvoiceStatus.HOD_APPROVED, hodApprovedBy: 'hod-1' });
      const lines = committed.filter((r) => r.payableNumber);
      expect(lines.map((l) => [l.id, l.hodApprovedBy])).toEqual([['payable-fee-1', 'hod-1'], ['payable-exp-1', 'hod-1']]);
      expect(committed).toContainEqual(expect.objectContaining({ action: 'ASSAYER_INVOICE_HOD_APPROVED', toState: AssayerInvoiceStatus.HOD_APPROVED }));
      expect(committed.filter((r) => r.action === 'PAYABLE_HOD_APPROVED')).toHaveLength(2);
      await flush();
      expect(emitSafe).toHaveBeenCalledWith(expect.objectContaining({
        type: 'ASSAYER_INVOICE_APPROVED', assayerId: 'assayer-1', payload: { count: 2, invoiceNumber: 'AINV-1' },
      }));
    });

    it('refuses the HOD who approved the bill at the office — nothing moves', async () => {
      await expect(service.hodApprove('ainv-1', 'office-1')).rejects.toThrow(/Segregation of duties/);
      expect(committed).toHaveLength(0);
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'SEGREGATION_OF_DUTIES_REFUSED', entityType: 'ASSAYER_INVOICE' }));
    });

    it('refuses a bill the office has not approved; a second press on an HOD-approved bill is a no-op', async () => {
      assayerInvoiceRepo.findOne.mockImplementation(async () => officeApprovedBill({ status: AssayerInvoiceStatus.SUBMITTED }));
      await expect(service.hodApprove('ainv-1', 'hod-1')).rejects.toThrow(/not been approved by the office/);
      assayerInvoiceRepo.findOne.mockImplementation(async () => officeApprovedBill({ status: AssayerInvoiceStatus.HOD_APPROVED }));
      await service.hodApprove('ainv-1', 'hod-1');
      expect(committed).toHaveLength(0);
    });

    it('the office cannot cancel or revise a bill waiting for, or cleared by, the HOD', async () => {
      await expect(service.cancel('ainv-1', 'office-1', 'Wrong month')).rejects.toThrow(ConflictException);
      assayerInvoiceRepo.findOne.mockImplementation(async () => officeApprovedBill({ status: AssayerInvoiceStatus.HOD_APPROVED }));
      await expect(service.cancel('ainv-1', 'office-1', 'Wrong month')).rejects.toThrow(ConflictException);
      await expect(service.reviseInvoice('ainv-1', 'office-1', 'Wrong month')).rejects.toThrow(/approved/);
    });

    it('sends the bill back: → SUBMITTED with the reason, the assayer’s confirmation kept, the lines back to Due, the office told', async () => {
      const out = await service.hodReject('ainv-1', 'hod-1', 'Two of these audits were never completed.');
      expect(out).toMatchObject({
        status: AssayerInvoiceStatus.SUBMITTED, approvedBy: null, approvedAt: null,
        hodRejectedBy: 'hod-1', hodRejectReason: 'Two of these audits were never completed.', confirmedVersion: 1, revision: 1,
      });
      const lines = committed.filter((r) => r.payableNumber);
      expect(lines).toHaveLength(2);
      for (const l of lines) {
        expect(l).toMatchObject({
          status: AssayerPayableStatus.PENDING, approvedBy: null, approvedAt: null, hodApprovedAt: null,
          destinationBankAccountNumber: null, destinationIfsc: null, destinationVerifiedAt: null, destinationVerifiedSource: null,
          assayerInvoiceId: 'ainv-1',
        });
      }
      expect(committed).toContainEqual(expect.objectContaining({ action: 'ASSAYER_INVOICE_HOD_REJECTED', fromState: 'APPROVED', toState: 'SUBMITTED' }));
      await flush(); await flush();
      expect(emitSafe).toHaveBeenCalledWith(expect.objectContaining({
        type: 'BILLING_FINAL_APPROVAL_REJECTED', ownerUserId: 'office-1', payload: expect.objectContaining({ tab: 'bills' }),
      }));
      // The bill can then be approved again by the office, on the assayer's standing confirmation.
      assayerInvoiceRepo.findOne.mockImplementation(async () => ({ ...out, approvedAt: null, approvedBy: null, lineCount: 2, subtotalBase: '2150.00', subtotalTravel: '300.00', tdsAmount: '200.00', totalAmount: '2250.00', revision: 1, confirmedVersion: 1 }));
      payableRepo.findOne.mockImplementation(async (opts: any) => lines.find((l) => l.id === opts?.where?.id) ?? null);
      lockedPayableRows = lines;
      const again = await service.approve('ainv-1', 'office-2');
      expect(again.status).toBe(AssayerInvoiceStatus.APPROVED);
    });

    it('needs a reason, and refuses when money has already moved on the bill', async () => {
      await expect(service.hodReject('ainv-1', 'hod-1', 'short')).rejects.toThrow(BadRequestException);
      lockedPayableRows = [approvedLines()[0], expenseLine({ assayerInvoiceId: 'ainv-1', status: AssayerPayableStatus.PAID, paidAmount: '450.00' })];
      await expect(service.hodReject('ainv-1', 'hod-1', 'Two of these audits were never completed.')).rejects.toThrow(/already paid/);
      expect(committed).toHaveLength(0);
    });

    it('explains the one-open-bill rule instead of failing with a database error', async () => {
      assayerInvoiceRepo.save.mockImplementationOnce(async () => {
        throw Object.assign(new Error('duplicate key value violates unique constraint "UQ_assayer_invoices_one_active_per_assayer"'), {
          code: '23505', constraint: 'UQ_assayer_invoices_one_active_per_assayer',
          driverError: { code: '23505', constraint: 'UQ_assayer_invoices_one_active_per_assayer' },
        });
      });
      await expect(service.hodReject('ainv-1', 'hod-1', 'Two of these audits were never completed.')).rejects.toThrow(/another bill out/);
    });
  });

  describe('cancel — release the lines, keep the record', () => {
    it('cancels a SUBMITTED invoice with a reason and NULLs its lines’ invoice id', async () => {
      assayerInvoiceRepo.findOne.mockImplementation(async () => invoice({ status: AssayerInvoiceStatus.SUBMITTED }));
      const result = await service.cancel('ainv-1', 'ops-1', 'fee dispute — re-invite after correction');
      expect(result.status).toBe(AssayerInvoiceStatus.CANCELLED);
      const release = managerUpdates.find((u) => u.entity === 'AssayerPayableEntity');
      expect(release).toMatchObject({ criteria: { assayerInvoiceId: 'ainv-1' }, patch: expect.objectContaining({ assayerInvoiceId: null }), committed: true });
      const inv = committed.find((r) => r.lineCount !== undefined);
      expect(inv).toMatchObject({ status: AssayerInvoiceStatus.CANCELLED, cancelReason: 'fee dispute — re-invite after correction', cancelledBy: 'ops-1' });
    });

    it('demands a reason', async () => {
      await expect(service.cancel('ainv-1', 'ops-1', '  ')).rejects.toThrow(BadRequestException);
    });

    it('refuses to cancel an APPROVED invoice — those lines are approved payouts now', async () => {
      assayerInvoiceRepo.findOne.mockImplementation(async () => invoice({ status: AssayerInvoiceStatus.APPROVED }));
      await expect(service.cancel('ainv-1', 'ops-1', 'oops')).rejects.toThrow(ConflictException);
    });
  });

  describe('voiding / holding an invoiced line (engine guards)', () => {
    it('voiding the LAST line of an INVITED invoice detaches it and auto-cancels the invoice', async () => {
      payableRepo.findOne.mockImplementation(async () => feeLine({ assayerInvoiceId: 'ainv-1' }));
      assayerInvoiceRepo.findOne.mockImplementation(async () => invoice({ lineCount: 1, subtotalBase: '1700.00', subtotalTravel: '300.00', totalAmount: '1800.00' }));
      recomputeRow = { n: 0, base: 0, travel: 0, tds: 0, total: 0 }; // after the detach, nothing remains
      await engine.voidPayable('payable-fee-1', 'audit reopened', 'ops-1');
      const detach = managerUpdates.find((u) => u.entity === 'AssayerPayableEntity' && u.patch.assayerInvoiceId === null);
      expect(detach).toBeTruthy();
      const inv = committed.find((r) => r.lineCount !== undefined);
      expect(inv).toMatchObject({ status: AssayerInvoiceStatus.CANCELLED, cancelReason: 'all lines removed', lineCount: 0 });
      expect(committed.find((r) => r.payableNumber)).toMatchObject({ status: AssayerPayableStatus.VOIDED });
    });

    it('voiding one of several INVITED lines detaches it and recomputes the invoice’s SUMs', async () => {
      payableRepo.findOne.mockImplementation(async () => feeLine({ assayerInvoiceId: 'ainv-1' }));
      assayerInvoiceRepo.findOne.mockImplementation(async () => invoice());
      recomputeRow = { n: 1, base: 450, travel: 0, tds: 0, total: 450 }; // the expense line remains
      await engine.voidPayable('payable-fee-1', 'audit reopened', 'ops-1');
      const inv = committed.find((r) => r.lineCount !== undefined);
      expect(inv).toMatchObject({ status: AssayerInvoiceStatus.INVITED, lineCount: 1, subtotalBase: 450, totalAmount: 450 });
      expect(committed.map((r) => r.action)).toContain('ASSAYER_INVOICE_RECOMPUTED');
    });

    it('refuses to void a line on a SUBMITTED invoice — cancel the invoice first', async () => {
      payableRepo.findOne.mockImplementation(async () => feeLine({ assayerInvoiceId: 'ainv-1' }));
      assayerInvoiceRepo.findOne.mockImplementation(async () => invoice({ status: AssayerInvoiceStatus.SUBMITTED }));
      await expect(engine.voidPayable('payable-fee-1', 'audit reopened', 'ops-1'))
        .rejects.toThrow(/cancel invoice AINV-1 first/);
      expect(committed).toHaveLength(0);
    });

    it('placing a hold detaches from an INVITED invoice the same way', async () => {
      payableRepo.findOne.mockImplementation(async () => feeLine({ assayerInvoiceId: 'ainv-1' }));
      assayerInvoiceRepo.findOne.mockImplementation(async () => invoice());
      recomputeRow = { n: 1, base: 450, travel: 0, tds: 0, total: 450 };
      await engine.holdPayout('payable-fee-1', true, 'bank mismatch', 'ops-1');
      expect(managerUpdates.some((u) => u.entity === 'AssayerPayableEntity' && u.patch.assayerInvoiceId === null)).toBe(true);
    });

    it('per-payable approve refuses an actively-invoiced line by its invoice number', async () => {
      payableRepo.findOne.mockImplementation(async () => feeLine({ assayerInvoiceId: 'ainv-1' }));
      assayerInvoiceRepo.findOne.mockImplementation(async () => invoice({ status: AssayerInvoiceStatus.SUBMITTED }));
      const result = await engine.approvePayouts(['payable-fee-1'], 'finance-1', undefined, 'Assayer confirmed the amounts by phone');
      expect(result.done).toEqual([]);
      expect(result.refused[0].reason).toContain('awaiting assayer invoice AINV-1');
    });
  });

  // ── Re-price interactions ─────────────────────────────────────────────────

  describe('repriceAssignment — frozen on SUBMITTED, recomputed on INVITED', () => {
    const assignment = () => ({
      id: 'asn-1', assignmentNumber: 'ASN-001', status: AssignmentStatus.COMPLETED,
      projectId: 'project-1', assayerId: 'assayer-1', agreedFee: '2400.00', proposedFee: null,
      quotedTravelFee: '300.00', completionDate: new Date('2026-08-10T10:00:00Z'),
    });
    beforeEach(() => {
      assignmentRepo.findOne.mockImplementation(async () => assignment());
      managerQuery.mockImplementation(async (sql: string, params?: any[]) => {
        if (sql.includes('FROM client_configurations')) return [{ default_base_fee: '3000' }];
        if (sql.includes('FROM client_billing')) return [{ gst_rate: '18', tds_rate: '10', payment_terms: 'NET30' }];
        if (sql.includes('has_pan')) return [{ has_pan: true }];
        return defaultManagerQuery(sql);
      });
    });

    it('leaves a payable on a SUBMITTED invoice untouched and says so', async () => {
      payableRepo.findOne.mockImplementation(async () => feeLine({ assayerInvoiceId: 'ainv-1' }));
      assayerInvoiceRepo.findOne.mockImplementation(async () => invoice({ status: AssayerInvoiceStatus.SUBMITTED }));
      const result = await engine.repriceAssignment('asn-1', 'ops-1');
      expect(result.reason).toContain('AINV-1');
      expect(result.reason).toContain('left untouched');
      // No repriced payable reached the transaction.
      expect(committed.filter((r) => r.payableNumber)).toHaveLength(0);
    });

    it('re-prices a payable on a merely-INVITED invoice and recomputes the invoice in the same tx', async () => {
      payableRepo.findOne.mockImplementation(async () => feeLine({ assayerInvoiceId: 'ainv-1' }));
      assayerInvoiceRepo.findOne.mockImplementation(async () => invoice({ lineCount: 1 }));
      recomputeRow = { n: 1, base: 2100, travel: 300, tds: 240, total: 2160 };
      const result = await engine.repriceAssignment('asn-1', 'ops-1');
      expect(result.repriced).toBe(true);
      expect(committed.filter((r) => r.payableNumber)).toHaveLength(1);
      const inv = committed.find((r) => r.lineCount !== undefined);
      expect(inv).toMatchObject({ lineCount: 1, subtotalBase: 2100, totalAmount: 2160 });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });
  });

  // ── The statement fork ────────────────────────────────────────────────────

  describe('assayerStatement — staff see the book, the assayer sees what they have invoiced', () => {
    const payableRows = () => [
      // Grandfathered: PAID under the old rules, visible with the badge.
      feeLine({ id: 'p-old', payableNumber: 'PY-OLD', status: AssayerPayableStatus.PAID, paidAmount: '1800.00', preInvoicingEra: true }),
      // On an APPROVED invoice: visible.
      feeLine({ id: 'p-inv', payableNumber: 'PY-INV', status: AssayerPayableStatus.APPROVED, assayerInvoiceId: 'ainv-9' }),
      // Eligible but not yet invited: HIDDEN from the assayer.
      feeLine({ id: 'p-new', payableNumber: 'PY-NEW' }),
      // Voided: hidden from the assayer always.
      feeLine({ id: 'p-void', payableNumber: 'PY-VOID', status: AssayerPayableStatus.VOIDED }),
    ];
    const paymentRows = () => [
      { id: 'pay-1', paymentReference: 'NEFT-1', method: 'NEFT', amount: '1800.00', receivedDate: '2026-08-01', runningBalance: '450.00', notes: null, payableId: 'p-old' },
      { id: 'pay-2', paymentReference: 'NEFT-2', method: 'NEFT', amount: '500.00', receivedDate: '2026-08-02', runningBalance: '0.00', notes: null, payableId: 'p-new' },
    ];
    beforeEach(() => {
      payableRepo.find.mockImplementation(async () => payableRows());
      paymentRepo.find.mockImplementation(async () => paymentRows());
      assayerRepo.findOne.mockImplementation(async () => ({ id: 'assayer-1', displayName: 'Asha Verma', assayerCode: 'AS-01', region: 'NORTH', panNumber: 'ABCDE1234F' }));
      invoiceLabelRows = [{ id: 'ainv-9', invoice_number: 'AINV-9', status: 'APPROVED' }];
      settingsValues['billing.assayerInvoicingEnabled'] = true;
    });

    it('staff shape is unchanged — every row, payments with balanceAfter — plus invoice labels per payable', async () => {
      const s = await engine.assayerStatement('assayer-1', undefined, 'staff');
      expect(s.payables).toHaveLength(4);
      expect(s.payables.find((p: any) => p.id === 'p-inv')).toMatchObject({ invoiceNumber: 'AINV-9', invoiceStatus: 'APPROVED' });
      expect(s.payments).toHaveLength(2);
      expect(s.payments[0].balanceAfter).toBe(450);
      expect(s.invoicing).toBeUndefined(); // the counts block is the gated shape's, not staff's
    });

    it('assayer shape: only APPROVED-invoice and grandfathered rows, the latter badged', async () => {
      const s = await engine.assayerStatement('assayer-1', undefined, 'assayer');
      expect(s.payables.map((p: any) => p.id).sort()).toEqual(['p-inv', 'p-old']);
      expect(s.payables.find((p: any) => p.id === 'p-old').preInvoicingEra).toBe(true);
      expect(s.payables.find((p: any) => p.id === 'p-inv').preInvoicingEra).toBe(false);
    });

    /**
     * Owner decision 2026-09-24: "amounts appear in Money as soon as the assayer sends the bill".
     * Sent = SUBMITTED, APPROVED or PAID. INVITED (not yet sent) stays hidden. PAID matters on its
     * own: under the approved-only gate a bill's lines vanished from Money the moment it was paid.
     */
    it.each([
      ['SUBMITTED', true],
      ['APPROVED', true],
      ['PAID', true],
      ['INVITED', false],
      ['CANCELLED', false],
      ['SUPERSEDED', false],
    ])('assayer shape: a line on a %s bill is visible = %s', async (status, visible) => {
      invoiceLabelRows = [{ id: 'ainv-9', invoice_number: 'AINV-9', status }];
      const s = await engine.assayerStatement('assayer-1', undefined, 'assayer');
      expect(s.payables.some((p: any) => p.id === 'p-inv')).toBe(visible);
      // Never the unbilled or the voided line, whatever the bill's state.
      expect(s.payables.map((p: any) => p.id)).not.toContain('p-new');
      expect(s.payables.map((p: any) => p.id)).not.toContain('p-void');
    });

    /**
     * Owner decision 2026-09-24: when the office revises a bill the assayer already SENT, the
     * revision starts unsent (it asks them to check and send again) — but the amounts they already
     * saw stay in Money meanwhile. A bill never sent reveals nothing at any revision.
     */
    it('sent → revised: the line stays visible on the unsent revision', async () => {
      invoiceLabelRows = [{ id: 'ainv-9', invoice_number: 'AINV-9-R2', status: 'INVITED' }];
      invoiceChainRows = [
        { id: 'ainv-1', status: 'SUPERSEDED', submitted_at: '2026-09-20T10:00:00Z', supersedes_invoice_id: null },
        { id: 'ainv-9', status: 'INVITED', submitted_at: null, supersedes_invoice_id: 'ainv-1' },
      ];
      const s = await engine.assayerStatement('assayer-1', undefined, 'assayer');
      expect(s.payables.map((p: any) => p.id)).toContain('p-inv');
      expect(s.payables.map((p: any) => p.id)).not.toContain('p-new');
    });

    it('sent → revised → revised again: still visible through the whole chain', async () => {
      invoiceLabelRows = [{ id: 'ainv-9', invoice_number: 'AINV-9-R3', status: 'INVITED' }];
      invoiceChainRows = [
        { id: 'ainv-1', status: 'SUPERSEDED', submitted_at: '2026-09-20T10:00:00Z', supersedes_invoice_id: null },
        { id: 'ainv-2', status: 'SUPERSEDED', submitted_at: null, supersedes_invoice_id: 'ainv-1' },
        { id: 'ainv-9', status: 'INVITED', submitted_at: null, supersedes_invoice_id: 'ainv-2' },
      ];
      const s = await engine.assayerStatement('assayer-1', undefined, 'assayer');
      expect(s.payables.map((p: any) => p.id)).toContain('p-inv');
    });

    it('never sent → revised: still hidden', async () => {
      invoiceLabelRows = [{ id: 'ainv-9', invoice_number: 'AINV-9-R2', status: 'INVITED' }];
      invoiceChainRows = [
        { id: 'ainv-1', status: 'SUPERSEDED', submitted_at: null, supersedes_invoice_id: null },
        { id: 'ainv-9', status: 'INVITED', submitted_at: null, supersedes_invoice_id: 'ainv-1' },
      ];
      const s = await engine.assayerStatement('assayer-1', undefined, 'assayer');
      expect(s.payables.map((p: any) => p.id)).not.toContain('p-inv');
    });

    it('assayer totals come from the narrowed SUM — same expressions, narrower WHERE', async () => {
      narrowedTotalsRow = { earned: 2700, paid: 1800, outstanding: 900, awaiting_approval: 0, on_hold: 0, tds_withheld: 300, payable_count: 2 };
      const s = await engine.assayerStatement('assayer-1', undefined, 'assayer');
      expect(s.totals).toMatchObject({ earned: 2700, paid: 1800, outstanding: 900, payableCount: 2 });
      const narrowed = managerQuery.mock.calls.find(([sql]) => sql.includes('assayer_invoice_id = ANY($2::uuid[])'));
      expect(narrowed?.[0]).toContain(`p.status <> 'VOIDED'`);
      // The totals read the same revealing-bill set as the rows (a sent bill, or a revision of one).
      expect(narrowed?.[0]).toContain(`(p.pre_invoicing_era = true OR p.assayer_invoice_id = ANY($2::uuid[]))`);
      expect(narrowed?.[1]?.[1]).toEqual(['ainv-9']);
      const reveal = managerQuery.mock.calls.find(([sql]) => sql.includes('WITH RECURSIVE chain'));
      expect(reveal?.[1]?.[1]).toEqual(['SUBMITTED', 'APPROVED', 'HOD_APPROVED', 'PAID']);
      expect(reveal?.[0]).toContain('submitted_at IS NOT NULL');
    });

    it('assayer payments are filtered to visible payables and carry NO balanceAfter', async () => {
      const s = await engine.assayerStatement('assayer-1', undefined, 'assayer');
      expect(s.payments).toHaveLength(1);
      expect(s.payments[0].id).toBe('pay-1');
      expect('balanceAfter' in s.payments[0]).toBe(false); // a running balance over hidden rows would leak their sum
    });

    it('assayer statement carries the counts-only invoicing block — never an amount', async () => {
      awaitingCountRow = { n: 3 };
      invitationRow = { id: 'ainv-live', status: 'INVITED', line_count: 5 };
      const s = await engine.assayerStatement('assayer-1', undefined, 'assayer');
      expect(s.invoicing).toEqual({ awaitingInvoiceCount: 3, invitation: { id: 'ainv-live', status: 'INVITED', lineCount: 5 } });
    });

    it('while the rollout flag is OFF, the assayer audience keeps today’s FULL shape', async () => {
      delete settingsValues['billing.assayerInvoicingEnabled'];
      const s = await engine.assayerStatement('assayer-1', undefined, 'assayer');
      expect(s.payables).toHaveLength(4); // nothing hidden
      expect(s.payments).toHaveLength(2);
      expect(s.payments[0].balanceAfter).toBe(450);
      expect(s.invoicing).toBeUndefined();
    });
  });

  // ── The reveal ────────────────────────────────────────────────────────────

  describe('getInvitationFor — the reveal', () => {
    it('returns null when nothing is active', async () => {
      await expect(service.getInvitationFor('assayer-1')).resolves.toBeNull();
    });

    it('returns the active invoice with labelled lines, and applies the staged region ceiling', async () => {
      assayerInvoiceRepo.findOne.mockImplementation(async () => invoice());
      managerQuery.mockImplementation(async (sql: string, params?: any[]) => {
        if (sql.includes('FROM assayer_payables p') && sql.includes('assayer_invoice_id = $1')) {
          return [
            { id: 'payable-fee-1', payable_number: 'PY-FEE-1', status: 'PENDING', on_hold: false, expense_id: null, assignment_id: 'asn-1', base_amount: '1700.00', travel_amount: '300.00', tds_amount: '200.00', total_amount: '1800.00', assignment_number: 'ASN-001', completion_date: '2026-08-10', branch_name: 'Karol Bagh', expense_category: null },
            { id: 'payable-exp-1', payable_number: 'PY-EXP-1', status: 'PENDING', on_hold: false, expense_id: 'expense-1', assignment_id: 'asn-1', base_amount: '450.00', travel_amount: '0.00', tds_amount: '0.00', total_amount: '450.00', assignment_number: 'ASN-001', completion_date: '2026-08-10', branch_name: 'Karol Bagh', expense_category: 'PARKING' },
          ];
        }
        return defaultManagerQuery(sql);
      });
      const invitation = await service.getInvitationFor('assayer-1', { regions: ['NORTH'] } as any);
      expect(invitation).toMatchObject({ invoiceNumber: 'AINV-1', status: AssayerInvoiceStatus.INVITED, lineCount: 2 });
      expect(invitation!.lines).toEqual([
        expect.objectContaining({ kind: 'FEE', assignmentNumber: 'ASN-001', branchName: 'Karol Bagh', serviceDate: '2026-08-10', baseAmount: 1700, totalAmount: 1800 }),
        expect.objectContaining({ kind: 'EXPENSE', expenseCategory: 'PARKING', totalAmount: 450 }),
      ]);
      expect(assertRegionAllowedStaged).toHaveBeenCalledWith('NORTH', { regions: ['NORTH'] }, 'billing-engine:assayer-invoice-invitation');
    });
  });

  // ── Scenario F: Revision and supersession ───────────────────────────────────

  describe('reviseInvoice — Scenario F: controlled revision & supersession', () => {
    it('marks current invoice SUPERSEDED, links new revision (R2), and re-attaches eligible lines', async () => {
      const inv = invoice({ id: 'ainv-1', invoiceNumber: 'AINV-1', status: AssayerInvoiceStatus.SUBMITTED, revision: 1 });
      assayerInvoiceRepo.findOne.mockImplementation(async (opts: any) => {
        if (opts?.where?.id === 'ainv-1') return inv;
        return null;
      });
      const lines = [feeLine({ assayerInvoiceId: 'ainv-1' }), expenseLine({ assayerInvoiceId: 'ainv-1' })];
      lockedPayableRows = lines;

      const revised = await service.reviseInvoice('ainv-1', 'ops-1', 'Disputed travel amount');

      expect(revised.revision).toBe(2);
      expect(revised.invoiceNumber).toBe('AINV-1-R2');
      expect(revised.status).toBe(AssayerInvoiceStatus.INVITED);
      expect(revised.supersedesInvoiceId).toBe('ainv-1');

      const oldInvUpdate = committed.find((r) => r.id === 'ainv-1');
      expect(oldInvUpdate).toMatchObject({
        status: AssayerInvoiceStatus.SUPERSEDED,
      });

      expect(committed.some((r) => r.action === 'ASSAYER_INVOICE_SUPERSEDED')).toBe(true);
      expect(committed.some((r) => r.action === 'ASSAYER_INVOICE_INVITED')).toBe(true);
    });

    it('refuses to revise an already approved or paid invoice', async () => {
      assayerInvoiceRepo.findOne.mockImplementation(async () =>
        invoice({ id: 'ainv-1', status: AssayerInvoiceStatus.APPROVED }),
      );
      await expect(service.reviseInvoice('ainv-1', 'ops-1', 'some reason')).rejects.toThrow(ConflictException);
    });

    it('refuses to approve an invoice whose current revision has not been confirmed', async () => {
      assayerInvoiceRepo.findOne.mockImplementation(async () =>
        invoice({
          id: 'ainv-2',
          invoiceNumber: 'AINV-1-R2',
          status: AssayerInvoiceStatus.SUBMITTED,
          revision: 2,
          confirmedVersion: 1, // Assayer only confirmed Rev 1, not Rev 2!
        }),
      );
      await expect(service.approve('ainv-2', 'finance-1')).rejects.toThrow(ConflictException);
    });
  });

  // ── The rollout gate ──────────────────────────────────────────────────────

  // ── The 2026-09-24 money audit ──────────────────────────────────────────
  describe('2026-09-24 audit', () => {
    describe('F5 — staff confirming for the assayer is recorded as staff, with a reason', () => {
      it('records the staff member as the actor, and why', async () => {
        assayerInvoiceRepo.findOne.mockImplementation(async () => invoice());
        await service.submit('assayer-1', 'req-uuid-1', { staffId: 'ops-7', reason: 'Assayer confirmed the amounts by phone' });
        const inv = committed.find((r) => r.lineCount !== undefined);
        expect(inv).toMatchObject({ status: AssayerInvoiceStatus.SUBMITTED, updatedBy: 'ops-7' });
        const h = committed.find((r) => r.action === 'ASSAYER_INVOICE_SUBMITTED');
        expect(h.createdBy).toBe('ops-7');
        expect(h.newValue).toMatchObject({ submittedBy: 'STAFF_ON_BEHALF', onBehalfOfAssayerId: 'assayer-1', staffId: 'ops-7' });
        expect(h.reason).toMatch(/by phone/);
        expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ASSAYER_INVOICE_SUBMITTED', userId: 'ops-7' }), expect.anything());
      });

      it("the assayer's own submission is recorded as theirs", async () => {
        assayerInvoiceRepo.findOne.mockImplementation(async () => invoice());
        await service.submit('assayer-1', 'req-uuid-1');
        const h = committed.find((r) => r.action === 'ASSAYER_INVOICE_SUBMITTED');
        expect(h.createdBy).toBe('assayer-1');
        expect(h.newValue).toMatchObject({ submittedBy: 'ASSAYER' });
      });

      it('refuses a staff submission without a real reason, and writes nothing', async () => {
        assayerInvoiceRepo.findOne.mockImplementation(async () => invoice());
        await expect(service.submit('assayer-1', 'req-uuid-1', { staffId: 'ops-7', reason: 'ok' })).rejects.toThrow(BadRequestException);
        expect(committed).toHaveLength(0);
      });
    });

    describe('F10 — a bill whose lines were all paid before approval is settled by it', () => {
      const paidLines = () => [
        feeLine({ assayerInvoiceId: 'ainv-1', status: AssayerPayableStatus.PAID, paidAmount: '1800.00' }),
        expenseLine({ assayerInvoiceId: 'ainv-1', status: AssayerPayableStatus.PAID, paidAmount: '450.00' }),
      ];
      const countByStatus = () => {
        payableRepo.count = jest.fn(async (opts: any) => (opts?.where?.status === AssayerPayableStatus.PAID ? 2 : 0));
      };
      afterEach(() => { delete payableRepo.count; });

      it('office approval → PAID, not "approved" with nothing to pay', async () => {
        const inv = invoice({ status: AssayerInvoiceStatus.SUBMITTED, submittedAt: new Date(), submittedRequestId: 'r', revision: 1, confirmedVersion: 1 });
        assayerInvoiceRepo.findOne.mockImplementation(async () => inv);
        lockedPayableRows = paidLines();
        countByStatus();
        const out = await service.approve('ainv-1', 'finance-1');
        expect(out.status).toBe(AssayerInvoiceStatus.PAID);
        expect(committed.find((r) => r.action === 'ASSAYER_INVOICE_PAID')).toMatchObject({ fromState: AssayerInvoiceStatus.APPROVED });
      });

      it('HOD approval → PAID too', async () => {
        const inv = invoice({ status: AssayerInvoiceStatus.APPROVED, approvedBy: 'office-1', approvedAt: new Date(), revision: 1, confirmedVersion: 1 });
        assayerInvoiceRepo.findOne.mockImplementation(async () => inv);
        lockedPayableRows = paidLines();
        countByStatus();
        const out = await service.hodApprove('ainv-1', 'hod-1');
        expect(out.status).toBe(AssayerInvoiceStatus.PAID);
        expect(committed.find((r) => r.action === 'ASSAYER_INVOICE_PAID')).toMatchObject({ fromState: AssayerInvoiceStatus.HOD_APPROVED });
      });

      it('a bill with money still owed stays approved', async () => {
        const inv = invoice({ status: AssayerInvoiceStatus.SUBMITTED, submittedAt: new Date(), submittedRequestId: 'r', revision: 1, confirmedVersion: 1 });
        assayerInvoiceRepo.findOne.mockImplementation(async () => inv);
        const owed = [feeLine({ assayerInvoiceId: 'ainv-1' }), expenseLine({ assayerInvoiceId: 'ainv-1' })];
        lockedPayableRows = owed;
        payableRepo.findOne.mockImplementation(async (opts: any) => owed.find((l: any) => l.id === opts?.where?.id) ?? null);
        payableRepo.count = jest.fn(async (opts: any) => (opts?.where?.status === AssayerPayableStatus.PAID ? 0 : 2));
        const out = await service.approve('ainv-1', 'finance-1');
        expect(out.status).toBe(AssayerInvoiceStatus.APPROVED);
      });
    });

    describe('F12 — the bills list is region-narrowed on the assayer', () => {
      it('narrows a region-scoped caller to assayers in their regions (and those with none)', async () => {
        await service.list({ status: AssayerInvoiceStatus.SUBMITTED }, { regions: ['WEST'] as any });
        const where = assayerInvoiceRepo.findAndCount.mock.calls[0][0].where;
        expect(where.status).toBe(AssayerInvoiceStatus.SUBMITTED);
        const op = where.assayerId;
        expect(op?.type).toBe('raw');
        const sql = op.getSql('"assayerId"');
        expect(sql).toContain('s.region IS NULL OR s.region = ANY(CAST(:regions AS text[]))');
        expect(op.objectLiteralParameters).toEqual({ regions: ['WEST'] });
      });

      it('keeps an assayer filter inside the ceiling', async () => {
        await service.list({ assayerId: 'assayer-9' }, { regions: ['WEST'] as any });
        const op = assayerInvoiceRepo.findAndCount.mock.calls[0][0].where.assayerId;
        expect(op.getSql('x')).toMatch(/^x = :assayerId AND x IN/);
        expect(op.objectLiteralParameters).toEqual({ assayerId: 'assayer-9', regions: ['WEST'] });
      });

      it('an unrestricted caller sees every bill', async () => {
        await service.list({});
        expect(assayerInvoiceRepo.findAndCount.mock.calls[0][0].where).toEqual({ isActive: true });
      });
    });

    describe('F13 — the revision push carries no rupee figure', () => {
      it('sends count and number, never the total', async () => {
        const inv = invoice({ id: 'ainv-1', status: AssayerInvoiceStatus.SUBMITTED, revision: 1 });
        assayerInvoiceRepo.findOne.mockImplementation(async (opts: any) => (opts?.where?.id === 'ainv-1' ? inv : null));
        lockedPayableRows = [feeLine({ assayerInvoiceId: 'ainv-1' })];
        await service.reviseInvoice('ainv-1', 'ops-1', 'Disputed travel amount');
        await flush();
        const call = emitSafe.mock.calls.find(([o]) => o.dedupeKey?.startsWith('ASSAYER_INVOICE_REVISED'))?.[0];
        expect(call.payload).toMatchObject({ count: 1, isRevision: true });
        expect(call.payload).not.toHaveProperty('total');
        expect(JSON.stringify(call.payload)).not.toMatch(/1800|₹/);
      });
    });
  });

  describe('assertEnabled — the rollout gate', () => {
    it('404s while the flag is off or unreadable', async () => {
      await expect(service.assertEnabled()).rejects.toThrow(NotFoundException);
      settingsGet.mockImplementationOnce(async () => { throw new Error('unknown setting'); });
      await expect(service.assertEnabled()).rejects.toThrow(NotFoundException);
    });

    it('passes when the flag is on', async () => {
      settingsValues['billing.assayerInvoicingEnabled'] = true;
      await expect(service.assertEnabled()).resolves.toBeUndefined();
    });
  });
});
