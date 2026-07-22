import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Compass, Check, X, AlertTriangle, CheckCircle, ExternalLink, Search } from 'lucide-react';
import { Priority } from '@fapoms/shared';
import { api } from '../services/api';
import { InteractivePlanningMap } from '../components/InteractivePlanningMap';

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
    latitude: number | null;
    longitude: number | null;
  };
  assignment: {
    id: string;
    status: string;
    proposedFee: number;
    agreedFee: number | null;
    assayer?: { displayName: string };
  } | null;
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
  latitude: number | null;
  longitude: number | null;
  score?: number;
  baseFee?: number;
}

const STATUS_OPTIONS = [
  { value: 'ALL', label: 'All Statuses' },
  { value: 'IMPORTED', label: 'Imported' },
  { value: 'PLANNING', label: 'Planning' },
  { value: 'ASSIGNMENT_CONFIRMED', label: 'Confirmed' },
  { value: 'SCHEDULED', label: 'Scheduled' },
];

export const PlanningWorkspace: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(searchParams.get('projectId') || '');
  const [branches, setBranches] = useState<ProjectBranch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [, setIsLoadingQueue] = useState(false);
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false);
  const [routePoints, setRoutePoints] = useState<{ latitude: number; longitude: number }[] | undefined>(undefined);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizedSummary, setOptimizedSummary] = useState<{ totalDistanceKm: number; totalDurationMinutes: number } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [stateFilter, setStateFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [cityFilter, setCityFilter] = useState('');
  const [districtFilter, setDistrictFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('ALL');

  const [showNegotiationModal, setShowNegotiationModal] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null);
  const [selectedCandidateForMap, setSelectedCandidateForMap] = useState<Candidate | null>(null);
  const [negotiatingFee, setNegotiatingFee] = useState('1500');
  const [negotiatingDate, setNegotiatingDate] = useState('2026-07-20');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { loadProjects(); }, []);

  useEffect(() => {
    if (selectedProjectId) {
      loadProjectBranches(selectedProjectId);
      setRoutePoints(undefined);
      setOptimizedSummary(null);
    } else {
      setBranches([]);
      setSelectedBranchId(null);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    const selectedPb = branches.find(b => b.id === selectedBranchId);
    setSelectedCandidateForMap(null);
    if (selectedPb) {
      loadCandidates(selectedPb.branchId);
    } else {
      setCandidates([]);
    }
  }, [selectedBranchId, branches]);

  useEffect(() => {
    if (selectedBranchId && drawerRef.current) {
      drawerRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedBranchId]);

  const handleOptimizeRoute = async (candidate: Candidate) => {
    let assignedBranches = branches.filter(b => b.assignment && b.assignment.assayer?.displayName === candidate.displayName);
    if (assignedBranches.length === 0 && selectedBranchId) {
      const currentPb = branches.find(b => b.id === selectedBranchId);
      if (currentPb) {
        assignedBranches = [currentPb];
      }
    }
    if (assignedBranches.length === 0) {
      alert(`No branch allocations or selected branch found for ${candidate.displayName}.`);
      return;
    }
    const originLat = candidate.latitude ?? assignedBranches[0].branch.latitude;
    const originLng = candidate.longitude ?? assignedBranches[0].branch.longitude;
    if (!originLat || !originLng) { alert('Missing location coordinates: Cannot calculate route.'); return; }
    const destinations = assignedBranches.filter(b => b.branch.latitude !== null && b.branch.longitude !== null).map(b => ({ id: b.branch.id, latitude: b.branch.latitude!, longitude: b.branch.longitude! }));
    if (destinations.length === 0) { alert('No valid branch coordinates found to optimize.'); return; }
    setIsOptimizing(true);
    setOptimizedSummary(null);
    setRoutePoints(undefined);
    try {
      const response = await fetch('/api/v1/geo/route/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('fapoms_token')}` },
        body: JSON.stringify({ origin: { latitude: originLat, longitude: originLng }, destinations, roundTrip: true })
      });
      const resData = await response.json();
      if (response.ok && resData.success) {
        const { optimizedSequence, totalDistanceKm, totalDurationMinutes } = resData.data;
        const points = [{ latitude: originLat, longitude: originLng }];
        for (const destId of optimizedSequence) {
          const matchedBranch = assignedBranches.find(b => b.branch.id === destId);
          if (matchedBranch?.branch.latitude && matchedBranch.branch.longitude) points.push({ latitude: matchedBranch.branch.latitude, longitude: matchedBranch.branch.longitude });
        }
        points.push({ latitude: originLat, longitude: originLng });
        setRoutePoints(points);
        setOptimizedSummary({ totalDistanceKm, totalDurationMinutes });
      } else { alert(resData.message || 'Failed to calculate optimized route.'); }
    } catch { alert('Network request failure while optimizing route.'); }
    finally { setIsOptimizing(false); }
  };

  const loadProjects = async () => {
    try {
      const response = await api.request<ProjectOption[]>('/projects', { method: 'GET' });
      setProjects(response);
      if (response.length > 0) setSelectedProjectId(response[0].id);
    } catch { console.error('Failed to load projects'); }
  };

  const loadProjectBranches = async (projectId: string) => {
    setIsLoadingQueue(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/branches`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('fapoms_token')}` }
      });
      const resData = await response.json();
      if (response.ok && resData.success) {
        setBranches(resData.data);
        setSelectedBranchId(resData.data.length > 0 ? resData.data[0].id : null);
      }
    } catch { console.error('Failed to fetch project branches queue'); }
    finally { setIsLoadingQueue(false); }
  };

  const loadCandidates = async (branchId: string) => {
    setIsLoadingCandidates(true);
    try {
      const response = await api.request<Candidate[]>(`/planning/recommendations?branchId=${branchId}`, { method: 'GET' });
      setCandidates(response);
    } catch { console.error('Failed to load candidate recommendations'); }
    finally { setIsLoadingCandidates(false); }
  };

  const handleConfirmAssignment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBranchId || !selectedCandidate) return;
    setMessage(null);
    setShowNegotiationModal(false);
    try {
      const response = await fetch('/api/v1/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('fapoms_token')}` },
        body: JSON.stringify({ projectBranchId: selectedBranchId, assayerId: selectedCandidate.id, proposedFee: Number(negotiatingFee), scheduledDate: negotiatingDate })
      });
      const resData = await response.json();
      if (response.ok && resData.success) {
        setMessage({ type: 'success', text: `Successfully assigned branch to ${selectedCandidate.displayName} on ${negotiatingDate}!` });
        loadProjectBranches(selectedProjectId);
      } else { setMessage({ type: 'error', text: resData.message || 'Scheduling failed due to validation rules.' }); }
    } catch { setMessage({ type: 'error', text: 'Network connection failed while scheduling assignment.' }); }
  };

  const handleCancelAssignment = async (assignmentId: string) => {
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/assignments/${assignmentId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('fapoms_token')}` },
        body: JSON.stringify({ targetStatus: 'CANCELLED', remarks: 'Operational unassign from map planning workspace.' })
      });
      const resData = await response.json();
      if (response.ok && resData.success) { setMessage({ type: 'success', text: 'Assignment successfully cancelled/unassigned!' }); loadProjectBranches(selectedProjectId); }
      else { setMessage({ type: 'error', text: resData.message || 'Failed to unassign.' }); }
    } catch { setMessage({ type: 'error', text: 'Network request failure during unassign.' }); }
  };

  const statesList = Array.from(new Set(branches.map(b => b.branch?.state).filter(Boolean)));
  const filteredBranches = branches.filter(b => {
    const q = searchTerm.toLowerCase();
    return (b.branch?.name.toLowerCase().includes(q) || b.branch?.branchCode.toLowerCase().includes(q)) &&
      (stateFilter === 'ALL' || b.branch?.state === stateFilter) &&
      (statusFilter === 'ALL' || b.status === statusFilter) &&
      (cityFilter === '' || (b.branch?.city || '').toLowerCase().includes(cityFilter.toLowerCase())) &&
      (districtFilter === '' || (b.branch?.district || '').toLowerCase().includes(districtFilter.toLowerCase())) &&
      (priorityFilter === 'ALL' || b.priority === priorityFilter);
  });
  const selectedPb = branches.find(b => b.id === selectedBranchId);
  const totalCount = branches.length;
  const confirmedCount = branches.filter(b => b.status === 'ASSIGNMENT_CONFIRMED' || b.status === 'SCHEDULED').length;
  const coveragePct = totalCount > 0 ? Number(((confirmedCount / totalCount) * 100).toFixed(1)) : 0;

  const layoutMode = localStorage.getItem('planning_layout') || 'default';
  const [layout, setLayout] = useState(layoutMode);
  const setLayoutMode = (m: string) => { setLayout(m); localStorage.setItem('planning_layout', m); };

  const s = (sel: string, set: (v: string) => void, opts: { value: string; label: string }[]) => (
    <select value={sel} onChange={e => set(e.target.value)}
      style={{ padding: '7px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px', cursor: 'pointer' }}>
      {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  const renderCandidatesList = (horizontal: boolean) => {
    if (isLoadingCandidates) {
      return <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>Searching for assayers...</div>;
    }
    if (candidates.length === 0) {
      return (
        <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
          <AlertTriangle size={20} style={{ margin: '0 auto 6px' }} />
          No suitable assayers found near this branch.
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', gap: '12px', overflowX: horizontal ? 'auto' : 'hidden', flexDirection: horizontal ? 'row' : 'column', paddingBottom: '4px' }}>
        {candidates.map(c => {
          const conf = c.score != null ? Math.round(c.score) : c.distanceKm != null && c.distanceKm < 30 ? 98 : c.distanceKm != null && c.distanceKm < 60 ? 88 : 74;
          return (
            <div key={c.id} style={{
              minWidth: horizontal ? '280px' : 'auto', maxWidth: horizontal ? '300px' : 'auto', flexShrink: horizontal ? 0 : undefined,
              background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '12px',
              display: 'flex', flexDirection: 'column', gap: '8px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>{c.displayName}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '3px', marginTop: '1px' }}>
                    <Compass size={11} /> {c.distanceKm !== null ? `${c.distanceKm} km` : 'Unknown distance'}
                  </div>
                </div>
                <span style={{ padding: '2px 6px', borderRadius: '8px', fontSize: '10px', fontWeight: 600, background: conf >= 90 ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)', color: conf >= 90 ? 'var(--status-active)' : '#f59e0b' }}>
                  {conf}%
                </span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', gap: '12px' }}>
                <span>📞 {c.phone}</span>
                <span>📍 {c.city}</span>
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button onClick={() => setSelectedCandidateForMap(selectedCandidateForMap?.id === c.id ? null : c)}
                  className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px', flex: 1, justifyContent: 'center', background: selectedCandidateForMap?.id === c.id ? 'rgba(139, 92, 246, 0.2)' : 'var(--bg-primary)', borderColor: selectedCandidateForMap?.id === c.id ? 'var(--accent-secondary)' : 'var(--border-color)', color: selectedCandidateForMap?.id === c.id ? 'var(--accent-secondary)' : '#fff' }}>
                  👁️ Map
                </button>
                <button onClick={() => handleOptimizeRoute(c)} disabled={isOptimizing}
                  className="btn btn-secondary" style={{ flex: 1, padding: '4px 8px', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                  <Compass size={11} /> Route
                </button>
                <button onClick={() => {
                  setSelectedCandidate(c);
                  setNegotiatingFee(c.baseFee ? c.baseFee.toString() : '1500');
                  setNegotiatingDate(new Date().toISOString().split('T')[0]);
                  setShowNegotiationModal(true);
                }}
                  className="btn btn-primary" style={{ flex: 1, padding: '4px 8px', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                  <Check size={11} /> Assign
                </button>
              </div>
              {optimizedSummary && routePoints && selectedCandidate?.id === c.id && (
                <div style={{ padding: '6px 8px', background: 'rgba(99,102,241,0.05)', border: '1px dashed rgba(99,102,241,0.3)', borderRadius: 'var(--radius-sm)', fontSize: '10px', color: 'var(--accent-secondary)' }}>
                  Route: {optimizedSummary.totalDistanceKm} km / {optimizedSummary.totalDurationMinutes} min
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', margin: '-32px' }}>
      {/* ── Toolbar: Project select + filters + KPI + Layout ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '10px 32px 0', flexShrink: 0 }}>
        <select value={selectedProjectId} onChange={e => setSelectedProjectId(e.target.value)}
          style={{ padding: '6px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', minWidth: '180px' }}>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name} ({p.projectNumber})</option>)}
        </select>
        {selectedProjectId && (
          <button onClick={() => navigate(`/projects`)} title="Open project"
            style={{ background: 'none', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', cursor: 'pointer', padding: '5px 8px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
            <ExternalLink size={12} /> Project
          </button>
        )}
        {s(stateFilter, setStateFilter, [{ value: 'ALL', label: 'State' }, ...statesList.map(s => ({ value: s, label: s }))])}
        {s(statusFilter, setStatusFilter, STATUS_OPTIONS)}
        {s(priorityFilter, setPriorityFilter, [{ value: 'ALL', label: 'Priority' }, { value: 'LOW', label: 'Low' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'HIGH', label: 'High' }, { value: 'CRITICAL', label: 'Critical' }])}
        <input type="text" placeholder="City..." value={cityFilter} onChange={e => setCityFilter(e.target.value)}
          style={{ width: '90px', padding: '6px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '12px' }} />
        <input type="text" placeholder="District..." value={districtFilter} onChange={e => setDistrictFilter(e.target.value)}
          style={{ width: '90px', padding: '6px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '12px' }} />
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <b style={{ color: 'var(--accent-primary)' }}>{totalCount}</b> branches
          <span style={{ color: 'var(--status-active)' }}>{coveragePct}%</span> confirmed
          <span style={{ color: '#f59e0b' }}>{totalCount - confirmedCount}</span> pending
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px' }}>
          {[['default', 'Map + Drawer'], ['three-col', '3 Column'], ['map-only', 'Map Only']].map(([k, lbl]) => (
            <button key={k} onClick={() => setLayoutMode(k)}
              style={{ background: layout === k ? 'rgba(99,102,241,0.15)' : 'none', border: `1px solid ${layout === k ? 'var(--accent-primary)' : 'var(--border-color)'}`, borderRadius: 'var(--radius-sm)', color: layout === k ? 'var(--accent-primary)' : 'var(--text-secondary)', cursor: 'pointer', padding: '4px 8px', fontSize: '10px', fontWeight: layout === k ? 600 : 400 }}>
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {/* ── Message Banner ── */}
      {message && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 32px', fontSize: '12px', borderBottom: '1px solid', background: message.type === 'success' ? 'rgba(16,185,129,0.06)' : 'rgba(239,68,68,0.06)', borderColor: message.type === 'success' ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)', color: message.type === 'success' ? 'var(--accent-secondary)' : '#f87171', flexShrink: 0 }}>
          {message.type === 'success' ? <CheckCircle size={13} /> : <AlertTriangle size={13} />}
          <span>{message.text}</span>
        </div>
      )}

      {/* ── Layout: Default (Branch list + Map + Drawer) ── */}
      {layout === 'default' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'row', minHeight: 0, gap: '10px', padding: '0 32px 32px' }}>
          <div style={{ width: '280px', minWidth: '280px', display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
            <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Search size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              <input type="text" placeholder="Search branches..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                style={{ flex: 1, background: 'none', border: 'none', color: '#fff', outline: 'none', fontSize: '12px' }} />
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px' }}>
              {branches.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>No branches loaded.</div>
              ) : filteredBranches.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>No branches match filters.</div>
              ) : (
                filteredBranches.map(pb => {
                  const isSelected = pb.id === selectedBranchId;
                  const isAssigned = !!pb.assignment;
                  const statusColor = isAssigned ? 'var(--status-active)' : '#f59e0b';
                  return (
                    <div key={pb.id} onClick={() => setSelectedBranchId(pb.id)}
                      style={{ padding: '8px 10px', cursor: 'pointer', borderRadius: 'var(--radius-sm)', marginBottom: '2px',
                        background: isSelected ? 'rgba(99,102,241,0.2)' : isAssigned ? 'rgba(16,185,129,0.04)' : 'transparent',
                        borderLeft: isSelected ? '3px solid var(--accent-primary)' : isAssigned ? '3px solid rgba(16,185,129,0.4)' : '3px solid transparent',
                        outline: isSelected ? '1px solid rgba(99,102,241,0.3)' : 'none', outlineOffset: '-1px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <div style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                          background: isSelected ? 'var(--accent-primary)' : isAssigned ? 'var(--status-active)' : '#f59e0b',
                          boxShadow: isSelected ? '0 0 6px rgba(99,102,241,0.5)' : 'none' }} />
                        <div style={{ fontSize: '12px', fontWeight: 600, color: '#fff', flex: 1 }}>{pb.branch.name}</div>
                        {isAssigned && (
                          <span style={{ fontSize: '9px', color: 'var(--status-active)', whiteSpace: 'nowrap', fontWeight: 500 }}>✓ Assigned</span>
                        )}
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px', marginLeft: '14px' }}>{pb.branch.city}, {pb.branch.state}</div>
                      <div style={{ display: 'flex', gap: '4px', marginTop: '4px', alignItems: 'center', marginLeft: '14px' }}>
                        <span style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '4px', background: isAssigned ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)', color: statusColor, fontWeight: 500 }}>{pb.status.replace(/_/g, ' ')}</span>
                        {isAssigned && (
                          <span style={{ fontSize: '9px', color: 'var(--status-active)' }}>{pb.assignment?.assayer?.displayName}</span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
            <InteractivePlanningMap fillContainer
              branches={filteredBranches.map(b => ({ id: b.id, name: b.branch.name, latitude: b.branch.latitude, longitude: b.branch.longitude, status: b.status }))}
              selectedBranchId={selectedBranchId}
              onSelectBranch={id => setSelectedBranchId(id)}
              routePoints={routePoints}
              selectedAssayerFromParent={selectedCandidateForMap}
            />
            <div ref={drawerRef} style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              maxHeight: selectedBranchId ? '280px' : '0px', overflow: 'hidden',
              transition: 'max-height 0.3s ease, opacity 0.2s ease', opacity: selectedBranchId ? 1 : 0, zIndex: 20,
              background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
            }}>
              {selectedPb && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>RECOMMENDED ASSAYERS</span>
                      <span style={{ fontSize: '14px', fontWeight: 600, marginLeft: '10px' }}>{selectedPb.branch.name}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{selectedPb.branch.city}, {selectedPb.branch.state}</span>
                      {selectedPb.assignment && (
                        <button onClick={() => handleCancelAssignment(selectedPb.assignment!.id)} className="btn btn-secondary"
                          style={{ padding: '3px 8px', fontSize: '10px', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>Unassign</button>
                      )}
                    </div>
                  </div>
                  <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px' }}>
                    {renderCandidatesList(true)}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Layout: 3-Column (Branch list + Map + Detail panel) ── */}
      {layout === 'three-col' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'row', minHeight: 0, gap: '10px', padding: '0 32px 32px' }}>
          <div style={{ width: '240px', minWidth: '240px', display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
            <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Search size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              <input type="text" placeholder="Search branches..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                style={{ flex: 1, background: 'none', border: 'none', color: '#fff', outline: 'none', fontSize: '12px' }} />
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px' }}>
              {filteredBranches.map(pb => {
                const isSelected = pb.id === selectedBranchId;
                const isAssigned = !!pb.assignment;
                return (
                  <div key={pb.id} onClick={() => setSelectedBranchId(pb.id)}
                    style={{ padding: '8px 10px', cursor: 'pointer', borderRadius: 'var(--radius-sm)', marginBottom: '2px',
                      background: isSelected ? 'rgba(99,102,241,0.2)' : isAssigned ? 'rgba(16,185,129,0.04)' : 'transparent',
                      borderLeft: isSelected ? '3px solid var(--accent-primary)' : isAssigned ? '3px solid rgba(16,185,129,0.4)' : '3px solid transparent',
                      outline: isSelected ? '1px solid rgba(99,102,241,0.3)' : 'none', outlineOffset: '-1px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <div style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                        background: isSelected ? 'var(--accent-primary)' : isAssigned ? 'var(--status-active)' : '#f59e0b',
                        boxShadow: isSelected ? '0 0 6px rgba(99,102,241,0.5)' : 'none' }} />
                      <div style={{ fontSize: '12px', fontWeight: 600, color: '#fff', flex: 1 }}>{pb.branch.name}</div>
                      {isAssigned && (
                        <span style={{ fontSize: '9px', color: 'var(--status-active)', whiteSpace: 'nowrap', fontWeight: 500 }}>✓</span>
                      )}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px', marginLeft: '14px' }}>{pb.branch.city}, {pb.branch.state}</div>
                    <div style={{ display: 'flex', gap: '4px', marginTop: '4px', alignItems: 'center', marginLeft: '14px' }}>
                      <span style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '4px', background: isAssigned ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)', color: isAssigned ? 'var(--status-active)' : '#f59e0b', fontWeight: 500 }}>{pb.status.replace(/_/g, ' ')}</span>
                      {isAssigned && (
                        <span style={{ fontSize: '9px', color: 'var(--status-active)' }}>{pb.assignment?.assayer?.displayName}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
            <InteractivePlanningMap fillContainer
              branches={filteredBranches.map(b => ({ id: b.id, name: b.branch.name, latitude: b.branch.latitude, longitude: b.branch.longitude, status: b.status }))}
              selectedBranchId={selectedBranchId}
              onSelectBranch={id => setSelectedBranchId(id)}
              routePoints={routePoints}
              selectedAssayerFromParent={selectedCandidateForMap}
            />
          </div>

          {selectedPb && (
            <div style={{ width: '340px', minWidth: '340px', display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>BRANCH DETAILS</span>
                  <div style={{ fontSize: '14px', fontWeight: 600, marginTop: '1px' }}>{selectedPb.branch.name}</div>
                </div>
                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{selectedPb.branch.city}</span>
                  {selectedPb.assignment && (
                    <button onClick={() => handleCancelAssignment(selectedPb.assignment!.id)} className="btn btn-secondary"
                      style={{ padding: '2px 6px', fontSize: '9px', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>Unassign</button>
                  )}
                </div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '8px' }}>RECOMMENDED ASSAYERS</span>
                {renderCandidatesList(false)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Layout: Map Only ── */}
      {layout === 'map-only' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '0 0 32px' }}>
          <InteractivePlanningMap fillContainer
            branches={filteredBranches.map(b => ({ id: b.id, name: b.branch.name, latitude: b.branch.latitude, longitude: b.branch.longitude, status: b.status }))}
            selectedBranchId={selectedBranchId}
            onSelectBranch={id => setSelectedBranchId(id)}
            routePoints={routePoints}
            selectedAssayerFromParent={selectedCandidateForMap}
          />
        </div>
      )}

      {/* ── Negotiation Modal ── */}
      {showNegotiationModal && selectedCandidate && selectedPb && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <form onSubmit={handleConfirmAssignment} className="glass-card" style={{ width: '420px', display: 'flex', flexDirection: 'column', gap: '20px', padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ fontSize: '16px', fontWeight: 600 }}>Confirm Assignment</h4>
              <button type="button" onClick={() => setShowNegotiationModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={18} /></button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', padding: '14px', background: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', fontSize: '13px' }}>
              <div><span style={{ color: 'var(--text-muted)' }}>Branch</span><div style={{ fontWeight: 600, color: '#fff', marginTop: '2px' }}>{selectedPb.branch.name}</div></div>
              <div><span style={{ color: 'var(--text-muted)' }}>Assayer</span><div style={{ fontWeight: 600, color: '#fff', marginTop: '2px' }}>{selectedCandidate.displayName}</div></div>
              <div><span style={{ color: 'var(--text-muted)' }}>Location</span><div style={{ fontWeight: 600, color: '#fff', marginTop: '2px' }}>{selectedPb.branch.city}, {selectedPb.branch.state}</div></div>
              <div><span style={{ color: 'var(--text-muted)' }}>Distance</span><div style={{ fontWeight: 600, color: '#fff', marginTop: '2px' }}>{selectedCandidate.distanceKm ?? 'N/A'} km</div></div>
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Fee (INR)</label>
                <input type="number" value={negotiatingFee} onChange={e => setNegotiatingFee(e.target.value)} required
                  style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '14px' }} />
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Audit Date</label>
                <input type="date" value={negotiatingDate} onChange={e => setNegotiatingDate(e.target.value)} required
                  style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '14px' }} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
              <button type="button" onClick={() => setShowNegotiationModal(false)} className="btn btn-secondary">Cancel</button>
              <button type="submit" className="btn btn-primary">Confirm Commitment</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
