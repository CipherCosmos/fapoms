import React from 'react';
import { MapPin, CheckCircle2, AlertTriangle, ShieldCheck } from 'lucide-react';
import { DataTable } from '../../../components/ui/DataTable';
import { StatusBadge } from '../../../components/ui/StatusBadge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { fmtDate } from '../../../utils/dates';
import { onboardingNextStep, stillWorkable, isRecordedDeceased } from '../assayer-shared';
import { computeRosterAttention } from './computeRosterAttention';
import { RosterRowActions } from './RosterRowActions';
import { missingFields, payoutBlockers } from '../roster-filters';
import { counted } from '../../../utils/plural';
import type { RosterPerson } from '../roster-filters';
import type { SortKey } from './useRosterQuery';

export interface RosterTableProps {
  rows: RosterPerson[];
  totalLoaded: number;
  visibleCount: number;
  loading: boolean;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: (checked: boolean) => void;
  canManage: boolean;
  canCreate: boolean;
  onRowClick: (id: string) => void;
  onEdit: (id: string) => void;
  onResumeRegistration: (id: string) => void;
  onStartTransition: (person: RosterPerson, targetStatus: string) => void;
  onDelete: (person: RosterPerson) => void;
  onShowMore: () => void;
  activeCriteria: string[];
  onClearFilters: () => void;
}

export const RecordGaps: React.FC<{ a: RosterPerson }> = ({ a }) => {
  const missing = missingFields(a);
  const blockers = payoutBlockers(a);

  if (missing.length > 0 && !stillWorkable(a)) {
    return (
      <span
        title={`Missing: ${missing.join(', ')}`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--text-muted)' }}
      >
        {counted(missing.length, 'gap')} · {isRecordedDeceased(a) ? 'no longer with us' : 'left'}
      </span>
    );
  }
  if (missing.length === 0) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--success)', fontSize: '12px' }}>
        <CheckCircle2 size={12} /> Complete
      </span>
    );
  }
  return (
    <span
      title={`Missing: ${missing.join(', ')}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', fontWeight: 600,
        color: blockers.length ? 'var(--danger)' : 'var(--warning)',
      }}
    >
      <AlertTriangle size={12} />
      {blockers.length ? `Cannot be paid · ${missing.length} missing` : `${missing.length} missing`}
    </span>
  );
};

const useIsMobile = (max = 768): boolean => {
  const [isMobile, setIsMobile] = React.useState(
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(`(max-width: ${max}px)`).matches
      : false,
  );
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${max}px)`);
    const handler = () => setIsMobile(mq.matches);
    handler();
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [max]);
  return isMobile;
};

export const RosterTable: React.FC<RosterTableProps> = ({
  rows,
  totalLoaded,
  visibleCount,
  loading,
  sortKey,
  sortDir,
  onSort,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  canManage,
  canCreate,
  onRowClick,
  onEdit,
  onResumeRegistration,
  onStartTransition,
  onDelete,
  onShowMore,
  activeCriteria,
  onClearFilters,
}) => {
  const isMobile = useIsMobile(768);
  const displayedRows = rows.slice(0, visibleCount);

  return (
    <div
      style={{
        border: '1px solid var(--border-color)',
        borderRadius: '10px',
        overflow: 'hidden',
        background: 'var(--bg-card)',
      }}
    >
      {!isMobile ? (
        /* Responsive Desktop View Table */
        <div className="roster-desktop-view">
          <DataTable<RosterPerson>
            density="compact"
            rows={loading ? [] : displayedRows}
            rowKey={(a) => a.id}
            onRowClick={(a) => onRowClick(a.id)}
          loading={loading}
          loadingRows={8}
          sortKey={sortKey}
          sortOrder={sortDir}
          onSort={(k) => onSort(k as SortKey)}
          selectable={canManage}
          selected={selectedIds}
          onToggleSelect={onToggleSelect}
          onSelectAll={onSelectAll}
          rowStyle={(a) =>
            selectedIds.has(a.id)
              ? { background: 'color-mix(in srgb, var(--accent) 10%, transparent)' }
              : undefined
          }
          emptyState={
            totalLoaded === 0 ? (
              <EmptyState
                meaning="NO_DATA"
                title="Workforce roster is empty"
                message="The workforce roster currently contains no registered assayer profiles."
              />
            ) : (
              <EmptyState
                meaning="NO_RESULTS"
                title="No Assayers Match Current Filters"
                message={`No records match ${activeCriteria.join(' + ')}.`}
                onClearFilters={onClearFilters}
              />
            )
          }
          columns={[
            {
              key: 'displayName',
              header: 'Assayer Identity',
              sortable: true,
              render: (a) => (
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{a.displayName}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                    {a.assayerCode} · {a.phone || 'No phone'}
                  </div>
                </div>
              ),
            },
            {
              key: 'lifecycleStatus',
              header: 'Lifecycle Stage',
              sortable: true,
              render: (a) => {
                const nextStep = onboardingNextStep(a);
                const title = nextStep ? `Onboarding not finished: ${nextStep}.` : undefined;
                return (
                  <div>
                    <StatusBadge domain="assayerLifecycle" status={a.lifecycleStatus} title={title} />
                    {nextStep && (
                      <div
                        title={title}
                        style={{
                          fontSize: '11px',
                          color: 'var(--text-muted)',
                          marginTop: '3px',
                          maxWidth: '180px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {nextStep}
                      </div>
                    )}
                  </div>
                );
              },
            },
            {
              key: 'attention',
              header: 'Operational Attention',
              sortable: false,
              render: (a) => {
                const attention = computeRosterAttention(a);
                return (
                  <div>
                    <StatusBadge
                      domain="rosterAttention"
                      status={attention.state}
                      title={attention.reason}
                    />
                    {attention.reason && (
                      <div
                        style={{
                          fontSize: '11px',
                          color: 'var(--text-muted)',
                          marginTop: '2px',
                          maxWidth: '180px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {attention.reason}
                      </div>
                    )}
                  </div>
                );
              },
            },
            {
              key: 'completeness',
              header: 'Record',
              sortable: true,
              render: (a) => <RecordGaps a={a} />,
            },
            {
              key: 'state',
              header: 'Location',
              sortable: true,
              render: (a) => (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12.5px' }}>
                  <MapPin size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <span>{[a.city, a.state].filter(Boolean).join(', ') || '—'}</span>
                </span>
              ),
            },
            {
              key: 'empanelment',
              header: 'Client Clearance',
              sortable: false,
              render: (a) => {
                const emp = (a as any).empanelment;
                if (!emp || emp.clientCount === 0) {
                  return <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>0 banks</span>;
                }
                const isCleared = emp.plannableClients > 0;
                return (
                  <span
                    style={{
                      fontSize: '12px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      color: isCleared ? 'var(--text-primary)' : 'var(--danger)',
                      fontWeight: isCleared ? 400 : 600,
                    }}
                  >
                    <ShieldCheck size={12} style={{ opacity: 0.7 }} />
                    {emp.plannableClients} / {emp.clientCount} plannable
                  </span>
                );
              },
            },
            {
              key: 'joiningDate',
              header: 'Joined',
              sortable: true,
              render: (a) => (
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  {fmtDate(a.joiningDate) || '—'}
                </span>
              ),
            },
            {
              key: 'actions',
              header: 'Actions',
              align: 'right',
              render: (a) => (
                <RosterRowActions
                  person={a}
                  canCreate={canCreate}
                  canManage={canManage}
                  onEdit={onEdit}
                  onResumeRegistration={onResumeRegistration}
                  onStartTransition={onStartTransition}
                  onDelete={onDelete}
                />
              ),
            },
          ]}
        />
      </div>
      ) : (
        /* Mobile Card Strategy (< 768px): Structured touch-friendly cards */
        <div className="roster-mobile-view" style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px' }}>
        {displayedRows.map((person) => {
          const attention = computeRosterAttention(person);
          const emp = (person as any).empanelment;
          const isSelected = selectedIds.has(person.id);

          return (
            <div
              key={person.id}
              onClick={() => onRowClick(person.id)}
              style={{
                padding: '12px',
                borderRadius: '8px',
                border: isSelected ? '1px solid var(--accent)' : '1px solid var(--border-color)',
                background: isSelected ? 'color-mix(in srgb, var(--accent) 8%, var(--bg-card))' : 'var(--bg-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {canManage && (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => onToggleSelect(person.id)}
                      style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                      aria-label={`Select ${person.displayName}`}
                    />
                  )}
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>
                      {person.displayName}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                      {person.assayerCode}
                    </div>
                  </div>
                </div>
                <StatusBadge domain="assayerLifecycle" status={person.lifecycleStatus} />
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                <StatusBadge domain="rosterAttention" status={attention.state} />
                {emp && emp.clientCount > 0 && (
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {emp.plannableClients} / {emp.clientCount} banks
                  </span>
                )}
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                  {[person.city, person.state].filter(Boolean).join(', ')}
                </span>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderTop: '1px solid var(--border-color)',
                  paddingTop: '6px',
                  marginTop: '2px',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                  {person.phone || 'No phone'}
                </span>
                <RosterRowActions
                  person={person}
                  canCreate={canCreate}
                  canManage={canManage}
                  onEdit={onEdit}
                  onResumeRegistration={onResumeRegistration}
                  onStartTransition={onStartTransition}
                  onDelete={onDelete}
                />
              </div>
            </div>
          );
        })}
        </div>
      )}

      {/* Pagination Footer */}
      {!loading && rows.length > 0 && (
        <div
          style={{
            padding: '10px 14px',
            fontSize: '12.5px',
            color: 'var(--text-secondary)',
            borderTop: '1px solid var(--border-color)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            flexWrap: 'wrap',
          }}
        >
          <span>
            Showing {Math.min(visibleCount, rows.length).toLocaleString('en-IN')} of{' '}
            {rows.length.toLocaleString('en-IN')} loaded rows
          </span>
          {rows.length > visibleCount && (
            <button
              type="button"
              onClick={onShowMore}
              className="btn btn-secondary"
              style={{ padding: '5px 14px', fontSize: '12px' }}
            >
              Show {Math.min(200, rows.length - visibleCount)} more
            </button>
          )}
        </div>
      )}
    </div>
  );
};
