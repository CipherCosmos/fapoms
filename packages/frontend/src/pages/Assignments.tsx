import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, AlertCircle, RefreshCw, Calendar, IndianRupee, MessageSquare, Clock, Send, Search, Filter, CheckCircle, XCircle, ExternalLink } from 'lucide-react';
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
  projectBranch: { branch: { name: string; state: string } };
}

interface TimelineEvent {
  type: string;
  timestamp: string;
  description: string;
  user: string;
}

export const Assignments: React.FC = () => {
  const navigate = useNavigate();
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selectedAsnId, setSelectedAsnId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [newComment, setNewComment] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingTimeline, setIsLoadingTimeline] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  const [schedulingAsnId, setSchedulingAsnId] = useState<string | null>(null);
  const [schedulingDate, setSchedulingDate] = useState(new Date().toISOString().split('T')[0]);
  const [page] = useState(1);

  useEffect(() => {
    loadAssignments();
  }, [page]);

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)' }}>Assignments Workspace</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
            Manage and transition the lifecycle of professional audit commitments.
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 400px', gap: '24px', alignItems: 'start' }}>
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
                  <tr key={asn.id} onClick={() => setSelectedAsnId(asn.id)} style={{ borderBottom: '1px solid var(--border-color)', fontSize: '14px', cursor: 'pointer', background: selectedAsnId === asn.id ? 'rgba(99, 102, 241, 0.08)' : 'transparent', borderLeft: selectedAsnId === asn.id ? '4px solid var(--accent-primary)' : '4px solid transparent' }}>
                    <td style={{ padding: '16px 24px', fontWeight: 600 }}>{asn.assignmentNumber}</td>
                    <td style={{ padding: '16px 24px' }}>
                      <div><b>{asn.projectBranch?.branch?.name}</b></div>
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{asn.project?.name}</span>
                    </td>
                    <td style={{ padding: '16px 24px' }}>{asn.assayer?.displayName}</td>
                    <td style={{ padding: '16px 24px' }}>
                      <span className="badge" style={{
                        background: asn.status === AssignmentStatus.ACCEPTED || asn.status === AssignmentStatus.CLOSED ? 'rgba(16, 185, 129, 0.1)' : asn.status === AssignmentStatus.CANCELLED || asn.status === AssignmentStatus.REJECTED ? 'rgba(239,68,68,0.1)' : 'rgba(245, 158, 11, 0.1)',
                        color: asn.status === AssignmentStatus.ACCEPTED || asn.status === AssignmentStatus.CLOSED ? 'var(--status-active)' : asn.status === AssignmentStatus.CANCELLED || asn.status === AssignmentStatus.REJECTED ? '#ef4444' : 'var(--text-secondary)',
                        padding: '4px 8px'
                      }}>
                        {asn.status}
                      </span>
                    </td>
                    <td style={{ padding: '16px 24px' }} onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        {asn.status === AssignmentStatus.CREATED && (
                          <button onClick={() => handleTransition(asn.id, AssignmentStatus.CANDIDATE_SELECTED)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }}>Select Candidate</button>
                        )}
                        {asn.status === AssignmentStatus.CANDIDATE_SELECTED && (
                          <button onClick={() => handleTransition(asn.id, AssignmentStatus.CONTACT_INITIATED)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }}>Initiate Contact</button>
                        )}
                        {asn.status === AssignmentStatus.CONTACT_INITIATED && (
                          <button onClick={() => handleTransition(asn.id, AssignmentStatus.NEGOTIATION)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }}>Negotiate</button>
                        )}
                        {asn.status === AssignmentStatus.NEGOTIATION && (
                          <button onClick={() => handleTransition(asn.id, AssignmentStatus.ACCEPTED)} className="btn btn-primary" style={{ padding: '4px 8px', fontSize: '12px' }}>Accept</button>
                        )}
                        {asn.status === AssignmentStatus.ACCEPTED && (
                          <button onClick={() => { setSchedulingAsnId(asn.id); setSchedulingDate(asn.scheduledDate ? new Date(asn.scheduledDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]); }} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }}>Schedule</button>
                        )}
                        {asn.status === AssignmentStatus.SCHEDULED && (
                          <button onClick={() => handleTransition(asn.id, AssignmentStatus.AUDIT_COMPLETED)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }}>Complete Audit</button>
                        )}
                        {asn.status === AssignmentStatus.AUDIT_COMPLETED && (
                          <button onClick={() => handleTransition(asn.id, AssignmentStatus.CLOSED)} className="btn btn-primary" style={{ padding: '4px 8px', fontSize: '12px' }}>Close</button>
                        )}
                        {![AssignmentStatus.CLOSED, AssignmentStatus.CANCELLED, AssignmentStatus.REJECTED].includes(asn.status) && (
                          <button onClick={() => { if (confirm('Are you sure?')) handleTransition(asn.id, AssignmentStatus.CANCELLED, { reason: 'Cancelled via UI' }); }} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px', border: '1px solid rgba(239, 68, 68, 0.4)', background: 'transparent', color: '#ef4444' }}>Cancel</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Right Column - Timeline & Comments Thread */}
        <div className="glass-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px', minHeight: '500px' }}>
          {selectedAsn ? (
            <>
              <div>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700 }}>DETAILS PANEL</span>
                <h4 style={{ fontSize: '18px', fontWeight: 700, margin: '2px 0' }}>{selectedAsn.assignmentNumber}</h4>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                  Assayer: <b>{selectedAsn.assayer?.displayName}</b>
                </p>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  Branch: <b>{selectedAsn.projectBranch?.branch?.name}</b>
                  {selectedAsn.project?.name && (
                    <span> — Project: <b>{selectedAsn.project.name}</b></span>
                  )}
                </p>
                <div style={{ marginTop: '10px', display: 'flex', gap: '16px', fontSize: '13px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <IndianRupee size={14} style={{ color: 'var(--text-muted)' }} />
                    <span>₹{selectedAsn.agreedFee ?? selectedAsn.proposedFee}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Calendar size={14} style={{ color: 'var(--text-muted)' }} />
                    <span>{selectedAsn.scheduledDate ? new Date(selectedAsn.scheduledDate).toLocaleDateString() : 'Unscheduled'}</span>
                  </div>
                </div>
                <div style={{ marginTop: '8px', display: 'flex', gap: '6px' }}>
                  <button onClick={() => navigate(`/planning`)} className="btn btn-secondary" style={{ padding: '3px 8px', fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <ExternalLink size={10} /> Planning
                  </button>
                  <button onClick={() => navigate(`/scheduling`)} className="btn btn-secondary" style={{ padding: '3px 8px', fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <ExternalLink size={10} /> Schedule
                  </button>
                </div>
              </div>

              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px', flex: 1, display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Clock size={14} /> CHRONOLOGICAL TIMELINE
                </span>
                {isLoadingTimeline ? (
                  <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading timeline events...</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '320px', overflowY: 'auto', paddingRight: '4px' }}>
                    {timeline.length === 0 ? (
                      <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center' }}>No timeline logs recorded yet.</div>
                    ) : (
                      timeline.map((evt, idx) => (
                        <div key={idx} style={{ background: evt.type === 'COMMENT' ? 'rgba(99, 102, 241, 0.05)' : 'rgba(255,255,255,0.02)', border: evt.type === 'COMMENT' ? '1px solid rgba(99,102,241,0.2)' : '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', padding: '10px', fontSize: '12px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                            <span><b>{evt.user}</b> ({evt.type})</span>
                            <span>{new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                          <p style={{ color: '#fff', margin: 0 }}>{evt.description}</p>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              <form onSubmit={handlePostComment} style={{ display: 'flex', gap: '8px', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                <input type="text" value={newComment} onChange={(e) => setNewComment(e.target.value)} placeholder="Post comment to thread..." required style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
                <button type="submit" className="btn btn-primary" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Send size={14} />
                </button>
              </form>
            </>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '60px 0' }}>
              <MessageSquare size={32} style={{ margin: '0 auto 12px auto' }} />
              <p>Select an assignment row to review detail logs and post comments.</p>
            </div>
          )}
        </div>
      </div>

      {/* Schedule Modal */}
      {schedulingAsnId && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setSchedulingAsnId(null)}>
          <div className="glass-card" style={{ width: '400px', display: 'flex', flexDirection: 'column', gap: '20px' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ fontSize: '18px', fontWeight: 600 }}>Schedule Audit Date</h4>
              <button onClick={() => setSchedulingAsnId(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px' }}>&times;</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Audit Scheduled Date *</label>
                <input type="date" value={schedulingDate} onChange={(e) => setSchedulingDate(e.target.value)} required style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
              <button onClick={() => setSchedulingAsnId(null)} className="btn btn-secondary">Cancel</button>
              <button onClick={async () => {
                if (!schedulingDate || !schedulingAsnId) return;
                try {
                  await api.request('/schedules', {
                    method: 'POST',
                    body: JSON.stringify({
                      assignmentId: schedulingAsnId,
                      scheduledDate: schedulingDate,
                      remarks: 'Scheduled from assignments workspace',
                    }),
                  });
                  await api.request(`/assignments/${schedulingAsnId}/transition`, {
                    method: 'POST',
                    body: JSON.stringify({ targetStatus: AssignmentStatus.SCHEDULED, remarks: 'Schedule confirmed' }),
                  });
                  setSchedulingAsnId(null);
                  loadAssignments();
                } catch (err: any) {
                  alert(err?.message || 'Failed to create schedule');
                }
              }} className="btn btn-primary">Confirm Schedule</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
