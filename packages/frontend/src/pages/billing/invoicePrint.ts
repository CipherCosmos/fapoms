import { formatRupees } from '@fapoms/shared';
import type { InvoiceDocument } from '../../services/billing';

/**
 * The printable GST tax invoice.
 *
 * There is deliberately no PDF library here (spec: add no such dependency). Instead this builds a
 * self-contained, A4-styled HTML document and opens it in a new tab; the operator uses the
 * browser's own Print → "Save as PDF", which produces a pixel-perfect A4 invoice with no server
 * round trip and nothing to install. Every figure comes from the invoice document endpoint, which
 * reads the stored totals and only *labels* the tax split — this file changes no money.
 *
 * Seller identity is whatever platform settings hold; a field that has not been set prints as a
 * marked placeholder ("‹set company GSTIN in Settings›") so an unconfigured system yields an
 * obviously-incomplete invoice rather than a plausible one with a blank or wrong identity.
 */

const money = (n: number) => formatRupees(n, { decimals: 2 });

/** Escape text destined for HTML — client names, notes and addresses are data, never markup. */
function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A required seller/identity value, or a clearly-marked placeholder pointing at Settings. */
function orPlaceholder(value: string | null | undefined, whatToSet: string): string {
  if (value && String(value).trim()) return esc(value);
  return `<span class="placeholder">‹set ${esc(whatToSet)} in Settings›</span>`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Address with commas turned into line breaks, escaped. */
function addressBlock(value: string | null, whatToSet: string): string {
  if (!value || !value.trim()) return `<div class="placeholder">‹set ${esc(whatToSet)} in Settings›</div>`;
  return esc(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('<br/>');
}

function buildHtml(doc: InvoiceDocument): string {
  const inter = doc.taxMode === 'INTER';
  const t = doc.totals;

  // Line rows. The tax columns shown depend on the supply type: IGST for inter-state, CGST+SGST
  // for intra-state — the same choice GST law makes, driven by the two parties' state codes.
  const rows = doc.lines
    .map((l) => {
      const taxCols = inter
        ? `<td class="num">${l.taxRate ? `${l.taxRate}%` : '—'}</td><td class="num">${money(l.igst)}</td>`
        : `<td class="num">${l.taxRate ? `${l.taxRate / 2}%` : '—'}</td><td class="num">${money(l.cgst)}</td>` +
          `<td class="num">${l.taxRate ? `${l.taxRate / 2}%` : '—'}</td><td class="num">${money(l.sgst)}</td>`;
      return `<tr>
        <td class="num">${l.srNo}</td>
        <td>${esc(l.description)}${l.branchName ? `<div class="sub">${esc(l.branchName)}</div>` : ''}</td>
        <td>${esc(l.hsnSac)}</td>
        <td>${fmtDate(l.serviceDate)}</td>
        <td class="num">${money(l.taxableAmount)}</td>
        ${taxCols}
        <td class="num">${money(l.total)}</td>
      </tr>`;
    })
    .join('');

  const taxHead = inter
    ? `<th class="num" colspan="2">IGST</th>`
    : `<th class="num" colspan="2">CGST</th><th class="num" colspan="2">SGST</th>`;
  const taxSubHead = inter
    ? `<th class="num">Rate</th><th class="num">Amount</th>`
    : `<th class="num">Rate</th><th class="num">Amount</th><th class="num">Rate</th><th class="num">Amount</th>`;
  const colspanForLabel = inter ? 6 : 8; // sr + desc + hsn + date + taxable + tax cols, up to the total

  const taxTotalsRows = inter
    ? `<tr><td>IGST</td><td class="num">${money(t.igst)}</td></tr>`
    : `<tr><td>CGST</td><td class="num">${money(t.cgst)}</td></tr>
       <tr><td>SGST</td><td class="num">${money(t.sgst)}</td></tr>`;

  const assumedNote = doc.taxSplitAssumed
    ? `<div class="warn">Tax shown as CGST + SGST (same-state) because the ${doc.seller.stateCode ? 'client’s place of supply' : 'company’s'} GST state could not be determined. Set the company GSTIN and the client’s GSTIN to confirm whether this supply is intra-state (CGST + SGST) or inter-state (IGST).</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Tax Invoice ${esc(doc.invoice.number)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; font-size: 12px; margin: 0; background: #f3f4f6; }
  .sheet { background: #fff; max-width: 210mm; margin: 12px auto; padding: 18mm 14mm; }
  .toolbar { max-width: 210mm; margin: 12px auto 0; display: flex; gap: 8px; justify-content: flex-end; }
  .toolbar button { font-size: 13px; padding: 8px 16px; border-radius: 6px; border: 1px solid #cbd5e1; background: #fff; cursor: pointer; }
  .toolbar button.primary { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
  h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: 0.02em; }
  .muted { color: #6b7280; }
  .placeholder { color: #b45309; font-style: italic; background: #fffbeb; padding: 0 3px; border-radius: 3px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; border-bottom: 2px solid #111; padding-bottom: 12px; }
  .title { text-align: right; }
  .parties { display: flex; gap: 16px; margin: 14px 0; }
  .party { flex: 1; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; }
  .party .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; font-weight: 700; margin-bottom: 4px; }
  .party .name { font-weight: 700; font-size: 13px; }
  .kv { font-size: 11px; margin-top: 4px; }
  .kv b { color: #374151; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 24px; font-size: 11px; margin: 6px 0 12px; }
  .meta div b { color: #374151; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; vertical-align: top; }
  thead th { background: #f3f4f6; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.03em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sub { color: #6b7280; font-size: 10.5px; margin-top: 2px; }
  .foot { display: flex; justify-content: space-between; gap: 20px; margin-top: 14px; }
  .words { flex: 1; }
  .words .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; font-weight: 700; }
  .words .value { font-weight: 600; margin-top: 3px; }
  .totals { width: 46%; }
  .totals table td { border: none; border-bottom: 1px solid #eef0f2; padding: 4px 2px; }
  .totals tr.grand td { border-top: 2px solid #111; border-bottom: none; font-weight: 700; font-size: 13px; padding-top: 7px; }
  .totals tr.net td { font-weight: 700; }
  .warn { margin-top: 12px; border: 1px solid #f59e0b; background: #fffbeb; color: #92400e; padding: 8px 10px; border-radius: 6px; font-size: 11px; }
  .terms { margin-top: 16px; font-size: 10.5px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 8px; }
  .sign { margin-top: 26px; text-align: right; font-size: 11px; }
  .sign .line { margin-top: 34px; border-top: 1px solid #9ca3af; display: inline-block; padding-top: 4px; min-width: 200px; }
  @media print { body { background: #fff; } .sheet { margin: 0; padding: 0; max-width: none; } .toolbar { display: none; } }
</style>
</head>
<body>
  <div class="toolbar no-print">
    <button class="primary" onclick="window.print()">Print / Save as PDF</button>
    <button onclick="window.close()">Close</button>
  </div>
  <div class="sheet">
    <div class="head">
      <div>
        <h1>${orPlaceholder(doc.seller.legalName, 'company legal name')}</h1>
        <div class="kv">${addressBlock(doc.seller.address, 'company address')}</div>
        <div class="kv"><b>GSTIN:</b> ${orPlaceholder(doc.seller.gstin, 'company GSTIN')}</div>
        <div class="kv"><b>PAN:</b> ${orPlaceholder(doc.seller.pan, 'company PAN')}${doc.seller.stateName ? ` &nbsp; <b>State:</b> ${esc(doc.seller.stateName)}${doc.seller.stateCode ? ` (${esc(doc.seller.stateCode)})` : ''}` : ''}</div>
      </div>
      <div class="title">
        <h1>TAX INVOICE</h1>
        <div class="kv"><b>No:</b> ${esc(doc.invoice.number)}</div>
        <div class="kv"><b>Date:</b> ${fmtDate(doc.invoice.issueDate)}</div>
        <div class="kv muted">${esc(doc.invoice.status)}</div>
      </div>
    </div>

    <div class="parties">
      <div class="party">
        <div class="label">Bill to</div>
        <div class="name">${orPlaceholder(doc.client.name, 'client name')}</div>
        <div class="kv">${addressBlock(doc.client.address, 'client billing address on the client record')}</div>
        <div class="kv"><b>GSTIN:</b> ${doc.client.gstin ? esc(doc.client.gstin) : '<span class="placeholder">not on file</span>'}</div>
      </div>
      <div class="party">
        <div class="label">Supply</div>
        <div class="kv"><b>Place of supply:</b> ${doc.placeOfSupply ? `${esc(doc.placeOfSupply.name ?? '')}${doc.placeOfSupply.code ? ` (${esc(doc.placeOfSupply.code)})` : ''}` : '<span class="placeholder">unknown — set client GSTIN</span>'}</div>
        <div class="kv"><b>Tax:</b> ${inter ? 'IGST (inter-state)' : 'CGST + SGST (intra-state)'}</div>
        <div class="kv"><b>Due:</b> ${fmtDate(doc.invoice.dueDate)}</div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th class="num" rowspan="2">#</th>
          <th rowspan="2">Description</th>
          <th rowspan="2">HSN/SAC</th>
          <th rowspan="2">Audit date</th>
          <th class="num" rowspan="2">Taxable</th>
          ${taxHead}
          <th class="num" rowspan="2">Total</th>
        </tr>
        <tr>${taxSubHead}</tr>
      </thead>
      <tbody>
        ${rows}
        <tr>
          <td colspan="${colspanForLabel}" class="num" style="font-weight:700">Total</td>
          <td class="num" style="font-weight:700">${money(t.invoiceValue)}</td>
        </tr>
      </tbody>
    </table>

    ${assumedNote}

    <div class="foot">
      <div class="words">
        <div class="label">Amount in words</div>
        <div class="value">${esc(doc.amountInWords)}</div>
      </div>
      <div class="totals">
        <table>
          <tr><td>Taxable value</td><td class="num">${money(t.taxable)}</td></tr>
          ${taxTotalsRows}
          <tr><td>Total tax</td><td class="num">${money(t.tax)}</td></tr>
          <tr class="grand"><td>Invoice value</td><td class="num">${money(t.invoiceValue)}</td></tr>
          ${t.tds > 0 ? `<tr><td class="muted">Less: TDS deducted by client</td><td class="num muted">−${money(t.tds)}</td></tr>
          <tr class="net"><td>Net receivable</td><td class="num">${money(t.netReceivable)}</td></tr>` : ''}
        </table>
      </div>
    </div>

    ${doc.invoice.paymentTerms ? `<div class="terms"><b>Payment terms:</b> ${esc(doc.invoice.paymentTerms)}</div>` : ''}
    ${doc.invoice.notes ? `<div class="terms">${esc(doc.invoice.notes)}</div>` : ''}
    <div class="terms">This is a computer-generated tax invoice. TDS, where shown, is deducted by the recipient at the applicable rate and is not part of the invoice value.</div>

    <div class="sign">
      For ${orPlaceholder(doc.seller.legalName, 'company legal name')}
      <div class="line">Authorised signatory</div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Open the printable invoice in a new tab. Throws when the browser blocks the pop-up, so the
 * caller can tell the operator to allow pop-ups rather than leaving them staring at nothing.
 */
export function openInvoicePrintWindow(doc: InvoiceDocument): void {
  const win = window.open('', '_blank');
  if (!win) {
    throw new Error('Your browser blocked the invoice tab. Allow pop-ups for this site and try again.');
  }
  win.document.open();
  win.document.write(buildHtml(doc));
  win.document.close();
}
