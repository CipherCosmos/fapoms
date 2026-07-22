import React, { useState, useEffect } from 'react';
import { CalendarDays, AlertCircle, RefreshCw, Calendar, Check, Globe, ShieldAlert } from 'lucide-react';
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

interface Holiday {
  id: string;
  name: string;
  date: string;
  type: string;
  applicableStates: string[] | null;
}

export const Scheduling: React.FC = () => {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingHolidays, setIsLoadingHolidays] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Holiday Check Lookup State
  const [lookupDate, setLookupDate] = useState('');
  const [lookupState, setLookupState] = useState('MH');
  const [lookupResult, setLookupResult] = useState<string | null>(null);

  useEffect(() => {
    loadSchedules();
    loadHolidays();
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

  const loadHolidays = async () => {
    setIsLoadingHolidays(true);
    try {
      const token = localStorage.getItem('fapoms_token');
      const response = await fetch('/api/v1/holidays?limit=20', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setHolidays(data.data);
      }
    } catch (err) {
      console.error('Failed to load holiday calendar');
    } finally {
      setIsLoadingHolidays(false);
    }
  };

  const handleCheckHoliday = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lookupDate) return;

    try {
      const token = localStorage.getItem('fapoms_token');
      const response = await fetch(`/api/v1/holidays/check?date=${lookupDate}&stateCode=${lookupState}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setLookupResult(data.data.isHoliday ? '🛑 HOLIDAY CONFLICT: observed date' : '✅ COMPLIANT: working day');
      }
    } catch (err) {
      setLookupResult('Error looking up calendar');
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

      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: '1fr 400px', 
        gap: '24px',
        alignItems: 'start'
      }}>
        {/* Left Column - Schedules Queue */}
        <div className="glass-card" style={{ padding: 0, overflowX: 'auto' }}>
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>Loading schedule records...</div>
          ) : schedules.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
              <CalendarDays size={48} style={{ margin: '0 auto 16px auto', opacity: 0.5 }} />
              <p>No active schedules found.</p>
            </div>
          ) : (
            <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px', textTransform: 'uppercase' }}>
                  <th style={{ padding: '16px 24px' }}>Project</th>
                  <th style={{ padding: '16px 24px' }}>Assayer</th>
                  <th style={{ padding: '16px 24px' }}>Scheduled Date</th>
                  <th style={{ padding: '16px 24px' }}>Status</th>
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
          )}
        </div>

        {/* Right Column - Holiday Calendar directory */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          {/* Holiday Lookup widget */}
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
                    flex: 1,
                    padding: '8px 12px',
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    color: '#fff',
                    outline: 'none',
                    fontSize: '13px'
                  }}
                />
                <input 
                  type="text"
                  placeholder="MH"
                  value={lookupState}
                  onChange={(e) => setLookupState(e.target.value)}
                  style={{
                    width: '60px',
                    padding: '8px 12px',
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    color: '#fff',
                    outline: 'none',
                    textAlign: 'center',
                    fontSize: '13px'
                  }}
                />
              </div>
              <button type="submit" className="btn btn-primary" style={{ width: '100%', padding: '8px', fontSize: '13px' }}>
                Verify Calendar Date
              </button>
            </form>
            {lookupResult && (
              <div style={{
                padding: '8px 12px',
                borderRadius: 'var(--radius-sm)',
                fontSize: '13px',
                fontWeight: 600,
                textAlign: 'center',
                background: lookupResult.includes('CONFLIANT') ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                color: lookupResult.includes('CONFLIANT') ? 'var(--status-active)' : '#ef4444',
                border: '1px solid',
                borderColor: lookupResult.includes('CONFLIANT') ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'
              }}>
                {lookupResult}
              </div>
            )}
          </div>

          {/* Holidays list panel */}
          <div className="glass-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <h4 style={{ fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Globe size={16} /> Regional Calendar Directory
            </h4>

            {isLoadingHolidays ? (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>Loading calendar data...</div>
            ) : holidays.length === 0 ? (
              <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center' }}>No holidays registered.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '320px', overflowY: 'auto' }}>
                {holidays.map((h) => (
                  <div key={h.id} style={{
                    padding: '10px',
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: '12px'
                  }}>
                    <div>
                      <span style={{ fontWeight: 600, color: '#fff', display: 'block' }}>{h.name}</span>
                      <span style={{ color: 'var(--text-muted)' }}>Type: {h.type}</span>
                    </div>
                    <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                      {new Date(h.date).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
};
