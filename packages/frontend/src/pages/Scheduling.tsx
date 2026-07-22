import React, { useState, useEffect } from 'react';
import { 
  CalendarDays, 
  AlertCircle, 
  RefreshCw, 
  Calendar, 
  Check, 
  ShieldAlert, 
  Plus, 
  Search, 
  Clock, 
  CheckCircle2, 
  History
} from 'lucide-react';
import { ScheduleStatus } from '@fapoms/shared';
import { api } from '../services/api';

interface Schedule {
  id: string;
  projectId: string;
  assayerId: string;
  scheduledDate: string;
  status: ScheduleStatus;
  remarks: string | null;
  assayer: { displayName: string; };
  project: { name: string; };
  assignment: { assignmentNumber: string; };
}


interface AssignmentOption {
  id: string;
  assignmentNumber: string;
  assayer: { displayName: string; };
  projectBranch: { branch: { name: string; state: string; }; };
}

interface TimelineEvent {
  id: string;
  type: string;
  title: string;
  description: string;
  timestamp: string;
  user: string;
}

const STATE_CODES = [
  { value: 'AP', label: 'AP - Andhra Pradesh' },
  { value: 'AR', label: 'AR - Arunachal Pradesh' },
  { value: 'AS', label: 'AS - Assam' },
  { value: 'BR', label: 'BR - Bihar' },
  { value: 'CG', label: 'CG - Chhattisgarh' },
  { value: 'GA', label: 'GA - Goa' },
  { value: 'GJ', label: 'GJ - Gujarat' },
  { value: 'HR', label: 'HR - Haryana' },
  { value: 'HP', label: 'HP - Himachal Pradesh' },
  { value: 'JK', label: 'JK - Jammu and Kashmir' },
  { value: 'JH', label: 'JH - Jharkhand' },
  { value: 'KA', label: 'KA - Karnataka' },
  { value: 'KL', label: 'KL - Kerala' },
  { value: 'LD', label: 'LD - Lakshadweep' },
  { value: 'MP', label: 'MP - Madhya Pradesh' },
  { value: 'MH', label: 'MH - Maharashtra' },
  { value: 'MN', label: 'MN - Manipur' },
  { value: 'ML', label: 'ML - Meghalaya' },
  { value: 'MZ', label: 'MZ - Mizoram' },
  { value: 'NL', label: 'NL - Nagaland' },
  { value: 'OD', label: 'OD - Odisha' },
  { value: 'PY', label: 'PY - Puducherry' },
  { value: 'PB', label: 'PB - Punjab' },
  { value: 'RJ', label: 'RJ - Rajasthan' },
  { value: 'SK', label: 'SK - Sikkim' },
  { value: 'TN', label: 'TN - Tamil Nadu' },
  { value: 'TG', label: 'TG - Telangana' },
  { value: 'TR', label: 'TR - Tripura' },
  { value: 'UP', label: 'UP - Uttar Pradesh' },
  { value: 'UK', label: 'UK - Uttarakhand' },
  { value: 'WB', label: 'WB - West Bengal' },
  { value: 'AN', label: 'AN - Andaman and Nicobar' },
  { value: 'CH', label: 'CH - Chandigarh' },
  { value: 'DN', label: 'DN - Dadra and Nagar Haveli' },
  { value: 'DD', label: 'DD - Daman and Diu' },
  { value: 'DL', label: 'DL - Delhi' },
  { value: 'LA', label: 'LA - Ladakh' },
];

export const Scheduling: React.FC = () => {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [assignments, setAssignments] = useState<AssignmentOption[]>([]);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState('');
  const [scheduleDate, setScheduleDate] = useState(new Date().toISOString().split('T')[0]);
  const [scheduleRemarks, setScheduleRemarks] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // Selected schedule detail & timeline states
  const [selectedSchId, setSelectedSchId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [isLoadingTimeline, setIsLoadingTimeline] = useState(false);

  // Reschedule form states
  const [newRescheduleDate, setNewRescheduleDate] = useState(new Date().toISOString().split('T')[0]);
  const [rescheduleRemarks, setRescheduleRemarks] = useState('');
  const [isRescheduling, setIsRescheduling] = useState(false);

  const [lookupDate, setLookupDate] = useState('');
  const [lookupState, setLookupState] = useState('MH');
  const [lookupResult, setLookupResult] = useState<string | null>(null);

  useEffect(() => {
    loadSchedules();
  }, []);

  useEffect(() => {
    if (selectedSchId) {
      loadTimeline(selectedSchId);
      const activeSch = schedules.find(s => s.id === selectedSchId);
      if (activeSch) {
        setNewRescheduleDate(activeSch.scheduledDate);
      }
    } else {
      setTimeline([]);
    }
  }, [selectedSchId, schedules]);

  const loadSchedules = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.request<Schedule[]>('/schedules');
      setSchedules(data);
      if (data.length > 0 && !selectedSchId) {
        setSelectedSchId(data[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch schedules');
    } finally {
      setIsLoading(false);
    }
  };

  const loadTimeline = async (id: string) => {
    setIsLoadingTimeline(true);
    try {
      const data = await api.request<TimelineEvent[]>(`/schedules/${id}/timeline`);
      setTimeline(data);
    } catch (err) {
      console.error('Failed to load schedule timeline events');
    } finally {
      setIsLoadingTimeline(false);
    }
  };

  const loadAcceptedAssignments = async () => {
    try {
      const response = await fetch(`/api/v1/assignments?status=ACCEPTED&limit=100`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('fapoms_token')}` }
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setAssignments(data.data);
        if (data.data && data.data.length > 0) {
          setSelectedAssignmentId(data.data[0].id);
        }
      }
    } catch (err) {
      console.error('Failed to load assignments');
    }
  };

  const openCreateModal = () => {
    setSelectedAssignmentId('');
    setScheduleDate(new Date().toISOString().split('T')[0]);
    setScheduleRemarks('');
    setShowCreateModal(true);
    loadAcceptedAssignments();
  };

  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAssignmentId || !scheduleDate) return;
    setIsCreating(true);
    try {
      await api.request('/schedules', {
        method: 'POST',
        body: JSON.stringify({
          assignmentId: selectedAssignmentId,
          scheduledDate: scheduleDate,
          remarks: scheduleRemarks || undefined,
        }),
      });
      setShowCreateModal(false);
      loadSchedules();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create schedule');
    } finally {
      setIsCreating(false);
    }
  };

  const handleCheckHoliday = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lookupDate) return;
    try {
      const token = localStorage.getItem('fapoms_token');
      const response = await fetch(`/api/v1/holidays/check?date=${lookupDate}&stateCode=${lookupState}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setLookupResult(data.data.isHoliday ? 'HOLIDAY_CONFLICT' : 'COMPLIANT');
      }
    } catch (err) {
      setLookupResult('ERROR');
    }
  };

  const handleTransition = async (id: string, targetStatus: ScheduleStatus) => {
    try {
      await api.request(`/schedules/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus, remarks: 'Transitioned via UI dashboard' }),
      });
      loadSchedules();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to transition schedule');
    }
  };

  const handleRescheduleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSchId || !newRescheduleDate) return;
    setIsRescheduling(true);
    try {
      await api.request(`/schedules/${selectedSchId}/transition`, {
        method: 'POST',
        body: JSON.stringify({
          targetStatus: ScheduleStatus.RESCHEDULED,
          scheduledDate: newRescheduleDate,
          remarks: rescheduleRemarks || 'Audit Rescheduled via scheduling panel',
        }),
      });
      setRescheduleRemarks('');
      loadSchedules();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to reschedule audit');
    } finally {
      setIsRescheduling(false);
    }
  };

  const selectedSch = schedules.find(s => s.id === selectedSchId);

  const todayStr = new Date().toISOString().split('T')[0];
  const totalSchedules = schedules.length;
  const todaySchedules = schedules.filter(s => s.scheduledDate === todayStr).length;
  const confirmedSchedules = schedules.filter(s => s.status === ScheduleStatus.CONFIRMED).length;
  const tentativeSchedules = schedules.filter(s => s.status === ScheduleStatus.TENTATIVE).length;

  const filteredSchedules = schedules.filter(s => {
    const matchesSearch = !searchTerm ||
      (s.project?.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (s.assayer?.displayName || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'ALL' || s.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)' }}>Scheduling Dashboard</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
            Monitor and coordinate scheduled audits, view audit trails, and manage rescheduling date/times.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={openCreateModal} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Plus size={16} /> Create Schedule
          </button>
          <button onClick={loadSchedules} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <RefreshCw size={16} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div style={{ display: 'flex', gap: '12px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', padding: '16px', borderRadius: 'var(--radius-md)', color: 'var(--status-inactive)' }}>
          <AlertCircle size={20} />
          <span>{error}</span>
        </div>
      )}

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ background: 'rgba(99, 102, 241, 0.1)', borderRadius: 'var(--radius-md)', padding: '10px', color: 'var(--accent-primary)' }}>
            <CalendarDays size={20} />
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>TOTAL SCHEDULES</div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: '#fff' }}>{totalSchedules}</div>
          </div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ background: 'rgba(16, 185, 129, 0.1)', borderRadius: 'var(--radius-md)', padding: '10px', color: 'var(--status-active)' }}>
            <Calendar size={20} />
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>TODAY'S AUDITS</div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: '#fff' }}>{todaySchedules}</div>
          </div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ background: 'rgba(16, 185, 129, 0.1)', borderRadius: 'var(--radius-md)', padding: '10px', color: 'var(--status-active)' }}>
            <CheckCircle2 size={20} />
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>CONFIRMED</div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: '#fff' }}>{confirmedSchedules}</div>
          </div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ background: 'rgba(245, 158, 11, 0.1)', borderRadius: 'var(--radius-md)', padding: '10px', color: '#f59e0b' }}>
            <Clock size={20} />
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>TENTATIVE</div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: '#fff' }}>{tentativeSchedules}</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '24px', alignItems: 'start' }}>
        
        {/* Left Column - List */}
        <div className="glass-card" style={{ padding: 0, overflowX: 'auto' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', gap: '12px', alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                type="text"
                placeholder="Search by project or assayer..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                style={{
                  width: '100%', padding: '8px 12px 8px 32px', background: 'var(--bg-primary)',
                  border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
                  color: '#fff', outline: 'none', fontSize: '13px'
                }}
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{ padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: '13px', outline: 'none' }}
            >
              <option value="ALL">All Status</option>
              <option value={ScheduleStatus.TENTATIVE}>Tentative</option>
              <option value={ScheduleStatus.CONFIRMED}>Confirmed</option>
              <option value={ScheduleStatus.RESCHEDULED}>Rescheduled</option>
              <option value={ScheduleStatus.COMPLETED}>Completed</option>
            </select>
          </div>

          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>Loading schedule records...</div>
          ) : filteredSchedules.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
              <CalendarDays size={48} style={{ margin: '0 auto 16px auto', opacity: 0.5 }} />
              <p>{searchTerm || statusFilter !== 'ALL' ? 'No schedules match your filters.' : 'No active schedules found. Create one from an accepted assignment.'}</p>
            </div>
          ) : (
            <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px', textTransform: 'uppercase' }}>
                  <th style={{ padding: '16px 24px' }}>Assignment ID</th>
                  <th style={{ padding: '16px 24px' }}>Project</th>
                  <th style={{ padding: '16px 24px' }}>Assayer</th>
                  <th style={{ padding: '16px 24px' }}>Date</th>
                  <th style={{ padding: '16px 24px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredSchedules.map((sch) => (
                  <tr 
                    key={sch.id} 
                    onClick={() => setSelectedSchId(sch.id)}
                    style={{ 
                      borderBottom: '1px solid var(--border-color)', 
                      fontSize: '14px',
                      cursor: 'pointer',
                      background: selectedSchId === sch.id ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
                      borderLeft: selectedSchId === sch.id ? '4px solid var(--accent-primary)' : '4px solid transparent'
                    }}
                  >
                    <td style={{ padding: '16px 24px', fontFamily: 'monospace', fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                      {sch.assignment?.assignmentNumber || '-'}
                    </td>
                    <td style={{ padding: '16px 24px', fontWeight: 600 }}>{sch.project?.name || '-'}</td>
                    <td style={{ padding: '16px 24px' }}>{sch.assayer?.displayName}</td>
                    <td style={{ padding: '16px 24px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <Calendar size={14} style={{ color: 'var(--text-muted)' }} />
                        {new Date(sch.scheduledDate).toLocaleDateString()}
                      </div>
                    </td>
                    <td style={{ padding: '16px 24px' }}>
                      <span className="badge" style={{
                        background: sch.status === ScheduleStatus.CONFIRMED ? 'rgba(16, 185, 129, 0.1)' :
                          sch.status === ScheduleStatus.COMPLETED ? 'rgba(99, 102, 241, 0.1)' :
                          sch.status === ScheduleStatus.RESCHEDULED ? 'rgba(245, 158, 11, 0.1)' :
                          'rgba(245, 158, 11, 0.1)',
                        color: sch.status === ScheduleStatus.CONFIRMED ? 'var(--status-active)' :
                          sch.status === ScheduleStatus.COMPLETED ? 'var(--accent-primary)' :
                          'var(--text-secondary)',
                        padding: '4px 8px'
                      }}>
                        {sch.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Right Column - Schedule Details, Rescheduling Form, Audit Trail Timeline */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {selectedSch ? (
            <div className="glass-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div>
                <span style={{ fontSize: '10px', color: 'var(--accent-primary)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Schedule Details</span>
                <h4 style={{ fontSize: '16px', fontWeight: 700, color: '#fff', margin: '4px 0 2px' }}>{selectedSch.project?.name}</h4>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '8px' }}>
                  <span>Assayer: <b>{selectedSch.assayer?.displayName}</b></span>
                  <span>Date: <b>{new Date(selectedSch.scheduledDate).toLocaleDateString()}</b></span>
                  <span>Assignment: <code style={{ color: 'var(--accent-secondary)' }}>{selectedSch.assignment?.assignmentNumber}</code></span>
                </div>
              </div>

              {/* Confirm / Reschedule / Complete state control buttons */}
              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {selectedSch.status === ScheduleStatus.TENTATIVE && (
                  <button 
                    onClick={() => handleTransition(selectedSch.id, ScheduleStatus.CONFIRMED)} 
                    className="btn btn-primary" 
                    style={{ flex: 1, padding: '8px', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                  >
                    <Check size={14} /> Confirm Schedule
                  </button>
                )}
                {selectedSch.status === ScheduleStatus.CONFIRMED && (
                  <button 
                    onClick={() => handleTransition(selectedSch.id, ScheduleStatus.COMPLETED)} 
                    className="btn btn-primary" 
                    style={{ flex: 1, padding: '8px', fontSize: '12px', background: 'rgba(16,185,129,0.2)', border: '1px solid rgba(16,185,129,0.3)', color: 'var(--status-active)' }}
                  >
                    Complete Audit
                  </button>
                )}
                {selectedSch.status === ScheduleStatus.RESCHEDULED && (
                  <button 
                    onClick={() => handleTransition(selectedSch.id, ScheduleStatus.CONFIRMED)} 
                    className="btn btn-primary" 
                    style={{ flex: 1, padding: '8px', fontSize: '12px' }}
                  >
                    Re-Confirm Schedule
                  </button>
                )}
              </div>

              {/* Advanced Rescheduling Date Form */}
              {(selectedSch.status === ScheduleStatus.CONFIRMED || selectedSch.status === ScheduleStatus.RESCHEDULED) && (
                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, display: 'block', marginBottom: '8px' }}>RESCHEDULE AUDIT</span>
                  <form onSubmit={handleRescheduleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>New Target Date</label>
                      <input 
                        type="date" 
                        value={newRescheduleDate} 
                        onChange={(e) => setNewRescheduleDate(e.target.value)} 
                        required 
                        style={{ padding: '8px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '12px' }}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Reason / Remarks</label>
                      <input 
                        type="text" 
                        placeholder="e.g. Assayer requested date change..." 
                        value={rescheduleRemarks} 
                        onChange={(e) => setRescheduleRemarks(e.target.value)} 
                        required 
                        style={{ padding: '8px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '12px' }}
                      />
                    </div>
                    <button type="submit" disabled={isRescheduling} className="btn btn-secondary" style={{ padding: '8px', fontSize: '12px', fontWeight: 600 }}>
                      {isRescheduling ? 'Updating Schedule...' : 'Apply Rescheduling'}
                    </button>
                  </form>
                </div>
              )}

              {/* Audit Trail Timeline */}
              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px' }}>
                  <History size={13} style={{ color: 'var(--accent-secondary)' }} /> AUDIT TRAIL / TIMELINE
                </span>
                
                {isLoadingTimeline ? (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '10px 0' }}>Syncing timeline trail...</div>
                ) : timeline.length === 0 ? (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '10px 0' }}>No trail logs found.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '180px', overflowY: 'auto', paddingRight: '4px' }}>
                    {timeline.map((evt) => (
                      <div key={evt.id} style={{ display: 'flex', gap: '10px', fontSize: '12px' }}>
                        <div style={{ marginTop: '4px', width: '5px', height: '5px', borderRadius: '50%', background: 'var(--accent-primary)', flexShrink: 0 }} />
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontWeight: 600, color: '#fff' }}>{evt.title.replace(/_/g, ' ')}</span>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '11px', marginTop: '1px' }}>{evt.description}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '9px', marginTop: '2px' }}>
                            {new Date(evt.timestamp).toLocaleString()} by {evt.user}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="glass-card" style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)' }}>
              Select a schedule row to view details, timeline audit trails, and perform rescheduling actions.
            </div>
          )}

          {/* Holiday collision validation widget */}
          <div className="glass-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <h4 style={{ fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
              <ShieldAlert size={16} /> Holiday Collision Check
            </h4>
            <form onSubmit={handleCheckHoliday} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="date"
                  value={lookupDate}
                  onChange={(e) => setLookupDate(e.target.value)}
                  required
                  style={{
                    flex: 1, padding: '8px 12px', background: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
                    color: '#fff', outline: 'none', fontSize: '13px'
                  }}
                />
                <select
                  value={lookupState}
                  onChange={(e) => setLookupState(e.target.value)}
                  style={{
                    width: '140px', padding: '8px 12px', background: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
                    color: '#fff', outline: 'none', fontSize: '13px', cursor: 'pointer'
                  }}
                >
                  {STATE_CODES.map(sc => (
                    <option key={sc.value} value={sc.value}>{sc.label}</option>
                  ))}
                </select>
              </div>
              <button type="submit" className="btn btn-primary" style={{ width: '100%', padding: '8px', fontSize: '13px' }}>
                Verify Calendar Date
              </button>
            </form>
            {lookupResult && (
              <div style={{
                padding: '8px 12px', borderRadius: 'var(--radius-sm)', fontSize: '13px',
                fontWeight: 600, textAlign: 'center',
                background: lookupResult === 'COMPLIANT' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                color: lookupResult === 'COMPLIANT' ? 'var(--status-active)' : '#ef4444',
                border: '1px solid',
                borderColor: lookupResult === 'COMPLIANT' ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'
              }}>
                {lookupResult === 'COMPLIANT' ? 'Working day - no conflict' :
                 lookupResult === 'HOLIDAY_CONFLICT' ? 'Holiday conflict - pick another date' :
                 'Error checking calendar'}
              </div>
            )}
          </div>

        </div>

      </div>

      {showCreateModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowCreateModal(false)}>
          <div className="glass-card" style={{ width: '480px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <CalendarDays size={18} /> Create Schedule
              </h3>
              <button onClick={() => setShowCreateModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px' }}>&times;</button>
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              Create a confirmed schedule from an accepted assignment. Holiday and availability checks will run automatically.
            </p>
            <form onSubmit={handleCreateSchedule} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>Accepted Assignment *</label>
                <select
                  value={selectedAssignmentId}
                  onChange={(e) => setSelectedAssignmentId(e.target.value)}
                  required
                  style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }}
                >
                  <option value="">-- Select an accepted assignment --</option>
                  {assignments.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.assignmentNumber} — {a.assayer?.displayName || 'N/A'} — {a.projectBranch?.branch?.name || 'N/A'}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>Scheduled Date *</label>
                <input
                  type="date"
                  value={scheduleDate}
                  onChange={(e) => setScheduleDate(e.target.value)}
                  required
                  style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>Remarks (optional)</label>
                <input
                  type="text"
                  value={scheduleRemarks}
                  onChange={(e) => setScheduleRemarks(e.target.value)}
                  placeholder="Notes for this schedule..."
                  style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }}
                />
              </div>
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                <button type="button" onClick={() => setShowCreateModal(false)} className="btn btn-secondary">Cancel</button>
                <button type="submit" disabled={isCreating} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {isCreating ? 'Creating...' : <><Check size={14} /> Confirm Schedule</>}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
