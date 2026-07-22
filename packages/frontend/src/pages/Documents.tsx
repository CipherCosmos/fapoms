import React, { useState, useEffect } from 'react';
import { Files, AlertCircle, RefreshCw, Upload, FileText, Download, Search, Clock, CheckCircle, XCircle } from 'lucide-react';
import type { DocumentStatus } from '@fapoms/shared';

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
      const token = localStorage.getItem('fapoms_token');
      const response = await fetch('/api/v1/projects', { headers: { 'Authorization': `Bearer ${token}` } });
      const data = await response.json();
      if (response.ok && data.success && data.data.length > 0) {
        const pId = data.data[0].id;
        const bResp = await fetch(`/api/v1/projects/${pId}/branches`, { headers: { 'Authorization': `Bearer ${token}` } });
        const bData = await bResp.json();
        if (bResp.ok && bData.success && bData.data.length > 0) {
          const pbId = bData.data[0].id;
          setProjectBranchId(pbId);
          const dResp = await fetch(`/api/v1/documents/project-branch/${pbId}`, { headers: { 'Authorization': `Bearer ${token}` } });
          const dData = await dResp.json();
          if (dResp.ok && dData.success) setDocuments(dData.data);
        }
      }
    } catch { setError('Network connection error while fetching documents.'); }
    finally { setIsLoading(false); }
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectBranchId || !selectedFile) return;
    setIsUploading(true);
    setError(null);
    try {
      const token = localStorage.getItem('fapoms_token');
      const formData = new FormData();
      formData.append('file', selectedFile);
      const response = await fetch(`/api/v1/documents/upload?projectBranchId=${projectBranchId}&type=${docType}`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: formData
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setSelectedFile(null);
        const fileInput = document.getElementById('file-upload-input') as HTMLInputElement;
        if (fileInput) fileInput.value = '';
        loadDocuments();
      } else setError(data.message || 'Upload registration failed.');
    } catch { setError('Network connection failed during upload.'); }
    finally { setIsUploading(false); }
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

        {/* Upload Panel */}
        <div className="glass-card" style={{ height: 'fit-content', display: 'flex', flexDirection: 'column', gap: '16px', padding: '20px' }}>
          <h4 style={{ fontWeight: 600, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Upload size={16} /> Upload Document
          </h4>
          <form onSubmit={handleUploadSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Project Branch ID</label>
              <input type="text" value={projectBranchId} onChange={e => setProjectBranchId(e.target.value)} required
                style={{ padding: '8px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Document Type</label>
              <select value={docType} onChange={e => setDocType(e.target.value)}
                style={{ padding: '8px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }}>
                <option value="CUSTOMER_MASTER_DATA">Customer Master Data</option>
                <option value="RETURNED_AUDIT_PDF">Returned Audit PDF</option>
                <option value="BRANCH_LIST">Branch List</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Select File</label>
              <input id="file-upload-input" type="file" onChange={e => { if (e.target.files?.length) setSelectedFile(e.target.files[0]); }} required
                style={{ padding: '8px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
            </div>
            <button type="submit" disabled={isUploading} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
              <Upload size={15} /> {isUploading ? 'Uploading...' : 'Upload File'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
