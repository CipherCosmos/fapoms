import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Upload, Building2, Globe, ShieldAlert, Activity, Plus, Edit2, Trash2, Phone, FileText, User, Filter, ChevronDown, Map, X } from 'lucide-react';
import { SearchInput, FilterSelect, StatusBadge, AlertBanner, Modal, useToast } from '../components/ui';
import { api } from '../services/api';
import { INDIAN_STATES } from '@fapoms/shared';
import { connectSocket } from '../services/socket';
import { useCurrentRoles, canManageBranches, canDeleteBranches } from '../hooks/useCurrentRoles';
import { userMessage } from '../services/errors';

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



export const Branches: React.FC = () => {
  const { toast } = useToast();
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
  // Audit and finance can open this page but hold no branch write permission —
  // showing them Add/Edit/Delete only produces a 403 when they click.
  const roles = useCurrentRoles();
  const canManage = canManageBranches(roles);
  // Deletion is admin-only on the backend; showing it more widely only produced a 403 on click.
  const canDelete = canDeleteBranches(roles);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);
  const [branchDetail, setBranchDetail] = useState<BranchDetail | null>(null);
  const [showContactModal, setShowContactModal] = useState(false);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const branchIdParam = searchParams.get('id');

  useEffect(() => {
    loadClients();
    const socket = connectSocket();
    const refresh = () => { loadClients(); if (selectedClientId) loadBranches(selectedClientId); };
    socket?.on('ProjectPlanningStarted', refresh);
    socket?.on('ProjectBranchAssignmentConfirmed', refresh);
    return () => {
      socket?.off('ProjectPlanningStarted', refresh);
      socket?.off('ProjectBranchAssignmentConfirmed', refresh);
    };
  }, []);
  useEffect(() => { if (selectedClientId) loadBranches(selectedClientId); }, [selectedClientId]);

  useEffect(() => {
    if (branchIdParam && branches.length > 0) {
      const found = branches.find(b => b.id === branchIdParam);
      if (found) loadBranchDetail(found);
    }
  }, [branchIdParam, branches]);

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
    } catch (err) { toast({ type: 'error', title: 'Could not delete branch', message: userMessage(err) }); }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedClientId) return;
    setIsUploading(true); setMessage(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const data = await api.request<{ importedCount: number; errors?: any[] }>(`/branches/import/${selectedClientId}`, {
        method: 'POST',
        body: formData
      });
      const { importedCount, errors } = data;
      let msg = `Successfully imported ${importedCount} branches.`;
      if (errors && errors.length > 0) msg += ` Excluded ${errors.length} rows due to validation errors.`;
      setMessage({ type: 'success', text: msg });
      loadBranches(selectedClientId);
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
          { label: 'High / Critical Risk', value: highRiskCount, icon: ShieldAlert, color: 'var(--danger)' },
          { label: 'Standard Complexity', value: standardCount, icon: Activity, color: 'var(--accent-secondary)' },
        ].map(card => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '16px' }}>
              <div style={{ width: '44px', height: '44px', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: card.color }}>
                <Icon size={22} />
              </div>
              <div>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500 }}>{card.label}</span>
                <h4 style={{ fontSize: '24px', fontWeight: 800, margin: '2px 0', color: 'var(--text-primary)' }}>{card.value}</h4>
              </div>
            </div>
          );
        })}
      </div>

      {message && <AlertBanner type={message.type} message={message.text} />}

      <div className="responsive-grid-split" style={{ alignItems: 'start' }}>
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
            <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search by name, code or SOL ID..." compact style={{ minWidth: '180px' }} />
            <button onClick={() => setShowFilters(!showFilters)} className="btn btn-secondary" style={{ padding: '6px 10px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Filter size={13} /> Filters <ChevronDown size={12} style={{ transform: showFilters ? 'rotate(180deg)' : '' }} />
            </button>
            {canManage && (
              <button onClick={() => setShowCreateModal(true)} className="btn btn-primary" style={{ padding: '6px 14px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Plus size={14} /> Add Branch
              </button>
            )}
          </div>

          {/* Advanced Filters */}
          {showFilters && (
            <div className="glass-card" style={{ padding: '12px 16px', display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
              <FilterSelect label={<span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>State:</span>} value={stateFilter} onChange={setStateFilter} options={[{ value: 'ALL', label: 'All' }, ...states.map(s => ({ value: s, label: s }))]} compact />
              <FilterSelect label={<span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>Region:</span>} value={regionFilter} onChange={setRegionFilter} options={[{ value: 'ALL', label: 'All' }, ...regions.map(r => ({ value: r, label: r }))]} compact />
              <FilterSelect label={<span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>Risk:</span>} value={riskFilter} onChange={setRiskFilter} options={[{ value: 'ALL', label: 'All' }, ...RISK_CATEGORIES.map(r => ({ value: r, label: r }))]} compact />
              {(() => {
                const activeCount = [stateFilter !== 'ALL', regionFilter !== 'ALL', riskFilter !== 'ALL'].filter(Boolean).length;
                if (activeCount === 0) return null;
                return (
                  <button type="button" onClick={() => { setStateFilter('ALL'); setRegionFilter('ALL'); setRiskFilter('ALL'); }}
                    title="Clear all filters"
                    style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', fontSize: '11px', fontWeight: 600, color: 'var(--accent)', background: 'var(--status-pending-bg)', border: '1px solid var(--border-hair)', borderRadius: '4px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    <X size={12} /> Clear {activeCount}
                  </button>
                );
              })()}
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
                      onClick={() => { loadBranchDetail(b); navigate(`/branches?id=${b.id}`, { replace: true }); }}
                      style={{ cursor: 'pointer', background: selectedBranch?.id === b.id ? 'rgba(216,174,71,0.08)' : undefined }}>
                      <td style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{b.branchCode}</td>
                      <td style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{b.solId || '-'}</td>
                      <td style={{ fontWeight: 600, fontSize: '14px' }}>{b.name}</td>
                      <td style={{ fontSize: '13px' }}>{b.city}, {b.state}</td>
                      <td style={{ fontSize: '13px' }}>{b.region || '-'}</td>
                      <td>
                        <StatusBadge label={b.riskCategory || '-'} bg={b.riskCategory === 'HIGH' || b.riskCategory === 'CRITICAL' ? 'var(--status-cancelled-bg)' : b.riskCategory === 'MEDIUM' ? 'var(--status-pending-bg)' : 'var(--status-active-bg)'} color={b.riskCategory === 'HIGH' || b.riskCategory === 'CRITICAL' ? 'var(--danger)' : b.riskCategory === 'MEDIUM' ? 'var(--warning)' : 'var(--status-active)'} />
                      </td>
                      <td style={{ fontSize: '12px' }}>{b.branchType || '-'}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          {canManage && <>
                            <button aria-label="Edit branch" onClick={() => { setEditingBranch(b); setShowEditModal(true); }} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '11px' }}><Edit2 size={11} /></button>
                            {canDelete && <button aria-label="Delete branch" onClick={() => handleDelete(b.id)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '11px', color: 'var(--danger)' }}><Trash2 size={11} /></button>}
                          </>}
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
                  {canManage && <>
                    <button onClick={() => { setEditingBranch(selectedBranch); setShowEditModal(true); }} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '11px' }}><Edit2 size={11} /></button>
                    <button onClick={() => setShowContactModal(true)} className="btn btn-primary" style={{ padding: '4px 10px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Plus size={11} /> Contact
                    </button>
                  </>}
                </div>
              </div>

              {/* Info Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px', padding: '12px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
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
                        <Map size={14} /> Verify on Google Maps
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
                  <div key={c.id} style={{ padding: '10px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', fontSize: '12px', marginBottom: '8px' }}>
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
                  <div key={d.id} style={{ padding: '10px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', fontSize: '12px', marginBottom: '8px' }}>
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
  const { toast } = useToast();
  const [form, setForm] = useState<BranchFormData>(initial);
  const [submitting, setSubmitting] = useState(false);

  const set = (key: keyof BranchFormData) => (v: string) => setForm(f => ({ ...f, [key]: v }));

  const field = (label: string, key: keyof BranchFormData, opts?: { type?: string; required?: boolean; full?: boolean; options?: {value: string; label: string}[]; placeholder?: string }) => (
    <div key={key} style={opts?.full ? { gridColumn: '1 / -1' } : {}}>
      <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '3px', fontWeight: 500 }}>{label}{opts?.required && ' *'}</label>
      {opts?.options ? (
        <select value={form[key]} onChange={(e) => set(key)(e.target.value)} required={opts?.required}
          style={{ width: '100%', padding: '7px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px' }}>
          <option value="">Select...</option>
          {opts.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input type={opts?.type || 'text'} value={form[key]} onChange={(e) => set(key)(e.target.value)} required={opts?.required} placeholder={opts?.placeholder}
          style={{ width: '100%', padding: '7px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px' }} />
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
      body.operatingHours = { default: "09:00 - 18:00" };

      if (branchId) {
        await api.request(`/branches/${branchId}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await api.request('/branches', { method: 'POST', body: JSON.stringify(body) });
      }
      onSaved();
      onClose();
    } catch (err: any) {
      toast({ type: 'error', title: `Could not ${branchId ? 'update' : 'create'} branch`, message: userMessage(err) });
    } finally { setSubmitting(false); }
  };

  return (
    <Modal open onClose={onClose} title={<><Building2 size={18} /> {title}</>} width="640px" maxHeight="90vh" asForm onSubmit={handleSubmit} bodyStyle={{ overflowY: 'auto' }} footer={
      <>
        <button type="button" onClick={onClose} className="btn btn-secondary" disabled={submitting}>Cancel</button>
        <button type="submit" disabled={submitting} className="btn btn-primary">{submitting ? 'Saving...' : 'Save'}</button>
      </>
    }>
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
    </Modal>
  );
};

const InfoRow: React.FC<{ label: string; value: string; full?: boolean }> = ({ label, value, full }) => (
  <div style={full ? { gridColumn: '1 / -1' } : {}}>
    <span style={{ color: 'var(--text-muted)' }}>{label}</span>
    <div style={{ fontWeight: 600, marginTop: '1px' }}>{value}</div>
  </div>
);

const AddBranchContactModal: React.FC<{ branchId: string; onClose: () => void; onAdded: () => void }> = ({ branchId, onClose, onAdded }) => {
  const { toast } = useToast();
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
    } catch (err) { toast({ type: 'error', title: 'Could not add contact', message: userMessage(err) }); }
    finally { setSubmitting(false); }
  };

  return (
    <Modal open onClose={onClose} title={<><User size={16} /> Add Branch Contact</>} width="480px" asForm onSubmit={handleSubmit} footer={
      <>
        <button type="button" onClick={onClose} className="btn btn-secondary" disabled={submitting}>Cancel</button>
        <button type="submit" disabled={submitting} className="btn btn-primary">{submitting ? 'Saving...' : 'Save Contact'}</button>
      </>
    }>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        {[
          { placeholder: 'Name *', val: name, set: setName, required: true },
          { placeholder: 'Email *', val: email, set: setEmail, type: 'email', required: true },
          { placeholder: 'Phone *', val: phone, set: setPhone, required: true },
          { placeholder: 'Designation *', val: designation, set: setDesignation, required: true },
          { placeholder: 'Department', val: department, set: setDepartment },
        ].map(f => (
          <input key={f.placeholder} placeholder={f.placeholder} type={f.type || 'text'} value={f.val} onChange={(e) => f.set(e.target.value)} required={f.required}
            style={{ padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px' }} />
        ))}
        <div style={{ gridColumn: '1 / -1' }}>
          <textarea placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            style={{ width: '100%', padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px', resize: 'vertical' }} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} /> Primary contact
        </label>
      </div>
    </Modal>
  );
};
