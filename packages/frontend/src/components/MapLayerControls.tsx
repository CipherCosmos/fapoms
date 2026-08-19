import React, { useState } from 'react';
import { Layers, ChevronDown, ChevronUp } from 'lucide-react';
import { branchStatusLabel } from '../utils/statusLabels';

interface MapLayerControlsProps {
  showBranches: boolean;
  setShowBranches: (val: boolean) => void;
  showAssayers: boolean;
  setShowAssayers: (val: boolean) => void;
  showRoutes: boolean;
  setShowRoutes: (val: boolean) => void;
  showSlaRisk: boolean;
  setShowSlaRisk: (val: boolean) => void;
  slaRadiusKm?: number;
  setSlaRadiusKm?: (val: number) => void;
  showWorkforceDensity: boolean;
  setShowWorkforceDensity: (val: boolean) => void;
  showRevenueDensity: boolean;
  setShowRevenueDensity: (val: boolean) => void;
  mapStyle: 'auto' | 'voyager' | 'dark' | 'satellite';
  setMapStyle: (val: 'auto' | 'voyager' | 'dark' | 'satellite') => void;
  radiusKm: number;
  setRadiusKm: (val: number) => void;
  searchQuery: string;
  setSearchQuery: (val: string) => void;
  cityFilter: string;
  setCityFilter: (val: string) => void;
  branchStatusFilter: string[];
  setBranchStatusFilter: (val: string[]) => void;
  inline?: boolean;
}

export const MapLayerControls: React.FC<MapLayerControlsProps> = ({
  showBranches, setShowBranches,
  showAssayers, setShowAssayers,
  showRoutes, setShowRoutes,
  showSlaRisk, setShowSlaRisk,
  slaRadiusKm, setSlaRadiusKm,
  showWorkforceDensity, setShowWorkforceDensity,
  showRevenueDensity, setShowRevenueDensity,
  mapStyle, setMapStyle,
  radiusKm, setRadiusKm,
  searchQuery, setSearchQuery,
  cityFilter, setCityFilter,
  branchStatusFilter, setBranchStatusFilter,
  inline,
}) => {
  const [collapsed, setCollapsed] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const BRANCH_STATUSES = [
    'IMPORTED', 'PLANNING', 'CANDIDATE_SEARCH', 'CONTACT_INITIATED', 'NEGOTIATION',
    'ASSIGNMENT_CONFIRMED', 'SCHEDULED', 'AUDIT_COMPLETED', 'VALIDATION_COMPLETED',
    'CLOSED', 'UNABLE_TO_COVER', 'ON_HOLD', 'CANCELLED',
  ];

  /**
   * Thirteen raw workflow states is the pipeline's own vocabulary; a coordinator filtering the
   * map is asking a four-way question — is this branch waiting for me, under way, finished, or
   * called off? These four groups answer that in one click each, and every individual state is
   * still there under "Show all statuses", so nothing has been taken away.
   */
  const STATUS_GROUPS: ReadonlyArray<{ label: string; statuses: string[] }> = [
    { label: 'To do', statuses: ['IMPORTED', 'PLANNING', 'CANDIDATE_SEARCH', 'ON_HOLD'] },
    { label: 'In progress', statuses: ['CONTACT_INITIATED', 'NEGOTIATION', 'ASSIGNMENT_CONFIRMED', 'SCHEDULED'] },
    { label: 'Done', statuses: ['AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'] },
    { label: 'Cancelled', statuses: ['UNABLE_TO_COVER', 'CANCELLED'] },
  ];
  /** Every status in the group is on — the only state in which the group chip reads as "on". */
  const groupActive = (statuses: string[]) => statuses.every(st => branchStatusFilter.includes(st));
  const toggleGroup = (statuses: string[]) => {
    setBranchStatusFilter(
      groupActive(statuses)
        ? branchStatusFilter.filter(st => !statuses.includes(st))
        : Array.from(new Set([...branchStatusFilter, ...statuses])),
    );
  };
  const [allStatusesOpen, setAllStatusesOpen] = useState(false);
  /** Analytics layers and raw radius boxes: real tools, but not part of the everyday job. */
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const toggleStatus = (status: string) => {
    setBranchStatusFilter(
      branchStatusFilter.includes(status)
        ? branchStatusFilter.filter(s => s !== status)
        : [...branchStatusFilter, status]
    );
  };

  const trigger = (
    <button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}
      style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer', userSelect: 'none', padding: '6px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', fontSize: '12px', whiteSpace: 'nowrap', font: 'inherit' }}>
      <Layers size={14} style={{ color: 'var(--accent-primary)' }} />
      <span>Map Controls</span>
      <ChevronDown size={12} />
    </button>
  );

  const panelContent = () => (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Basemap</span>
        <div style={{ display: 'flex', gap: '2px', background: 'var(--bg-primary)', padding: '2px', borderRadius: 'var(--radius-sm)' }}>
          {(['auto', 'voyager', 'dark', 'satellite'] as const).map(style => (
            <button key={style} type="button" onClick={() => setMapStyle(style)}
              style={{
                flex: 1, padding: '4px 6px', fontSize: '10px', textTransform: 'uppercase',
                fontWeight: 600, background: mapStyle === style ? 'var(--accent-primary)' : 'transparent',
                color: mapStyle === style ? 'var(--on-accent)' : 'var(--text-primary)', border: 'none', borderRadius: 'var(--radius-xs)', cursor: 'pointer', transition: 'all 0.2s'
              }}
            >
              {style === 'auto' ? 'Auto' : style === 'voyager' ? 'Light' : style === 'dark' ? 'Dark' : 'Sat'}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', borderTop: '1px solid var(--border-hair)', paddingTop: '8px' }}>
        {/* Raw kilometre box — an Advanced control; the everyday distance question is answered by
            the "Nearby only" menu on the match panel. Kept here in full, just not up front. */}
        <span style={{ display: advancedOpen ? 'block' : 'none', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Proximity Search</span>
        <div style={{ display: advancedOpen ? 'flex' : 'none', alignItems: 'center', gap: '6px', background: 'var(--bg-primary)', padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}>
          <span style={{ color: 'var(--text-secondary)' }}>Radius:</span>
          <input type="number" min="10" max="2000" value={radiusKm}
            onChange={(e) => setRadiusKm(Math.max(1, Number(e.target.value)))}
            style={{ width: '60px', background: 'transparent', border: 'none', color: 'var(--text-primary)', outline: 'none', fontSize: '12px', fontWeight: 600, textAlign: 'right' }}
          />
          <span style={{ color: 'var(--text-muted)' }}>km</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', borderTop: '1px solid var(--border-hair)', paddingTop: '8px' }}>
        <button type="button" onClick={() => setFiltersOpen(!filtersOpen)} aria-expanded={filtersOpen}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none', color: 'var(--text-muted)', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', background: 'none', border: 'none', padding: 0, width: '100%', font: 'inherit' }}>
          <span>Search &amp; Filters</span>
          <span style={{ marginLeft: 'auto' }}>{filtersOpen ? '−' : '+'}</span>
        </button>
        {filtersOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <input type="text" placeholder="Search branch name..." value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ width: '100%', padding: '4px 8px', fontSize: '11px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none' }}
            />
            <input type="text" placeholder="Filter by city..." value={cityFilter}
              onChange={(e) => setCityFilter(e.target.value)}
              style={{ width: '100%', padding: '4px 8px', fontSize: '11px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none' }}
            />
            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Branch Status</span>
            {/* The everyday four-way question first. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
              {STATUS_GROUPS.map(g => {
                const active = branchStatusFilter.length === 0 || groupActive(g.statuses);
                return (
                  <button key={g.label} type="button" onClick={() => toggleGroup(g.statuses)}
                    title={`${g.label}: ${g.statuses.map(branchStatusLabel).join(', ')}`}
                    style={{
                      padding: '3px 8px', fontSize: '10px', fontWeight: 700,
                      background: active ? 'var(--status-pending-bg)' : 'transparent',
                      color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                      border: active ? '1px solid var(--accent-primary)' : '1px solid var(--border-hair)',
                      borderRadius: 'var(--radius-xs)', cursor: 'pointer',
                    }}
                  >
                    {g.label}
                  </button>
                );
              })}
            </div>
            {/* …and every individual state, unchanged, for the times the groups are too coarse. */}
            <button type="button" onClick={() => setAllStatusesOpen(o => !o)} aria-expanded={allStatusesOpen}
              style={{ alignSelf: 'flex-start', padding: 0, fontSize: '10px', background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', textDecoration: 'underline' }}>
              {allStatusesOpen ? 'Hide individual statuses' : 'Show all statuses'}
            </button>
            <div style={{ display: allStatusesOpen ? 'flex' : 'none', flexWrap: 'wrap', gap: '3px' }}>
              {BRANCH_STATUSES.map(s => {
                const active = branchStatusFilter.length === 0 || branchStatusFilter.includes(s);
                return (
                  <button key={s} type="button" onClick={() => toggleStatus(s)}
                    style={{
                      padding: '2px 6px', fontSize: '9px', fontWeight: 600,
                      background: active ? 'var(--status-pending-bg)' : 'transparent',
                      color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                      border: active ? '1px solid var(--accent-primary)' : '1px solid var(--border-hair)',
                      borderRadius: 'var(--radius-xs)', cursor: 'pointer',
                    }}
                  >
                    {branchStatusLabel(s)}
                  </button>
                );
              })}
            </div>
            {branchStatusFilter.length > 0 && (
              <button type="button" onClick={() => setBranchStatusFilter([])}
                style={{ alignSelf: 'flex-start', padding: '2px 8px', fontSize: '9px', background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', textDecoration: 'underline' }}
              >
                Clear status filter
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid var(--border-hair)', paddingTop: '8px' }}>
        <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Data Layers</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={showBranches} onChange={(e) => setShowBranches(e.target.checked)} /> Audit Branches
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={showAssayers} onChange={(e) => setShowAssayers(e.target.checked)} /> Assayers (Auditors)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={showRoutes} onChange={(e) => setShowRoutes(e.target.checked)} /> Route Lines
        </label>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid var(--border-hair)', paddingTop: '8px' }}>
        {/*
          "SLA Breach Risk" named the opposite of what this layer draws. The circle marks the
          zone in which someone lives TOO CLOSE to a branch to audit it independently — a
          minimum-distance rule, nothing to do with service levels, as its own tooltip on the
          planning screen already said. Renamed to what it shows.
        */}
        <button type="button" onClick={() => setAdvancedOpen(o => !o)} aria-expanded={advancedOpen}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none', color: 'var(--text-muted)', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', background: 'none', border: 'none', padding: 0, width: '100%', font: 'inherit' }}>
          <span>Advanced</span>
          <span style={{ marginLeft: 'auto' }}>{advancedOpen ? '−' : '+'}</span>
        </button>
        <label style={{ display: advancedOpen ? 'flex' : 'none', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}
          title="Shades the area around each branch in which a person lives too close to audit it independently.">
          <input type="checkbox" checked={showSlaRisk} onChange={(e) => setShowSlaRisk(e.target.checked)} /> ⚠️ Too close to branch
        </label>
        {advancedOpen && showSlaRisk && setSlaRadiusKm && (
          <div style={{ marginLeft: '22px', display: 'flex', flexDirection: 'column', gap: '4px', padding: '6px 8px', backgroundColor: 'var(--status-cancelled-bg)', borderRadius: '6px', border: '1px solid var(--status-cancelled)', marginBottom: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', color: 'var(--danger)' }}>
              <span>Minimum distance: <strong>{slaRadiusKm || 15} km</strong></span>
            </div>
            <input
              type="range"
              min="2"
              max="60"
              step="1"
              value={slaRadiusKm || 15}
              onChange={(e) => setSlaRadiusKm(Number(e.target.value))}
              style={{ accentColor: 'var(--danger)', width: '100%', cursor: 'pointer' }}
            />
            <div style={{ display: 'flex', gap: '4px', marginTop: '2px' }}>
              {[5, 15, 30, 50].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setSlaRadiusKm(preset)}
                  style={{
                    flex: 1,
                    fontSize: '9px',
                    padding: '2px 0',
                    borderRadius: '4px',
                    border: (slaRadiusKm || 15) === preset ? '1px solid var(--danger)' : '1px solid var(--border-hair)',
                    backgroundColor: (slaRadiusKm || 15) === preset ? 'var(--status-cancelled-bg)' : 'var(--bg-surface-2)',
                    color: (slaRadiusKm || 15) === preset ? 'var(--text-primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  {preset}k
                </button>
              ))}
            </div>
          </div>
        )}
        <label style={{ display: advancedOpen ? 'flex' : 'none', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={showWorkforceDensity} onChange={(e) => setShowWorkforceDensity(e.target.checked)} /> 👥 Workforce Density
        </label>
        <label style={{ display: advancedOpen ? 'flex' : 'none', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={showRevenueDensity} onChange={(e) => setShowRevenueDensity(e.target.checked)} /> 💰 Revenue Density
        </label>
      </div>
    </>
  );

  if (inline) {
    return (
      <div style={{ position: 'relative' }}>
        {trigger}
        {!collapsed && (
          <div style={{
            position: 'absolute', top: '100%', right: 0, marginTop: '4px', zIndex: 1000,
            background: 'var(--bg-surface-2)', backdropFilter: 'blur(8px)',
            border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
            padding: '12px 16px', boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
            display: 'flex', flexDirection: 'column', gap: '10px',
            fontSize: '12px', width: '260px',
          }}>
            {panelContent()}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{
      position: 'absolute', top: '10px', right: '10px', zIndex: 1000,
      background: 'var(--bg-surface-2)', backdropFilter: 'blur(8px)',
      border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
      display: 'flex', flexDirection: 'column', gap: collapsed ? 0 : '10px',
      fontSize: '12px', width: collapsed ? 'auto' : '220px',
      transition: 'all 0.2s', padding: collapsed ? '8px 12px' : '12px 16px',
    }}>
      <button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}
        style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer', userSelect: 'none', background: 'none', border: 'none', padding: 0, width: '100%', font: 'inherit' }}>
        <Layers size={14} style={{ color: 'var(--accent-primary)' }} />
        <span>{collapsed ? 'Map Controls' : 'Map Settings & Layers'}</span>
        {collapsed ? <ChevronDown size={12} style={{ marginLeft: '6px' }} /> : <ChevronUp size={12} style={{ marginLeft: 'auto' }} />}
      </button>
      {!collapsed && panelContent()}
    </div>
  );
};
