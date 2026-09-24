import { mapAssayerStatementResponse } from './assayer-statement-mapping';

/**
 * A realistic raw statement response, shaped like `billing-engine.service.ts`'s
 * `assayerStatement()` actually returns it (ungated/staff shape) — every field it sends,
 * with a distinct non-default, non-falsy value where the field's type allows one, specifically
 * so a field that gets silently dropped by the mapping shows up as a real assertion failure
 * rather than two zeros/nulls comparing equal by coincidence.
 */
const RAW_RESPONSE = {
  assayerId: 'assayer-1',
  assayerName: 'Test Assayer',
  assayerCode: 'AS0099',
  pan: 'ABCDE1234F',
  tdsSection: '194J',
  totals: {
    earned: 10000,
    paid: 4000,
    outstanding: 6000,
    awaitingApproval: 1000,
    onHoldOrDisputed: 500,
    tdsWithheld: 786,
    payableCount: 3,
  },
  payables: [
    {
      id: 'p1',
      payableNumber: 'PB-001',
      status: 'PENDING',
      onHold: true,
      holdReason: 'Awaiting bank details',
      assignmentId: 'a1',
      expenseId: null,
      baseAmount: 1000,
      travelAmount: 200,
      tdsAmount: 100,
      totalAmount: 1100,
      paidAmount: 0,
      outstanding: 1100,
      createdAt: '2026-09-01T00:00:00.000Z',
      invoiceNumber: 'INV-2026-0007',
      invoiceStatus: 'APPROVED',
      preInvoicingEra: true,
      hodApproved: true,
    },
  ],
  payments: [
    {
      id: 'pm1',
      paymentReference: 'REF-1',
      method: 'NEFT',
      amount: 500,
      paidDate: '2026-09-05T00:00:00.000Z',
      balanceAfter: 1200,
      notes: 'Partial settlement',
    },
  ],
  invoicing: {
    awaitingInvoiceCount: 2,
    invitation: { id: 'inv-1', status: 'SUBMITTED', lineCount: 4 },
  },
};

const mapStatementWithout = (key: string) => mapAssayerStatementResponse({
  ...RAW_RESPONSE,
  payables: RAW_RESPONSE.payables.map((p: Record<string, unknown>) => {
    const { [key]: _omit, ...rest } = p;
    return rest;
  }),
});

describe('mapAssayerStatementResponse', () => {
  it('maps every field the shared AssayerStatement type declares — none silently dropped', () => {
    const mapped = mapAssayerStatementResponse(RAW_RESPONSE);

    // Top-level identity/PAN/TDS-section fields.
    expect(mapped.assayerId).toBe('assayer-1');
    expect(mapped.assayerName).toBe('Test Assayer');
    expect(mapped.assayerCode).toBe('AS0099');
    expect(mapped.pan).toBe('ABCDE1234F');
    expect(mapped.tdsSection).toBe('194J');

    // The confirmed bug: tdsWithheld used to be silently absent from the mapped totals.
    expect(mapped.totals).toEqual(RAW_RESPONSE.totals);

    // The confirmed bug: invoiceNumber/invoiceStatus used to be silently absent from every row.
    expect(mapped.payables[0]).toMatchObject({
      invoiceNumber: 'INV-2026-0007',
      invoiceStatus: 'APPROVED',
      preInvoicingEra: true,
      // The HOD's final approval (2026-09-24): "approved for payment" versus "awaiting final approval".
      hodApproved: true,
    });

    expect(mapped.payments[0]).toMatchObject({
      paymentReference: 'REF-1',
      balanceAfter: 1200,
      notes: 'Partial settlement',
    });

    expect(mapped.invoicing).toEqual({
      awaitingInvoiceCount: 2,
      invitation: { id: 'inv-1', status: 'SUBMITTED', lineCount: 4 },
    });
  });

  it('nulls out optional fields cleanly rather than leaving them undefined', () => {
    const mapped = mapAssayerStatementResponse({
      ...RAW_RESPONSE,
      assayerName: undefined,
      assayerCode: undefined,
      pan: undefined,
      payables: [{ ...RAW_RESPONSE.payables[0], invoiceNumber: undefined, invoiceStatus: undefined }],
      invoicing: undefined,
    });

    expect(mapped.assayerName).toBeNull();
    expect(mapped.assayerCode).toBeNull();
    expect(mapped.pan).toBeNull();
    expect(mapped.payables[0].invoiceNumber).toBeNull();
    expect(mapped.payables[0].invoiceStatus).toBeNull();
    expect(mapped.invoicing).toBeUndefined();
    // A server from before the HOD step sends no flag: it reads as not yet approved for payment.
    expect(mapStatementWithout('hodApproved').payables[0].hodApproved).toBe(false);
  });

  it('omits balanceAfter and invoicing on the gated (assayer-audience) shape without throwing', () => {
    const gated = {
      ...RAW_RESPONSE,
      payments: [{ ...RAW_RESPONSE.payments[0], balanceAfter: undefined }],
      invoicing: undefined,
    };
    delete (gated.payments[0] as any).balanceAfter;

    const mapped = mapAssayerStatementResponse(gated);

    expect(mapped.payments[0].balanceAfter).toBeNull();
    expect(mapped.invoicing).toBeUndefined();
  });
});
