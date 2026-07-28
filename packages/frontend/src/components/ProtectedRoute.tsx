import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { SystemRole } from '@fapoms/shared';
import { canAccessRoute } from '../config/route-permissions';

interface ProtectedRouteProps {
  children: React.ReactNode;
  userRoles?: SystemRole[];
  isLoading?: boolean;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  userRoles,
  isLoading,
}) => {
  const location = useLocation();

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--text-muted)' }}>
        Loading session...
      </div>
    );
  }

  if (!userRoles || userRoles.length === 0) {
    if (location.pathname === '/dashboard') {
      return <>{children}</>;
    }
    return <Navigate to="/dashboard" replace />;
  }

  if (!canAccessRoute(userRoles, location.pathname)) {
    if (location.pathname !== '/dashboard') {
      return <Navigate to="/dashboard" replace />;
    }
  }

  return <>{children}</>;
};
