import React from 'react';
import { NavLink } from 'react-router-dom';
import { 
  LayoutDashboard, 
  FolderKanban, 
  GitMerge, 
  Map, 
  CalendarDays, 
  Files, 
  ShieldAlert, 
  BarChart3, 
  Settings, 
  ClipboardList
} from 'lucide-react';

interface SidebarProps {
  user?: { displayName: string; email: string };
}

export const Sidebar: React.FC<SidebarProps> = ({ user }) => {
  const menuItems = [
    { name: 'Dashboard', path: '/dashboard', icon: LayoutDashboard },
    { name: 'Projects', path: '/projects', icon: FolderKanban },
    { name: 'Branches', path: '/branches', icon: GitMerge },
    { name: 'Assignment Planning', path: '/planning', icon: Map },
    { name: 'Assignments', path: '/assignments', icon: ClipboardList },
    { name: 'Scheduling', path: '/scheduling', icon: CalendarDays },
    { name: 'Documents', path: '/documents', icon: Files },
    { name: 'Validation', path: '/validation', icon: ShieldAlert },
    { name: 'Reports', path: '/reports', icon: BarChart3 },
    { name: 'Administration', path: '/admin', icon: Settings },
  ];

  return (
    <aside className="sidebar-area" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Brand Logo Container */}
      <div style={{ 
        padding: '24px', 
        borderBottom: '1px solid var(--border-color)', 
        background: 'rgba(0,0,0,0.2)',
        display: 'flex',
        alignItems: 'center',
        gap: '12px'
      }}>
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
          boxShadow: 'var(--shadow-neon)'
        }}>
          F
        </div>
        <div>
          <h1 style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'var(--font-display)', lineHeight: 1 }}>FAPOMS</h1>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>Audit Ops Suite</span>
        </div>
      </div>

      {/* Navigation Menu */}
      <nav style={{ flex: 1, padding: '24px 16px', display: 'flex', flexDirection: 'column', gap: '6px', overflowY: 'auto' }}>
        {menuItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.name}
              to={item.path}
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 16px',
                borderRadius: 'var(--radius-md)',
                color: isActive ? '#fff' : 'var(--text-secondary)',
                background: isActive ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                borderLeft: isActive ? '3px solid var(--accent-primary)' : '3px solid transparent',
                textDecoration: 'none',
                fontSize: '14px',
                fontWeight: isActive ? 600 : 500,
                transition: 'all var(--transition-fast)'
              })}
            >
              <Icon size={18} style={{ minWidth: '18px' }} />
              <span>{item.name}</span>
            </NavLink>
          );
        })}
      </nav>

      {/* User Status Summary Footnote */}
      <div style={{ 
        padding: '20px', 
        borderTop: '1px solid var(--border-color)',
        background: 'rgba(0,0,0,0.1)',
        display: 'flex',
        alignItems: 'center',
        gap: '12px'
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
          color: 'var(--accent-secondary)'
        }}>
          {(user?.displayName || 'SA').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
            {user?.displayName || 'System Admin'}
          </span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {user?.email || 'admin@fapoms.com'}
          </span>
        </div>
      </div>
    </aside>
  );
};
