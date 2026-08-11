import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { Wifi, WifiOff, Settings as SettingsIcon, LogOut, Filter, ChevronDown, Search, X, Check } from 'lucide-react';
import { SystemRole } from '@fapoms/shared';
import { NotificationDropdown } from './NotificationDropdown';
import { MenuToggle } from './ui/MenuToggle';
import { useSocketConnection } from '../hooks/useSocketConnection';
import { useScope } from '../context/ScopeContext';
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

/** One row of the scope panel. A native select — the list can run to 30+ states. */
const ScopeSelect: React.FC<{
  label: string;
  value: string;
  allLabel: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}> = ({ label, value, allLabel, options, onChange }) => (
  <label style={{ display: 'grid', gridTemplateColumns: '52px 1fr', alignItems: 'center', gap: '8px' }}>
    <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' }}>{label}</span>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={options.length === 0}
      style={{
        width: '100%',
        padding: '5px 8px',
        fontSize: '12px',
        fontWeight: value !== 'ALL' ? 700 : 500,
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-surface-2)',
        color: value !== 'ALL' ? 'var(--accent-primary)' : 'var(--text-primary)',
        border: `1px solid ${value !== 'ALL' ? 'var(--accent-primary)' : 'var(--border-color)'}`,
        cursor: options.length === 0 ? 'not-allowed' : 'pointer',
        outline: 'none',
      }}
    >
      <option value="ALL">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  </label>
);

export const Header: React.FC<HeaderProps> = ({ user, onLogout, onToggleSidebar, title }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const live = useSocketConnection();
  const {
    projects, selectedProjectId, setSelectedProjectId, selectedProject,
    options, region, clientId, zoneId, state,
    availableStates, availableZones, setScope, resetScope, activeCount, applies,
  } = useScope();
  const [profileHover, setProfileHover] = useState(false);
  const [filterDropdownOpen, setFilterDropdownOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');

  // The panel is portaled out of the header (see the note at its render site), so its position
  // has to be measured rather than inherited, and it is no longer a DOM descendant of the
  // button — outside-click has to test both nodes.
  const scopeAnchorRef = useRef<HTMLDivElement>(null);
  const scopePanelRef = useRef<HTMLDivElement>(null);
  const [scopeAnchorRect, setScopeAnchorRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!filterDropdownOpen) return;
    const measure = () => setScopeAnchorRect(scopeAnchorRef.current?.getBoundingClientRect() ?? null);
    measure();
    // Fixed coordinates go stale when the viewport moves under them. `true` catches scrolls in
    // `.main-area` and any other nested scroller, not just the window.
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [filterDropdownOpen]);

  useEffect(() => {
    if (!filterDropdownOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !scopeAnchorRef.current?.contains(target) &&
        !scopePanelRef.current?.contains(target)
      ) {
        setFilterDropdownOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFilterDropdownOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [filterDropdownOpen]);

  const filteredProjects = projects.filter((p) => {
    const q = projectSearch.toLowerCase().trim();
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.projectNumber.toLowerCase().includes(q) ||
      (p.client?.name && p.client.name.toLowerCase().includes(q))
    );
  });

  // The button shows the narrowest thing that is set, with a count badge for the rest —
  // "West · +2" reads at a glance where "Region: West, Client: RBL, State: Gujarat" does not.
  const scopeSummary = (() => {
    if (state !== 'ALL') return state;
    if (zoneId !== 'ALL') return options.zones.find((z) => z.id === zoneId)?.name ?? 'Zone';
    if (selectedProjectId !== 'ALL') {
      return selectedProject ? `${selectedProject.projectNumber} — ${selectedProject.name}` : 'Selected project';
    }
    if (clientId !== 'ALL') return options.clients.find((c) => c.id === clientId)?.name ?? 'Client';
    if (region !== 'ALL') return options.regions.find((r) => r.value === region)?.label ?? region;
    return options.assignedRegions ? `My regions (${options.assignedRegions.length})` : 'All data';
  })();

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
        {/* Global operational scope: project, region, client, zone, state. */}
        {/* Hidden on the data-entry and validation desks: the scope does not govern their
            queues, and a control that visibly does nothing reads as a broken filter. */}
        {applies && (projects.length > 0 || options.regions.length > 0) && (
          <div className="header-project-filter" style={{ position: 'relative' }} ref={scopeAnchorRef}>
            <button
              onClick={() => setFilterDropdownOpen((open) => !open)}
              title="Global scope filter — narrow the whole app to your region, client, zone or project"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '7px',
                padding: '5px 12px',
                borderRadius: 'var(--radius-full)',
                background: activeCount > 0 ? 'var(--accent-soft)' : 'var(--bg-primary)',
                border: `1px solid ${activeCount > 0 ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                color: activeCount > 0 ? 'var(--accent-primary)' : 'var(--text-secondary)',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
              }}
            >
              <Filter size={12} style={{ color: activeCount > 0 ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
              <span style={{ maxWidth: '190px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {scopeSummary}
              </span>
              {activeCount > 1 && (
                <span
                  style={{
                    fontSize: '10px', fontWeight: 700, lineHeight: 1,
                    padding: '2px 5px', borderRadius: 'var(--radius-full)',
                    background: 'var(--accent-primary)', color: 'var(--bg-primary)',
                  }}
                >
                  {activeCount}
                </span>
              )}
              <ChevronDown size={12} style={{ color: 'var(--text-muted)' }} />
            </button>

            {/* Filter Dropdown Panel.

                Portaled to document.body and positioned with fixed coordinates measured off
                the button, the same way NotificationDropdown does it. Two separate things in
                the layout make an in-place `position: absolute` panel unusable here, and
                neither one can be beaten with z-index:

                  1. `.main-area` (index.css) is `overflow-y: auto`, which computes overflow-x
                     to `auto` as well — so it is a scroll container that CLIPS the panel to
                     its box. Clipping ignores z-index entirely.
                  2. In the glass and black-gold themes, index.css matches the header on its
                     `var(--bg-secondary)` inline background and gives it a `backdrop-filter`.
                     That makes `.app-header` a stacking context with `z-index: auto`, which
                     caps everything inside it — so the panel's 999999 is only ever compared
                     against its siblings in the header, never against the modals and drawers
                     it was losing to.

                A body portal sidesteps both: nothing above it clips, and it competes at the
                root. */}
            {filterDropdownOpen && scopeAnchorRect && createPortal(
              <div
                ref={scopePanelRef}
                style={{
                  position: 'fixed',
                  // Right-aligned to the button, but never off-screen on a narrow viewport.
                  left: Math.max(12, Math.min(scopeAnchorRect.right - 300, window.innerWidth - 312)),
                  top: scopeAnchorRect.bottom + 6,
                  maxHeight: `calc(100vh - ${scopeAnchorRect.bottom + 18}px)`,
                  width: '300px',
                  background: 'var(--bg-surface-2)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-lg), 0 24px 50px rgba(0,0,0,0.4)',
                  // Matches the notification dropdown. Meaningful now that the panel is at the
                  // root: pages mount modals, drawers and map overlays at 1000–10001.
                  zIndex: 999999,
                  display: 'flex',
                  flexDirection: 'column',
                  // `maxHeight` above keeps the panel inside the viewport; this lets the whole
                  // panel scroll on a short screen rather than clipping the footer off.
                  overflowY: 'auto',
                }}
              >
                {/* Geographic + client scope. Region sits first because it is the one an
                    operator sets once and leaves alone; the rest narrow within it. */}
                <div style={{ padding: '10px', borderBottom: '1px solid var(--border-color)', display: 'grid', gap: '8px', background: 'var(--bg-primary)' }}>
                  <ScopeSelect
                    label="Region"
                    value={region}
                    onChange={(v) => setScope({ region: v })}
                    allLabel={
                      options.assignedRegions
                        ? `My regions (${options.assignedRegions.length})`
                        : 'All regions'
                    }
                    options={options.regions.map((r) => ({ value: r.value, label: `${r.label} (${r.count})` }))}
                  />
                  <ScopeSelect
                    label="Client"
                    value={clientId}
                    onChange={(v) => setScope({ clientId: v })}
                    allLabel="All clients"
                    options={options.clients.map((c) => ({ value: c.id, label: c.name }))}
                  />
                  <ScopeSelect
                    label="Zone"
                    value={zoneId}
                    onChange={(v) => setScope({ zoneId: v })}
                    allLabel="All zones"
                    options={availableZones.map((z) => ({ value: z.id, label: z.name }))}
                  />
                  <ScopeSelect
                    label="State"
                    value={state}
                    onChange={(v) => setScope({ state: v })}
                    allLabel="All states"
                    options={availableStates.map((s) => ({ value: s.value, label: `${s.value} (${s.count})` }))}
                  />
                </div>

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
                {activeCount > 0 && (
                  <div style={{ padding: '6px 10px', borderTop: '1px solid var(--border-color)', background: 'var(--bg-primary)' }}>
                    <button
                      onClick={() => {
                        resetScope();
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
                      <span>Clear all scope filters</span>
                    </button>
                  </div>
                )}
              </div>,
              document.body,
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
