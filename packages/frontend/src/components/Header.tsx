import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Wifi, WifiOff, Settings as SettingsIcon, LogOut, Filter, ChevronDown, Search, X, Check } from 'lucide-react';
import { SystemRole } from '@fapoms/shared';
import { NotificationDropdown } from './NotificationDropdown';
import { MenuToggle } from './ui/MenuToggle';
import { useSocketConnection } from '../hooks/useSocketConnection';
import { useProject } from '../context/ProjectContext';
import { GlobalSearch } from './GlobalSearch';

interface HeaderProps {
  user?: { displayName: string; email: string; roles?: { name: SystemRole }[] };
  onLogout?: () => void;
  onToggleSidebar?: () => void;
  title?: string;
}

const BREADCRUMBS: { prefix: string; category: string; label: string }[] = [
  { prefix: '/dashboard', category: 'Overview', label: 'Dashboard' },
  { prefix: '/executive-map', category: 'Overview', label: 'Command Room' },
  { prefix: '/projects', category: 'Operations', label: 'Projects' },
  { prefix: '/planning', category: 'Operations', label: 'Stage 1: Planning' },
  { prefix: '/scheduling', category: 'Operations', label: 'Stage 2: Schedule Dispatch' },
  { prefix: '/assignments', category: 'Operations', label: 'Stage 3: Field Execution' },
  { prefix: '/clients', category: 'Management', label: 'Clients' },
  { prefix: '/billing', category: 'Management', label: 'Billing' },
  { prefix: '/branches', category: 'Management', label: 'Branches' },
  { prefix: '/hr', category: 'Management', label: 'Workforce' },
  { prefix: '/documents', category: 'Management', label: 'Documents' },
  { prefix: '/data-entry', category: 'Management', label: 'Data Entry & Validation' },
  { prefix: '/holidays', category: 'Administration', label: 'Holiday Calendar' },
  { prefix: '/rules', category: 'Administration', label: 'Rule Engine' },
  { prefix: '/users', category: 'Administration', label: 'User Management' },
  { prefix: '/settings', category: 'Administration', label: 'Settings' },
];

export const Header: React.FC<HeaderProps> = ({ user, onLogout, onToggleSidebar, title }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const live = useSocketConnection();
  const { projects, selectedProjectId, setSelectedProjectId, selectedProject } = useProject();
  const [profileHover, setProfileHover] = useState(false);
  const [filterDropdownOpen, setFilterDropdownOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');

  const filteredProjects = projects.filter((p) => {
    const q = projectSearch.toLowerCase().trim();
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.projectNumber.toLowerCase().includes(q) ||
      (p.client?.name && p.client.name.toLowerCase().includes(q))
    );
  });

  const match = BREADCRUMBS.find((b) => location.pathname.startsWith(b.prefix));
  const initials = (user?.displayName || 'SA').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();

  return (
    <header className="app-header" style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      padding: '0 24px',
      height: '56px',
      borderBottom: '1px solid var(--border-color)',
      background: 'var(--bg-secondary)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0, overflow: 'hidden' }}>
        {onToggleSidebar && (
          <MenuToggle onClick={onToggleSidebar} title="Toggle Menu" />
        )}
        {match ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '12px', overflow: 'hidden' }}>
            <span style={{ color: 'var(--text-muted)' }}>/</span>
            <span style={{ fontWeight: 600, color: 'var(--accent)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {title || match.label}
            </span>
          </div>
        ) : (
          <span style={{ fontSize: '15px', fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--accent)', whiteSpace: 'nowrap' }}>
            Sumeru Audit Suite
          </span>
        )}
      </div>

      <div className="header-actions" style={{ display: 'flex', alignItems: 'center', gap: '16px', minWidth: 0 }}>
        {/* Enhanced Global Project Filter */}
        {projects.length > 0 && (
          <div className="header-project-filter" style={{ position: 'relative' }}>
            <button
              onClick={() => setFilterDropdownOpen((open) => !open)}
              title="Global Project Scope Filter"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '7px',
                padding: '5px 12px',
                borderRadius: 'var(--radius-full)',
                background: selectedProjectId !== 'ALL' ? 'var(--accent-soft)' : 'var(--bg-primary)',
                border: `1px solid ${selectedProjectId !== 'ALL' ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                color: selectedProjectId !== 'ALL' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
              }}
            >
              <Filter size={12} style={{ color: selectedProjectId !== 'ALL' ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
              <span style={{ maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedProjectId === 'ALL'
                  ? 'All Projects'
                  : selectedProject
                  ? `${selectedProject.projectNumber} — ${selectedProject.name}`
                  : 'Selected Project'}
              </span>
              <ChevronDown size={12} style={{ color: 'var(--text-muted)' }} />
            </button>

            {/* Filter Dropdown Panel */}
            {filterDropdownOpen && (
              <div
                style={{
                  position: 'absolute',
                  right: 0,
                  top: '100%',
                  marginTop: '6px',
                  width: '280px',
                  background: 'var(--bg-surface-2)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-lg)',
                  zIndex: 1000,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                {/* Search Bar */}
                <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '6px', background: 'var(--bg-primary)' }}>
                  <Search size={13} style={{ color: 'var(--text-muted)' }} />
                  <input
                    type="text"
                    placeholder="Search projects..."
                    value={projectSearch}
                    onChange={(e) => setProjectSearch(e.target.value)}
                    style={{
                      width: '100%',
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-primary)',
                      fontSize: '12px',
                      outline: 'none',
                    }}
                  />
                  {projectSearch && (
                    <button
                      onClick={() => setProjectSearch('')}
                      style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>

                {/* Project List */}
                <div style={{ maxHeight: '240px', overflowY: 'auto', padding: '4px 0' }}>
                  <button
                    onClick={() => {
                      setSelectedProjectId('ALL');
                      setFilterDropdownOpen(false);
                      setProjectSearch('');
                    }}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 14px',
                      background: selectedProjectId === 'ALL' ? 'var(--status-pending-bg)' : 'transparent',
                      border: 'none',
                      color: selectedProjectId === 'ALL' ? 'var(--accent-primary)' : 'var(--text-primary)',
                      fontSize: '12px',
                      fontWeight: selectedProjectId === 'ALL' ? 700 : 500,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>All Projects ({projects.length})</span>
                    {selectedProjectId === 'ALL' && <Check size={14} style={{ color: 'var(--accent-primary)' }} />}
                  </button>

                  {filteredProjects.map((p) => {
                    const active = selectedProjectId === p.id;
                    return (
                      <button
                        key={p.id}
                        onClick={() => {
                          setSelectedProjectId(p.id);
                          setFilterDropdownOpen(false);
                          setProjectSearch('');
                        }}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 14px',
                          background: active ? 'var(--status-pending-bg)' : 'transparent',
                          border: 'none',
                          color: active ? 'var(--accent-primary)' : 'var(--text-primary)',
                          fontSize: '12px',
                          fontWeight: active ? 700 : 500,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '8px',
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                          <span style={{ fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{p.projectNumber} {p.client?.name ? `• ${p.client.name}` : ''}</span>
                        </div>
                        {active && <Check size={14} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />}
                      </button>
                    );
                  })}

                  {filteredProjects.length === 0 && (
                    <div style={{ padding: '12px 14px', fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center' }}>
                      No matching projects
                    </div>
                  )}
                </div>

                {/* Footer Clear Action */}
                {selectedProjectId !== 'ALL' && (
                  <div style={{ padding: '6px 10px', borderTop: '1px solid var(--border-color)', background: 'var(--bg-primary)' }}>
                    <button
                      onClick={() => {
                        setSelectedProjectId('ALL');
                        setFilterDropdownOpen(false);
                        setProjectSearch('');
                      }}
                      style={{
                        width: '100%',
                        padding: '4px',
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-muted)',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '4px',
                      }}
                    >
                      <X size={12} />
                      <span>Reset to All Projects</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <div className="header-search" style={{ position: 'relative', width: '240px', flexShrink: 0 }}>
          <GlobalSearch />
        </div>
        <div
          className="header-live-badge"
          title={live ? 'Live updates connected' : 'Live updates disconnected'}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '4px 8px', borderRadius: 'var(--radius-full)',
            fontSize: '11px', fontWeight: 600,
            background: live ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)',
            color: live ? 'var(--success)' : 'var(--danger)',
            whiteSpace: 'nowrap',
          }}
        >
          {live ? <Wifi size={12} /> : <WifiOff size={12} />}
          {live ? 'Live' : 'Offline'}
        </div>
        <NotificationDropdown />

        {/* Profile Avatar Hover Menu */}
        <div
          style={{ position: 'relative' }}
          onMouseEnter={() => setProfileHover(true)}
          onMouseLeave={() => setProfileHover(false)}
        >
          <div
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              background: 'var(--accent-soft)',
              border: '1px solid var(--accent-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '12px',
              fontWeight: 700,
              color: 'var(--accent)',
              cursor: 'pointer',
            }}
            title={user?.displayName || 'User Profile'}
          >
            {initials}
          </div>

          {/* Hover Menu Card */}
          {profileHover && (
            <div
              style={{
                position: 'absolute',
                right: 0,
                top: '100%',
                marginTop: '4px',
                width: '210px',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--shadow-lg)',
                padding: '8px 0',
                zIndex: 1000,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {/* User Header Info */}
              <div style={{ padding: '8px 14px 10px 14px', borderBottom: '1px solid var(--border-color)' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {user?.displayName || 'System Admin'}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {user?.email || 'admin@fapoms.com'}
                </div>
              </div>

              {/* Menu Actions */}
              <button
                onClick={() => {
                  setProfileHover(false);
                  navigate('/settings');
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '10px 14px',
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-primary)',
                  fontSize: '13px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  textAlign: 'left',
                  width: '100%',
                  transition: 'background 0.15s ease',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                <SettingsIcon size={15} style={{ color: 'var(--accent)' }} />
                <span>Settings & Profile</span>
              </button>

              {onLogout && (
                <button
                  onClick={() => {
                    setProfileHover(false);
                    onLogout();
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '10px 14px',
                    background: 'none',
                    border: 'none',
                    color: 'var(--danger)',
                    fontSize: '13px',
                    fontWeight: 500,
                    cursor: 'pointer',
                    textAlign: 'left',
                    width: '100%',
                    borderTop: '1px solid var(--border-color)',
                    transition: 'background 0.15s ease',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--status-cancelled-bg)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                >
                  <LogOut size={15} />
                  <span>Sign Out</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
