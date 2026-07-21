import React, { useState, useEffect } from 'react';
import { Search, Filter, Plus, FileSpreadsheet, Eye, X, CheckCircle, AlertCircle } from 'lucide-react';
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
  createdAt: string;
}

export const Projects: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Modal State
  const [showModal, setShowModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectNumber, setNewProjectNumber] = useState('');
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedPriority, setSelectedPriority] = useState<Priority>(Priority.MEDIUM);
  const [startDate, setStartDate] = useState('2026-07-01');
  const [endDate, setEndDate] = useState('2026-07-31');

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadProjects();
    loadClients();
  }, []);

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
      if (response.length > 0) {
        setSelectedClientId(response[0].id);
      }
    } catch (err) {
      console.error('Failed to load clients options');
    }
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    if (!newProjectName || !newProjectNumber || !selectedClientId) {
      setMessage({ type: 'error', text: 'Please fill in all mandatory fields.' });
      return;
    }

    try {
      const response = await fetch('/api/v1/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('fapoms_token')}`
        },
        body: JSON.stringify({
          name: newProjectName,
          projectNumber: newProjectNumber,
          clientId: selectedClientId,
          priority: selectedPriority,
          startDate,
          endDate
        })
      });

      const resData = await response.json();

      if (response.ok && resData.success) {
        setMessage({ type: 'success', text: `Project "${newProjectName}" successfully created!` });
        setShowModal(false);
        // Clear fields
        setNewProjectName('');
        setNewProjectNumber('');
        loadProjects();
      } else {
        setMessage({ type: 'error', text: resData.message || 'Failed to create project.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Network connection error.' });
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
    return match ? match.name : 'SBI Corporate';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      
      {/* Page Header Actions */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)' }}>Projects Directory</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Manage all client audit cycles and monitor progress.</p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button className="btn btn-secondary">
            <FileSpreadsheet size={16} /> Export CSV
          </button>
          <button onClick={() => { setMessage(null); setShowModal(true); }} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Plus size={16} /> Create Project
          </button>
        </div>
      </div>

      {/* Notifications Alert */}
      {message && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '12px 16px',
          borderRadius: 'var(--radius-md)',
          fontSize: '13px',
          border: '1px solid',
          background: message.type === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
          borderColor: message.type === 'success' ? 'var(--accent-secondary)' : 'rgba(239,68,68,0.4)',
          color: message.type === 'success' ? 'var(--accent-secondary)' : '#f87171'
        }}>
          {message.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
          <span>{message.text}</span>
        </div>
      )}

      {/* Filter Row */}
      <div className="glass-card" style={{ padding: '16px', display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        
        {/* Search */}
        <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
          <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input 
            type="text"
            placeholder="Search by project name or code..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px 10px 36px',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-primary)',
              outline: 'none',
              fontSize: '14px'
            }}
          />
        </div>

        {/* Status Filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Filter size={16} style={{ color: 'var(--text-muted)' }} />
          <select 
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{
              padding: '10px 16px',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-primary)',
              outline: 'none',
              fontSize: '14px'
            }}
          >
            <option value="ALL">All Statuses</option>
            {Object.values(ProjectStatus).map(status => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </div>

      </div>

      {/* Projects Table */}
      <div className="table-container">
        {isLoading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
            Loading projects master directory...
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Project Number</th>
                <th>Project Name</th>
                <th>Client Name</th>
                <th>Priority</th>
                <th>Timeline</th>
                <th>Status</th>
                <th style={{ textAlign: 'center' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredProjects.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)' }}>
                    No projects found.
                  </td>
                </tr>
              ) : (
                filteredProjects.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: 'monospace', fontWeight: 600 }}>{p.projectNumber}</td>
                    <td style={{ fontWeight: 600 }}>{p.name}</td>
                    <td>{getClientName(p.clientId)}</td>
                    <td>
                      <span style={{ 
                        color: p.priority === Priority.CRITICAL ? 'var(--priority-critical)' : 
                               p.priority === Priority.HIGH ? 'var(--priority-high)' : 
                               p.priority === Priority.MEDIUM ? 'var(--priority-medium)' : 'var(--priority-low)',
                        fontWeight: 600,
                        fontSize: '13px'
                      }}>
                        {p.priority}
                      </span>
                    </td>
                    <td style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                      {p.startDate ? `${new Date(p.startDate).toLocaleDateString()} - ${new Date(p.endDate!).toLocaleDateString()}` : 'Not scheduled'}
                    </td>
                    <td>
                      <span className="badge" style={{
                        background: p.status === ProjectStatus.EXECUTION ? 'var(--status-active-bg)' : 
                                   p.status === ProjectStatus.PLANNING ? 'rgba(99, 102, 241, 0.1)' : 
                                   p.status === ProjectStatus.DRAFT ? 'var(--status-draft-bg)' : 'var(--status-pending-bg)',
                        color: p.status === ProjectStatus.EXECUTION ? 'var(--status-active)' : 
                               p.status === ProjectStatus.PLANNING ? 'var(--accent-primary)' : 
                               p.status === ProjectStatus.DRAFT ? 'var(--status-draft)' : 'var(--status-pending)',
                      }}>
                        {p.status}
                      </span>
                    </td>
                    <td style={{ display: 'flex', justifyContent: 'center', gap: '8px' }}>
                      <button className="btn btn-secondary" style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Eye size={14} /> Detail
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Creation Modal Overlay */}
      {showModal && (
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
          <form onSubmit={handleCreateProject} className="glass-card" style={{ width: '460px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ fontSize: '18px', fontWeight: 600 }}>Create Audit Project</h4>
              <button type="button" onClick={() => setShowModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Project Name *</label>
                <input 
                  type="text" 
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="e.g. SBI Quarter 3 Audit"
                  required
                  style={{
                    padding: '10px',
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    color: '#fff',
                    outline: 'none'
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Project Number / Business Identifier *</label>
                <input 
                  type="text" 
                  value={newProjectNumber}
                  onChange={(e) => setNewProjectNumber(e.target.value)}
                  placeholder="e.g. PRJ-2026-002"
                  required
                  style={{
                    padding: '10px',
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    color: '#fff',
                    outline: 'none'
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Client Institution *</label>
                <select
                  value={selectedClientId}
                  onChange={(e) => setSelectedClientId(e.target.value)}
                  required
                  style={{
                    padding: '10px',
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    color: '#fff',
                    outline: 'none'
                  }}
                >
                  {clients.map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c.clientCode})</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Priority *</label>
                <select
                  value={selectedPriority}
                  onChange={(e) => setSelectedPriority(e.target.value as Priority)}
                  required
                  style={{
                    padding: '10px',
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    color: '#fff',
                    outline: 'none'
                  }}
                >
                  {Object.values(Priority).map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Start Date</label>
                  <input 
                    type="date" 
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    style={{
                      padding: '10px',
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border-color)',
                      borderRadius: 'var(--radius-sm)',
                      color: '#fff',
                      outline: 'none'
                    }}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>End Date</label>
                  <input 
                    type="date" 
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    style={{
                      padding: '10px',
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border-color)',
                      borderRadius: 'var(--radius-sm)',
                      color: '#fff',
                      outline: 'none'
                    }}
                  />
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
              <button type="button" onClick={() => setShowModal(false)} className="btn btn-secondary">
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Confirm & Create
              </button>
            </div>

          </form>
        </div>
      )}

    </div>
  );
};
