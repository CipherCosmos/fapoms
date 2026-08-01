import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { 
  CalendarDays, RefreshCw, Calendar, CheckCircle2,
  Plus, Download, ChevronLeft, ChevronRight,
  X, Sun, Landmark, Umbrella, Filter, List, Grid, ArrowRight
} from 'lucide-react';
import { ScheduleStatus } from '@fapoms/shared';
import { scheduleStatusLabel } from '../utils/statusLabels';
import { api } from '../services/api';
import { queryClient } from '../queryClient';
import { queryKeys } from '../hooks/queryKeys';
import { useSocketInvalidation } from '../hooks/useSocketInvalidation';
import { Modal, FilterSelect, AlertBanner } from '../components/ui';

interface Schedule {
  id: string;
  projectId: string;
  assayerId: string;
  scheduledDate: string;
  completedAt: string | null;
  status: ScheduleStatus;
  remarks: string | null;
  assayer: { displayName: string; };
  project: { name: string; };
  assignment: {
    assignmentNumber: string;
    proposedFee?: number;
    agreedFee?: number | null;
    scheduledDate?: string | null;
    completionDate?: string | null;
    status?: string;
    projectBranch?: {
      id: string;
      status?: string;
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
  projectBranch: { branch: { name: string; city: string; state: string; }; };
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
  const [viewMode, setViewMode] = useState<'calendar' | 'timeline'>('calendar');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState('');
  const [scheduleDate, setScheduleDate] = useState(today.toISOString().split('T')[0]);
  const [scheduleRemarks, setScheduleRemarks] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [assayerWorkload, setAssayerWorkload] = useState<{ count: number; schedules: any[] } | null>(null);
  const [selectedSchId, setSelectedSchId] = useState<string | null>(null);
  const [showRescheduleModal, setShowRescheduleModal] = useState(false);
  const [rescheduleSchId, setRescheduleSchId] = useState<string | null>(null);
  const [rescheduleNewDate, setRescheduleNewDate] = useState(today.toISOString().split('T')[0]);
  const [documents, setDocuments] = useState<any[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  useSocketInvalidation();

  const { data: schedules = [] } = useQuery({
    queryKey: queryKeys.schedules.list,
    queryFn: () => api.request<Schedule[]>('/schedules'),
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
  });

  const { data: assignments = [] } = useQuery({
    queryKey: [...queryKeys.assignments.all, 'available'],
    queryFn: () => api.request<AssignmentOption[]>('/assignments?projectBranchStatus=ASSIGNMENT_CONFIRMED&unscheduledOnly=true&limit=100'),
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
  });

  const { data: holidaysRes } = useQuery({
    queryKey: ['holidays', currentYear],
    queryFn: () => api.request<any[]>(`/holidays?year=${currentYear}&limit=200`),
    staleTime: 60_000,
  });

  const holidays = (Array.isArray(holidaysRes) ? holidaysRes : (holidaysRes as any)?.data) || [];
  const selectedSch = schedules.find(s => s.id === selectedSchId);

  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const firstDayOfWeek = new Date(currentYear, currentMonth, 1).getDay();

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

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all });
    queryClient.invalidateQueries({ queryKey: [...queryKeys.assignments.all, 'available'] });
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
      setSuccessMsg('Schedule created! Audit confirmed on calendar.');
      setSelectedAssignmentId('');
      setScheduleRemarks('');
      invalidateAll();
    } catch (err: any) {
      setError(err?.message || 'Failed to create schedule');
    } finally { setIsCreating(false); }
  };

  const handleQuickScheduleFromQueue = (assignmentId: string) => {
    setSelectedAssignmentId(assignmentId);
    setScheduleDate(selectedDate || today.toISOString().split('T')[0]);
    setShowCreateModal(true);
    const sel = assignments.find(a => a.id === assignmentId);
    if (sel?.assayerId) loadAssayerWorkload(sel.assayerId, selectedDate);
  };

  const handleTransition = async (id: string, targetStatus: ScheduleStatus) => {
    if (targetStatus === ScheduleStatus.RESCHEDULED) {
      setRescheduleSchId(id);
      setRescheduleNewDate(today.toISOString().split('T')[0]);
      setShowRescheduleModal(true);
      return;
    }
    setError(null);
    try {
      await api.request(`/schedules/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({
          targetStatus,
          remarks: `Transitioned to ${scheduleStatusLabel(targetStatus)}`,
        }),
      });
      setSuccessMsg(`Schedule status set to ${scheduleStatusLabel(targetStatus)}`);
      invalidateAll();
    } catch (err: any) {
      setError(err?.message || 'Failed to update schedule');
    }
  };

  const handleConfirmReschedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rescheduleSchId || !rescheduleNewDate) return;
    setError(null);
    try {
      await api.request(`/schedules/${rescheduleSchId}/transition`, {
        method: 'POST',
        body: JSON.stringify({
          targetStatus: ScheduleStatus.RESCHEDULED,
          remarks: `Rescheduled to ${rescheduleNewDate}`,
          scheduledDate: rescheduleNewDate,
        }),
      });
      setShowRescheduleModal(false);
      setSuccessMsg(`Schedule rescheduled to ${rescheduleNewDate}`);
      invalidateAll();
    } catch (err: any) {
      setError(err?.message || 'Failed to reschedule');
    }
  };

  const todayStr = today.toISOString().split('T')[0];

  const filteredSchedules = schedules.filter(s => {
    const schDateStr = new Date(s.scheduledDate).toISOString().split('T')[0];
    if (statusFilter === 'ALL') return true;
    if (statusFilter === 'ONGOING') return schDateStr === todayStr && s.status !== ScheduleStatus.COMPLETED;
    if (statusFilter === 'UPCOMING') return schDateStr > todayStr && s.status !== ScheduleStatus.COMPLETED;
    if (statusFilter === 'HISTORICAL') return schDateStr < todayStr || s.status === ScheduleStatus.COMPLETED;
    return s.status === statusFilter;
  });

  const getSchedulesForDate = (dateStr: string) => filteredSchedules.filter(s => {
    const sd = new Date(s.scheduledDate).toISOString().split('T')[0];
    return sd === dateStr;
  });

  const dateSchedules = getSchedulesForDate(selectedDate);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', height: '100%', minHeight: 0, padding: '0 8px 8px' }}>
      {/* ── UNIFIED COMMAND HEADER BAR ── */}
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: 'linear-gradient(135deg, #8b5cf6, #6366f1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
            <Calendar size={20} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 800, color: '#fff', margin: 0 }}>SCHEDULING WORKSPACE</h3>
              <span style={{ fontSize: '10px', padding: '2px 7px', borderRadius: '4px', background: 'rgba(139,92,246,0.2)', color: '#a78bfa', fontWeight: 700 }}>
                STAGE 2: CALENDAR DISPATCH
              </span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {schedules.length} Active Schedules • {assignments.length} Unscheduled Confirmed Offers
            </div>
          </div>
        </div>

        {/* Action Controls & Navigation Shortcuts */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {/* Filter Dropdown */}
          <FilterSelect value={statusFilter} onChange={setStatusFilter} label={<Filter size={14} style={{ color: 'var(--text-muted)' }} />} compact options={[
            { value: 'ALL', label: 'All Schedules' },
            { value: 'ONGOING', label: '⚡ Ongoing (Today)' },
            { value: 'UPCOMING', label: '📅 Upcoming' },
            { value: 'COMPLETED', label: '✓ Completed' },
            { value: 'RESCHEDULED', label: '🔄 Rescheduled' },
            { value: 'TENTATIVE', label: '⏳ Tentative' },
            { value: 'HISTORICAL', label: '📜 History Log' },
          ]} style={{ background: 'none', border: '1px solid var(--border-color)' }} />

          {/* View Toggle */}
          <div style={{ display: 'flex', background: 'var(--bg-primary)', padding: '2px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
            <button onClick={() => setViewMode('calendar')} style={{ padding: '4px 8px', borderRadius: '4px', border: 'none', background: viewMode === 'calendar' ? '#6366f1' : 'transparent', color: '#fff', fontSize: '11px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Grid size={12} /> Grid
            </button>
            <button onClick={() => setViewMode('timeline')} style={{ padding: '4px 8px', borderRadius: '4px', border: 'none', background: viewMode === 'timeline' ? '#6366f1' : 'transparent', color: '#fff', fontSize: '11px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <List size={12} /> Timeline
            </button>
          </div>

          <button onClick={() => { setShowCreateModal(true); setScheduleDate(today.toISOString().split('T')[0]); setAssayerWorkload(null); }}
            className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '5px', background: '#10b981', borderColor: '#10b981' }}>
            <Plus size={13} /> + Schedule Audit
          </button>

          <button onClick={() => window.location.href = '/assignments'} className="btn btn-secondary" style={{ padding: '6px 10px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            Stage 3: Field Execution <ArrowRight size={12} />
          </button>
        </div>
      </div>

      {error && (
        <AlertBanner type="error" message={error} />
      )}
      {successMsg && (
        <AlertBanner type="success" message={successMsg} />
      )}

      {/* ── WORKSPACE BODY: 3 PANEL FLEX ── */}
      <div style={{ flex: 1, display: 'flex', gap: '10px', minHeight: 0, overflow: 'hidden' }}>
        
        {/* PANEL 1: UNASSIGNED CONFIRMED AUDITS QUEUE (LEFT DRAWER 280px) */}
        <div style={{ width: '280px', minWidth: '280px', display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-color)', background: 'rgba(30, 41, 59, 0.6)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700 }}>UNSCHEDULED QUEUE</span>
              <div style={{ fontSize: '13px', fontWeight: 800, color: '#fff' }}>Confirmed Offers</div>
            </div>
            <span style={{ fontSize: '10px', padding: '2px 7px', borderRadius: '10px', background: 'rgba(245,158,11,0.2)', color: '#f59e0b', fontWeight: 700 }}>
              {assignments.length}
            </span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '6px' }}>
            {assignments.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '30px 16px', color: 'var(--text-muted)', fontSize: '12px' }}>
                <CheckCircle2 size={24} style={{ margin: '0 auto 8px', opacity: 0.4, color: '#10b981' }} />
                All confirmed assignments are scheduled on the calendar!
              </div>
            ) : (
              assignments.map(a => (
                <div key={a.id} style={{ padding: '10px', borderRadius: '8px', marginBottom: '6px', background: 'rgba(30, 41, 59, 0.4)', border: '1px solid rgba(255, 255, 255, 0.05)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: '#fff', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.projectBranch?.branch?.name}</div>
                    <span style={{ fontSize: '10px', color: '#f59e0b', fontWeight: 700 }}>₹{a.proposedFee}</span>
                  </div>
                  <div style={{ fontSize: '10px', color: '#94a3b8', display: 'flex', justifyContent: 'space-between' }}>
                    <span>📍 {a.projectBranch?.branch?.city}, {a.projectBranch?.branch?.state}</span>
                  </div>
                  <div style={{ fontSize: '10px', color: '#38bdf8', fontWeight: 600 }}>👤 {a.assayer?.displayName}</div>
                  <button onClick={() => handleQuickScheduleFromQueue(a.id)}
                    className="btn btn-secondary" style={{ marginTop: '4px', width: '100%', padding: '4px', fontSize: '10px', background: 'rgba(99,102,241,0.15)', borderColor: 'rgba(99,102,241,0.3)', color: '#818cf8', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                    <Calendar size={11} /> Quick Schedule
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* PANEL 2: MAIN CALENDAR / TIMELINE CANVAS (CENTER FLEX) */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          
          {/* Calendar Month Navigation Header */}
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(30, 41, 59, 0.6)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <h2 style={{ fontSize: '16px', fontWeight: 800, margin: 0, color: '#fff' }}>{MONTHS[currentMonth]} {currentYear}</h2>
              <div style={{ display: 'flex', gap: '2px' }}>
                <button onClick={handlePrevMonth} style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: '#fff', cursor: 'pointer', padding: '2px 6px' }}><ChevronLeft size={14} /></button>
                <button onClick={handleNextMonth} style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: '#fff', cursor: 'pointer', padding: '2px 6px' }}><ChevronRight size={14} /></button>
              </div>
            </div>
            <button onClick={() => invalidateAll()} className="btn btn-secondary" style={{ padding: '3px 8px', fontSize: '10px', display: 'flex', alignItems: 'center', gap: '3px' }}>
              <RefreshCw size={10} /> Refresh
            </button>
          </div>

          {/* VIEW MODE 1: GRID CALENDAR */}
          {viewMode === 'calendar' ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '8px', minHeight: 0, overflowY: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', marginBottom: '4px' }}>
                {DAYS.map(d => <div key={d} style={{ textAlign: 'center', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', padding: '4px 0' }}>{d}</div>)}
              </div>

              <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', gridAutoRows: 'minmax(65px, 1fr)' }}>
                {Array.from({ length: firstDayOfWeek }).map((_, i) => <div key={`empty-${i}`} />)}
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const day = i + 1;
                  const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  const cellDate = new Date(currentYear, currentMonth, day);
                  const dayOfWeek = cellDate.getDay();
                  const weekIndex = Math.ceil(day / 7);

                  const isSunday = dayOfWeek === 0;
                  const isAltSaturday = dayOfWeek === 6 && (weekIndex === 2 || weekIndex === 4);

                  const daySchedules = getSchedulesForDate(dateStr);
                  const dayHolidays = holidays.filter((h: any) => {
                    const hd = typeof h.date === 'string' ? h.date.slice(0, 10) : new Date(h.date).toISOString().slice(0, 10);
                    return hd === dateStr;
                  });
                  const isToday = dateStr === today.toISOString().split('T')[0];
                  const isSelected = dateStr === selectedDate;
                  const hasSchedules = daySchedules.length > 0;
                  const isHoliday = dayHolidays.length > 0 || isSunday || isAltSaturday;

                  return (
                    <div key={day} onClick={() => setSelectedDate(dateStr)}
                      style={{ padding: '6px', cursor: 'pointer', borderRadius: '6px', minHeight: '60px', position: 'relative',
                        background: isSelected ? 'rgba(99, 102, 241, 0.25)' : isHoliday ? 'rgba(239,68,68,0.1)' : isToday ? 'rgba(139,92,246,0.06)' : 'rgba(30, 41, 59, 0.3)',
                        border: isSelected ? '1px solid #6366f1' : isHoliday ? '1px solid rgba(239,68,68,0.3)' : isToday ? '1px solid rgba(139,92,246,0.2)' : '1px solid rgba(255,255,255,0.03)',
                      }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                        <span style={{ fontSize: '11px', fontWeight: isToday || isHoliday ? 800 : 600, color: isHoliday ? '#f87171' : isToday ? '#a5b4fc' : '#fff' }}>{day}</span>
                        {isHoliday && (
                          <span style={{ fontSize: '9px', color: '#f87171' }}>
                            {isSunday ? <Sun size={12} /> : isAltSaturday ? <Landmark size={12} /> : <Umbrella size={12} />}
                          </span>
                        )}
                      </div>
                      {hasSchedules && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          {daySchedules.slice(0, 2).map(s => (
                            <div key={s.id} onClick={(e) => { e.stopPropagation(); setSelectedSchId(s.id); }}
                              style={{ padding: '2px 4px', borderRadius: '3px', background: STATUS_COLORS[s.status] ? `${STATUS_COLORS[s.status]}25` : 'rgba(99,102,241,0.2)', borderLeft: `2px solid ${STATUS_COLORS[s.status] || '#6366f1'}`, fontSize: '9px', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {s.assignment?.projectBranch?.branch?.name || s.assayer?.displayName}
                            </div>
                          ))}
                          {daySchedules.length > 2 && (
                            <span style={{ fontSize: '8px', color: '#38bdf8', fontWeight: 700 }}>+{daySchedules.length - 2} more</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            /* VIEW MODE 2: TIMELINE LIST */
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>
              {filteredSchedules.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '13px' }}>No schedules match the status filter.</div>
              ) : (
                filteredSchedules.map(sch => (
                  <div key={sch.id} onClick={() => { setSelectedSchId(sch.id); setSelectedDate(new Date(sch.scheduledDate).toISOString().split('T')[0]); }}
                    style={{ padding: '12px 14px', borderRadius: '8px', marginBottom: '6px', background: selectedSchId === sch.id ? 'rgba(99,102,241,0.2)' : 'rgba(30,41,59,0.4)', border: selectedSchId === sch.id ? '1px solid #6366f1' : '1px solid rgba(255,255,255,0.05)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: '#fff' }}>{sch.assignment?.projectBranch?.branch?.name || 'Branch Audit'}</div>
                      <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px', display: 'flex', gap: '10px' }}>
                        <span>👤 {sch.assayer?.displayName}</span>
                        <span>📅 {new Date(sch.scheduledDate).toLocaleDateString('en-IN')}</span>
                      </div>
                    </div>
                    <span style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 700, background: (STATUS_COLORS[sch.status] || '#6366f1') + '20', color: STATUS_COLORS[sch.status] || '#6366f1' }}>
                      {scheduleStatusLabel(sch.status)}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* PANEL 3: DATE AGENDAS & AUDIT PACKET INSPECTOR (RIGHT FLEX 340px) */}
        <div style={{ width: '340px', minWidth: '340px', display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          
          {/* Selected Date Header */}
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-color)', background: 'rgba(30, 41, 59, 0.6)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700 }}>DATE AGENDA</span>
              <div style={{ fontSize: '12px', fontWeight: 800, color: '#fff' }}>
                {new Date(selectedDate).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
              </div>
            </div>
            <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', background: 'rgba(56,189,248,0.15)', color: '#38bdf8', fontWeight: 700 }}>
              {dateSchedules.length} Job{dateSchedules.length !== 1 ? 's' : ''}
            </span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
            {/* Holiday Banners for Selected Date */}
            {(() => {
              const selDate = new Date(selectedDate);
              const dow = selDate.getDay();
              const dom = selDate.getDate();
              const wIdx = Math.ceil(dom / 7);
              const isSun = dow === 0;
              const isAltSat = dow === 6 && (wIdx === 2 || wIdx === 4);

              return (
                <>
                  {isSun && (
                    <div style={{ marginBottom: '6px', padding: '8px 10px', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '6px' }}>
                      <div style={{ color: '#f87171', fontWeight: 700, fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Sun size={13} /> Sunday Bank Holiday
                      </div>
                    </div>
                  )}
                  {isAltSat && (
                    <div style={{ marginBottom: '6px', padding: '8px 10px', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '6px' }}>
                      <div style={{ color: '#f59e0b', fontWeight: 700, fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Landmark size={13} /> {wIdx === 2 ? '2nd' : '4th'} Saturday Bank Holiday
                      </div>
                    </div>
                  )}
                </>
              );
            })()}

            {dateSchedules.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--text-muted)', fontSize: '12px' }}>
                <CalendarDays size={24} style={{ margin: '0 auto 6px', opacity: 0.3 }} />
                No audits scheduled for this date.
              </div>
            ) : (
              dateSchedules.map(sch => (
                <div key={sch.id} onClick={() => setSelectedSchId(selectedSchId === sch.id ? null : sch.id)}
                  style={{ padding: '8px 10px', cursor: 'pointer', borderRadius: '6px', marginBottom: '4px',
                    background: selectedSchId === sch.id ? 'rgba(99,102,241,0.25)' : 'rgba(30,41,59,0.4)',
                    borderLeft: selectedSchId === sch.id ? '3px solid #6366f1' : '3px solid transparent',
                    border: selectedSchId === sch.id ? '1px solid rgba(99,102,241,0.4)' : '1px solid rgba(255,255,255,0.03)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: '#fff' }}>{sch.assignment?.projectBranch?.branch?.name}</div>
                    <span style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '3px', background: (STATUS_COLORS[sch.status] || '#6366f1') + '20', color: STATUS_COLORS[sch.status] || '#6366f1', fontWeight: 700 }}>{scheduleStatusLabel(sch.status)}</span>
                  </div>
                  <div style={{ fontSize: '10px', color: '#38bdf8', marginTop: '2px' }}>👤 {sch.assayer?.displayName}</div>
                </div>
              ))
            )}

            {/* Selected Schedule Inspector Detail Block */}
            {selectedSch && (
              <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 700, marginBottom: '6px' }}>DISPATCH PACKET DETAILS</div>
                
                {/* Actions */}
                <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                  {(selectedSch.status === ScheduleStatus.CONFIRMED || selectedSch.status === ScheduleStatus.RESCHEDULED) &&
                    !['AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'].includes((selectedSch.assignment?.projectBranch as any)?.status) &&
                    (selectedSch.assignment as any)?.status !== 'COMPLETED' && (
                      <button onClick={() => handleTransition(selectedSch.id, ScheduleStatus.RESCHEDULED)} className="btn btn-secondary" style={{ flex: 1, padding: '4px', fontSize: '10px' }}>
                        Reschedule
                      </button>
                  )}
                  {selectedSch.status !== ScheduleStatus.COMPLETED &&
                    !['AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'].includes((selectedSch.assignment?.projectBranch as any)?.status) && (
                      <button onClick={() => handleTransition(selectedSch.id, ScheduleStatus.COMPLETED)} className="btn btn-primary" style={{ flex: 1, padding: '4px', fontSize: '10px', background: '#10b981', borderColor: '#10b981' }}>
                        ✓ Complete
                      </button>
                  )}
                </div>

                {/* Audit Timeline — Scheduled → Completed with Duration */}
                <div style={{ marginBottom: '10px', padding: '8px 10px', background: 'rgba(30,41,59,0.5)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 700, marginBottom: '6px' }}>AUDIT TIMELINE</div>
                  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: '9px', color: '#64748b', fontWeight: 700 }}>SCHEDULED</div>
                      <div style={{ fontSize: '11px', color: '#38bdf8', fontWeight: 600 }}>
                        {new Date(selectedSch.scheduledDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '9px', color: '#64748b', fontWeight: 700 }}>COMPLETED</div>
                      <div style={{ fontSize: '11px', color: selectedSch.completedAt ? '#34d399' : '#64748b', fontWeight: 600 }}>
                        {selectedSch.completedAt
                          ? new Date(selectedSch.completedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
                          : '— Pending'}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '9px', color: '#64748b', fontWeight: 700 }}>DURATION</div>
                      <div style={{ fontSize: '11px', fontWeight: 700, color: (() => {
                        if (!selectedSch.completedAt) return '#64748b';
                        const days = Math.ceil((new Date(selectedSch.completedAt).getTime() - new Date(selectedSch.scheduledDate).getTime()) / (1000 * 60 * 60 * 24));
                        return days <= 1 ? '#34d399' : days <= 3 ? '#f59e0b' : '#ef4444';
                      })() }}>
                        {selectedSch.completedAt
                          ? (() => {
                              const ms = new Date(selectedSch.completedAt).getTime() - new Date(selectedSch.scheduledDate).getTime();
                              const days = Math.ceil(ms / (1000 * 60 * 60 * 24));
                              return days === 0 ? 'Same day' : days === 1 ? '1 day' : `${days} days`;
                            })()
                          : '—'}
                      </div>
                    </div>
                  </div>
                  {selectedSch.assignment?.completionDate && (
                    <div style={{ marginTop: '6px', paddingTop: '5px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', gap: '10px' }}>
                      <div>
                        <div style={{ fontSize: '9px', color: '#64748b', fontWeight: 700 }}>ASSIGNMENT COMPLETION</div>
                        <div style={{ fontSize: '10px', color: '#a78bfa', fontWeight: 600 }}>
                          {new Date(selectedSch.assignment.completionDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: '9px', color: '#64748b', fontWeight: 700 }}>FEE</div>
                        <div style={{ fontSize: '10px', color: '#10b981', fontWeight: 700 }}>
                          ₹{selectedSch.assignment.agreedFee ?? selectedSch.assignment.proposedFee ?? '—'}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Document Downloads */}
                <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 700, marginBottom: '4px' }}>ATTACHED PDF DOCUMENTS</div>
                {documents.length === 0 ? (
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', padding: '6px', border: '1px dashed var(--border-color)', borderRadius: '4px' }}>
                    No audit files attached.
                  </div>
                ) : (
                  documents.map(doc => (
                    <div key={doc.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 6px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', fontSize: '10px', marginBottom: '3px' }}>
                      <span style={{ color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' }}>{doc.fileName}</span>
                      <a href={`/api/v1/documents/${doc.id}/download`} target="_blank" rel="noreferrer" style={{ color: '#38bdf8' }}>
                        <Download size={11} />
                      </a>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── CREATE SCHEDULE MODAL ── */}
      {showCreateModal && (
        <Modal
          open
          onClose={() => setShowCreateModal(false)}
          title="Create Audit Schedule"
          width="460px"
          closeIcon={<X size={16} />}
          asForm
          onSubmit={handleCreateSchedule}
          footer={
            <>
              <button type="button" onClick={() => setShowCreateModal(false)} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '11px' }}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={isCreating} style={{ padding: '6px 12px', fontSize: '11px', background: '#10b981', borderColor: '#10b981' }}>
                {isCreating ? 'Creating...' : 'Create Schedule'}
              </button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Assignment *</label>
            <select value={selectedAssignmentId} onChange={e => {
              setSelectedAssignmentId(e.target.value);
              const sel = assignments.find(a => a.id === e.target.value);
              if (sel?.assayerId && scheduleDate) loadAssayerWorkload(sel.assayerId, scheduleDate);
            }} required
              style={{ width: '100%', padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '12px' }}>
              <option value="">— Select Confirmed Offer —</option>
              {assignments.map(a => (
                <option key={a.id} value={a.id}>
                  {a.assignmentNumber} — {a.projectBranch?.branch?.name} ({a.assayer?.displayName})
                </option>
              ))}
            </select>
            {assayerWorkload && (
              <div style={{ fontSize: '10px', marginTop: '2px', padding: '4px 8px', borderRadius: '4px',
                background: assayerWorkload.count >= 3 ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)',
                color: assayerWorkload.count >= 3 ? '#f87171' : '#6ee7b7' }}>
                Assayer Weekly Load: {assayerWorkload.count} schedule(s)
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
              style={{ width: '100%', padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '12px' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Remarks (optional)</label>
            <input type="text" value={scheduleRemarks} onChange={e => setScheduleRemarks(e.target.value)} placeholder="e.g., Priority morning slot"
              style={{ width: '100%', padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '12px' }} />
          </div>
        </Modal>
      )}

      {/* ── RESCHEDULE DATE MODAL ── */}
      {showRescheduleModal && (
        <Modal
          open
          onClose={() => setShowRescheduleModal(false)}
          title="Reschedule Audit Date"
          width="420px"
          closeIcon={<X size={16} />}
          asForm
          onSubmit={handleConfirmReschedule}
          footer={
            <>
              <button type="button" onClick={() => setShowRescheduleModal(false)} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '11px' }}>Cancel</button>
              <button type="submit" className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '11px', background: '#8b5cf6', borderColor: '#8b5cf6' }}>
                Confirm Reschedule
              </button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>New Audit Date *</label>
            <input type="date" value={rescheduleNewDate} onChange={e => setRescheduleNewDate(e.target.value)} required
              style={{ width: '100%', padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
          </div>
        </Modal>
      )}
    </div>
  );
};
