import React, { useState } from 'react';
import { Layers, ChevronDown, ChevronUp } from 'lucide-react';

interface MapLayerControlsProps {
  showBranches: boolean;
  setShowBranches: (val: boolean) => void;
  showRoutes: boolean;
  setShowRoutes: (val: boolean) => void;
  showSlaRisk: boolean;
  setShowSlaRisk: (val: boolean) => void;
  showWorkforceDensity: boolean;
  setShowWorkforceDensity: (val: boolean) => void;
  showRevenueDensity: boolean;
  setShowRevenueDensity: (val: boolean) => void;
  useGoogleMap: boolean;
  setUseGoogleMap: (val: boolean) => void;
}

export const MapLayerControls: React.FC<MapLayerControlsProps> = ({
  showBranches,
  setShowBranches,
  showRoutes,
  setShowRoutes,
  showSlaRisk,
  setShowSlaRisk,
  showWorkforceDensity,
  setShowWorkforceDensity,
  showRevenueDensity,
  setShowRevenueDensity,
  useGoogleMap,
  setUseGoogleMap,
}) => {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <div style={{
      position: 'absolute',
      top: '10px',
      right: '10px',
      zIndex: 1000,
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-color)',
      padding: collapsed ? '6px 10px' : '10px 14px',
      borderRadius: 'var(--radius-sm)',
      boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
      display: 'flex',
      flexDirection: 'column',
      gap: collapsed ? 0 : '8px',
      fontSize: '12px',
      minWidth: collapsed ? 'auto' : '180px',
      transition: 'all 0.2s',
    }}>
      <div onClick={() => setCollapsed(!collapsed)}
        style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer', userSelect: 'none' }}>
        <Layers size={14} />
        {collapsed ? 'Layers' : 'Layer Management'}
        {collapsed ? <ChevronUp size={12} style={{ marginLeft: '2px' }} /> : <ChevronDown size={12} style={{ marginLeft: 'auto' }} />}
      </div>
      {!collapsed && (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)', paddingTop: '6px' }}>
            <input type="checkbox" checked={showBranches} onChange={(e) => setShowBranches(e.target.checked)} />
            Audit Branches
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={showRoutes} onChange={(e) => setShowRoutes(e.target.checked)} />
            Optimized Route Lines
          </label>
          <div style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />
          <div style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-muted)' }}>GEOGRAPHIC ANALYTICS</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={showSlaRisk} onChange={(e) => setShowSlaRisk(e.target.checked)} />
            ⚠️ SLA Breach Risk
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={showWorkforceDensity} onChange={(e) => setShowWorkforceDensity(e.target.checked)} />
            👥 Workforce Density
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={showRevenueDensity} onChange={(e) => setShowRevenueDensity(e.target.checked)} />
            💰 Revenue Density Heat
          </label>
          
          <div style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />
          <div style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-muted)' }}>BASEMAP</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={useGoogleMap} onChange={(e) => setUseGoogleMap(e.target.checked)} />
            🗺️ Google Maps Satellite
          </label>
        </>
      )}
    </div>
  );
};
