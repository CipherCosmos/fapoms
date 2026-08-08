import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { SystemRole } from '@fapoms/shared';
import { Login } from './pages/Login';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Dashboard } from './pages/Dashboard';
import { ExecutiveMap } from './pages/ExecutiveMap';
import { Projects } from './pages/Projects';
import { Branches } from './pages/Branches';
import { PlanningWorkspace } from './pages/PlanningWorkspace';
import { Assignments } from './pages/Assignments';
import { Scheduling } from './pages/Scheduling';
import { Documents } from './pages/Documents';
import { Users } from './pages/Users';
import { AssayerProfile } from './pages/AssayerProfile';
import { Clients } from './pages/Clients';
import { Billing } from './pages/Billing';
import { LedgerPage } from './pages/billing/LedgerPage';
import { ClientBillingSettingsPage } from './pages/billing/ClientBillingSettingsPage';
import { AssayerStatementPage } from './pages/billing/AssayerStatementPage';
import { Rules } from './pages/Rules';
import { Notifications } from './pages/Notifications';
import { Holidays } from './pages/Holidays';
import Settings from './pages/Settings';
import { api } from './services/api';
import { HrLayout } from './pages/hr/HrLayout';
import { HrOverviewPage } from './pages/hr/HrOverviewPage';
import { HrRosterPage } from './pages/hr/HrRosterPage';
import { HrOnboardingPage } from './pages/hr/HrOnboardingPage';
import { HrRecordsPage } from './pages/hr/HrRecordsPage';
import { HrCompliancePage } from './pages/hr/HrCompliancePage';
import { HrCapabilityPage } from './pages/hr/HrCapabilityPage';
import { HrDocumentsPage } from './pages/hr/HrDocumentsPage';
import { HrPayPage } from './pages/hr/HrPayPage';
import { HrDeploymentPage } from './pages/hr/HrDeploymentPage';
import { HrUtilisationPage } from './pages/hr/HrUtilisationPage';
import { HrActivityPage } from './pages/hr/HrActivityPage';
import DataEntryDesk from './pages/dataentry/DataEntryDesk';
import ForcePasswordChange from './pages/ForcePasswordChange';

interface UserProfile {
  displayName: string;
  email: string;
  username: string;
  roles: { name: SystemRole }[];
  /** Set while the account still holds a password issued by someone else. */
  mustChangePassword?: boolean;
}

export const App: React.FC = () => {
  const [token, setToken] = useState<string | null>(localStorage.getItem('fapoms_token'));
  
  const getCachedUser = (): UserProfile | null => {
    try {
      const cached = localStorage.getItem('fapoms_user_cache');
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  };

  const [currentUser, setCurrentUser] = useState<UserProfile | null>(getCachedUser);
  const [isLoadingUser, setIsLoadingUser] = useState<boolean>(Boolean(token) && !currentUser);
  const navigate = useNavigate();

  useEffect(() => {
    if (token) {
      setIsLoadingUser(true);
      api.request<UserProfile>('/users/me', { method: 'GET' })
        .then((user) => {
          setCurrentUser(user);
          try {
            localStorage.setItem('fapoms_user_cache', JSON.stringify(user));
          } catch {}
        })
        .catch((err) => {
          console.warn('[App] User session validation failed:', err);
          handleLogout();
        })
        .finally(() => {
          setIsLoadingUser(false);
        });
    } else {
      setIsLoadingUser(false);
    }
  }, [token]);

  const userRoles = currentUser?.roles?.map((r) => r.name) ?? [];

  const handleLoginSuccess = (jwtToken: string, refreshToken: string) => {
    localStorage.setItem('fapoms_token', jwtToken);
    localStorage.setItem('fapoms_refresh_token', refreshToken);
    setToken(jwtToken);
    navigate('/dashboard');
  };

  const handleLogout = () => {
    localStorage.removeItem('fapoms_token');
    localStorage.removeItem('fapoms_refresh_token');
    localStorage.removeItem('fapoms_user_cache');
    setToken(null);
    setCurrentUser(null);
    navigate('/login');
  };

  if (!token) {
    return (
      <Routes>
        <Route path="/login" element={<Login onLoginSuccess={handleLoginSuccess} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  /**
   * An account still on an issued password sees only the change-password form.
   *
   * After the token check because changing a password needs a session, and before the
   * application because operational work should not happen under a credential that was handed
   * out rather than chosen. Waits for the profile to load so a slow /users/me does not flash
   * this screen at someone who does not need it.
   */
  if (!isLoadingUser && currentUser?.mustChangePassword) {
    return (
      <ForcePasswordChange
        onChanged={() => {
          setCurrentUser((prev) => (prev ? { ...prev, mustChangePassword: false } : prev));
          try {
            const cached = getCachedUser();
            if (cached) localStorage.setItem('fapoms_user_cache', JSON.stringify({ ...cached, mustChangePassword: false }));
          } catch {}
        }}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <Layout onLogout={handleLogout} user={currentUser || undefined}>
      <Routes>
        <Route path="/dashboard" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Dashboard /></ProtectedRoute>} />
        <Route path="/executive-map" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><ExecutiveMap /></ProtectedRoute>} />
        <Route path="/projects" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Projects /></ProtectedRoute>} />
        <Route path="/branches" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Branches /></ProtectedRoute>} />
        <Route path="/planning" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><PlanningWorkspace /></ProtectedRoute>} />
        <Route path="/assignments" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Assignments /></ProtectedRoute>} />
        <Route path="/scheduling" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Scheduling /></ProtectedRoute>} />
        <Route path="/documents" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Documents /></ProtectedRoute>} />
        <Route path="/data-entry" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><DataEntryDesk /></ProtectedRoute>} />
        {/* Validation is now part of the merged data-entry board. */}
        <Route path="/validation" element={<Navigate to="/data-entry" replace />} />
        <Route path="/users" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Users /></ProtectedRoute>} />
        {/* HR is a section, not a page: each concern has its own URL under the shared shell. */}
        <Route path="/hr" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><HrLayout /></ProtectedRoute>}>
          <Route index element={<HrOverviewPage />} />
          <Route path="roster" element={<HrRosterPage />} />
          <Route path="onboarding" element={<HrOnboardingPage />} />
          <Route path="records" element={<HrRecordsPage />} />
          <Route path="compliance" element={<HrCompliancePage />} />
          <Route path="capability" element={<HrCapabilityPage />} />
          <Route path="documents" element={<HrDocumentsPage />} />
          <Route path="pay" element={<HrPayPage />} />
          <Route path="deployment" element={<HrDeploymentPage />} />
          <Route path="utilisation" element={<HrUtilisationPage />} />
          <Route path="activity" element={<HrActivityPage />} />
        </Route>
        {/* The roster now lives inside the workforce console; keep the old path working. */}
        <Route path="/assayers" element={<Navigate to="/hr/roster" replace />} />
        <Route path="/assayers/:id" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><AssayerProfile /></ProtectedRoute>} />
        <Route path="/clients" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Clients /></ProtectedRoute>} />
        <Route path="/billing" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Billing /></ProtectedRoute>} />
        <Route path="/billing/ledger" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><LedgerPage /></ProtectedRoute>} />
        <Route path="/billing/settings" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><ClientBillingSettingsPage /></ProtectedRoute>} />
        <Route path="/billing/statement" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><AssayerStatementPage /></ProtectedRoute>} />
        <Route path="/rules" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Rules /></ProtectedRoute>} />
        <Route path="/holidays" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Holidays /></ProtectedRoute>} />
        <Route path="/notifications" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Notifications /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Settings /></ProtectedRoute>} />
        
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  );
};

export default App;
