import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { SystemRole } from '@fapoms/shared';
import { canAccessRoute, defaultRouteFor } from '../config/route-permissions';

interface ProtectedRouteProps {
  children: React.ReactNode;
  userRoles?: SystemRole[];
  userPermissions?: string[];
  isLoading?: boolean;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  userRoles,
  userPermissions,
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

  const roles = userRoles ?? [];
  const permissions = userPermissions ?? [];

  /**
   * A person with no roles at all can still hold permissions, so this can no longer short-circuit
   * on an empty role list the way it did — that was the branch that sent a workforce clerk on a
   * database-defined role to a dashboard they had no right to and no way to load.
   */
  if (canAccessRoute(roles, permissions, location.pathname)) {
    return <>{children}</>;
  }

  /**
   * Refused. Send them somewhere they can work rather than to a fixed page.
   *
   * `/dashboard` used to be that fixed page, which is how the incident behind all this looked
   * from the outside: every route said no, the redirect said dashboard, and the dashboard's own
   * API said no as well. `defaultRouteFor` answers with a page this person can genuinely open,
   * and the equality check below is what stops a redirect loop if that answer is the page we are
   * already standing on.
   */
  const landing = defaultRouteFor(roles, permissions);
  if (landing !== location.pathname) {
    return <Navigate to={landing} replace />;
  }

  /**
   * The terminal case, and today an unreachable one: `defaultRouteFor` only ever answers with a
   * page this person can open, and the notification inbox is open to every signed-in principal,
   * so the redirect above always fires. It stays because the day somebody closes that last door
   * this is the difference between a sentence on screen and a redirect loop the browser hangs on.
   */
  return (
    <div style={{ maxWidth: 520, margin: '18vh auto', padding: '0 24px', textAlign: 'center', color: 'var(--text-secondary)' }}>
      <h2 style={{ margin: '0 0 10px', fontSize: 19, color: 'var(--text-primary)' }}>
        Nothing has been shared with you yet
      </h2>
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
        Your account is active, but it has not been given access to any part of the system.
        Ask an administrator to add the areas you need to your role.
      </p>
    </div>
  );
};
