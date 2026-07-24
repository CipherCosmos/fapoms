import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Compass, Check, X, AlertTriangle, CheckCircle, ExternalLink, Search, Star, Briefcase, MapPin, Phone, Mail, Award, Clock, DollarSign, Calendar, TrendingUp, Building2 } from 'lucide-react';
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
  zoneId: string | null;
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

interface AssayerDetail {
  id: string;
  assayerCode: string;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode: string | null;
  status: string;
  lifecycleStatus: string;
  employmentType: string;
  joiningDate: string | null;
  department: string | null;
  region: string | null;
  skills: string[] | null;
  certifications: { name: string; expiryDate: string }[] | null;
  languages: string[] | null;
  specializations: string[] | null;
  experienceYears: number;
  performanceRating: number;
  totalAssignments: number;
  completedAssignments: number;
  cancelledAssignments: number;
  onTimeCompletions: number;
  totalEarnings: number;
  lastAssignmentDate: string | null;
  averageRating: number;
  notes: string | null;
}

interface Remark {
  id: string;
  content: string;
  category: string;
  visibility: string;
  authorName: string;
  rating: number | null;
  createdAt: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  PERFORMANCE: '#8b5cf6',
  QUALITY: '#3b82f6',
  BEHAVIORAL: '#f59e0b',
  TRAINING: '#10b981',
  GENERAL: '#6b7280',
};

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
  const [zones, setZones] = useState<{ id: string; name: string }[]>([]);
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
  const [zoneFilter, setZoneFilter] = useState('ALL');

  const [showNegotiationModal, setShowNegotiationModal] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null);
  const [selectedCandidateForMap, setSelectedCandidateForMap] = useState<Candidate | null>(null);
  const [negotiatingFee, setNegotiatingFee] = useState('1500');
  const [commercialBaseFee, setCommercialBaseFee] = useState<number | null>(null);
  const [loadingCommercial, setLoadingCommercial] = useState(false);
  const [negotiatingDate, setNegotiatingDate] = useState('2026-07-20');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showAssayerDetailModal, setShowAssayerDetailModal] = useState(false);
  const [detailAssayer, setDetailAssayer] = useState<AssayerDetail | null>(null);
  const [detailRemarks, setDetailRemarks] = useState<Remark[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showAllCandidates, setShowAllCandidates] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { loadProjects(); loadZones(); }, []);

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
      const data = await api.request<any>('/geo/route/optimize', {
        method: 'POST',
        body: JSON.stringify({ origin: { latitude: originLat, longitude: originLng }, destinations, roundTrip: true })
      });
      const { optimizedSequence, totalDistanceKm, totalDurationMinutes } = data;
      const points = [{ latitude: originLat, longitude: originLng }];
      for (const destId of optimizedSequence) {
        const matchedBranch = assignedBranches.find(b => b.branch.id === destId);
        if (matchedBranch?.branch.latitude && matchedBranch.branch.longitude) points.push({ latitude: matchedBranch.branch.latitude, longitude: matchedBranch.branch.longitude });
      }
      points.push({ latitude: originLat, longitude: originLng });
      setRoutePoints(points);
      setOptimizedSummary({ totalDistanceKm, totalDurationMinutes });
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

  const loadZones = async () => {
    try {
      const data = await api.request<{ id: string; name: string }[]>('/zones?limit=100');
      setZones(data || []);
    } catch { console.error('Failed to load zones'); }
  };

  const loadProjectBranches = async (projectId: string) => {
    setIsLoadingQueue(true);
    setMessage(null);
    try {
      const data = await api.request<ProjectBranch[]>(`/projects/${projectId}/branches`);
      setBranches(data);
      setSelectedBranchId(data.length > 0 ? data[0].id : null);
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

  const loadAssayerDetail = async (assayerId: string) => {
    setLoadingDetail(true);
    setShowAssayerDetailModal(true);
    try {
      const [profile, remarks] = await Promise.all([
        api.request<AssayerDetail>(`/assayers/${assayerId}/profile`, { method: 'GET' }),
        api.request<Remark[]>(`/assayers/${assayerId}/remark`, { method: 'GET' }),
      ]);
      setDetailAssayer(profile);
      setDetailRemarks(Array.isArray(remarks) ? remarks : []);
    } catch { console.error('Failed to load assayer details'); }
    finally { setLoadingDetail(false); }
  };

  const handleConfirmAssignment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBranchId || !selectedCandidate) return;
    setMessage(null);
    setShowNegotiationModal(false);
    try {
      await api.request('/assignments', {
        method: 'POST',
        body: JSON.stringify({ projectBranchId: selectedBranchId, assayerId: selectedCandidate.id, proposedFee: Number(negotiatingFee), scheduledDate: negotiatingDate })
      });
      setMessage({ type: 'success', text: `Successfully assigned branch to ${selectedCandidate.displayName} on ${negotiatingDate}!` });
      loadProjectBranches(selectedProjectId);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Scheduling failed due to validation rules.' });
    }
  };

  const handleCancelAssignment = async (assignmentId: string) => {
    setMessage(null);
    try {
      await api.request(`/assignments/${assignmentId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus: 'CANCELLED', remarks: 'Operational unassign from map planning workspace.' })
      });
      setMessage({ type: 'success', text: 'Assignment successfully cancelled/unassigned!' });
      loadProjectBranches(selectedProjectId);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to unassign.' });
    }
  };

  const statesList = Array.from(new Set(branches.map(b => b.branch?.state).filter(Boolean)));
  const filteredBranches = branches.filter(b => {
    const q = searchTerm.toLowerCase();
    return (b.branch?.name.toLowerCase().includes(q) || b.branch?.branchCode.toLowerCase().includes(q)) &&
      (stateFilter === 'ALL' || b.branch?.state === stateFilter) &&
      (statusFilter === 'ALL' || b.status === statusFilter) &&
      (cityFilter === '' || (b.branch?.city || '').toLowerCase().includes(cityFilter.toLowerCase())) &&
      (districtFilter === '' || (b.branch?.district || '').toLowerCase().includes(districtFilter.toLowerCase())) &&
      (priorityFilter === 'ALL' || b.priority === priorityFilter) &&
      (zoneFilter === 'ALL' || b.zoneId === zoneFilter);
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
    const displayCandidates = showAllCandidates 
      ? candidates 
      : candidates.filter(c => c.distanceKm === null || c.distanceKm <= 700);

    if (displayCandidates.length === 0) {
      return (
        <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={20} style={{ color: 'var(--accent-secondary)' }} />
          <span>No suitable assayers found within 700km.</span>
          {!showAllCandidates && candidates.length > 0 && (
            <button onClick={() => setShowAllCandidates(true)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '10px' }}>
              Show all ({candidates.length}) candidates
            </button>
          )}
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', gap: '12px', overflowX: horizontal ? 'auto' : 'hidden', flexDirection: horizontal ? 'row' : 'column', paddingBottom: '4px' }}>
        {displayCandidates.map(c => {
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
                <button onClick={() => loadAssayerDetail(c.id)}
                  className="btn btn-secondary" style={{ flex: 1, padding: '4px 8px', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                  <Search size={11} /> Details
                </button>
                <button onClick={async () => {
                  setSelectedCandidate(c);
                  setCommercialBaseFee(null);
                  setLoadingCommercial(true);
                  try {
                    const profile = await api.request<{ baseFee: number }>(`/assayers/${c.id}/commercial/active`, { method: 'GET' });
                    const fee = profile.baseFee ?? c.baseFee ?? 1500;
                    setCommercialBaseFee(fee);
                    setNegotiatingFee(fee.toString());
                  } catch {
                    const fee = c.baseFee ?? 1500;
                    setNegotiatingFee(fee.toString());
                  } finally {
                    setLoadingCommercial(false);
                    setNegotiatingDate(new Date().toISOString().split('T')[0]);
                    setShowNegotiationModal(true);
                  }
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
        {s(zoneFilter, setZoneFilter, [{ value: 'ALL', label: 'Zone' }, ...zones.map(z => ({ value: z.id, label: z.name }))])}
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>RECOMMENDED ASSAYERS</span>
                      <span style={{ fontSize: '14px', fontWeight: 600 }}>{selectedPb.branch.name}</span>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer', marginLeft: '12px' }}>
                        <input type="checkbox" checked={showAllCandidates} onChange={(e) => setShowAllCandidates(e.target.checked)} />
                        Show Distant (&gt;700km)
                      </label>
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>RECOMMENDED ASSAYERS</span>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
                    <input type="checkbox" checked={showAllCandidates} onChange={(e) => setShowAllCandidates(e.target.checked)} />
                    Show Distant (&gt;700km)
                  </label>
                </div>
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
          <form onSubmit={handleConfirmAssignment} className="glass-card" style={{ width: '580px', display: 'flex', flexDirection: 'column', gap: '20px', padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ fontSize: '16px', fontWeight: 600 }}>Confirm Assignment</h4>
              <button type="button" onClick={() => setShowNegotiationModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={18} /></button>
            </div>

            {/* Assayer Summary */}
            <div style={{ display: 'flex', gap: '14px', padding: '14px', background: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
              <div style={{ width: '44px', height: '44px', borderRadius: '50%', background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '17px', fontWeight: 700, flexShrink: 0 }}>
                {selectedCandidate.displayName.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '15px', fontWeight: 700, color: '#fff' }}>{selectedCandidate.displayName}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>{selectedCandidate.assayerCode}</div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '6px', fontSize: '11px', color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}><MapPin size={10} /> {selectedCandidate.city}, {selectedCandidate.state}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}><Phone size={10} /> {selectedCandidate.phone}</span>
                  {selectedCandidate.email && <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}><Mail size={10} /> {selectedCandidate.email}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', flexShrink: 0 }}>
                <span style={{ padding: '2px 8px', borderRadius: '8px', fontSize: '11px', fontWeight: 600, background: (selectedCandidate.score ?? 74) >= 90 ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)', color: (selectedCandidate.score ?? 74) >= 90 ? 'var(--status-active)' : '#f59e0b' }}>
                  {selectedCandidate.score != null ? Math.round(selectedCandidate.score) : selectedCandidate.distanceKm != null && selectedCandidate.distanceKm < 30 ? 98 : selectedCandidate.distanceKm != null && selectedCandidate.distanceKm < 60 ? 88 : 74}% Match
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}><Compass size={10} /> {selectedCandidate.distanceKm ?? 'N/A'} km</span>
              </div>
            </div>

            {/* Branch + Assignment details in 2-col grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div style={{ padding: '12px', background: 'rgba(99,102,241,0.05)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(99,102,241,0.15)' }}>
                <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Building2 size={11} /> BRANCH
                </div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>{selectedPb.branch.name}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>{selectedPb.branch.city}, {selectedPb.branch.state}</div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px' }}>Code: {selectedPb.branch.branchCode}</div>
              </div>
              <div style={{ padding: '12px', background: 'rgba(16,185,129,0.05)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(16,185,129,0.15)' }}>
                <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <TrendingUp size={11} /> ASSIGNMENT
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Status: </span>
                  <span style={{ color: '#f59e0b', fontWeight: 600 }}>{selectedPb.status.replace(/_/g, ' ')}</span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Priority: </span>
                  <span style={{ color: '#fff', fontWeight: 600 }}>{selectedPb.priority || 'Normal'}</span>
                </div>
                {selectedCandidate.baseFee != null && (
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Suggested Fee: </span>
                    <span style={{ color: '#f59e0b', fontWeight: 600 }}>₹{selectedCandidate.baseFee.toLocaleString()}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Fee inputs */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <DollarSign size={11} /> Base Fee
                </label>
                <div style={{ padding: '10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: loadingCommercial ? 'var(--text-muted)' : '#f59e0b', fontSize: '14px', fontWeight: 600 }}>
                  {loadingCommercial ? 'Loading...' : commercialBaseFee != null ? `₹${commercialBaseFee.toLocaleString()}` : selectedCandidate.baseFee != null ? `₹${selectedCandidate.baseFee.toLocaleString()}` : 'Not set'}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <TrendingUp size={11} /> Negotiation Fee
                </label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '13px' }}>₹</span>
                  <input type="number" value={negotiatingFee} onChange={e => setNegotiatingFee(e.target.value)} required
                    style={{ width: '100%', padding: '10px 10px 10px 26px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '14px', boxSizing: 'border-box' }} />
                </div>
              </div>
            </div>

            {/* Audit Date */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Calendar size={11} /> Audit Date
              </label>
              <input type="date" value={negotiatingDate} onChange={e => setNegotiatingDate(e.target.value)} required
                style={{ width: '100%', padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '14px', boxSizing: 'border-box' }} />
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
              <button type="button" onClick={() => setShowNegotiationModal(false)} className="btn btn-secondary">Cancel</button>
              <button type="submit" className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Check size={14} /> Confirm Commitment
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Assayer Detail Modal ── */}
      {showAssayerDetailModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 101 }}>
          <div className="glass-card" style={{ width: '800px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', padding: '24px', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexShrink: 0 }}>
              <h4 style={{ fontSize: '16px', fontWeight: 600 }}>Assayer Details</h4>
              <button onClick={() => { setShowAssayerDetailModal(false); setDetailAssayer(null); setDetailRemarks([]); }}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={18} /></button>
            </div>

            <div style={{ overflowY: 'auto', flex: 1, paddingRight: '4px' }}>
              {loadingDetail ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading assayer details...</div>
              ) : !detailAssayer ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Assayer not found.</div>
              ) : (
                <>
                  {(() => {
                    const completionRate = detailAssayer.totalAssignments > 0
                      ? Math.round((detailAssayer.completedAssignments / detailAssayer.totalAssignments) * 100) : 0;
                    const onTimeRate = detailAssayer.completedAssignments > 0
                      ? Math.round((detailAssayer.onTimeCompletions / detailAssayer.completedAssignments) * 100) : 0;
                    return (
                      <>
                        {/* Header Card */}
                        <div className="glass-card" style={{ padding: '20px', borderRadius: 'var(--radius-md)', marginBottom: '16px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                              <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '18px', fontWeight: 700 }}>
                                {detailAssayer.displayName.charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <h3 style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>{detailAssayer.displayName}</h3>
                                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '2px', flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{detailAssayer.assayerCode}</span>
                                  <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                                  <span style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '8px', background: detailAssayer.lifecycleStatus === 'ACTIVE' ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)', color: detailAssayer.lifecycleStatus === 'ACTIVE' ? 'var(--status-active)' : '#f59e0b', fontWeight: 500 }}>{detailAssayer.lifecycleStatus}</span>
                                  <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '3px' }}><Briefcase size={10} /> {detailAssayer.employmentType}</span>
                                  <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '3px' }}><Star size={10} /> {detailAssayer.experienceYears} yrs exp</span>
                                </div>
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                              <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '24px', fontWeight: 700, color: detailAssayer.averageRating >= 4 ? 'var(--status-active)' : detailAssayer.averageRating >= 3 ? '#f59e0b' : '#ef4444' }}>
                                  {Number(detailAssayer.averageRating) > 0 ? Number(detailAssayer.averageRating).toFixed(1) : '—'}
                                </div>
                                <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '1px' }}>Avg Rating</div>
                              </div>
                              <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--accent-primary)' }}>
                                  {Number(detailAssayer.performanceRating).toFixed(1)}
                                </div>
                                <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '1px' }}>Perf. Rating</div>
                              </div>
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border-color)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><MapPin size={11} /> {detailAssayer.city}, {detailAssayer.state}</div>
                            {detailAssayer.phone && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><Phone size={11} /> {detailAssayer.phone}</div>}
                            {detailAssayer.email && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><Mail size={11} /> {detailAssayer.email}</div>}
                            {detailAssayer.department && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><Briefcase size={11} /> {detailAssayer.department}</div>}
                            {detailAssayer.region && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><MapPin size={11} /> Region: {detailAssayer.region}</div>}
                          </div>
                        </div>

                        {/* KPI Cards */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px', marginBottom: '16px' }}>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><Briefcase size={10} /> Total</div>
                            <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--accent-primary)' }}>{detailAssayer.totalAssignments}</div>
                          </div>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><CheckCircle size={10} /> Completed</div>
                            <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--status-active)' }}>{detailAssayer.completedAssignments}</div>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '1px' }}>{completionRate}%</div>
                          </div>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><Clock size={10} /> On-Time</div>
                            <div style={{ fontSize: '22px', fontWeight: 700, color: '#3b82f6' }}>{onTimeRate}%</div>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '1px' }}>{detailAssayer.onTimeCompletions} jobs</div>
                          </div>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><DollarSign size={10} /> Earnings</div>
                            <div style={{ fontSize: '22px', fontWeight: 700, color: '#f59e0b' }}>₹{Number(detailAssayer.totalEarnings).toLocaleString()}</div>
                          </div>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><Calendar size={10} /> Last</div>
                            <div style={{ fontSize: '12px', fontWeight: 600, color: '#fff' }}>
                              {detailAssayer.lastAssignmentDate ? new Date(detailAssayer.lastAssignmentDate).toLocaleDateString() : '—'}
                            </div>
                          </div>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                          {/* Left: Skills & Certifications */}
                          <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
                            <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><Award size={13} /> Skills & Certifications</h4>
                            <div style={{ marginBottom: '10px' }}>
                              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>SKILLS</div>
                              {detailAssayer.skills && detailAssayer.skills.length > 0 ? (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                                  {detailAssayer.skills.map(s => (
                                    <span key={s} style={{ padding: '2px 6px', background: 'rgba(99,102,241,0.1)', color: 'var(--accent-primary)', borderRadius: '8px', fontSize: '10px' }}>{s}</span>
                                  ))}
                                </div>
                              ) : (
                                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No skills recorded</div>
                              )}
                            </div>
                            <div>
                              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>CERTIFICATIONS</div>
                              {detailAssayer.certifications && detailAssayer.certifications.length > 0 ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                  {detailAssayer.certifications.map(c => (
                                    <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 6px', background: 'rgba(16,185,129,0.05)', borderRadius: 'var(--radius-sm)' }}>
                                      <span style={{ fontSize: '11px', color: '#fff' }}>{c.name}</span>
                                      <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Exp: {new Date(c.expiryDate).toLocaleDateString()}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No certifications recorded</div>
                              )}
                            </div>
                          </div>

                          {/* Right: Performance Insights */}
                          <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
                            <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><TrendingUp size={13} /> Performance Insights</h4>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              <div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>COMPLETION RATE</div>
                                <div style={{ height: '6px', background: 'var(--bg-primary)', borderRadius: '3px', overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${completionRate}%`, background: completionRate >= 80 ? 'var(--status-active)' : completionRate >= 50 ? '#f59e0b' : '#ef4444', borderRadius: '3px', transition: 'width 0.3s' }} />
                                </div>
                                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '1px' }}>{completionRate}%</div>
                              </div>
                              <div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>ON-TIME DELIVERY</div>
                                <div style={{ height: '6px', background: 'var(--bg-primary)', borderRadius: '3px', overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${onTimeRate}%`, background: onTimeRate >= 80 ? 'var(--status-active)' : onTimeRate >= 50 ? '#f59e0b' : '#ef4444', borderRadius: '3px', transition: 'width 0.3s' }} />
                                </div>
                                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '1px' }}>{onTimeRate}%</div>
                              </div>
                              {detailAssayer.totalEarnings > 0 && (
                                <div>
                                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>AVERAGE EARNINGS PER JOB</div>
                                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#f59e0b' }}>
                                    ₹{Math.round(Number(detailAssayer.totalEarnings) / Math.max(detailAssayer.completedAssignments, 1)).toLocaleString()}
                                  </div>
                                </div>
                              )}
                              {detailAssayer.experienceYears > 0 && (
                                <div>
                                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>EXPERIENCE</div>
                                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>{detailAssayer.experienceYears} years</div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Remarks */}
                        <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)', marginTop: '14px' }}>
                          <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><Star size={13} /> Reviews & Remarks</h4>
                          {detailRemarks.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '12px', color: 'var(--text-muted)', fontSize: '11px' }}>No remarks yet.</div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '300px', overflowY: 'auto' }}>
                              {detailRemarks.map(r => (
                                <div key={r.id} style={{ padding: '8px 10px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', borderLeft: `3px solid ${CATEGORY_COLORS[r.category] || '#6b7280'}` }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '3px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                                      <span style={{ fontSize: '9px', padding: '1px 4px', borderRadius: '3px', background: `${CATEGORY_COLORS[r.category] || '#6b7280'}20`, color: CATEGORY_COLORS[r.category] || '#6b7280', fontWeight: 600 }}>{r.category}</span>
                                      <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>by {r.authorName}</span>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '1px' }}>
                                      {r.rating != null && [1, 2, 3, 4, 5].map(s => (
                                        <Star key={s} size={9} fill={s <= r.rating! ? '#f59e0b' : 'none'} color={s <= r.rating! ? '#f59e0b' : 'var(--text-muted)'} />
                                      ))}
                                    </div>
                                  </div>
                                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{r.content}</div>
                                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>{new Date(r.createdAt).toLocaleString()}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </>
                    );
                  })()}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
