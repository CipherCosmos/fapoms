import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { Plus, Calendar, Users, UserCheck, UserX, Clock, Edit2, Trash2, User, MapPin, Briefcase, Award, CreditCard, AlertTriangle, Star, ExternalLink, Search } from 'lucide-react';
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

export const Assayers: React.FC = () => {
  const navigate = useNavigate();
  const [assayers, setAssayers] = useState<Assayer[]>([]);
  const [selectedAssayer, setSelectedAssayer] = useState<Assayer | null>(null);
  const [commercials, setCommercials] = useState<CommercialProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showLifecycleModal, setShowLifecycleModal] = useState(false);
  const [targetLifecycle, setTargetLifecycle] = useState('');
  const [activeTab, setActiveTab] = useState<'profile' | 'commercial'>('profile');

  // Filters
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
    try {
      const data = await api.request<CommercialProfile[]>(`/assayers/${assayer.id}/commercial`);
      setCommercials(data);
    } catch (e) { console.error(e); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this assayer profile?')) return;
    try {
      await api.request(`/assayers/${id}`, { method: 'DELETE' });
      if (selectedAssayer?.id === id) setSelectedAssayer(null);
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
  const activeAssayers = assayers.filter(a => a.status === AssayerLifecycleStatus.ACTIVE).length;
  const onLeaveAssayers = assayers.filter(a => a.status === AssayerLifecycleStatus.ON_LEAVE).length;
  const inactiveAssayers = assayers.filter(a => ![AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.ON_LEAVE].includes(a.status as any)).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
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

      <div className="glass-card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '200px', position: 'relative' }}>
            <input type="text" placeholder="Search by name, code, email, phone..." value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              style={{ width: '100%', padding: '8px 12px 8px 34px', fontSize: '13px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}
            />
            <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          </div>
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
          <button type="button" onClick={() => setFiltersExpanded(!filtersExpanded)}
            style={{ padding: '8px 12px', fontSize: '12px', background: 'none', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            {filtersExpanded ? 'Fewer Filters −' : 'More Filters +'}
          </button>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{filteredAssayers.length} of {assayers.length} assayers</span>
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

      <div style={{ display: 'grid', gridTemplateColumns: '350px 1fr', gap: '24px', height: 'calc(100vh - 480px)' }}>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '20px', borderBottom: '1px solid var(--border-color)' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>Assayers Directory</h2>
          </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
                {loading ? (
                  <div style={{ textAlign: 'center', padding: '20px' }}>Loading...</div>
                ) : filteredAssayers.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>No assayers match filters.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {filteredAssayers.map((a) => (
                  <div key={a.id} onClick={() => selectAssayer(a)}
                    style={{ padding: '12px 16px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                      background: selectedAssayer?.id === a.id ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                      border: selectedAssayer?.id === a.id ? '1px solid var(--accent-primary)' : '1px solid transparent' }}>
                    <div style={{ fontWeight: 600, fontSize: '14px' }}>{a.displayName}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{a.assayerCode} • {a.city}, {a.state}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {selectedAssayer ? (
            <>
              <div style={{ padding: '20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h2 style={{ fontSize: '22px', fontWeight: 700, margin: 0 }}>{selectedAssayer.displayName}</h2>
                  <span className="badge" style={{ marginTop: '4px', padding: '4px 10px', fontSize: '12px',
                    background: `${STATUS_COLORS[selectedAssayer.lifecycleStatus || selectedAssayer.status] || '#6b7280'}20`,
                    color: STATUS_COLORS[selectedAssayer.lifecycleStatus || selectedAssayer.status] || '#6b7280',
                    border: `1px solid ${STATUS_COLORS[selectedAssayer.lifecycleStatus || selectedAssayer.status] || '#6b7280'}40` }}>
                    {selectedAssayer.lifecycleStatus || selectedAssayer.status}
                  </span>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    {selectedAssayer.employmentType} • {selectedAssayer.department || 'No Dept'} • {selectedAssayer.experienceYears}y exp
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => navigate(`/assayers/${selectedAssayer.id}`)} className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <ExternalLink size={12} /> Full Profile
                  </button>
                  <button onClick={() => setShowEditModal(true)} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Edit2 size={12} /> Edit
                  </button>
                  {LIFECYCLE_TRANSITIONS[selectedAssayer.lifecycleStatus || selectedAssayer.status]?.length > 0 && (
                    <button onClick={() => setShowLifecycleModal(true)} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px' }}>
                      Transition
                    </button>
                  )}
                  <button onClick={() => handleDelete(selectedAssayer.id)} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px', color: '#ef4444', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Trash2 size={12} /> Delete
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)' }}>
                {(['profile', 'commercial'] as const).map(tab => (
                  <button key={tab} onClick={() => setActiveTab(tab)}
                    style={{ flex: 1, padding: '12px', background: 'transparent', border: 'none',
                      borderBottom: activeTab === tab ? '2px solid var(--accent-primary)' : '2px solid transparent',
                      color: activeTab === tab ? '#fff' : 'var(--text-muted)', fontWeight: 600, fontSize: '13px', cursor: 'pointer', textTransform: 'uppercase' }}>
                    {tab === 'profile' ? 'Profile' : 'Commercial'}
                  </button>
                ))}
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
                {activeTab === 'profile' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
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

                    <Section title="Skills & Experience" icon={<Award size={14} />}>
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

                    <Section title="Emergency Contact" icon={<AlertTriangle size={14} />}>
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
              <Users size={48} style={{ marginBottom: '16px', opacity: 0.5 }} />
              Select an assayer to view details
            </div>
          )}
        </div>
      </div>

      {showCreateModal && <CreateAssayerModal onClose={() => setShowCreateModal(false)} onCreated={() => { setShowCreateModal(false); fetchAssayers(); }} />}
      {showEditModal && selectedAssayer && <EditAssayerModal assayer={selectedAssayer} onClose={() => setShowEditModal(false)} onUpdated={() => { setShowEditModal(false); fetchAssayers().then(() => selectAssayer(selectedAssayer)); }} />}
      {showLifecycleModal && selectedAssayer && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowLifecycleModal(false)}>
          <div className="glass-card" style={{ width: '400px', padding: '24px' }} onClick={(e) => e.stopPropagation()}>
            <h4 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px' }}>Transition Lifecycle Status</h4>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px' }}>
              {selectedAssayer.displayName} — Current: <b>{selectedAssayer.lifecycleStatus || selectedAssayer.status}</b>
            </p>
            <select value={targetLifecycle} onChange={(e) => setTargetLifecycle(e.target.value)}
              style={{ width: '100%', padding: '10px', marginBottom: '16px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}>
              <option value="">-- Select target status --</option>
              {LIFECYCLE_TRANSITIONS[selectedAssayer.lifecycleStatus || selectedAssayer.status]?.map(s => <option key={s} value={s}>{s}</option>)}
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
            <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '20px' }}>Configure Assayer Rates</h3>
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
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 20px', padding: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
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

const inputStyle = { width: '100%', padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' };
const labelStyle = { display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' };
const selectStyle = { width: '100%', padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', cursor: 'pointer' };

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
  { key: 'assayerCode', label: 'Assayer Code *', required: true },
  { key: 'firstName', label: 'First Name *', required: true },
  { key: 'lastName', label: 'Last Name *', required: true },
  { key: 'displayName', label: 'Display Name' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone *', required: true },
  { key: 'alternatePhone', label: 'Alternate Phone' },
  { key: 'address', label: 'Address *', required: true, full: true },
  { key: 'state', label: 'State *', required: true, options: INDIAN_STATES },
  { key: 'district', label: 'District *', required: true },
  { key: 'city', label: 'City *', required: true },
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

const EDIT_FIELDS: FieldDef[] = [
  { key: 'firstName', label: 'First Name *', required: true },
  { key: 'lastName', label: 'Last Name *', required: true },
  { key: 'displayName', label: 'Display Name' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone *', required: true },
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

const renderField = (field: FieldDef, form: any, setForm: (v: any) => void) => (
  <div key={field.key} style={field.full ? { gridColumn: '1 / -1' } : {}}>
    <label style={labelStyle}>{field.label}</label>
    {field.options ? (
      <select value={form[field.key] || ''} onChange={(e) => setForm({ ...form, [field.key]: e.target.value })} required={field.required} style={selectStyle}>
        <option value="">Select...</option>
        {field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    ) : (
      <input type={field.type || 'text'} value={form[field.key] || ''} onChange={(e) => setForm({ ...form, [field.key]: e.target.value })} required={field.required} placeholder={field.placeholder}
        style={inputStyle} />
    )}
  </div>
);

const ModalShell: React.FC<{ title: string; icon: React.ReactNode; onClose: () => void; onSubmit: (e: React.FormEvent) => void; submitting: boolean; submitLabel: string; children: React.ReactNode; wide?: boolean }> = ({ title, icon, onClose, onSubmit, submitting, submitLabel, children, wide }) => (
  <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
    <div className="glass-card" style={{ width: wide ? '700px' : '520px', padding: '24px', maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h3 style={{ fontSize: '18px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>{icon} {title}</h3>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px' }}>&times;</button>
      </div>
      <form onSubmit={onSubmit}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>{children}</div>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '20px', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={submitting} className="btn btn-primary">{submitting ? 'Saving...' : submitLabel}</button>
        </div>
      </form>
    </div>
  </div>
);

const CreateAssayerModal: React.FC<{ onClose: () => void; onCreated: () => void }> = ({ onClose, onCreated }) => {
  const [form, setForm] = useState<Record<string, string>>({});
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

  return (
    <ModalShell title="Add Assayer" icon={<User size={18} />} onClose={onClose} onSubmit={handleSubmit} submitting={submitting} submitLabel="Create Assayer" wide>
      {CREATE_FIELDS.map(f => renderField(f, form, setForm))}
    </ModalShell>
  );
};

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

  return (
    <ModalShell title="Edit Assayer" icon={<Edit2 size={18} />} onClose={onClose} onSubmit={handleSubmit} submitting={submitting} submitLabel="Save Changes" wide>
      {EDIT_FIELDS.map(f => renderField(f, form, setForm))}
    </ModalShell>
  );
};
