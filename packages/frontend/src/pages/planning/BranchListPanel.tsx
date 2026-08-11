import React from 'react';
import { Search } from 'lucide-react';
import { ProjectBranchStatus } from '@fapoms/shared';
import { branchStatusLabel } from '../../utils/statusLabels';

export interface ProjectBranch {
  id: string;
  projectId: string;
  branchId: string;
  status: string;
  priority: string;
  zoneId: string | null;
  scheduledDate: string | null;
  remarks: string | null;
  branch: {
    id: string;
    branchCode: string;
    solId: string | null;
    name: string;
    state: string;
    district: string;
    city: string;
    latitude: number | null;
    longitude: number | null;
  };
  assignment: {
    id: string;
    status: string;
    proposedFee: number;
    agreedFee: number | null;
    scheduledDate: string | null;
    remarks?: string | null;
    negotiatedByName?: string | null;
    negotiationCount?: number;
    assayer?: { id: string; displayName: string; assayerCode?: string };
  } | null;
}

/**
 * Shared definition of the branch queue panel.
 */
export const BranchListPanel: React.FC<{
  branches: ProjectBranch[];
  selectedBranchId: string | null;
  onSelectBranch: (id: string) => void;
  searchTerm: string;
  onSearchTermChange: (value: string) => void;
  loading?: boolean;
  width?: number;
  /**
   * Multi-select for bulk assignment. Optional so the panel keeps working unchanged where
   * bulk actions don't apply. Planning was strictly one-branch-at-a-time — `selectedBranchId`
   * is a single string — so staffing 72 branches meant 72 separate passes through the
   * candidate flow. Only branches with no assignment yet are selectable; the rest have
   * already left the planning stage.
   */
  bulkSelectedIds?: Set<string>;
  onToggleBulkSelect?: (id: string) => void;
  onToggleBulkSelectAll?: () => void;
}> = ({
  branches,
  selectedBranchId,
  onSelectBranch,
  searchTerm,
  onSearchTermChange,
  loading = false,
  width = 320,
  bulkSelectedIds,
  onToggleBulkSelect,
  onToggleBulkSelectAll,
}) => {
  const bulkEnabled = !!bulkSelectedIds && !!onToggleBulkSelect;
  const selectableBranches = branches.filter((b) => !b.assignment && b.status !== 'UNABLE_TO_COVER');
  const allSelectableSelected =
    selectableBranches.length > 0 && selectableBranches.every((b) => bulkSelectedIds?.has(b.id));

  return (
    <div style={{ width: `${width}px`, minWidth: `${width}px`, display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '6px', background: 'var(--bg-surface-2)' }}>
        <Search size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input type="text" placeholder="Search branches..." value={searchTerm} onChange={e => onSearchTermChange(e.target.value)}
          style={{ flex: 1, background: 'none', border: 'none', color: 'var(--text-primary)', outline: 'none', fontSize: '12px' }} />
      </div>
      {bulkEnabled && selectableBranches.length > 0 && (
        <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '7px', background: 'var(--bg-surface-2)' }}>
          <input
            type="checkbox"
            checked={allSelectableSelected}
            onChange={() => onToggleBulkSelectAll?.()}
            style={{ cursor: 'pointer', accentColor: 'var(--accent)' }}
            aria-label="Select all unassigned branches"
          />
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>
            {bulkSelectedIds!.size > 0
              ? `${bulkSelectedIds!.size} selected`
              : `Select unassigned (${selectableBranches.length})`}
          </span>
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '30px 12px', color: 'var(--text-muted)', fontSize: '12px' }}>
            <span className="spinner" style={{ display: 'inline-block', marginBottom: 8 }} />
            <div>Loading branches…</div>
          </div>
        ) : branches.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '30px 12px', color: 'var(--text-muted)', fontSize: '12px' }}>No branches in this project.</div>
        ) : branches.map(pb => {
          const isSelected = pb.id === selectedBranchId;
          const isAssigned = !!pb.assignment;
          const isDone = ['CLOSED'].includes(pb.status);
          const isValidationPending = ['AUDIT_COMPLETED', 'VALIDATION_COMPLETED'].includes(pb.status) || pb.assignment?.status === 'COMPLETED';
          // Negotiation is a project-branch state; COUNTER_OFFER is only a transition verb, never an
          // AssignmentStatus value — so pb.status === 'NEGOTIATION' is the real (and only) signal.
          const isNegotiating = pb.status === 'NEGOTIATION';

          const badgeBg = isDone ? 'var(--status-active-bg)' : isValidationPending ? 'var(--status-pending-bg)' : isAssigned ? 'rgba(216,174,71,0.15)' : isNegotiating ? 'rgba(216,174,71,0.2)' : 'var(--border-hair)';
          const badgeColor = isDone ? 'var(--success)' : isValidationPending ? 'var(--warning)' : isAssigned ? 'var(--accent)' : isNegotiating ? 'var(--accent)' : 'var(--text-muted)';
          const statusLabel = isDone
            ? `✓ ${branchStatusLabel(pb.status)}`
            : isValidationPending
            ? `🔍 ${branchStatusLabel(pb.status)}`
            : isNegotiating
            ? `💬 ${branchStatusLabel(ProjectBranchStatus.NEGOTIATION)}`
            : isAssigned
            ? `✓ ${branchStatusLabel(ProjectBranchStatus.ASSIGNMENT_CONFIRMED)}`
            : `⏳ ${branchStatusLabel(pb.status)}`;

          return (
            <div key={pb.id} onClick={() => onSelectBranch(pb.id)}
              style={{
                padding: '10px 12px', cursor: 'pointer', borderRadius: '8px', marginBottom: '6px',
                background: isSelected ? 'rgba(216,174,71,0.25)' : isDone ? 'var(--status-active-bg)' : isAssigned ? 'rgba(216,174,71,0.06)' : 'var(--bg-surface-2)',
                borderLeft: isSelected ? '4px solid var(--accent)' : isDone ? '4px solid var(--success)' : isAssigned ? '4px solid var(--accent)' : isNegotiating ? '4px solid var(--warning)' : '4px solid transparent',
                border: isSelected ? '1px solid rgba(216,174,71,0.5)' : '1px solid var(--border-hair)',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                {bulkEnabled && !isAssigned && pb.status !== 'UNABLE_TO_COVER' && (
                  <input
                    type="checkbox"
                    checked={bulkSelectedIds!.has(pb.id)}
                    // Ticking a row must not also make it the single active branch — the two
                    // selections mean different things and the row click already does that.
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => onToggleBulkSelect!(pb.id)}
                    style={{ cursor: 'pointer', accentColor: 'var(--accent)', flexShrink: 0 }}
                    aria-label={`Select ${pb.branch.name} for bulk assignment`}
                  />
                )}
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{pb.branch.name}</div>
                <span style={{ fontSize: '10px', padding: '2px 7px', borderRadius: '4px', background: badgeBg, color: badgeColor, fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {statusLabel}
                </span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{pb.branch.city}, {pb.branch.state}</span>
                {pb.assignment?.assayer?.displayName && (
                  <span style={{ fontSize: '10px', color: 'var(--accent)', fontWeight: 600 }}>👤 {pb.assignment.assayer.displayName}</span>
                )}
              </div>
              {isNegotiating && pb.assignment?.negotiatedByName && (
                <div style={{ fontSize: '9.5px', color: 'var(--warning)', marginTop: '2px' }}>
                  💬 Being negotiated by <b>{pb.assignment.negotiatedByName}</b>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
