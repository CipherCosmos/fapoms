import React from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { useLocation } from 'react-router-dom';

interface LayoutProps {
  children: React.ReactNode;
  onLogout?: () => void;
  user?: { displayName: string; email: string };
}

export const Layout: React.FC<LayoutProps> = ({ children, onLogout, user }) => {
  const location = useLocation();

  // Get human readable title from route path
  const getRouteTitle = (path: string): string => {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return 'Dashboard';
    const mainPart = parts[0];
    
    // Capitalize and replace hyphens with spaces
    const title = mainPart.charAt(0).toUpperCase() + mainPart.slice(1).replace(/-/g, ' ');
    
    if (parts.length > 1) {
      return `${title} Details`;
    }
    return title;
  };

  return (
    <div className="app-container">
      {/* Sidebar Navigation */}
      <Sidebar user={user} />

      {/* Global Header */}
      <Header onLogout={onLogout} title={getRouteTitle(location.pathname)} />

      {/* Main Workspace Area */}
      <main className="main-area">
        {children}
      </main>
    </div>
  );
};
