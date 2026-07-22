import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { InteractivePlanningMap } from '../components/InteractivePlanningMap';
import { Map, Flag, CheckCircle, ExternalLink, ShieldAlert } from 'lucide-react';

interface Branch {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  status: string;
  state: string;
  district?: string;
  city?: string;
  branchCode?: string;
  projectId?: string;
  client?: {
    name: string;
  };
}

export const ExecutiveMap: React.FC = () => {
  const navigate = useNavigate();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [filterState, setFilterState] = useState('ALL');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    loadBranches();
  }, []);

  const loadBranches = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/v1/projects', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('fapoms_token')}`
        }
      });
      const data = await response.json();
      if (response.ok && data.success) {
        const allBranches: Branch[] = [];
        data.data.forEach((proj: any) => {
          if (proj.projectBranches) {
            proj.projectBranches.forEach((pb: any) => {
              if (pb.branch) {
                allBranches.push({
                  id: pb.branch.id,
                  name: pb.branch.name,
                  latitude: pb.branch.latitude,
                  longitude: pb.branch.longitude,
                  status: pb.status || 'PLANNING',
                  state: pb.branch.state || 'MH',
                  city: pb.branch.city,
                  branchCode: pb.branch.branchCode,
                  projectId: proj.id,
                  client: proj.client
                });
              }
            });
          }
        });
        setBranches(allBranches);
      }
    } catch (err) {
      console.error('Failed to load branches for executive map');
    } finally {
      setIsLoading(false);
    }
  };

  const getFilteredBranches = () => {
    if (filterState === 'ALL') return branches;
    return branches.filter((b) => b.state === filterState);
  };

  const filtered = getFilteredBranches();

  // Selected Branch object lookup
  const selectedBranch = branches.find(b => b.id === selectedBranchId);

  // Calculate executive metrics
  const totalBranches = branches.length;
  const completedAudits = branches.filter(b => b.status === 'CLOSED' || b.status === 'AUDIT_COMPLETED').length;
  const activeAudits = branches.filter(b => b.status === 'SCHEDULED' || b.status === 'ACCEPTED').length;
  const complianceRate = totalBranches > 0 ? Math.round((completedAudits / totalBranches) * 100) : 100;
  const pendingAssignments = branches.filter(b => b.status === 'PLANNING' || b.status === 'IMPORTED').length;

  const states = Array.from(new Set(branches.map((b) => b.state)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldAlert size={24} style={{ color: 'var(--accent-primary)' }} /> Executive Command Center
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
            Real-time geospatial intelligence, operational risk metrics, and instant dispatcher controls.
          </p>
        </div>

        {/* Drill-down selector */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Jurisdiction:</span>
          <select 
            value={filterState} 
            onChange={(e) => setFilterState(e.target.value)}
            style={{
              padding: '8px 12px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-sm)',
              color: '#fff',
              outline: 'none',
              fontSize: '12px',
              cursor: 'pointer'
            }}
          >
            <option value="ALL">All Territories (National)</option>
            {states.map((st) => (
              <option key={st} value={st}>{st} State Jurisdiction</option>
            ))}
          </select>
        </div>
      </div>

      {/* KPI Overlays */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px' }}>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '16px', borderLeft: '3px solid var(--accent-primary)' }}>
          <div style={{ background: 'rgba(99, 102, 241, 0.08)', color: 'var(--accent-primary)', width: '42px', height: '42px', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Map size={20} />
          </div>
          <div>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', fontWeight: 600 }}>TOTAL STATIONS</span>
            <h4 style={{ fontSize: '22px', fontWeight: 800, margin: 0, color: '#fff', fontFamily: 'var(--font-display)' }}>{totalBranches}</h4>
          </div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '16px', borderLeft: '3px solid var(--status-active)' }}>
          <div style={{ background: 'rgba(16, 185, 129, 0.08)', color: 'var(--status-active)', width: '42px', height: '42px', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CheckCircle size={20} />
          </div>
          <div>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', fontWeight: 600 }}>COMPLIANCE RATE</span>
            <h4 style={{ fontSize: '22px', fontWeight: 800, margin: 0, color: '#fff', fontFamily: 'var(--font-display)' }}>{complianceRate}%</h4>
          </div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '16px', borderLeft: '3px solid #f59e0b' }}>
          <div style={{ background: 'rgba(245, 158, 11, 0.08)', color: '#f59e0b', width: '42px', height: '42px', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Flag size={20} />
          </div>
          <div>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', fontWeight: 600 }}>ACTIVE AUDITS</span>
            <h4 style={{ fontSize: '22px', fontWeight: 800, margin: 0, color: '#fff', fontFamily: 'var(--font-display)' }}>{activeAudits}</h4>
          </div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '16px', borderLeft: '3px solid #ef4444' }}>
          <div style={{ background: 'rgba(239, 68, 68, 0.08)', color: '#ef4444', width: '42px', height: '42px', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ShieldAlert size={20} />
          </div>
          <div>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', fontWeight: 600 }}>UNASSIGNED QUEUE</span>
            <h4 style={{ fontSize: '22px', fontWeight: 800, margin: 0, color: '#fff', fontFamily: 'var(--font-display)' }}>{pendingAssignments}</h4>
          </div>
        </div>
      </div>

      {/* Map visualization split layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: '20px', minHeight: '520px' }}>
        
        {/* Geographic Map Container */}
        {isLoading ? (
          <div className="glass-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
            Loading geographic markers...
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <InteractivePlanningMap 
              branches={filtered}
              selectedBranchId={selectedBranchId}
              onSelectBranch={setSelectedBranchId}
              fillContainer
            />
          </div>
        )}

        {/* Real-time Dispatch detail / Info panel */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', padding: '20px', gap: '16px', overflowY: 'auto' }}>
          {selectedBranch ? (
            <>
              <div>
                <span style={{ fontSize: '10px', color: 'var(--accent-primary)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Selected station</span>
                <h4 style={{ fontSize: '16px', fontWeight: 700, color: '#fff', margin: '4px 0 2px' }}>{selectedBranch.name}</h4>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>Code: {selectedBranch.branchCode}</span>
              </div>

              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>CLIENT DETAILS</span>
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>{selectedBranch.client?.name || 'N/A'}</span>
              </div>

              <div>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>OPERATIONAL STATE</span>
                <span style={{ fontSize: '12px', padding: '4px 8px', borderRadius: '4px', display: 'inline-block', fontWeight: 600,
                  background: selectedBranch.status === 'CLOSED' || selectedBranch.status === 'AUDIT_COMPLETED' ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)',
                  color: selectedBranch.status === 'CLOSED' || selectedBranch.status === 'AUDIT_COMPLETED' ? '#10b981' : '#f59e0b' }}>
                  {selectedBranch.status}
                </span>
              </div>

              <div>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>LOCATION</span>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{selectedBranch.city}, {selectedBranch.state}</span>
              </div>

              <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                {selectedBranch.projectId ? (
                  <button 
                    onClick={() => navigate(`/planning?projectId=${selectedBranch.projectId}`)} 
                    className="btn btn-secondary" 
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '12px', padding: '10px' }}
                  >
                    <ExternalLink size={13} /> Dispatch Operations
                  </button>
                ) : (
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center' }}>No associated project found.</span>
                )}
                <button 
                  onClick={() => setSelectedBranchId(null)} 
                  className="btn btn-secondary" 
                  style={{ fontSize: '12px', padding: '6px' }}
                >
                  Clear Selection
                </button>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', textAlign: 'center', gap: '12px' }}>
              <Map size={32} style={{ opacity: 0.3, color: 'var(--accent-primary)' }} />
              <div>
                <h5 style={{ fontSize: '13px', fontWeight: 600, color: '#fff', margin: '0 0 4px' }}>Interactive Command Panel</h5>
                <p style={{ fontSize: '11px', margin: 0 }}>Click any audit station node on the map to load real-time dispatch routes and operations overview.</p>
              </div>
            </div>
          )}
        </div>

      </div>

    </div>
  );
};
