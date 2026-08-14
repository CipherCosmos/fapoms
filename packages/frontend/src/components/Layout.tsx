import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Map, CalendarDays, ClipboardList } from 'lucide-react';
import { SystemRole } from '@fapoms/shared';
import { Sidebar } from './Sidebar';
import { SearchOverlay } from './SearchOverlay';
import { Header } from './Header';
import { MenuToggle } from './ui/MenuToggle';
import { RuleBypassBanner } from './RuleBypassBanner';
import { useSocketInvalidation } from '../hooks/useSocketInvalidation';

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
          <NavLink to="/dashboard" className={({ isActive }) => `mobile-nav-item ${isActive ? 'active' : ''}`}>
            <LayoutDashboard size={18} />
            <span>Overview</span>
          </NavLink>
          <NavLink to="/planning" className={({ isActive }) => `mobile-nav-item ${isActive ? 'active' : ''}`}>
            <Map size={18} />
            <span>Planning</span>
          </NavLink>
          <NavLink to="/scheduling" className={({ isActive }) => `mobile-nav-item ${isActive ? 'active' : ''}`}>
            <CalendarDays size={18} />
            <span>Schedule</span>
          </NavLink>
          <NavLink to="/assignments" className={({ isActive }) => `mobile-nav-item ${isActive ? 'active' : ''}`}>
            <ClipboardList size={18} />
            <span>Execution</span>
          </NavLink>
          <MenuToggle onClick={() => setMobileDrawerOpen(true)} label="Menu" className="mobile-nav-item" style={{ flex: 1 }} />
        </nav>
      </div>
      <SearchOverlay />
    </div>
  );
};
