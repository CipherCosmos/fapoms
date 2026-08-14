import React, { useState, useEffect, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { defaultRouteForRoles } from './config/route-permissions';
import { SystemRole } from '@fapoms/shared';
import { Login } from './pages/Login';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { api } from './services/api';
import { clearSession } from './services/session';
import ForcePasswordChange from './pages/ForcePasswordChange';
import { CallProvider } from './components/calls/CallProvider';

/**
 * Route pages are code-split so the initial bundle carries only the login/shell critical path.
 *
 * Each page becomes its own chunk that Rollup loads on demand when its route is first visited,
 * keeping heavy views (PlanningWorkspace, billing, HR, the pdf.js-backed data-entry desk) out of
 * the entry bundle. Pages that already have a default export are imported directly; the rest are
 * named exports, so the promise is mapped to `{ default }` for React.lazy.
 */
const Dashboard = React.lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const ExecutiveMap = React.lazy(() => import('./pages/ExecutiveMap').then((m) => ({ default: m.ExecutiveMap })));
const Projects = React.lazy(() => import('./pages/Projects').then((m) => ({ default: m.Projects })));
const Branches = React.lazy(() => import('./pages/Branches').then((m) => ({ default: m.Branches })));
const PlanningWorkspace = React.lazy(() => import('./pages/PlanningWorkspace').then((m) => ({ default: m.PlanningWorkspace })));
const Assignments = React.lazy(() => import('./pages/Assignments').then((m) => ({ default: m.Assignments })));
const Scheduling = React.lazy(() => import('./pages/Scheduling').then((m) => ({ default: m.Scheduling })));
const Documents = React.lazy(() => import('./pages/Documents').then((m) => ({ default: m.Documents })));
const Users = React.lazy(() => import('./pages/Users'));
const Clients = React.lazy(() => import('./pages/Clients').then((m) => ({ default: m.Clients })));
const Billing = React.lazy(() => import('./pages/Billing').then((m) => ({ default: m.Billing })));
const LedgerPage = React.lazy(() => import('./pages/billing/LedgerPage').then((m) => ({ default: m.LedgerPage })));
const ClientBillingSettingsPage = React.lazy(() => import('./pages/billing/ClientBillingSettingsPage').then((m) => ({ default: m.ClientBillingSettingsPage })));
const AssayerStatementPage = React.lazy(() => import('./pages/billing/AssayerStatementPage').then((m) => ({ default: m.AssayerStatementPage })));
const Rules = React.lazy(() => import('./pages/Rules'));
const Notifications = React.lazy(() => import('./pages/Notifications'));
const FeedbackPage = React.lazy(() => import('./pages/feedback/FeedbackPage').then((m) => ({ default: m.FeedbackPage })));
const Holidays = React.lazy(() => import('./pages/Holidays'));
const TransportCosts = React.lazy(() => import('./pages/TransportCosts'));
const NotificationAdmin = React.lazy(() => import('./pages/admin/NotificationAdmin'));
const PlatformSettings = React.lazy(() => import('./pages/admin/PlatformSettings'));
const Zones = React.lazy(() => import('./pages/Zones'));
const OperationsInbox = React.lazy(() => import('./pages/OperationsInbox').then((m) => ({ default: m.OperationsInbox })));
const Settings = React.lazy(() => import('./pages/Settings'));
const RuleBypassPanel = React.lazy(() => import('./pages/admin/RuleBypassPanel').then((m) => ({ default: m.RuleBypassPanel })));
const HrLayout = React.lazy(() => import('./pages/hr/HrLayout').then((m) => ({ default: m.HrLayout })));
const HrOverviewPage = React.lazy(() => import('./pages/hr/HrOverviewPage').then((m) => ({ default: m.HrOverviewPage })));
const HrRosterPage = React.lazy(() => import('./pages/hr/HrRosterPage').then((m) => ({ default: m.HrRosterPage })));
const HrOnboardingPage = React.lazy(() => import('./pages/hr/HrOnboardingPage').then((m) => ({ default: m.HrOnboardingPage })));
const HrRecordsPage = React.lazy(() => import('./pages/hr/HrRecordsPage').then((m) => ({ default: m.HrRecordsPage })));
const HrCompliancePage = React.lazy(() => import('./pages/hr/HrCompliancePage').then((m) => ({ default: m.HrCompliancePage })));
const HrCapabilityPage = React.lazy(() => import('./pages/hr/HrCapabilityPage').then((m) => ({ default: m.HrCapabilityPage })));
const HrDocumentsPage = React.lazy(() => import('./pages/hr/HrDocumentsPage').then((m) => ({ default: m.HrDocumentsPage })));
const HrPayPage = React.lazy(() => import('./pages/hr/HrPayPage').then((m) => ({ default: m.HrPayPage })));
const HrDeploymentPage = React.lazy(() => import('./pages/hr/HrDeploymentPage').then((m) => ({ default: m.HrDeploymentPage })));
const HrUtilisationPage = React.lazy(() => import('./pages/hr/HrUtilisationPage').then((m) => ({ default: m.HrUtilisationPage })));
const HrActivityPage = React.lazy(() => import('./pages/hr/HrActivityPage').then((m) => ({ default: m.HrActivityPage })));
const DataEntryOverview = React.lazy(() => import('./pages/dataentry/DataEntryOverview'));
const PacketsQueue = React.lazy(() => import('./pages/dataentry/PacketsQueue'));
const ReviewsQueue = React.lazy(() => import('./pages/dataentry/ReviewsQueue'));
const DataEntryCasePage = React.lazy(() => import('./pages/dataentry/CasePage'));
const DataEntryLayout = React.lazy(() => import('./pages/dataentry/DataEntryLayout').then((m) => ({ default: m.DataEntryLayout })));
const ClarificationsPage = React.lazy(() => import('./pages/dataentry/ClarificationsPage').then((m) => ({ default: m.ClarificationsPage })));

/** Lightweight fallback shown while a route chunk is fetched. Mirrors ProtectedRoute's loader. */
const RouteFallback: React.FC = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '60vh',
      color: 'var(--text-muted)',
    }}
  >
    Loading…
  </div>
);

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
    // Belt and braces: a sign-in that follows a crash, a back-button return, or any path that
    // skipped handleLogout must not start on top of someone else's cached data or scope.
    clearSession();
    localStorage.setItem('fapoms_token', jwtToken);
    localStorage.setItem('fapoms_refresh_token', refreshToken);
    setToken(jwtToken);
    // Land on the role's home rather than a fixed page — the '/' route resolves it once the
    // profile (and therefore the roles) has loaded.
    navigate('/');
  };

  const handleLogout = () => {
    // Clears storage *and* the React Query cache — this navigates rather than reloading, so
    // without the cache clear the next person to sign in on this machine is served the
    // previous user's branches, assignments and dashboard.
    clearSession();
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
    <CallProvider>
    <Layout onLogout={handleLogout} user={currentUser || undefined}>
      <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* Root sends each role to the first screen of their actual work. Wait for the profile
            so an admin is not flashed the auditor's default before roles resolve. */}
        <Route
          path="/"
          element={
            isLoadingUser && userRoles.length === 0
              ? <RouteFallback />
              : <Navigate to={defaultRouteForRoles(userRoles)} replace />
          }
        />
        <Route path="/dashboard" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Dashboard /></ProtectedRoute>} />
        <Route path="/executive-map" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><ExecutiveMap /></ProtectedRoute>} />
        <Route path="/projects" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Projects /></ProtectedRoute>} />
        <Route path="/branches" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Branches /></ProtectedRoute>} />
        <Route path="/planning" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><PlanningWorkspace /></ProtectedRoute>} />
        <Route path="/assignments" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Assignments /></ProtectedRoute>} />
        <Route path="/scheduling" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Scheduling /></ProtectedRoute>} />
        <Route path="/documents" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Documents /></ProtectedRoute>} />
        <Route path="/data-entry" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><DataEntryLayout /></ProtectedRoute>}>
          <Route index element={<DataEntryOverview />} />
          <Route path="packets" element={<PacketsQueue />} />
          <Route path="reviews" element={<ReviewsQueue />} />
          <Route path="case/:branchId" element={<DataEntryCasePage />} />
          <Route path="clarifications" element={<ClarificationsPage />} />
        </Route>
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
        <Route path="/clients" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Clients /></ProtectedRoute>} />
        <Route path="/billing" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Billing /></ProtectedRoute>} />
        <Route path="/billing/ledger" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><LedgerPage /></ProtectedRoute>} />
        <Route path="/billing/settings" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><ClientBillingSettingsPage /></ProtectedRoute>} />
        <Route path="/billing/statement" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><AssayerStatementPage /></ProtectedRoute>} />
        <Route path="/admin/rule-bypass" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><RuleBypassPanel /></ProtectedRoute>} />
        <Route path="/rules" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Rules /></ProtectedRoute>} />
        <Route path="/holidays" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Holidays /></ProtectedRoute>} />
        <Route path="/transport-costs" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><TransportCosts /></ProtectedRoute>} />
        <Route path="/admin/notifications" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><NotificationAdmin /></ProtectedRoute>} />
        <Route path="/admin/settings" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><PlatformSettings /></ProtectedRoute>} />
        <Route path="/zones" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Zones /></ProtectedRoute>} />
        <Route path="/inbox" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><OperationsInbox /></ProtectedRoute>} />
        <Route path="/notifications" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Notifications /></ProtectedRoute>} />
        <Route path="/feedback" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><FeedbackPage /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Settings /></ProtectedRoute>} />
        
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </Layout>
    </CallProvider>
  );
};

export default App;
