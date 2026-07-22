import React, { useState, useEffect } from 'react';
import { InteractivePlanningMap } from '../components/InteractivePlanningMap';
import { Map, Flag, CheckCircle } from 'lucide-react';

interface Branch {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  status: string;
  state: string;
  district?: string;
  client?: {
    name: string;
  };
}

export const ExecutiveMap: React.FC = () => {
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
        // Collect branches across all active projects
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

  // Calculate executive KPI metrics
  const totalBranches = branches.length;
  const completedAudits = branches.filter(b => b.status === 'CLOSED' || b.status === 'AUDIT_COMPLETED').length;
  const activeAudits = branches.filter(b => b.status === 'SCHEDULED' || b.status === 'ACCEPTED').length;
  const complianceRate = totalBranches > 0 ? Math.round((completedAudits / totalBranches) * 100) : 100;

  const states = Array.from(new Set(branches.map((b) => b.state)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      
      {/* Header */}
      <div>
        <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)' }}>Executive Command Center</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
          Real-time spatial operations intelligence and portfolio overview.
        </p>
      </div>

      {/* Drill-down selector */}
      <div className="glass-card" style={{ display: 'flex', gap: '16px', alignItems: 'center', padding: '16px' }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Region Drill-down:</span>
        <select 
          value={filterState} 
          onChange={(e) => setFilterState(e.target.value)}
          style={{
            padding: '8px 12px',
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-sm)',
            color: '#fff',
            outline: 'none',
            fontSize: '13px',
            cursor: 'pointer'
          }}
        >
          <option value="ALL">All Territories (National)</option>
          {states.map((st) => (
            <option key={st} value={st}>{st} State Jurisdiction</option>
          ))}
        </select>
      </div>

      {/* KPI Overlays */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px' }}>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--accent-primary)', width: '40px', height: '40px', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Map size={20} />
          </div>
          <div>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Total Audit Sites</span>
            <h4 style={{ fontSize: '20px', fontWeight: 700, margin: '2px 0' }}>{totalBranches}</h4>
          </div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--status-active)', width: '40px', height: '40px', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CheckCircle size={20} />
          </div>
          <div>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Compliance Rate</span>
            <h4 style={{ fontSize: '20px', fontWeight: 700, margin: '2px 0' }}>{complianceRate}%</h4>
          </div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ background: 'rgba(245, 158, 11, 0.1)', color: 'rgba(245, 158, 11, 1)', width: '40px', height: '40px', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Flag size={20} />
          </div>
          <div>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Active Audits</span>
            <h4 style={{ fontSize: '20px', fontWeight: 700, margin: '2px 0' }}>{activeAudits}</h4>
          </div>
        </div>
      </div>

      {/* Map visualization */}
      {isLoading ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading geographic markers...</div>
      ) : (
        <div style={{ minHeight: '380px' }}>
          <InteractivePlanningMap 
            branches={filtered}
            selectedBranchId={selectedBranchId}
            onSelectBranch={setSelectedBranchId}
          />
        </div>
      )}

    </div>
  );
};
