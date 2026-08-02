import React, { useState } from 'react';
import { SystemRole } from '@fapoms/shared';
import { Sidebar } from './Sidebar';
import { SearchOverlay } from './SearchOverlay';
import { Header } from './Header';

interface LayoutProps {
  children: React.ReactNode;
  onLogout?: () => void;
  // Must carry roles: Sidebar filters its menu on them, and a type that omits
  // the field silently reduces every non-admin to an empty menu the moment
  // anything constructs this object rather than passing the fetched user straight
  // through.
  user?: { displayName: string; email: string; roles?: { name: SystemRole }[] };
}

export const Layout: React.FC<LayoutProps> = ({ children, onLogout, user }) => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  return (
    <div className="app-container" style={{ '--sidebar-width': sidebarCollapsed ? '64px' : '260px' } as React.CSSProperties}>
      <Sidebar user={user} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(c => !c)} onLogout={onLogout} />
      <div className="main-area" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
        <Header onLogout={onLogout} />
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
          {children}
        </div>
      </div>
      <SearchOverlay />
    </div>
  );
};
