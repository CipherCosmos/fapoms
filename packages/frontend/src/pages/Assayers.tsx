import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { Plus, Calendar, Users, UserCheck, UserX, Clock, Edit2, Trash2, User, MapPin, Briefcase, Award, CreditCard, AlertTriangle, Star, ExternalLink, Search, Phone, DollarSign, TrendingUp, CheckCircle, X } from 'lucide-react';
import { AssayerLifecycleStatus } from '@fapoms/shared';

interface Assayer {
  id: string;
  assayerCode: string;
  employeeId: string | null;
  employeeCode: string | null;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string | null;
  phone: string;
  alternatePhone: string | null;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  status: string;
  lifecycleStatus: string;
  organizationId: string | null;
  panNumber: string | null;
  bankAccountNumber: string | null;
  ifscCode: string | null;
  notes: string | null;
  employmentType: string;
  joiningDate: string | null;
  exitDate: string | null;
  terminationDate: string | null;
  managerId: string | null;
  department: string | null;
  region: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactRelation: string | null;
  photograph: string | null;
  skills: string[] | null;
  certifications: { name: string; expiryDate: string }[] | null;
  languages: string[] | null;
  preferredRegions: string[] | null;
  specializations: string[] | null;
  experienceYears: number;
  performanceRating: number;
  leaves: { startDate: string; endDate: string }[] | null;
  workingHours: { start: string; end: string } | null;
  maxDailyWorkload: number;
  maxWeeklyWorkload: number;
}

interface AssayerProfile {
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

interface CommercialProfile {
  id: string;
  baseFee: number;
  hourlyRate: number;
  dailyRate: number;
  travelReimbursement: number;
  accommodationAllowance: number;
  mealAllowance: number;
  currency: string;
  effectiveStartDate: string;
  effectiveEndDate: string | null;
}

const LIFECYCLE_TRANSITIONS: Record<string, string[]> = {
  [AssayerLifecycleStatus.INVITED]: [AssayerLifecycleStatus.DOCUMENT_VERIFICATION],
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: [AssayerLifecycleStatus.BACKGROUND_VERIFICATION, AssayerLifecycleStatus.INACTIVE],
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: [AssayerLifecycleStatus.TRAINING, AssayerLifecycleStatus.INACTIVE],
  [AssayerLifecycleStatus.TRAINING]: [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.INACTIVE],
  [AssayerLifecycleStatus.ACTIVE]: [AssayerLifecycleStatus.ON_LEAVE, AssayerLifecycleStatus.SUSPENDED, AssayerLifecycleStatus.INACTIVE, AssayerLifecycleStatus.RESIGNED],
  [AssayerLifecycleStatus.ON_LEAVE]: [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.INACTIVE],
  [AssayerLifecycleStatus.SUSPENDED]: [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.TERMINATED],
  [AssayerLifecycleStatus.INACTIVE]: [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.ARCHIVED],
  [AssayerLifecycleStatus.RESIGNED]: [AssayerLifecycleStatus.ARCHIVED],
  [AssayerLifecycleStatus.TERMINATED]: [AssayerLifecycleStatus.ARCHIVED],
};

const STATUS_COLORS: Record<string, string> = {
  [AssayerLifecycleStatus.ACTIVE]: '#10b981',
  [AssayerLifecycleStatus.ON_LEAVE]: '#f59e0b',
  [AssayerLifecycleStatus.INVITED]: '#3b82f6',
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: '#8b5cf6',
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: '#8b5cf6',
  [AssayerLifecycleStatus.TRAINING]: '#f59e0b',
  [AssayerLifecycleStatus.SUSPENDED]: '#ef4444',
  [AssayerLifecycleStatus.INACTIVE]: '#6b7280',
  [AssayerLifecycleStatus.RESIGNED]: '#9ca3af',
  [AssayerLifecycleStatus.TERMINATED]: '#dc2626',
  [AssayerLifecycleStatus.ARCHIVED]: '#9ca3af',
};

const INITIALS_BG = ['#6366f1', '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6'];

function getInitialsBg(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return INITIALS_BG[Math.abs(hash) % INITIALS_BG.length];
}

function highlightText(text: string, query: string) {
  if (!query || !text) return text;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <span key={i} style={{ background: 'rgba(99,102,241,0.3)', color: '#fff', borderRadius: '2px', padding: '0 1px' }}>{part}</span>
      : part
  );
}

export const Assayers: React.FC = () => {
  const navigate = useNavigate();
  const [assayers, setAssayers] = useState<Assayer[]>([]);
  const [selectedAssayer, setSelectedAssayer] = useState<Assayer | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<AssayerProfile | null>(null);
  const [commercials, setCommercials] = useState<CommercialProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showLifecycleModal, setShowLifecycleModal] = useState(false);
  const [targetLifecycle, setTargetLifecycle] = useState('');
  const [activeTab, setActiveTab] = useState<'profile' | 'commercial'>('profile');

  const [searchText, setSearchText] = useState('');
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [filterCity, setFilterCity] = useState('');
  const [filterState, setFilterState] = useState('ALL');
  const [filterEmployment, setFilterEmployment] = useState('ALL');
  const [filterSkills, setFilterSkills] = useState('');
  const [filtersExpanded, setFiltersExpanded] = useState(false);

  const filteredAssayers = assayers.filter(a => {
    if (searchText) {
      const q = searchText.toLowerCase();
      if (!a.displayName.toLowerCase().includes(q) &&
          !a.assayerCode.toLowerCase().includes(q) &&
          !(a.email || '').toLowerCase().includes(q) &&
          !a.phone.includes(q)) return false;
    }
    if (filterStatus !== 'ALL' && a.lifecycleStatus !== filterStatus && a.status !== filterStatus) return false;
    if (filterCity && !a.city.toLowerCase().includes(filterCity.toLowerCase())) return false;
    if (filterState !== 'ALL' && a.state !== filterState) return false;
    if (filterEmployment !== 'ALL' && a.employmentType !== filterEmployment) return false;
    if (filterSkills && !(a.skills || []).some(s => s.toLowerCase().includes(filterSkills.toLowerCase()))) return false;
    return true;
  });

  const [baseFee, setBaseFee] = useState(0);
  const [hourlyRate, setHourlyRate] = useState(0);
  const [dailyRate, setDailyRate] = useState(0);
  const [travelReimbursement, setTravelReimbursement] = useState(0);
  const [accommodationAllowance, setAccommodationAllowance] = useState(0);
  const [mealAllowance, setMealAllowance] = useState(0);
  const [currency] = useState('INR');
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState('');

  useEffect(() => { fetchAssayers(); }, []);

  const fetchAssayers = async () => {
    setLoading(true);
    try {
      const data = await api.request<Assayer[]>('/assayers');
      setAssayers(data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const selectAssayer = async (assayer: Assayer) => {
    setSelectedAssayer(assayer);
    setActiveTab('profile');
    setSelectedProfile(null);
    try {
      const [profile, commercial] = await Promise.all([
        api.request<AssayerProfile>(`/assayers/${assayer.id}/profile`, { method: 'GET' }).catch(() => null),
        api.request<CommercialProfile[]>(`/assayers/${assayer.id}/commercial`).catch(() => [] as CommercialProfile[]),
      ]);
      setSelectedProfile(profile);
      setCommercials(commercial);
    } catch (e) { console.error(e); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this assayer profile?')) return;
    try {
      await api.request(`/assayers/${id}`, { method: 'DELETE' });
      if (selectedAssayer?.id === id) { setSelectedAssayer(null); setSelectedProfile(null); }
      fetchAssayers();
    } catch (e) { alert(e instanceof Error ? e.message : 'Failed to delete'); }
  };

  const handleLifecycleTransition = async () => {
    if (!selectedAssayer || !targetLifecycle) return;
    try {
      await api.request(`/assayers/${selectedAssayer.id}/lifecycle`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus: targetLifecycle }),
      });
      setShowLifecycleModal(false);
      setTargetLifecycle('');
      fetchAssayers().then(() => selectAssayer(selectedAssayer));
    } catch (e) { alert(e instanceof Error ? e.message : 'Transition failed'); }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAssayer) return;
    setSubmitting(true);
    try {
      await api.request(`/assayers/${selectedAssayer.id}/commercial`, {
        method: 'POST',
        body: JSON.stringify({
          baseFee, hourlyRate, dailyRate, travelReimbursement,
          accommodationAllowance, mealAllowance, currency,
          effectiveStartDate: new Date(startDate).toISOString(),
          effectiveEndDate: endDate ? new Date(endDate).toISOString() : null,
        }),
      });
      setShowProfileModal(false);
      selectAssayer(selectedAssayer);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to save commercial profile');
    } finally { setSubmitting(false); }
  };

  const totalAssayers = assayers.length;
  const activeAssayers = assayers.filter(a => a.lifecycleStatus === AssayerLifecycleStatus.ACTIVE).length;
  const onLeaveAssayers = assayers.filter(a => a.lifecycleStatus === AssayerLifecycleStatus.ON_LEAVE).length;
  const inactiveAssayers = assayers.filter(a => ![AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.ON_LEAVE].includes(a.lifecycleStatus as any)).length;

  const completionRate = selectedProfile && selectedProfile.totalAssignments > 0
    ? Math.round((selectedProfile.completedAssignments / selectedProfile.totalAssignments) * 100) : 0;
  const onTimeRate = selectedProfile && selectedProfile.completedAssignments > 0
    ? Math.round((selectedProfile.onTimeCompletions / selectedProfile.completedAssignments) * 100) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)' }}>Assayers Workforce</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
            Manage assayer profiles, lifecycle, and commercial billing configurations.
          </p>
        </div>
        <button onClick={() => setShowCreateModal(true)} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Plus size={16} /> Add Assayer
        </button>
      </div>

      {/* ── KPI Dashboard ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ background: 'rgba(99, 102, 241, 0.1)', borderRadius: 'var(--radius-md)', padding: '10px', color: 'var(--accent-primary)' }}><Users size={20} /></div>
          <div><div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>TOTAL</div><div style={{ fontSize: '24px', fontWeight: 800, color: '#fff' }}>{totalAssayers}</div></div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ background: 'rgba(16, 185, 129, 0.1)', borderRadius: 'var(--radius-md)', padding: '10px', color: 'var(--status-active)' }}><UserCheck size={20} /></div>
          <div><div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>ACTIVE</div><div style={{ fontSize: '24px', fontWeight: 800, color: '#fff' }}>{activeAssayers}</div></div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ background: 'rgba(245, 158, 11, 0.1)', borderRadius: 'var(--radius-md)', padding: '10px', color: '#f59e0b' }}><Clock size={20} /></div>
          <div><div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>ON LEAVE</div><div style={{ fontSize: '24px', fontWeight: 800, color: '#fff' }}>{onLeaveAssayers}</div></div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ background: 'rgba(107, 114, 128, 0.1)', borderRadius: 'var(--radius-md)', padding: '10px', color: '#6b7280' }}><UserX size={20} /></div>
          <div><div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>INACTIVE</div><div style={{ fontSize: '24px', fontWeight: 800, color: '#fff' }}>{inactiveAssayers}</div></div>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="glass-card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '200px', position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', zIndex: 1 }} />
            <input type="text" placeholder="Search by name, code, email, phone..." value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              style={{ width: '100%', padding: '8px 12px 8px 34px', fontSize: '13px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', boxSizing: 'border-box' }}
            />
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
              style={{ padding: '8px 12px', fontSize: '12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}>
              <option value="ALL">All Status</option>
              {Object.values(AssayerLifecycleStatus).map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
            <select value={filterEmployment} onChange={(e) => setFilterEmployment(e.target.value)}
              style={{ padding: '8px 12px', fontSize: '12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}>
              <option value="ALL">All Employment</option>
              <option value="INTERNAL">Internal</option>
              <option value="EXTERNAL">External</option>
              <option value="CONTRACT">Contract</option>
            </select>
            <button onClick={() => setFiltersExpanded(!filtersExpanded)}
              style={{ padding: '8px 12px', fontSize: '12px', background: filtersExpanded ? 'rgba(99,102,241,0.1)' : 'none', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: filtersExpanded ? 'var(--accent-primary)' : 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              {filtersExpanded ? 'Fewer Filters −' : 'More Filters +'}
            </button>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{filteredAssayers.length} of {assayers.length} assayers</span>
        </div>
        {filtersExpanded && (
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', paddingTop: '8px', borderTop: '1px solid var(--border-color)' }}>
            <input type="text" placeholder="Filter by city..." value={filterCity}
              onChange={(e) => setFilterCity(e.target.value)}
              style={{ padding: '6px 10px', fontSize: '12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', width: '160px' }}
            />
            <select value={filterState} onChange={(e) => setFilterState(e.target.value)}
              style={{ padding: '6px 10px', fontSize: '12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}>
              <option value="ALL">All States</option>
              {[...new Set(assayers.map(a => a.state))].sort().map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <input type="text" placeholder="Filter by skill..." value={filterSkills}
              onChange={(e) => setFilterSkills(e.target.value)}
              style={{ padding: '6px 10px', fontSize: '12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', width: '160px' }}
            />
          </div>
        )}
      </div>

      {/* ── Main Content ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: '24px', minHeight: 'calc(100vh - 480px)' }}>
        {/* ── List Panel ── */}
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontSize: '15px', fontWeight: 600, margin: 0 }}>Assayers Directory</h2>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', background: 'var(--bg-primary)', padding: '2px 8px', borderRadius: '10px' }}>{filteredAssayers.length}</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
            {loading ? (
              <div style={{ padding: '24px' }}>
                {[1, 2, 3, 4, 5].map(i => (
                  <div key={i} style={{ padding: '12px', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '12px', animation: 'pulse 1.5s infinite' }}>
                    <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'var(--border-color)' }} />
                    <div style={{ flex: 1 }}><div style={{ height: '14px', width: '60%', background: 'var(--border-color)', borderRadius: '4px', marginBottom: '6px' }} /><div style={{ height: '10px', width: '40%', background: 'var(--border-color)', borderRadius: '4px' }} /></div>
                  </div>
                ))}
              </div>
            ) : filteredAssayers.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                <Search size={32} style={{ opacity: 0.4, marginBottom: '12px' }} />
                <div style={{ fontSize: '14px', fontWeight: 600 }}>No assayers found</div>
                <div style={{ fontSize: '12px', marginTop: '4px' }}>Try adjusting your filters</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {filteredAssayers.map((a) => {
                  const isSelected = selectedAssayer?.id === a.id;
                  const sc = STATUS_COLORS[a.lifecycleStatus || a.status] || '#6b7280';
                  const initialsBg = getInitialsBg(a.id);
                  return (
                    <div key={a.id} onClick={() => selectAssayer(a)}
                      style={{
                        padding: '10px 14px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                        background: isSelected ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
                        border: isSelected ? '1px solid rgba(99, 102, 241, 0.3)' : '1px solid transparent',
                        transition: 'all 0.15s', position: 'relative',
                      }}
                      onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)'; }}
                      onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: initialsBg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '14px', fontWeight: 700, flexShrink: 0 }}>
                          {a.displayName.charAt(0).toUpperCase()}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {highlightText(a.displayName, searchText)}
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: sc, flexShrink: 0 }} />
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <span style={{ fontFamily: 'monospace', fontSize: '10px' }}>{a.assayerCode}</span>
                            <span>•</span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '2px' }}><MapPin size={9} /> {a.city}</span>
                            <span>•</span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '2px' }}><Briefcase size={9} /> {a.experienceYears}y</span>
                          </div>
                          {a.skills && a.skills.length > 0 && (
                            <div style={{ display: 'flex', gap: '3px', marginTop: '4px', flexWrap: 'wrap' }}>
                              {a.skills.slice(0, 3).map(s => (
                                <span key={s} style={{ padding: '1px 5px', background: 'rgba(99,102,241,0.08)', color: 'var(--accent-primary)', borderRadius: '4px', fontSize: '9px', fontWeight: 500 }}>{s}</span>
                              ))}
                              {a.skills.length > 3 && (
                                <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>+{a.skills.length - 3}</span>
                              )}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'none', gap: '2px', flexShrink: 0 }} className="assayer-actions">
                          <button onClick={e => { e.stopPropagation(); navigate(`/assayers/${a.id}`); }}
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px', borderRadius: '4px' }}
                            title="Full Profile"><ExternalLink size={13} /></button>
                          <button onClick={e => { e.stopPropagation(); setSelectedAssayer(a); setShowEditModal(true); }}
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px', borderRadius: '4px' }}
                            title="Edit"><Edit2 size={13} /></button>
                        </div>
                      </div>
                      {isSelected && (
                        <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', width: '3px', height: '24px', background: 'var(--accent-primary)', borderRadius: '0 2px 2px 0' }} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Detail Panel ── */}
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {selectedAssayer ? (
            <>
              {/* Profile Header */}
              <div style={{ padding: '20px', borderBottom: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                    <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: getInitialsBg(selectedAssayer.id), display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '18px', fontWeight: 700, flexShrink: 0 }}>
                      {selectedAssayer.displayName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <h2 style={{ fontSize: '20px', fontWeight: 700, margin: 0 }}>{selectedAssayer.displayName}</h2>
                        <span style={{ padding: '3px 10px', borderRadius: '10px', fontSize: '11px', fontWeight: 600,
                          background: `${STATUS_COLORS[selectedAssayer.lifecycleStatus || selectedAssayer.status] || '#6b7280'}20`,
                          color: STATUS_COLORS[selectedAssayer.lifecycleStatus || selectedAssayer.status] || '#6b7280',
                          border: `1px solid ${STATUS_COLORS[selectedAssayer.lifecycleStatus || selectedAssayer.status] || '#6b7280'}40` }}>
                          {selectedAssayer.lifecycleStatus || selectedAssayer.status}
                        </span>
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>{selectedAssayer.assayerCode}</span>
                        <span>•</span>
                        <span>{selectedAssayer.employmentType}</span>
                        <span>•</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}><Briefcase size={11} /> {selectedAssayer.experienceYears}y exp</span>
                        {selectedAssayer.department && <><span>•</span><span>{selectedAssayer.department}</span></>}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <button onClick={() => navigate(`/assayers/${selectedAssayer.id}`)} className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <ExternalLink size={12} /> Full Profile
                    </button>
                    <button onClick={() => setShowEditModal(true)} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Edit2 size={12} /> Edit
                    </button>
                    {LIFECYCLE_TRANSITIONS[selectedAssayer.lifecycleStatus || selectedAssayer.status]?.length > 0 && (
                      <button onClick={() => setShowLifecycleModal(true)} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '11px' }}>
                        Transition
                      </button>
                    )}
                    <button onClick={() => handleDelete(selectedAssayer.id)} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '11px', color: '#ef4444', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Trash2 size={12} /> Delete
                    </button>
                  </div>
                </div>

                {/* Quick Stats Row */}
                {selectedProfile && (
                  <div style={{ display: 'flex', gap: '16px', marginTop: '14px', paddingTop: '14px', borderTop: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ background: 'rgba(99,102,241,0.1)', borderRadius: 'var(--radius-sm)', padding: '6px', color: 'var(--accent-primary)' }}><Briefcase size={13} /></div>
                      <div><div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600 }}>ASSIGNMENTS</div><div style={{ fontSize: '15px', fontWeight: 700 }}>{selectedProfile.totalAssignments}</div></div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ background: 'rgba(16,185,129,0.1)', borderRadius: 'var(--radius-sm)', padding: '6px', color: 'var(--status-active)' }}><CheckCircle size={13} /></div>
                      <div><div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600 }}>COMPLETED</div><div style={{ fontSize: '15px', fontWeight: 700 }}>{selectedProfile.completedAssignments} <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>({completionRate}%)</span></div></div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ background: 'rgba(245,158,11,0.1)', borderRadius: 'var(--radius-sm)', padding: '6px', color: '#f59e0b' }}><DollarSign size={13} /></div>
                      <div><div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600 }}>EARNINGS</div><div style={{ fontSize: '15px', fontWeight: 700 }}>₹{Number(selectedProfile.totalEarnings).toLocaleString()}</div></div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ background: 'rgba(139,92,246,0.1)', borderRadius: 'var(--radius-sm)', padding: '6px', color: '#8b5cf6' }}><Star size={13} /></div>
                      <div><div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600 }}>RATING</div><div style={{ fontSize: '15px', fontWeight: 700 }}>{Number(selectedProfile.averageRating) > 0 ? Number(selectedProfile.averageRating).toFixed(1) : '—'} <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>/ 5</span></div></div>
                    </div>
                    {selectedProfile.lastAssignmentDate && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{ background: 'rgba(59,130,246,0.1)', borderRadius: 'var(--radius-sm)', padding: '6px', color: '#3b82f6' }}><Calendar size={13} /></div>
                        <div><div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600 }}>LAST JOB</div><div style={{ fontSize: '13px', fontWeight: 600 }}>{new Date(selectedProfile.lastAssignmentDate).toLocaleDateString()}</div></div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)' }}>
                {(['profile', 'commercial'] as const).map(tab => (
                  <button key={tab} onClick={() => setActiveTab(tab)}
                    style={{ flex: 1, padding: '12px', background: 'transparent', border: 'none',
                      borderBottom: activeTab === tab ? '2px solid var(--accent-primary)' : '2px solid transparent',
                      color: activeTab === tab ? '#fff' : 'var(--text-muted)', fontWeight: 600, fontSize: '13px', cursor: 'pointer', textTransform: 'uppercase', transition: 'all 0.15s' }}>
                    {tab === 'profile' ? 'Profile' : 'Commercial'}
                  </button>
                ))}
              </div>

              {/* Tab Content */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
                {activeTab === 'profile' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {/* Performance & Stats (from selectedProfile) */}
                    {selectedProfile && (
                      <Section title="Performance & Statistics" icon={<TrendingUp size={14} />}>
                        <Row label="Total Assignments" value={String(selectedProfile.totalAssignments)} />
                        <Row label="Completed" value={`${selectedProfile.completedAssignments} (${completionRate}%)`} />
                        <Row label="Cancelled" value={String(selectedProfile.cancelledAssignments)} />
                        <Row label="On-Time Deliveries" value={`${selectedProfile.onTimeCompletions} (${onTimeRate}%)`} />
                        <Row label="Total Earnings" value={`₹${Number(selectedProfile.totalEarnings).toLocaleString()}`} />
                        <Row label="Average Rating" value={Number(selectedProfile.averageRating) > 0 ? `${Number(selectedProfile.averageRating).toFixed(1)} / 5` : '—'} />
                        <Row label="Performance Rating" value={selectedProfile.performanceRating ? `${selectedProfile.performanceRating} / 5` : '—'} />
                        {selectedProfile.lastAssignmentDate && <Row label="Last Assignment" value={new Date(selectedProfile.lastAssignmentDate).toLocaleDateString()} />}
                        {/* On-Time & Completion bars */}
                        <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '4px' }}>
                          <div>
                            <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>COMPLETION RATE</div>
                            <div style={{ height: '6px', background: 'var(--bg-primary)', borderRadius: '3px', overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${completionRate}%`, background: completionRate >= 80 ? 'var(--status-active)' : completionRate >= 50 ? '#f59e0b' : '#ef4444', borderRadius: '3px', transition: 'width 0.3s' }} />
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>ON-TIME DELIVERY</div>
                            <div style={{ height: '6px', background: 'var(--bg-primary)', borderRadius: '3px', overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${onTimeRate}%`, background: onTimeRate >= 80 ? 'var(--status-active)' : onTimeRate >= 50 ? '#f59e0b' : '#ef4444', borderRadius: '3px', transition: 'width 0.3s' }} />
                            </div>
                          </div>
                        </div>
                      </Section>
                    )}

                    <Section title="Contact Information" icon={<User size={14} />}>
                      <Row label="Code" value={selectedAssayer.assayerCode} code />
                      <Row label="Display Name" value={selectedAssayer.displayName} />
                      <Row label="Email" value={selectedAssayer.email || '-'} />
                      <Row label="Phone" value={selectedAssayer.phone} />
                      <Row label="Alternate Phone" value={selectedAssayer.alternatePhone || '-'} />
                    </Section>

                    <Section title="Address & Location" icon={<MapPin size={14} />}>
                      <Row label="Address" value={selectedAssayer.address} full />
                      <Row label="City" value={selectedAssayer.city} />
                      <Row label="District" value={selectedAssayer.district} />
                      <Row label="State" value={selectedAssayer.state} />
                      <Row label="Pincode" value={selectedAssayer.pincode || '-'} />
                      <Row label="Region" value={selectedAssayer.region || '-'} />
                      <Row label="Coordinates" value={
                        selectedAssayer.latitude && selectedAssayer.longitude ? (
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            <span>{Number(selectedAssayer.latitude).toFixed(4)}, {Number(selectedAssayer.longitude).toFixed(4)}</span>
                            <a href={`https://www.google.com/maps/search/?api=1&query=${selectedAssayer.latitude},${selectedAssayer.longitude}`}
                              target="_blank" rel="noopener noreferrer"
                              style={{ fontSize: '11px', color: 'var(--accent-primary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                              🗺️ Verify
                            </a>
                          </div>
                        ) : '-'
                      } />
                    </Section>

                    <Section title="Employment" icon={<Briefcase size={14} />}>
                      <Row label="Employee ID" value={selectedAssayer.employeeId || '-'} />
                      <Row label="Employee Code" value={selectedAssayer.employeeCode || '-'} />
                      <Row label="Type" value={selectedAssayer.employmentType} />
                      <Row label="Department" value={selectedAssayer.department || '-'} />
                      <Row label="Joining Date" value={selectedAssayer.joiningDate ? new Date(selectedAssayer.joiningDate).toLocaleDateString() : '-'} />
                      <Row label="Manager ID" value={selectedAssayer.managerId || '-'} />
                    </Section>

                    <Section title="Financial & Compliance" icon={<CreditCard size={14} />}>
                      <Row label="PAN Number" value={selectedAssayer.panNumber || '-'} />
                      <Row label="Bank Account" value={selectedAssayer.bankAccountNumber || '-'} />
                      <Row label="IFSC Code" value={selectedAssayer.ifscCode || '-'} />
                    </Section>

                    <Section title="Skills & Qualifications" icon={<Award size={14} />}>
                      <Row label="Experience" value={`${selectedAssayer.experienceYears} years`} />
                      <Row label="Performance" value={selectedAssayer.performanceRating ? `${selectedAssayer.performanceRating}/5` : '-'} />
                      <Row label="Skills" value={selectedAssayer.skills?.join(', ') || '-'} />
                      <Row label="Languages" value={selectedAssayer.languages?.join(', ') || '-'} />
                      <Row label="Specializations" value={selectedAssayer.specializations?.join(', ') || '-'} />
                      <Row label="Preferred Regions" value={selectedAssayer.preferredRegions?.join(', ') || '-'} />
                      <Row label="Certifications" value={selectedAssayer.certifications?.map(c => `${c.name}${c.expiryDate ? ` (exp: ${new Date(c.expiryDate).toLocaleDateString()})` : ''}`).join(', ') || '-'} />
                    </Section>

                    <Section title="Workload" icon={<AlertTriangle size={14} />}>
                      <Row label="Max Daily" value={String(selectedAssayer.maxDailyWorkload)} />
                      <Row label="Max Weekly" value={String(selectedAssayer.maxWeeklyWorkload)} />
                      <Row label="Working Hours" value={selectedAssayer.workingHours ? `${selectedAssayer.workingHours.start} - ${selectedAssayer.workingHours.end}` : '-'} />
                    </Section>

                    <Section title="Emergency Contact" icon={<Phone size={14} />}>
                      <Row label="Name" value={selectedAssayer.emergencyContactName || '-'} />
                      <Row label="Phone" value={selectedAssayer.emergencyContactPhone || '-'} />
                      <Row label="Relation" value={selectedAssayer.emergencyContactRelation || '-'} />
                    </Section>

                    <Section title="Notes" icon={<Star size={14} />}>
                      <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{selectedAssayer.notes || 'No notes'}</div>
                    </Section>
                  </div>
                ) : (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                      <h3 style={{ fontSize: '16px', fontWeight: 600, margin: 0 }}>Commercial Profile History</h3>
                      <button onClick={() => setShowProfileModal(true)} className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Plus size={12} /> Add Rate
                      </button>
                    </div>
                    {commercials.length === 0 ? (
                      <div style={{ padding: '30px', textAlign: 'center', background: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border-color)', color: 'var(--text-muted)' }}>
                        No commercial profile configured.
                      </div>
                    ) : commercials.map(c => (
                      <div key={c.id} style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '16px', marginBottom: '12px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px', marginBottom: '10px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '13px' }}>
                            <Calendar size={14} /> Effective: {new Date(c.effectiveStartDate).toLocaleDateString()} - {c.effectiveEndDate ? new Date(c.effectiveEndDate).toLocaleDateString() : 'Present'}
                          </div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', fontSize: '13px' }}>
                          <div><span style={{ color: 'var(--text-muted)' }}>Base Fee</span><div style={{ fontWeight: 600 }}>₹{c.baseFee}</div></div>
                          <div><span style={{ color: 'var(--text-muted)' }}>Hourly</span><div style={{ fontWeight: 600 }}>₹{c.hourlyRate}</div></div>
                          <div><span style={{ color: 'var(--text-muted)' }}>Daily</span><div style={{ fontWeight: 600 }}>₹{c.dailyRate}</div></div>
                          <div><span style={{ color: 'var(--text-muted)' }}>Travel/km</span><div style={{ fontWeight: 600 }}>₹{c.travelReimbursement}</div></div>
                          <div><span style={{ color: 'var(--text-muted)' }}>Accommodation</span><div style={{ fontWeight: 600 }}>₹{c.accommodationAllowance}</div></div>
                          <div><span style={{ color: 'var(--text-muted)' }}>Meals</span><div style={{ fontWeight: 600 }}>₹{c.mealAllowance}</div></div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
              <Users size={48} style={{ marginBottom: '16px', opacity: 0.3 }} />
              <div style={{ fontSize: '15px', fontWeight: 600 }}>Select an assayer</div>
              <div style={{ fontSize: '12px', marginTop: '4px' }}>Choose from the directory to view details</div>
            </div>
          )}
        </div>
      </div>

      {showCreateModal && <CreateAssayerModal onClose={() => setShowCreateModal(false)} onCreated={() => { setShowCreateModal(false); fetchAssayers(); }} />}
      {showEditModal && selectedAssayer && <EditAssayerModal assayer={selectedAssayer} onClose={() => setShowEditModal(false)} onUpdated={() => { setShowEditModal(false); fetchAssayers().then(() => selectAssayer(selectedAssayer)); }} />}
      {showLifecycleModal && selectedAssayer && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowLifecycleModal(false)}>
          <div className="glass-card" style={{ width: '400px', padding: '24px' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h4 style={{ fontSize: '16px', fontWeight: 600 }}>Transition Lifecycle</h4>
              <button onClick={() => setShowLifecycleModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '18px' }}>&times;</button>
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px' }}>
              {selectedAssayer.displayName} — Current: <b>{selectedAssayer.lifecycleStatus || selectedAssayer.status}</b>
            </p>
            <select value={targetLifecycle} onChange={(e) => setTargetLifecycle(e.target.value)}
              style={{ width: '100%', padding: '10px', marginBottom: '16px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}>
              <option value="">-- Select target status --</option>
              {LIFECYCLE_TRANSITIONS[selectedAssayer.lifecycleStatus || selectedAssayer.status]?.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowLifecycleModal(false)} className="btn btn-secondary">Cancel</button>
              <button onClick={handleLifecycleTransition} disabled={!targetLifecycle} className="btn btn-primary">Confirm</button>
            </div>
          </div>
        </div>
      )}
      {showProfileModal && selectedAssayer && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowProfileModal(false)}>
          <div className="glass-card" style={{ width: '550px', padding: '24px' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 600 }}>Configure Assayer Rates</h3>
              <button onClick={() => setShowProfileModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px' }}>&times;</button>
            </div>
            <form onSubmit={handleSaveProfile}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
                {[{ label: 'Base Fee (₹)', val: baseFee, set: setBaseFee }, { label: 'Hourly Rate (₹)', val: hourlyRate, set: setHourlyRate }, { label: 'Daily Rate (₹)', val: dailyRate, set: setDailyRate }, { label: 'Travel/km (₹)', val: travelReimbursement, set: setTravelReimbursement }, { label: 'Accommodation (₹)', val: accommodationAllowance, set: setAccommodationAllowance }, { label: 'Meal Allowance (₹)', val: mealAllowance, set: setMealAllowance }].map(f => (
                  <div key={f.label}><label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>{f.label}</label>
                    <input type="number" className="form-input" style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={f.val} onChange={(e) => f.set(Number(e.target.value))} required /></div>
                ))}
                <div><label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Start Date</label>
                  <input type="date" className="form-input" style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={startDate} onChange={(e) => setStartDate(e.target.value)} required /></div>
                <div><label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>End Date (Optional)</label>
                  <input type="date" className="form-input" style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                <button type="button" onClick={() => setShowProfileModal(false)} style={{ background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-muted)', padding: '8px 16px', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                <button type="submit" disabled={submitting} style={{ background: 'var(--gradient-neon)', border: 'none', color: '#fff', padding: '8px 16px', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer', boxShadow: 'var(--shadow-neon)' }}>{submitting ? 'Saving...' : 'Save Profile'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

const Section: React.FC<{ title: string; icon: React.ReactNode; children: React.ReactNode }> = ({ title, icon, children }) => (
  <div>
    <h4 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px', letterSpacing: '0.5px' }}>
      {icon} {title}
    </h4>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 20px', padding: '14px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
      {children}
    </div>
  </div>
);

const Row: React.FC<{ label: string; value: React.ReactNode; code?: boolean; full?: boolean }> = ({ label, value, code, full }) => (
  <div style={full ? { gridColumn: '1 / -1' } : {}}>
    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{label}</span>
    <div style={{ fontWeight: 600, fontSize: '13px', fontFamily: code ? 'monospace' : undefined, wordBreak: 'break-word' }}>{value}</div>
  </div>
);

const labelStyle = { display: 'block', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' };
const formFieldStyle = { padding: '10px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff', width: '100%', boxSizing: 'border-box' as const, outline: 'none', fontSize: '13px' };
const formSelectStyle = { padding: '10px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff', width: '100%', boxSizing: 'border-box' as const, outline: 'none', cursor: 'pointer', fontSize: '13px' };

const FIELD_TEXTAREA = new Set(['address', 'notes']);
const FIELD_MONO = new Set(['assayerCode', 'employeeCode', 'employeeId', 'panNumber', 'bankAccountNumber', 'ifscCode']);
const FIELD_TEL = new Set(['phone', 'alternatePhone', 'emergencyContactPhone']);
const FIELD_NUM = new Set(['experienceYears', 'maxDailyWorkload', 'maxWeeklyWorkload']);
const FIELD_TIME = new Set(['workingHoursStart', 'workingHoursEnd']);

const INDIAN_STATES: { value: string; label: string }[] = [
  { value: 'Andhra Pradesh', label: 'Andhra Pradesh' }, { value: 'Arunachal Pradesh', label: 'Arunachal Pradesh' },
  { value: 'Assam', label: 'Assam' }, { value: 'Bihar', label: 'Bihar' },
  { value: 'Chhattisgarh', label: 'Chhattisgarh' }, { value: 'Goa', label: 'Goa' },
  { value: 'Gujarat', label: 'Gujarat' }, { value: 'Haryana', label: 'Haryana' },
  { value: 'Himachal Pradesh', label: 'Himachal Pradesh' }, { value: 'Jharkhand', label: 'Jharkhand' },
  { value: 'Karnataka', label: 'Karnataka' }, { value: 'Kerala', label: 'Kerala' },
  { value: 'Madhya Pradesh', label: 'Madhya Pradesh' }, { value: 'Maharashtra', label: 'Maharashtra' },
  { value: 'Manipur', label: 'Manipur' }, { value: 'Meghalaya', label: 'Meghalaya' },
  { value: 'Mizoram', label: 'Mizoram' }, { value: 'Nagaland', label: 'Nagaland' },
  { value: 'Odisha', label: 'Odisha' }, { value: 'Punjab', label: 'Punjab' },
  { value: 'Rajasthan', label: 'Rajasthan' }, { value: 'Sikkim', label: 'Sikkim' },
  { value: 'Tamil Nadu', label: 'Tamil Nadu' }, { value: 'Telangana', label: 'Telangana' },
  { value: 'Tripura', label: 'Tripura' }, { value: 'Uttar Pradesh', label: 'Uttar Pradesh' },
  { value: 'Uttarakhand', label: 'Uttarakhand' }, { value: 'West Bengal', label: 'West Bengal' },
  { value: 'Andaman and Nicobar Islands', label: 'Andaman and Nicobar Islands' },
  { value: 'Chandigarh', label: 'Chandigarh' }, { value: 'Delhi', label: 'Delhi' },
  { value: 'Jammu and Kashmir', label: 'Jammu and Kashmir' }, { value: 'Ladakh', label: 'Ladakh' },
  { value: 'Lakshadweep', label: 'Lakshadweep' }, { value: 'Puducherry', label: 'Puducherry' },
];

const EMPLOYMENT_TYPES: { value: string; label: string }[] = [
  { value: 'FULL_TIME', label: 'Full Time' }, { value: 'PART_TIME', label: 'Part Time' },
  { value: 'CONTRACT', label: 'Contract' }, { value: 'INTERN', label: 'Intern' },
  { value: 'CONSULTANT', label: 'Consultant' }, { value: 'FREELANCE', label: 'Freelance' },
];

const DEPARTMENTS: { value: string; label: string }[] = [
  { value: 'Operations', label: 'Operations' }, { value: 'Gold Testing', label: 'Gold Testing' },
  { value: 'Diamond Testing', label: 'Diamond Testing' }, { value: 'KYC Verification', label: 'KYC Verification' },
  { value: 'Cash Management', label: 'Cash Management' }, { value: 'Logistics', label: 'Logistics' },
  { value: 'Quality Assurance', label: 'Quality Assurance' }, { value: 'Administration', label: 'Administration' },
  { value: 'Finance', label: 'Finance' }, { value: 'Human Resources', label: 'Human Resources' },
  { value: 'Information Technology', label: 'Information Technology' },
];

const EMERGENCY_CONTACT_RELATIONS: { value: string; label: string }[] = [
  { value: 'Spouse', label: 'Spouse' }, { value: 'Parent', label: 'Parent' },
  { value: 'Sibling', label: 'Sibling' }, { value: 'Child', label: 'Child' },
  { value: 'Friend', label: 'Friend' }, { value: 'Colleague', label: 'Colleague' },
  { value: 'Other', label: 'Other' },
];

const PERFORMANCE_RATINGS: { value: string; label: string }[] = [
  { value: '1', label: '1 - Poor' }, { value: '2', label: '2 - Below Average' },
  { value: '3', label: '3 - Average' }, { value: '4', label: '4 - Good' },
  { value: '5', label: '5 - Excellent' },
];

interface FieldDef { key: string; label: string; required?: boolean; type?: string; full?: boolean; placeholder?: string; options?: { value: string; label: string }[] }

const CREATE_FIELDS: FieldDef[] = [
  { key: 'assayerCode', label: 'Assayer Code', required: true },
  { key: 'firstName', label: 'First Name', required: true },
  { key: 'lastName', label: 'Last Name', required: true },
  { key: 'displayName', label: 'Display Name' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone', required: true },
  { key: 'alternatePhone', label: 'Alternate Phone' },
  { key: 'address', label: 'Address', required: true, full: true },
  { key: 'state', label: 'State', required: true, options: INDIAN_STATES },
  { key: 'district', label: 'District', required: true },
  { key: 'city', label: 'City', required: true },
  { key: 'pincode', label: 'Pincode' },
  { key: 'region', label: 'Region' },
  { key: 'employeeId', label: 'Employee ID' },
  { key: 'employeeCode', label: 'Employee Code' },
  { key: 'employmentType', label: 'Employment Type', options: EMPLOYMENT_TYPES },
  { key: 'department', label: 'Department', options: DEPARTMENTS },
  { key: 'joiningDate', label: 'Joining Date', type: 'date' },
  { key: 'panNumber', label: 'PAN Number' },
  { key: 'bankAccountNumber', label: 'Bank Account' },
  { key: 'ifscCode', label: 'IFSC Code' },
  { key: 'experienceYears', label: 'Experience (years)', type: 'number' },
  { key: 'notes', label: 'Notes', full: true },
];

const CREATE_FIELD_GROUPS: FieldGroup[] = [
  { title: 'Personal', icon: <User size={13} />, fields: ['assayerCode', 'firstName', 'lastName', 'displayName', 'email', 'phone', 'alternatePhone'] },
  { title: 'Address', icon: <MapPin size={13} />, fields: ['address', 'city', 'district', 'state', 'pincode', 'region'] },
  { title: 'Employment', icon: <Briefcase size={13} />, fields: ['employeeId', 'employeeCode', 'employmentType', 'department', 'joiningDate'] },
  { title: 'Financial', icon: <CreditCard size={13} />, fields: ['panNumber', 'bankAccountNumber', 'ifscCode'] },
  { title: 'Skills', icon: <Award size={13} />, fields: ['experienceYears'] },
  { title: 'Other', icon: <Clock size={13} />, fields: ['notes'] },
];

const EDIT_FIELDS: FieldDef[] = [
  { key: 'firstName', label: 'First Name', required: true },
  { key: 'lastName', label: 'Last Name', required: true },
  { key: 'displayName', label: 'Display Name' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone', required: true },
  { key: 'alternatePhone', label: 'Alternate Phone' },
  { key: 'address', label: 'Address', full: true },
  { key: 'state', label: 'State', options: INDIAN_STATES },
  { key: 'district', label: 'District' },
  { key: 'city', label: 'City' },
  { key: 'pincode', label: 'Pincode' },
  { key: 'region', label: 'Region' },
  { key: 'employeeId', label: 'Employee ID' },
  { key: 'employeeCode', label: 'Employee Code' },
  { key: 'employmentType', label: 'Employment Type', options: EMPLOYMENT_TYPES },
  { key: 'department', label: 'Department', options: DEPARTMENTS },
  { key: 'joiningDate', label: 'Joining Date', type: 'date' },
  { key: 'exitDate', label: 'Exit Date', type: 'date' },
  { key: 'terminationDate', label: 'Termination Date', type: 'date' },
  { key: 'managerId', label: 'Manager ID' },
  { key: 'panNumber', label: 'PAN Number' },
  { key: 'bankAccountNumber', label: 'Bank Account' },
  { key: 'ifscCode', label: 'IFSC Code' },
  { key: 'experienceYears', label: 'Experience (years)', type: 'number' },
  { key: 'performanceRating', label: 'Performance Rating', type: 'number', options: PERFORMANCE_RATINGS },
  { key: 'maxDailyWorkload', label: 'Max Daily Workload', type: 'number' },
  { key: 'maxWeeklyWorkload', label: 'Max Weekly Workload', type: 'number' },
  { key: 'emergencyContactName', label: 'Emergency Contact Name' },
  { key: 'emergencyContactPhone', label: 'Emergency Contact Phone' },
  { key: 'emergencyContactRelation', label: 'Emergency Contact Relation', options: EMERGENCY_CONTACT_RELATIONS },
  { key: 'workingHoursStart', label: 'Working Hours Start', placeholder: '09:00' },
  { key: 'workingHoursEnd', label: 'Working Hours End', placeholder: '18:00' },
  { key: 'notes', label: 'Notes', full: true },
];

const renderFormField = (field: FieldDef, form: Record<string, string>, setForm: (v: Record<string, string>) => void) => {
  const val = form[field.key] || '';
  const isTextarea = FIELD_TEXTAREA.has(field.key);
  const isMono = FIELD_MONO.has(field.key);
  const isTel = FIELD_TEL.has(field.key);
  const isNum = FIELD_NUM.has(field.key);
  const isTime = FIELD_TIME.has(field.key);

  const handleChange = (v: string) => {
    if (field.key === 'panNumber' || field.key === 'ifscCode') {
      setForm({ ...form, [field.key]: v.toUpperCase() });
    } else {
      setForm({ ...form, [field.key]: v });
    }
  };

  return (
    <div key={field.key} style={field.full ? { gridColumn: '1 / -1' } : {}}>
      <label style={labelStyle}>
        {field.label}{field.required && <span style={{ color: '#ef4444', marginLeft: '2px' }}>*</span>}
      </label>
      {field.options ? (
        <select value={val} onChange={(e) => setForm({ ...form, [field.key]: e.target.value })} required={field.required} style={formSelectStyle}>
          <option value="">-- Select {field.label.replace(' *', '')} --</option>
          {field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : isTextarea ? (
        <textarea value={val} onChange={(e) => handleChange(e.target.value)} placeholder={field.placeholder || `Enter ${field.label.toLowerCase().replace(' *', '')}`}
          rows={3} style={{ ...formFieldStyle, resize: 'vertical', minHeight: '60px', fontFamily: 'inherit' }} />
      ) : (
        <div style={{ position: 'relative' }}>
          {isTel && <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '12px', pointerEvents: 'none' }}>+91</span>}
          <input
            type={isTime ? 'time' : isTel ? 'tel' : isNum ? 'number' : field.type || 'text'}
            value={val}
            onChange={(e) => handleChange(e.target.value)}
            required={field.required}
            placeholder={
              field.placeholder ||
              (isTel ? '9876543210' : field.key === 'pincode' ? '6-digit pincode' : field.key === 'email' ? 'name@example.com' : field.key === 'panNumber' ? 'ABCDE1234F' : field.key === 'ifscCode' ? 'HDFC0001234' : field.key === 'bankAccountNumber' ? 'Account number' : field.key === 'managerId' ? 'Manager UUID' : `Enter ${field.label.toLowerCase().replace(' *', '')}`)
            }
            inputMode={isNum || field.key === 'pincode' || isTel ? 'numeric' : field.key === 'email' ? 'email' : 'text'}
            maxLength={field.key === 'pincode' ? 6 : field.key === 'panNumber' ? 10 : field.key === 'ifscCode' ? 11 : undefined}
            min={isNum ? 0 : undefined}
            step={isNum ? '1' : undefined}
            autoComplete="off"
            style={{
              ...formFieldStyle,
              fontFamily: isMono ? 'monospace' : 'inherit',
              textTransform: (field.key === 'panNumber' || field.key === 'ifscCode') ? 'uppercase' : 'none',
              letterSpacing: isMono ? '0.5px' : 'normal',
              ...(isTel ? { paddingLeft: '42px' } : {}),
            }} />
        </div>
      )}
    </div>
  );
};

const CreateAssayerModal: React.FC<{ onClose: () => void; onCreated: () => void }> = ({ onClose, onCreated }) => {
  const [form, setForm] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true);
    try {
      const body: any = {};
      CREATE_FIELDS.forEach(f => {
        const val = form[f.key];
        if (val !== undefined && val !== '') {
          if (f.type === 'number') body[f.key] = Number(val);
          else if (f.type === 'date') body[f.key] = new Date(val).toISOString();
          else body[f.key] = val;
        }
      });
      await api.request('/assayers', { method: 'POST', body: JSON.stringify(body) });
      onCreated();
    } catch (err) { alert(err instanceof Error ? err.message : 'Failed to create assayer'); }
    finally { setSubmitting(false); }
  };

  const fieldsMap = new Map(CREATE_FIELDS.map(f => [f.key, f]));
  const currentGroup = CREATE_FIELD_GROUPS[activeTab];

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="glass-card" style={{ width: '680px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '20px 24px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <h3 style={{ fontSize: '18px', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <User size={18} style={{ color: 'var(--accent-primary)' }} /> Add Assayer
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px', borderRadius: '4px' }}><X size={18} /></button>
        </div>
        <div style={{ display: 'flex', gap: '0', padding: '16px 24px 0', borderBottom: '1px solid var(--border-color)', overflowX: 'auto' }}>
          {CREATE_FIELD_GROUPS.map((group, i) => (
            <button key={group.title} onClick={() => setActiveTab(i)}
              style={{
                padding: '8px 14px', background: 'transparent', border: 'none',
                borderBottom: activeTab === i ? '2px solid var(--accent-primary)' : '2px solid transparent',
                color: activeTab === i ? 'var(--accent-primary)' : 'var(--text-muted)',
                fontWeight: activeTab === i ? 700 : 500, fontSize: '12px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap',
                transition: 'all 0.15s', opacity: activeTab === i ? 1 : 0.6,
              }}>
              {group.icon} {group.title}
            </button>
          ))}
        </div>
        <form onSubmit={handleSubmit} style={{ overflowY: 'auto', padding: '20px 24px', flex: 1 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>{currentGroup.title}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              {currentGroup.fields.map(key => {
                const field = fieldsMap.get(key);
                return field ? renderFormField(field, form, setForm) : null;
              })}
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '16px', marginTop: '20px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              {activeTab > 0 && (
                <button type="button" onClick={() => setActiveTab(activeTab - 1)} className="btn btn-secondary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  ← Previous
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" onClick={onClose} className="btn btn-secondary" style={{ padding: '8px 16px', fontSize: '12px' }}>Cancel</button>
              {activeTab < CREATE_FIELD_GROUPS.length - 1 ? (
                <button type="button" onClick={() => setActiveTab(activeTab + 1)} className="btn btn-primary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  Next →
                </button>
              ) : (
                <button type="submit" disabled={submitting} className="btn btn-primary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {submitting ? 'Saving...' : <><CheckCircle size={14} /> Create Assayer</>}
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

interface FieldGroup {
  title: string;
  icon: React.ReactNode;
  fields: string[];
}

const EDIT_FIELD_GROUPS: FieldGroup[] = [
  { title: 'Personal', icon: <User size={13} />, fields: ['firstName', 'lastName', 'displayName', 'email', 'phone', 'alternatePhone'] },
  { title: 'Address', icon: <MapPin size={13} />, fields: ['address', 'city', 'district', 'state', 'pincode', 'region'] },
  { title: 'Employment', icon: <Briefcase size={13} />, fields: ['employeeId', 'employeeCode', 'employmentType', 'department', 'joiningDate', 'exitDate', 'terminationDate', 'managerId'] },
  { title: 'Financial', icon: <CreditCard size={13} />, fields: ['panNumber', 'bankAccountNumber', 'ifscCode'] },
  { title: 'Skills', icon: <Award size={13} />, fields: ['experienceYears', 'performanceRating', 'maxDailyWorkload', 'maxWeeklyWorkload'] },
  { title: 'Emergency', icon: <Phone size={13} />, fields: ['emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation'] },
  { title: 'Other', icon: <Clock size={13} />, fields: ['workingHoursStart', 'workingHoursEnd', 'notes'] },
];

const EditAssayerModal: React.FC<{ assayer: Assayer; onClose: () => void; onUpdated: () => void }> = ({ assayer, onClose, onUpdated }) => {
  const [form, setForm] = useState<Record<string, string>>(() => {
    const f: Record<string, string> = {};
    EDIT_FIELDS.forEach(field => {
      let val = (assayer as any)[field.key];
      if (field.key === 'workingHoursStart') val = assayer.workingHours?.start || '';
      else if (field.key === 'workingHoursEnd') val = assayer.workingHours?.end || '';
      else if (field.key === 'latitude' || field.key === 'longitude') val = val !== null && val !== undefined ? String(val) : '';
      else if (field.key === 'joiningDate' || field.key === 'exitDate' || field.key === 'terminationDate') val = val ? new Date(val).toISOString().split('T')[0] : '';
      else val = val !== null && val !== undefined ? String(val) : '';
      f[field.key] = val;
    });
    return f;
  });
  const [activeEditTab, setActiveEditTab] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true);
    try {
      const body: any = {};
      EDIT_FIELDS.forEach(field => {
        const val = form[field.key];
        if (val !== undefined && val !== '') {
          if (field.key === 'workingHoursStart' || field.key === 'workingHoursEnd') {
            body.workingHours = { ...(assayer.workingHours || {}), [field.key === 'workingHoursStart' ? 'start' : 'end']: val };
          } else if (field.type === 'number') body[field.key] = Number(val);
          else if (field.type === 'date') body[field.key] = new Date(val).toISOString();
          else body[field.key] = val;
        }
      });
      await api.request(`/assayers/${assayer.id}`, { method: 'PUT', body: JSON.stringify(body) });
      onUpdated();
    } catch (err) { alert(err instanceof Error ? err.message : 'Failed to update assayer'); }
    finally { setSubmitting(false); }
  };

  const statusColor = STATUS_COLORS[assayer.lifecycleStatus || assayer.status] || '#6b7280';

  const fieldsMap = new Map(EDIT_FIELDS.map(f => [f.key, f]));
  const currentGroup = EDIT_FIELD_GROUPS[activeEditTab];

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="glass-card" style={{ width: '680px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ padding: '20px 24px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h3 style={{ fontSize: '18px', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Edit2 size={18} style={{ color: 'var(--accent-primary)' }} /> Edit Assayer
            </h3>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontFamily: 'monospace' }}>{assayer.assayerCode}</span>
              <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: statusColor }} />
                {assayer.lifecycleStatus || assayer.status}
              </span>
              <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
              <span>{assayer.displayName}</span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px', borderRadius: '4px' }}><X size={18} /></button>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: '0', padding: '16px 24px 0', borderBottom: '1px solid var(--border-color)', overflowX: 'auto' }}>
          {EDIT_FIELD_GROUPS.map((group, i) => (
            <button key={group.title} onClick={() => setActiveEditTab(i)}
              style={{
                padding: '8px 14px', background: 'transparent', border: 'none',
                borderBottom: activeEditTab === i ? '2px solid var(--accent-primary)' : '2px solid transparent',
                color: activeEditTab === i ? 'var(--accent-primary)' : 'var(--text-muted)',
                fontWeight: activeEditTab === i ? 700 : 500, fontSize: '12px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap',
                transition: 'all 0.15s', opacity: activeEditTab === i ? 1 : 0.6,
              }}>
              {group.icon} {group.title}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} style={{ overflowY: 'auto', padding: '20px 24px', flex: 1 }}>
          {/* Tab content */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>{currentGroup.title}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              {currentGroup.fields.map(key => {
                const field = fieldsMap.get(key);
                return field ? renderFormField(field, form, setForm) : null;
              })}
            </div>
          </div>

          {/* Navigation + Submit */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '16px', marginTop: '20px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              {activeEditTab > 0 && (
                <button type="button" onClick={() => setActiveEditTab(activeEditTab - 1)} className="btn btn-secondary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  ← Previous
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" onClick={onClose} className="btn btn-secondary" style={{ padding: '8px 16px', fontSize: '12px' }}>Cancel</button>
              {activeEditTab < EDIT_FIELD_GROUPS.length - 1 ? (
                <button type="button" onClick={() => setActiveEditTab(activeEditTab + 1)} className="btn btn-primary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  Next →
                </button>
              ) : (
                <button type="submit" disabled={submitting} className="btn btn-primary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {submitting ? 'Saving...' : <><CheckCircle size={14} /> Save Changes</>}
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
