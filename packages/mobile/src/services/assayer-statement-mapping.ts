import type { AssayerStatement } from '../types/mobile-app';

/**
 * Maps the raw `GET /billing-engine/assayers/:assayerId/statement` response body into the
 * canonical `AssayerStatement` shape (`@fapoms/shared`).
 *
 * Split out of `api.service.ts` into its own file, importing nothing from `react-native`, so it
 * can be unit-tested directly under the mobile package's current jest config (`ts-jest` only, no
 * React Native transform — `api.service.ts` itself cannot even be loaded by jest today because it
 * imports `Platform` from `react-native` at the top of the file). This is also just better shape:
 * response-mapping is pure data transformation and has no business needing a fetch wrapper's
 * dependencies.
 *
 * This exists because the previous inline version of this mapping silently dropped
 * `totals.tdsWithheld`, `tdsSection`, and every payable's `invoiceNumber`/`invoiceStatus` — fields
 * the backend always computes and sends, and that the staff-facing web statement already reads
 * and displays. See `assayer-statement-mapping.spec.ts`'s "every declared field is mapped" test,
 * which exists specifically to catch a regression of that shape: a field present on a realistic
 * raw response but absent from the mapped result.
 */
export function mapAssayerStatementResponse(d: any): AssayerStatement {
  const num = (v: any) => Number(v) || 0;
  return {
    assayerId: d.assayerId,
    assayerName: d.assayerName ?? null,
    assayerCode: d.assayerCode ?? null,
    pan: d.pan ?? null,
    tdsSection: d.tdsSection,
    totals: {
      earned: num(d.totals?.earned),
      paid: num(d.totals?.paid),
      outstanding: num(d.totals?.outstanding),
      awaitingApproval: num(d.totals?.awaitingApproval),
      onHoldOrDisputed: num(d.totals?.onHoldOrDisputed),
      tdsWithheld: num(d.totals?.tdsWithheld),
      payableCount: num(d.totals?.payableCount),
    },
    payables: (d.payables || []).map((p: any) => ({
      id: p.id,
      payableNumber: p.payableNumber,
      status: p.status,
      onHold: !!p.onHold,
      holdReason: p.holdReason ?? null,
      assignmentId: p.assignmentId ?? null,
      expenseId: p.expenseId ?? null,
      baseAmount: num(p.baseAmount),
      travelAmount: num(p.travelAmount),
      tdsAmount: num(p.tdsAmount),
      totalAmount: num(p.totalAmount),
      paidAmount: num(p.paidAmount),
      outstanding: num(p.outstanding),
      createdAt: p.createdAt,
      invoiceNumber: p.invoiceNumber ?? null,
      invoiceStatus: p.invoiceStatus ?? null,
      // Grandfathered rows — visible under the pre-invoicing rules, badged as such.
      preInvoicingEra: p.preInvoicingEra === true,
      // The HOD's final approval (2026-09-24): approved by the office is not yet approved for payment.
      hodApproved: p.hodApproved === true,
    })),
    payments: (d.payments || []).map((pm: any) => ({
      id: pm.id,
      paymentReference: pm.paymentReference,
      method: pm.method,
      amount: num(pm.amount),
      paidDate: pm.paidDate,
      // The gated statement omits balanceAfter entirely (a running balance over rows the reader
      // cannot see would leak the hidden ones' sum); map its absence to null.
      balanceAfter: pm.balanceAfter == null ? null : num(pm.balanceAfter),
      notes: pm.notes,
    })),
    // Present only once billing.assayerInvoicingEnabled is on server-side; its absence is how the
    // earnings screen knows to render the legacy (ungated) world.
    ...(d.invoicing
      ? {
          invoicing: {
            awaitingInvoiceCount: num(d.invoicing.awaitingInvoiceCount),
            invitation: d.invoicing.invitation
              ? {
                  id: d.invoicing.invitation.id,
                  status: d.invoicing.invitation.status,
                  lineCount: num(d.invoicing.invitation.lineCount),
                }
              : null,
          },
        }
      : {}),
  };
}
