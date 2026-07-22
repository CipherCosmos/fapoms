import React, { useState, useEffect } from 'react';
import { ShieldAlert, AlertCircle, RefreshCw, Check, X, ClipboardList, Info } from 'lucide-react';
import { ValidationStatus } from '@fapoms/shared';

interface ValidationCase {
  id: string;
  projectBranchId: string;
  status: ValidationStatus;
  remarks: string | null;
  correctionNotes: string | null;
  ocrResult: any | null;
  projectBranch?: {
    branch?: {
      name: string;
      branchCode: string;
    };
  };
}

export const Validation: React.FC = () => {
  const [cases, setCases] = useState<ValidationCase[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [remarksInput, setRemarksInput] = useState('');
  const [notesInput, setNotesInput] = useState('');
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
        if (data.data.length > 0 && !selectedCaseId) {
          setSelectedCaseId(data.data[0].id);
        }
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
          remarks: remarksInput || `Processed via validation workspace review`,
          notes: notesInput
        })
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setRemarksInput('');
        setNotesInput('');
        loadCases();
      } else {
        alert(data.message || 'Action failed.');
      }
    } catch (err) {
      alert('Network communication error during processing.');
    }
  };

  const selectedCase = cases.find(c => c.id === selectedCaseId);

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

      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: '1fr 400px', 
        gap: '24px',
        alignItems: 'start'
      }}>
        {/* Left Column - Validation Cases List */}
        <div className="glass-card" style={{ padding: 0, overflowX: 'auto' }}>
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>Loading validation cases...</div>
          ) : cases.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
              <ShieldAlert size={48} style={{ margin: '0 auto 16px auto', opacity: 0.5 }} />
              <p>No validation cases pending review.</p>
            </div>
          ) : (
            <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px', textTransform: 'uppercase' }}>
                  <th style={{ padding: '16px 24px' }}>Branch Link</th>
                  <th style={{ padding: '16px 24px' }}>Status</th>
                  <th style={{ padding: '16px 24px' }}>Remarks</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr 
                    key={c.id} 
                    onClick={() => setSelectedCaseId(c.id)}
                    style={{ 
                      borderBottom: '1px solid var(--border-color)', 
                      fontSize: '14px',
                      cursor: 'pointer',
                      background: selectedCaseId === c.id ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
                      borderLeft: selectedCaseId === c.id ? '4px solid var(--accent-primary)' : '4px solid transparent'
                    }}
                  >
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
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Right Column - Case Details & Decision Form */}
        <div className="glass-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px', minHeight: '400px' }}>
          {selectedCase ? (
            <>
              <div>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700 }}>CASE INSPECTOR</span>
                <h4 style={{ fontSize: '18px', fontWeight: 700, margin: '2px 0' }}>{selectedCase.projectBranch?.branch?.name}</h4>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>SOL ID: {selectedCase.projectBranch?.branch?.branchCode}</span>
              </div>

              {/* OCR Summaries if present */}
              {selectedCase.ocrResult && (
                <div style={{ padding: '12px', background: 'rgba(99, 102, 241, 0.05)', border: '1px solid rgba(99, 102, 241, 0.2)', borderRadius: 'var(--radius-sm)' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', fontWeight: 700, marginBottom: '6px' }}>OCR EXTRACTION SUMMARY</span>
                  <pre style={{ fontSize: '11px', margin: 0, overflowX: 'auto', color: 'var(--text-secondary)' }}>
                    {JSON.stringify(selectedCase.ocrResult, null, 2)}
                  </pre>
                </div>
              )}

              {/* Status details & Notes */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }}>
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Current Status: </span>
                  <span className="badge" style={{ background: 'rgba(255,255,255,0.05)', color: '#fff' }}>{selectedCase.status}</span>
                </div>
                {selectedCase.correctionNotes && (
                  <div style={{ padding: '10px', background: 'rgba(239, 68, 68, 0.05)', borderLeft: '3px solid #ef4444', borderRadius: 'var(--radius-sm)' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', fontWeight: 600 }}>CORRECTION REMARKS</span>
                    <span style={{ color: '#fff' }}>{selectedCase.correctionNotes}</span>
                  </div>
                )}
              </div>

              {/* Decision Action forms */}
              {selectedCase.status !== ValidationStatus.APPROVED && (
                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Info size={14} /> ACTION SUBMISSION
                  </span>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Reviewer Remarks</label>
                    <input 
                      type="text" 
                      value={remarksInput}
                      onChange={(e) => setRemarksInput(e.target.value)}
                      placeholder="Audit status remarks..."
                      style={{
                        padding: '8px 12px',
                        background: 'var(--bg-primary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 'var(--radius-sm)',
                        color: '#fff',
                        outline: 'none',
                        fontSize: '13px'
                      }}
                    />
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Correction Notes (if applicable)</label>
                    <textarea 
                      value={notesInput}
                      onChange={(e) => setNotesInput(e.target.value)}
                      placeholder="Specify checklist items requiring correction..."
                      style={{
                        padding: '8px 12px',
                        background: 'var(--bg-primary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 'var(--radius-sm)',
                        color: '#fff',
                        outline: 'none',
                        fontSize: '13px',
                        minHeight: '60px',
                        resize: 'vertical'
                      }}
                    />
                  </div>

                  <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                    <button 
                      onClick={() => handleAction(selectedCase.id, ValidationStatus.APPROVED)} 
                      className="btn btn-primary" 
                      style={{ flex: 1, padding: '8px 12px', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                    >
                      <Check size={14} /> Approve Case
                    </button>
                    <button 
                      onClick={() => handleAction(selectedCase.id, ValidationStatus.CORRECTION_REQUIRED)} 
                      className="btn btn-secondary" 
                      style={{ flex: 1, padding: '8px 12px', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', border: '1px solid rgba(239, 68, 68, 0.4)', background: 'transparent', color: '#ef4444' }}
                    >
                      <X size={14} /> Flag Correction
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '60px 0' }}>
              <ClipboardList size={32} style={{ margin: '0 auto 12px auto' }} />
              <p>Select a case row to inspect validation logs and input approval decisions.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
