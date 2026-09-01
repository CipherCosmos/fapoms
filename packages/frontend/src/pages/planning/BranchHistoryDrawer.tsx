import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, ClipboardList, FileText, ShieldCheck, GitBranch } from 'lucide-react';
import { DetailDrawer } from '../../components/ui';
import { api } from '../../services/api';
import { branchStatusLabel, anyStatusLabel, activityEventLabel } from '@fapoms/shared';

/**
 * Everything that has happened to one branch.
 *
 * Planning could show a branch as CLOSED with nowhere to find out when, by whom,
 * or through which steps it got there — project-branch status changes were never
 * written to the audit trail at all, and the assignments, documents and
 * validation case that tell the rest of the story each lived on a different
 * page. This is the single answer to "what happened to this branch".
 */

interface TimelineEntry {
  kind: 'STATUS' | 'ASSIGNMENT' | 'DOCUMENT' | 'VALIDATION';
  at: string;
  title: string;
  from: string | null;
  to: string | null;
  detail: string | null;
  actor: string | null;
}

interface BranchHistory {
  branchName: string | null;
  solId: string | null;
  projectName: string | null;
  currentStatus: string;
  scheduledDate: string | null;
  packetCount: number | null;
  timeline: TimelineEntry[];
}

const KIND_META: Record<TimelineEntry['kind'], { icon: React.ReactNode; tone: string; label: string }> = {
  STATUS: { icon: <GitBranch size={13} />, tone: 'var(--accent)', label: 'Status' },
  ASSIGNMENT: { icon: <ClipboardList size={13} />, tone: 'var(--warning)', label: 'Assignment' },
  DOCUMENT: { icon: <FileText size={13} />, tone: 'var(--accent)', label: 'Document' },
  VALIDATION: { icon: <ShieldCheck size={13} />, tone: 'var(--success)', label: 'Validation' },
};

const fmtWhen = (d: string) =>
  new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const label: React.CSSProperties = {
  fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)',
};

export const BranchHistoryDrawer: React.FC<{ projectBranchId: string; onClose: () => void }> = ({
  projectBranchId, onClose,
}) => {
  const { data, isLoading, error } = useQuery({
    queryKey: ['branch-history', projectBranchId],
    queryFn: () => api.request<BranchHistory>(`/projects/branches/${projectBranchId}/history`),
  });

  const h = data as BranchHistory | undefined;

  return (
    <DetailDrawer
      open
      onClose={onClose}
      width={520}
      title={
        <>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{h?.branchName ?? 'Branch history'}</div>
          <div style={{ ...label, marginTop: 4 }}>
            {h?.solId ?? '—'}{h?.projectName ? ` · ${h.projectName}` : ''}
          </div>
        </>
      }
    >
      {isLoading && <Muted>Loading history…</Muted>}
      {error && <div style={{ color: 'var(--danger)', fontSize: '13px' }}>{(error as Error).message}</div>}
      {h && (
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', paddingBottom: 4 }}>
          <Fact label="Current status" value={branchStatusLabel(h.currentStatus)} />
          <Fact label="Scheduled" value={h.scheduledDate ? new Date(h.scheduledDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Not set'} />
          <Fact label="Packets" value={h.packetCount != null ? String(h.packetCount) : '—'} />
        </div>
      )}
      {h && h.timeline.length === 0 && (
        <Muted>
          Nothing has happened to this branch yet — it has been imported but no assignment,
          paperwork or validation has been recorded against it.
        </Muted>
      )}
      {h?.timeline.map((e, i) => {
        const meta = KIND_META[e.kind] ?? KIND_META.STATUS;
        return (
          <div key={i} style={{ display: 'flex', gap: '12px', paddingBottom: '16px' }}>
            {/* rail */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                background: 'var(--bg-page)', border: `1px solid ${meta.tone}`,
                color: meta.tone, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {meta.icon}
              </div>
              {i < h.timeline.length - 1 && (
                <div style={{ width: 1, flex: 1, background: 'var(--border-color)', marginTop: 4 }} />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0, paddingTop: '2px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600 }}>
                {activityEventLabel(e.title)}
              </div>
              {e.from && e.to && (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {/* A timeline entry's from/to is a status on whichever axis the entry
                      came from — STATUS entries carry branch statuses, ASSIGNMENT entries
                      assignment ones. `anyStatusLabel` reads both and still degrades an
                      unrecognised value to words rather than leaving it shouting. */}
                  {anyStatusLabel(e.from)} → <strong style={{ color: 'var(--text-primary)' }}>{anyStatusLabel(e.to)}</strong>
                </div>
              )}
              {e.detail && (
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{e.detail}</div>
              )}
              <div style={{ ...label, marginTop: '4px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <Clock size={10} /> {fmtWhen(e.at)} · {e.actor ?? 'system'} · {meta.label}
              </div>
            </div>
          </div>
        );
      })}
    </DetailDrawer>
  );
};

const Fact: React.FC<{ label: string; value: string }> = ({ label: l, value }) => (
  <div>
    <div style={label}>{l.toUpperCase()}</div>
    <div style={{ fontSize: '13px', fontWeight: 600, marginTop: '2px' }}>{value}</div>
  </div>
);

const Muted: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '16px 0', lineHeight: 1.5 }}>{children}</div>
);

export default BranchHistoryDrawer;
