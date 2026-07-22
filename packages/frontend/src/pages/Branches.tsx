import React, { useState, useEffect } from 'react';
import { Search, Upload, AlertCircle, CheckCircle, Building2, Globe, ShieldAlert, Activity, Plus, Edit2, Trash2, Phone, FileText, User, Filter, ChevronDown } from 'lucide-react';
import { api } from '../services/api';

interface ClientOption {
  id: string;
  clientCode: string;
  name: string;
}

interface Branch {
  id: string;
  branchCode: string;
  solId: string | null;
  name: string;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode: string | null;
  region: string | null;
  territory: string | null;
  zoneId: string | null;
  branchType: string | null;
  phone: string | null;
  email: string | null;
  managerName: string | null;
  openingDate: string | null;
  lastAuditDate: string | null;
  operatingHours: Record<string, any> | null;
  latitude: number | null;
  longitude: number | null;
  clientId: string | null;
  riskScore: number;
  riskCategory: string | null;
  complexity: string;
  estimatedDurationHours: number;
  requiredCompetencies: string[] | null;
  client?: ClientOption;
}

interface BranchDetail extends Branch {
  contacts: BranchContact[];
  documents: BranchDocument[];
}

interface BranchContact {
  id: string;
  name: string;
  email: string;
  phone: string;
  designation: string;
  department: string | null;
  isPrimary: boolean;
  notes: string | null;
}

interface BranchDocument {
  id: string;
  fileName: string;
  category: string;
  fileSize: number;
  remarks: string | null;
}

interface BranchFormData {
  branchCode: string;
  solId: string;
  name: string;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode: string;
  region: string;
  territory: string;
  zoneId: string;
  branchType: string;
  phone: string;
  email: string;
  managerName: string;
  openingDate: string;
  lastAuditDate: string;
  latitude: string;
  longitude: string;
  riskScore: string;
  riskCategory: string;
  complexity: string;
  estimatedDurationHours: string;
  requiredCompetencies: string;
  clientId: string;
}

const emptyForm: BranchFormData = {
  branchCode: '', solId: '', name: '', address: '', state: '', district: '', city: '',
  pincode: '', region: '', territory: '', zoneId: '', branchType: '', phone: '', email: '',
  managerName: '', openingDate: '', lastAuditDate: '', latitude: '', longitude: '',
  riskScore: '', riskCategory: '', complexity: 'STANDARD', estimatedDurationHours: '8',
  requiredCompetencies: '', clientId: '',
};

const RISK_CATEGORIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const COMPLEXITIES = ['STANDARD', 'COMPLEX', 'VERY_COMPLEX'];
const BRANCH_TYPES = ['MAIN', 'BRANCH', 'SUB_BRANCH', 'EXTENSION', 'MICRO'];

const INDIAN_STATES = [
  { value: 'Andhra Pradesh', label: 'Andhra Pradesh' }, { value: 'Arunachal Pradesh', label: 'Arunachal Pradesh' },
  { value: 'Assam', label: 'Assam' }, { value: 'Bihar', label: 'Bihar' },
  { value: 'Chhattisgarh', label: 'Chhattisgarh' }, { value: 'Goa', label: 'Goa' },
  { value: 'Gujarat', label: 'Gujarat' }, { value: 'Haryana', label: 'Haryana' },
  { value: 'Himachal Pradesh', label: 'Himachal Pradesh' }, { value: 'Jharkhand', label: 'Jharkhand' },
  { value: 'Karnataka', label: 'Karnataka' }, { value: 'Kerala', label: 'Kerala' },
  { value: 'Madhya Pradesh', label: 'Madhya Pradesh' }, { value: 'Maharashtra', label: 'Maharashtra' },
  { value: 'Manipur', label: 'Manipur' }, { value: 'Meghalaya', label: 'Meghalaya' },
  { value: 'Mizoram', label: 'Mizoram' }, { value: 'Nagaland', label: 'Nagaland' },
  { value: 'Odisha', label: 'Odisha' }, { value: 'Punjab', label: 'Punjab' },
  { value: 'Rajasthan', label: 'Rajasthan' }, { value: 'Sikkim', label: 'Sikkim' },
  { value: 'Tamil Nadu', label: 'Tamil Nadu' }, { value: 'Telangana', label: 'Telangana' },
  { value: 'Tripura', label: 'Tripura' }, { value: 'Uttar Pradesh', label: 'Uttar Pradesh' },
  { value: 'Uttarakhand', label: 'Uttarakhand' }, { value: 'West Bengal', label: 'West Bengal' },
  { value: 'Andaman and Nicobar Islands', label: 'Andaman and Nicobar Islands' },
  { value: 'Chandigarh', label: 'Chandigarh' }, { value: 'Delhi', label: 'Delhi' },
  { value: 'Jammu and Kashmir', label: 'Jammu and Kashmir' }, { value: 'Ladakh', label: 'Ladakh' },
  { value: 'Lakshadweep', label: 'Lakshadweep' }, { value: 'Puducherry', label: 'Puducherry' },
];

export const Branches: React.FC = () => {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  const [stateFilter, setStateFilter] = useState('ALL');
  const [regionFilter, setRegionFilter] = useState('ALL');
  const [riskFilter, setRiskFilter] = useState('ALL');
  const [showFilters, setShowFilters] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);
  const [branchDetail, setBranchDetail] = useState<BranchDetail | null>(null);
  const [showContactModal, setShowContactModal] = useState(false);

  useEffect(() => { loadClients(); loadBranches(); }, []);
  useEffect(() => { loadBranches(selectedClientId); }, [selectedClientId]);

  const loadClients = async () => {
    try {
      const response = await api.request<ClientOption[]>('/clients');
      setClients(response);
      if (response.length > 0 && !selectedClientId) setSelectedClientId(response[0].id);
    } catch (err) { console.error('Failed to load clients'); }
  };

  const loadBranches = async (clientId?: string) => {
    setIsLoading(true);
    try {
      const url = clientId ? `/branches?clientId=${clientId}&limit=500` : '/branches?limit=500';
      const response = await api.request<Branch[]>(url);
      setBranches(response);
    } catch (err) { console.error('Failed to load branches'); }
    finally { setIsLoading(false); }
  };

  const loadBranchDetail = async (branch: Branch) => {
    setSelectedBranch(branch);
    try {
      const detail = await api.request<BranchDetail>(`/branches/${branch.id}`);
      setBranchDetail(detail);
    } catch (err) { console.error('Failed to load branch details'); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this branch?')) return;
    try {
      await api.request(`/branches/${id}`, { method: 'DELETE' });
      setMessage({ type: 'success', text: 'Branch deleted.' });
      if (selectedBranch?.id === id) { setSelectedBranch(null); setBranchDetail(null); }
      loadBranches(selectedClientId);
    } catch (err) { alert(err instanceof Error ? err.message : 'Failed to delete'); }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedClientId) return;
    setIsUploading(true); setMessage(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await fetch(`/api/v1/branches/import/${selectedClientId}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('fapoms_token')}` },
        body: formData
      });
      const resData = await response.json();
      if (response.ok && resData.success) {
        const { importedCount, errors } = resData.data;
        let msg = `Successfully imported ${importedCount} branches.`;
        if (errors?.length > 0) msg += ` Excluded ${errors.length} rows due to validation errors.`;
        setMessage({ type: 'success', text: msg });
        loadBranches(selectedClientId);
      } else {
        setMessage({ type: 'error', text: resData.message || 'Import failed.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Network connection error during file upload.' });
    } finally { setIsUploading(false); e.target.value = ''; }
  };

  const filteredBranches = branches.filter(b => {
    const matchesSearch = !searchTerm || b.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      b.branchCode.toLowerCase().includes(searchTerm.toLowerCase()) || (b.solId && b.solId.includes(searchTerm));
    const matchesState = stateFilter === 'ALL' || b.state === stateFilter;
    const matchesRegion = regionFilter === 'ALL' || b.region === regionFilter;
    const matchesRisk = riskFilter === 'ALL' || b.riskCategory === riskFilter;
    return matchesSearch && matchesState && matchesRegion && matchesRisk;
  });

  const states = [...new Set(branches.map(b => b.state).filter(Boolean))].sort();
  const regions = [...new Set(branches.map(b => b.region).filter((r): r is string => r !== null))].sort();

  const totalCount = branches.length;
  const regionCount = new Set(branches.map(b => b.region).filter(Boolean)).size;
  const highRiskCount = branches.filter(b => b.riskCategory === 'HIGH' || b.riskCategory === 'CRITICAL').length;
  const standardCount = branches.filter(b => b.complexity === 'STANDARD').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
        {[
          { label: 'Total Branches', value: totalCount, icon: Building2, color: 'var(--accent-primary)' },
          { label: 'Regions Covered', value: regionCount, icon: Globe, color: 'var(--status-active)' },
          { label: 'High / Critical Risk', value: highRiskCount, icon: ShieldAlert, color: '#ef4444' },
          { label: 'Standard Complexity', value: standardCount, icon: Activity, color: 'var(--accent-secondary)' },
        ].map(card => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '16px' }}>
              <div style={{ width: '44px', height: '44px', borderRadius: 'var(--radius-md)', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: card.color }}>
                <Icon size={22} />
              </div>
              <div>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500 }}>{card.label}</span>
                <h4 style={{ fontSize: '24px', fontWeight: 800, margin: '2px 0', color: '#fff' }}>{card.value}</h4>
              </div>
            </div>
          );
        })}
      </div>

      {message && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', borderRadius: 'var(--radius-md)', fontSize: '13px', border: '1px solid',
          background: message.type === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
          borderColor: message.type === 'success' ? 'var(--accent-secondary)' : 'rgba(239,68,68,0.4)',
          color: message.type === 'success' ? 'var(--accent-secondary)' : '#f87171' }}>
          {message.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
          <span>{message.text}</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 420px', gap: '24px', alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Toolbar */}
          <div className="glass-card" style={{ padding: '14px 16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <label style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Client</label>
              <select value={selectedClientId} onChange={(e) => setSelectedClientId(e.target.value)}
                style={{ padding: '6px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', minWidth: '160px' }}>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name} ({c.clientCode})</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <label style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Excel Import</label>
              <label className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 14px', cursor: isUploading ? 'not-allowed' : 'pointer', fontSize: '13px', opacity: isUploading ? 0.7 : 1 }}>
                <Upload size={14} /> {isUploading ? 'Uploading...' : 'Import Excel'}
                <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFileUpload} disabled={isUploading} style={{ display: 'none' }} />
              </label>
            </div>
            <div style={{ position: 'relative', flex: 1, minWidth: '180px' }}>
              <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input type="text" placeholder="Search by name, code or SOL ID..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
                style={{ width: '100%', padding: '6px 10px 6px 28px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px' }} />
            </div>
            <button onClick={() => setShowFilters(!showFilters)} className="btn btn-secondary" style={{ padding: '6px 10px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Filter size={13} /> Filters <ChevronDown size={12} style={{ transform: showFilters ? 'rotate(180deg)' : '' }} />
            </button>
            <button onClick={() => setShowCreateModal(true)} className="btn btn-primary" style={{ padding: '6px 14px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Plus size={14} /> Add Branch
            </button>
          </div>

          {/* Advanced Filters */}
          {showFilters && (
            <div className="glass-card" style={{ padding: '12px 16px', display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>State:</span>
                <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}
                  style={{ padding: '6px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '12px' }}>
                  <option value="ALL">All</option>
                  {states.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>Region:</span>
                <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)}
                  style={{ padding: '6px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '12px' }}>
                  <option value="ALL">All</option>
                  {regions.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>Risk:</span>
                <select value={riskFilter} onChange={(e) => setRiskFilter(e.target.value)}
                  style={{ padding: '6px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '12px' }}>
                  <option value="ALL">All</option>
                  {RISK_CATEGORIES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* Table */}
          <div className="table-container">
            {isLoading ? (
              <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading branch master repository...</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Code</th><th>SOL ID</th><th>Branch Name</th><th>City / State</th><th>Region</th><th>Risk</th><th>Type</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBranches.length === 0 ? (
                    <tr><td colSpan={8} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)' }}>No branches found.</td></tr>
                  ) : filteredBranches.map((b) => (
                    <tr key={b.id || b.branchCode}
                      onClick={() => loadBranchDetail(b)}
                      style={{ cursor: 'pointer', background: selectedBranch?.id === b.id ? 'rgba(99, 102, 241, 0.08)' : undefined }}>
                      <td style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{b.branchCode}</td>
                      <td style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{b.solId || '-'}</td>
                      <td style={{ fontWeight: 600, fontSize: '14px' }}>{b.name}</td>
                      <td style={{ fontSize: '13px' }}>{b.city}, {b.state}</td>
                      <td style={{ fontSize: '13px' }}>{b.region || '-'}</td>
                      <td>
                        <span className="badge" style={{ padding: '2px 8px', fontSize: '11px',
                          background: b.riskCategory === 'HIGH' || b.riskCategory === 'CRITICAL' ? 'rgba(239,68,68,0.1)' : b.riskCategory === 'MEDIUM' ? 'rgba(245,158,11,0.1)' : 'rgba(16,185,129,0.1)',
                          color: b.riskCategory === 'HIGH' || b.riskCategory === 'CRITICAL' ? '#ef4444' : b.riskCategory === 'MEDIUM' ? '#f59e0b' : 'var(--status-active)' }}>
                          {b.riskCategory || '-'}
                        </span>
                      </td>
                      <td style={{ fontSize: '12px' }}>{b.branchType || '-'}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button onClick={() => { setEditingBranch(b); setShowEditModal(true); }} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '11px' }}><Edit2 size={11} /></button>
                          <button onClick={() => handleDelete(b.id)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '11px', color: '#ef4444' }}><Trash2 size={11} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Detail Panel */}
        <div className="glass-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px', maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' }}>
          {selectedBranch && branchDetail ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' }}>{branchDetail.branchCode}</span>
                  <h4 style={{ fontSize: '16px', fontWeight: 700, margin: '2px 0' }}>{branchDetail.name}</h4>
                </div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button onClick={() => { setEditingBranch(selectedBranch); setShowEditModal(true); }} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '11px' }}><Edit2 size={11} /></button>
                  <button onClick={() => setShowContactModal(true)} className="btn btn-primary" style={{ padding: '4px 10px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Plus size={11} /> Contact
                  </button>
                </div>
              </div>

              {/* Info Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px', padding: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
                <InfoRow label="SOL ID" value={branchDetail.solId || '-'} />
                <InfoRow label="Branch Type" value={branchDetail.branchType || '-'} />
                <InfoRow label="Region" value={branchDetail.region || '-'} />
                <InfoRow label="Territory" value={branchDetail.territory || '-'} />
                <InfoRow label="Manager" value={branchDetail.managerName || '-'} />
                <InfoRow label="Risk Category" value={branchDetail.riskCategory || '-'} />
                <InfoRow label="Risk Score" value={branchDetail.riskScore != null ? String(Number(branchDetail.riskScore).toFixed(2)) : '-'} />
                <InfoRow label="Complexity" value={branchDetail.complexity} />
                <InfoRow label="Est. Duration" value={branchDetail.estimatedDurationHours != null ? `${branchDetail.estimatedDurationHours}h` : '-'} />
                <InfoRow label="Phone" value={branchDetail.phone || '-'} />
                {branchDetail.email && <InfoRow label="Email" value={branchDetail.email} full />}
                <InfoRow label="Opening Date" value={branchDetail.openingDate ? new Date(branchDetail.openingDate).toLocaleDateString() : '-'} />
                <InfoRow label="Last Audit" value={branchDetail.lastAuditDate ? new Date(branchDetail.lastAuditDate).toLocaleDateString() : '-'} />
                <div style={{ gridColumn: '1 / -1' }}><span style={{ color: 'var(--text-muted)' }}>Address</span><div style={{ fontWeight: 600, marginTop: '2px' }}>{branchDetail.address}, {branchDetail.city}, {branchDetail.state} - {branchDetail.pincode || 'N/A'}</div></div>
                {branchDetail.latitude && branchDetail.longitude && (
                  <div style={{ gridColumn: '1 / -1' }}><span style={{ color: 'var(--text-muted)' }}>Coordinates</span>
                    <div style={{ fontWeight: 600, fontFamily: 'monospace', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>{Number(branchDetail.latitude).toFixed(4)}, {Number(branchDetail.longitude).toFixed(4)}</span>
                      <a href={`https://www.google.com/maps/search/?api=1&query=${branchDetail.latitude},${branchDetail.longitude}`}
                        target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: '11px', color: 'var(--accent-primary)', display: 'inline-flex', alignItems: 'center', gap: '2px', textDecoration: 'none' }}>
                        🗺️ Verify on Google Maps
                      </a>
                    </div>
                  </div>
                )}
                {branchDetail.requiredCompetencies && branchDetail.requiredCompetencies.length > 0 && (
                  <div style={{ gridColumn: '1 / -1' }}><span style={{ color: 'var(--text-muted)' }}>Competencies</span><div style={{ fontWeight: 600, marginTop: '2px' }}>{branchDetail.requiredCompetencies.join(', ')}</div></div>
                )}
              </div>

              {/* Contacts */}
              <div>
                <h5 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Phone size={13} /> Contacts ({branchDetail.contacts?.length || 0})
                </h5>
                {(!branchDetail.contacts || branchDetail.contacts.length === 0) ? (
                  <div style={{ padding: '12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)' }}>No contacts added yet.</div>
                ) : branchDetail.contacts.map(c => (
                  <div key={c.id} style={{ padding: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', fontSize: '12px', marginBottom: '8px' }}>
                    <div style={{ fontWeight: 600, display: 'flex', justifyContent: 'space-between' }}>
                      <span>{c.name} {c.isPrimary && <span style={{ fontSize: '10px', color: 'var(--accent-secondary)' }}>(PRIMARY)</span>}</span>
                    </div>
                    <div style={{ color: 'var(--text-muted)' }}>{c.designation}{c.department && ` • ${c.department}`}</div>
                    <div style={{ color: 'var(--text-secondary)', display: 'flex', gap: '10px', fontSize: '11px', marginTop: '2px' }}><span>{c.email}</span><span>{c.phone}</span></div>
                  </div>
                ))}
              </div>

              {/* Documents */}
              <div>
                <h5 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <FileText size={13} /> Documents ({branchDetail.documents?.length || 0})
                </h5>
                {(!branchDetail.documents || branchDetail.documents.length === 0) ? (
                  <div style={{ padding: '12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)' }}>No documents.</div>
                ) : branchDetail.documents.map(d => (
                  <div key={d.id} style={{ padding: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', fontSize: '12px', marginBottom: '8px' }}>
                    <div style={{ fontWeight: 600 }}>{d.fileName}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{d.category} • {(d.fileSize / 1024).toFixed(1)} KB{d.remarks && ` • ${d.remarks}`}</div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '300px', color: 'var(--text-muted)' }}>
              <Building2 size={40} style={{ opacity: 0.4, marginBottom: '12px' }} />
              <span style={{ fontSize: '13px' }}>Select a branch to view details</span>
            </div>
          )}
        </div>
      </div>

      {showCreateModal && (
        <BranchFormModal
          title="Add Branch"
          initial={{ ...emptyForm, clientId: selectedClientId }}
          clientOptions={clients}
          onClose={() => setShowCreateModal(false)}
          onSaved={() => loadBranches(selectedClientId)}
        />
      )}

      {showEditModal && editingBranch && (
        <BranchFormModal
          title="Edit Branch"
          branchId={editingBranch.id}
          initial={{
            branchCode: editingBranch.branchCode,
            solId: editingBranch.solId || '',
            name: editingBranch.name,
            address: editingBranch.address,
            state: editingBranch.state,
            district: editingBranch.district,
            city: editingBranch.city,
            pincode: editingBranch.pincode || '',
            region: editingBranch.region || '',
            territory: editingBranch.territory || '',
            zoneId: editingBranch.zoneId || '',
            branchType: editingBranch.branchType || '',
            phone: editingBranch.phone || '',
            email: editingBranch.email || '',
            managerName: editingBranch.managerName || '',
            openingDate: editingBranch.openingDate || '',
            lastAuditDate: editingBranch.lastAuditDate || '',
            latitude: editingBranch.latitude ? String(editingBranch.latitude) : '',
            longitude: editingBranch.longitude ? String(editingBranch.longitude) : '',
            riskScore: editingBranch.riskScore ? String(editingBranch.riskScore) : '',
            riskCategory: editingBranch.riskCategory || '',
            complexity: editingBranch.complexity || 'STANDARD',
            estimatedDurationHours: editingBranch.estimatedDurationHours ? String(editingBranch.estimatedDurationHours) : '8',
            requiredCompetencies: editingBranch.requiredCompetencies?.join(', ') || '',
            clientId: editingBranch.clientId || selectedClientId,
          }}
          clientOptions={clients}
          onClose={() => { setShowEditModal(false); setEditingBranch(null); }}
          onSaved={() => {
            loadBranches(selectedClientId);
            if (selectedBranch?.id === editingBranch.id) loadBranchDetail(editingBranch);
          }}
        />
      )}

      {showContactModal && selectedBranch && (
        <AddBranchContactModal branchId={selectedBranch.id} onClose={() => setShowContactModal(false)} onAdded={() => { setShowContactModal(false); loadBranchDetail(selectedBranch); }} />
      )}
    </div>
  );
};

const BranchFormModal: React.FC<{
  title: string;
  initial: BranchFormData;
  branchId?: string;
  clientOptions: ClientOption[];
  onClose: () => void;
  onSaved: () => void;
}> = ({ title, initial, branchId, clientOptions, onClose, onSaved }) => {
  const [form, setForm] = useState<BranchFormData>(initial);
  const [submitting, setSubmitting] = useState(false);

  const set = (key: keyof BranchFormData) => (v: string) => setForm(f => ({ ...f, [key]: v }));

  const field = (label: string, key: keyof BranchFormData, opts?: { type?: string; required?: boolean; full?: boolean; options?: {value: string; label: string}[]; placeholder?: string }) => (
    <div key={key} style={opts?.full ? { gridColumn: '1 / -1' } : {}}>
      <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '3px', fontWeight: 500 }}>{label}{opts?.required && ' *'}</label>
      {opts?.options ? (
        <select value={form[key]} onChange={(e) => set(key)(e.target.value)} required={opts?.required}
          style={{ width: '100%', padding: '7px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }}>
          <option value="">Select...</option>
          {opts.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input type={opts?.type || 'text'} value={form[key]} onChange={(e) => set(key)(e.target.value)} required={opts?.required} placeholder={opts?.placeholder}
          style={{ width: '100%', padding: '7px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
      )}
    </div>
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true);
    try {
      const body: any = {
        branchCode: form.branchCode, name: form.name, address: form.address,
        state: form.state, district: form.district, city: form.city,
        clientId: form.clientId || undefined,
      };
      if (form.solId) body.solId = form.solId;
      if (form.pincode) body.pincode = form.pincode;
      if (form.region) body.region = form.region;
      if (form.territory) body.territory = form.territory;
      if (form.zoneId) body.zoneId = form.zoneId;
      if (form.branchType) body.branchType = form.branchType;
      if (form.phone) body.phone = form.phone;
      if (form.email) body.email = form.email;
      if (form.managerName) body.managerName = form.managerName;
      if (form.openingDate) body.openingDate = form.openingDate;
      if (form.lastAuditDate) body.lastAuditDate = form.lastAuditDate;
      if (form.latitude) body.latitude = parseFloat(form.latitude);
      if (form.longitude) body.longitude = parseFloat(form.longitude);
      if (form.riskScore) body.riskScore = parseFloat(form.riskScore);
      if (form.riskCategory) body.riskCategory = form.riskCategory;
      if (form.complexity) body.complexity = form.complexity;
      if (form.estimatedDurationHours) body.estimatedDurationHours = parseFloat(form.estimatedDurationHours);
      if (form.requiredCompetencies) body.requiredCompetencies = form.requiredCompetencies.split(',').map(s => s.trim());

      if (branchId) {
        await api.request(`/branches/${branchId}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await api.request('/branches', { method: 'POST', body: JSON.stringify(body) });
      }
      onSaved();
      onClose();
    } catch (err: any) {
      alert(err?.message || `Failed to ${branchId ? 'update' : 'create'} branch`);
    } finally { setSubmitting(false); }
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="glass-card" style={{ width: '640px', maxHeight: '90vh', overflowY: 'auto', padding: '24px' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h3 style={{ fontSize: '18px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Building2 size={18} /> {title}
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px' }}>&times;</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <span style={{ gridColumn: '1 / -1', fontSize: '12px', fontWeight: 600, color: 'var(--accent-primary)', marginTop: '4px' }}>IDENTIFICATION</span>
            {field('Branch Code *', 'branchCode', { required: true })}
            {field('SOL ID', 'solId', { placeholder: 'e.g. 12345' })}
            {field('Branch Name *', 'name', { required: true, full: true })}
            {field('Branch Type', 'branchType', { options: BRANCH_TYPES.map(t => ({ value: t, label: t })) })}
            {field('Client *', 'clientId', { options: clientOptions.map(c => ({ value: c.id, label: `${c.name} (${c.clientCode})` })), required: true })}
            {field('Manager Name', 'managerName', { placeholder: 'Branch manager name', full: true })}

            <span style={{ gridColumn: '1 / -1', fontSize: '12px', fontWeight: 600, color: 'var(--accent-primary)', marginTop: '4px' }}>LOCATION</span>
            {field('Address *', 'address', { required: true, full: true })}
            {field('City *', 'city', { required: true })}
            {field('District *', 'district', { required: true })}
            {field('State *', 'state', { required: true, options: INDIAN_STATES })}
            {field('Pincode', 'pincode', { placeholder: 'e.g. 400001' })}
            {field('Region', 'region')}
            {field('Territory', 'territory')}
            {field('Zone ID', 'zoneId')}

            <span style={{ gridColumn: '1 / -1', fontSize: '12px', fontWeight: 600, color: 'var(--accent-primary)', marginTop: '4px' }}>CONTACT</span>
            {field('Phone', 'phone', { placeholder: 'e.g. +91-22-12345678' })}
            {field('Email', 'email', { type: 'email' })}

            <span style={{ gridColumn: '1 / -1', fontSize: '12px', fontWeight: 600, color: 'var(--accent-primary)', marginTop: '4px' }}>AUDIT & RISK</span>
            {field('Risk Category', 'riskCategory', { options: RISK_CATEGORIES.map(r => ({ value: r, label: r })) })}
            {field('Risk Score', 'riskScore', { type: 'number', placeholder: '0.00 - 100.00' })}
            {field('Complexity', 'complexity', { options: COMPLEXITIES.map(c => ({ value: c, label: c })) })}
            {field('Est. Duration (hours)', 'estimatedDurationHours', { type: 'number' })}
            {field('Required Competencies', 'requiredCompetencies', { full: true, placeholder: 'Comma-separated, e.g. Gold Valuation, KYC Audit' })}
            {field('Opening Date', 'openingDate', { type: 'date' })}
            {field('Last Audit Date', 'lastAuditDate', { type: 'date' })}
          </div>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '20px', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
            <button type="button" onClick={onClose} className="btn btn-secondary" disabled={submitting}>Cancel</button>
            <button type="submit" disabled={submitting} className="btn btn-primary">{submitting ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
};

const InfoRow: React.FC<{ label: string; value: string; full?: boolean }> = ({ label, value, full }) => (
  <div style={full ? { gridColumn: '1 / -1' } : {}}>
    <span style={{ color: 'var(--text-muted)' }}>{label}</span>
    <div style={{ fontWeight: 600, marginTop: '1px' }}>{value}</div>
  </div>
);

const AddBranchContactModal: React.FC<{ branchId: string; onClose: () => void; onAdded: () => void }> = ({ branchId, onClose, onAdded }) => {
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [phone, setPhone] = useState('');
  const [designation, setDesignation] = useState(''); const [department, setDepartment] = useState(''); const [isPrimary, setIsPrimary] = useState(false); const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true);
    try {
      await api.request(`/branches/${branchId}/contacts`, {
        method: 'POST',
        body: JSON.stringify({ name, email, phone, designation, department: department || undefined, isPrimary, notes: notes || undefined }),
      });
      onAdded();
    } catch (err) { alert(err instanceof Error ? err.message : 'Failed to add contact'); }
    finally { setSubmitting(false); }
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="glass-card" style={{ width: '480px', padding: '24px' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h4 style={{ fontSize: '16px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}><User size={16} /> Add Branch Contact</h4>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px' }}>&times;</button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            {[
              { placeholder: 'Name *', val: name, set: setName, required: true },
              { placeholder: 'Email *', val: email, set: setEmail, type: 'email', required: true },
              { placeholder: 'Phone *', val: phone, set: setPhone, required: true },
              { placeholder: 'Designation *', val: designation, set: setDesignation, required: true },
              { placeholder: 'Department', val: department, set: setDepartment },
            ].map(f => (
              <input key={f.placeholder} placeholder={f.placeholder} type={f.type || 'text'} value={f.val} onChange={(e) => f.set(e.target.value)} required={f.required}
                style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
            ))}
            <div style={{ gridColumn: '1 / -1' }}>
              <textarea placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                style={{ width: '100%', padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px', resize: 'vertical' }} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} /> Primary contact
            </label>
          </div>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '8px', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
            <button type="button" onClick={onClose} className="btn btn-secondary" disabled={submitting}>Cancel</button>
            <button type="submit" disabled={submitting} className="btn btn-primary">{submitting ? 'Saving...' : 'Save Contact'}</button>
          </div>
        </form>
      </div>
    </div>
  );
};
