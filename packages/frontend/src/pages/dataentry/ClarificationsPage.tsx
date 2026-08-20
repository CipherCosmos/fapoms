import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, AlertTriangle, User, ArrowRight, ChevronDown, ChevronRight, Phone } from 'lucide-react';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { counted } from '../../utils/plural';

/**
 * The clarification worklist.
 *
 * The board only ever showed an aggregate "N open" count and per-branch chips, and an OPEN
 * query (waiting on the assayer) looked identical to a RESPONDED one (the assayer answered, our
 * move). So no one could see, across every case, which clarifications need the desk's attention
 * versus which are waiting on the field — the exact half of the loop that decides how long a
 * case sits open. This splits them, surfaces the SLA every query already carries but nothing
 * showed, and drills into the case's thread.
 *
 * It reads two ways. "By status" is the deadline-ordered list above. "By auditor" gathers every
 * open question under the auditor it is with — "Ravi — 4 open questions" — so the desk can phone
 * one person and clear all of them in a single call instead of hunting the list for their name.
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
type View = 'status' | 'auditor';

const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

const slaLabel = (row: ClarificationRow): { text: string; tone: string } => {
  if (row.status === 'RESOLVED') return { text: 'resolved', tone: 'var(--text-muted)' };
  // "no SLA" is the acronym for the reply deadline the office agreed with the field. Nothing
  // outside the code calls it that.
  if (!row.slaDueDate) return { text: 'no reply deadline', tone: 'var(--text-muted)' };
  const ms = new Date(row.slaDueDate).getTime() - Date.now();
  const hrs = Math.round(ms / 3_600_000);
  if (ms < 0) return { text: `${counted(Math.abs(hrs), 'hour')} overdue`, tone: 'var(--danger)' };
  return { text: `${counted(hrs, 'hour')} left to reply`, tone: hrs <= 2 ? 'var(--warning)' : 'var(--text-muted)' };
};

/** The whole worklist's shape, computed in SQL. The tabs read these, never the loaded rows. */
interface WorklistCounts { US: number; ASSAYER: number; OVERDUE: number; DONE: number; total: number }
interface WorklistResponse { items: ClarificationRow[]; counts: WorklistCounts }

/** One auditor's open questions, gathered for a single phone call. */
interface AuditorGroup {
  assayerId: string | null;
  assayerName: string | null;
  assayerCode: string | null;
  openCount: number;
  overdueCount: number;
  oldestCreatedAt: string | null;
  items: ClarificationRow[];
}
interface ByAssayerResponse { groups: AuditorGroup[]; total: number }

/** One clarification, drawn the same way in both the flat list and inside an auditor's group. */
const ClarificationCard: React.FC<{ row: ClarificationRow; onOpen: () => void }> = ({ row, onOpen }) => {
  const sla = slaLabel(row);
  return (
    <button onClick={onOpen}
      style={{ ...card, textAlign: 'left', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'flex-start', borderLeft: `3px solid ${row.slaOverdue ? 'var(--danger)' : row.awaiting === 'US' ? 'var(--warning)' : 'var(--border-color)'}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
          <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{row.branchName ?? 'Unknown branch'}</strong>
          {row.targetField && <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 999, background: 'var(--bg-surface-2)', color: 'var(--text-muted)' }}>About: {row.targetField}</span>}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--text-muted)' }}>
            <User size={11} /> {row.assayerName ?? '—'}{row.assayerCode ? ` · ${row.assayerCode}` : ''}
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.queryText}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          Asked {fmtWhen(row.createdAt)}{row.lastMessageAt ? ` · last message ${fmtWhen(row.lastMessageAt)}` : ''}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: sla.tone }}>
          {row.slaOverdue ? <AlertTriangle size={11} /> : <Clock size={11} />} {sla.text}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--accent)' }}>
          Open case <ArrowRight size={12} />
        </span>
      </div>
    </button>
  );
};

export const ClarificationsPage: React.FC = () => {
  const navigate = useNavigate();
  const [view, setView] = useState<View>('status');
  const [rows, setRows] = useState<ClarificationRow[]>([]);
  const [counts, setCounts] = useState<WorklistCounts>({ US: 0, ASSAYER: 0, OVERDUE: 0, DONE: 0, total: 0 });
  const [groups, setGroups] = useState<AuditorGroup[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('US');

  const openCase = (row: ClarificationRow) =>
    navigate(row.projectBranchId ? `/data-entry/case/${row.projectBranchId}` : '/data-entry');

  /**
   * One tab's worth of rows (or, by auditor, the whole open list grouped) plus the counts for the
   * tabs. This used to fetch every clarification ever raised — resolved ones included, forever —
   * and filter and count them in the browser. `validation_queries` is append-only, so that
   * request grew without limit for a page that shows one slice at a time.
   */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url = view === 'auditor'
      ? '/validation-queries/worklist/by-assayer'
      : `/validation-queries/worklist?filter=${filter}`;
    api.request<WorklistResponse | ByAssayerResponse>(url)
      .then((r) => {
        if (cancelled) return;
        if (view === 'auditor') {
          setGroups((r as ByAssayerResponse).groups ?? []);
        } else {
          const wr = r as WorklistResponse;
          setRows(wr.items ?? []);
          setCounts(wr.counts ?? { US: 0, ASSAYER: 0, OVERDUE: 0, DONE: 0, total: 0 });
        }
      })
      .catch((e) => { if (!cancelled) setError(`Could not load the clarification list. ${userMessage(e)}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [view, filter]);

  const shown = rows;
  /** True when the server had more for this tab than it sent — say so rather than imply a total. */
  const truncated = counts[filter] > shown.length;

  const TABS: { key: Filter; label: string; tone?: string }[] = [
    { key: 'US', label: 'Awaiting us', tone: 'var(--warning)' },
    { key: 'ASSAYER', label: 'Awaiting assayer' },
    { key: 'OVERDUE', label: 'Overdue', tone: 'var(--danger)' },
    { key: 'DONE', label: 'Resolved' },
  ];

  const VIEWS: { key: View; label: string }[] = [
    { key: 'status', label: 'By status' },
    { key: 'auditor', label: 'By auditor' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* How to slice the list: by whose move it is, or by the person to call. */}
      <div style={{ display: 'flex', gap: 6 }}>
        {VIEWS.map((v) => {
          const active = view === v.key;
          return (
            <button key={v.key} onClick={() => setView(v.key)}
              style={{
                padding: '6px 14px', borderRadius: 999, cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
                background: active ? 'var(--accent)' : 'transparent',
                color: active ? '#fff' : 'var(--text-secondary)',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border-color)'}`,
              }}>
              {v.label}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading clarifications…</div>
      ) : error ? (
        <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>
      ) : view === 'status' ? (
        <>
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
              {truncated && (
                <div style={{ fontSize: 11.5, color: 'var(--warning)', lineHeight: 1.45 }}>
                  Showing the {shown.length} most urgent of {counted(counts[filter], 'question')}. Clear these and the rest move up —
                  they are ordered by reply deadline, soonest first.
                </div>
              )}
              {shown.map((r) => (
                <ClarificationCard key={r.id} row={r} onOpen={() => openCase(r)} />
              ))}
            </div>
          )}
        </>
      ) : (
        /* By auditor: one row per person, expand to see and clear their open questions together. */
        groups.length === 0 ? (
          <div style={{ ...card, color: 'var(--text-muted)', fontSize: 13 }}>
            No auditor has open clarifications right now. When the desk raises a question, or an assayer's reply is still
            being worked, the auditor shows up here so you can settle everything with them in one call.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {groups.map((g) => {
              const key = g.assayerId ?? '__unassigned__';
              const isOpen = !!expanded[key];
              return (
                <div key={key} style={{ ...card, padding: 0, overflow: 'hidden' }}>
                  <button onClick={() => setExpanded((e) => ({ ...e, [key]: !e[key] }))}
                    style={{
                      width: '100%', textAlign: 'left', cursor: 'pointer', background: 'transparent', border: 'none',
                      display: 'flex', alignItems: 'center', gap: 10, padding: 14,
                      borderLeft: `3px solid ${g.overdueCount > 0 ? 'var(--danger)' : 'var(--warning)'}`,
                    }}>
                    {isOpen ? <ChevronDown size={16} color="var(--text-muted)" /> : <ChevronRight size={16} color="var(--text-muted)" />}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                      <User size={14} color="var(--text-muted)" />
                      <strong style={{ fontSize: 14, color: 'var(--text-primary)' }}>{g.assayerName ?? 'Unassigned'}</strong>
                      {g.assayerCode && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>· {g.assayerCode}</span>}
                    </span>
                    {g.overdueCount > 0 && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: 'var(--danger)' }}>
                        <AlertTriangle size={12} /> {counted(g.overdueCount, 'overdue')}
                      </span>
                    )}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 700, color: 'var(--text-secondary)' }}>
                      <Phone size={12} /> {counted(g.openCount, 'open question')}
                    </span>
                  </button>
                  {isOpen && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 12px 12px' }}>
                      {g.items.map((r) => (
                        <ClarificationCard key={r.id} row={r} onOpen={() => openCase(r)} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
};

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md, 10px)', padding: 14,
};
