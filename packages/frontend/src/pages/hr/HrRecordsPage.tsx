import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { card, label, Bar, Empty, Table, OpenLink, FIELD_LABELS } from './hr-ui';
import { assayerLifecycleLabel } from '@fapoms/shared';
import type { HrWorkforceOverview } from '../../hooks/useHrWorkforce';
import { useHr } from './HrLayout';

/**
 * Whose personnel record is incomplete, field by field.
 *
 * Previously a tab inside the single HR workspace. It now has its own URL, so it can be linked
 * to from a worklist, bookmarked by whoever owns that part of the job, and grow the controls
 * that job needs without competing for room with seven other concerns.
 */

const RecordsTabBody = ({ d, navigate, search, setSearch, canManage }: { d: HrWorkforceOverview; navigate: (path: string) => void; search: string; setSearch: (v: string) => void; canManage: boolean }) => {
  const [onlyField, setOnlyField] = useState<string>('');

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return d.compliance.incomplete.filter((r) => {
      if (onlyField && !r.missing.includes(onlyField)) return false;
      if (!q) return true;
      return `${r.displayName} ${r.assayerCode} ${r.state} ${r.district}`.toLowerCase().includes(q);
    });
  }, [d.compliance.incomplete, search, onlyField]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <section style={card}>
        <div style={{ ...label, marginBottom: '12px' }}>Completeness by field — click to filter the list below</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '12px' }}>
          {d.compliance.fields.map((f) => {
            const selected = onlyField === f.column;
            const selectable = f.critical;
            return (
              <div
                key={f.column}
                onClick={() => selectable && setOnlyField(selected ? '' : f.column)}
                title={f.blocks}
                style={{
                  padding: '10px', borderRadius: '8px', cursor: selectable ? 'pointer' : 'default',
                  border: `1px solid ${selected ? 'var(--accent)' : 'transparent'}`,
                  background: selected ? 'rgba(216,174,71,0.12)' : 'var(--bg-surface-2)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px' }}>
                  <span style={{ fontWeight: 600 }}>{f.label}{f.critical && <span style={{ color: 'var(--danger)' }}> *</span>}</span>
                  <span style={{ color: f.missing ? 'var(--warning)' : 'var(--success)' }}>{f.missing ? `${f.missing} missing` : 'complete'}</span>
                </div>
            <Bar pct={f.pct} tone={f.pct === 100 ? 'var(--success)' : f.critical ? 'var(--danger)' : 'var(--warning)'} />
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '6px' }}>{f.blocks}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '10px', flexWrap: 'wrap' }}>
          <div style={label}>
            Incomplete records ({rows.length}{onlyField ? ` missing ${FIELD_LABELS[onlyField] ?? onlyField}` : ''})
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            {onlyField && (
              <button onClick={() => setOnlyField('')} className="btn btn-secondary" style={{ fontSize: '11px', padding: '5px 10px' }}>
                Clear filter
              </button>
            )}
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, code, location"
                style={{
                  padding: '6px 10px 6px 26px', fontSize: '12px', borderRadius: '6px',
                  border: '1px solid var(--border-color)', background: 'var(--bg-input)',
                  color: 'inherit', minWidth: '220px',
                }}
              />
            </div>
          </div>
        </div>

        {rows.length === 0 ? (
          /*
           * Two filters can hide the list — the field tile above and the search box — and the old
           * wording, "No record matches this filter", named neither. A clerk who had typed a name
           * ten minutes earlier and then clicked a field tile could not tell which of the two to
           * undo, and when nothing was filtered at all it still blamed a filter that was not set.
           * Each case now says which control is hiding the rows, or that there is genuinely
           * nothing left to chase.
           */
          <Empty>
            {d.compliance.incompleteCount === 0
              ? 'Every active record has its payroll and duty-of-care fields filled in — nothing to chase here.'
              : onlyField && search.trim()
                ? `Nobody missing ${FIELD_LABELS[onlyField] ?? onlyField} matches “${search.trim()}”. Clear the search box or the field above to widen it.`
                : onlyField
                  ? `Nobody is missing ${FIELD_LABELS[onlyField] ?? onlyField}. Click that field above again to see everyone with something missing.`
                  : `No incomplete record matches “${search.trim()}”. Clear the search box to see all ${d.compliance.incompleteCount}.`}
          </Empty>
        ) : (
          <Table
            head={['Assayer', 'Code', 'Location', 'Stage', 'Missing', '']}
            rows={rows.map((r) => [
              <strong>{r.displayName}</strong>,
              <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{r.assayerCode}</span>,
              [r.district, r.state].filter(Boolean).join(', ') || '—',
              // `lifecycleStatus` is a database enum (`DOCUMENT_VERIFICATION`, `PRE_ONBOARDING`).
              // Printed raw it shouted underscored capitals at HR staff and, worse, disagreed
              // with the wording the roster and onboarding screens use for the very same person.
              assayerLifecycleLabel(r.lifecycleStatus),
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {r.missing.map((m) => (
                  <span key={m} style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '4px', background: 'var(--status-cancelled-bg)', color: 'var(--danger)' }}>
                    {FIELD_LABELS[m] ?? m}
                  </span>
                ))}
              </div>,
              // `/assayers/:id` IS NOT A ROUTE. `/assayers` is a bare redirect to /hr/roster and
              // matches that path only, so `/assayers/<uuid>` fell through to the catch-all and
              // dumped the user on the dashboard. Every "Fix" on this page — the one action the
              // whole screen exists for — silently threw the person away from the record they
              // clicked. The roster drawer reads `?assayer=<id>` and opens straight onto that one
              // person's editable details; Onboarding already links this way.
              <OpenLink label={canManage ? 'Fix' : 'View'} onClick={() => navigate(`/hr/roster?assayer=${r.id}`)} />,
            ])}
          />
        )}
      </section>
    </div>
  );
};

// ── Compliance ─────────────────────────────────────────────────────────────

export const HrRecordsPage: React.FC = () => {
  const { data: d, canManage } = useHr();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  return <RecordsTabBody d={d} navigate={navigate} search={search} setSearch={setSearch} canManage={canManage} />;
};
