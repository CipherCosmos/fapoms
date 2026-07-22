import React from 'react';
import { Layers } from 'lucide-react';

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
}) => {
  return (
    <div style={{
      position: 'absolute',
      top: '10px',
      right: '10px',
      zIndex: 1000,
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-color)',
      padding: '10px 14px',
      borderRadius: 'var(--radius-sm)',
      boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      fontSize: '12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '2px' }}>
        <Layers size={14} /> Layer Management
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
        <input 
          type="checkbox" 
          checked={showBranches} 
          onChange={(e) => setShowBranches(e.target.checked)} 
        />
        Audit Branches
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
        <input 
          type="checkbox" 
          checked={showRoutes} 
          onChange={(e) => setShowRoutes(e.target.checked)} 
        />
        Optimized Route Lines
      </label>
      
      <div style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />
      <div style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-muted)' }}>GEOGRAPHIC ANALYTICS</div>
      
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
        <input 
          type="checkbox" 
          checked={showSlaRisk} 
          onChange={(e) => setShowSlaRisk(e.target.checked)} 
        />
        ⚠️ SLA Breach Risk Overlay
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
        <input 
          type="checkbox" 
          checked={showWorkforceDensity} 
          onChange={(e) => setShowWorkforceDensity(e.target.checked)} 
        />
        👥 Workforce Density
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
        <input 
          type="checkbox" 
          checked={showRevenueDensity} 
          onChange={(e) => setShowRevenueDensity(e.target.checked)} 
        />
        💰 Revenue Density Heat
      </label>
    </div>
  );
};
