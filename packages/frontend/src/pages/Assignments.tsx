import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ClipboardList, AlertCircle, RefreshCw, Calendar, MessageSquare, Clock, Send, Search, Filter, CheckCircle, XCircle, ExternalLink, GitCommit, Circle } from 'lucide-react';
import { AssignmentStatus } from '@fapoms/shared';
import { api } from '../services/api';

interface Assignment {
  id: string;
  assignmentNumber: string;
  projectId: string;
  assayerId: string;
  status: AssignmentStatus;
  proposedFee: number;
  agreedFee: number | null;
  scheduledDate: string | null;
  project: { name: string };
  assayer: { displayName: string };
  projectBranch: { status?: string; branch: { name: string; state: string } };
}

interface TimelineEvent {
  type: string;
  timestamp: string;
  description: string;
  user: string;
}

export const Assignments: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const assignmentIdParam = searchParams.get('id');
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selectedAsnId, setSelectedAsnId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [newComment, setNewComment] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingTimeline, setIsLoadingTimeline] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  const [page] = useState(1);

  useEffect(() => {
    loadAssignments();
  }, [page]);

  useEffect(() => {
    if (assignmentIdParam && assignments.length > 0) {
      const found = assignments.find(a => a.id === assignmentIdParam);
      if (found) setSelectedAsnId(assignmentIdParam);
    }
  }, [assignmentIdParam, assignments]);

  useEffect(() => {
    if (selectedAsnId) {
      loadTimeline(selectedAsnId);
    } else {
      setTimeline([]);
    }
  }, [selectedAsnId]);

  const formatRelativeTime = (ts: string): string => {
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  const formatEventTime = (ts: string): string => {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatEventDate = (ts: string): string => {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };

  const groupByDate = (events: TimelineEvent[]): { date: string; events: TimelineEvent[] }[] => {
    const groups: Record<string, TimelineEvent[]> = {};
    events.forEach(evt => {
      const key = new Date(evt.timestamp).toDateString();
      if (!groups[key]) groups[key] = [];
      groups[key].push(evt);
    });
    return Object.entries(groups).map(([date, evts]) => ({ date, events: evts }));
  };

  const getEventIcon = (type: string) => {
    if (type === 'COMMENT') return <MessageSquare size={14} />;
    if (type === 'STATUS_CHANGE' || type === 'TRANSITION') return <GitCommit size={14} />;
    return <Circle size={14} />;
  };

  const getEventAccent = (type: string) => {
    if (type === 'COMMENT') return { color: 'var(--accent-primary)', bg: 'rgba(99, 102, 241, 0.08)', border: 'rgba(99, 102, 241, 0.2)', iconBg: 'rgba(99, 102, 241, 0.15)' };
    if (type === 'STATUS_CHANGE' || type === 'TRANSITION') return { color: '#10b981', bg: 'rgba(16, 185, 129, 0.08)', border: 'rgba(16, 185, 129, 0.2)', iconBg: 'rgba(16, 185, 129, 0.15)' };
    return { color: 'var(--accent-secondary)', bg: 'rgba(6, 182, 212, 0.08)', border: 'rgba(6, 182, 212, 0.2)', iconBg: 'rgba(6, 182, 212, 0.15)' };
  };

  const highlightKeywords = (text: string): React.ReactNode => {
    const keywordMap: Record<string, string> = {
      'CREATED': '#f59e0b', 'ACCEPTED': '#10b981', 'REJECTED': '#ef4444',
      'SCHEDULED': '#06b6d4', 'COMPLETED': '#a855f7', 'CANCELLED': '#ef4444',
      'CLOSED': '#10b981', 'PENDING': '#f59e0b', 'CONFIRMED': '#10b981',
      'NEGOTIATION': '#f59e0b', 'CHECKED_IN': '#06b6d4',
      'CANDIDATE_SELECTED': '#f59e0b', 'CONTACT_INITIATED': '#3b82f6',
      'AUDIT_COMPLETED': '#a855f7',
    };
    const pattern = new RegExp(`(${Object.keys(keywordMap).join('|')}|₹[\\d,]+(?:\\.\\d+)?)`, 'gi');
    const parts = text.split(pattern);
    return parts.map((part, i) => {
      const upper = part.toUpperCase();
      const color = keywordMap[upper];
      if (color) {
        return <span key={i} style={{ display: 'inline-block', padding: '0 5px', borderRadius: '3px', fontSize: '11px', fontWeight: 700, background: color + '20', color, letterSpacing: '0.2px' }}>{part}</span>;
      }
      if (/^₹[\d,]+(\.\d+)?$/.test(part)) {
        return <span key={i} style={{ display: 'inline-block', padding: '0 5px', borderRadius: '3px', fontSize: '11px', fontWeight: 700, background: '#fbbf24' + '20', color: '#fbbf24' }}>{part}</span>;
      }
      return part;
    });
  };

  useEffect(() => {
    loadAssignments();
  }, [page]);

  useEffect(() => {
    if (assignmentIdParam && assignments.length > 0) {
      const found = assignments.find(a => a.id === assignmentIdParam);
      if (found) setSelectedAsnId(assignmentIdParam);
    }
  }, [assignmentIdParam, assignments]);

  useEffect(() => {
    if (selectedAsnId) {
      loadTimeline(selectedAsnId);
    } else {
      setTimeline([]);
    }
  }, [selectedAsnId]);

  const loadAssignments = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.request<Assignment[]>(`/assignments?page=${page}&limit=20`, { method: 'GET' });
      setAssignments(response);
      if (response.length > 0 && !selectedAsnId) {
        setSelectedAsnId(response[0].id);
      }
    } catch (err) {
      setError('Failed to fetch assignments.');
    } finally {
      setIsLoading(false);
    }
  };

  const loadTimeline = async (id: string) => {
    setIsLoadingTimeline(true);
    try {
      const response = await api.request<TimelineEvent[]>(`/assignments/${id}/timeline`, { method: 'GET' });
      setTimeline(response);
    } catch (err) {
      console.error('Failed to load assignment timeline');
    } finally {
      setIsLoadingTimeline(false);
    }
  };

  const handlePostComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAsnId || !newComment.trim()) return;
    try {
      await api.request(`/assignments/${selectedAsnId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ comment: newComment })
      });
      setNewComment('');
      loadTimeline(selectedAsnId);
    } catch (err) {
      console.error('Failed to post comment');
    }
  };

  const handleTransition = async (id: string, targetStatus: AssignmentStatus, extraPayload: Record<string, any> = {}) => {
    try {
      await api.request(`/assignments/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus, remarks: 'Transitioned via UI dashboard', ...extraPayload })
      });
      loadAssignments();
      if (selectedAsnId === id) loadTimeline(id);
    } catch (err: any) {
      alert(err?.message || 'Failed to process transition.');
    }
  };

  const updateFee = async (id: string, currentFee: number) => {
    const fee = window.prompt('Enter updated fee (₹):', currentFee?.toString() || '1500');
    if (fee && !isNaN(Number(fee))) {
      try {
        await api.request(`/assignments/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ proposedFee: Number(fee) })
        });
        loadAssignments();
      } catch (err: any) {
        alert(err?.message || 'Failed to update fee.');
      }
    }
  };

  const negotiateFee = async (id: string, currentFee: number) => {
    const fee = window.prompt('Enter agreed fee (₹):', currentFee?.toString() || '1500');
    if (fee && !isNaN(Number(fee))) {
      handleTransition(id, AssignmentStatus.NEGOTIATION, { fee: Number(fee) });
    }
  };

  const adminAcceptOffer = async (id: string, currentFee: number) => {
    const fee = window.prompt('Confirm accepted fee (₹):', currentFee?.toString() || '1500');
    if (fee && !isNaN(Number(fee))) {
      const remarks = window.prompt('Add remarks (for audit trail):', 'Accepted via admin panel');
      handleTransition(id, AssignmentStatus.ACCEPTED, { fee: Number(fee), remarks: remarks || 'Accepted via admin panel' });
    }
  };

  const adminRejectOffer = async (id: string) => {
    const reason = window.prompt('Reason for rejection (required for audit trail):');
    if (reason && reason.trim()) {
      handleTransition(id, AssignmentStatus.REJECTED, { reason: reason.trim(), remarks: `Rejected via admin panel. Reason: ${reason.trim()}` });
    }
  };

  const selectedAsn = assignments.find(a => a.id === selectedAsnId);

  const filteredAssignments = assignments.filter(a => {
    const matchesSearch = a.assignmentNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          a.project?.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          a.assayer?.displayName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          a.projectBranch?.branch?.name?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'ALL' || a.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const totalCount = assignments.length;
  const activeCount = assignments.filter(a =>
    ![AssignmentStatus.CLOSED, AssignmentStatus.CANCELLED, AssignmentStatus.REJECTED].includes(a.status)
  ).length;
  const closedCount = assignments.filter(a => a.status === AssignmentStatus.CLOSED).length;
  const cancelledCount = assignments.filter(a => a.status === AssignmentStatus.CANCELLED || a.status === AssignmentStatus.REJECTED).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* ── UNIFIED 3-STEP PIPELINE BAR ── */}
      <div style={{ background: 'rgba(15, 23, 42, 0.8)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '10px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div onClick={() => window.location.href = '/planning'} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', borderRadius: '20px', color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>
            <span>1</span> Planning & Matching
          </div>
          <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>➔</span>
          <div onClick={() => window.location.href = '/scheduling'} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', borderRadius: '20px', color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>
            <span>2</span> Schedule Dispatch
          </div>
          <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>➔</span>
          <div onClick={() => window.location.href = '/assignments'} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 12px', background: 'rgba(16,185,129,0.2)', border: '1px solid #10b981', borderRadius: '20px', color: '#fff', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
            <span>3</span> Field Execution
          </div>
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          💡 Step 3 of 3: Track field audit progress — acceptance, check-in, report submission & closure.
        </div>
      </div>
      {/* ── STAGE 3 WORKFLOW HEADER BANNER ── */}
      <div style={{ background: 'linear-gradient(90deg, rgba(16,185,129,0.12) 0%, rgba(99,102,241,0.06) 100%)', border: '1px solid rgba(16,185,129,0.25)', padding: '14px 20px', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ backgroundColor: '#10b981', color: '#000', fontSize: '11px', fontWeight: 800, padding: '4px 8px', borderRadius: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Stage 3 of 3
          </span>
          <div>
            <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              Field Execution & Audit Completion
            </h3>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Track field audit progress — acceptance, live GPS check-in, report submission, and closure.
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button 
            onClick={() => window.location.href = '/planning'} 
            style={{ padding: '6px 12px', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '6px', color: '#a5b4fc', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
          >
            ← Stage 1: Planning
          </button>
          <button 
            onClick={() => window.location.href = '/scheduling'} 
            style={{ padding: '6px 12px', background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.3)', borderRadius: '6px', color: '#c084fc', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
          >
            ← Stage 2: Schedule Dispatch
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)' }}>Field Execution Workspace</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
            Track and manage live field audits — from scheduling to report submission.
          </p>
        </div>
        <button onClick={loadAssignments} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {error && (
        <div style={{ display: 'flex', gap: '12px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', padding: '16px', borderRadius: 'var(--radius-md)', color: 'var(--status-inactive)' }}>
          <AlertCircle size={20} />
          <span>{error}</span>
        </div>
      )}

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
        {[
          { label: 'Total Assignments', value: totalCount, icon: ClipboardList, color: 'var(--accent-primary)' },
          { label: 'Active / In Progress', value: activeCount, icon: RefreshCw, color: 'var(--accent-secondary)' },
          { label: 'Closed', value: closedCount, icon: CheckCircle, color: 'var(--status-active)' },
          { label: 'Cancelled / Rejected', value: cancelledCount, icon: XCircle, color: '#ef4444' },
        ].map(card => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '16px' }}>
              <div style={{ width: '44px', height: '44px', borderRadius: 'var(--radius-md)', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: card.color }}>
                <Icon size={22} />
              </div>
              <div>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500 }}>{card.label}</span>
                <h4 style={{ fontSize: '24px', fontWeight: 800, margin: '2px 0', color: '#fff' }}>{card.value}</h4>
              </div>
            </div>
          );
        })}
      </div>

      {/* Search & Filter */}
      <div className="glass-card" style={{ padding: '12px 16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
          <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input type="text" placeholder="Search by ID, project, assayer, branch..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} style={{ width: '100%', padding: '8px 12px 8px 36px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Filter size={14} style={{ color: 'var(--text-muted)' }} />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }}>
            <option value="ALL">All Statuses</option>
            {Object.values(AssignmentStatus).map(s => (<option key={s} value={s}>{s}</option>))}
          </select>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '20px', alignItems: 'start' }}>
        {/* Left Column - Assignments List */}
        <div className="glass-card" style={{ padding: 0, overflowX: 'auto' }}>
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>Loading assignments queue...</div>
          ) : filteredAssignments.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
              <ClipboardList size={48} style={{ margin: '0 auto 16px auto', opacity: 0.5 }} />
              <p>No assignments found matching your criteria.</p>
            </div>
          ) : (
            <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px', textTransform: 'uppercase' }}>
                  <th style={{ padding: '16px 24px' }}>Assignment ID</th>
                  <th style={{ padding: '16px 24px' }}>Project / Branch</th>
                  <th style={{ padding: '16px 24px' }}>Assayer</th>
                  <th style={{ padding: '16px 24px' }}>Status</th>
                  <th style={{ padding: '16px 24px' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredAssignments.map((asn) => (
                  <tr key={asn.id} onClick={() => { setSelectedAsnId(asn.id); navigate(`/assignments?id=${asn.id}`, { replace: true }); }} style={{ borderBottom: '1px solid var(--border-color)', fontSize: '14px', cursor: 'pointer', background: selectedAsnId === asn.id ? 'rgba(99, 102, 241, 0.08)' : 'transparent', borderLeft: selectedAsnId === asn.id ? '4px solid var(--accent-primary)' : '4px solid transparent' }}>
                    <td style={{ padding: '16px 24px', fontWeight: 600 }}>{asn.assignmentNumber}</td>
                    <td style={{ padding: '16px 24px' }}>
                      <div><b>{asn.projectBranch?.branch?.name}</b></div>
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{asn.project?.name}</span>
                    </td>
                    <td style={{ padding: '16px 24px' }}>{asn.assayer?.displayName}</td>
                    <td style={{ padding: '16px 24px' }}>
                      {(() => {
                        const st = String(asn.status);
                        const isCheckedIn = st === 'CHECKED_IN' || (st === 'SCHEDULED' && asn.projectBranch?.status === 'SCHEDULED');
                        const isAccepted = st === 'ACCEPTED' || st === 'ASSIGNMENT_CONFIRMED';
                        const isClosed = st === 'CLOSED';
                        const isCancelled = st === 'CANCELLED' || st === 'REJECTED';
                        const isDone = st === 'AUDIT_COMPLETED';

                        const bg = isCheckedIn ? 'rgba(6, 182, 212, 0.15)' : isAccepted ? 'rgba(16, 185, 129, 0.15)' : isClosed ? 'rgba(16, 185, 129, 0.2)' : isDone ? 'rgba(168, 85, 247, 0.15)' : isCancelled ? 'rgba(239, 68, 68, 0.15)' : 'rgba(245, 158, 11, 0.15)';
                        const color = isCheckedIn ? '#06b6d4' : isAccepted ? '#10b981' : isClosed ? '#10b981' : isDone ? '#a855f7' : isCancelled ? '#ef4444' : '#f59e0b';
                        const icon = isCheckedIn ? '📍 ' : isAccepted ? '✅ ' : isDone ? '📄 ' : isClosed ? '🔒 ' : '';

                        return (
                          <span className="badge" style={{ background: bg, color: color, padding: '4px 10px', fontWeight: 700, borderRadius: '6px' }}>
                            {icon}{asn.status}
                          </span>
                        );
                      })()}
                    </td>
                    <td style={{ padding: '16px 24px' }} onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {asn.status === AssignmentStatus.CREATED && (
                          <button onClick={() => handleTransition(asn.id, AssignmentStatus.CANDIDATE_SELECTED, {})} className="btn btn-secondary" style={{ padding: '3px 8px', fontSize: '11px', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.4)', color: '#818cf8' }}>Select Candidate</button>
                        )}
                        {asn.status === AssignmentStatus.CANDIDATE_SELECTED && (
                          <button onClick={() => handleTransition(asn.id, AssignmentStatus.CONTACT_INITIATED, {})} className="btn btn-secondary" style={{ padding: '3px 8px', fontSize: '11px', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.4)', color: '#818cf8' }}>Initiate Contact</button>
                        )}
                        {asn.status === AssignmentStatus.CONTACT_INITIATED && (
                          <button onClick={() => negotiateFee(asn.id, asn.proposedFee)} className="btn btn-secondary" style={{ padding: '3px 8px', fontSize: '11px', background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)', color: '#fbbf24' }}>🤝 Negotiate Fee</button>
                        )}
                        {[AssignmentStatus.CONTACT_INITIATED, AssignmentStatus.NEGOTIATION].includes(asn.status) && (
                          <>
                            <button onClick={() => adminAcceptOffer(asn.id, asn.proposedFee)} className="btn btn-secondary" style={{ padding: '3px 8px', fontSize: '11px', background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', color: '#10b981' }}>✅ Accept Offer</button>
                            <button onClick={() => adminRejectOffer(asn.id)} className="btn btn-secondary" style={{ padding: '3px 8px', fontSize: '11px', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', color: '#ef4444' }}>❌ Reject Offer</button>
                          </>
                        )}
                        {asn.status === AssignmentStatus.NEGOTIATION && (
                          <button onClick={() => updateFee(asn.id, asn.proposedFee)} className="btn btn-secondary" style={{ padding: '3px 8px', fontSize: '11px', background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)', color: '#fbbf24' }}>💰 Update Fee</button>
                        )}
                        {asn.status === AssignmentStatus.SCHEDULED && (
                          <button onClick={() => handleTransition(asn.id, AssignmentStatus.AUDIT_COMPLETED)} className="btn btn-secondary" style={{ padding: '3px 8px', fontSize: '11px' }}>Complete Audit</button>
                        )}
                        {asn.status === AssignmentStatus.AUDIT_COMPLETED && (
                          <button onClick={() => handleTransition(asn.id, AssignmentStatus.CLOSED)} className="btn btn-primary" style={{ padding: '3px 8px', fontSize: '11px' }}>Close</button>
                        )}
                        {![AssignmentStatus.CLOSED, AssignmentStatus.CANCELLED, AssignmentStatus.REJECTED, AssignmentStatus.AUDIT_COMPLETED].includes(asn.status) && (
                          <button onClick={() => { if (confirm('Are you sure?')) handleTransition(asn.id, AssignmentStatus.CANCELLED, { reason: 'Cancelled via UI' }); }} className="btn btn-secondary" style={{ padding: '3px 8px', fontSize: '11px', border: '1px solid rgba(239, 68, 68, 0.4)', background: 'transparent', color: '#ef4444' }}>Cancel</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Right Column - Details Panel */}
        <div className="glass-card" style={{ padding: 0, display: 'flex', flexDirection: 'column', minHeight: '500px', overflow: 'hidden' }}>
          {selectedAsn ? (
            <>
              {/* Header */}
          <div style={{
            background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.12) 0%, rgba(6, 182, 212, 0.06) 100%)',
            borderBottom: '1px solid var(--border-color)',
            padding: '14px 16px 12px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.5px' }}>DETAILS PANEL</span>
                <h4 style={{ fontSize: '14px', fontWeight: 700, margin: '1px 0' }}>{selectedAsn.assignmentNumber}</h4>
                  </div>
                  <div>
                    {(() => {
                      const st = String(selectedAsn.status);
                      const isCheckedIn = st === 'CHECKED_IN';
                      const isAccepted = st === 'ACCEPTED' || st === 'ASSIGNMENT_CONFIRMED' || st === 'SCHEDULED';
                      const isClosed = st === 'CLOSED';
                      const isDone = st === 'AUDIT_COMPLETED';
                      const isCancelled = st === 'CANCELLED' || st === 'REJECTED';
                      const bg = isCheckedIn ? 'rgba(6, 182, 212, 0.2)' : isAccepted ? 'rgba(16, 185, 129, 0.2)' : isClosed ? 'rgba(16, 185, 129, 0.25)' : isDone ? 'rgba(168, 85, 247, 0.2)' : isCancelled ? 'rgba(239, 68, 68, 0.2)' : 'rgba(245, 158, 11, 0.2)';
                      const color = isCheckedIn ? '#06b6d4' : isAccepted ? '#10b981' : isClosed ? '#10b981' : isDone ? '#a855f7' : isCancelled ? '#ef4444' : '#f59e0b';
                      return (
                        <span className="badge" style={{ background: bg, color, padding: '4px 12px', fontWeight: 700, fontSize: '12px' }}>
                          {selectedAsn.status}
                        </span>
                      );
                    })()}
                  </div>
                </div>
              </div>

              {/* Details Grid */}
              <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', borderBottom: '1px solid var(--border-color)' }}>
                <div style={{ background: 'rgba(99, 102, 241, 0.06)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid rgba(99, 102, 241, 0.15)' }}>
                  <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Assayer</span>
                  <p style={{ fontSize: '12px', fontWeight: 600, margin: '1px 0', color: '#fff' }}>{selectedAsn.assayer?.displayName || '—'}</p>
                </div>
                <div style={{ background: 'rgba(6, 182, 212, 0.06)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid rgba(6, 182, 212, 0.15)' }}>
                  <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Fee</span>
                  <p style={{ fontSize: '14px', fontWeight: 800, margin: '1px 0', background: 'linear-gradient(135deg, #fbbf24, #f59e0b)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                    ₹{selectedAsn.agreedFee ?? selectedAsn.proposedFee}
                  </p>
                </div>
                <div style={{ background: 'rgba(16, 185, 129, 0.06)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid rgba(16, 185, 129, 0.15)', gridColumn: 'span 2' }}>
                  <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Branch / Project</span>
                  <p style={{ fontSize: '12px', fontWeight: 600, margin: '1px 0', color: '#fff' }}>
                    {selectedAsn.projectBranch?.branch?.name}
                    {selectedAsn.projectBranch?.branch?.state && (
                      <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}> — {selectedAsn.projectBranch.branch.state}</span>
                    )}
                  </p>
                  <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: '1px 0 0' }}>{selectedAsn.project?.name}</p>
                </div>
                <div style={{ background: 'rgba(168, 85, 247, 0.06)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid rgba(168, 85, 247, 0.15)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Calendar size={13} style={{ color: '#a855f7' }} />
                  <div>
                    <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Scheduled</span>
                    <p style={{ fontSize: '12px', fontWeight: 600, margin: '1px 0', color: '#fff' }}>{selectedAsn.scheduledDate ? new Date(selectedAsn.scheduledDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Unscheduled'}</p>
                  </div>
                </div>
                <div style={{ background: 'rgba(245, 158, 11, 0.06)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', border: '1px solid rgba(245, 158, 11, 0.15)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <ExternalLink size={13} style={{ color: '#f59e0b' }} />
                  <div>
                    <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Quick Links</span>
                    <div style={{ display: 'flex', gap: '4px', marginTop: '1px' }}>
                      <button onClick={() => navigate(`/planning`)} className="btn btn-secondary" style={{ padding: '1px 6px', fontSize: '9px', background: 'rgba(255,255,255,0.05)' }}>Planning</button>
                      <button onClick={() => navigate(`/scheduling`)} className="btn btn-secondary" style={{ padding: '1px 6px', fontSize: '9px', background: 'rgba(255,255,255,0.05)' }}>Schedule</button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Timeline Section */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 16px', overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px', letterSpacing: '0.3px' }}>
                    <Clock size={12} style={{ color: 'var(--accent-primary)' }} /> CHRONOLOGICAL TIMELINE
                  </span>
                  {timeline.length > 0 && (
                    <span style={{ fontSize: '9px', color: 'var(--text-muted)', background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: 'var(--radius-full)' }}>
                      {timeline.length} event{timeline.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                {isLoadingTimeline ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '32px', color: 'var(--text-muted)', fontSize: '13px' }}>
                    <div style={{ width: '14px', height: '14px', border: '2px solid var(--border-color)', borderTop: '2px solid var(--accent-primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                    Loading timeline...
                  </div>
                ) : (
                  <div style={{ maxHeight: '300px', overflowY: 'auto', paddingRight: '4px', flex: 1 }}>
                    {timeline.length === 0 ? (
                      <div style={{ padding: '28px', color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
                        <Clock size={22} style={{ margin: '0 auto 10px', opacity: 0.3 }} />
                        <p style={{ fontWeight: 600, marginBottom: '2px' }}>No timeline events yet</p>
                        <p style={{ fontSize: '12px' }}>Events will appear here as the assignment progresses.</p>
                      </div>
                    ) : (
                      groupByDate(timeline).map((group) => (
                        <div key={group.date}>
                          {/* Date Header */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '12px 0 8px' }}>
                            <div style={{
                              fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
                              background: 'var(--bg-tertiary)', padding: '2px 10px',
                              borderRadius: 'var(--radius-full)', letterSpacing: '0.3px',
                            }}>
                              {formatEventDate(group.events[0].timestamp)}
                            </div>
                            <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }} />
                          </div>

                          {/* Timeline vertical line + events */}
                          <div style={{ position: 'relative', paddingLeft: '28px' }}>
                            {/* Vertical connecting line */}
                            <div style={{
                              position: 'absolute', left: '13px', top: '8px', bottom: '8px',
                              width: '2px', background: 'var(--border-color)',
                              borderRadius: '1px',
                            }} />
                            {group.events.map((evt, idx) => {
                              const accent = getEventAccent(evt.type);
                              return (
                                <div key={idx} style={{
                                  position: 'relative',
                                  marginBottom: idx < group.events.length - 1 ? '10px' : 0,
                                }}>
                                  {/* Icon node on the timeline line */}
                                  <div style={{
                                    position: 'absolute', left: '-28px', top: '8px',
                                    width: '26px', height: '26px',
                                    borderRadius: '50%',
                                    background: accent.iconBg,
                                    border: `2px solid ${accent.color}`,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    color: accent.color,
                                    zIndex: 1,
                                  }}>
                                    {getEventIcon(evt.type)}
                                  </div>
                                  {/* Event card */}
                                  <div style={{
                                    background: accent.bg,
                                    border: `1px solid ${accent.border}`,
                                    borderRadius: 'var(--radius-sm)',
                                    padding: '8px 10px',
                                    fontSize: '12px',
                                    transition: 'all 0.2s ease',
                                    cursor: 'default',
                                  }}
                                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'translateX(2px)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)'; }}
                                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'none'; (e.currentTarget as HTMLElement).style.boxShadow = 'none'; }}
                                  >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <span style={{
                                          display: 'inline-block', padding: '1px 6px',
                                          fontSize: '9px', fontWeight: 700, letterSpacing: '0.3px',
                                          borderRadius: 'var(--radius-full)',
                                          background: accent.color + '20',
                                          color: accent.color,
                                        }}>
                                          {evt.type}
                                        </span>
                                        <span style={{ color: 'var(--text-secondary)', fontSize: '11px', fontWeight: 500 }}>
                                          {evt.user}
                                        </span>
                                      </div>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{formatEventTime(evt.timestamp)}</span>
                                        <span style={{ fontSize: '10px', color: 'var(--text-muted)', opacity: 0.6 }}>{formatRelativeTime(evt.timestamp)}</span>
                                      </div>
                                    </div>
                                    <p style={{ color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5, paddingLeft: '2px', fontSize: '12px' }}>{highlightKeywords(evt.description)}</p>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Comment Form */}
              <form onSubmit={handlePostComment} style={{
                display: 'flex',
                gap: '6px',
                padding: '10px 16px',
                borderTop: '1px solid var(--border-color)',
                background: 'rgba(99, 102, 241, 0.04)',
              }}>
                <input
                  type="text"
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder="Post comment..."
                  required
                  style={{
                    flex: 1,
                    padding: '7px 10px',
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    color: '#fff',
                    outline: 'none',
                    fontSize: '12px',
                  }}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{
                    padding: '7px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <Send size={13} />
                </button>
              </form>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, padding: '60px 24px', textAlign: 'center' }}>
              <div style={{
                width: '56px', height: '56px',
                borderRadius: 'var(--radius-md)',
                background: 'rgba(99, 102, 241, 0.1)',
                border: '1px solid rgba(99, 102, 241, 0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                marginBottom: '16px',
              }}>
                <MessageSquare size={28} style={{ color: 'var(--accent-primary)', opacity: 0.7 }} />
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', fontWeight: 600 }}>No Assignment Selected</p>
              <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px', maxWidth: '260px' }}>
                Select an assignment row from the table to review its details, timeline, and post comments.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Schedule Modal removed — scheduling is now done in Stage 2 (Schedule Dispatch) */}
    </div>
  );
};
