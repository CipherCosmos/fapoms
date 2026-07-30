import React, { useState, useEffect, useCallback } from 'react';
import { Files, AlertCircle, RefreshCw, Upload, FileText, Download, Search, CheckCircle, Send, Inbox, Truck, LayoutList } from 'lucide-react';
import { connectSocket, getSocket } from '../services/socket';

interface Project {
  id: string;
  name: string;
  status: string;
}

interface Branch {
  id: string;
  name: string;
}

interface AssessmentLink {
  id: string;
  projectId: string;
  branchId: string;
  branch?: Branch;
  project?: Project;
  status: string;
}

interface DocumentItem {
  id: string;
  assessmentId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  type: string;
  status: string;
  createdAt: string;
  assessment?: AssessmentLink;
}

interface DataEntryGroup {
  project: string;
  branch: string;
  documents: DocumentItem[];
}

type Tab = 'upload' | 'data-entry' | 'all';

const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
  UPLOADED: { bg: 'rgba(99,102,241,0.1)', color: 'var(--accent-primary)' },
  DISPATCHED: { bg: 'rgba(245,158,11,0.1)', color: '#f59e0b' },
  RECEIVED: { bg: 'rgba(16,185,129,0.1)', color: 'var(--status-active)' },
  PROCESSED: { bg: 'rgba(139,92,246,0.1)', color: '#a78bfa' },
  ARCHIVED: { bg: 'rgba(107,114,128,0.1)', color: '#9ca3af' },
  GENERATED: { bg: 'rgba(59,130,246,0.1)', color: '#60a5fa' },
};

async function apiGet<T>(endpoint: string): Promise<T> {
  const token = localStorage.getItem('fapoms_token');
  const res = await fetch(`/api/v1${endpoint}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Request failed: ${endpoint}`);
  }
  const json = await res.json();
  return json.data as T;
}

async function apiPost(endpoint: string, body?: any): Promise<any> {
  const token = localStorage.getItem('fapoms_token');
  const res = await fetch(`/api/v1${endpoint}`, {
    method: 'POST',
    headers: {
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Request failed: ${endpoint}`);
  }
  const json = await res.json();
  return json.data;
}

async function apiUpload(endpoint: string, formData: FormData): Promise<any> {
  const token = localStorage.getItem('fapoms_token');
  const res = await fetch(`/api/v1${endpoint}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Upload failed: ${endpoint}`);
  }
  const json = await res.json();
  return json.data;
}

export const Documents: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('upload');

  // Projects & Branches
  const [projects, setProjects] = useState<Project[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [assessments, setAssessments] = useState<AssessmentLink[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [selectedAssessmentId, setSelectedAssessmentId] = useState('');

  // Documents
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [stats, setStats] = useState({ total: 0, uploaded: 0, dispatched: 0, received: 0 });
  const [dataEntryQueue, setDataEntryQueue] = useState<DataEntryGroup[]>([]);

  // Upload
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [docType, setDocType] = useState('PRE_FIELD_AUDIT_PDF');
  const [isUploading, setIsUploading] = useState(false);

  // UI
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [dispatching, setDispatching] = useState<string | null>(null);

  useEffect(() => {
    loadProjects();
    loadStats();
    loadDataEntryQueue();
    connectSocket();
    const socket = getSocket();
    if (socket) {
      socket.on('document:uploaded', () => { loadDocsForCurrentAssessment(); loadStats(); loadDataEntryQueue(); });
      socket.on('document:status-changed', () => { loadDocsForCurrentAssessment(); loadStats(); loadDataEntryQueue(); });
      socket.on('document:received', () => { loadDocsForCurrentAssessment(); loadStats(); loadDataEntryQueue(); });
    }
    return () => {
      const s = getSocket();
      if (s) {
        s.off('document:uploaded');
        s.off('document:status-changed');
        s.off('document:received');
      }
    };
  }, []);

  const loadProjects = async () => {
    try {
      const data = await apiGet<Project[]>('/projects');
      setProjects(data || []);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const loadAssessments = async (projectId: string) => {
    try {
      const data = await apiGet<AssessmentLink[]>(`/projects/${projectId}/branches`);
      setAssessments(data || []);
      const branchList = (data || []).map((pb: AssessmentLink) => pb.branch).filter(Boolean) as Branch[];
      setBranches(branchList);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const loadStats = async () => {
    try {
      const s = await apiGet<{ total: number; uploaded: number; dispatched: number; received: number }>('/documents/stats/summary');
      if (s) setStats(s);
    } catch {}
  };

  const loadDataEntryQueue = async () => {
    try {
      const q = await apiGet<DataEntryGroup[]>('/documents/queue/data-entry');
      if (q) setDataEntryQueue(q);
    } catch {}
  };

  const loadDocsForCurrentAssessment = useCallback(async () => {
    try {
      if (selectedAssessmentId) {
        const docs = await apiGet<DocumentItem[]>(`/documents/assessment/${selectedAssessmentId}`);
        setDocuments(docs || []);
      } else {
        const docs = await apiGet<DocumentItem[]>('/documents');
        setDocuments(docs || []);
      }
    } catch (err: any) {
      setError(err.message);
    }
  }, [selectedAssessmentId]);

  useEffect(() => {
    loadDocsForCurrentAssessment();
  }, [selectedAssessmentId, loadDocsForCurrentAssessment]);

  const handleProjectChange = async (projectId: string) => {
    setSelectedProjectId(projectId);
    setSelectedBranchId('');
    setSelectedAssessmentId('');
    setDocuments([]);
    if (projectId) {
      await loadAssessments(projectId);
    } else {
      setBranches([]);
      setAssessments([]);
    }
  };

  const handleBranchChange = (branchId: string) => {
    setSelectedBranchId(branchId);
    const link = assessments.find(pb => pb.branchId === branchId);
    setSelectedAssessmentId(link?.id || '');
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAssessmentId || !selectedFile) return;
    setIsUploading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      await apiUpload(`/documents/upload?assessmentId=${selectedAssessmentId}&type=${docType}`, formData);
      setSelectedFile(null);
      const fileInput = document.getElementById('doc-upload-input') as HTMLInputElement;
      if (fileInput) fileInput.value = '';
      setSuccessMsg(`File "${selectedFile.name}" uploaded successfully.`);
      await loadDocsForCurrentAssessment();
      await loadStats();
    } catch (err: any) {
      setError(err.message || 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDispatch = async (docId: string) => {
    setDispatching(docId);
    setError(null);
    setSuccessMsg(null);
    try {
      const result = await apiPost(`/documents/${docId}/dispatch`);
      setSuccessMsg(result?.message || 'Document dispatched.');
      await loadDocsForCurrentAssessment();
      await loadStats();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDispatching(null);
    }
  };

  const handleReceive = async (docId: string) => {
    setError(null);
    setSuccessMsg(null);
    try {
      const result = await apiPost(`/documents/${docId}/receive`);
      setSuccessMsg(result?.message || 'Document received.');
      await loadDocsForCurrentAssessment();
      await loadStats();
      await loadDataEntryQueue();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const filtered = documents.filter(d =>
    d.fileName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    d.type.toLowerCase().includes(searchTerm.toLowerCase()) ||
    d.status.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'upload', label: 'Upload & Dispatch', icon: <Upload size={14} /> },
    { key: 'data-entry', label: 'Data Entry Queue', icon: <LayoutList size={14} /> },
    { key: 'all', label: 'All Documents', icon: <FileText size={14} /> },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Header */}
      <div style={{ background: 'linear-gradient(90deg, rgba(99,102,241,0.12) 0%, rgba(16,185,129,0.06) 100%)', border: '1px solid rgba(99,102,241,0.25)', padding: '14px 20px', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ backgroundColor: '#6366f1', color: '#fff', fontSize: '11px', fontWeight: 800, padding: '4px 8px', borderRadius: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Document Transportation
          </span>
          <div>
            <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              PDF Dispatch & Audit Return Tracking
            </h3>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Upload generated PDFs per branch, dispatch to assayers, track returned audits
            </span>
          </div>
        </div>
        <button onClick={() => { loadStats(); loadDataEntryQueue(); loadDocsForCurrentAssessment(); }} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' }}>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(99,102,241,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Files size={20} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{stats.total}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Total Documents</div></div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(99,102,241,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Upload size={20} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{stats.uploaded}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Awaiting Dispatch</div></div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(245,158,11,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Send size={20} style={{ color: '#f59e0b' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{stats.dispatched}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Dispatched to Assayer</div></div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(16,185,129,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Inbox size={20} style={{ color: 'var(--status-active)' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{stats.received}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Received Back</div></div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
        {tabs.map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderRadius: 'var(--radius-md)', border: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
              background: activeTab === tab.key ? 'var(--accent-primary)' : 'transparent',
              color: activeTab === tab.key ? '#fff' : 'var(--text-secondary)',
              transition: 'all 0.15s ease',
            }}>
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ display: 'flex', gap: '8px', padding: '12px 16px', background: 'rgba(239,68,68,0.08)', color: '#f87171', fontSize: '13px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <AlertCircle size={14} /><span>{error}</span>
          <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: '14px' }}>&times;</button>
        </div>
      )}
      {successMsg && (
        <div style={{ display: 'flex', gap: '8px', padding: '12px 16px', background: 'rgba(16,185,129,0.08)', color: '#6ee7b7', fontSize: '13px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(16,185,129,0.2)' }}>
          <CheckCircle size={14} /><span>{successMsg}</span>
          <button onClick={() => setSuccessMsg(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#6ee7b7', cursor: 'pointer', fontSize: '14px' }}>&times;</button>
        </div>
      )}

      {/* ──────────────── TAB: Upload & Dispatch ──────────────── */}
      {activeTab === 'upload' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '20px' }}>
          {/* Left: Document table for selected branch */}
          <div className="glass-card" style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <Search size={14} style={{ position: 'absolute', left: '10px', top: '8px', color: 'var(--text-muted)' }} />
                <input type="text" placeholder="Search documents..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                  style={{ width: '100%', padding: '7px 10px 7px 30px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
              </div>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{filtered.length} docs</span>
            </div>

            {!selectedAssessmentId ? (
              <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                <Truck size={40} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
                <p style={{ fontSize: '14px' }}>Select a project and branch to view and manage documents.</p>
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                <FileText size={40} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
                <p style={{ fontSize: '14px' }}>No documents for this branch yet. Upload a generated PDF.</p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>File Name</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Uploaded</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(doc => {
                      const st = STATUS_STYLES[doc.status] || { bg: 'rgba(107,114,128,0.1)', color: '#9ca3af' };
                      return (
                        <tr key={doc.id}>
                          <td style={{ fontWeight: 600 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <FileText size={16} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                              {doc.fileName}
                            </div>
                          </td>
                          <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{doc.type.replace(/_/g, ' ')}</td>
                          <td>
                            <span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600, background: st.bg, color: st.color }}>
                              {doc.status}
                            </span>
                          </td>
                          <td style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{new Date(doc.createdAt).toLocaleDateString()}</td>
                          <td>
                            <div style={{ display: 'flex', gap: '6px' }}>
                              <a href={`/api/v1/documents/${doc.id}/download`} target="_blank" rel="noreferrer"
                                style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px', background: 'rgba(99,102,241,0.1)', borderRadius: 'var(--radius-sm)', color: 'var(--accent-primary)', fontSize: '11px', textDecoration: 'none' }}>
                                <Download size={12} />
                              </a>
                              {doc.status === 'UPLOADED' && (
                                <button onClick={() => handleDispatch(doc.id)} disabled={dispatching === doc.id}
                                  style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px', background: 'rgba(245,158,11,0.1)', borderRadius: 'var(--radius-sm)', color: '#f59e0b', fontSize: '11px', border: 'none', cursor: 'pointer' }}>
                                  <Send size={12} /> {dispatching === doc.id ? '...' : 'Dispatch'}
                                </button>
                              )}
                              {doc.status === 'DISPATCHED' && (
                                <button onClick={() => handleReceive(doc.id)}
                                  style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px', background: 'rgba(16,185,129,0.1)', borderRadius: 'var(--radius-sm)', color: 'var(--status-active)', fontSize: '11px', border: 'none', cursor: 'pointer' }}>
                                  <Inbox size={12} /> Receive
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Right: Upload Panel */}
          <div className="glass-card" style={{ height: 'fit-content', display: 'flex', flexDirection: 'column', gap: '16px', padding: '20px' }}>
            <h4 style={{ fontWeight: 600, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-primary)' }}>
              <Upload size={16} /> Upload Generated PDF
            </h4>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
              Select project, branch, and upload the OCR-generated PDF for dispatch to the assayer.
            </p>

            <form onSubmit={handleUploadSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Project</label>
                <select value={selectedProjectId} onChange={e => handleProjectChange(e.target.value)} required
                  style={{ padding: '8px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }}>
                  <option value="">-- Select Project --</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Branch</label>
                <select value={selectedBranchId} onChange={e => handleBranchChange(e.target.value)} required disabled={!selectedProjectId}
                  style={{ padding: '8px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }}>
                  <option value="">-- Select Branch --</option>
                  {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              {selectedAssessmentId && (
                <div style={{ padding: '6px 10px', background: 'rgba(99,102,241,0.06)', borderRadius: 'var(--radius-sm)', fontSize: '11px', color: 'var(--text-muted)' }}>
                  Assessment ID: {selectedAssessmentId}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Document Type</label>
                <select value={docType} onChange={e => setDocType(e.target.value)}
                  style={{ padding: '8px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }}>
                  <option value="PRE_FIELD_AUDIT_PDF">Generated Audit PDF (to dispatch)</option>
                  <option value="CUSTOMER_MASTER_DATA">Customer Master Excel</option>
                  <option value="BRANCH_LIST">Branch Mandate List</option>
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Select File</label>
                <input id="doc-upload-input" type="file" onChange={e => { if (e.target.files?.length) setSelectedFile(e.target.files[0]); }} required
                  style={{ padding: '8px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
              </div>
              <button type="submit" disabled={isUploading || !selectedAssessmentId} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '10px' }}>
                <Upload size={15} /> {isUploading ? 'Uploading...' : 'Upload PDF'}
              </button>
            </form>

            <div style={{ padding: '12px', background: 'rgba(16,185,129,0.06)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(16,185,129,0.2)', fontSize: '11px', color: 'var(--status-active)' }}>
              <strong>Dispatch Flow:</strong> Upload &rarr; click "Dispatch" &rarr; push notification sent to assayer &rarr; assayer submits scanned PDF &rarr; click "Receive".
            </div>
          </div>
        </div>
      )}

      {/* ──────────────── TAB: Data Entry Queue ──────────────── */}
      {activeTab === 'data-entry' && (
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h4 style={{ fontWeight: 600, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <LayoutList size={16} style={{ color: 'var(--accent-primary)' }} /> Received PDFs Ready for Data Entry
            </h4>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{dataEntryQueue.reduce((sum, g) => sum + g.documents.length, 0)} documents</span>
          </div>

          {dataEntryQueue.length === 0 ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
              <Inbox size={40} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
              <p style={{ fontSize: '14px' }}>No received PDFs yet. Dispatch documents to assayers and wait for return.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {dataEntryQueue.map((group, idx) => (
                <div key={idx} style={{ borderBottom: idx < dataEntryQueue.length - 1 ? '1px solid var(--border-color)' : 'none' }}>
                  <div style={{ padding: '12px 16px', background: 'rgba(99,102,241,0.04)', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <FileText size={14} style={{ color: 'var(--accent-primary)' }} />
                    <span style={{ fontWeight: 600, fontSize: '13px' }}>{group.project} / {group.branch}</span>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: 'auto' }}>{group.documents.length} PDF{group.documents.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>File Name</th>
                          <th>Status</th>
                          <th>Received</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.documents.map(doc => (
                          <tr key={doc.id}>
                            <td style={{ fontWeight: 600 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <FileText size={14} style={{ color: 'var(--status-active)', flexShrink: 0 }} />
                                {doc.fileName}
                              </div>
                            </td>
                            <td>
                              <span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600, background: 'rgba(16,185,129,0.1)', color: 'var(--status-active)' }}>
                                {doc.status}
                              </span>
                            </td>
                            <td style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{new Date(doc.createdAt).toLocaleDateString()}</td>
                            <td>
                              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                <a href={`/api/v1/documents/${doc.id}/download`} target="_blank" rel="noreferrer"
                                  style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 10px', background: 'rgba(99,102,241,0.1)', borderRadius: 'var(--radius-sm)', color: 'var(--accent-primary)', fontSize: '12px', textDecoration: 'none' }}>
                                  <Download size={12} /> Download PDF
                                </a>

                                {doc.status !== 'SENT_TO_EXTERNAL_OCR' && doc.status !== 'COMPLETED' && (
                                  <button onClick={async () => {
                                    try {
                                      await apiPost(`/documents/${doc.id}/send-external-ocr`);
                                      setSuccessMsg('PDF marked as sent to External OCR Application.');
                                      await loadDataEntryQueue();
                                    } catch (err: any) {
                                      setError(err.message);
                                    }
                                  }} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 10px', background: 'rgba(245,158,11,0.1)', borderRadius: 'var(--radius-sm)', color: '#f59e0b', fontSize: '12px', border: 'none', cursor: 'pointer' }}>
                                    Send to External OCR
                                  </button>
                                )}

                                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 10px', background: 'rgba(16,185,129,0.1)', borderRadius: 'var(--radius-sm)', color: 'var(--status-active)', fontSize: '12px', cursor: 'pointer', margin: 0 }}>
                                  <Upload size={12} /> Upload Excel
                                  <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={async (e) => {
                                    if (e.target.files?.length && doc.assessmentId) {
                                      const formData = new FormData();
                                      formData.append('file', e.target.files[0]);
                                      try {
                                        await apiUpload(`/documents/upload-excel?assessmentId=${doc.assessmentId}`, formData);
                                        setSuccessMsg(`Excel report uploaded for Assessment. Assessment COMPLETED!`);
                                        await loadDataEntryQueue();
                                        await loadStats();
                                      } catch (err: any) {
                                        setError(err.message);
                                      }
                                    }
                                  }} />
                                </label>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ──────────────── TAB: All Documents ──────────────── */}
      {activeTab === 'all' && (
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <Search size={14} style={{ position: 'absolute', left: '10px', top: '8px', color: 'var(--text-muted)' }} />
              <input type="text" placeholder="Search across all documents..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                style={{ width: '100%', padding: '7px 10px 7px 30px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
            </div>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{filtered.length} documents</span>
          </div>
          <p style={{ padding: '12px 16px', margin: 0, fontSize: '12px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>
            Browse documents across all projects. Select a specific branch in the Upload tab for document management actions.
          </p>
          {filtered.length === 0 ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
              <Files size={40} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
              <p style={{ fontSize: '14px' }}>No documents found.</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>File Name</th>
                    <th>Type</th>
                    <th>Project / Branch</th>
                    <th>Status</th>
                    <th>Uploaded</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(doc => {
                    const st = STATUS_STYLES[doc.status] || { bg: 'rgba(107,114,128,0.1)', color: '#9ca3af' };
                    const asmt = doc.assessment;
                    return (
                      <tr key={doc.id}>
                        <td style={{ fontWeight: 600 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <FileText size={16} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                            {doc.fileName}
                          </div>
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{doc.type.replace(/_/g, ' ')}</td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {asmt?.project?.name || '?'} / {asmt?.branch?.name || '?'}
                        </td>
                        <td>
                          <span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600, background: st.bg, color: st.color }}>
                            {doc.status}
                          </span>
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{new Date(doc.createdAt).toLocaleDateString()}</td>
                        <td>
                          <a href={`/api/v1/documents/${doc.id}/download`} target="_blank" rel="noreferrer"
                            style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 10px', background: 'rgba(99,102,241,0.1)', borderRadius: 'var(--radius-sm)', color: 'var(--accent-primary)', fontSize: '12px', textDecoration: 'none' }}>
                            <Download size={12} /> Download
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
