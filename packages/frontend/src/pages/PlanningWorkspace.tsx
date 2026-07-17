import React, { useState, useEffect } from 'react';
import { Compass, PhoneCall, Check, X, ShieldAlert, AlertTriangle, CheckCircle } from 'lucide-react';
import { Priority } from '@fapoms/shared';
import { api } from '../services/api';

interface ProjectOption {
  id: string;
  name: string;
  projectNumber: string;
}

interface ProjectBranch {
  id: string;
  projectId: string;
  branchId: string;
  status: string;
  priority: Priority;
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
  };
}

interface Candidate {
  id: string;
  assayerCode: string;
  displayName: string;
  phone: string;
  email: string | null;
  status: string;
  state: string;
  district: string;
  city: string;
  distanceKm: number | null;
}

export const PlanningWorkspace: React.FC = () => {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  
  const [branches, setBranches] = useState<ProjectBranch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  
  const [isLoadingQueue, setIsLoadingQueue] = useState(false);
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false);

  // Modal & Input States
  const [showNegotiationModal, setShowNegotiationModal] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null);
  const [negotiatingFee, setNegotiatingFee] = useState('1500');
  const [negotiatingDate, setNegotiatingDate] = useState('2026-07-20');

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 1. Load active projects list
  useEffect(() => {
    loadProjects();
  }, []);

  // 2. Load project branches when project selection changes
  useEffect(() => {
    if (selectedProjectId) {
      loadProjectBranches(selectedProjectId);
    } else {
      setBranches([]);
      setSelectedBranchId(null);
    }
  }, [selectedProjectId]);

  // 3. Load candidate recommendations when branch selection changes
  useEffect(() => {
    const selectedPb = branches.find(b => b.id === selectedBranchId);
    if (selectedPb) {
      loadCandidates(selectedPb.branchId);
    } else {
      setCandidates([]);
    }
  }, [selectedBranchId, branches]);

  const loadProjects = async () => {
    try {
      const fallback = [
        { id: '1', name: 'SBI Corporate Audit 2026', projectNumber: 'PRJ-2026-001' }
      ];
      const response = await api.request<ProjectOption[]>('/projects', { method: 'GET' }, fallback);
      setProjects(response);
      if (response.length > 0) {
        setSelectedProjectId(response[0].id);
      }
    } catch (err) {
      console.error('Failed to load projects');
    }
  };

  const loadProjectBranches = async (projectId: string) => {
    setIsLoadingQueue(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/branches`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('fapoms_token')}`
        }
      });
      const resData = await response.json();
      if (response.ok && resData.success) {
        setBranches(resData.data);
        if (resData.data.length > 0) {
          setSelectedBranchId(resData.data[0].id);
        } else {
          setSelectedBranchId(null);
        }
      }
    } catch (err) {
      console.error('Failed to fetch project branches queue');
    } finally {
      setIsLoadingQueue(false);
    }
  };

  const loadCandidates = async (branchId: string) => {
    setIsLoadingCandidates(true);
    try {
      const fallback = [
        { id: '1', assayerCode: 'AS-01', displayName: 'Nilesh Rahane', phone: '+91 98765 43210', email: 'nilesh@fapoms.com', status: 'ACTIVE', state: 'Maharashtra', district: 'Pune', city: 'Pune City', distanceKm: 4.8 }
      ];
      const response = await api.request<Candidate[]>(`/planning/recommendations?branchId=${branchId}`, { method: 'GET' }, fallback);
      setCandidates(response);
    } catch (err) {
      console.error('Failed to load candidate recommendations');
    } finally {
      setIsLoadingCandidates(false);
    }
  };

  // 4. Handle creating a confirmed assignment commitment
  const handleConfirmAssignment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBranchId || !selectedCandidate) return;

    setMessage(null);
    setShowNegotiationModal(false);

    try {
      const response = await fetch('/api/v1/assignments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('fapoms_token')}`
        },
        body: JSON.stringify({
          projectBranchId: selectedBranchId,
          assayerId: selectedCandidate.id,
          proposedFee: Number(negotiatingFee),
          scheduledDate: negotiatingDate
        })
      });

      const resData = await response.json();

      if (response.ok && resData.success) {
        setMessage({
          type: 'success',
          text: `Successfully assigned branch to ${selectedCandidate.displayName} on ${negotiatingDate}!`
        });
        loadProjectBranches(selectedProjectId);
      } else {
        setMessage({
          type: 'error',
          text: resData.message || 'Scheduling failed due to validation rules.'
        });
      }
    } catch (err) {
      setMessage({
        type: 'error',
        text: 'Network connection failed while scheduling assignment.'
      });
    }
  };

  const selectedPb = branches.find(b => b.id === selectedBranchId);

  // Recalculate dynamic Confirmed Coverage percentage
  const totalCount = branches.length;
  const confirmedCount = branches.filter(b => b.status === 'ASSIGNMENT_CONFIRMED' || b.status === 'SCHEDULED').length;
  const coveragePercentage = totalCount > 0 ? parseFloat(((confirmedCount / totalCount) * 100).toFixed(1)) : 0;

  return (
    <div style={{ 
      display: 'grid', 
      gridTemplateColumns: '1fr 360px', 
      gap: '24px', 
      height: 'calc(100vh - var(--header-height) - 64px)'
    }}>
      
      {/* Left + Center Area (Workspace Queue) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', height: '100%', overflowY: 'auto' }}>
        
        {/* Workspace Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' }}>SELECT PROJECT</label>
              <select
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                style={{
                  padding: '8px 12px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  outline: 'none',
                  minWidth: '220px'
                }}
              >
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.projectNumber})</option>
                ))}
              </select>
            </div>
          </div>
          
          {/* Coverage gauge */}
          <div style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            padding: '10px 20px',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            alignItems: 'center',
            gap: '12px'
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>CONFIRMED COVERAGE</span>
              <span style={{ fontSize: '18px', fontWeight: 800, color: 'var(--status-active)', fontFamily: 'var(--font-display)' }}>
                {coveragePercentage}%
              </span>
            </div>
            <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: `conic-gradient(var(--status-active) ${coveragePercentage}%, var(--bg-tertiary) 0)` }} />
          </div>
        </div>

        {/* Notifications Alert */}
        {message && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '12px 16px',
            borderRadius: 'var(--radius-md)',
            fontSize: '13px',
            border: '1px solid',
            background: message.type === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
            borderColor: message.type === 'success' ? 'var(--accent-secondary)' : 'rgba(239,68,68,0.4)',
            color: message.type === 'success' ? 'var(--accent-secondary)' : '#f87171'
          }}>
            {message.type === 'success' ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
            <span>{message.text}</span>
          </div>
        )}

        {/* Planning Queue */}
        <div className="glass-card" style={{ flex: 1, padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h4 style={{ fontSize: '16px', fontWeight: 600 }}>Project Branches Queue ({branches.length})</h4>
          
          <div className="table-container" style={{ flex: 1 }}>
            {isLoadingQueue ? (
              <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                Loading project branches queue...
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Branch Name</th>
                    <th>SOL ID / Code</th>
                    <th>District / State</th>
                    <th>Planning Status</th>
                  </tr>
                </thead>
                <tbody>
                  {branches.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)' }}>
                        No branches associated with this project.
                      </td>
                    </tr>
                  ) : (
                    branches.map((b) => (
                      <tr 
                        key={b.id} 
                        onClick={() => setSelectedBranchId(b.id)}
                        style={{ 
                          cursor: 'pointer',
                          background: selectedBranchId === b.id ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
                          borderLeft: selectedBranchId === b.id ? '4px solid var(--accent-primary)' : '4px solid transparent'
                        }}
                      >
                        <td style={{ fontWeight: 600 }}>{b.branch.name}</td>
                        <td style={{ fontSize: '13px', fontFamily: 'monospace' }}>
                          {b.branch.solId || '-'} / {b.branch.branchCode}
                        </td>
                        <td>{b.branch.district}, {b.branch.state}</td>
                        <td>
                          <span className="badge" style={{
                            background: b.status === 'ASSIGNMENT_CONFIRMED' ? 'var(--status-active-bg)' : 'rgba(99, 102, 241, 0.1)',
                            color: b.status === 'ASSIGNMENT_CONFIRMED' ? 'var(--status-active)' : 'var(--accent-primary)'
                          }}>
                            {b.status.replace(/_/g, ' ')}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>

      </div>

      {/* Right Area (Assayer Recommendations Panel) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        
        {/* Recommendation Detail panel */}
        <div className="glass-card" style={{ flex: 1, padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px', overflowY: 'auto' }}>
          
          {selectedPb ? (
            <>
              <div>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700 }}>SELECTED BRANCH</span>
                <h4 style={{ fontSize: '18px', fontWeight: 700, margin: '2px 0' }}>{selectedPb.branch.name}</h4>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                  {selectedPb.branch.city}, {selectedPb.branch.district}, {selectedPb.branch.state}
                </p>
                {selectedPb.scheduledDate && (
                  <p style={{ fontSize: '12px', color: 'var(--accent-secondary)', marginTop: '4px', fontWeight: 600 }}>
                    Scheduled Date: {new Date(selectedPb.scheduledDate).toLocaleDateString()}
                  </p>
                )}
              </div>

              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 700, display: 'block', marginBottom: '12px' }}>
                  RECOMMENDED ASSAYERS (PostGIS Proximity)
                </span>

                {isLoadingCandidates ? (
                  <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    Computing proximity sphere...
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    {candidates.length === 0 ? (
                      <div style={{
                        padding: '16px',
                        borderRadius: 'var(--radius-md)',
                        border: '1px dashed var(--border-color)',
                        textAlign: 'center',
                        color: 'var(--text-muted)',
                        fontSize: '13px'
                      }}>
                        <AlertTriangle size={24} style={{ margin: '0 auto 8px auto', color: 'rgba(245,158,11,0.6)' }} />
                        No active candidates within district bounds.
                      </div>
                    ) : (
                      candidates.map((c) => (
                        <div key={c.id} style={{
                          background: 'rgba(255, 255, 255, 0.02)',
                          border: '1px solid var(--border-color)',
                          borderRadius: 'var(--radius-md)',
                          padding: '14px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '10px'
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div>
                              <span style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>{c.displayName}</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                                <Compass size={12} />
                                <span>
                                  {c.distanceKm !== null ? `${c.distanceKm} km away` : 'Fallback Match (State/District)'}
                                </span>
                              </div>
                            </div>
                            <span className="badge" style={{
                              background: 'var(--status-active-bg)',
                              color: 'var(--status-active)',
                              padding: '2px 6px',
                              fontSize: '10px'
                            }}>
                              {c.status}
                            </span>
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px', color: 'var(--text-muted)', gap: '2px' }}>
                            <span>Region: <b>{c.city}, {c.district}</b></span>
                            <span>Phone: <b>{c.phone}</b></span>
                          </div>

                          <div style={{ display: 'flex', gap: '8px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '10px' }}>
                            <a href={`tel:${c.phone}`} className="btn btn-secondary" style={{ flex: 1, padding: '6px 8px', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                              <PhoneCall size={12} /> Call
                            </a>
                            <button 
                              onClick={() => {
                                setSelectedCandidate(c);
                                setShowNegotiationModal(true);
                              }} 
                              className="btn btn-primary" 
                              style={{ flex: 1, padding: '6px 8px', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                            >
                              <Check size={12} /> Assign
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px 0' }}>
              <ShieldAlert size={32} style={{ margin: '0 auto 12px auto' }} />
              <p>Select a branch from the planning queue to view recommendations.</p>
            </div>
          )}

        </div>

      </div>

      {/* Negotiation Modal overlay */}
      {showNegotiationModal && selectedCandidate && selectedPb && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          background: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 100
        }}>
          <form onSubmit={handleConfirmAssignment} className="glass-card" style={{ width: '400px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ fontSize: '18px', fontWeight: 600 }}>Create Assignment Commitment</h4>
              <button type="button" onClick={() => setShowNegotiationModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                Assigning branch <b>{selectedPb.branch.name}</b> to assayer <b>{selectedCandidate.displayName}</b>.
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Negotiated Professional Fee (INR)</label>
                <input 
                  type="number" 
                  value={negotiatingFee}
                  onChange={(e) => setNegotiatingFee(e.target.value)}
                  required
                  style={{
                    padding: '10px',
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    color: '#fff',
                    outline: 'none'
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Proposed Audit Date *</label>
                <input 
                  type="date" 
                  value={negotiatingDate}
                  onChange={(e) => setNegotiatingDate(e.target.value)}
                  required
                  style={{
                    padding: '10px',
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    color: '#fff',
                    outline: 'none'
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
              <button type="button" onClick={() => setShowNegotiationModal(false)} className="btn btn-secondary">
                Cancel
              </button>
              <button 
                type="submit"
                className="btn btn-primary"
              >
                Confirm Commitment
              </button>
            </div>

          </form>
        </div>
      )}

    </div>
  );
};
