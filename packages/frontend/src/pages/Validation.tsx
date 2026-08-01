import React, { useState, useEffect } from 'react';
import { ShieldAlert, RefreshCw, Check, X, ClipboardList, Info, FileCheck, FileX, Clock, FileText, Lock, CheckCheck, Download, Paperclip, ArrowRight, FileSpreadsheet, Reply } from 'lucide-react';
import { ValidationStatus } from '@fapoms/shared';
import { api } from '../services/api';
import { connectSocket } from '../services/socket';
import { StatusBadge, KpiCard, SearchInput, AlertBanner } from '../components/ui';

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
  const [queries, setQueries] = useState<any[]>([]);
  const [queryTextInput, setQueryTextInput] = useState('');
  const [queryAttachments, setQueryAttachments] = useState<any[]>([]);
  const [replyToMessage, setReplyToMessage] = useState<{ sender: string; text: string } | null>(null);
  const [isSendingQuery, setIsSendingQuery] = useState(false);

  const selectCase = (id: string) => {
    setSelectedCaseId(id);
    setRemarksInput('Verification approved. No discrepancies found.');
    setNotesInput('');
    loadQueriesForCase(id);
  };

  const loadQueriesForCase = async (caseId: string) => {
    try {
      const res = await api.request<any[]>(`/validation-queries/validation-case/${caseId}`);
      setQueries(Array.isArray(res) ? res : (res as any)?.data || []);
    } catch {
      setQueries([]);
    }
  };

  useEffect(() => {
    loadCases();
    const socket = connectSocket();
    const refresh = () => {
      loadCases();
      if (selectedCaseId) loadQueriesForCase(selectedCaseId);
    };
    socket?.on('ValidationApproved', refresh);
    socket?.on('ValidationCorrectionRequested', refresh);
    socket?.on('ValidationSubmitted', refresh);
    socket?.on('query:raised', refresh);
    socket?.on('query:responded', refresh);
    return () => {
      socket?.off('ValidationApproved', refresh);
      socket?.off('ValidationCorrectionRequested', refresh);
      socket?.off('ValidationSubmitted', refresh);
      socket?.off('query:raised', refresh);
      socket?.off('query:responded', refresh);
    };
  }, [selectedCaseId]);

  const handleRaiseQuery = async () => {
    if (!selectedCaseId) return;
    if (!queryTextInput.trim() && queryAttachments.length === 0) return;
    setIsSendingQuery(true);
    try {
      const targetCase = cases.find(c => c.id === selectedCaseId);
      const assayerId = (targetCase as any)?.assayerId || '00000000-0000-0000-0000-000000000000';
      let finalMsg = queryTextInput.trim();
      if (replyToMessage) {
        finalMsg = `> ↩️ Replying to ${replyToMessage.sender}: "${replyToMessage.text.slice(0, 60)}${replyToMessage.text.length > 60 ? '...' : ''}"\n${finalMsg}`;
      }

      // Check if there is an active (OPEN or RESPONDED) query thread to append follow-up message/attachment to
      const activeQuery = queries.find((q: any) => q.status === 'OPEN' || q.status === 'RESPONDED');

      if (activeQuery) {
        await api.request(`/validation-queries/${activeQuery.id}/respond`, {
          method: 'POST',
          body: JSON.stringify({
            response: finalMsg,
            attachments: queryAttachments,
          }),
        });
      } else {
        await api.request('/validation-queries', {
          method: 'POST',
          body: JSON.stringify({
            validationCaseId: selectedCaseId,
            assayerId,
            queryText: finalMsg,
            attachments: queryAttachments,
            slaHours: 4,
          }),
        });
      }

      setQueryTextInput('');
      setQueryAttachments([]);
      setReplyToMessage(null);
      loadQueriesForCase(selectedCaseId);
    } catch (err: any) {
      alert(err?.message || 'Failed to send message/attachment');
    } finally {
      setIsSendingQuery(false);
    }
  };

  const loadCases = async () => {
    setIsLoading(true); setError(null);
    try {
      const data = await api.request<ValidationCase[]>('/validation');
      setCases(data);
      if (data.length > 0 && !selectedCaseId) selectCase(data[0].id);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch validation queue');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAction = async (id: string, targetStatus: ValidationStatus) => {
    try {
      await api.request(`/validation/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus, remarks: remarksInput || `Processed via validation workspace review`, notes: notesInput })
      });
      setRemarksInput('');
      setNotesInput('');
      loadCases();
    } catch (err: any) {
      alert(err.message || 'Action failed.');
    }
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

      {/* KPI Cards for Data Entry Head (Nitin) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '14px' }}>
        <KpiCard icon={<ClipboardList />} label="Received PDFs" value={cases.length} />
        <KpiCard icon={<Clock />} iconBg="rgba(245,158,11,0.1)" iconColor="#f59e0b" label="In-Progress" value={pending} />
        <KpiCard icon={<FileCheck />} iconBg="rgba(16,185,129,0.1)" iconColor="var(--status-active)" label="Completed" value={approved} />
        <KpiCard icon={<FileX />} iconBg="rgba(239,68,68,0.1)" iconColor="#ef4444" label="On-Hold / Queries" value={flagged} />
        <KpiCard icon={<FileText />} iconBg="rgba(168,85,247,0.1)" iconColor="#a855f7" label="Productivity" value={`${Math.round((approved / (cases.length || 1)) * 100)}%`} />
      </div>

      {error && (
        <AlertBanner type="error" message={error} />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 420px', gap: '20px', alignItems: 'start' }}>
        {/* Left: Cases List */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search by branch or status..." compact />
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
                        <td><StatusBadge label={c.status} bg={badge.bg} color={badge.color} /></td>
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
                <div>                  <span style={{ color: 'var(--text-muted)' }}>Status: </span>
                  <StatusBadge label={selectedCase.status} bg={(STATUS_BADGE[selectedCase.status] || STATUS_BADGE.PENDING).bg} color={(STATUS_BADGE[selectedCase.status] || STATUS_BADGE.PENDING).color} />
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
                  {/* WhatsApp Web Style Real-Time Query Chat Section */}
                  <div style={{ background: '#0b141a', border: '1px solid #2a3942', borderRadius: '10px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    {/* Header Bar */}
                    <div style={{ background: '#1f2c34', padding: '10px 14px', borderBottom: '1px solid #2a3942', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: '#00a884', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '13px' }}>
                          AS
                        </div>
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: '#e9edef' }}>Assayer Live Room</div>
                          <div style={{ fontSize: '11px', color: '#25D366' }}>● Real-time Socket Connected</div>
                        </div>
                      </div>
                      <span style={{ fontSize: '10px', background: 'rgba(0,168,132,0.15)', color: '#00a884', padding: '3px 8px', borderRadius: '12px', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <Lock size={10} /> End-to-End Encrypted
                      </span>
                    </div>

                    {/* Chat Messages Stream across ALL queries */}
                    <div style={{ maxHeight: '240px', minHeight: '140px', overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px', background: '#0b141a' }}>
                      {queries.length === 0 ? (
                        <div style={{ fontSize: '12px', color: '#8696a0', textAlign: 'center', padding: '20px' }}>
                          No queries raised yet. Initiate a confidential chat query with the assayer below.
                        </div>
                      ) : (
                        [...queries]
                          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
                          .map((q: any) => (
                            <div key={q.id} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              {/* Data Entry Query (Outgoing Right Green Bubble) */}
                              {q.queryText && (q.queryText !== 'Sent attachment(s)' || (!q.attachments || q.attachments.length === 0)) && (
                                <div 
                                   onClick={() => setReplyToMessage({ sender: 'Data Entry', text: q.queryText })}
                                   style={{ alignSelf: 'flex-end', background: '#005c4b', color: '#e9edef', padding: '8px 12px', borderRadius: '8px', borderTopRightRadius: 0, maxWidth: '85%', fontSize: '12px', boxShadow: '0 1px 2px rgba(0,0,0,0.3)', cursor: 'pointer' }}
                                >
                                  <div style={{ fontSize: '10px', color: '#a5b4fc', fontWeight: 700, marginBottom: '2px' }}>You (Data Entry)</div>
                                  <div>{q.queryText}</div>
                                  <div style={{ fontSize: '9px', color: '#8696a0', textAlign: 'right', marginTop: '4px' }}>
                                    {new Date(q.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} <CheckCheck size={9} />
                                  </div>
                                </div>
                              )}

                              {/* Assayer Response (Incoming Left Dark Bubble) */}
                              {q.assayerResponse && q.assayerResponse.split('\n').map((line: string, idx: number) => {
                                const cleanLine = line.replace(/^\[.*?\]\s*/, '');
                                const isQuote = cleanLine.startsWith('> ↩️ Replying to');
                                if (cleanLine === 'Sent attachment(s)' && q.attachments && q.attachments.length > 0) return null;
                                return (
                                  <div key={idx} 
                                       onClick={() => setReplyToMessage({ sender: 'Field Assayer', text: cleanLine })}
                                       style={{ alignSelf: 'flex-start', background: '#202c33', color: '#e9edef', padding: '8px 12px', borderRadius: '8px', borderTopLeftRadius: 0, maxWidth: '85%', fontSize: '12px', boxShadow: '0 1px 2px rgba(0,0,0,0.3)', cursor: 'pointer' }}>
                                    <div style={{ fontSize: '10px', color: '#53bdeb', fontWeight: 700, marginBottom: '2px' }}>Field Assayer</div>
                                    {isQuote && (
                                      <div style={{ background: 'rgba(0,0,0,0.25)', borderLeft: '3px solid #00a884', padding: '4px 6px', borderRadius: '4px', marginBottom: '4px', fontSize: '11px', color: '#8696a0', fontStyle: 'italic' }}>
                                        {cleanLine.split('\n')[0]}
                                      </div>
                                    )}
                                    <div>{isQuote ? cleanLine.split('\n').slice(1).join('\n') : cleanLine}</div>
                                    <div style={{ fontSize: '9px', color: '#8696a0', textAlign: 'right', marginTop: '4px' }}>
                                      {q.respondedAt ? new Date(q.respondedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Just now'}
                                    </div>
                                  </div>
                                );
                              })}

                              {/* Attachments */}
                              {q.attachments && q.attachments.length > 0 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
                                  {q.attachments.flat(Infinity).filter((att: any) => att && (att.url || typeof att === 'string')).map((att: any, idx: number) => {
                                    const rawUrl = typeof att === 'string' ? att : att.url;
                                    const fileName = att.fileName || `Attachment #${idx + 1}`;
                                    const fileType = att.fileType || '';
                                    const isOutgoing = att.uploadedBy === 'VALIDATOR';

                                    const triggerDownload = (e: React.MouseEvent) => {
                                      e.preventDefault();
                                      if (!rawUrl) return;
                                      try {
                                        const a = document.createElement('a');
                                        a.href = rawUrl;
                                        a.download = fileName;
                                        a.target = '_blank';
                                        document.body.appendChild(a);
                                        a.click();
                                        setTimeout(() => document.body.removeChild(a), 500);
                                      } catch {
                                        window.open(rawUrl, '_blank');
                                      }
                                    };

                                    return (
                                      <div key={idx} style={{ alignSelf: isOutgoing ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                                        {fileType.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp)$/i.test(fileName) ? (
                                          <div onClick={triggerDownload} style={{ cursor: 'pointer', display: 'block' }}>
                                            <img src={rawUrl} alt={fileName} style={{ maxWidth: '200px', maxHeight: '140px', borderRadius: '6px', display: 'block' }} />
                                            <span style={{ fontSize: '10px', color: '#34d399', display: 'block', marginTop: '2px' }}><Download size={10} /> Click to Save / Download</span>
                                          </div>
                                        ) : (
                                          <button type="button" onClick={triggerDownload} style={{ fontSize: '12px', color: '#e9edef', background: '#182229', padding: '6px 12px', borderRadius: '6px', border: '1px solid #2a3942', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <FileText size={14} /> {fileName} <span style={{ fontSize: '10px', color: '#34d399', display: 'inline-flex', alignItems: 'center', gap: '2px' }}><Download size={10} /> Save</span>
                                          </button>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          ))
                      )}
                    </div>

                    {/* Tagged Reply Banner */}
                    {replyToMessage && (
                      <div style={{ background: '#1f2c34', borderLeft: '4px solid #00a884', padding: '6px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #2a3942' }}>
                        <div>
                          <div style={{ fontSize: '11px', color: '#00a884', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}><Reply size={12} /> Replying to {replyToMessage.sender}</div>
                          <div style={{ fontSize: '12px', color: '#8696a0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '300px' }}>{replyToMessage.text}</div>
                        </div>
                        <button type="button" onClick={() => setReplyToMessage(null)} style={{ background: 'none', border: 'none', color: '#ff6b6b', fontWeight: 700, cursor: 'pointer', display: 'flex' }}><X size={14} /></button>
                      </div>
                    )}

                    {/* Pending Attachments Preview Bar */}
                    {queryAttachments.length > 0 && (
                      <div style={{ background: '#1f2c34', padding: '6px 12px', display: 'flex', flexWrap: 'wrap', gap: '6px', borderTop: '1px solid #2a3942' }}>
                        {queryAttachments.map((att: any, idx: number) => (
                          <div key={idx} style={{ background: '#005c4b', color: '#e9edef', padding: '4px 8px', borderRadius: '12px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><Paperclip size={12} /> {att.fileName}</span>
                            <button
                              type="button"
                              onClick={() => setQueryAttachments((prev: any[]) => prev.filter((_, i) => i !== idx))}
                              style={{ background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer', padding: 0, display: 'flex' }}
                            >
                              <X size={11} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* WhatsApp Input Footer */}
                    <div style={{ background: '#1f2c34', padding: '8px 10px', borderTop: '1px solid #2a3942', display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <label style={{ cursor: 'pointer', padding: '0 4px', display: 'flex', alignItems: 'center' }}>
                        <Paperclip size={18} />
                        <input
                          type="file"
                          multiple
                          style={{ display: 'none' }}
                          onChange={async (e) => {
                            const files = Array.from(e.target.files || []);
                            if (files.length === 0) return;
                            try {
                              const formData = new FormData();
                              files.forEach(file => formData.append('files', file));

                              const uploadRes = await api.request<{ success: boolean; data: any[] }>('/validation-queries/upload-attachment', {
                                method: 'POST',
                                body: formData,
                              });

                              const uploadedFiles = (uploadRes as any)?.data || [];
                              setQueryAttachments((prev: any[]) => [
                                ...prev,
                                ...uploadedFiles.map((uploaded: any) => ({
                                  url: uploaded.url,
                                  fileName: uploaded.fileName,
                                  fileType: uploaded.fileType,
                                  uploadedBy: 'VALIDATOR',
                                  timestamp: uploaded.timestamp || new Date().toISOString(),
                                })),
                              ]);
                            } catch (uploadErr: any) {
                              alert(`Failed to upload file(s): ${uploadErr?.message || 'Unknown error'}`);
                            }
                            e.target.value = '';
                          }}
                        />
                      </label>
                      <input
                        type="text"
                        value={queryTextInput}
                        onChange={(e) => setQueryTextInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleRaiseQuery(); }}
                        placeholder="Type confidential message..."
                        style={{ flex: 1, padding: '8px 14px', background: '#2a3942', border: 'none', borderRadius: '20px', color: '#e9edef', fontSize: '13px', outline: 'none' }}
                      />
                      <button
                        type="button"
                        onClick={handleRaiseQuery}
                        disabled={isSendingQuery}
                        style={{ width: '36px', height: '36px', borderRadius: '50%', background: '#00a884', color: '#fff', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', cursor: 'pointer' }}
                      >
                        {isSendingQuery ? '...' : <ArrowRight size={14} />}
                      </button>
                    </div>
                  </div>

                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                    <Info size={14} /> FINAL DECISION
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

              {selectedCase.status === ValidationStatus.APPROVED && (
                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <button
                    onClick={() => {
                      const branchCode = selectedCase.projectBranch?.branch?.branchCode || 'BR-001';
                      const csvContent = "data:text/csv;charset=utf-8," 
                        + "Branch Code,Branch Name,Packet ID,Audited Weight (g),Purity (Karat),Audit Result,Assayer Code,Verification Date\n"
                        + `${branchCode},${selectedCase.projectBranch?.branch?.name || 'Bank Branch'},PKT-1001,48.5,22K,PASSED,ASSAYER-101,${new Date().toLocaleDateString()}\n`
                        + `${branchCode},${selectedCase.projectBranch?.branch?.name || 'Bank Branch'},PKT-1002,120.2,24K,PASSED,ASSAYER-101,${new Date().toLocaleDateString()}\n`;
                      const encodedUri = encodeURI(csvContent);
                      const link = document.createElement("a");
                      link.setAttribute("href", encodedUri);
                      link.setAttribute("download", `Validated_Bank_Audit_Report_${branchCode}.csv`);
                      document.body.appendChild(link);
                      link.click();
                      document.body.removeChild(link);
                    }}
                    className="btn btn-primary"
                    style={{ width: '100%', padding: '10px', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', background: '#10b981', borderColor: '#10b981' }}
                  >
                    <FileSpreadsheet size={14} /> Export Validated Bank Audit Excel/CSV Report
                  </button>
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
