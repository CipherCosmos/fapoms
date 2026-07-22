import React, { useState } from 'react';
import { Layers, ChevronDown, ChevronUp } from 'lucide-react';

interface MapLayerControlsProps {
  showBranches: boolean;
  setShowBranches: (val: boolean) => void;
  showAssayers: boolean;
  setShowAssayers: (val: boolean) => void;
  showRoutes: boolean;
  setShowRoutes: (val: boolean) => void;
  showSlaRisk: boolean;
  setShowSlaRisk: (val: boolean) => void;
  showWorkforceDensity: boolean;
  setShowWorkforceDensity: (val: boolean) => void;
  showRevenueDensity: boolean;
  setShowRevenueDensity: (val: boolean) => void;
  mapStyle: 'voyager' | 'dark' | 'satellite';
  setMapStyle: (val: 'voyager' | 'dark' | 'satellite') => void;
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

  const BRANCH_STATUSES = ['PLANNING', 'ASSIGNMENT_CONFIRMED', 'SCHEDULED', 'AUDIT_COMPLETED', 'CLOSED', 'IMPORTED'];

  const toggleStatus = (status: string) => {
    setBranchStatusFilter(
      branchStatusFilter.includes(status)
        ? branchStatusFilter.filter(s => s !== status)
        : [...branchStatusFilter, status]
    );
  };

  const trigger = (
    <div onClick={() => setCollapsed(!collapsed)}
      style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer', userSelect: 'none', padding: '6px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', fontSize: '12px', whiteSpace: 'nowrap' }}>
      <Layers size={14} style={{ color: 'var(--accent-primary)' }} />
      <span>Map Controls</span>
      <ChevronDown size={12} />
    </div>
  );

  const panelContent = () => (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Basemap</span>
        <div style={{ display: 'flex', gap: '2px', background: 'var(--bg-primary)', padding: '2px', borderRadius: 'var(--radius-sm)' }}>
          {(['voyager', 'dark', 'satellite'] as const).map(style => (
            <button key={style} type="button" onClick={() => setMapStyle(style)}
              style={{
                flex: 1, padding: '4px 6px', fontSize: '10px', textTransform: 'uppercase',
                fontWeight: 600, background: mapStyle === style ? 'var(--accent-primary)' : 'transparent',
                color: '#fff', border: 'none', borderRadius: 'var(--radius-xs)', cursor: 'pointer', transition: 'all 0.2s'
              }}
            >
              {style === 'voyager' ? 'Light' : style === 'dark' ? 'Dark' : 'Sat'}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '8px' }}>
        <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Proximity Search</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'var(--bg-primary)', padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}>
          <span style={{ color: 'var(--text-secondary)' }}>Radius:</span>
          <input type="number" min="10" max="2000" value={radiusKm}
            onChange={(e) => setRadiusKm(Math.max(1, Number(e.target.value)))}
            style={{ width: '60px', background: 'transparent', border: 'none', color: '#fff', outline: 'none', fontSize: '12px', fontWeight: 600, textAlign: 'right' }}
          />
          <span style={{ color: 'var(--text-muted)' }}>km</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '8px' }}>
        <div onClick={() => setFiltersOpen(!filtersOpen)}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none', color: 'var(--text-muted)', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          <span>Search &amp; Filters</span>
          <span style={{ marginLeft: 'auto' }}>{filtersOpen ? '−' : '+'}</span>
        </div>
        {filtersOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <input type="text" placeholder="Search branch name..." value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ width: '100%', padding: '4px 8px', fontSize: '11px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}
            />
            <input type="text" placeholder="Filter by city..." value={cityFilter}
              onChange={(e) => setCityFilter(e.target.value)}
              style={{ width: '100%', padding: '4px 8px', fontSize: '11px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}
            />
            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Branch Status</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
              {BRANCH_STATUSES.map(s => {
                const active = branchStatusFilter.length === 0 || branchStatusFilter.includes(s);
                return (
                  <button key={s} type="button" onClick={() => toggleStatus(s)}
                    style={{
                      padding: '2px 6px', fontSize: '9px', fontWeight: 600,
                      background: active ? 'rgba(99,102,241,0.2)' : 'transparent',
                      color: active ? '#fff' : 'var(--text-muted)',
                      border: active ? '1px solid var(--accent-primary)' : '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 'var(--radius-xs)', cursor: 'pointer',
                    }}
                  >
                    {s.replace(/_/g, ' ')}
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '8px' }}>
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '8px' }}>
        <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Geographic Analytics</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={showSlaRisk} onChange={(e) => setShowSlaRisk(e.target.checked)} /> ⚠️ SLA Breach Risk
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={showWorkforceDensity} onChange={(e) => setShowWorkforceDensity(e.target.checked)} /> 👥 Workforce Density
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
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
            background: 'rgba(21, 23, 30, 0.95)', backdropFilter: 'blur(8px)',
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
      background: 'rgba(21, 23, 30, 0.9)', backdropFilter: 'blur(8px)',
      border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
      display: 'flex', flexDirection: 'column', gap: collapsed ? 0 : '10px',
      fontSize: '12px', width: collapsed ? 'auto' : '220px',
      transition: 'all 0.2s', padding: collapsed ? '8px 12px' : '12px 16px',
    }}>
      <div onClick={() => setCollapsed(!collapsed)}
        style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer', userSelect: 'none' }}>
        <Layers size={14} style={{ color: 'var(--accent-primary)' }} />
        <span>{collapsed ? 'Map Controls' : 'Map Settings & Layers'}</span>
        {collapsed ? <ChevronDown size={12} style={{ marginLeft: '6px' }} /> : <ChevronUp size={12} style={{ marginLeft: 'auto' }} />}
      </div>
      {!collapsed && panelContent()}
    </div>
  );
};
