import React, { useState } from 'react';
import { Sidebar } from './Sidebar';

interface LayoutProps {
  children: React.ReactNode;
  onLogout?: () => void;
  user?: { displayName: string; email: string };
}

export const Layout: React.FC<LayoutProps> = ({ children, onLogout, user }) => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  return (
    <div className="app-container" style={{ '--sidebar-width': sidebarCollapsed ? '64px' : '260px' } as React.CSSProperties}>
      <Sidebar user={user} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(c => !c)} onLogout={onLogout} />
      <main className="main-area">
        {children}
      </main>
    </div>
  );
};
