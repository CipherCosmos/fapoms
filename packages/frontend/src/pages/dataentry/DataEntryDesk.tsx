import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Inbox, UserPlus, CheckCircle2, MessageSquare, FileText, AlertTriangle, Send as SubmitIcon,
} from 'lucide-react';

import { api } from '../../services/api';
import { useCurrentRoles } from '../../hooks/useCurrentRoles';
import { SystemRole } from '@fapoms/shared';
import { CaseWorkspace } from './CaseWorkspace';

/**
 * Data entry and validation, as one board.
 *
 * These were two separate pages — a delegation desk with no PDF, and a
 * "Validation Workspace" with a fake chat skin, a hardcoded assayer id, and a
 * fabricated CSV standing in for the actual submit-to-client step. They are one
 * pipeline for one team: a returned packet is delegated, worked, handed back,
 * reviewed by the head, approved, and submitted — so it is one board, ordered
 * by that real sequence, backed by the real transitions the backend now
 * actually supports end to end.
 *
 * A branch appears in exactly one lane at a time: the document lanes (still
 * being typed in) hand off to the case lanes (in the head's hands) the moment a
 * validation case exists past PENDING — never both.
 */

interface QueueItem {
  id: string; fileName: string; status: string;
  receivedAt: string | null; assignedAt: string | null; completedAt: string | null;
  projectBranchId: string | null; branchName: string | null; branchCode: string | null;
  assigneeName: string | null;
}

interface Queue { total: number; unassigned: number; inProgress: number; completed: number; items: QueueItem[] }
interface TeamMember { id: string; name: string; username: string; role: string }

interface CaseRow {
  id: string; status: string; projectBranchId: string;
  projectBranch?: { branch?: { name: string; branchCode: string } };
}

interface QueryRow { id: string; documentId: string | null; status: string; projectBranchId?: string; validationCaseId: string }

type DocLane = 'unallocated' | 'working';
type CaseLane = 'review' | 'approved' | 'submitted';

const DOC_LANES: { key: DocLane; label: string; hint: string; tone: string }[] = [
  { key: 'unallocated', label: 'Waiting to allocate', hint: 'Returned by the assayer, nobody working it yet', tone: 'var(--warning)' },
  { key: 'working', label: 'Being worked', hint: 'Delegated and in progress', tone: 'var(--accent)' },
];
const CASE_LANES: { key: CaseLane; label: string; hint: string; tone: string; statuses: string[] }[] = [
  { key: 'review', label: 'In review', hint: 'With the head — approve, or send back with a note', tone: 'var(--warning)', statuses: ['HUMAN_REVIEW', 'CORRECTION_REQUIRED'] },
  { key: 'approved', label: 'Approved', hint: 'Ready to submit to the client', tone: 'var(--success)', statuses: ['APPROVED'] },
  { key: 'submitted', label: 'Submitted', hint: 'Sent to the client', tone: 'var(--success)', statuses: ['SUBMITTED'] },
];

const fmtWhen = (d?: string | null) =>
  d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

const card: React.CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border-color)',
  borderRadius: '10px', padding: '14px',
};
const label: React.CSSProperties = {
  fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)',
};

export const DataEntryDesk: React.FC = () => {
  const roles = useCurrentRoles();
  const isHead = roles.some((r) =>
    [SystemRole.DATA_ENTRY_HEAD, SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR].includes(r));

  const [params, setParams] = useSearchParams();
  const [queue, setQueue] = useState<Queue | null>(null);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [queries, setQueries] = useState<QueryRow[]>([]);
  const [mineOnly, setMineOnly] = useState(!isHead);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const openBranchId = params.get('branch');

  const load = useCallback(() => {
    api.request<Queue>(mineOnly ? '/documents/data-entry/mine' : '/documents/data-entry/queue')
      .then(setQueue)
      .catch((e) => setErr((e as Error).message));
    api.request<CaseRow[]>('/validation?limit=200')
      .then((r) => setCases(Array.isArray(r) ? r : []))
      .catch(() => setCases([]));
    api.request<QueryRow[]>('/validation-queries')
      .then((r) => setQueries(Array.isArray(r) ? r : []))
      .catch(() => setQueries([]));
  }, [mineOnly]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!isHead) return;
    api.request<TeamMember[]>('/documents/data-entry/team')
      .then((t) => setTeam(Array.isArray(t) ? t : []))
      .catch(() => setTeam([]));
  }, [isHead]);

  const assign = async (docId: string, assigneeId: string) => {
    if (!assigneeId) return;
    setBusy(docId);
    try {
      await api.request(`/documents/${docId}/assign-data-entry`, { method: 'POST', body: JSON.stringify({ assigneeId }) });
      load();
    } catch (e) { setErr((e as Error).message); }
    setBusy(null);
  };

  const handBack = async (docId: string) => {
    setBusy(docId);
    try {
      await api.request(`/documents/${docId}/complete-data-entry`, { method: 'POST' });
      load();
    } catch (e) { setErr((e as Error).message); }
    setBusy(null);
  };

  // A branch with a case past PENDING is in the head's hands now — the document
  // lanes stop describing what is actually happening to it, so it moves wholesale
  // to the case lanes instead of appearing in both.
  const caseByBranch = useMemo(() => {
    const m = new Map<string, CaseRow>();
    for (const c of cases) if (c.projectBranchId) m.set(c.projectBranchId, c);
    return m;
  }, [cases]);

  const inCaseFlow = useCallback(
    (branchId: string | null) => {
      if (!branchId) return false;
      const c = caseByBranch.get(branchId);
      return !!c && c.status !== 'PENDING' && c.status !== 'ASSIGNED';
    },
    [caseByBranch],
  );

  const docsByLane = useMemo(() => {
    const map: Record<DocLane, QueueItem[]> = { unallocated: [], working: [] };
    for (const d of queue?.items ?? []) {
      if (inCaseFlow(d.projectBranchId)) continue;
      map[d.completedAt || d.assigneeName ? 'working' : 'unallocated'].push(d);
    }
    return map;
  }, [queue, inCaseFlow]);

  const casesByLane = useMemo(() => {
    const map: Record<CaseLane, CaseRow[]> = { review: [], approved: [], submitted: [] };
    for (const c of cases) {
      const lane = CASE_LANES.find((l) => l.statuses.includes(c.status));
      if (lane) map[lane.key].push(c);
    }
    return map;
  }, [cases]);

  const openQueriesFor = (branchId: string | null | undefined) =>
    queries.filter((q) => {
      if (q.status === 'RESOLVED') return false;
      const c = cases.find((x) => x.id === q.validationCaseId);
      return c?.projectBranchId === branchId;
    });

  const openWorkspaceForCase = (c: CaseRow) => setParams({ branch: c.projectBranchId }, { replace: false });
  const openWorkspaceForDoc = (d: QueueItem) => {
    if (d.projectBranchId) setParams({ branch: d.projectBranchId }, { replace: false });
  };

  if (openBranchId) {
    return (
      <div style={{ padding: '16px 20px' }}>
        <CaseWorkspace projectBranchId={openBranchId} onBack={() => setParams({}, { replace: true })} onChanged={load} />
      </div>
    );
  }

  const totalCases = cases.length;
  const openClarifications = queries.filter((q) => q.status !== 'RESOLVED').length;

  return (
    <div style={{ padding: '18px 22px', maxWidth: '1600px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '14px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '21px', fontWeight: 700, margin: 0 }}>Data entry &amp; validation</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginTop: '3px' }}>
            Returned packets end to end: delegate, process, review, approve, submit.
          </p>
        </div>
        {isHead && (
          <div style={{ display: 'flex', gap: '4px' }}>
            <button onClick={() => setMineOnly(false)} className={mineOnly ? 'btn btn-secondary' : 'btn btn-primary'} style={{ fontSize: '12px', padding: '7px 12px' }}>Whole desk</button>
            <button onClick={() => setMineOnly(true)} className={mineOnly ? 'btn btn-primary' : 'btn btn-secondary'} style={{ fontSize: '12px', padding: '7px 12px' }}>Mine</button>
          </div>
        )}
      </div>

      {err && (
        <div style={{ margin: '12px 0', padding: '9px 13px', borderRadius: '8px', background: 'var(--status-cancelled-bg)', color: 'var(--danger)', fontSize: '12.5px', display: 'flex', gap: '7px', alignItems: 'center' }}>
          <AlertTriangle size={14} /> {err}
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', margin: '16px 0' }}>
        <Stat icon={<Inbox size={15} />} value={queue?.total ?? 0} caption="At the desk" />
        <Stat icon={<UserPlus size={15} />} value={queue?.unassigned ?? 0} caption="Waiting to allocate" tone={(queue?.unassigned ?? 0) > 0 ? 'var(--warning)' : undefined} />
        <Stat icon={<FileText size={15} />} value={casesByLane.review.length} caption="In review" tone={casesByLane.review.length ? 'var(--warning)' : undefined} />
        <Stat icon={<CheckCircle2 size={15} />} value={casesByLane.approved.length} caption="Approved" tone={casesByLane.approved.length ? 'var(--success)' : undefined} />
        <Stat icon={<SubmitIcon size={15} />} value={casesByLane.submitted.length} caption="Submitted" />
        <Stat icon={<MessageSquare size={15} />} value={openClarifications} caption="Open clarifications" tone={openClarifications ? 'var(--warning)' : undefined} />
      </div>

      {queue?.total === 0 && totalCases === 0 && (
        <div style={{ ...card, textAlign: 'center', padding: '40px' }}>
          <Inbox size={28} style={{ opacity: 0.35 }} />
          <div style={{ fontSize: '14px', fontWeight: 600, marginTop: '10px' }}>Nothing here yet</div>
          <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Packets appear once an assayer returns a scanned audit and it is marked received.
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px' }}>
        {DOC_LANES.map((lane) => (
          <section key={lane.key} style={card}>
            <LaneHeader tone={lane.tone} label={lane.label} hint={lane.hint} count={docsByLane[lane.key].length} />
            {docsByLane[lane.key].length === 0 ? (
              <Empty />
            ) : docsByLane[lane.key].map((d) => {
              const open = openQueriesFor(d.projectBranchId);
              return (
                <div key={d.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border-hair)' }}>
                  <div style={{ fontSize: '12.5px', fontWeight: 600 }}>{d.branchName ?? d.fileName}</div>
                  <div style={{ ...label, marginTop: '2px' }}>{d.branchCode ?? '—'} · received {fmtWhen(d.receivedAt)}</div>
                  {d.assigneeName && (
                    <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                      with <strong>{d.assigneeName}</strong>{d.assignedAt && <span style={{ color: 'var(--text-muted)' }}> · {fmtWhen(d.assignedAt)}</span>}
                    </div>
                  )}
                  {open.length > 0 && <OpenQueryChip count={open.length} onClick={() => openWorkspaceForDoc(d)} />}
                  <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
                    {isHead && lane.key === 'unallocated' && (
                      <select defaultValue="" disabled={busy === d.id} onChange={(e) => assign(d.id, e.target.value)}
                        style={{ padding: '5px 8px', fontSize: '11.5px', borderRadius: '6px', background: 'var(--bg-input)', color: 'inherit', border: '1px solid var(--border-color)' }}>
                        <option value="">Delegate to…</option>
                        {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    )}
                    {lane.key === 'working' && (
                      <button onClick={() => handBack(d.id)} disabled={busy === d.id} className="btn btn-secondary" style={{ fontSize: '11.5px', padding: '5px 10px' }}>
                        {busy === d.id ? 'Saving…' : 'Hand back to head'}
                      </button>
                    )}
                    <button onClick={() => openWorkspaceForDoc(d)} disabled={!d.projectBranchId} className="btn btn-secondary"
                      style={{ fontSize: '11.5px', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <FileText size={12} /> Open packet
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        ))}

        {CASE_LANES.map((lane) => (
          <section key={lane.key} style={card}>
            <LaneHeader tone={lane.tone} label={lane.label} hint={lane.hint} count={casesByLane[lane.key].length} />
            {casesByLane[lane.key].length === 0 ? (
              <Empty />
            ) : casesByLane[lane.key].map((c) => {
              const open = openQueriesFor(c.projectBranchId);
              const branch = c.projectBranch?.branch;
              return (
                <div key={c.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border-hair)' }}>
                  <div style={{ fontSize: '12.5px', fontWeight: 600 }}>{branch?.name ?? 'Branch'}</div>
                  <div style={{ ...label, marginTop: '2px' }}>{branch?.branchCode ?? '—'}</div>
                  {open.length > 0 && <OpenQueryChip count={open.length} onClick={() => openWorkspaceForCase(c)} />}
                  <div style={{ marginTop: '8px' }}>
                    <button onClick={() => openWorkspaceForCase(c)} className="btn btn-secondary" style={{ fontSize: '11.5px', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <FileText size={12} /> {lane.key === 'review' ? 'Review' : 'Open'}
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
};

const LaneHeader: React.FC<{ tone: string; label: string; hint: string; count: number }> = ({ tone, label: text, hint, count }) => (
  <>
    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '3px' }}>
      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: tone }} />
      <span style={{ ...label, color: tone }}>{text}</span>
      <span style={{ ...label, marginLeft: 'auto' }}>{count}</span>
    </div>
    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>{hint}</div>
  </>
);

const Empty: React.FC = () => <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '14px 0' }}>Empty.</div>;

const OpenQueryChip: React.FC<{ count: number; onClick: () => void }> = ({ count, onClick }) => (
  <button onClick={onClick} style={{
    display: 'flex', alignItems: 'center', gap: '5px', marginTop: '7px', textAlign: 'left',
    padding: '5px 8px', borderRadius: '6px', cursor: 'pointer', fontSize: '11.5px',
    background: 'var(--status-pending-bg)', border: '1px solid var(--status-pending-bg)', color: 'var(--warning)',
  }}>
    <MessageSquare size={11} /> {count} open clarification{count > 1 ? 's' : ''}
  </button>
);

const Stat: React.FC<{ icon: React.ReactNode; value: React.ReactNode; caption: string; tone?: string }> = ({ icon, value, caption, tone }) => (
    <div style={{ ...card, flex: '1 1 150px', minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: tone ?? 'var(--text-primary)' }}>
      {icon}<span style={{ fontSize: '22px', fontWeight: 700, lineHeight: 1 }}>{value}</span>
    </div>
    <div style={{ ...label, marginTop: '6px' }}>{caption}</div>
  </div>
);

export default DataEntryDesk;
