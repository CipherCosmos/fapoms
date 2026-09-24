import { InvoiceStatus } from '@fapoms/shared';
import { buildInvoiceHtml, canPrintTaxInvoice, openInvoicePrintWindow, taxInvoicePrintBlockedReason } from './invoicePrint';
import type { InvoiceDocument } from '../../services/billing';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));

/**
 * Audit E1 (2026-09-24): the printed document is headed TAX INVOICE, so it may only be printed for
 * an invoice that IS one — sent to the client, or paid. And the status on it is said in words,
 * not as the enum's spelling.
 */
const doc = (status: InvoiceStatus): InvoiceDocument => ({
  invoice: { number: 'INV-2026-0001', status, issueDate: '2026-09-01', dueDate: '2026-09-30', currency: 'INR', notes: null, paymentTerms: null },
  seller: { legalName: 'Seller Ltd', address: null, gstin: null, pan: null, stateName: null, stateCode: null },
  client: { name: 'Acme', address: null, gstin: null, stateName: null, stateCode: null },
  placeOfSupply: null,
  taxMode: 'INTRA',
  taxSplitAssumed: false,
  defaultSac: '998399',
  lines: [],
  totals: { taxable: 1000, cgst: 90, sgst: 90, igst: 0, tax: 180, invoiceValue: 1180, tds: 0, netReceivable: 1180 },
  amountInWords: 'One thousand one hundred eighty rupees only',
});

describe('invoicePrint — only a sent or paid invoice prints as a tax invoice', () => {
  it('prints ISSUED and PAID, nothing else', () => {
    expect(canPrintTaxInvoice(InvoiceStatus.ISSUED)).toBe(true);
    expect(canPrintTaxInvoice(InvoiceStatus.PAID)).toBe(true);
    for (const s of [InvoiceStatus.DRAFT, InvoiceStatus.AWAITING_HOD, InvoiceStatus.HOD_APPROVED, InvoiceStatus.CANCELLED]) {
      expect(canPrintTaxInvoice(s)).toBe(false);
      expect(taxInvoicePrintBlockedReason(s)).toBeTruthy();
    }
    expect(taxInvoicePrintBlockedReason(InvoiceStatus.ISSUED)).toBeNull();
  });

  it('refuses to open the print window for a draft (the backstop behind the disabled button)', () => {
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    expect(() => openInvoicePrintWindow(doc(InvoiceStatus.DRAFT))).toThrow(/not a tax invoice/);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('prints the status in words, not the raw enum', () => {
    const html = buildInvoiceHtml(doc(InvoiceStatus.ISSUED));
    expect(html).not.toMatch(/>ISSUED</);
    expect(html).toMatch(/<div class="kv muted">[^<]*[a-z][^<]*<\/div>/);
  });
});
