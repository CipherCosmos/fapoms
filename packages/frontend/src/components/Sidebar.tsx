import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { SystemRole } from '@fapoms/shared';
import {
  ShieldOff,
  LayoutDashboard,
  FolderKanban,
  GitMerge,
  Map,
  CalendarDays,
  Files,
  
  ClipboardList,
  Users,
  Sliders,
  Building2,
  Receipt,
  UserCog, Inbox, Flag, MessageSquare } from 'lucide-react';
import { GlobalSearch } from './GlobalSearch';
import { canAccessRoute } from '../config/route-permissions';
import { BrandLogo } from './BrandLogo';

interface SidebarProps {
  user?: { displayName: string; email: string; roles?: { name: SystemRole }[] };
  collapsed: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({ user, collapsed }) => {
  const location = useLocation();
  const userRoles = (user?.roles ?? []).map((r) => r.name);

  const allMenuGroups: { category: string; items: { name: string; path: string; icon: React.ComponentType<any> }[] }[] = [
    {
      category: 'Overview',
      items: [
        { name: 'Dashboard', path: '/dashboard', icon: LayoutDashboard },
        { name: 'Command Room', path: '/executive-map', icon: Map },
        { name: 'Feedback', path: '/feedback', icon: MessageSquare },
      ],
    },
    {
      category: 'Operations',
      items: [
        { name: 'Ops Inbox', path: '/inbox', icon: Inbox },
        { name: 'Projects', path: '/projects', icon: FolderKanban },
        { name: 'Stage 1: Planning', path: '/planning', icon: Map },
        { name: 'Stage 2: Schedule Dispatch', path: '/scheduling', icon: CalendarDays },
        { name: 'Stage 3: Field Execution', path: '/assignments', icon: ClipboardList },
        { name: 'Field Issues', path: '/field-issues', icon: Flag },
      ],
    },
    {
      category: 'Management',
      items: [
        { name: 'Clients', path: '/clients', icon: Building2 },
        { name: 'Billing', path: '/billing', icon: Receipt },
        { name: 'Branches', path: '/branches', icon: GitMerge },
        { name: 'Workforce', path: '/hr', icon: UserCog },
        { name: 'Documents', path: '/documents', icon: Files },
        { name: 'Data Entry & Validation', path: '/data-entry', icon: Inbox },
      ],
    },
    {
      category: 'Administration',
      items: [
        { name: 'Holiday Calendar', path: '/holidays', icon: CalendarDays },
        { name: 'Territorial Zones', path: '/zones', icon: Map },
        { name: 'Rule Engine', path: '/rules', icon: Sliders },
        // Administrators only — filtered by canAccessRoute against route-permissions, same as
        // every other item here.
        { name: 'Rule Bypass (Testing)', path: '/admin/rule-bypass', icon: ShieldOff },
        { name: 'User Management', path: '/users', icon: Users },
      ],
    },
  ];

  const menuGroups = allMenuGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canAccessRoute(userRoles, item.path)),
    }))
    .filter((group) => group.items.length > 0);

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
          color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
          background: isActive ? 'var(--status-pending-bg)' : 'transparent',
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
    // No `sidebar-area` class on this aside: that's the Layout wrapper's class. When this aside
    // also carried it, the ≤1024px drawer CSS (`transform: translateX(-100%)`) matched BOTH
    // nodes — the wrapper slid in with `.mobile-open`, but this inner aside (all the content)
    // stayed translated off-screen, so the open drawer showed as an empty panel.
    <aside style={{ display: 'flex', flexDirection: 'column', height: '100%', transition: 'all var(--transition-normal)' }}>
      {/* Brand + Toggle */}
      <div style={{ 
        padding: collapsed ? '16px 14px' : '20px 24px', 
        borderBottom: '1px solid var(--border-color)', 
        background: 'rgba(0,0,0,0.2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: collapsed ? 0 : '12px',
        position: 'relative'
      }}>
        <BrandLogo size={collapsed ? 'sm' : 'md'} collapsed={collapsed} />
      </div>

      {/* Global Search */}
      {!collapsed && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)' }}>
          <GlobalSearch />
        </div>
      )}

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
    </aside>
  );
};
