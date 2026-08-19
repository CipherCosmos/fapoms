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
  UserCog, Inbox, MessageSquare, Bus, BellRing, SlidersHorizontal } from 'lucide-react';
import { GlobalSearch } from './GlobalSearch';
import { canAccessRoute } from '../config/route-permissions';
import { WORK_TABS } from '../pages/work/workTabs';
import { BrandLogo } from './BrandLogo';

interface SidebarProps {
  user?: { displayName: string; email: string; roles?: { name: SystemRole }[] };
  collapsed: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({ user, collapsed }) => {
  const location = useLocation();
  const userRoles = (user?.roles ?? []).map((r) => r.name);

  /**
   * ONE ENTRY FOR ONE JOB.
   *
   * "My Work Today", "Audit Planning", "Visit Scheduling" and "Field Work" used to be four
   * separate rows here — four doors onto a single job, arranged by lifecycle stage rather than by
   * anything a coordinator does. Choosing between them required already knowing which stage a
   * branch had reached, which is precisely the thing they open the app to find out. They are now
   * one destination with tabs inside it (src/pages/work/workTabs.ts explains the merge in full).
   *
   * The row still has to point at a real path, and roles differ on which stages they may open —
   * a document executive gets the calendar only, finance gets field work only — so it points at
   * the first tab this particular role can access. `activePaths` then keeps the row highlighted
   * across all four, since the visitor never leaves the destination by switching tab.
   */
  const auditWorkTabs = WORK_TABS.filter((tab) => canAccessRoute(userRoles, tab.path));

  const allMenuGroups: { category: string; items: { name: string; path: string; icon: React.ComponentType<any>; activePaths?: readonly string[] }[] }[] = [
    {
      category: 'Overview',
      items: [
        { name: 'Dashboard', path: '/dashboard', icon: LayoutDashboard },
        { name: 'Live Map', path: '/executive-map', icon: Map },
        { name: 'Feedback', path: '/feedback', icon: MessageSquare },
      ],
    },
    {
      category: 'Operations',
      items: [
        ...(auditWorkTabs.length > 0
          ? [{
              name: 'Audit Work',
              path: auditWorkTabs[0].path as string,
              icon: ClipboardList,
              activePaths: WORK_TABS.map((tab) => tab.path),
            }]
          : []),
        { name: 'Projects', path: '/projects', icon: FolderKanban },
      ],
    },
    {
      category: 'Business Records',
      items: [
        { name: 'Clients', path: '/clients', icon: Building2 },
        { name: 'Billing', path: '/billing', icon: Receipt },
        { name: 'Branches', path: '/branches', icon: GitMerge },
        { name: 'Workforce', path: '/hr', icon: UserCog },
        { name: 'Branch Paperwork', path: '/documents', icon: Files },
        { name: 'Audit Data Entry', path: '/data-entry', icon: Inbox },
      ],
    },
    /**
     * Two groups, not one list in the order things were built.
     *
     * "Operational setup" is reference data operations maintain to do the work — dates that
     * cannot be worked, territories, what travel costs, the scoring rules. "Administration" is
     * the platform itself: how it behaves, who may use it, and the deliberate suspension of its
     * controls. They were one accreted list, which is why "where do I change X" had no
     * answerable shape.
     */
    {
      category: 'Operational Setup',
      items: [
        { name: 'Holiday Calendar', path: '/holidays', icon: CalendarDays },
        { name: 'Service Areas', path: '/zones', icon: Map },
        { name: 'Transport Costs', path: '/transport-costs', icon: Bus },
        { name: 'Business Rules', path: '/rules', icon: Sliders },
      ],
    },
    {
      category: 'Administration',
      items: [
        { name: 'Platform Settings', path: '/admin/settings', icon: SlidersHorizontal },
        { name: 'Notification Rules', path: '/admin/notifications', icon: BellRing },
        { name: 'User Management', path: '/users', icon: Users },
        // Administrators only — filtered by canAccessRoute against route-permissions, same as
        // every other item here.
        { name: 'Rule Bypass', path: '/admin/rule-bypass', icon: ShieldOff },
      ],
    },
  ];

  const menuGroups = allMenuGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canAccessRoute(userRoles, item.path)),
    }))
    .filter((group) => group.items.length > 0);

  const renderNavLink = (item: { name: string; path: string; icon: React.ComponentType<any>; activePaths?: readonly string[] }) => {
    const Icon = item.icon;
    // `activePaths` exists for merged destinations (Audit Work), whose tabs are each their own
    // URL: without it, switching to a tab other than the one this row links to would un-highlight
    // the row and make it look as though you had left the section.
    const matchAgainst = item.activePaths ?? [item.path];
    const isActive = matchAgainst.some(
      (path) => location.pathname === path || location.pathname.startsWith(path + '/'),
    );
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
