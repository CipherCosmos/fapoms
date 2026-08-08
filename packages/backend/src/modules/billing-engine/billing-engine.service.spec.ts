import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, BadRequestException } from '@nestjs/common';
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
import { BillingLevel, BillingState, AssayerPayableStatus, PaymentMethod, PaymentDirection } from '@fapoms/shared';

/**
 * Covers the money math and the guards that decide whether money may move —
 * the parts where a silent error becomes a wrong invoice.
 */
describe('BillingEngineService', () => {
  let service: BillingEngineService;

  const saved: any[] = [];
  // Client contract used by every test: 18% GST, 10% TDS, NET30.
  const managerQuery = jest.fn(async (sql: string) => {
    if (sql.includes('FROM client_billing')) return [{ gst_rate: '18', tds_rate: '10', payment_terms: 'NET30' }];
    if (sql.includes('FROM users')) return [{ display_name: 'Priya Menon' }];
    if (sql.includes('FROM clients WHERE id')) return [{ id: 'client-1' }];
    return [];
  });

  const entryRepo: any = {
    create: jest.fn((d) => ({ ...d })),
    save: jest.fn(async (d) => { const r = { id: d.id ?? `entry-${saved.length + 1}`, ...d }; saved.push(r); return r; }),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn(async () => []), getOne: jest.fn(async () => null),
    })),
    manager: { query: managerQuery },
  };

  const conflictRepo: any = {
    create: jest.fn((d) => d),
    save: jest.fn(async (d) => ({ id: 'conflict-1', ...d })),
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    count: jest.fn(async () => 0),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => null),
    })),
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

  const assignmentRepo: any = {
    create: jest.fn((d) => d), save: jest.fn(async (d) => ({ id: 'x', ...d })),
    find: jest.fn(async () => []), findOne: jest.fn(async () => null),
  };

  const simpleRepo = () => ({
    create: jest.fn((d) => d), save: jest.fn(async (d) => ({ id: 'x', ...d })),
    find: jest.fn(async () => []), findOne: jest.fn(async () => null),
  });

  beforeEach(async () => {
    saved.length = 0;
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingEngineService,
        { provide: getRepositoryToken(BillingEntryEntity), useValue: entryRepo },
        { provide: getRepositoryToken(BillingInvoiceEntity), useValue: simpleRepo() },
            { provide: getRepositoryToken(BillingPaymentEntity), useValue: paymentRepo },
        { provide: getRepositoryToken(AssayerPayableEntity), useValue: payableRepo },
        { provide: getRepositoryToken(BillingConflictEntity), useValue: conflictRepo },
        { provide: getRepositoryToken(BillingHistoryEntity), useValue: simpleRepo() },
        { provide: getRepositoryToken(AssignmentEntity), useValue: assignmentRepo },
        { provide: getRepositoryToken(ProjectEntity), useValue: simpleRepo() },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn(), subscribe: jest.fn() } },
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
        where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
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
      entryRepo.find.mockResolvedValueOnce([
        { id: 'a', clientId: 'client-1', entryNumber: 'BE-A', paidAmount: 0, invoiceId: null },
        { id: 'b', clientId: 'client-2', entryNumber: 'BE-B', paidAmount: 0, invoiceId: null },
      ]);
      await expect(service.mergeEntries(['a', 'b'], 'user-1')).rejects.toThrow(BadRequestException);
    });

    it('refuses to merge entries already invoiced or part-paid', async () => {
      entryRepo.find.mockResolvedValueOnce([
        { id: 'a', clientId: 'client-1', entryNumber: 'BE-A', paidAmount: 0, invoiceId: 'inv-1' },
        { id: 'b', clientId: 'client-1', entryNumber: 'BE-B', paidAmount: 0, invoiceId: null },
      ]);
      await expect(service.mergeEntries(['a', 'b'], 'user-1')).rejects.toThrow(ConflictException);
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
      q.mockImplementation(async (sql: string) => {
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
    });

    it('refuses to pay out more than is owed', async () => {
      payableRepo.findOne.mockResolvedValueOnce({ ...approved });
      await expect(
        service.recordDisbursement(
          { payableId: 'payable-1', paymentReference: 'NEFT-1', method: PaymentMethod.NEFT, amount: 5000 },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
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
  });
});
