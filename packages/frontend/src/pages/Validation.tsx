import React, { useState, useEffect } from 'react';
import { ShieldAlert, AlertCircle, RefreshCw, Check, X, ClipboardList, Info, Search, FileCheck, FileX, Clock } from 'lucide-react';
import { ValidationStatus } from '@fapoms/shared';

interface ValidationCase {
  id: string;
  projectBranchId: string;
  status: ValidationStatus;
  remarks: string | null;
  correctionNotes: string | null;
  ocrResult: any | null;
  projectBranch?: { branch?: { name: string; branchCode: string } };
}

const STATUS_BADGE: Record<string, { bg: string; color: string }> = {
  PENDING: { bg: 'rgba(245,158,11,0.1)', color: '#f59e0b' },
  APPROVED: { bg: 'rgba(16,185,129,0.1)', color: 'var(--status-active)' },
  CORRECTION_REQUIRED: { bg: 'rgba(239,68,68,0.1)', color: '#ef4444' },
  FLAGGED: { bg: 'rgba(239,68,68,0.1)', color: '#ef4444' },
};

export const Validation: React.FC = () => {
  const [cases, setCases] = useState<ValidationCase[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [remarksInput, setRemarksInput] = useState('Verification approved. No discrepancies found.');
  const [notesInput, setNotesInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  const selectCase = (id: string) => {
    setSelectedCaseId(id);
    setRemarksInput('Verification approved. No discrepancies found.');
    setNotesInput('');
  };

  useEffect(() => { loadCases(); }, []);

  const loadCases = async () => {
    setIsLoading(true); setError(null);
    try {
      const token = localStorage.getItem('fapoms_token');
      const response = await fetch('/api/v1/validation', { headers: { 'Authorization': `Bearer ${token}` } });
      const data = await response.json();
      if (response.ok && data.success) {
        setCases(data.data);
        if (data.data.length > 0 && !selectedCaseId) selectCase(data.data[0].id);
      } else setError(data.message || 'Failed to fetch validation queue');
    } catch { setError('Network connection error while fetching validation cases.'); }
    finally { setIsLoading(false); }
  };

  const handleAction = async (id: string, targetStatus: ValidationStatus) => {
    try {
      const token = localStorage.getItem('fapoms_token');
      const response = await fetch(`/api/v1/validation/${id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ targetStatus, remarks: remarksInput || `Processed via validation workspace review`, notes: notesInput })
      });
      const data = await response.json();
      if (response.ok && data.success) { setRemarksInput(''); setNotesInput(''); loadCases(); }
      else alert(data.message || 'Action failed.');
    } catch { alert('Network communication error during processing.'); }
  };

  const selectedCase = cases.find(c => c.id === selectedCaseId);
  const filtered = cases.filter(c =>
    (c.projectBranch?.branch?.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.status.toLowerCase().includes(searchTerm.toLowerCase())
  );
  const pending = cases.filter(c => c.status === ValidationStatus.PENDING).length;
  const approved = cases.filter(c => c.status === ValidationStatus.APPROVED).length;
  const flagged = cases.filter(c => c.status === ValidationStatus.CORRECTION_REQUIRED).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)' }}>Validation Workspace</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>Review and approve audit validation cases</p>
        </div>
        <button onClick={loadCases} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' }}>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(99,102,241,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ClipboardList size={20} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{cases.length}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Total Cases</div></div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(245,158,11,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Clock size={20} style={{ color: '#f59e0b' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{pending}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Pending Review</div></div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(16,185,129,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <FileCheck size={20} style={{ color: 'var(--status-active)' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{approved}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Approved</div></div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(239,68,68,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <FileX size={20} style={{ color: '#ef4444' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{flagged}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Flagged</div></div>
        </div>
      </div>

      {error && (
        <div style={{ display: 'flex', gap: '8px', padding: '10px 14px', background: 'rgba(239,68,68,0.08)', borderRadius: 'var(--radius-md)', color: '#f87171', fontSize: '13px', border: '1px solid rgba(239,68,68,0.2)' }}>
          <AlertCircle size={14} /><span>{error}</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 420px', gap: '20px', alignItems: 'start' }}>
        {/* Left: Cases List */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <Search size={14} style={{ position: 'absolute', left: '10px', top: '8px', color: 'var(--text-muted)' }} />
              <input type="text" placeholder="Search by branch or status..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                style={{ width: '100%', padding: '7px 10px 7px 30px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
            </div>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{filtered.length} cases</span>
          </div>
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
              <ShieldAlert size={40} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
              <p>{searchTerm ? 'No matching cases.' : 'No validation cases pending review.'}</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr><th>Branch</th><th>Status</th><th>Remarks</th><th>Case ID</th></tr>
                </thead>
                <tbody>
                  {filtered.map(c => {
                    const badge = STATUS_BADGE[c.status] || STATUS_BADGE.PENDING;
                    return (
                      <tr key={c.id} onClick={() => selectCase(c.id)}
                        style={{ cursor: 'pointer', background: selectedCaseId === c.id ? 'rgba(99,102,241,0.08)' : 'transparent', borderLeft: selectedCaseId === c.id ? '3px solid var(--accent-primary)' : '3px solid transparent' }}>
                        <td style={{ fontWeight: 600 }}>{c.projectBranch?.branch?.name || '—'}</td>
                        <td><span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600, background: badge.bg, color: badge.color }}>{c.status}</span></td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.remarks || '-'}</td>
                        <td style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{c.id.slice(0, 8)}...</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right: Case Detail */}
        <div className="glass-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px', minHeight: '400px' }}>
          {selectedCase ? (
            <>
              <div>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700 }}>CASE DETAILS</span>
                <h4 style={{ fontSize: '18px', fontWeight: 700, margin: '2px 0' }}>{selectedCase.projectBranch?.branch?.name || 'Unknown Branch'}</h4>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Code: {selectedCase.projectBranch?.branch?.branchCode || '—'}</span>
              </div>

              {selectedCase.ocrResult && (
                <div style={{ padding: '12px', background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 'var(--radius-sm)' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', fontWeight: 700, marginBottom: '6px' }}>OCR EXTRACTION</span>
                  <pre style={{ fontSize: '11px', margin: 0, overflowX: 'auto', color: 'var(--text-secondary)', maxHeight: '120px' }}>{JSON.stringify(selectedCase.ocrResult, null, 2)}</pre>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }}>
                <div><span style={{ color: 'var(--text-muted)' }}>Status: </span>
                  <span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600, background: (STATUS_BADGE[selectedCase.status] || STATUS_BADGE.PENDING).bg, color: (STATUS_BADGE[selectedCase.status] || STATUS_BADGE.PENDING).color }}>{selectedCase.status}</span>
                </div>
                {selectedCase.correctionNotes && (
                  <div style={{ padding: '10px', background: 'rgba(239,68,68,0.05)', borderLeft: '3px solid #ef4444', borderRadius: 'var(--radius-sm)' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', fontWeight: 600 }}>CORRECTION NOTES</span>
                    <span style={{ color: '#fff', fontSize: '12px' }}>{selectedCase.correctionNotes}</span>
                  </div>
                )}
              </div>

              {selectedCase.status !== ValidationStatus.APPROVED && (
                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Info size={14} /> DECISION
                  </span>
                  <input type="text" value={remarksInput} onChange={e => setRemarksInput(e.target.value)} placeholder="Reviewer remarks..."
                    style={{ padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
                  <textarea value={notesInput} onChange={e => setNotesInput(e.target.value)} placeholder="Correction notes (if applicable)..."
                    style={{ padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px', minHeight: '60px', resize: 'vertical' }} />
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => handleAction(selectedCase.id, ValidationStatus.APPROVED)} className="btn btn-primary"
                      style={{ flex: 1, padding: '8px', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                      <Check size={14} /> Approve
                    </button>
                    <button onClick={() => handleAction(selectedCase.id, ValidationStatus.CORRECTION_REQUIRED)} className="btn btn-secondary"
                      style={{ flex: 1, padding: '8px', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', border: '1px solid rgba(239,68,68,0.4)', background: 'transparent', color: '#ef4444' }}>
                      <X size={14} /> Flag
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '60px 0' }}>
              <ClipboardList size={32} style={{ margin: '0 auto 12px' }} />
              <p>Select a case to review details and make decisions.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
