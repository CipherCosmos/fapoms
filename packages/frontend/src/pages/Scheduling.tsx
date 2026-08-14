import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { 
  CalendarDays, RefreshCw, Calendar, CheckCircle2,
  Plus, Download, ChevronLeft, ChevronRight,
  X, Sun, Landmark, Umbrella, Filter, List, Grid, ArrowRight
} from 'lucide-react';
import { ScheduleStatus, SystemRole, formatRupees } from '@fapoms/shared';
import { useCurrentRoles, hasAnyRole } from '../hooks/useCurrentRoles';
import { scheduleStatusLabel, localDateKey, todayDateKey, formatDateOnly } from '../utils/statusLabels';
import { api } from '../services/api';
import { userMessage } from '../services/errors';
import { queryClient } from '../queryClient';
import { queryKeys } from '../hooks/queryKeys';
import { useScope, withScope } from '../context/ScopeContext';
import { Modal, FilterSelect, AlertBanner } from '../components/ui';

import { assignmentFee, assignmentFeeValue } from '../utils/money';
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
  projectId: string;
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
  TENTATIVE: 'var(--warning)',
  CONFIRMED: 'var(--success)',
  // Distinct hues: these two previously shared var(--accent), making a moved audit visually
  // indistinguishable from a finished one across the grid, timeline and agenda.
  RESCHEDULED: 'var(--info, #4A90D9)',
  COMPLETED: 'var(--accent)',
};

export const Scheduling: React.FC = () => {
  const today = new Date();
  // Create/complete/reschedule are ops-only on the backend (POST /schedules, /:id/transition). Other
  // roles reach the calendar as viewers, so the write controls are hidden rather than offered as 403s.
  const canManageSchedules = hasAnyRole(useCurrentRoles(), [
    SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE,
  ]);
  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [selectedDate, setSelectedDate] = useState<string>(todayDateKey());
  const [viewMode, setViewMode] = useState<'calendar' | 'timeline'>('calendar');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState('');
  const [scheduleDate, setScheduleDate] = useState(todayDateKey());
  const [scheduleRemarks, setScheduleRemarks] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [assayerWorkload, setAssayerWorkload] = useState<{ count: number; weeklyCapacity?: number; schedules: any[] } | null>(null);
  const [selectedSchId, setSelectedSchId] = useState<string | null>(null);
  const [showRescheduleModal, setShowRescheduleModal] = useState(false);
  const [rescheduleSchId, setRescheduleSchId] = useState<string | null>(null);
  const [rescheduleNewDate, setRescheduleNewDate] = useState(todayDateKey());
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [documents, setDocuments] = useState<any[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  // Bulk dispatch: pick several unscheduled offers and put them on one date in a single action —
  // a 40-branch rollout was previously 40 modal round-trips.
  const [bulkQueueIds, setBulkQueueIds] = useState<Set<string>>(new Set());
  const [bulkDate, setBulkDate] = useState(todayDateKey());
  const [bulkScheduling, setBulkScheduling] = useState(false);

  const { scopeParams, scopeKey } = useScope();
  const scopeQuery = withScope(scopeParams);

  // Scoped to the visible month (± one month so navigation feels seamless). The old bare
  // '/schedules' call hit the backend's default limit=50 ordered oldest-first — so once the org
  // passed 50 lifetime schedules, the CURRENT month silently rendered empty. The window keeps the
  // payload bounded no matter how much history accumulates.
  const monthStart = new Date(currentYear, currentMonth - 1, 1);
  const monthEnd = new Date(currentYear, currentMonth + 2, 0);
  const dateFrom = localDateKey(monthStart);
  const dateTo = localDateKey(monthEnd);
  const { data: rawSchedules = [], isLoading: isLoadingSchedules, isError: schedulesError, refetch: refetchSchedules } = useQuery({
    queryKey: [...queryKeys.schedules.list, dateFrom, dateTo, scopeKey],
    queryFn: () => api.request<Schedule[]>(`/schedules?dateFrom=${dateFrom}&dateTo=${dateTo}&limit=500&${scopeQuery}`),
    staleTime: 5_000,
    retry: 1,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
  });
  const schedules = Array.isArray(rawSchedules) ? rawSchedules : [];

  const { data: rawAssignments = [], isLoading: isLoadingAssignments, isError: assignmentsError, refetch: refetchAssignments } = useQuery({
    queryKey: [...queryKeys.assignments.all, 'available', scopeKey],
    queryFn: () => api.request<AssignmentOption[]>(`/assignments?projectBranchStatus=ASSIGNMENT_CONFIRMED&unscheduledOnly=true&limit=100&${scopeQuery}`),
    staleTime: 5_000,
    retry: 1,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
  });
  const assignments = Array.isArray(rawAssignments) ? rawAssignments : [];

  // The header's global scope is applied by the server (both queries send it, and both keys
  // include it). Re-filtering here would only duplicate the project dimension and still miss
  // region, which a schedule row does not carry — it reaches one through its branch.
  const scopedSchedules = schedules;
  const scopedAssignments = assignments;

  const { data: holidaysRes } = useQuery({
    queryKey: ['holidays', currentYear],
    queryFn: () => api.request<any[]>(`/holidays?year=${currentYear}&limit=200`),
    staleTime: 60_000,
  });

  const holidays = (Array.isArray(holidaysRes) ? holidaysRes : (holidaysRes as any)?.data) || [];
  const selectedSch = schedules.find(s => s.id === selectedSchId);

  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const firstDayOfWeek = new Date(currentYear, currentMonth, 1).getDay();

  // Success notices get out of the way on their own; errors stay until dismissed — a backend
  // rejection reason ("assayer already booked at …") that vanished after 4 seconds was unreadable.
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
      const res = await api.request<{ count: number; weeklyCapacity: number; schedules: any[] }>(`/schedules/assayer-workload?assayerId=${assayerId}&date=${date}`);
      setAssayerWorkload(res);
    } catch { setAssayerWorkload(null); }
  };

  const loadDocumentsForSchedule = async (branchId: string) => {
    try {
      const data = await api.request<any[]>(`/documents/project-branch/${branchId}`);
      setDocuments(Array.isArray(data) ? data : []);
    } catch { setDocuments([]); }
  };

  const openDocumentDownload = async (documentId: string) => {
    const { downloadUrl } = await api.request<{ downloadUrl: string }>(`/documents/${documentId}/download-token`);
    window.open(`/api/v1${downloadUrl}`, '_blank', 'noopener,noreferrer');
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
      setError(`Failed to create schedule ${userMessage(err)}`);
    } finally { setIsCreating(false); }
  };

  const handleQuickScheduleFromQueue = (assignmentId: string) => {
    setSelectedAssignmentId(assignmentId);
    setScheduleDate(selectedDate || todayDateKey());
    setShowCreateModal(true);
    const sel = scopedAssignments.find(a => a.id === assignmentId);
    if (sel?.assayerId) loadAssayerWorkload(sel.assayerId, selectedDate);
  };

  /** Schedule every selected queue offer on one date; failures stay selected for retry. */
  const handleBulkSchedule = async () => {
    if (bulkQueueIds.size === 0 || !bulkDate || bulkScheduling) return;
    setBulkScheduling(true);
    setError(null);
    const ids = [...bulkQueueIds];
    const results = await Promise.allSettled(
      ids.map((id) => api.request('/schedules', {
        method: 'POST',
        body: JSON.stringify({ assignmentId: id, scheduledDate: bulkDate, remarks: 'Bulk scheduled from dispatch queue' }),
      })),
    );
    const failedIds = ids.filter((_, i) => results[i].status === 'rejected');
    const okCount = ids.length - failedIds.length;
    setBulkScheduling(false);
    // Only successes leave the selection — what remains selected is exactly what still needs doing.
    setBulkQueueIds(new Set(failedIds));
    if (failedIds.length === 0) {
      setSuccessMsg(`${okCount} audit(s) scheduled for ${bulkDate}.`);
    } else {
      const nameById = new Map(assignments.map((a) => [a.id, a.projectBranch?.branch?.name || a.assignmentNumber]));
      const firstErr = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      setError(
        `${okCount}/${ids.length} scheduled. Failed (still selected for retry): ${failedIds.map((id) => nameById.get(id)).join(', ')}` +
        (firstErr ? ` — ${userMessage(firstErr.reason)}` : ''),
      );
    }
    invalidateAll();
  };

  // In-flight guard: without it a double-click on Complete fired two transitions, the second of
  // which failed with "Invalid Transition" — a red banner after an action that actually succeeded.
  const [transitioningId, setTransitioningId] = useState<string | null>(null);

  const handleTransition = async (id: string, targetStatus: ScheduleStatus) => {
    if (transitioningId) return;
    if (targetStatus === ScheduleStatus.RESCHEDULED) {
      setRescheduleSchId(id);
      // Seed with the schedule's CURRENT date, not today — ops adjusts from where the audit
      // stands; defaulting to today made a mis-click silently pull a future audit to today.
      const sch = schedules.find(s => s.id === id);
      setRescheduleNewDate(sch?.scheduledDate ? localDateKey(sch.scheduledDate) : todayDateKey());
      setShowRescheduleModal(true);
      return;
    }
    if (targetStatus === ScheduleStatus.COMPLETED && !window.confirm('Mark this schedule complete? This moves the audit forward and is not reversible.')) return;
    setError(null);
    setTransitioningId(id);
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
      setError(`Failed to update schedule ${userMessage(err)}`);
    } finally {
      setTransitioningId(null);
    }
  };

  const handleConfirmReschedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rescheduleSchId || !rescheduleNewDate) return;
    setError(null);
    setIsRescheduling(true);
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
      // Follow the audit to its new date so the agenda and the inspector keep describing the
      // same schedule instead of the stale day.
      setSelectedDate(rescheduleNewDate);
      const d = new Date(`${rescheduleNewDate}T00:00:00`);
      setCurrentMonth(d.getMonth());
      setCurrentYear(d.getFullYear());
      invalidateAll();
    } catch (err: any) {
      setError(`Failed to reschedule ${userMessage(err)}`);
    } finally {
      setIsRescheduling(false);
    }
  };

  const todayStr = todayDateKey();

  // Memoized, and indexed by date. The unmemoized version rebuilt this filter on every render
  // (every keystroke in the remarks field), and each of the ~31 calendar cells then re-scanned
  // the whole list — O(days × schedules) per render. One pass builds a date-keyed Map instead.
  const filteredSchedules = React.useMemo(() => scopedSchedules.filter(s => {
    const schDateStr = localDateKey(s.scheduledDate);
    if (statusFilter === 'ALL') return true;
    if (statusFilter === 'ONGOING') return schDateStr === todayStr && s.status !== ScheduleStatus.COMPLETED;
    if (statusFilter === 'UPCOMING') return schDateStr > todayStr && s.status !== ScheduleStatus.COMPLETED;
    if (statusFilter === 'HISTORICAL') return schDateStr < todayStr || s.status === ScheduleStatus.COMPLETED;
    return s.status === statusFilter;
  }), [scopedSchedules, statusFilter, todayStr]);

  const schedulesByDate = React.useMemo(() => {
    const m = new Map<string, Schedule[]>();
    for (const s of filteredSchedules) {
      const key = localDateKey(s.scheduledDate);
      const list = m.get(key);
      if (list) list.push(s); else m.set(key, [s]);
    }
    return m;
  }, [filteredSchedules]);

  const getSchedulesForDate = (dateStr: string) => schedulesByDate.get(dateStr) ?? [];

  const dateSchedules = getSchedulesForDate(selectedDate);

  // Timeline list search — the view had no way to find a branch/assayer/assignment in a long month.
  const [timelineSearch, setTimelineSearch] = useState('');
  const timelineSchedules = React.useMemo(() => {
    const q = timelineSearch.trim().toLowerCase();
    if (!q) return filteredSchedules;
    return filteredSchedules.filter(s =>
      (s.assignment?.projectBranch?.branch?.name ?? '').toLowerCase().includes(q) ||
      (s.assignment?.projectBranch?.branch?.city ?? '').toLowerCase().includes(q) ||
      (s.assignment?.projectBranch?.branch?.state ?? '').toLowerCase().includes(q) ||
      (s.assayer?.displayName ?? '').toLowerCase().includes(q) ||
      (s.assignment?.assignmentNumber ?? '').toLowerCase().includes(q) ||
      (s.project?.name ?? '').toLowerCase().includes(q),
    );
  }, [filteredSchedules, timelineSearch]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', height: '100%', minHeight: 0, padding: '0 8px 8px' }}>
      {/* ── UNIFIED COMMAND HEADER BAR ── */}
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: 'linear-gradient(135deg, var(--accent), var(--accent))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--on-accent)' }}>
            <Calendar size={20} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>SCHEDULING WORKSPACE</h3>
              <span style={{ fontSize: '10px', padding: '2px 7px', borderRadius: '4px', background: 'rgba(216,174,71,0.2)', color: 'var(--accent)', fontWeight: 700 }}>
                STAGE 2: CALENDAR DISPATCH
              </span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {scopedSchedules.length} Active Schedules • {scopedAssignments.length} Unscheduled Confirmed Offers
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
            { value: 'CONFIRMED', label: '✅ Confirmed' },
            { value: 'RESCHEDULED', label: '🔄 Rescheduled' },
            { value: 'TENTATIVE', label: '⏳ Tentative' },
            { value: 'HISTORICAL', label: '📜 History Log' },
          ]} style={{ background: 'none', border: '1px solid var(--border-color)' }} />

          {/* View Toggle */}
          <div style={{ display: 'flex', background: 'var(--bg-primary)', padding: '2px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
            <button onClick={() => setViewMode('calendar')} style={{ padding: '4px 8px', borderRadius: '4px', border: 'none', background: viewMode === 'calendar' ? 'var(--accent)' : 'transparent', color: viewMode === 'calendar' ? 'var(--on-accent)' : 'var(--text-primary)', fontSize: '11px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Grid size={12} /> Grid
            </button>
            <button onClick={() => setViewMode('timeline')} style={{ padding: '4px 8px', borderRadius: '4px', border: 'none', background: viewMode === 'timeline' ? 'var(--accent)' : 'transparent', color: viewMode === 'timeline' ? 'var(--on-accent)' : 'var(--text-primary)', fontSize: '11px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <List size={12} /> Timeline
            </button>
          </div>

          {canManageSchedules && (
          <button onClick={() => { setShowCreateModal(true); setScheduleDate(todayDateKey()); setAssayerWorkload(null); }}
            className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '5px', background: 'var(--success)', borderColor: 'var(--success)' }}>
            <Plus size={13} /> + Schedule Audit
          </button>
          )}

          <button onClick={() => window.location.href = '/assignments'} className="btn btn-secondary" style={{ padding: '6px 10px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            Stage 3: Field Execution <ArrowRight size={12} />
          </button>
        </div>
      </div>

      {error && (
        <AlertBanner type="error" message={error} onClose={() => setError(null)} />
      )}
      {successMsg && (
        <AlertBanner type="success" message={successMsg} />
      )}
      {(schedulesError || assignmentsError) && (
        // A failed load must not masquerade as an empty calendar / clear queue.
        <AlertBanner type="error">
          <span style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            {schedulesError ? 'Could not load schedules.' : 'Could not load the unscheduled queue.'} Check your connection and try again.
            <button
              onClick={() => { if (schedulesError) refetchSchedules(); if (assignmentsError) refetchAssignments(); }}
              className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: '11px' }}
            >
              Retry
            </button>
          </span>
        </AlertBanner>
      )}

      {/* ── WORKSPACE BODY: RESPONSIVE 3-PANEL FLEX ── */}
      <div className="responsive-grid-split" style={{ flex: 1, minHeight: 0, overflow: 'auto', gridTemplateColumns: '260px 1fr 260px' }}>
        
        {/* PANEL 1: UNASSIGNED CONFIRMED AUDITS QUEUE */}
        <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-surface-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700 }}>UNSCHEDULED QUEUE</span>
              <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>Confirmed Offers</div>
            </div>
            <span style={{ fontSize: '10px', padding: '2px 7px', borderRadius: '10px', background: 'var(--status-pending-bg)', color: 'var(--warning)', fontWeight: 700 }}>
              {scopedAssignments.length}
            </span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '6px' }}>
            {isLoadingAssignments ? (
              <div style={{ textAlign: 'center', padding: '30px 16px', color: 'var(--text-muted)', fontSize: '12px' }}>
                <span className="spinner" style={{ display: 'inline-block', marginBottom: 8 }} />
                Loading unscheduled assignments…
              </div>
            ) : scopedAssignments.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '30px 16px', color: 'var(--text-muted)', fontSize: '12px' }}>
                <CheckCircle2 size={24} style={{ margin: '0 auto 8px', opacity: 0.4, color: 'var(--success)' }} />
                No unscheduled confirmed offers for the selected project.
              </div>
            ) : (
              <>
              {/* Bulk dispatch bar — select several offers, one date, one action. */}
              {canManageSchedules && scopedAssignments.length > 1 && (
                <div style={{ padding: '8px', marginBottom: '6px', borderRadius: '8px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-hair)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
                    <input
                      type="checkbox"
                      checked={bulkQueueIds.size === scopedAssignments.length && scopedAssignments.length > 0}
                      onChange={(e) => setBulkQueueIds(e.target.checked ? new Set(scopedAssignments.map(a => a.id)) : new Set())}
                    />
                    Select all ({scopedAssignments.length})
                  </label>
                  {bulkQueueIds.size > 0 && (
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input type="date" value={bulkDate} min={todayDateKey()} onChange={(e) => setBulkDate(e.target.value)}
                        style={{ flex: 1, minWidth: '120px', fontSize: '11px', padding: '4px 6px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none' }} />
                      <button onClick={handleBulkSchedule} disabled={bulkScheduling}
                        className="btn btn-primary" style={{ padding: '4px 10px', fontSize: '11px', fontWeight: 700 }}>
                        {bulkScheduling ? 'Scheduling…' : `Schedule ${bulkQueueIds.size}`}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {scopedAssignments.map(a => (
                <div key={a.id} style={{ padding: '10px', borderRadius: '8px', marginBottom: '6px', background: 'var(--bg-surface-2)', border: bulkQueueIds.has(a.id) ? '1px solid var(--accent)' : '1px solid var(--border-hair)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '6px' }}>
                    {canManageSchedules && (
                      <input
                        type="checkbox"
                        checked={bulkQueueIds.has(a.id)}
                        onChange={(e) => setBulkQueueIds(prev => {
                          const next = new Set(prev);
                          e.target.checked ? next.add(a.id) : next.delete(a.id);
                          return next;
                        })}
                        style={{ marginTop: '1px', flexShrink: 0, cursor: 'pointer' }}
                        aria-label={`Select ${a.projectBranch?.branch?.name || a.assignmentNumber} for bulk scheduling`}
                      />
                    )}
                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.projectBranch?.branch?.name}</div>
                    <span style={{ fontSize: '10px', color: 'var(--warning)', fontWeight: 700 }}>₹{a.proposedFee}</span>
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>📍 {a.projectBranch?.branch?.city}, {a.projectBranch?.branch?.state}</span>
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--accent)', fontWeight: 600 }}>👤 {a.assayer?.displayName}</div>
                  <button onClick={() => handleQuickScheduleFromQueue(a.id)}
                    className="btn btn-secondary" style={{ marginTop: '4px', width: '100%', padding: '4px', fontSize: '10px', background: 'rgba(216,174,71,0.15)', borderColor: 'rgba(216,174,71,0.3)', color: 'var(--accent)', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                    <Calendar size={11} /> Quick Schedule
                  </button>
                </div>
              ))}
              </>
            )}
          </div>
        </div>

        {/* PANEL 2: MAIN CALENDAR / TIMELINE CANVAS (CENTER FLEX) */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          
          {/* Calendar Month Navigation Header */}
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-surface-2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <h2 style={{ fontSize: '16px', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>{MONTHS[currentMonth]} {currentYear}</h2>
              <div style={{ display: 'flex', gap: '2px' }}>
                <button aria-label="Previous month" onClick={handlePrevMonth} style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', cursor: 'pointer', padding: '6px 10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ChevronLeft size={16} /></button>
                <button aria-label="Next month" onClick={handleNextMonth} style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', cursor: 'pointer', padding: '6px 10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ChevronRight size={16} /></button>
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
                  const isToday = dateStr === todayDateKey();
                  const isSelected = dateStr === selectedDate;
                  const hasSchedules = daySchedules.length > 0;
                  const isHoliday = dayHolidays.length > 0 || isSunday || isAltSaturday;

                  return (
                    <div key={day} onClick={() => setSelectedDate(dateStr)}
                      style={{ padding: '6px', cursor: 'pointer', borderRadius: '6px', minHeight: '60px', position: 'relative',
                        background: isSelected ? 'rgba(216,174,71,0.25)' : isHoliday ? 'var(--status-cancelled-bg)' : isToday ? 'rgba(216,174,71,0.06)' : 'var(--bg-surface-2)',
                        border: isSelected ? '1px solid var(--accent)' : isHoliday ? '1px solid var(--status-cancelled-bg)' : isToday ? '1px solid rgba(216,174,71,0.2)' : '1px solid var(--bg-surface-2)',
                      }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                        <span style={{ fontSize: '11px', fontWeight: isToday || isHoliday ? 800 : 600, color: isHoliday ? 'var(--danger)' : isToday ? 'var(--accent)' : 'var(--text-primary)' }}>{day}</span>
                        {isHoliday && (
                          <span style={{ fontSize: '9px', color: 'var(--danger)' }}>
                            {isSunday ? <Sun size={12} /> : isAltSaturday ? <Landmark size={12} /> : <Umbrella size={12} />}
                          </span>
                        )}
                      </div>
                      {hasSchedules && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          {daySchedules.slice(0, 2).map(s => (
                            <div key={s.id} onClick={(e) => { e.stopPropagation(); setSelectedSchId(s.id); }}
                              style={{ padding: '2px 4px', borderRadius: '3px', background: STATUS_COLORS[s.status] ? `${STATUS_COLORS[s.status]}25` : 'rgba(216,174,71,0.2)', borderLeft: `2px solid ${STATUS_COLORS[s.status] || 'var(--accent)'}`, fontSize: '9px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {s.assignment?.projectBranch?.branch?.name || s.assayer?.displayName}
                            </div>
                          ))}
                          {daySchedules.length > 2 && (
                            <span
                              title={`Select the day to see all ${daySchedules.length} audits in the agenda panel`}
                              style={{ fontSize: '8px', color: 'var(--accent)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}
                            >
                              +{daySchedules.length - 2} more
                            </span>
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
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px', display: 'flex', flexDirection: 'column' }}>
              <input
                type="search"
                value={timelineSearch}
                onChange={e => setTimelineSearch(e.target.value)}
                placeholder="Search by branch, assayer, assignment #, project, city…"
                style={{ marginBottom: '8px', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', outline: 'none', fontSize: '12px' }}
              />
              {isLoadingSchedules ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '13px' }}>
                  <span className="spinner" style={{ display: 'inline-block', marginBottom: 8 }} />
                  Loading schedules…
                </div>
              ) : timelineSchedules.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '13px' }}>
                  {timelineSearch ? 'No schedules match your search.' : 'No schedules match the status filter.'}
                </div>
              ) : (
                timelineSchedules.map(sch => {
                  const days = Math.round((new Date(localDateKey(sch.scheduledDate) + 'T00:00:00').getTime() - new Date(todayStr + 'T00:00:00').getTime()) / 86_400_000);
                  const fee = assignmentFeeValue(sch.assignment);
                  const branch = sch.assignment?.projectBranch?.branch;
                  return (
                  <div key={sch.id} onClick={() => { setSelectedSchId(sch.id); setSelectedDate(localDateKey(sch.scheduledDate)); }}
                    style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '6px', background: selectedSchId === sch.id ? 'rgba(216,174,71,0.2)' : 'var(--bg-surface-2)', border: selectedSchId === sch.id ? '1px solid var(--accent)' : '1px solid var(--border-hair)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                        {branch?.name || 'Branch Audit'}
                        {branch?.city && <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}> · {branch.city}{branch.state ? `, ${branch.state}` : ''}</span>}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                        <span>{sch.assignment?.assignmentNumber}</span>
                        <span>{sch.assayer?.displayName}</span>
                        <span>{sch.project?.name}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                      {fee != null && <span style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--warning)' }}>{formatRupees(fee)}</span>}
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: days < 0 ? 'var(--text-muted)' : days === 0 ? 'var(--accent)' : 'var(--text-primary)' }}>
                          {formatDateOnly(sch.scheduledDate)}
                        </div>
                        <div style={{ fontSize: '9.5px', color: days < 0 ? 'var(--text-muted)' : days === 0 ? 'var(--accent)' : 'var(--text-secondary)', fontWeight: 600 }}>
                          {days === 0 ? 'today' : days > 0 ? `in ${days}d` : `${-days}d ago`}
                        </div>
                      </div>
                      <span style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 700, background: (STATUS_COLORS[sch.status] || 'var(--accent)') + '20', color: STATUS_COLORS[sch.status] || 'var(--accent)' }}>
                        {scheduleStatusLabel(sch.status)}
                      </span>
                    </div>
                  </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* PANEL 3: DATE AGENDAS & AUDIT PACKET INSPECTOR */}
        <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          
          {/* Selected Date Header */}
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-surface-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700 }}>DATE AGENDA</span>
              <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>
                {formatDateOnly(selectedDate, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
              </div>
            </div>
            <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', background: 'rgba(216,174,71,0.15)', color: 'var(--accent)', fontWeight: 700 }}>
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
                    <div style={{ marginBottom: '6px', padding: '8px 10px', background: 'var(--status-cancelled-bg)', border: '1px solid var(--status-cancelled-bg)', borderRadius: '6px' }}>
                      <div style={{ color: 'var(--danger)', fontWeight: 700, fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Sun size={13} /> Sunday Bank Holiday
                      </div>
                    </div>
                  )}
                  {isAltSat && (
                    <div style={{ marginBottom: '6px', padding: '8px 10px', background: 'var(--status-pending-bg)', border: '1px solid var(--status-pending-bg)', borderRadius: '6px' }}>
                      <div style={{ color: 'var(--warning)', fontWeight: 700, fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
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
                    background: selectedSchId === sch.id ? 'rgba(216,174,71,0.25)' : 'var(--bg-surface-2)',
                    borderLeft: selectedSchId === sch.id ? '3px solid var(--accent)' : '3px solid transparent',
                    border: selectedSchId === sch.id ? '1px solid rgba(216,174,71,0.4)' : '1px solid var(--bg-surface-2)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{sch.assignment?.projectBranch?.branch?.name}</div>
                    <span style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '3px', background: (STATUS_COLORS[sch.status] || 'var(--accent)') + '20', color: STATUS_COLORS[sch.status] || 'var(--accent)', fontWeight: 700 }}>{scheduleStatusLabel(sch.status)}</span>
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--accent)', marginTop: '2px' }}>👤 {sch.assayer?.displayName}</div>
                </div>
              ))
            )}

            {/* Selected Schedule Inspector Detail Block */}
            {selectedSch && (
              <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, marginBottom: '6px' }}>DISPATCH PACKET DETAILS</div>
                
                {/* Actions */}
                <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                  {canManageSchedules &&
                    (selectedSch.status === ScheduleStatus.CONFIRMED || selectedSch.status === ScheduleStatus.RESCHEDULED) &&
                    !['AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'].includes((selectedSch.assignment?.projectBranch as any)?.status) &&
                    (selectedSch.assignment as any)?.status !== 'COMPLETED' && (
                      <button onClick={() => handleTransition(selectedSch.id, ScheduleStatus.RESCHEDULED)} disabled={transitioningId != null} className="btn btn-secondary" style={{ flex: 1, padding: '4px', fontSize: '10px' }}>
                        Reschedule
                      </button>
                  )}
                  {canManageSchedules &&
                    selectedSch.status !== ScheduleStatus.COMPLETED &&
                    !['AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'].includes((selectedSch.assignment?.projectBranch as any)?.status) && (
                      <button onClick={() => handleTransition(selectedSch.id, ScheduleStatus.COMPLETED)} disabled={transitioningId != null} className="btn btn-primary" style={{ flex: 1, padding: '4px', fontSize: '10px', background: 'var(--success)', borderColor: 'var(--success)' }}>
                        {transitioningId === selectedSch.id ? 'Saving…' : '✓ Complete'}
                      </button>
                  )}
                </div>

                {/* Audit Timeline — Scheduled → Completed with Duration */}
                <div style={{ marginBottom: '10px', padding: '8px 10px', background: 'var(--bg-surface-2)', borderRadius: '6px', border: '1px solid var(--border-hair)' }}>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, marginBottom: '6px' }}>AUDIT TIMELINE</div>
                  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 700 }}>SCHEDULED</div>
                      <div style={{ fontSize: '11px', color: 'var(--accent)', fontWeight: 600 }}>
                        {formatDateOnly(selectedSch.scheduledDate)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 700 }}>COMPLETED</div>
                      <div style={{ fontSize: '11px', color: selectedSch.completedAt ? 'var(--success)' : 'var(--text-muted)', fontWeight: 600 }}>
                        {selectedSch.completedAt
                          ? new Date(selectedSch.completedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
                          : '— Pending'}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 700 }}>DURATION</div>
                      <div style={{ fontSize: '11px', fontWeight: 700, color: (() => {
                        if (!selectedSch.completedAt) return 'var(--text-muted)';
                        const days = Math.ceil((new Date(selectedSch.completedAt).getTime() - new Date(selectedSch.scheduledDate).getTime()) / (1000 * 60 * 60 * 24));
                        return days <= 1 ? 'var(--success)' : days <= 3 ? 'var(--warning)' : 'var(--danger)';
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
                    <div style={{ marginTop: '6px', paddingTop: '5px', borderTop: '1px solid var(--border-hair)', display: 'flex', gap: '10px' }}>
                      <div>
                        <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 700 }}>ASSIGNMENT COMPLETION</div>
                        <div style={{ fontSize: '10px', color: 'var(--accent)', fontWeight: 600 }}>
                          {new Date(selectedSch.assignment.completionDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 700 }}>FEE</div>
                        <div style={{ fontSize: '10px', color: 'var(--success)', fontWeight: 700 }}>
                          {assignmentFee(selectedSch.assignment)}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Document Downloads */}
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, marginBottom: '4px' }}>ATTACHED PDF DOCUMENTS</div>
                {documents.length === 0 ? (
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', padding: '6px', border: '1px dashed var(--border-color)', borderRadius: '4px' }}>
                    No audit files attached.
                  </div>
                ) : (
                  documents.map(doc => (
                    <div key={doc.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 6px', background: 'var(--bg-surface-2)', borderRadius: '4px', fontSize: '10px', marginBottom: '3px' }}>
                      <span style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' }}>{doc.fileName}</span>
                      <button type="button" aria-label={`Download ${doc.fileName}`} title="Download"
                        onClick={() => openDocumentDownload(doc.id).catch((e: any) => setError(`Failed to open download. ${userMessage(e)}`))}
                        style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>
                        <Download size={11} />
                      </button>
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
              <button type="submit" className="btn btn-primary" disabled={isCreating} style={{ padding: '6px 12px', fontSize: '11px', background: 'var(--success)', borderColor: 'var(--success)' }}>
                {isCreating ? 'Creating...' : 'Create Schedule'}
              </button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Assignment *</label>
            <select value={selectedAssignmentId} onChange={e => {
              setSelectedAssignmentId(e.target.value);
              const sel = scopedAssignments.find(a => a.id === e.target.value);
              if (sel?.assayerId && scheduleDate) loadAssayerWorkload(sel.assayerId, scheduleDate);
            }} required
              style={{ width: '100%', padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '12px' }}>
              <option value="">— Select Confirmed Offer —</option>
              {scopedAssignments.map(a => (
                <option key={a.id} value={a.id}>
                  {a.assignmentNumber} — {a.projectBranch?.branch?.name} ({a.assayer?.displayName})
                </option>
              ))}
            </select>
            {assayerWorkload && (() => {
              /**
               * The ceiling comes from the server with the count.
               *
               * This compared a WEEKLY count against a hardcoded 3 — which is the DAILY cap.
               * The desk saw a red "over-booked" warning at a fifth of the real weekly limit of
               * 15 and under-booked assayers the planning engines were recommending as having
               * room for twelve more branches.
               */
              const cap = assayerWorkload.weeklyCapacity || 15;
              const full = assayerWorkload.count >= cap;
              return (
                <div style={{ fontSize: '10px', marginTop: '2px', padding: '4px 8px', borderRadius: '4px',
                  background: full ? 'var(--status-cancelled-bg)' : 'var(--status-active-bg)',
                  color: full ? 'var(--danger)' : 'var(--success)' }}>
                  Assayer Weekly Load: {assayerWorkload.count} of {cap} schedule(s)
                </div>
              );
            })()}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Audit Date *</label>
            <input type="date" value={scheduleDate} onChange={e => {
              setScheduleDate(e.target.value);
              if (selectedAssignmentId) {
                const sel = scopedAssignments.find(a => a.id === selectedAssignmentId);
                if (sel?.assayerId) loadAssayerWorkload(sel.assayerId, e.target.value);
              }
            }} required
              style={{ width: '100%', padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '12px' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Remarks (optional)</label>
            <input type="text" value={scheduleRemarks} onChange={e => setScheduleRemarks(e.target.value)} placeholder="e.g., Priority morning slot"
              style={{ width: '100%', padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '12px' }} />
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
              <button type="button" onClick={() => setShowRescheduleModal(false)} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '11px' }} disabled={isRescheduling}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={isRescheduling} style={{ padding: '6px 12px', fontSize: '11px', background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--on-accent)' }}>
                {isRescheduling ? 'Rescheduling…' : 'Confirm Reschedule'}
              </button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {(() => {
              const sch = schedules.find(s => s.id === rescheduleSchId);
              return sch?.scheduledDate ? (
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  Currently scheduled for <b style={{ color: 'var(--text-primary)' }}>{formatDateOnly(sch.scheduledDate)}</b>
                  {sch.assignment?.projectBranch?.branch?.name && <> · {sch.assignment.projectBranch.branch.name}</>}
                </div>
              ) : null;
            })()}
            <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>New Audit Date *</label>
            <input type="date" value={rescheduleNewDate} min={todayDateKey()} onChange={e => setRescheduleNewDate(e.target.value)} required
              style={{ width: '100%', padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px' }} />
          </div>
        </Modal>
      )}
    </div>
  );
};
