import React, { useState, useEffect, useRef } from 'react';
import { useUrlSelection } from '../hooks/useUrlSelection';
import { Upload, Building2, Globe, ShieldAlert, Activity, Plus, Edit2, Trash2, Phone, FileText, User, Filter, ChevronDown, Map, X } from 'lucide-react';
import { SearchInput, FilterSelect, StatusBadge, AlertBanner, Modal, Select, useToast } from '../components/ui';
import { Autocomplete } from '../components/ui/Autocomplete';
import type { IndiaPlaceResult } from '../components/ui/Autocomplete';
import { api } from '../services/api';
import { GeoPrecisionBadge, geoNeedsFixing } from '../components/GeoPrecisionBadge';
import { PinCoordinateControl } from '../components/PinCoordinateControl';
import { INDIAN_STATES, REGION_ORDER, REGION_LABELS, regionLabel, canonicalStateName, resolveRegion } from '@fapoms/shared';
import { useScope, withScope } from '../context/ScopeContext';
import { connectSocket } from '../services/socket';
import { useCurrentRoles, canManageBranches, canDeleteBranches } from '../hooks/useCurrentRoles';
import { userMessage } from '../services/errors';
import { getZones } from '../services/planning';

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
  /** How the coordinate above was obtained, and what it matched — see GeoPrecisionBadge. */
  geoSource: string | null;
  geoAccuracyMeters: number | null;
  geoMatchedName: string | null;
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

/**
 * `98765 43210`, `+91-9876543210` and `09876543210` are one phone number, and the database should
 * hold one spelling of it. Same rule the assayer form applies (`AssayerForms.handleSubmit`):
 * digits only, then a `+91` unless the number already carries the country code.
 */
const normalisePhone = (raw: string): string => {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('91') ? `+${digits}` : `+91${digits}`;
};

const RISK_CATEGORIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const COMPLEXITIES = ['STANDARD', 'COMPLEX', 'VERY_COMPLEX'];
const BRANCH_TYPES = ['MAIN', 'BRANCH', 'SUB_BRANCH', 'EXTENSION', 'MICRO'];

/**
 * Risk score and risk category are one idea, not two.
 *
 * They used to be two unlinked inputs — a free number "0.00 - 100.00" and a four-value picker —
 * so the office had to know both the banding and the number behind it, and nothing stopped a
 * branch being saved as CRITICAL with a score of 3. The band is the part a person can actually
 * judge; the number is derived from it. The exact score is still editable under Advanced for the
 * rare branch that carries a real scored assessment, and editing it re-bands the category so the
 * two can never disagree again.
 */
const RISK_BANDS: { category: string; min: number; max: number; score: number; hint: string }[] = [
  { category: 'LOW', min: 0, max: 25, score: 12.5, hint: 'Routine branch, no history of exceptions' },
  { category: 'MEDIUM', min: 25, max: 50, score: 37.5, hint: 'Ordinary exposure' },
  { category: 'HIGH', min: 50, max: 75, score: 62.5, hint: 'Large holdings or past exceptions' },
  { category: 'CRITICAL', min: 75, max: 100, score: 90, hint: 'Escalated — needs senior assayer' },
];

const scoreForCategory = (category: string): string => {
  const band = RISK_BANDS.find((b) => b.category === category);
  return band ? String(band.score) : '';
};

const categoryForScore = (score: string): string => {
  const n = parseFloat(score);
  if (!Number.isFinite(n)) return '';
  // Upper bound inclusive on the top band so 100 is CRITICAL rather than nothing.
  const band = RISK_BANDS.find((b) => n >= b.min && (n < b.max || b.max === 100));
  return band?.category ?? '';
};

/**
 * A day's work is what the complexity says it is, unless someone says otherwise.
 *
 * "Est. Duration (hours)" is a number the office has no way to know for a branch they have never
 * visited; the planner does. These are the same durations planning already assumes per
 * complexity, so leaving the field alone now produces the right answer instead of a typed guess.
 */
const DEFAULT_HOURS_BY_COMPLEXITY: Record<string, string> = {
  STANDARD: '8',
  COMPLEX: '12',
  VERY_COMPLEX: '16',
};

/**
 * Applies a real place picked from the geo lookup across the whole address block, so state,
 * district, city and pincode stay consistent with one another.
 *
 * Same mechanism the assayer form uses (`Autocomplete` → `/geo/autocomplete`), applied to the
 * branch form's field names. Typing a pincode therefore fills district, city and state — four
 * fields the system already knows the moment it knows one of them.
 */
const applyPlaceToBranch = (fieldKey: 'city' | 'district' | 'pincode', place: IndiaPlaceResult, form: BranchFormData): BranchFormData => {
  const primary = (place.label || '').split(',')[0].trim();
  const next = { ...form };
  if (place.state) {
    // Canonicalised, because State is rendered as a <select> that matches its options by exact
    // string — a raw "MAHARASHTRA" from the lookup would land on "Select…" and read as unset.
    next.state = canonicalStateName(place.state) ?? place.state;
  }
  if (place.district) next.district = place.district;
  if (fieldKey === 'city') next.city = primary;
  if (fieldKey === 'district') {
    next.district = place.district || primary;
    if (!next.city) next.city = primary;
  }
  if (fieldKey === 'pincode') {
    if (place.pincode) next.pincode = place.pincode;
    if (!next.city) next.city = primary;
  }
  return next;
};



export const Branches: React.FC = () => {
  const { toast } = useToast();
  // The header's global scope. `scopeKey` changes whenever any dimension does, and is what the
  // reload effect below watches.
  const { scopeParams, scopeKey } = useScope();
  const [branches, setBranches] = useState<Branch[]>([]);
  // The true server-side total, so the UI can tell the operator when the loaded list is truncated
  // rather than silently showing a partial list as if it were everything.
  const [branchesTotal, setBranchesTotal] = useState(0);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  // State and region used to be filtered here. They moved to the header's global scope so the
  // choice follows the operator across every page, and so the server can apply them to the
  // whole result set rather than to the one page this component happens to have loaded.
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
  // Writes the id while preserving the client filter, the search box and the header's scope —
  // `navigate('/branches?id=' + id)` used to replace the whole query string and drop them.
  const [branchIdParam, selectBranch] = useUrlSelection('id');

  // The socket handler below subscribes once (mount), so it must read the *current* selected client
  // through a ref — capturing selectedClientId in the closure would freeze it at its initial '' and a
  // live event would never refresh the branches of whatever client is actually selected.
  const selectedClientIdRef = useRef(selectedClientId);
  // The global scope needs the same treatment, and for a sharper reason: a socket refresh that
  // fired after the operator changed region would refetch with the mount-time scope and repaint
  // the table with another region's branches — a live event silently undoing the filter.
  const scopeParamsRef = useRef(scopeParams);
  scopeParamsRef.current = scopeParams;

  useEffect(() => {
    loadClients();
    const socket = connectSocket();
    const refresh = () => {
      loadClients();
      if (selectedClientIdRef.current) loadBranches(selectedClientIdRef.current);
    };
    socket?.on('ProjectPlanningStarted', refresh);
    socket?.on('ProjectBranchAssignmentConfirmed', refresh);
    return () => {
      socket?.off('ProjectPlanningStarted', refresh);
      socket?.off('ProjectBranchAssignmentConfirmed', refresh);
    };
  }, []);
  useEffect(() => {
    selectedClientIdRef.current = selectedClientId;
    if (selectedClientId || scopeParams.clientId) loadBranches(selectedClientId);
  }, [selectedClientId, scopeKey]);

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

  const BRANCH_PAGE_LIMIT = 1000;
  const loadBranches = async (clientId?: string) => {
    setIsLoading(true);
    try {
      // Region, zone and state come from the header's global scope and are applied by the
      // server. They cannot be applied here: the list is capped at BRANCH_PAGE_LIMIT rows, so
      // filtering what already arrived would show "12 of 4000" and quietly hide the remainder.
      // Read through the ref, never the render closure: this is called from the socket handler
      // too, which was bound once at mount.
      const currentScope = scopeParamsRef.current;
      const url = `/branches?${withScope(currentScope, {
        // The global client scope wins when set; otherwise the page's own picker decides.
        clientId: currentScope.clientId ?? clientId,
        limit: BRANCH_PAGE_LIMIT,
      })}`;
      // withMeta so we learn the true total and can warn when the list is capped, instead of
      // silently dropping branches past the limit (a bank client can exceed it).
      const response = await api.request<{ data: Branch[]; meta?: { pagination?: { total?: number } } }>(url, { withMeta: true });
      const rows = Array.isArray(response) ? (response as unknown as Branch[]) : (response?.data ?? []);
      setBranches(rows);
      setBranchesTotal(response?.meta?.pagination?.total ?? rows.length);
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
      if (errors && errors.length > 0) {
        // Show what actually failed, not just a count — the backend returns per-row reasons.
        const detail = errors
          .slice(0, 5)
          .map((er: any) => (typeof er === 'string' ? er : er?.reason || er?.message || JSON.stringify(er)))
          .join('; ');
        msg += ` Excluded ${errors.length} row(s): ${detail}${errors.length > 5 ? '…' : ''}`;
      }
      setMessage({ type: errors && errors.length > 0 ? 'error' : 'success', text: msg });
      loadBranches(selectedClientId);
    } catch (err) {
      // The real failure (e.g. a 400 with a validation message), not a blanket "network error".
      setMessage({ type: 'error', text: userMessage(err) });
    } finally { setIsUploading(false); e.target.value = ''; }
  };

  const filteredBranches = branches.filter(b => {
    const matchesSearch = !searchTerm || b.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      b.branchCode.toLowerCase().includes(searchTerm.toLowerCase()) || (b.solId && b.solId.includes(searchTerm));
    const matchesRisk = riskFilter === 'ALL' || b.riskCategory === riskFilter;
    return matchesSearch && matchesRisk;
  });

  const totalCount = branchesTotal || branches.length;
  const isTruncated = branchesTotal > branches.length;
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

      {isTruncated && (
        <AlertBanner type="error">
          Showing {branches.length.toLocaleString()} of {branchesTotal.toLocaleString()} branches — the list is capped.
          Use the search and filters to narrow down, or select a specific client, so no branches are hidden.
        </AlertBanner>
      )}

      <div className="responsive-grid-split" style={{ alignItems: 'start', gridTemplateColumns: 'minmax(0, 1fr) minmax(320px, 400px)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Toolbar */}
          <div className="glass-card" style={{ padding: '14px 16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <label style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Client</label>
              <Select value={selectedClientId} onChange={setSelectedClientId}
                options={clients.map(c => ({ value: c.id, label: `${c.name} (${c.clientCode})` }))}
                style={{ minWidth: '160px' }}
              />
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
              <FilterSelect label={<span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>Risk:</span>} value={riskFilter} onChange={setRiskFilter} options={[{ value: 'ALL', label: 'All' }, ...RISK_CATEGORIES.map(r => ({ value: r, label: r }))]} compact />
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Region, zone and state are set in the header's scope filter.
              </span>
              {(() => {
                const activeCount = [riskFilter !== 'ALL'].filter(Boolean).length;
                if (activeCount === 0) return null;
                return (
                  <button type="button" onClick={() => { setRiskFilter('ALL'); }}
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
                      onClick={() => { loadBranchDetail(b); selectBranch(b.id); }}
                      style={{ cursor: 'pointer', background: selectedBranch?.id === b.id ? 'rgba(216,174,71,0.08)' : undefined }}>
                      <td style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{b.branchCode}</td>
                      <td style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{b.solId || '-'}</td>
                      <td style={{ fontWeight: 600, fontSize: '14px' }}>{b.name}</td>
                      <td style={{ fontSize: '13px' }}>{b.city}, {b.state}</td>
                      <td style={{ fontSize: '13px' }}>{regionLabel(b.region)}</td>
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
                <InfoRow label="Region" value={regionLabel(branchDetail.region)} />
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
                  <div style={{ gridColumn: '1 / -1' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Coordinates</span>
                    <div style={{ fontWeight: 600, fontFamily: 'monospace', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span>{Number(branchDetail.latitude).toFixed(6)}, {Number(branchDetail.longitude).toFixed(6)}</span>
                      {/* The number of decimals implies a precision the value may not have; the
                          badge is what stops six decimal places reading as six decimal places
                          of confidence. */}
                      <GeoPrecisionBadge source={branchDetail.geoSource} matchedName={branchDetail.geoMatchedName} />
                      <a href={`https://www.openstreetmap.org/?mlat=${branchDetail.latitude}&mlon=${branchDetail.longitude}#map=17/${branchDetail.latitude}/${branchDetail.longitude}`}
                        target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: '11px', color: 'var(--accent-primary)', display: 'inline-flex', alignItems: 'center', gap: '2px', textDecoration: 'none' }}>
                        <Map size={14} /> Check on the map
                      </a>
                    </div>
                    {branchDetail.geoMatchedName && (
                      <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '3px' }}>
                        Matched: {branchDetail.geoMatchedName}
                      </div>
                    )}
                    {/* Shown only where it is actionable: a placeholder coordinate is the one
                        case where a person standing at the branch beats every geocoder, and
                        this is the moment they are looking at the record. */}
                    {geoNeedsFixing(branchDetail.geoSource) && canManage && (
                      <PinCoordinateControl
                        target="branch"
                        id={branchDetail.id}
                        onPinned={() => { loadBranchDetail(branchDetail); loadBranches(selectedClientId); }}
                      />
                    )}
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
            // Branch states arrive from client spreadsheets in capitals ("MAHARASHTRA"); the
            // canonical list is title case. A <select> matches its options by exact string, so
            // every imported branch opened with State showing "Select…" — and State is required,
            // which blocked the whole form until the user re-picked a state they had not changed.
            state: canonicalStateName(editingBranch.state) ?? editingBranch.state,
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
  // The zone was previously a free-text box labelled "Zone ID", which asked the operator to type a
  // raw UUID. Zone ids are not shown anywhere in the application, so there was no way to know one;
  // and anything that was not a UUID came back as a 500. Zones are few, so offer them by name.
  const [zoneOptions, setZoneOptions] = useState<{ value: string; label: string }[]>([]);

  useEffect(() => {
    getZones()
      .then((zs) => setZoneOptions(zs.map((z) => {
        // Zone names repeat across clients by design — every bank has a "West Zone" — so a flat
        // list of names alone offers the same label five times. Name the client alongside it.
        const owner = clientOptions.find((c) => c.id === z.clientId);
        return {
          value: z.id,
          label: z.clientId ? `${z.name} — ${owner?.name ?? 'client-specific'}` : `${z.name} — all clients`,
        };
      })))
      .catch(() => setZoneOptions([]));   // the rest of the form still works without it
  }, [clientOptions]);

  /**
   * A state that no spelling rule recognises — older imports carry names that are not states at
   * all — is kept as an option of its own. Dropping it would silently rewrite the branch's state
   * to whatever the user picked to get past a required field.
   */
  const stateOptions = React.useMemo(() => (
    !form.state || INDIAN_STATES.some((s) => s.value === form.state)
      ? INDIAN_STATES
      : [...INDIAN_STATES, { value: form.state, label: `${form.state} (as recorded)` }]
  ), [form.state]);

  /**
   * Everything the branch controller does not require is behind this. Only branchCode, name and
   * state are mandatory server-side (and branchCode is now allocated when left blank), so a
   * short everyday form costs nothing functionally — every field is still here, one click away,
   * and an edit that already carries advanced values opens with the section expanded so nothing
   * a branch holds is ever hidden from the person changing it.
   */
  const [showAdvanced, setShowAdvanced] = useState(() => Boolean(
    initial.solId || initial.territory || initial.zoneId || initial.region || initial.email ||
    initial.managerName || initial.requiredCompetencies || initial.openingDate || initial.lastAuditDate
  ));

  /**
   * The distinct skills and certifications already in use across the roster — the same list the
   * HR capability page picks from, so a branch can only require a competency somebody could
   * actually hold. This was comma-separated free text, where "KYC Audits" silently became a
   * fifth competency nobody has and the branch became unplannable against it.
   *
   * The endpoint is HR-scoped; when the current user cannot read it the field falls back to the
   * old free-text box rather than losing the ability to record a competency at all.
   */
  const [competencyOptions, setCompetencyOptions] = useState<string[] | null>(null);

  useEffect(() => {
    api.request<{ SKILL?: { name: string }[]; CERTIFICATION?: { name: string }[] }>('/assayers/workforce-attribute/vocabulary')
      .then((v) => {
        const names = [...(v?.SKILL ?? []), ...(v?.CERTIFICATION ?? [])].map((x) => x.name).filter(Boolean);
        setCompetencyOptions(Array.from(new Set(names)).sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => setCompetencyOptions([]));   // not permitted / unavailable → free text fallback
  }, []);

  const selectedCompetencies = React.useMemo(
    () => form.requiredCompetencies.split(',').map((c) => c.trim()).filter(Boolean),
    [form.requiredCompetencies],
  );

  const toggleCompetency = (name: string) => {
    const next = selectedCompetencies.includes(name)
      ? selectedCompetencies.filter((c) => c !== name)
      : [...selectedCompetencies, name];
    setForm((f) => ({ ...f, requiredCompetencies: next.join(', ') }));
  };

  const set = (key: keyof BranchFormData) => (v: string) => setForm(f => ({ ...f, [key]: v }));

  /** Picking a band writes the score with it; typing a score re-bands. One idea, one input. */
  const setRiskCategory = (v: string) => setForm(f => ({ ...f, riskCategory: v, riskScore: scoreForCategory(v) }));
  const setRiskScore = (v: string) => setForm(f => ({ ...f, riskScore: v, riskCategory: categoryForScore(v) || f.riskCategory }));
  /** Complexity carries its own typical duration, unless the user has already overridden it. */
  const setComplexity = (v: string) => setForm(f => ({
    ...f,
    complexity: v,
    estimatedDurationHours: Object.values(DEFAULT_HOURS_BY_COMPLEXITY).includes(f.estimatedDurationHours) || !f.estimatedDurationHours
      ? (DEFAULT_HOURS_BY_COMPLEXITY[v] ?? f.estimatedDurationHours)
      : f.estimatedDurationHours,
  }));

  const field = (label: string, key: keyof BranchFormData, opts?: { type?: string; required?: boolean; full?: boolean; options?: {value: string; label: string}[]; placeholder?: string; hint?: string; geo?: 'city' | 'district' | 'pincode'; onChange?: (v: string) => void }) => (
    <div key={key} style={opts?.full ? { gridColumn: '1 / -1' } : {}}>
      <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '3px', fontWeight: 500 }}>{label}{opts?.required && ' *'}</label>
      {opts?.options ? (
        <Select value={form[key]} onChange={opts.onChange ?? set(key)}
          placeholder={opts?.placeholder || 'Select...'}
          options={opts.options}
          style={{ width: '100%' }}
        />
      ) : opts?.geo ? (
        /* The lookup the assayer form already uses. Selecting a real place fills the rest of the
           address block, so the four location fields are answered by one of them. */
        <Autocomplete
          value={form[key]}
          onChange={set(key)}
          onSelect={(place) => setForm((f) => applyPlaceToBranch(opts.geo!, place, f))}
          placeholder={opts.placeholder || (opts.geo === 'pincode' ? 'Type a pincode — the rest fills in' : `Type to search ${label.toLowerCase()}…`)}
          filterType={(r) => (opts.geo === 'pincode' ? !!r.pincode : true)}
        />
      ) : (
        <input type={opts?.type || 'text'} value={form[key]} onChange={(e) => (opts?.onChange ?? set(key))(e.target.value)} required={opts?.required} placeholder={opts?.placeholder}
          style={{ width: '100%', padding: '7px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px' }} />
      )}
      {opts?.hint && <span style={{ display: 'block', fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '3px' }}>{opts.hint}</span>}
    </div>
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Client and State used to be <select required>, blocked from submitting empty by the
    // browser's own constraint validation — the custom dropdown doesn't participate in that,
    // so the check is re-asserted explicitly here.
    if (!form.clientId || !form.state) {
      toast({ type: 'error', title: 'Missing required field', message: `${!form.clientId ? 'Client' : 'State'} must be set.` });
      return;
    }
    setSubmitting(true);
    try {
      const body: any = {
        name: form.name, address: form.address,
        state: form.state, district: form.district, city: form.city,
        clientId: form.clientId || undefined,
      };
      // Omitted when blank so the server allocates the next free code. Sent verbatim when the
      // user typed one — a code that came off a client's own list must survive untouched.
      if (form.branchCode.trim()) body.branchCode = form.branchCode.trim();
      if (form.solId) body.solId = form.solId;
      if (form.pincode) body.pincode = form.pincode;
      if (form.region) body.region = form.region;
      if (form.territory) body.territory = form.territory;
      if (form.zoneId) body.zoneId = form.zoneId;
      if (form.branchType) body.branchType = form.branchType;
      // Normalised on the way out, like every other phone this product stores.
      if (form.phone) body.phone = normalisePhone(form.phone);
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
      if (form.requiredCompetencies) body.requiredCompetencies = form.requiredCompetencies.split(',').map(s => s.trim()).filter(Boolean);
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
        {field('Client', 'clientId', { options: clientOptions.map(c => ({ value: c.id, label: `${c.name} (${c.clientCode})` })), required: true })}
        {field('Branch Name', 'name', { required: true })}
        {/* Not required. The server allocates the next free BR-#### when this is blank — the same
            treatment the assayer form gives assayer codes. The office keeps no code register, so
            asking them to invent one only produced duplicates and typos. */}
        {field('Branch Code', 'branchCode', { placeholder: 'Left blank, one is assigned for you', full: true })}

        <span style={{ gridColumn: '1 / -1', fontSize: '12px', fontWeight: 600, color: 'var(--accent-primary)', marginTop: '4px' }}>LOCATION</span>
        {/* Pincode first, and deliberately so: it is the one thing on a branch letterhead that
            identifies the place, and picking a result fills district, city and state with it.
            State is the only mandatory one — it sets the region, zone and holiday calendar the
            branch is planned against. */}
        {field('Pincode', 'pincode', { geo: 'pincode', hint: 'Pick a result and district, city and state fill in for you' })}
        {field('City', 'city', { geo: 'city' })}
        {field('District', 'district', { geo: 'district' })}
        {field('State', 'state', { required: true, options: stateOptions })}
        {field('Address', 'address', { full: true })}

        <span style={{ gridColumn: '1 / -1', fontSize: '12px', fontWeight: 600, color: 'var(--accent-primary)', marginTop: '4px' }}>CONTACT & RISK</span>
        {field('Phone', 'phone', { placeholder: 'e.g. +91-22-12345678' })}
        {/* One input for one idea. The score is derived from the band and shown read-only here;
            it stays directly editable under Advanced for a branch with a real scored assessment. */}
        {field('Risk Category', 'riskCategory', {
          options: RISK_BANDS.map(b => ({ value: b.category, label: `${b.category} — ${b.hint}` })),
          onChange: setRiskCategory,
          hint: form.riskScore ? `Risk score ${Number(form.riskScore).toFixed(2)} — set from this band` : 'Sets the risk score for you',
        })}

        <button
          type="button"
          onClick={() => setShowAdvanced(v => !v)}
          style={{ gridColumn: '1 / -1', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-primary)', fontSize: '12px', fontWeight: 600 }}
        >
          <ChevronDown size={13} style={{ transform: showAdvanced ? 'rotate(180deg)' : '' }} />
          {showAdvanced ? 'Hide advanced details' : 'Advanced details (SOL ID, zone, competencies, dates)'}
        </button>

        {showAdvanced && <>
          <span style={{ gridColumn: '1 / -1', fontSize: '12px', fontWeight: 600, color: 'var(--accent-primary)', marginTop: '4px' }}>IDENTIFICATION</span>
          {field('SOL ID', 'solId', { placeholder: 'e.g. 12345' })}
          {field('Branch Type', 'branchType', { options: BRANCH_TYPES.map(t => ({ value: t, label: t })) })}
          {field('Manager Name', 'managerName', { placeholder: 'Branch manager name', full: true })}
          {field('Email', 'email', { type: 'email', full: true })}

          <span style={{ gridColumn: '1 / -1', fontSize: '12px', fontWeight: 600, color: 'var(--accent-primary)', marginTop: '4px' }}>PLANNING GEOGRAPHY</span>
          {/* Region is derived from state on the server (`resolveRegion`) and always has been —
              the picker used to sit in the everyday form under the label "Derived from state",
              which is a field asking to be left alone. It stays here, and only here, for the
              rare branch whose planning region genuinely differs from its postal state. */}
          {field('Region', 'region', {
            options: REGION_ORDER.map(r => ({ value: r, label: REGION_LABELS[r] })),
            placeholder: `Derived from state${form.state ? ` — ${regionLabel(resolveRegion(form.state))}` : ''}`,
            hint: 'Leave blank unless this branch is planned against a different region than its state.',
          })}
          {field('Territory', 'territory')}
          {field('Zone', 'zoneId', { options: zoneOptions, full: true })}

          <span style={{ gridColumn: '1 / -1', fontSize: '12px', fontWeight: 600, color: 'var(--accent-primary)', marginTop: '4px' }}>AUDIT & RISK</span>
          {field('Complexity', 'complexity', { options: COMPLEXITIES.map(c => ({ value: c, label: c })), onChange: setComplexity })}
          {field('Est. Duration (hours)', 'estimatedDurationHours', {
            type: 'number',
            hint: `Defaults to ${DEFAULT_HOURS_BY_COMPLEXITY[form.complexity] ?? '8'}h for ${form.complexity || 'STANDARD'}`,
          })}
          {field('Risk Score', 'riskScore', {
            type: 'number', onChange: setRiskScore, placeholder: '0.00 - 100.00', full: true,
            hint: 'Override only if you hold a scored assessment — the category re-bands to match.',
          })}

          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '3px', fontWeight: 500 }}>Required Competencies</label>
            {competencyOptions === null ? (
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Loading competencies…</span>
            ) : competencyOptions.length > 0 ? (
              /* Picked, never typed: a typo here used to invent a competency no assayer holds,
                 which silently made the branch unmatchable during planning. */
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {Array.from(new Set([...competencyOptions, ...selectedCompetencies])).map((name) => {
                  const on = selectedCompetencies.includes(name);
                  return (
                    <button key={name} type="button" onClick={() => toggleCompetency(name)} aria-pressed={on}
                      style={{ padding: '4px 10px', fontSize: '11.5px', borderRadius: '999px', cursor: 'pointer',
                        border: `1px solid ${on ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                        background: on ? 'rgba(216,174,71,0.12)' : 'var(--bg-primary)',
                        color: on ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>
                      {name}
                    </button>
                  );
                })}
              </div>
            ) : (
              /* The vocabulary is unavailable to this user — free text rather than no field. */
              field('', 'requiredCompetencies', { full: true, placeholder: 'Comma-separated, e.g. Gold Valuation, KYC Audit' })
            )}
          </div>

          {field('Opening Date', 'openingDate', { type: 'date' })}
          {field('Last Audit Date', 'lastAuditDate', { type: 'date' })}
        </>}
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
        // Normalised the same way the assayer form does it, so one person's number is one string
        // in the database rather than five spellings of it — dialling, de-duplication and the
        // SMS/WhatsApp channels all key off this.
        body: JSON.stringify({ name, email, phone: normalisePhone(phone), designation: designation || undefined, department: department || undefined, isPrimary, notes: notes || undefined }),
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
        {/* Real <label> elements, not placeholders standing in for them. A placeholder disappears
            the moment the user types, so the form the user is checking before saving had no
            labels at all on it — and screen readers had nothing to announce. */}
        {[
          { label: 'Name', val: name, set: setName, required: true, placeholder: 'e.g. Anita Rao' },
          { label: 'Email', val: email, set: setEmail, type: 'email', required: true, placeholder: 'name@example.com' },
          { label: 'Phone', val: phone, set: (v: string) => setPhone(v.replace(/\D/g, '')), required: true, tel: true, placeholder: '9876543210' },
          // Not required: a contact you only have a number for is still worth recording, and
          // the branch contact API no longer insists on one either.
          { label: 'Designation', val: designation, set: setDesignation, placeholder: 'e.g. Branch Manager' },
          { label: 'Department', val: department, set: setDepartment, placeholder: 'e.g. Operations' },
        ].map(f => (
          <div key={f.label}>
            <label htmlFor={`branch-contact-${f.label}`} style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '3px', fontWeight: 500 }}>
              {f.label}{f.required && <span style={{ color: 'var(--danger)', marginLeft: '2px' }}>*</span>}
            </label>
            <div style={{ position: 'relative' }}>
              {f.tel && <span aria-hidden style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '12px', pointerEvents: 'none' }}>+91</span>}
              <input id={`branch-contact-${f.label}`} placeholder={f.placeholder} type={f.tel ? 'tel' : f.type || 'text'} inputMode={f.tel ? 'numeric' : undefined}
                value={f.val} onChange={(e) => f.set(e.target.value)} required={f.required}
                style={{ width: '100%', boxSizing: 'border-box', padding: '8px', paddingLeft: f.tel ? '38px' : '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px' }} />
            </div>
          </div>
        ))}
        <div style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="branch-contact-notes" style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '3px', fontWeight: 500 }}>Notes</label>
          <textarea id="branch-contact-notes" placeholder="Anything worth remembering about this contact" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            style={{ width: '100%', padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px', resize: 'vertical' }} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} /> Primary contact
        </label>
      </div>
    </Modal>
  );
};
