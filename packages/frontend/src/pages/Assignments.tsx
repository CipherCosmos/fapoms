import React, { useState, useEffect } from 'react';
import { ClipboardList, AlertCircle, RefreshCw, Calendar, IndianRupee } from 'lucide-react';
import { AssignmentStatus } from '@fapoms/shared';

interface Assignment {
  id: string;
  assignmentNumber: string;
  projectId: string;
  assayerId: string;
  status: AssignmentStatus;
  proposedFee: number;
  agreedFee: number | null;
  scheduledDate: string | null;
  project: {
    name: string;
  };
  assayer: {
    displayName: string;
  };
  projectBranch: {
    branch: {
      name: string;
      state: string;
    };
  };
}

export const Assignments: React.FC = () => {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [page] = useState(1);

  useEffect(() => {
    loadAssignments();
  }, [page]);

  const loadAssignments = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('fapoms_token');
      const response = await fetch(`/api/v1/assignments?page=${page}&limit=10`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setAssignments(data.data);
      } else {
        setError(data.message || 'Failed to fetch assignments');
      }
    } catch (err) {
      setError('Network connection error while fetching assignments.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTransition = async (id: string, targetStatus: AssignmentStatus) => {
    try {
      const token = localStorage.getItem('fapoms_token');
      const response = await fetch(`/api/v1/assignments/${id}/transition`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          targetStatus,
          remarks: `Transitioned via UI dashboard`
        })
      });
      const data = await response.json();
      if (response.ok && data.success) {
        loadAssignments();
      } else {
        alert(data.message || 'Failed to transition assignment');
      }
    } catch (err) {
      alert('Network error while processing transition.');
    }
  };

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

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>Loading assignments queue...</div>
      ) : assignments.length === 0 ? (
        <div className="glass-card" style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
          <ClipboardList size={48} style={{ margin: '0 auto 16px auto', opacity: 0.5 }} />
          <p>No active assignments found.</p>
        </div>
      ) : (
        <div className="glass-card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px', textTransform: 'uppercase' }}>
                <th style={{ padding: '16px 24px' }}>Assignment ID</th>
                <th style={{ padding: '16px 24px' }}>Project</th>
                <th style={{ padding: '16px 24px' }}>Branch</th>
                <th style={{ padding: '16px 24px' }}>Assayer</th>
                <th style={{ padding: '16px 24px' }}>Status</th>
                <th style={{ padding: '16px 24px' }}>Fee</th>
                <th style={{ padding: '16px 24px' }}>Scheduled Date</th>
                <th style={{ padding: '16px 24px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((asn) => (
                <tr key={asn.id} style={{ borderBottom: '1px solid var(--border-color)', fontSize: '14px' }}>
                  <td style={{ padding: '16px 24px', fontWeight: 600 }}>{asn.assignmentNumber}</td>
                  <td style={{ padding: '16px 24px' }}>{asn.project?.name || 'FAPOMS Project'}</td>
                  <td style={{ padding: '16px 24px' }}>{asn.projectBranch?.branch?.name} ({asn.projectBranch?.branch?.state})</td>
                  <td style={{ padding: '16px 24px' }}>{asn.assayer?.displayName}</td>
                  <td style={{ padding: '16px 24px' }}>
                    <span className="badge" style={{
                      background: asn.status === AssignmentStatus.ACCEPTED ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                      color: asn.status === AssignmentStatus.ACCEPTED ? 'var(--status-active)' : 'var(--text-secondary)',
                      padding: '4px 8px'
                    }}>
                      {asn.status}
                    </span>
                  </td>
                  <td style={{ padding: '16px 24px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <IndianRupee size={12} /> {asn.agreedFee ?? asn.proposedFee}
                    </div>
                  </td>
                  <td style={{ padding: '16px 24px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Calendar size={14} style={{ color: 'var(--text-muted)' }} />
                      {asn.scheduledDate ? new Date(asn.scheduledDate).toLocaleDateString() : 'Unscheduled'}
                    </div>
                  </td>
                  <td style={{ padding: '16px 24px' }}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {asn.status === AssignmentStatus.CREATED && (
                        <button onClick={() => handleTransition(asn.id, AssignmentStatus.CANDIDATE_SELECTED)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }}>
                          Select Candidate
                        </button>
                      )}
                      {asn.status === AssignmentStatus.CANDIDATE_SELECTED && (
                        <button onClick={() => handleTransition(asn.id, AssignmentStatus.CONTACT_INITIATED)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }}>
                          Initiate Contact
                        </button>
                      )}
                      {asn.status === AssignmentStatus.CONTACT_INITIATED && (
                        <button onClick={() => handleTransition(asn.id, AssignmentStatus.NEGOTIATION)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }}>
                          Negotiate
                        </button>
                      )}
                      {asn.status === AssignmentStatus.NEGOTIATION && (
                        <button onClick={() => handleTransition(asn.id, AssignmentStatus.ACCEPTED)} className="btn btn-primary" style={{ padding: '4px 8px', fontSize: '12px' }}>
                          Accept
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
