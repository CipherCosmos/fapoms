import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Map, CalendarDays, ClipboardList } from 'lucide-react';
import { SystemRole } from '@fapoms/shared';
import { canAccessRoute } from '../config/route-permissions';
import { permissionKeysFrom } from '../hooks/useCurrentRoles';
import { Sidebar } from './Sidebar';
import { SearchOverlay } from './SearchOverlay';
import { Header } from './Header';
import { MenuToggle } from './ui/MenuToggle';
import { RuleBypassBanner } from './RuleBypassBanner';
import { useSocketInvalidation } from '../hooks/useSocketInvalidation';

const MOBILE_NAV: { path: string; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { path: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { path: '/planning', label: 'Planning', icon: Map },
  { path: '/scheduling', label: 'Schedule', icon: CalendarDays },
  { path: '/assignments', label: 'Execution', icon: ClipboardList },
];

interface LayoutProps {
  children: React.ReactNode;
  onLogout?: () => void;
  user?: { displayName: string; email: string; roles?: { name: SystemRole }[] };
}

export const Layout: React.FC<LayoutProps> = ({ children, onLogout, user }) => {
  /**
   * Live updates for every screen, mounted once here rather than per page.
   *
   * It used to be called from five page components, which meant a screen nobody remembered to
   * add it to simply never received a socket event — and the Operations Inbox, the negotiation
   * queue itself, was one of them. Worse than a slow refresh: its poll is disabled while the
   * socket is up (`refetchInterval: live ? false : 60_000`), so with nothing subscribed the
   * counter-offer lane did not update at all until the operator reloaded the page.
   *
   * The Layout wraps every authenticated route, so mounting it here makes "is this screen live?"
   * stop being a per-screen decision that can be forgotten.
   */
  useSocketInvalidation();

  /**
   * The phone bar is the sidebar's equivalent on a narrow screen, so it is filtered the same way.
   *
   * These four were hard-coded and shown to everyone. On a desktop the bar is hidden by CSS so
   * nobody noticed, but on a phone a workforce clerk was offered planning, scheduling and field
   * work — four links that bounce straight back to where they started. The sidebar has consulted
   * `canAccessRoute` for a long time; this had simply never been brought along.
   */
  const mobileNavItems = MOBILE_NAV.filter(
    (item) => canAccessRoute(
      (user?.roles ?? []).map((r) => r.name),
      permissionKeysFrom(user),
      item.path,
    ),
  );

  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  const toggleSidebar = () => {
    if (window.matchMedia('(max-width: 1024px)').matches) {
      setMobileDrawerOpen((o) => !o);
    } else {
      setSidebarCollapsed((c) => !c);
    }
  };

  return (
    <div className="app-container" style={{ '--sidebar-width': sidebarCollapsed ? '64px' : '260px' } as React.CSSProperties}>
      {/* Mobile Backdrop */}
      {mobileDrawerOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setMobileDrawerOpen(false)}
        />
      )}

      <div className={`sidebar-area ${mobileDrawerOpen ? 'mobile-open' : ''}`}>
        <Sidebar
          user={user}
          collapsed={sidebarCollapsed && !mobileDrawerOpen}
        />
      </div>

      <div className="main-area" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
        {/* Above the header, and outside the scrolling content, so a suspended control is the
            first thing on every screen and cannot be scrolled away from. */}
        <RuleBypassBanner />
        <Header
          user={user}
          onLogout={onLogout}
          onToggleSidebar={toggleSidebar}
        />
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px', paddingBottom: '70px' }}>
          {children}
        </div>

        {/* Mobile Bottom Navigation Bar */}
        <nav className="mobile-bottom-nav">
          {mobileNavItems.map(({ path, label, icon: Icon }) => (
            <NavLink key={path} to={path} className={({ isActive }) => `mobile-nav-item ${isActive ? 'active' : ''}`}>
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
          <MenuToggle onClick={() => setMobileDrawerOpen(true)} label="Menu" className="mobile-nav-item" style={{ flex: 1 }} />
        </nav>
      </div>
      <SearchOverlay />
    </div>
  );
};
