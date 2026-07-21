import React, { useState, useEffect } from 'react';
import { ShieldAlert, AlertCircle, RefreshCw, Check, X } from 'lucide-react';
import { ValidationStatus } from '@fapoms/shared';

interface ValidationCase {
  id: string;
  projectBranchId: string;
  status: ValidationStatus;
  remarks: string | null;
  correctionNotes: string | null;
  projectBranch?: {
    branch?: {
      name: string;
    };
  };
}

export const Validation: React.FC = () => {
  const [cases, setCases] = useState<ValidationCase[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadCases();
  }, []);

  const loadCases = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('fapoms_token');
      const response = await fetch('/api/v1/validation', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setCases(data.data);
      } else {
        setError(data.message || 'Failed to fetch validation queue');
      }
    } catch (err) {
      setError('Network connection error while fetching validation cases.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAction = async (id: string, targetStatus: ValidationStatus) => {
    try {
      const token = localStorage.getItem('fapoms_token');
      const response = await fetch(`/api/v1/validation/${id}/transition`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          targetStatus,
          remarks: `Processed via validator reviews panel`
        })
      });
      const data = await response.json();
      if (response.ok && data.success) {
        loadCases();
      } else {
        alert(data.message || 'Action failed.');
      }
    } catch (err) {
      alert('Network communication error during processing.');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)' }}>Validation Workspace</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
            Coordinate human validator audits and OCR status checks.
          </p>
        </div>
        <button onClick={loadCases} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>Loading validation cases...</div>
      ) : cases.length === 0 ? (
        <div className="glass-card" style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
          <ShieldAlert size={48} style={{ margin: '0 auto 16px auto', opacity: 0.5 }} />
          <p>No validation cases pending review.</p>
        </div>
      ) : (
        <div className="glass-card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px', textTransform: 'uppercase' }}>
                <th style={{ padding: '16px 24px' }}>Branch Link</th>
                <th style={{ padding: '16px 24px' }}>Status</th>
                <th style={{ padding: '16px 24px' }}>Remarks</th>
                <th style={{ padding: '16px 24px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--border-color)', fontSize: '14px' }}>
                  <td style={{ padding: '16px 24px', fontWeight: 600 }}>{c.projectBranch?.branch?.name || 'Assigned Branch Link'}</td>
                  <td style={{ padding: '16px 24px' }}>
                    <span className="badge" style={{
                      background: c.status === ValidationStatus.APPROVED ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                      color: c.status === ValidationStatus.APPROVED ? 'var(--status-active)' : 'var(--text-secondary)',
                      padding: '4px 8px'
                    }}>
                      {c.status}
                    </span>
                  </td>
                  <td style={{ padding: '16px 24px' }}>{c.remarks || '-'}</td>
                  <td style={{ padding: '16px 24px' }}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {c.status !== ValidationStatus.APPROVED && c.status !== ValidationStatus.SUBMITTED && (
                        <>
                          <button onClick={() => handleAction(c.id, ValidationStatus.APPROVED)} className="btn btn-primary" style={{ padding: '4px 8px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <Check size={12} /> Approve
                          </button>
                          <button onClick={() => handleAction(c.id, ValidationStatus.CORRECTION_REQUIRED)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <X size={12} /> Flag Correction
                          </button>
                        </>
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
