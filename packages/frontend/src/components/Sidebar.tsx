import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  FolderKanban,
  GitMerge,
  Map,
  CalendarDays,
  Files,
  ShieldAlert,
  ClipboardList,
  Users,
  Sliders,
  Building2,
  ChevronLeft,
  ChevronRight,
  LogOut,
} from 'lucide-react';

interface SidebarProps {
  user?: { displayName: string; email: string };
  collapsed: boolean;
  onToggle: () => void;
  onLogout?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ user, collapsed, onToggle, onLogout }) => {
  const location = useLocation();

  const menuGroups: { category: string; items: { name: string; path: string; icon: React.ComponentType<any> }[] }[] = [
    {
      category: 'Overview',
      items: [
        { name: 'Dashboard', path: '/dashboard', icon: LayoutDashboard },
        { name: 'Command Room', path: '/executive-map', icon: Map },
      ],
    },
    {
      category: 'Operations',
      items: [
        { name: 'Projects', path: '/projects', icon: FolderKanban },
        { name: 'Planning', path: '/planning', icon: Map },
        { name: 'Assignments', path: '/assignments', icon: ClipboardList },
        { name: 'Scheduling', path: '/scheduling', icon: CalendarDays },
      ],
    },
    {
      category: 'Management',
      items: [
        { name: 'Clients', path: '/clients', icon: Building2 },
        { name: 'Branches', path: '/branches', icon: GitMerge },
        { name: 'Assayers', path: '/assayers', icon: Users },
        { name: 'Documents', path: '/documents', icon: Files },
        { name: 'Validation', path: '/validation', icon: ShieldAlert },
      ],
    },
    {
      category: 'Administration',
      items: [
        { name: 'Rule Engine', path: '/rules', icon: Sliders },
        { name: 'User Management', path: '/users', icon: Users },
      ],
    },
  ];

  const renderNavLink = (item: { name: string; path: string; icon: React.ComponentType<any> }) => {
    const Icon = item.icon;
    const isActive = location.pathname === item.path || location.pathname.startsWith(item.path + '/');
    return (
      <NavLink
        key={item.name}
        to={item.path}
        className={`sidebar-link ${isActive ? 'active' : ''}`}
        title={collapsed ? item.name : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          gap: collapsed ? 0 : '12px',
          padding: collapsed ? '10px' : '10px 16px',
          borderRadius: 'var(--radius-md)',
          color: isActive ? '#fff' : 'var(--text-secondary)',
          background: isActive ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
          borderLeft: !collapsed && isActive ? '3px solid var(--accent-primary)' : collapsed ? 'none' : '3px solid transparent',
          textDecoration: 'none',
          fontSize: '13px',
          fontWeight: isActive ? 600 : 500,
          transition: 'all var(--transition-fast)',
          position: 'relative',
        }}
      >
        <Icon size={18} style={{ minWidth: '18px', flexShrink: 0 }} />
        {!collapsed && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</span>}
        {collapsed && isActive && (
          <div style={{ position: 'absolute', left: 0, top: '6px', bottom: '6px', width: '3px', background: 'var(--accent-primary)', borderRadius: '2px' }} />
        )}
      </NavLink>
    );
  };

  return (
    <aside className="sidebar-area" style={{ display: 'flex', flexDirection: 'column', height: '100%', transition: 'all var(--transition-normal)' }}>
      {/* Brand + Toggle */}
      <div style={{ 
        padding: collapsed ? '16px 14px' : '24px', 
        borderBottom: '1px solid var(--border-color)', 
        background: 'rgba(0,0,0,0.2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'space-between',
        gap: collapsed ? 0 : '12px',
        position: 'relative'
      }}>
        {!collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', overflow: 'hidden' }}>
            <div style={{
              background: 'var(--gradient-neon)',
              width: '36px',
              height: '36px',
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontWeight: 800,
              fontSize: '18px',
              fontFamily: 'var(--font-display)',
              boxShadow: 'var(--shadow-neon)',
              flexShrink: 0
            }}>
              F
            </div>
            <div>
              <h1 style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'var(--font-display)', lineHeight: 1 }}>FAPOMS</h1>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>Audit Ops Suite</span>
            </div>
          </div>
        )}
        {collapsed && (
          <div style={{
            background: 'var(--gradient-neon)',
            width: '36px',
            height: '36px',
            borderRadius: 'var(--radius-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontWeight: 800,
            fontSize: '18px',
            fontFamily: 'var(--font-display)',
            boxShadow: 'var(--shadow-neon)',
            flexShrink: 0
          }}>
            F
          </div>
        )}
        <button
          onClick={onToggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            position: collapsed ? 'absolute' : 'static',
            right: collapsed ? '-12px' : 'auto',
            top: collapsed ? '50%' : 'auto',
            transform: collapsed ? 'translateY(-50%)' : 'none',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-full)',
            width: '24px',
            height: '24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: 'var(--text-secondary)',
            zIndex: 5,
            flexShrink: 0
          }}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </div>

      {/* Navigation Menu */}
      <nav style={{ flex: 1, padding: collapsed ? '16px 10px' : '20px 16px', display: 'flex', flexDirection: 'column', gap: '2px', overflowY: 'auto' }}>
        {menuGroups.map(group => (
          <div key={group.category} style={{ marginBottom: collapsed ? '4px' : '8px' }}>
            {!collapsed && (
              <div style={{ padding: '4px 16px 6px', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>
                {group.category}
              </div>
            )}
            {group.items.map(renderNavLink)}
          </div>
        ))}
      </nav>

      {/* User Status */}
      <div style={{ 
        padding: collapsed ? '16px 14px' : '20px', 
        borderTop: '1px solid var(--border-color)',
        background: 'rgba(0,0,0,0.1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        gap: collapsed ? 0 : '12px',
        position: 'relative',
      }}>
        <div style={{ 
          width: '36px', 
          height: '36px', 
          borderRadius: 'var(--radius-full)', 
          background: 'var(--bg-tertiary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 600,
          color: 'var(--accent-secondary)',
          flexShrink: 0
        }}>
          {(user?.displayName || 'SA').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
        </div>
        {!collapsed && (
          <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {user?.displayName || 'System Admin'}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {user?.email || 'admin@fapoms.com'}
            </span>
          </div>
        )}
        {onLogout && (
          <button onClick={onLogout} title="Logout"
            style={{ position: collapsed ? 'absolute' : 'static', right: collapsed ? '-12px' : 'auto', top: collapsed ? '50%' : 'auto', transform: collapsed ? 'translateY(-50%)' : 'none', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 'var(--radius-sm)', color: '#ef4444', cursor: 'pointer', padding: collapsed ? '6px' : '6px 10px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', fontWeight: 500, marginLeft: collapsed ? 0 : 'auto', flexShrink: 0 }}>
            <LogOut size={collapsed ? 14 : 12} />
            {!collapsed && <span>Logout</span>}
          </button>
        )}
      </div>
    </aside>
  );
};
