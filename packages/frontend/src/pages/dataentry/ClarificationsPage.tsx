import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, AlertTriangle, User, ArrowRight } from 'lucide-react';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';

/**
 * The clarification worklist.
 *
 * The board only ever showed an aggregate "N open" count and per-branch chips, and an OPEN
 * query (waiting on the assayer) looked identical to a RESPONDED one (the assayer answered, our
 * move). So no one could see, across every case, which clarifications need the desk's attention
 * versus which are waiting on the field — the exact half of the loop that decides how long a
 * case sits open. This splits them, surfaces the SLA every query already carries but nothing
 * showed, and drills into the case's thread.
 */

interface ClarificationRow {
  id: string;
  validationCaseId: string;
  projectBranchId: string | null;
  status: string;
  queryText: string;
  targetField: string | null;
  branchName: string | null;
  assayerName: string | null;
  assayerCode: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  slaDueDate: string | null;
  slaOverdue: boolean;
  awaiting: 'US' | 'ASSAYER' | 'DONE';
}

type Filter = 'US' | 'ASSAYER' | 'OVERDUE' | 'DONE';

const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

const slaLabel = (row: ClarificationRow): { text: string; tone: string } => {
  if (row.status === 'RESOLVED') return { text: 'resolved', tone: 'var(--text-muted)' };
  if (!row.slaDueDate) return { text: 'no SLA', tone: 'var(--text-muted)' };
  const ms = new Date(row.slaDueDate).getTime() - Date.now();
  const hrs = Math.round(ms / 3_600_000);
  if (ms < 0) return { text: `${Math.abs(hrs)}h overdue`, tone: 'var(--danger)' };
  return { text: `${hrs}h left`, tone: hrs <= 2 ? 'var(--warning)' : 'var(--text-muted)' };
};

export const ClarificationsPage: React.FC = () => {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ClarificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('US');

  useEffect(() => {
    let cancelled = false;
    api.request<ClarificationRow[]>('/validation-queries/worklist')
      .then((r) => { if (!cancelled) setRows(r); })
      .catch((e) => { if (!cancelled) setError(`Could not load the clarification list. ${userMessage(e)}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const counts = useMemo(() => ({
    US: rows.filter((r) => r.awaiting === 'US').length,
    ASSAYER: rows.filter((r) => r.awaiting === 'ASSAYER').length,
    OVERDUE: rows.filter((r) => r.slaOverdue).length,
    DONE: rows.filter((r) => r.awaiting === 'DONE').length,
  }), [rows]);

  const shown = useMemo(() => {
    if (filter === 'OVERDUE') return rows.filter((r) => r.slaOverdue);
    return rows.filter((r) => r.awaiting === filter);
  }, [rows, filter]);

  if (loading) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading clarifications…</div>;
  if (error) return <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>;

  const TABS: { key: Filter; label: string; tone?: string }[] = [
    { key: 'US', label: 'Awaiting us', tone: 'var(--warning)' },
    { key: 'ASSAYER', label: 'Awaiting assayer' },
    { key: 'OVERDUE', label: 'Overdue', tone: 'var(--danger)' },
    { key: 'DONE', label: 'Resolved' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {TABS.map((t) => {
          const active = filter === t.key;
          const n = counts[t.key];
          return (
            <button key={t.key} onClick={() => setFilter(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderRadius: 10, cursor: 'pointer',
                background: active ? 'var(--bg-card)' : 'transparent',
                border: `1px solid ${active ? (t.tone ?? 'var(--accent)') : 'var(--border-color)'}`,
              }}>
              <span style={{ fontSize: 20, fontWeight: 700, color: n > 0 ? (t.tone ?? 'var(--text-primary)') : 'var(--text-muted)' }}>{n}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{t.label}</span>
            </button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <div style={{ ...card, color: 'var(--text-muted)', fontSize: 13 }}>
          {filter === 'US'
            ? 'Nothing is waiting on you. When an assayer answers a clarification, it moves here so the desk can act on it.'
            : filter === 'ASSAYER'
              ? 'Nothing is waiting on an assayer. Data-entry staff raise a clarification when something on a submitted report is not clear, and it sits here until the assayer replies.'
              : filter === 'OVERDUE'
                ? 'Nothing is past its reply deadline. A clarification shows up here when it has not been answered in the agreed time.'
                : 'No clarification has been closed yet. Once a question is answered and accepted, it is kept here as a record.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map((r) => {
            const sla = slaLabel(r);
            return (
              <button key={r.id} onClick={() => navigate(r.projectBranchId ? `/data-entry/case/${r.projectBranchId}` : '/data-entry')}
                style={{ ...card, textAlign: 'left', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'flex-start', borderLeft: `3px solid ${r.slaOverdue ? 'var(--danger)' : r.awaiting === 'US' ? 'var(--warning)' : 'var(--border-color)'}` }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                    <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{r.branchName ?? 'Unknown branch'}</strong>
                    {r.targetField && <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 999, background: 'var(--bg-surface-2)', color: 'var(--text-muted)' }}>Field: {r.targetField}</span>}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--text-muted)' }}>
                      <User size={11} /> {r.assayerName ?? '—'}{r.assayerCode ? ` · ${r.assayerCode}` : ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.queryText}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    raised {fmtWhen(r.createdAt)}{r.lastMessageAt ? ` · last message ${fmtWhen(r.lastMessageAt)}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: sla.tone }}>
                    {r.slaOverdue ? <AlertTriangle size={11} /> : <Clock size={11} />} {sla.text}
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--accent)' }}>
                    Open case <ArrowRight size={12} />
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md, 10px)', padding: 14,
};
