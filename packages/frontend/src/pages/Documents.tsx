import React, { useState, useEffect } from 'react';
import { Files, AlertCircle, RefreshCw, Upload, FileText } from 'lucide-react';
import { DocumentStatus } from '@fapoms/shared';

interface Document {
  id: string;
  fileName: string;
  fileSize: number;
  type: string;
  status: DocumentStatus;
  createdAt: string;
  projectBranch?: {
    branch?: {
      name: string;
    };
  };
}

export const Documents: React.FC = () => {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [projectBranchId, setProjectBranchId] = useState('');
  const [docType, setDocType] = useState('CUSTOMER_MASTER_DATA');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    loadDocuments();
  }, []);

  const loadDocuments = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('fapoms_token');
      // Fetch generic lists (default to active project branches placeholders if none specified)
      const response = await fetch('/api/v1/projects', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await response.json();
      if (response.ok && data.success && data.data.length > 0) {
        // Query first branch documents to show live database sync lists
        const pId = data.data[0].id;
        const bResp = await fetch(`/api/v1/projects/${pId}/branches`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const bData = await bResp.json();
        if (bResp.ok && bData.success && bData.data.length > 0) {
          const pbId = bData.data[0].id;
          setProjectBranchId(pbId); // Autofill active queue slot
          const dResp = await fetch(`/api/v1/documents/project-branch/${pbId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          const dData = await dResp.json();
          if (dResp.ok && dData.success) {
            setDocuments(dData.data);
          }
        }
      }
    } catch (err) {
      setError('Network connection error while fetching documents.');
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
      const token = localStorage.getItem('fapoms_token');
      const formData = new FormData();
      formData.append('file', selectedFile);

      const response = await fetch(`/api/v1/documents/upload?projectBranchId=${projectBranchId}&type=${docType}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });

      const data = await response.json();
      if (response.ok && data.success) {
        setSelectedFile(null);
        // Clear input element
        const fileInput = document.getElementById('file-upload-input') as HTMLInputElement;
        if (fileInput) fileInput.value = '';
        loadDocuments();
      } else {
        setError(data.message || 'Upload registration failed.');
      }
    } catch (err) {
      setError('Network connection failed during upload.');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 350px', gap: '24px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)' }}>Document Management</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
              Manage bank branch list documents and final audit reports.
            </p>
          </div>
          <button onClick={loadDocuments} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>Loading documents...</div>
        ) : documents.length === 0 ? (
          <div className="glass-card" style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
            <Files size={48} style={{ margin: '0 auto 16px auto', opacity: 0.5 }} />
            <p>No uploaded documents found for branch link slot. Use panel on the right to upload.</p>
          </div>
        ) : (
          <div className="glass-card" style={{ padding: 0 }}>
            {documents.map((doc) => (
              <div key={doc.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', borderBottom: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <FileText style={{ color: 'var(--accent-primary)' }} />
                  <div>
                    <h5 style={{ fontWeight: 600, fontSize: '14px' }}>{doc.fileName}</h5>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Size: {(doc.fileSize / 1024).toFixed(1)} KB | Type: {doc.type}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <a href={`/api/v1/documents/${doc.id}/download`} target="_blank" rel="noreferrer" className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }}>
                    Download
                  </a>
                  <span className="badge" style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--accent-primary)', padding: '4px 8px' }}>
                    {doc.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upload metadata form panel */}
      <div className="glass-card" style={{ height: 'fit-content', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <h4 style={{ fontWeight: 600, fontSize: '16px' }}>Register & Upload File</h4>
        <form onSubmit={handleUploadSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Project Branch ID (UUID)</label>
            <input
              type="text"
              value={projectBranchId}
              onChange={(e) => setProjectBranchId(e.target.value)}
              placeholder="00000000-0000..."
              required
              style={{ padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Document Type</label>
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value)}
              style={{ padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}
            >
              <option value="CUSTOMER_MASTER_DATA">Customer Master Data</option>
              <option value="RETURNED_AUDIT_PDF">Returned Audit PDF</option>
              <option value="BRANCH_LIST">Branch List</option>
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Select File *</label>
            <input
              id="file-upload-input"
              type="file"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  setSelectedFile(e.target.files[0]);
                }
              }}
              required
              style={{ padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}
            />
          </div>

          <button type="submit" disabled={isUploading} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginTop: '8px' }}>
            <Upload size={16} /> {isUploading ? 'Uploading...' : 'Upload File'}
          </button>
        </form>
      </div>
    </div>
  );
};
