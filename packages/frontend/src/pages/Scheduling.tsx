import React, { useState, useEffect } from 'react';
import { CalendarDays, AlertCircle, RefreshCw, Calendar, Check } from 'lucide-react';
import { ScheduleStatus } from '@fapoms/shared';

interface Schedule {
  id: string;
  projectId: string;
  assayerId: string;
  scheduledDate: string;
  status: ScheduleStatus;
  remarks: string | null;
  assayer: {
    displayName: string;
  };
  project: {
    name: string;
  };
}

export const Scheduling: React.FC = () => {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSchedules();
  }, []);

  const loadSchedules = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('fapoms_token');
      const response = await fetch('/api/v1/schedules', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setSchedules(data.data);
      } else {
        setError(data.message || 'Failed to fetch schedules');
      }
    } catch (err) {
      setError('Network connection error while fetching schedules.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTransition = async (id: string, targetStatus: ScheduleStatus) => {
    try {
      const token = localStorage.getItem('fapoms_token');
      const response = await fetch(`/api/v1/schedules/${id}/transition`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          targetStatus,
          remarks: `Updated state via scheduling dashboard`
        })
      });
      const data = await response.json();
      if (response.ok && data.success) {
        loadSchedules();
      } else {
        alert(data.message || 'Failed to transition schedule state');
      }
    } catch (err) {
      alert('Network error while processing transition.');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)' }}>Scheduling Dashboard</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
            Monitor and coordinate scheduled audits and holiday collision status.
          </p>
        </div>
        <button onClick={loadSchedules} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>Loading schedule records...</div>
      ) : schedules.length === 0 ? (
        <div className="glass-card" style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
          <CalendarDays size={48} style={{ margin: '0 auto 16px auto', opacity: 0.5 }} />
          <p>No active schedules found.</p>
        </div>
      ) : (
        <div className="glass-card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px', textTransform: 'uppercase' }}>
                <th style={{ padding: '16px 24px' }}>Project</th>
                <th style={{ padding: '16px 24px' }}>Assayer</th>
                <th style={{ padding: '16px 24px' }}>Scheduled Date</th>
                <th style={{ padding: '16px 24px' }}>Status</th>
                <th style={{ padding: '16px 24px' }}>Remarks</th>
                <th style={{ padding: '16px 24px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((sch) => (
                <tr key={sch.id} style={{ borderBottom: '1px solid var(--border-color)', fontSize: '14px' }}>
                  <td style={{ padding: '16px 24px', fontWeight: 600 }}>{sch.project?.name || 'FAPOMS Project'}</td>
                  <td style={{ padding: '16px 24px' }}>{sch.assayer?.displayName}</td>
                  <td style={{ padding: '16px 24px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Calendar size={14} style={{ color: 'var(--text-muted)' }} />
                      {new Date(sch.scheduledDate).toLocaleDateString()}
                    </div>
                  </td>
                  <td style={{ padding: '16px 24px' }}>
                    <span className="badge" style={{
                      background: sch.status === ScheduleStatus.CONFIRMED ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                      color: sch.status === ScheduleStatus.CONFIRMED ? 'var(--status-active)' : 'var(--text-secondary)',
                      padding: '4px 8px'
                    }}>
                      {sch.status}
                    </span>
                  </td>
                  <td style={{ padding: '16px 24px' }}>{sch.remarks || '-'}</td>
                  <td style={{ padding: '16px 24px' }}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {sch.status === ScheduleStatus.TENTATIVE && (
                        <button onClick={() => handleTransition(sch.id, ScheduleStatus.CONFIRMED)} className="btn btn-primary" style={{ padding: '4px 8px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <Check size={12} /> Confirm
                        </button>
                      )}
                      {sch.status === ScheduleStatus.CONFIRMED && (
                        <button onClick={() => handleTransition(sch.id, ScheduleStatus.RESCHEDULED)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          Reschedule
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
