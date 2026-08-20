import React, { useState } from 'react';
import { FileDown, Percent } from 'lucide-react';
import { formatRupees } from '@fapoms/shared';
import { Modal, StyledInput, useToast } from '../../components/ui';
import { billingApi } from '../../services/billing';
import type { TdsReport } from '../../services/billing';
import { userMessage } from '../../services/errors';
import { downloadCsv, datedFilename } from '../../utils/csv';
import { th, td, tdNum } from './shared';

const money = (n: number) => formatRupees(n, { decimals: 2 });

/**
 * TDS substantiation: PAN-wise, who we withheld TDS from over a period, and how much.
 *
 * The figures are the TDS the system already withheld on each payout — this view never recomputes
 * a rupee, it only sums and groups. The section (194C/194J) is a label read from settings and
 * shown so the report reads like the evidence a finance team files. Downloadable as CSV; the
 * amounts are exact to the paisa so it reconciles against the ledger.
 */
export const TdsReportModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { toast } = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<TdsReport | null>(null);

  const run = async () => {
    setLoading(true);
    try {
      const r = await billingApi.getTdsReport({ from: from || undefined, to: to || undefined });
      setReport(r);
      if (r.rows.length === 0) toast('info', 'No TDS was withheld in this period.');
    } catch (e) {
      toast({ type: 'error', title: 'Could not build the report', message: userMessage(e) });
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = () => {
    if (!report) return;
    const period = `${report.from ?? 'start'} to ${report.to ?? 'date'}`;
    const headers = ['Assayer', 'Assayer Code', 'PAN', `Section`, 'Payouts', 'Gross Paid', 'TDS Withheld', 'Net Paid', 'Period'];
    const rows = report.rows.map((r) => [
      r.assayerName ?? '', r.assayerCode ?? '', r.pan ?? 'PAN not on file', report.section,
      r.count, r.gross.toFixed(2), r.tds.toFixed(2), r.net.toFixed(2), period,
    ]);
    // Totals row, so the CSV foots to the same figures shown on screen.
    rows.push(['TOTAL', '', '', report.section, report.totals.count, report.totals.gross.toFixed(2), report.totals.tds.toFixed(2), report.totals.net.toFixed(2), period]);
    downloadCsv(datedFilename('tds_withheld_report'), headers, rows);
  };

  return (
    <Modal open onClose={onClose} title={<><Percent size={18} /> TDS withheld — PAN-wise report</>} width="820px"
      footer={<>
        <span style={{ marginRight: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
          Section {report?.section ?? '194J'} · TDS deducted from field workers. Amounts are what was already withheld — nothing is recomputed here.
        </span>
        <button type="button" onClick={onClose} className="btn btn-secondary">Close</button>
        <button type="button" onClick={exportCsv} disabled={!report || report.rows.length === 0} className="btn btn-primary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <FileDown size={14} /> Download CSV
        </button>
      </>}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          From (booking date)
          <StyledInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 170 }} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          To
          <StyledInput type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 170 }} />
        </label>
        <button onClick={run} disabled={loading} className="btn btn-primary">{loading ? 'Building…' : report ? 'Refresh' : 'Build report'}</button>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Leave both blank for the whole book.</span>
      </div>

      {report && (
        <div style={{ marginTop: 14 }}>
          {report.rows.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)' }}>
              No TDS withheld in this period.
            </div>
          ) : (
            <div style={{ overflowX: 'auto', maxHeight: 380 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>Assayer</th><th style={th}>PAN</th>
                  <th style={{ ...th, textAlign: 'right' }}>Payouts</th>
                  <th style={{ ...th, textAlign: 'right' }}>Gross</th>
                  <th style={{ ...th, textAlign: 'right' }}>TDS withheld</th>
                  <th style={{ ...th, textAlign: 'right' }}>Net</th>
                </tr></thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.assayerId}>
                      <td style={{ ...td, color: 'var(--text-primary)', fontWeight: 600 }}>
                        {r.assayerName ?? r.assayerId}
                        {r.assayerCode && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>{r.assayerCode}</span>}
                      </td>
                      <td style={td}>{r.pan ?? <span style={{ color: 'var(--danger)' }}>Not on file</span>}</td>
                      <td style={tdNum}>{r.count}</td>
                      <td style={tdNum}>{money(r.gross)}</td>
                      <td style={{ ...tdNum, color: 'var(--text-primary)', fontWeight: 600 }}>{money(r.tds)}</td>
                      <td style={tdNum}>{money(r.net)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: 'var(--bg-tertiary)' }}>
                    <td style={{ ...td, fontWeight: 700, color: 'var(--text-primary)' }} colSpan={2}>Total · {report.totals.count} payout{report.totals.count === 1 ? '' : 's'}</td>
                    <td style={tdNum} />
                    <td style={{ ...tdNum, fontWeight: 700 }}>{money(report.totals.gross)}</td>
                    <td style={{ ...tdNum, fontWeight: 700, color: 'var(--text-primary)' }}>{money(report.totals.tds)}</td>
                    <td style={{ ...tdNum, fontWeight: 700 }}>{money(report.totals.net)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};
