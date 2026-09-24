import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { SystemRole } from '@fapoms/shared';
import {
  ShieldOff,
  ShieldAlert,
  ShieldCheck,
  LayoutDashboard,
  FolderKanban,
  GitMerge,
  Map,
  CalendarDays,
  Files,

  ClipboardList,
  Users,
  Building2,
  Receipt,
  UserCog, Inbox, MessageSquare, BellRing, SlidersHorizontal,
  ScrollText, AlertTriangle } from 'lucide-react';
import { GlobalSearch } from './GlobalSearch';
import { canAccessRoute } from '../config/route-permissions';
import { permissionKeysFrom } from '../hooks/useCurrentRoles';
import { WORK_TABS } from '../pages/work/workTabs';
import { useApprovalCount } from '../pages/hr/approvals/approval-queue';
import { BrandLogo } from './BrandLogo';

interface SidebarProps {
  user?: { displayName: string; email: string; roles?: { name: SystemRole }[] };
  collapsed: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({ user, collapsed }) => {
  const location = useLocation();
  const userRoles = (user?.roles ?? []).map((r) => r.name);
  /**
   * Derived from the same object the roles come from rather than re-read from the cache, so the
   * navigation can never disagree with the gate that decides what happens when you click it.
   */
  const userPermissions = permissionKeysFrom(user);

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
  const auditWorkTabs = WORK_TABS.filter((tab) => canAccessRoute(userRoles, userPermissions, tab.path));
  /*
    Joiners waiting for THIS reader's approval before training. It sits on the Workforce row rather
    than a row of its own: the HR section's pages were taken out of the sidebar on purpose (several
    rows for one subject, two of them lighting up at once — see the note on the recruitment routes
    in App.tsx), and the Approvals tab inside Workforce carries the same number from the same query.
  */
  const approvalsWaiting = useApprovalCount();

  const allMenuGroups: { category: string; items: { name: string; path: string; icon: React.ComponentType<any>; activePaths?: readonly string[]; tooltip: string; badge?: number | null }[] }[] = [
    {
      category: 'Overview',
      items: [
        {
          name: 'Dashboard',
          path: '/dashboard',
          icon: LayoutDashboard,
          tooltip: 'Operational metrics, audit health, and real-time execution KPI summaries',
        },
        {
          name: 'Coverage map',
          path: '/executive-map',
          icon: Map,
          tooltip: 'Geographic visualization of client coverage, branch audits, and field density',
        },
      ],
    },
    {
      category: 'Commercial & Clients',
      items: [
        {
          name: 'Clients',
          path: '/clients',
          icon: Building2,
          tooltip: 'Client directory, commercial contracts, billing configurations, and agreements',
        },
        {
          name: 'Branches',
          path: '/branches',
          icon: GitMerge,
          tooltip: 'Master branch directory with IFSC codes, geographic coordinates, and coverage',
        },
      ],
    },
    {
      category: 'Field Operations',
      items: [
        {
          name: 'Projects',
          path: '/projects',
          icon: FolderKanban,
          tooltip: 'Audit engagements, branch allotments, scope tracking, and progress lifecycle',
        },
        ...(auditWorkTabs.length > 0
          ? [{
              name: 'Audit Work',
              path: auditWorkTabs[0].path as string,
              icon: ClipboardList,
              activePaths: WORK_TABS.map((tab) => tab.path),
              tooltip: 'Single dispatch desk: today’s actions, assayer planning, calendar scheduling, and field execution',
            }]
          : []),
        {
          name: 'Overdue Tracking',
          path: '/falling-behind',
          icon: AlertTriangle,
          tooltip: 'Track overdue visits, stalled branches, unassigned audits, and SLA breaches',
        },
      ],
    },
    {
      category: 'Document & Data Desk',
      items: [
        {
          name: 'Documents',
          path: '/documents',
          icon: Files,
          tooltip: 'Audit photo evidence, verification packets, signed delivery notes, and documents',
        },
        {
          name: 'Audit Data Entry',
          path: '/data-entry',
          icon: Inbox,
          tooltip: 'Desk QA review, branch audit findings entry, discrepancy logs, and validation packets',
        },
      ],
    },
    {
      category: 'Workforce & HR',
      items: [
        {
          name: 'Workforce',
          path: '/hr',
          icon: UserCog,
          activePaths: ['/hr', '/hr/roster', '/hr/pay', '/hr/where', '/hr/issues', '/hr/interviews', '/hr/applications', '/hr/onboarding'],
          tooltip: approvalsWaiting
            ? `${approvalsWaiting} ${approvalsWaiting === 1 ? 'joiner is' : 'joiners are'} waiting for your approval — open Workforce, then Approvals`
            : 'Assayer roster, onboarding, recruitment pipeline, live attendance, and payout ledger',
          badge: approvalsWaiting,
        },
      ],
    },
    {
      category: 'Finance & Billing',
      items: [
        {
          name: 'Billing',
          path: '/billing',
          icon: Receipt,
          tooltip: 'Client invoicing, assayer payouts, expense claims, and GST/TDS tax deductions',
        },
      ],
    },
    {
      category: 'Operational Setup',
      items: [
        {
          name: 'Service Areas',
          path: '/zones',
          icon: Map,
          tooltip: 'Pincode operational zones, regional boundaries, and travel radius settings',
        },
        {
          name: 'Holiday Calendar',
          path: '/holidays',
          icon: CalendarDays,
          tooltip: 'Indian bank holidays, 2nd & 4th Saturdays, and gazetted non-audit dates',
        },
        {
          name: 'Platform Settings',
          path: '/admin/settings',
          icon: SlidersHorizontal,
          tooltip: 'System settings, rate cards, timeout rules, and operational parameters',
        },
        {
          name: 'Service Logs',
          path: '/admin/logs',
          icon: ScrollText,
          tooltip: 'System activity logs, background worker status, and audit trail events',
        },
      ],
    },
    {
      category: 'Administration & Governance',
      items: [
        {
          name: 'User Management',
          path: '/users',
          icon: Users,
          tooltip: 'Internal user accounts, roles, access permissions, and account status',
        },
        {
          name: 'Notification Rules',
          path: '/admin/notifications',
          icon: BellRing,
          tooltip: 'Dispatch notifications, SLA breach alerts, and escalation triggers',
        },
        {
          /*
            Named for what it is. It was "Approvals", described as "pending management approvals, fee
            overrides, and exception sign-offs" — none of which it holds. It is the second admin's
            half of a developer's data-wipe request, and with joiner approvals now a list of their
            own (Workforce → Approvals), an approver looking for them would have landed here.
          */
          name: 'Data-wipe requests',
          path: '/admin/approvals',
          icon: ShieldCheck,
          tooltip: 'A developer\'s request to wipe data, waiting for a second admin to approve or reject it',
        },
        {
          name: 'Security & Compliance',
          path: '/admin/compliance',
          icon: ShieldAlert,
          tooltip: 'Compliance policies, system health checks, and data protection audits',
        },
        {
          name: 'Paused rules',
          path: '/admin/rule-bypass',
          icon: ShieldOff,
          tooltip: 'Temporary rule exemptions, emergency overrides, and bypassed constraints',
        },
        {
          name: 'Support',
          path: '/feedback',
          icon: MessageSquare,
          tooltip: 'Operator support tickets, platform bug reports, and feature feedback',
        },
      ],
    },
  ];

  const menuGroups = allMenuGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canAccessRoute(userRoles, userPermissions, item.path)),
    }))
    .filter((group) => group.items.length > 0);

  const renderNavLink = (item: {
    name: string; path: string; icon: React.ComponentType<any>; activePaths?: readonly string[]; tooltip: string;
    /** Something waiting on this reader there. Shown only when it is a positive number. */
    badge?: number | null;
  }) => {
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
        title={`${item.name} — ${item.tooltip}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          gap: collapsed ? 0 : 'var(--space-3, 12px)',
          padding: collapsed ? 'var(--space-2-5, 10px)' : 'var(--space-2, 8px) var(--space-3-5, 14px)',
          borderRadius: 'var(--radius-md, 10px)',
          color: isActive ? 'var(--accent-primary)' : 'var(--text-secondary)',
          background: isActive ? 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' : 'transparent',
          borderLeft: !collapsed && isActive ? '3px solid var(--accent-primary)' : collapsed ? 'none' : '3px solid transparent',
          textDecoration: 'none',
          fontSize: 'var(--text-sm, 13px)',
          fontWeight: isActive ? 600 : 500,
          transition: 'all var(--transition-fast)',
          position: 'relative',
        }}
      >
        <Icon size={18} style={{ minWidth: '18px', flexShrink: 0 }} />
        {!collapsed && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</span>}
        {!!item.badge && item.badge > 0 && (
          <span
            data-testid={`sidebar-badge-${item.path}`}
            aria-label={`${item.badge} waiting for you`}
            style={collapsed
              // Collapsed, there is no room beside the name: a number on the icon's corner.
              ? {
                position: 'absolute', top: '2px', right: '2px', minWidth: '16px', height: '16px', padding: '0 4px',
                borderRadius: '8px', fontSize: 'var(--text-3xs)', fontWeight: 700, lineHeight: '16px', textAlign: 'center',
                background: 'var(--danger)', color: '#fff', boxSizing: 'border-box',
              }
              : {
                marginLeft: 'auto', fontSize: 'var(--text-xs)', fontWeight: 700, padding: '1px 7px', borderRadius: '9px',
                background: 'var(--status-cancelled-bg)', color: 'var(--danger)', flexShrink: 0,
              }}
          >
            {item.badge}
          </span>
        )}
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
              <div style={{ padding: '4px 16px 6px', fontSize: 'var(--text-3xs)', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>
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
