import React, { useState, useEffect } from 'react';
import { 
  CalendarDays, AlertCircle, RefreshCw, Calendar, CheckCircle2,
  Plus, FileText, Download, ChevronLeft, ChevronRight,
  User, Circle, X
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
  assignment: {
    assignmentNumber: string;
    proposedFee?: number;
    agreedFee?: number | null;
    projectBranch?: {
      id: string;
      branch?: {
        id: string;
        name: string;
        latitude?: number | null;
        longitude?: number | null;
        city?: string;
        state?: string;
        address?: string;
      };
    };
  };
}

interface AssignmentOption {
  id: string;
  assignmentNumber: string;
  assayerId: string;
  assayer: { displayName: string; };
  projectBranch: { branch: { name: string; state: string; }; };
  project: { name: string; };
  proposedFee: number;
  status: string;
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const STATUS_COLORS: Record<string, string> = {
  TENTATIVE: '#f59e0b',
  CONFIRMED: '#10b981',
  RESCHEDULED: '#8b5cf6',
  COMPLETED: '#06b6d4',
};

export const Scheduling: React.FC = () => {
  const today = new Date();
  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [selectedDate, setSelectedDate] = useState<string>(today.toISOString().split('T')[0]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [assignments, setAssignments] = useState<AssignmentOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState('');
  const [scheduleDate, setScheduleDate] = useState(today.toISOString().split('T')[0]);
  const [scheduleRemarks, setScheduleRemarks] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [assayerWorkload, setAssayerWorkload] = useState<{ count: number; schedules: any[] } | null>(null);
  const [selectedSchId, setSelectedSchId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<any[]>([]);

  const selectedSch = schedules.find(s => s.id === selectedSchId);
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const firstDayOfWeek = new Date(currentYear, currentMonth, 1).getDay();

  useEffect(() => { loadSchedules(); }, []);

  useEffect(() => {
    if (error) { const t = setTimeout(() => setError(null), 4000); return () => clearTimeout(t); }
  }, [error]);

  useEffect(() => {
    if (successMsg) { const t = setTimeout(() => setSuccessMsg(null), 3000); return () => clearTimeout(t); }
  }, [successMsg]);

  useEffect(() => {
    if (selectedSch?.assignment?.projectBranch?.id) {
      loadDocumentsForSchedule(selectedSch.assignment.projectBranch.id);
    }
  }, [selectedSchId]);

  const loadSchedules = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.request<Schedule[]>('/schedules');
      setSchedules(data);
    } catch { setError('Failed to load schedules'); }
    finally { setIsLoading(false); }
  };

  const loadAcceptedAssignments = async () => {
    try {
      const data = await api.request<AssignmentOption[]>('/assignments?status=ACCEPTED&limit=100');
      setAssignments(data);
    } catch { console.error('Failed to load assignments'); }
  };

  const loadAssayerWorkload = async (assayerId: string, date: string) => {
    try {
      const res = await api.request<{ count: number; schedules: any[] }>(`/schedules/assayer-workload?assayerId=${assayerId}&date=${date}`);
      setAssayerWorkload(res);
    } catch { setAssayerWorkload(null); }
  };

  const loadDocumentsForSchedule = async (branchId: string) => {
    try {
      const data = await api.request<any[]>(`/documents/project-branch/${branchId}`);
      setDocuments(Array.isArray(data) ? data : []);
    } catch { setDocuments([]); }
  };

  const handlePrevMonth = () => {
    if (currentMonth === 0) { setCurrentMonth(11); setCurrentYear(currentYear - 1); }
    else setCurrentMonth(currentMonth - 1);
  };

  const handleNextMonth = () => {
    if (currentMonth === 11) { setCurrentMonth(0); setCurrentYear(currentYear + 1); }
    else setCurrentMonth(currentMonth + 1);
  };

  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAssignmentId || !scheduleDate) return;
    setIsCreating(true);
    setError(null);
    try {
      await api.request('/schedules', {
        method: 'POST',
        body: JSON.stringify({ assignmentId: selectedAssignmentId, scheduledDate: scheduleDate, remarks: scheduleRemarks || undefined }),
      });
      setShowCreateModal(false);
      setSuccessMsg('Schedule created! Assignment is now Scheduled.');
      setSelectedAssignmentId('');
      setScheduleRemarks('');
      loadSchedules();
    } catch (err: any) {
      setError(err?.message || 'Failed to create schedule');
    } finally { setIsCreating(false); }
  };

  const handleTransition = async (id: string, targetStatus: ScheduleStatus) => {
    setError(null);
    try {
      await api.request(`/schedules/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus, remarks: `Transitioned to ${targetStatus}` }),
      });
      setSuccessMsg(`Schedule marked as ${targetStatus}`);
      loadSchedules();
    } catch (err: any) {
      setError(err?.message || 'Failed to update schedule');
    }
  };

  const getSchedulesForDate = (dateStr: string) => schedules.filter(s => {
    const sd = new Date(s.scheduledDate).toISOString().split('T')[0];
    return sd === dateStr;
  });

  const dateSchedules = getSchedulesForDate(selectedDate);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* ── STAGE 2 HEADER ── */}
      <div style={{ background: 'linear-gradient(90deg, rgba(139,92,246,0.12) 0%, rgba(99,102,241,0.06) 100%)', border: '1px solid rgba(139,92,246,0.25)', padding: '14px 20px', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ backgroundColor: '#8b5cf6', color: '#fff', fontSize: '11px', fontWeight: 800, padding: '4px 8px', borderRadius: '4px' }}>STAGE 2 OF 3</span>
          <div>
            <h3 style={{ fontSize: '16px', fontWeight: 700, margin: 0, color: '#fff' }}>Schedule Dispatch</h3>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Step 2: Create audit schedules on the calendar — assign dates, dispatch PDF packets to assayers
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => window.location.href = '/planning'} style={{ padding: '6px 12px', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '6px', color: '#a5b4fc', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
            ← Stage 1: Planning
          </button>
          <button onClick={() => window.location.href = '/assignments'} style={{ padding: '6px 12px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '6px', color: '#6ee7b7', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
            Stage 3: Field Execution →
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '10px 16px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 'var(--radius-sm)', color: '#f87171', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertCircle size={16} /> {error}
        </div>
      )}
      {successMsg && (
        <div style={{ padding: '10px 16px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 'var(--radius-sm)', color: '#6ee7b7', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <CheckCircle2 size={16} /> {successMsg}
        </div>
      )}

      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
        {/* ── LEFT: CALENDAR ── */}
        <div className="glass-card" style={{ flex: 1, padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0, color: '#fff' }}>{MONTHS[currentMonth]} {currentYear}</h2>
              <button onClick={handlePrevMonth} style={{ background: 'none', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px 8px' }}>
                <ChevronLeft size={16} />
              </button>
              <button onClick={handleNextMonth} style={{ background: 'none', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px 8px' }}>
                <ChevronRight size={16} />
              </button>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button onClick={loadSchedules} className="btn btn-secondary" style={{ padding: '6px 10px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <RefreshCw size={13} /> Refresh
              </button>
              <button onClick={() => { setShowCreateModal(true); loadAcceptedAssignments(); setScheduleDate(today.toISOString().split('T')[0]); setAssayerWorkload(null); }}
                className="btn btn-primary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Plus size={14} /> Create Schedule
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '4px' }}>
            {DAYS.map(d => <div key={d} style={{ textAlign: 'center', fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', padding: '6px 0' }}>{d}</div>)}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
            {Array.from({ length: firstDayOfWeek }).map((_, i) => <div key={`empty-${i}`} />)}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const daySchedules = getSchedulesForDate(dateStr);
              const isToday = dateStr === today.toISOString().split('T')[0];
              const isSelected = dateStr === selectedDate;
              const hasSchedules = daySchedules.length > 0;

              return (
                <div key={day} onClick={() => setSelectedDate(dateStr)}
                  style={{ padding: '6px', cursor: 'pointer', borderRadius: '6px', minHeight: '52px',
                    background: isSelected ? 'rgba(139,92,246,0.15)' : isToday ? 'rgba(139,92,246,0.06)' : 'transparent',
                    border: isSelected ? '1px solid rgba(139,92,246,0.4)' : isToday ? '1px solid rgba(139,92,246,0.15)' : '1px solid transparent' }}>
                  <div style={{ fontSize: '12px', fontWeight: isToday ? 700 : 500, color: isToday ? 'var(--accent-primary)' : '#fff', marginBottom: '4px' }}>{day}</div>
                  {hasSchedules && (
                    <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                      {daySchedules.map(s => (
                        <span key={s.id} style={{ width: '6px', height: '6px', borderRadius: '50%', background: STATUS_COLORS[s.status] || 'var(--text-muted)' }} title={s.status} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: '16px', marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--border-color)', fontSize: '11px', color: 'var(--text-secondary)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><Circle size={8} fill="#10b981" color="#10b981" /> Confirmed</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><Circle size={8} fill="#8b5cf6" color="#8b5cf6" /> Rescheduled</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><Circle size={8} fill="#06b6d4" color="#06b6d4" /> Completed</span>
          </div>
        </div>

        {/* ── RIGHT: SCHEDULES FOR SELECTED DATE ── */}
        <div className="glass-card" style={{ width: '380px', minWidth: '380px', display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 220px)', overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>
              <Calendar size={14} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
              {new Date(selectedDate).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: '10px' }}>
              {dateSchedules.length} schedule{dateSchedules.length !== 1 ? 's' : ''}
            </span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
            {isLoading ? (
              <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '13px' }}>Loading schedules...</div>
            ) : dateSchedules.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)', fontSize: '13px' }}>
                <CalendarDays size={32} style={{ margin: '0 auto 10px', opacity: 0.3, display: 'block' }} />
                <p style={{ fontWeight: 600, marginBottom: '4px', color: 'var(--text-secondary)' }}>No Schedules for this Date</p>
                <p style={{ fontSize: '12px' }}>Click <b>Create Schedule</b> to assign an audit date to a confirmed assignment.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {dateSchedules.map(sch => {
                  const dotColor = STATUS_COLORS[sch.status] || 'var(--text-muted)';
                  return (
                    <div key={sch.id} onClick={() => setSelectedSchId(selectedSchId === sch.id ? null : sch.id)}
                      style={{ padding: '10px 12px', cursor: 'pointer', borderRadius: '8px',
                        background: selectedSchId === sch.id ? 'rgba(139,92,246,0.1)' : 'rgba(255,255,255,0.02)',
                        border: selectedSchId === sch.id ? '1px solid rgba(139,92,246,0.3)' : '1px solid var(--border-color)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <span style={{ fontWeight: 600, fontSize: '13px', color: '#fff' }}>{sch.assignment?.projectBranch?.branch?.name || 'Unknown Branch'}</span>
                        <span style={{ padding: '2px 8px', borderRadius: '8px', fontSize: '10px', fontWeight: 600, background: dotColor + '20', color: dotColor }}>{sch.status}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}><User size={11} /> {sch.assayer?.displayName || '—'}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}><FileText size={11} /> {sch.assignment?.assignmentNumber || '—'}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── SCHEDULE DETAIL PANEL ── */}
      {selectedSch && (
        <div className="glass-card" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
            <div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, marginBottom: '2px' }}>SCHEDULE DETAILS</div>
              <h3 style={{ fontSize: '16px', fontWeight: 700, margin: 0 }}>
                {selectedSch.assignment?.projectBranch?.branch?.name || 'Unknown Branch'}
              </h3>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                {selectedSch.assignment?.assignmentNumber} — {selectedSch.project?.name}
              </span>
            </div>
            <span style={{ padding: '4px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: (STATUS_COLORS[selectedSch.status] || 'var(--text-muted)') + '20', color: STATUS_COLORS[selectedSch.status] || 'var(--text-muted)' }}>
              {selectedSch.status}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr 200px', gap: '16px', marginBottom: '16px' }}>
            <div>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>ASSIGNED ASSAYER</span>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <User size={14} /> {selectedSch.assayer?.displayName || '—'}
              </div>
            </div>
            <div>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>SCHEDULED DATE</span>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Calendar size={14} /> {new Date(selectedSch.scheduledDate).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}
              </div>
            </div>
            <div>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>ACTIONS</span>
              <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                {selectedSch.status === ScheduleStatus.CONFIRMED && (
                  <button onClick={() => handleTransition(selectedSch.id, ScheduleStatus.RESCHEDULED)} className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '11px' }}>
                    Mark Rescheduled
                  </button>
                )}
                {selectedSch.status !== ScheduleStatus.COMPLETED && selectedSch.status !== ScheduleStatus.TENTATIVE && (
                  <button onClick={() => handleTransition(selectedSch.id, ScheduleStatus.COMPLETED)} className="btn btn-primary" style={{ padding: '4px 10px', fontSize: '11px', background: 'rgba(16,185,129,0.2)', border: '1px solid rgba(16,185,129,0.4)', color: '#6ee7b7' }}>
                    Mark Completed
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* PDF documents */}
          <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '8px' }}>
              <FileText size={12} /> PDF AUDIT PACKET
            </span>
            {documents.length === 0 ? (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', padding: '12px', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
                No documents uploaded yet. Upload a master file in the <b>Documents</b> page to trigger OCR processing.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {documents.map(doc => (
                  <div key={doc.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius-sm)', fontSize: '11px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <FileText size={12} style={{ color: 'var(--text-muted)' }} />
                      <span style={{ color: '#fff' }}>{doc.fileName}</span>
                      <span style={{ color: 'var(--text-muted)' }}>({doc.type?.replace(/_/g, ' ')})</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ padding: '1px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 600,
                        background: (doc.status === 'APPROVED' || doc.status === 'RECEIVED') ? 'rgba(16,185,129,0.15)' : doc.status === 'DISPATCHED' ? 'rgba(139,92,246,0.15)' : 'rgba(245,158,11,0.15)',
                        color: (doc.status === 'APPROVED' || doc.status === 'RECEIVED') ? '#10b981' : doc.status === 'DISPATCHED' ? '#8b5cf6' : '#f59e0b' }}>
                        {doc.status}
                      </span>
                      <a href={`/api/v1/documents/${doc.id}/download`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-primary)', display: 'flex' }}>
                        <Download size={12} />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button onClick={() => window.location.href = '/documents'}
              style={{ marginTop: '8px', width: '100%', padding: '6px', fontSize: '10px', background: 'rgba(99,102,241,0.08)', border: '1px dashed rgba(99,102,241,0.3)', borderRadius: 'var(--radius-sm)', color: 'var(--accent-primary)', cursor: 'pointer' }}>
              + Upload / Manage Documents
            </button>
          </div>

          {selectedSch.remarks && (
            <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px', marginTop: '12px' }}>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700 }}>REMARKS</span>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '4px 0 0' }}>{selectedSch.remarks}</p>
            </div>
          )}
        </div>
      )}

      {/* ── CREATE SCHEDULE MODAL ── */}
      {showCreateModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <form onSubmit={handleCreateSchedule} className="glass-card" style={{ width: '480px', display: 'flex', flexDirection: 'column', gap: '16px', padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ fontSize: '16px', fontWeight: 600, margin: 0 }}>Create Audit Schedule</h4>
              <button type="button" onClick={() => setShowCreateModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px' }}>
                <X size={18} />
              </button>
            </div>

            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
              Select a confirmed assignment and pick an audit date. This will move the assignment to <b>Scheduled</b> status.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Assignment *</label>
              <select value={selectedAssignmentId} onChange={e => {
                setSelectedAssignmentId(e.target.value);
                const sel = assignments.find(a => a.id === e.target.value);
                if (sel?.assayerId && scheduleDate) loadAssayerWorkload(sel.assayerId, scheduleDate);
              }} required
                style={{ width: '100%', padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }}>
                <option value="">— Select Assignment —</option>
                {assignments.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.assignmentNumber} — {a.projectBranch?.branch?.name} ({a.assayer?.displayName})
                  </option>
                ))}
              </select>
              {assayerWorkload && (
                <div style={{ fontSize: '11px', marginTop: '4px', padding: '6px 10px', borderRadius: '6px',
                  background: assayerWorkload.count >= 3 ? 'rgba(239,68,68,0.08)' : assayerWorkload.count >= 1 ? 'rgba(245,158,11,0.08)' : 'rgba(16,185,129,0.08)',
                  border: `1px solid ${assayerWorkload.count >= 3 ? 'rgba(239,68,68,0.2)' : assayerWorkload.count >= 1 ? 'rgba(245,158,11,0.2)' : 'rgba(16,185,129,0.2)'}`,
                  color: assayerWorkload.count >= 3 ? '#f87171' : assayerWorkload.count >= 1 ? '#fbbf24' : '#6ee7b7' }}>
                  This assayer has {assayerWorkload.count} schedule{assayerWorkload.count !== 1 ? 's' : ''} this week
                  {assayerWorkload.count >= 3 ? ' (heavy load)' : assayerWorkload.count >= 1 ? ' (moderate load)' : ' (light load)'}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Audit Date *</label>
              <input type="date" value={scheduleDate} onChange={e => {
                setScheduleDate(e.target.value);
                if (selectedAssignmentId) {
                  const sel = assignments.find(a => a.id === selectedAssignmentId);
                  if (sel?.assayerId) loadAssayerWorkload(sel.assayerId, e.target.value);
                }
              }} required
                style={{ width: '100%', padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Remarks (optional)</label>
              <input type="text" value={scheduleRemarks} onChange={e => setScheduleRemarks(e.target.value)} placeholder="e.g., Priority audit, morning slot"
                style={{ width: '100%', padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
              <button type="button" onClick={() => setShowCreateModal(false)} className="btn btn-secondary">Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={isCreating} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {isCreating ? 'Creating...' : <><Calendar size={14} /> Create Schedule</>}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
