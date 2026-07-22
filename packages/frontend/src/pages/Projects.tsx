import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Filter, Plus, FileSpreadsheet, Eye, X, CheckCircle, AlertCircle, Edit2, Trash2, Building2, FolderKanban, ClipboardList, ChevronRight, Clock, TrendingUp, ExternalLink } from 'lucide-react';
import { ProjectStatus, Priority } from '@fapoms/shared';
import { api } from '../services/api';

interface ClientOption {
  id: string;
  name: string;
  clientCode: string;
}

interface ProjectItem {
  id: string;
  projectNumber: string;
  name: string;
  clientId: string;
  status: ProjectStatus;
  priority: Priority;
  startDate: string | null;
  endDate: string | null;
  budget: number | null;
  scope: string | null;
  requiredSkills: string[] | null;
  requiredCertifications: string[] | null;
  description: string | null;
  createdAt: string;
  client?: { id: string; name: string; clientCode: string };
}

interface ProjectDetail extends ProjectItem {
  sla: Record<string, any> | null;
  risks: Record<string, any> | null;
  milestones: Record<string, any> | null;
  dependencies: Record<string, any> | null;
  organizationId: string | null;
  updatedAt: string;
  client?: { id: string; name: string; clientCode: string; email?: string; phone?: string };
}

interface FormData {
  name: string;
  projectNumber: string;
  clientId: string;
  priority: Priority;
  startDate: string;
  endDate: string;
  budget: number | '';
  scope: string;
  requiredSkills: string;
  requiredCertifications: string;
  description: string;
}

const TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  [ProjectStatus.DRAFT]: [ProjectStatus.PLANNING],
  [ProjectStatus.PLANNING]: [ProjectStatus.SCHEDULING, ProjectStatus.CANCELLED],
  [ProjectStatus.SCHEDULING]: [ProjectStatus.EXECUTION, ProjectStatus.ON_HOLD],
  [ProjectStatus.EXECUTION]: [ProjectStatus.VALIDATION, ProjectStatus.ON_HOLD],
  [ProjectStatus.VALIDATION]: [ProjectStatus.COMPLETED],
  [ProjectStatus.COMPLETED]: [ProjectStatus.ARCHIVED],
  [ProjectStatus.ON_HOLD]: [ProjectStatus.SCHEDULING, ProjectStatus.EXECUTION],
  [ProjectStatus.ARCHIVED]: [],
  [ProjectStatus.CANCELLED]: [],
};

const CAN_TRANSITION: Record<ProjectStatus, boolean> = {
  [ProjectStatus.DRAFT]: true,
  [ProjectStatus.PLANNING]: true,
  [ProjectStatus.SCHEDULING]: true,
  [ProjectStatus.EXECUTION]: true,
  [ProjectStatus.VALIDATION]: true,
  [ProjectStatus.COMPLETED]: true,
  [ProjectStatus.ARCHIVED]: false,
  [ProjectStatus.ON_HOLD]: true,
  [ProjectStatus.CANCELLED]: false,
};

const LIFECYCLE_INDEX: Record<ProjectStatus, number> = {
  [ProjectStatus.DRAFT]: 0,
  [ProjectStatus.PLANNING]: 1,
  [ProjectStatus.SCHEDULING]: 2,
  [ProjectStatus.EXECUTION]: 3,
  [ProjectStatus.VALIDATION]: 4,
  [ProjectStatus.COMPLETED]: 5,
  [ProjectStatus.ARCHIVED]: 6,
  [ProjectStatus.ON_HOLD]: 2,
  [ProjectStatus.CANCELLED]: -1,
};

const LIFECYCLE_STEPS = ['Draft', 'Planning', 'Scheduling', 'Execution', 'Validation', 'Completed', 'Archived'];

const emptyForm: FormData = {
  name: '',
  projectNumber: '',
  clientId: '',
  priority: Priority.MEDIUM,
  startDate: '2026-07-01',
  endDate: '2026-07-31',
  budget: '',
  scope: '',
  requiredSkills: '',
  requiredCertifications: '',
  description: '',
};

const statusBadge = (status: ProjectStatus) => {
  const map: Record<string, { bg: string; color: string }> = {
    [ProjectStatus.DRAFT]: { bg: 'var(--status-draft-bg)', color: 'var(--status-draft)' },
    [ProjectStatus.PLANNING]: { bg: 'rgba(99,102,241,0.1)', color: 'var(--accent-primary)' },
    [ProjectStatus.SCHEDULING]: { bg: 'var(--status-pending-bg)', color: 'var(--status-pending)' },
    [ProjectStatus.EXECUTION]: { bg: 'var(--status-active-bg)', color: 'var(--status-active)' },
    [ProjectStatus.VALIDATION]: { bg: 'rgba(139,92,246,0.1)', color: '#8b5cf6' },
    [ProjectStatus.COMPLETED]: { bg: 'rgba(16,185,129,0.1)', color: 'var(--accent-secondary)' },
    [ProjectStatus.ARCHIVED]: { bg: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' },
    [ProjectStatus.ON_HOLD]: { bg: 'rgba(245,158,11,0.1)', color: '#f59e0b' },
    [ProjectStatus.CANCELLED]: { bg: 'rgba(239,68,68,0.1)', color: '#ef4444' },
  };
  const s = map[status] || { bg: 'var(--status-pending-bg)', color: 'var(--status-pending)' };
  return { background: s.bg, color: s.color };
};

export const Projects: React.FC = () => {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [form, setForm] = useState<FormData>({ ...emptyForm });
  const [isSaving, setIsSaving] = useState(false);

  const [projectBranches, setProjectBranches] = useState<any[]>([]);

  useEffect(() => {
    loadProjects();
    loadClients();
  }, []);

  useEffect(() => {
    if (selectedId) {
      loadDetail(selectedId);
    } else {
      setDetail(null);
      setProjectBranches([]);
    }
  }, [selectedId]);

  const loadProjects = async () => {
    setIsLoading(true);
    try {
      const response = await api.request<ProjectItem[]>('/projects', { method: 'GET' });
      setProjects(response);
    } catch (err) {
      console.error('Failed to load projects');
    } finally {
      setIsLoading(false);
    }
  };

  const loadClients = async () => {
    try {
      const response = await api.request<ClientOption[]>('/clients', { method: 'GET' });
      setClients(response);
    } catch (err) {
      console.error('Failed to load clients options');
    }
  };

  const loadDetail = async (id: string) => {
    setIsLoadingDetail(true);
    try {
      const response = await api.request<ProjectDetail>(`/projects/${id}`, { method: 'GET' });
      setDetail(response);
      const branchesResponse = await api.request<any>(`/projects/${id}/branches`, { method: 'GET' });
      setProjectBranches(branchesResponse || []);
    } catch (err) {
      console.error('Failed to load project detail');
      setDetail(null);
      setProjectBranches([]);
    } finally {
      setIsLoadingDetail(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (!form.name || !form.projectNumber || !form.clientId) {
      setMessage({ type: 'error', text: 'Please fill in all mandatory fields.' });
      return;
    }
    setIsSaving(true);
    try {
      const response = await api.request<ProjectItem>('/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          projectNumber: form.projectNumber,
          clientId: form.clientId,
          priority: form.priority,
          startDate: form.startDate || undefined,
          endDate: form.endDate || undefined,
          budget: form.budget ? Number(form.budget) : undefined,
          scope: form.scope || undefined,
          requiredSkills: form.requiredSkills ? form.requiredSkills.split(',').map(s => s.trim()) : undefined,
          requiredCertifications: form.requiredCertifications ? form.requiredCertifications.split(',').map(s => s.trim()) : undefined,
          description: form.description || undefined,
        })
      });
      setMessage({ type: 'success', text: `Project "${response.name}" successfully created!` });
      setShowCreateModal(false);
      setForm({ ...emptyForm });
      loadProjects();
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Failed to create project.' });
    } finally {
      setIsSaving(false);
    }
  };

  const openEdit = () => {
    if (!detail) return;
    setForm({
      name: detail.name,
      projectNumber: detail.projectNumber,
      clientId: detail.clientId,
      priority: detail.priority,
      startDate: detail.startDate ? detail.startDate.substring(0, 10) : '',
      endDate: detail.endDate ? detail.endDate.substring(0, 10) : '',
      budget: detail.budget ?? '',
      scope: detail.scope || '',
      requiredSkills: detail.requiredSkills?.join(', ') || '',
      requiredCertifications: detail.requiredCertifications?.join(', ') || '',
      description: detail.description || '',
    });
    setShowEditModal(true);
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    setMessage(null);
    setIsSaving(true);
    try {
      const response = await api.request<ProjectItem>(`/projects/${detail.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name,
          projectNumber: form.projectNumber,
          clientId: form.clientId,
          priority: form.priority,
          startDate: form.startDate || undefined,
          endDate: form.endDate || undefined,
          budget: form.budget ? Number(form.budget) : undefined,
          scope: form.scope || undefined,
          requiredSkills: form.requiredSkills ? form.requiredSkills.split(',').map(s => s.trim()) : undefined,
          requiredCertifications: form.requiredCertifications ? form.requiredCertifications.split(',').map(s => s.trim()) : undefined,
          description: form.description || undefined,
        })
      });
      setMessage({ type: 'success', text: `Project "${response.name}" successfully updated!` });
      setShowEditModal(false);
      loadProjects();
      if (selectedId) loadDetail(selectedId);
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Failed to update project.' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!detail) return;
    setMessage(null);
    try {
      await api.request(`/projects/${detail.id}`, { method: 'DELETE' });
      setMessage({ type: 'success', text: `Project "${detail.name}" deleted.` });
      setShowDeleteConfirm(false);
      setSelectedId(null);
      loadProjects();
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Failed to delete project.' });
    }
  };

  const handleTransition = async (targetStatus: ProjectStatus) => {
    if (!detail) return;
    setMessage(null);
    try {
      await api.request(`/projects/${detail.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: detail.name,
          projectNumber: detail.projectNumber,
          clientId: detail.clientId,
          priority: detail.priority,
          status: targetStatus,
          startDate: detail.startDate?.substring(0, 10) || undefined,
          endDate: detail.endDate?.substring(0, 10) || undefined,
          budget: detail.budget ?? undefined,
          scope: detail.scope || undefined,
          requiredSkills: detail.requiredSkills || undefined,
          requiredCertifications: detail.requiredCertifications || undefined,
        })
      });
      setMessage({ type: 'success', text: `Project moved to ${targetStatus}` });
      loadProjects();
      if (selectedId) loadDetail(selectedId);
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Transition failed.' });
    }
  };

  const filteredProjects = projects.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          p.projectNumber.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'ALL' || p.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getClientName = (clientId: string) => {
    const match = clients.find(c => c.id === clientId);
    return match ? match.name : '—';
  };

  const totalCount = projects.length;
  const planningCount = projects.filter(p => p.status === ProjectStatus.DRAFT || p.status === ProjectStatus.PLANNING).length;
  const activeCount = projects.filter(p => p.status === ProjectStatus.SCHEDULING || p.status === ProjectStatus.EXECUTION).length;
  const completedCount = projects.filter(p => p.status === ProjectStatus.COMPLETED || p.status === ProjectStatus.ARCHIVED).length;

  const renderForm = (onSubmit: (e: React.FormEvent) => void, onClose: () => void, title: string) => (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      background: 'rgba(0,0,0,0.7)',
      backdropFilter: 'blur(4px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 100
    }}>
      <form onSubmit={onSubmit} className="glass-card" style={{ width: '560px', display: 'flex', flexDirection: 'column', gap: '20px', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h4 style={{ fontSize: '18px', fontWeight: 600 }}>{title}</h4>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Project Name *</label>
            <input type="text" value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. SBI Quarter 3 Audit" required style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Project Number *</label>
            <input type="text" value={form.projectNumber} onChange={(e) => setForm(f => ({ ...f, projectNumber: e.target.value }))} placeholder="e.g. PRJ-2026-002" required style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Client *</label>
            <select value={form.clientId} onChange={(e) => setForm(f => ({ ...f, clientId: e.target.value }))} required style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}>
              <option value="">Select client...</option>
              {clients.map(c => (<option key={c.id} value={c.id}>{c.name} ({c.clientCode})</option>))}
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Priority *</label>
            <select value={form.priority} onChange={(e) => setForm(f => ({ ...f, priority: e.target.value as Priority }))} required style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}>
              {Object.values(Priority).map(p => (<option key={p} value={p}>{p}</option>))}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Start Date</label>
              <input type="date" value={form.startDate} onChange={(e) => setForm(f => ({ ...f, startDate: e.target.value }))} style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>End Date</label>
              <input type="date" value={form.endDate} onChange={(e) => setForm(f => ({ ...f, endDate: e.target.value }))} style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Budget (INR)</label>
            <input type="number" value={form.budget} onChange={(e) => setForm(f => ({ ...f, budget: e.target.value === '' ? '' : Number(e.target.value) }))} placeholder="e.g. 150000" style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Description</label>
            <textarea value={form.description} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Project description..." style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', minHeight: '60px', resize: 'vertical' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Scope</label>
            <textarea value={form.scope} onChange={(e) => setForm(f => ({ ...f, scope: e.target.value }))} placeholder="Scope details and objectives..." style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', minHeight: '60px', resize: 'vertical' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Required Skills (comma-separated)</label>
            <input type="text" value={form.requiredSkills} onChange={(e) => setForm(f => ({ ...f, requiredSkills: e.target.value }))} placeholder="e.g. Gold Valuer, Auditing" style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Required Certifications (comma-separated)</label>
            <input type="text" value={form.requiredCertifications} onChange={(e) => setForm(f => ({ ...f, requiredCertifications: e.target.value }))} placeholder="e.g. Gold Valuer License" style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
          <button type="button" onClick={onClose} className="btn btn-secondary" disabled={isSaving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={isSaving}>{isSaving ? 'Saving...' : 'Save'}</button>
        </div>
      </form>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

      {/* Page Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)' }}>Projects</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>Manage all client audit cycles and monitor progress</p>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <FileSpreadsheet size={15} /> Export
          </button>
          <button onClick={() => { setMessage(null); setForm({ ...emptyForm, clientId: clients[0]?.id || '' }); setShowCreateModal(true); }}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--gradient-neon)', border: 'none', color: '#fff', padding: '10px 18px', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer', boxShadow: 'var(--shadow-neon)' }}>
            <Plus size={16} /> Create Project
          </button>
        </div>
      </div>

      {/* Notifications */}
      {message && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', borderRadius: 'var(--radius-md)', fontSize: '13px', border: '1px solid', background: message.type === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', borderColor: message.type === 'success' ? 'var(--accent-secondary)' : 'rgba(239,68,68,0.4)', color: message.type === 'success' ? 'var(--accent-secondary)' : '#f87171' }}>
          {message.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
          <span>{message.text}</span>
        </div>
      )}

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' }}>
        {[
          { label: 'Total Projects', value: totalCount, icon: FolderKanban, color: 'var(--accent-primary)' },
          { label: 'Planning / Draft', value: planningCount, icon: ClipboardList, color: 'var(--accent-secondary)' },
          { label: 'Active', value: activeCount, icon: TrendingUp, color: 'var(--status-active)' },
          { label: 'Completed / Archived', value: completedCount, icon: CheckCircle, color: 'var(--priority-low)' },
        ].map(card => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
              <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: card.color }}>
                <Icon size={20} />
              </div>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>{card.label}</div>
                <div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{card.value}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Filter Row */}
      <div className="glass-card" style={{ padding: '14px 18px', display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
          <Search size={15} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input type="text" placeholder="Search by project name or code..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
            style={{ width: '100%', padding: '9px 12px 9px 34px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Filter size={15} style={{ color: 'var(--text-muted)' }} />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            style={{ padding: '9px 14px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px' }}>
            <option value="ALL">All Statuses</option>
            {Object.values(ProjectStatus).map(status => (<option key={status} value={status}>{status}</option>))}
          </select>
        </div>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{filteredProjects.length} of {projects.length} results</span>
      </div>

      {/* Main Grid: Table + Detail Panel */}
      <div style={{ display: 'grid', gridTemplateColumns: selectedId ? '1fr 420px' : '1fr', gap: '24px', alignItems: 'start', transition: 'grid-template-columns 0.2s' }}>

        {/* Projects Table */}
        <div className="table-container" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ minWidth: '780px' }}>
              <thead>
                <tr>
                  <th style={{ width: '28px' }}></th>
                  <th>Project</th>
                  <th>Client</th>
                  <th>Priority</th>
                  <th>Timeline</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'center', width: '100px' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>Loading projects...</td></tr>
                ) : filteredProjects.length === 0 ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
                    <FolderKanban size={36} style={{ margin: '0 auto 10px', opacity: 0.3 }} />
                    <p style={{ fontSize: '14px' }}>{searchTerm || statusFilter !== 'ALL' ? 'No projects match your filters.' : 'No projects yet. Create your first one.'}</p>
                  </td></tr>
                ) : (
                  filteredProjects.map((p) => (
                    <tr key={p.id} onClick={() => setSelectedId(selectedId === p.id ? null : p.id)}
                      style={{ cursor: 'pointer', background: selectedId === p.id ? 'rgba(99, 102, 241, 0.08)' : 'transparent', borderLeft: selectedId === p.id ? '3px solid var(--accent-primary)' : '3px solid transparent', transition: 'background 0.15s' }}>
                      <td style={{ textAlign: 'center', padding: '10px 6px' }}>
                        <ChevronRight size={14} style={{ color: selectedId === p.id ? 'var(--accent-primary)' : 'var(--text-muted)', opacity: selectedId === p.id ? 1 : 0.3 }} />
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: '14px' }}>{p.name}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '1px' }}>{p.projectNumber}</div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Building2 size={13} style={{ color: 'var(--text-muted)' }} />
                          <span style={{ fontSize: '13px' }}>{p.client?.name || getClientName(p.clientId)}</span>
                        </div>
                      </td>
                      <td>
                        <span style={{
                          color: p.priority === Priority.CRITICAL ? 'var(--priority-critical)' : p.priority === Priority.HIGH ? 'var(--priority-high)' : p.priority === Priority.MEDIUM ? 'var(--priority-medium)' : 'var(--priority-low)',
                          fontWeight: 600, fontSize: '13px'
                        }}>
                          {p.priority}
                        </span>
                      </td>
                      <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {p.startDate ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <Clock size={12} style={{ opacity: 0.5 }} />
                            {new Date(p.startDate).toLocaleDateString()} – {p.endDate ? new Date(p.endDate).toLocaleDateString() : 'Ongoing'}
                          </div>
                        ) : (
                          <span style={{ opacity: 0.5, fontStyle: 'italic' }}>Not scheduled</span>
                        )}
                      </td>
                      <td>
                        <span className="badge" style={{
                          ...statusBadge(p.status),
                          fontSize: '11px',
                          fontWeight: 600,
                          padding: '3px 10px',
                          borderRadius: 'var(--radius-sm)',
                          display: 'inline-block',
                        }}>
                          {p.status}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => setSelectedId(selectedId === p.id ? null : p.id)}
                          className="btn btn-secondary"
                          style={{ padding: '5px 10px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <Eye size={13} /> {selectedId === p.id ? 'Close' : 'Detail'}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Detail Panel */}
        {selectedId && (
          <div className="glass-card" style={{ padding: '0', overflow: 'hidden', minHeight: '400px', display: 'flex', flexDirection: 'column' }}>
            {isLoadingDetail ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '60px 20px' }}>
                <div style={{ fontSize: '13px' }}>Loading project details...</div>
              </div>
            ) : detail ? (
              <>
                {/* Detail Header */}
                <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border-color)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>Project Details</span>
                      <h3 style={{ fontSize: '18px', fontWeight: 700, margin: '4px 0 2px' }}>{detail.name}</h3>
                      <code style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{detail.projectNumber}</code>
                    </div>
                    <span className="badge" style={{ ...statusBadge(detail.status), fontSize: '10px', fontWeight: 600, padding: '3px 10px', borderRadius: 'var(--radius-sm)' }}>
                      {detail.status}
                    </span>
                  </div>
                </div>

                {/* Lifecycle Progress */}
                {detail.status !== ProjectStatus.CANCELLED && (
                  <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', display: 'block', marginBottom: '10px' }}>Lifecycle</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                      {LIFECYCLE_STEPS.map((step, i) => {
                        const currentIdx = LIFECYCLE_INDEX[detail.status];
                        const stepIdx = i;
                        const isActive = stepIdx === currentIdx;
                        const isPast = currentIdx >= 0 && stepIdx <= currentIdx;
                        return (
                          <div key={step} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                            <div style={{
                              width: '100%', height: '4px', borderRadius: '2px',
                              background: isActive ? 'var(--accent-primary)' : isPast ? 'var(--accent-secondary)' : 'var(--border-color)',
                              transition: 'background 0.3s',
                            }} />
                            <span style={{
                              fontSize: '8px', fontWeight: isActive ? 700 : 400,
                              color: isActive ? 'var(--accent-primary)' : isPast ? 'var(--text-secondary)' : 'var(--text-muted)',
                              whiteSpace: 'nowrap',
                            }}>
                              {step}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Key Info */}
                <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '12px' }}>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Client</span>
                    <div style={{ fontWeight: 600, marginTop: '1px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Building2 size={12} style={{ color: 'var(--text-muted)' }} />
                      {detail.client?.name || getClientName(detail.clientId)}
                    </div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Priority</span>
                    <div style={{ fontWeight: 600, marginTop: '1px', color: detail.priority === Priority.CRITICAL ? 'var(--priority-critical)' : detail.priority === Priority.HIGH ? 'var(--priority-high)' : 'var(--priority-medium)' }}>
                      {detail.priority}
                    </div>
                  </div>
                  {detail.startDate && (
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Timeline</span>
                      <div style={{ fontWeight: 600, marginTop: '1px' }}>
                        {new Date(detail.startDate).toLocaleDateString()} – {detail.endDate ? new Date(detail.endDate).toLocaleDateString() : 'Ongoing'}
                      </div>
                    </div>
                  )}
                  {detail.budget != null && (
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Budget</span>
                      <div style={{ fontWeight: 600, marginTop: '1px' }}>₹{Number(detail.budget).toLocaleString()}</div>
                    </div>
                  )}
                </div>

                {/* Scope / Description */}
                {(detail.scope || detail.description) && (
                  <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', display: 'block', marginBottom: '6px' }}>Scope & Description</span>
                    {detail.scope && <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{detail.scope}</p>}
                    {detail.description && <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '6px 0 0', lineHeight: 1.5, fontStyle: 'italic' }}>{detail.description}</p>}
                  </div>
                )}

                {/* Required Qualifications */}
                {(() => {
                  const skills = detail.requiredSkills ?? [];
                  const certs = detail.requiredCertifications ?? [];
                  if (skills.length === 0 && certs.length === 0) return null;
                  return (
                    <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', display: 'block', marginBottom: '8px' }}>Required Qualifications</span>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {skills.length > 0 && (
                          <div>
                            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Skills: </span>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '2px' }}>
                              {skills.map((s, i) => (
                                <span key={i} style={{ fontSize: '11px', padding: '2px 8px', background: 'rgba(99,102,241,0.08)', borderRadius: '4px', color: 'var(--accent-primary)', fontWeight: 500 }}>{s}</span>
                              ))}
                            </div>
                          </div>
                        )}
                        {certs.length > 0 && (
                          <div>
                            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Certifications: </span>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '2px' }}>
                              {certs.map((c, i) => (
                                <span key={i} style={{ fontSize: '11px', padding: '2px 8px', background: 'rgba(16,185,129,0.08)', borderRadius: '4px', color: 'var(--accent-secondary)', fontWeight: 500 }}>{c}</span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Associated Branches Queue */}
                <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>
                      Audit Branches ({projectBranches.length})
                    </span>
                    {(detail.status === ProjectStatus.DRAFT || detail.status === ProjectStatus.PLANNING) && (
                      <label style={{ padding: '4px 8px', fontSize: '10px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', background: 'var(--gradient-neon)', border: 'none', color: '#fff', borderRadius: 'var(--radius-sm)', fontWeight: 600 }}>
                        <Plus size={11} /> Upload Excel
                        <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            setIsSaving(true);
                            setMessage(null);
                            const formData = new FormData();
                            formData.append('file', file);
                            try {
                              const token = localStorage.getItem('fapoms_token');
                              const response = await fetch(`/api/v1/projects/${detail.id}/branches/upload`, {
                                method: 'POST',
                                headers: { 'Authorization': `Bearer ${token}` },
                                body: formData
                              });
                              if (!response.ok) throw new Error('Failed to upload branches sheet');
                              setMessage({ type: 'success', text: `Successfully processed Excel sheet and associated branches!` });
                              loadDetail(detail.id);
                            } catch (err: any) {
                              setMessage({ type: 'error', text: err?.message || 'Failed to upload branches.' });
                            } finally {
                              setIsSaving(false);
                            }
                          }}
                        />
                      </label>
                    )}
                  </div>
                  {projectBranches.length === 0 ? (
                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>No branches selected for audit yet.</p>
                  ) : (
                    <div style={{ maxHeight: '140px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {projectBranches.map((pb: any) => (
                        <div key={pb.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', padding: '6px 8px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', borderLeft: '3px solid var(--accent-secondary)' }}>
                          <div>
                            <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{pb.branch?.name}</div>
                            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{pb.branch?.city}, {pb.branch?.state}</div>
                          </div>
                          <span className="badge" style={{ fontSize: '9px', padding: '2px 6px', background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)', borderRadius: '4px', fontWeight: 500 }}>{pb.status}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Metadata */}
                <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', gap: '16px', fontSize: '10px', color: 'var(--text-muted)' }}>
                  <span>Created: {new Date(detail.createdAt).toLocaleDateString()}</span>
                  <span>Updated: {new Date(detail.updatedAt).toLocaleDateString()}</span>
                </div>

                {/* Lifecycle Transitions */}
                <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', display: 'block', marginBottom: '8px' }}>Transitions</span>
                  {CAN_TRANSITION[detail.status] ? (
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {TRANSITIONS[detail.status]?.map(target => (
                        <button key={target} onClick={() => handleTransition(target)}
                          style={{
                            padding: '5px 10px', fontSize: '11px', borderRadius: 'var(--radius-sm)',
                            background: target === ProjectStatus.CANCELLED ? 'rgba(239,68,68,0.08)' : 'rgba(99,102,241,0.08)',
                            border: `1px solid ${target === ProjectStatus.CANCELLED ? 'rgba(239,68,68,0.3)' : 'rgba(99,102,241,0.3)'}`,
                            color: target === ProjectStatus.CANCELLED ? '#ef4444' : 'var(--accent-primary)',
                            cursor: 'pointer', fontWeight: 600,
                          }}>
                          {target === ProjectStatus.CANCELLED ? 'Cancel' : `→ ${target}`}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>No transitions available for this status.</span>
                  )}
                </div>

                {/* Actions */}
                <div style={{ padding: '16px 20px', display: 'flex', gap: '8px', marginTop: 'auto' }}>
                  <button onClick={() => navigate(`/planning?projectId=${detail.id}`)} className="btn btn-secondary" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '8px', fontSize: '12px' }}>
                    <ExternalLink size={13} /> Planning
                  </button>
                  <button onClick={openEdit} className="btn btn-secondary" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '8px', fontSize: '12px' }}>
                    <Edit2 size={13} /> Edit
                  </button>
                  <button onClick={() => setShowDeleteConfirm(true)} className="btn btn-secondary" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '8px', fontSize: '12px', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444' }}>
                    <Trash2 size={13} /> Delete
                  </button>
                </div>
              </>
            ) : (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '60px 20px' }}>
                <Building2 size={36} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
                <p style={{ fontSize: '13px' }}>Select a project to view details.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && renderForm(handleCreate, () => setShowCreateModal(false), 'Create Audit Project')}

      {/* Edit Modal */}
      {showEditModal && renderForm(handleEdit, () => setShowEditModal(false), 'Edit Project')}

      {/* Delete Confirmation */}
      {showDeleteConfirm && detail && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="glass-card" style={{ width: '400px', display: 'flex', flexDirection: 'column', gap: '20px', padding: '24px' }}>
            <h4 style={{ fontSize: '18px', fontWeight: 600 }}>Delete Project</h4>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
              Are you sure you want to delete <b>{detail.name}</b> ({detail.projectNumber})? This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
              <button onClick={() => setShowDeleteConfirm(false)} className="btn btn-secondary">Cancel</button>
              <button onClick={handleDelete} className="btn btn-primary" style={{ background: '#ef4444', border: 'none' }}>Delete</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
