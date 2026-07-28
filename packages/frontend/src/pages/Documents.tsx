import React, { useState, useEffect } from 'react';
import { Files, AlertCircle, RefreshCw, Upload, FileText, Download, Search, Clock, CheckCircle, XCircle } from 'lucide-react';
import type { DocumentStatus } from '@fapoms/shared';
import { api } from '../services/api';

interface Document {
  id: string;
  fileName: string;
  fileSize: number;
  type: string;
  status: DocumentStatus;
  createdAt: string;
  projectBranch?: { branch?: { name: string } };
}

const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
  PENDING: { bg: 'rgba(245,158,11,0.1)', color: '#f59e0b' },
  APPROVED: { bg: 'rgba(16,185,129,0.1)', color: 'var(--status-active)' },
  REJECTED: { bg: 'rgba(239,68,68,0.1)', color: '#ef4444' },
  UPLOADED: { bg: 'rgba(99,102,241,0.1)', color: 'var(--accent-primary)' },
};

export const Documents: React.FC = () => {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [projectBranchId, setProjectBranchId] = useState('');
  const [docType, setDocType] = useState('CUSTOMER_MASTER_DATA');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => { loadDocuments(); }, []);

  const loadDocuments = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const projects = await api.request<any[]>('/projects');
      if (projects && projects.length > 0) {
        const pId = projects[0].id;
        const branches = await api.request<any[]>(`/projects/${pId}/branches`);
        if (branches && branches.length > 0) {
          const pbId = branches[0].id;
          setProjectBranchId(pbId);
          const docs = await api.request<Document[]>(`/documents/project-branch/${pbId}`);
          setDocuments(docs);
        }
      }
    } catch (err: any) {
      setError(err.message || 'Network connection error while fetching documents.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectBranchId || !selectedFile) return;
    setIsUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      await api.request(`/documents/upload?projectBranchId=${projectBranchId}&type=${docType}`, {
        method: 'POST',
        body: formData
      });
      setSelectedFile(null);
      const fileInput = document.getElementById('file-upload-input') as HTMLInputElement;
      if (fileInput) fileInput.value = '';
      loadDocuments();
    } catch (err: any) {
      setError(err.message || 'Upload registration failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const filtered = documents.filter(d =>
    d.fileName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    d.type.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const totalCount = documents.length;
  const pendingCount = documents.filter(d => String(d.status) === 'PENDING').length;
  const approvedCount = documents.filter(d => String(d.status) === 'APPROVED').length;
  const rejectedCount = documents.filter(d => String(d.status) === 'REJECTED').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* ── MASTER DOCUMENT & OCR WORKFLOW HEADER ── */}
      <div style={{ background: 'linear-gradient(90deg, rgba(99,102,241,0.12) 0%, rgba(16,185,129,0.06) 100%)', border: '1px solid rgba(99,102,241,0.25)', padding: '14px 20px', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ backgroundColor: '#6366f1', color: '#fff', fontSize: '11px', fontWeight: 800, padding: '4px 8px', borderRadius: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Master Data & PDF Ingestion
          </span>
          <div>
            <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              Master File Upload & PDF Document Distribution
            </h3>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Upload customer master files, store audit report PDFs, and dispatch incoming documents to the OCR parsing queue.
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button 
            onClick={() => window.location.href = '/validation'} 
            style={{ padding: '6px 12px', background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', borderRadius: '6px', color: '#6ee7b7', fontSize: '12px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            🔍 View OCR Validation Queue ➔
          </button>
        </div>
      </div>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)' }}>Document Management</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>Upload, manage, and track audit documents</p>
        </div>
        <button onClick={loadDocuments} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' }}>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(99,102,241,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Files size={20} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{totalCount}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Total Documents</div></div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(245,158,11,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Clock size={20} style={{ color: '#f59e0b' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{pendingCount}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Pending Review</div></div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(16,185,129,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CheckCircle size={20} style={{ color: 'var(--status-active)' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{approvedCount}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Approved</div></div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(239,68,68,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <XCircle size={20} style={{ color: '#ef4444' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{rejectedCount}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Rejected</div></div>
        </div>
      </div>

      {/* Main Content */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: '20px' }}>
        {/* Document List */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <Search size={14} style={{ position: 'absolute', left: '10px', top: '8px', color: 'var(--text-muted)' }} />
              <input type="text" placeholder="Search documents..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                style={{ width: '100%', padding: '7px 10px 7px 30px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
            </div>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{filtered.length} documents</span>
          </div>

          {error && (
            <div style={{ display: 'flex', gap: '8px', padding: '12px 16px', background: 'rgba(239,68,68,0.08)', color: '#f87171', fontSize: '13px', borderBottom: '1px solid rgba(239,68,68,0.2)' }}>
              <AlertCircle size={14} /><span>{error}</span>
            </div>
          )}

          {isLoading ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
              <Files size={40} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
              <p style={{ fontSize: '14px' }}>{searchTerm ? 'No matching documents.' : 'No documents uploaded yet. Use the upload panel to add files.'}</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>File Name</th>
                    <th>Type</th>
                    <th>Size</th>
                    <th>Status</th>
                    <th>Uploaded</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(doc => {
                    const st = STATUS_STYLES[doc.status] || STATUS_STYLES.PENDING;
                    return (
                      <tr key={doc.id}>
                        <td style={{ fontWeight: 600 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <FileText size={16} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                            {doc.fileName}
                          </div>
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{doc.type.replace(/_/g, ' ')}</td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{(doc.fileSize / 1024).toFixed(1)} KB</td>
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

        {/* Upload Panel for Sajid & Operations Team */}
        <div className="glass-card" style={{ height: 'fit-content', display: 'flex', flexDirection: 'column', gap: '16px', padding: '20px' }}>
          <h4 style={{ fontWeight: 600, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-primary)' }}>
            <Upload size={16} /> Master Customer Excel Upload (Sajid/Operations)
          </h4>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
            Upload customer master Excel file for planned branches. System performs accountability checks against planned branches and dispatches to the external OCR application.
          </p>

          <form onSubmit={handleUploadSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Project Branch Link ID</label>
              <input type="text" value={projectBranchId} onChange={e => setProjectBranchId(e.target.value)} required
                placeholder="e.g. pb-001 or select branch..."
                style={{ padding: '8px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Document Workflow Category</label>
              <select value={docType} onChange={e => setDocType(e.target.value)}
                style={{ padding: '8px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }}>
                <option value="CUSTOMER_MASTER_DATA">Customer Master Excel (Sajid Team)</option>
                <option value="RETURNED_AUDIT_PDF">Returned Scanned Audit PDF (Field Auditor)</option>
                <option value="BRANCH_LIST">Branch Mandate List</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Select File (.xlsx / .pdf)</label>
              <input id="file-upload-input" type="file" onChange={e => { if (e.target.files?.length) setSelectedFile(e.target.files[0]); }} required
                style={{ padding: '8px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
            </div>
            <button type="submit" disabled={isUploading} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '10px' }}>
              <Upload size={15} /> {isUploading ? 'Uploading & Triggering OCR Bridge...' : 'Upload & Send to OCR Engine'}
            </button>
          </form>

          <div style={{ padding: '12px', background: 'rgba(16,185,129,0.06)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(16,185,129,0.2)', fontSize: '11px', color: 'var(--status-active)' }}>
            ✓ Accountability Check: Verification system will cross-reference customer rows against planned branch IDs.
          </div>
        </div>
      </div>
    </div>
  );
};
