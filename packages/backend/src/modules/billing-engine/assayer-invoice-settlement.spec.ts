import { FindOperator } from 'typeorm';
import { BillingEngineService } from './billing-engine.service';
import { AssayerPayableEntity } from './payable.entity';
import { AssayerInvoiceEntity } from './assayer-invoice.entity';
import { AssayerInvoiceStatus, AssayerPayableStatus } from '@fapoms/shared';

/**
 * E15 — when an APPROVED assayer invoice is settled, and what a void does to one.
 *
 *  - "All lines paid" treated a VOIDED line as unpaid, so one voided line kept an invoice
 *    APPROVED ("awaiting payment") for good however much was paid. Settled = PAID or VOIDED.
 *  - An invoice whose lines are ALL voided had nothing paid against it and must not become PAID.
 *  - Voiding a line on an APPROVED invoice left the header's total and line count including it.
 *    The line stays attached (history), the header is re-derived from the live lines, and the
 *    invoice settles if that was the last unpaid line — or is auto-cancelled if nothing is left.
 */
describe('assayer invoice settlement', () => {
  const matches = (cond: any, v: any): boolean => {
    if (cond instanceof FindOperator) {
      const t = (cond as any).type ?? (cond as any)._type;
      const val = (cond as any)._value; // raw: the `value` getter unwraps a nested operator
      if (t === 'not') return !matches(val, v);
      if (t === 'in') return (val as any[]).includes(v);
      throw new Error(`operator ${t} not modelled`);
    }
    return cond === v;
  };
  const where = (row: any, w: any) => Object.entries(w ?? {}).every(([k, c]) => matches(c, row[k]));

  const harness = (lines: Array<{ id: string; status: AssayerPayableStatus; total: number }>, invStatus = AssayerInvoiceStatus.APPROVED) => {
    const inv: any = {
      id: 'inv-1', invoiceNumber: 'AINV-1', assayerId: 'as-1', status: invStatus,
      lineCount: lines.length, totalAmount: lines.reduce((s, l) => s + l.total, 0),
      subtotalBase: 0, subtotalTravel: 0, tdsAmount: 0,
    };
    const payables: any[] = lines.map((l) => ({
      id: l.id, payableNumber: l.id.toUpperCase(), status: l.status, assayerInvoiceId: 'inv-1', isActive: true,
      totalAmount: l.total, paidAmount: l.status === AssayerPayableStatus.PAID ? l.total : 0,
      assignmentId: null, expenseId: 'exp', assayerId: 'as-1',
    }));
    const m: any = {
      findOne: jest.fn(async (entity: any, opts: any) => {
        if (entity === AssayerInvoiceEntity) return where(inv, opts.where) ? inv : null;
        if (entity === AssayerPayableEntity) return payables.find((p) => where(p, opts.where)) ?? null;
        return null;
      }),
      count: jest.fn(async (entity: any, opts: any) =>
        (entity === AssayerPayableEntity ? payables.filter((p) => where(p, opts.where)).length : 0)),
      save: jest.fn(async (e: any) => e),
      update: jest.fn(async () => undefined),
      // The header recompute's SUM — honours the live-line filter only if the SQL carries it.
      query: jest.fn(async (sql: string) => {
        const live = /NOT IN \('VOIDED'\)/.test(sql);
        const rows = payables.filter((p) => p.assayerInvoiceId === 'inv-1' && p.isActive && (!live || p.status !== 'VOIDED'));
        return [{ n: rows.length, base: 0, travel: 0, tds: 0, total: rows.reduce((s, p) => s + p.totalAmount, 0) }];
      }),
    };
    const svc: any = Object.create(BillingEngineService.prototype);
    svc.history = jest.fn(async () => ({}));
    svc.auditService = { recordEvent: jest.fn(async () => ({ id: 'ev' })) };
    svc.uow = { run: jest.fn(async (work: any) => work(m, jest.fn())) };
    return { svc, m, inv, payables, emit: jest.fn() };
  };

  it('a voided line does not hold an otherwise paid invoice open', async () => {
    const { svc, m, inv, emit } = harness([
      { id: 'p1', status: AssayerPayableStatus.PAID, total: 1000 },
      { id: 'p2', status: AssayerPayableStatus.VOIDED, total: 500 },
    ]);
    await svc.settleAssayerInvoiceIfPaid(m, emit, 'inv-1', 'fin-1');
    expect(inv.status).toBe(AssayerInvoiceStatus.PAID);
  });

  it('an invoice with an unpaid live line stays APPROVED', async () => {
    const { svc, m, inv, emit } = harness([
      { id: 'p1', status: AssayerPayableStatus.PAID, total: 1000 },
      { id: 'p2', status: AssayerPayableStatus.APPROVED, total: 500 },
    ]);
    await svc.settleAssayerInvoiceIfPaid(m, emit, 'inv-1', 'fin-1');
    expect(inv.status).toBe(AssayerInvoiceStatus.APPROVED);
  });

  it('an invoice whose lines are all voided never becomes PAID — nothing was paid', async () => {
    const { svc, m, inv, emit } = harness([
      { id: 'p1', status: AssayerPayableStatus.VOIDED, total: 1000 },
      { id: 'p2', status: AssayerPayableStatus.VOIDED, total: 500 },
    ]);
    await svc.settleAssayerInvoiceIfPaid(m, emit, 'inv-1', 'fin-1');
    expect(inv.status).toBe(AssayerInvoiceStatus.APPROVED);
  });

  it('voiding a line on an APPROVED invoice re-derives the header from the live lines', async () => {
    const { svc, inv, payables } = harness([
      { id: 'p1', status: AssayerPayableStatus.APPROVED, total: 1000 },
      { id: 'p2', status: AssayerPayableStatus.APPROVED, total: 500 },
    ]);
    await svc.voidPayable('p2', 'duplicate claim', 'fin-1');
    expect(payables[1]).toMatchObject({ status: AssayerPayableStatus.VOIDED, assayerInvoiceId: 'inv-1' }); // kept as history
    expect(inv.totalAmount).toBe(1000);
    expect(inv.lineCount).toBe(1);
    expect(inv.status).toBe(AssayerInvoiceStatus.APPROVED); // p1 is still owed
  });

  it('voiding the last unpaid line of an APPROVED invoice settles it', async () => {
    const { svc, inv } = harness([
      { id: 'p1', status: AssayerPayableStatus.PAID, total: 1000 },
      { id: 'p2', status: AssayerPayableStatus.APPROVED, total: 500 },
    ]);
    await svc.voidPayable('p2', 'duplicate claim', 'fin-1');
    expect(inv.status).toBe(AssayerInvoiceStatus.PAID);
    expect(inv.totalAmount).toBe(1000);
  });

  it('voiding every line of an APPROVED invoice cancels it rather than marking it PAID', async () => {
    const { svc, inv } = harness([{ id: 'p1', status: AssayerPayableStatus.APPROVED, total: 1000 }]);
    await svc.voidPayable('p1', 'audit reopened', 'fin-1');
    expect(inv.status).toBe(AssayerInvoiceStatus.CANCELLED);
    expect(inv.lineCount).toBe(0);
  });
});
