import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Map, CalendarDays, ClipboardList, Menu } from 'lucide-react';
import { SystemRole } from '@fapoms/shared';
import { Sidebar } from './Sidebar';
import { SearchOverlay } from './SearchOverlay';
import { Header } from './Header';

interface LayoutProps {
  children: React.ReactNode;
  onLogout?: () => void;
  user?: { displayName: string; email: string; roles?: { name: SystemRole }[] };
}

export const Layout: React.FC<LayoutProps> = ({ children, onLogout, user }) => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

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
          onToggle={() => setSidebarCollapsed((c) => !c)}
          onLogout={onLogout}
        />
      </div>

      <div className="main-area" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
        <Header
          onLogout={onLogout}
          onToggleSidebar={() => setMobileDrawerOpen((o) => !o)}
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
          <button onClick={() => setMobileDrawerOpen(true)} className="mobile-nav-item" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
            <Menu size={18} />
            <span>Menu</span>
          </button>
        </nav>
      </div>
      <SearchOverlay />
    </div>
  );
};
