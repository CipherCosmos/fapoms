import React, { useState, useEffect, Suspense } from 'react';
import { Routes, Route, Navigate, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { defaultRouteForRoles } from './config/route-permissions';
import { SystemRole } from '@fapoms/shared';
import { Login } from './pages/Login';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ProtectedRoute } from './components/ProtectedRoute';
import { api } from './services/api';
import { clearSession, endSession } from './services/session';
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
/**
 * Audit Work — the merged home of what used to be four sidebar destinations: My Work Today
 * (/inbox), Audit Planning (/planning), Visit Scheduling (/scheduling) and Field Work
 * (/assignments). One container serves all four paths and puts the matching tab in front, so
 * every existing URL, bookmark, notification payload and backend-generated link keeps resolving
 * exactly as it did — and each stage keeps its own path, which is what lets route-permissions.ts
 * go on gating the stages individually. The four page components are code-split inside it.
 * See src/pages/work/workTabs.ts for why they were merged.
 */
const AuditWork = React.lazy(() => import('./pages/work/AuditWork').then((m) => ({ default: m.AuditWork })));
const Documents = React.lazy(() => import('./pages/Documents').then((m) => ({ default: m.Documents })));
const Users = React.lazy(() => import('./pages/Users'));
const Clients = React.lazy(() => import('./pages/Clients').then((m) => ({ default: m.Clients })));
const Billing = React.lazy(() => import('./pages/Billing').then((m) => ({ default: m.Billing })));
const AssayerStatementPage = React.lazy(() => import('./pages/billing/AssayerStatementPage').then((m) => ({ default: m.AssayerStatementPage })));
const Rules = React.lazy(() => import('./pages/Rules'));
const Notifications = React.lazy(() => import('./pages/Notifications'));
const FeedbackPage = React.lazy(() => import('./pages/feedback/FeedbackPage').then((m) => ({ default: m.FeedbackPage })));
const Holidays = React.lazy(() => import('./pages/Holidays'));
const TransportCosts = React.lazy(() => import('./pages/TransportCosts'));
const NotificationAdmin = React.lazy(() => import('./pages/admin/NotificationAdmin'));
const PlatformSettings = React.lazy(() => import('./pages/admin/PlatformSettings'));
const Zones = React.lazy(() => import('./pages/Zones'));
const Settings = React.lazy(() => import('./pages/Settings'));
const RuleBypassPanel = React.lazy(() => import('./pages/admin/RuleBypassPanel').then((m) => ({ default: m.RuleBypassPanel })));
const HrLayout = React.lazy(() => import('./pages/hr/HrLayout').then((m) => ({ default: m.HrLayout })));
const HrOverviewPage = React.lazy(() => import('./pages/hr/HrOverviewPage').then((m) => ({ default: m.HrOverviewPage })));
const HrRosterPage = React.lazy(() => import('./pages/hr/HrRosterPage').then((m) => ({ default: m.HrRosterPage })));
const HrOnboardingPage = React.lazy(() => import('./pages/hr/HrOnboardingPage').then((m) => ({ default: m.HrOnboardingPage })));
const HrCapabilityPage = React.lazy(() => import('./pages/hr/HrCapabilityPage').then((m) => ({ default: m.HrCapabilityPage })));
const HrPayPage = React.lazy(() => import('./pages/hr/HrPayPage').then((m) => ({ default: m.HrPayPage })));
const HrPaperworkPage = React.lazy(() => import('./pages/hr/HrPaperworkPage').then((m) => ({ default: m.HrPaperworkPage })));
const HrWherePeopleArePage = React.lazy(() => import('./pages/hr/HrWherePeopleArePage').then((m) => ({ default: m.HrWherePeopleArePage })));
const DataEntryOverview = React.lazy(() => import('./pages/dataentry/DataEntryOverview'));
const PacketsQueue = React.lazy(() => import('./pages/dataentry/PacketsQueue'));
const ReviewsQueue = React.lazy(() => import('./pages/dataentry/ReviewsQueue'));
const DataEntryCasePage = React.lazy(() => import('./pages/dataentry/CasePage'));
const DataEntryLayout = React.lazy(() => import('./pages/dataentry/DataEntryLayout').then((m) => ({ default: m.DataEntryLayout })));
const ClarificationsPage = React.lazy(() => import('./pages/dataentry/ClarificationsPage').then((m) => ({ default: m.ClarificationsPage })));

/**
 * Where an unauthenticated visitor was trying to go, held until they have signed in.
 *
 * sessionStorage rather than localStorage: it belongs to this tab and this attempt, and must not
 * outlive the browser session or leak between tabs.
 */
const RETURN_TO_KEY = 'fapoms_return_to';

/**
 * Records the requested path, then sends the visitor to sign in.
 *
 * A component rather than an inline `<Navigate>` because the write has to happen as an effect —
 * doing it during render would be a side effect in the render phase.
 */
/**
 * Sends a just-signed-in person to wherever they were originally headed, or to their role's home.
 *
 * The destination is captured once, in a `useState` initialiser, and cleared in an effect — never
 * read-and-cleared inline in the element expression. React StrictMode double-invokes render in
 * development, so an inline consume returned the path on the first pass and `null` on the second,
 * and it was the second result the router actually used. Reading once fixes that, and clearing in
 * an effect keeps the render itself free of side effects.
 */
const PostLoginRedirect: React.FC<{ fallback: string }> = ({ fallback }) => {
  const [returnTo] = useState<string | null>(() => {
    try {
      const target = sessionStorage.getItem(RETURN_TO_KEY);
      return target && target !== '/login' ? target : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    try {
      sessionStorage.removeItem(RETURN_TO_KEY);
    } catch {
      // Non-fatal: the worst case is landing on the role's home page.
    }
  }, []);

  // ProtectedRoute still guards the destination, so a deep link into a section this role may not
  // open is refused exactly as it would be if they had clicked through to it.
  return <Navigate to={returnTo ?? fallback} replace />;
};

const RememberAndRedirectToLogin: React.FC = () => {
  const location = useLocation();
  useEffect(() => {
    try {
      sessionStorage.setItem(RETURN_TO_KEY, `${location.pathname}${location.search}`);
    } catch {
      // Storage unavailable (private mode, quota) — fall back to the role home after sign-in.
    }
  }, [location.pathname, location.search]);
  return <Navigate to="/login" replace />;
};

/**
 * The boundary that wraps the routed screen, reset by the URL.
 *
 * A separate component purely so the `useLocation()` subscription lives here rather than in
 * `App` — subscribing at the top would re-render the entire authenticated tree, Layout included,
 * on every navigation, which is a real cost to pay for a prop that only this boundary reads.
 */
const RouteErrorBoundary: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  return (
    <ErrorBoundary area="This screen" resetKey={location.pathname}>
      {children}
    </ErrorBoundary>
  );
};

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
    // The pending return path lives in sessionStorage, which clearSession does not touch.
    clearSession();
    localStorage.setItem('fapoms_token', jwtToken);
    localStorage.setItem('fapoms_refresh_token', refreshToken);
    /**
     * Mark the profile as loading in the same batch as the token, so the render between
     * "token set" and "/users/me returned" is a loader rather than an authenticated user with no
     * roles — which ProtectedRoute would otherwise bounce to the dashboard.
     */
    setIsLoadingUser(true);
    setToken(jwtToken);
    /**
     * Always land on '/' and let that route decide.
     *
     * Navigating straight to the remembered path from here raced the token state flip: the
     * router moved to /billing while the unauthenticated route table was still mounted, so it
     * matched a catch-all and was bounced before the real /billing route existed. Resolving the
     * destination inside the authenticated tree — once roles are known — removes the race.
     */
    navigate('/');
  };

  const handleLogout = () => {
    // Revokes the refresh token server-side *and* clears storage and the React Query cache.
    // The revoke matters on shared machines: without it "Sign Out" only forgot the tokens here
    // while they stayed valid on the server. The cache clear matters because this navigates
    // rather than reloading, so otherwise the next person to sign in on this machine is served
    // the previous user's branches, assignments and dashboard.
    //
    // Local state is torn down immediately rather than awaiting the revoke — the person asked to
    // leave, and a slow or failed network call must not keep them signed in on screen.
    void endSession();
    setToken(null);
    setCurrentUser(null);
    navigate('/login');
  };

  if (!token) {
    return (
      // Sign-in gets a boundary of its own: a crash here has nothing above it to fall back to, and
      // "the login page is blank" is the one failure nobody can work around from inside the app.
      <ErrorBoundary area="Sign in">
        <Routes>
          <Route path="/login" element={<Login onLoginSuccess={handleLoginSuccess} />} />
          {/*
            Remember where they were headed. A bookmarked or shared link to, say, /billing used to
            bounce to /login and then drop the person on their role's home page, leaving them to
            navigate back by hand — and a link pasted into a chat never landed anywhere useful.
            `RETURN_TO_KEY` is read once by handleLoginSuccess and cleared.
          */}
          <Route path="*" element={<RememberAndRedirectToLogin />} />
        </Routes>
      </ErrorBoundary>
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
    {/*
      Two boundaries, not one, because they protect different things.

      The outer one is the last resort: it catches a crash in the shell itself (header, sidebar,
      the rule-bypass banner, the call provider's UI) which would otherwise unmount the React root
      and leave a white page. The inner one wraps only the routed screen, so a crash in one page
      leaves the navigation, the notification bell and the scope selector on screen and the person
      can simply click somewhere else — and because it is reset by the pathname, doing so clears
      the error rather than carrying it to the next screen.
    */}
    <ErrorBoundary area="The application">
    <Layout onLogout={handleLogout} user={currentUser || undefined}>
      <RouteErrorBoundary>
      <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* Root sends each role to the first screen of their actual work. Wait for the profile
            so an admin is not flashed the auditor's default before roles resolve. */}
        <Route
          path="/"
          element={
            isLoadingUser && userRoles.length === 0
              ? <RouteFallback />
              : <PostLoginRedirect fallback={defaultRouteForRoles(userRoles)} />
          }
        />
        {/*
          One ProtectedRoute guards every authenticated screen below, the same pathless-layout
          pattern /data-entry and /hr already used one level down for their own child routes.
          ProtectedRoute reads location.pathname itself (not a route-specific prop), so it works
          identically whether it wraps one page directly or an <Outlet /> — this used to be
          pasted onto all 27 routes individually, which meant every new route had to remember
          to add it by hand.
        */}
        <Route element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Outlet /></ProtectedRoute>}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/executive-map" element={<ExecutiveMap />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/branches" element={<Branches />} />
          {/* The four Audit Work tabs. Same container, different tab in front — see AuditWork. */}
          <Route path="/inbox" element={<AuditWork />} />
          <Route path="/planning" element={<AuditWork />} />
          <Route path="/scheduling" element={<AuditWork />} />
          <Route path="/assignments" element={<AuditWork />} />
          <Route path="/documents" element={<Documents />} />
          <Route path="/data-entry" element={<DataEntryLayout />}>
            <Route index element={<DataEntryOverview />} />
            <Route path="packets" element={<PacketsQueue />} />
            <Route path="reviews" element={<ReviewsQueue />} />
            <Route path="case/:branchId" element={<DataEntryCasePage />} />
            <Route path="clarifications" element={<ClarificationsPage />} />
          </Route>
          <Route path="/users" element={<Users />} />
          {/*
            HR is a section, not a page. It briefly had eleven URLs, three of which badged off the
            same number — Records, Compliance and Documents all pointed at "this person's file is
            incomplete" — so closely related concerns are now merged into one destination each with
            plain-language filter chips. See the comment above PAGES in HrLayout.tsx for the full
            reasoning; the retired paths below redirect to the chip they used to be, because the
            backend worklist links to them by path and people have them bookmarked.
          */}
          <Route path="/hr" element={<HrLayout />}>
            <Route index element={<HrOverviewPage />} />
            <Route path="roster" element={<HrRosterPage />} />
            <Route path="onboarding" element={<HrOnboardingPage />} />
            <Route path="paperwork" element={<HrPaperworkPage />} />
            <Route path="skills" element={<HrCapabilityPage />} />
            <Route path="pay" element={<HrPayPage />} />
            <Route path="where" element={<HrWherePeopleArePage />} />

            {/* Retired URLs — kept resolving, each landing on the chip that replaced it.
                These duplicate LEGACY_PATHS in HrLayout.tsx on purpose: importing it here as a
                value would drag HrLayout out of its lazy chunk. Keep the two in step. */}
            <Route path="records" element={<Navigate to="/hr/paperwork?view=details" replace />} />
            <Route path="compliance" element={<Navigate to="/hr/paperwork?view=certificates" replace />} />
            <Route path="documents" element={<Navigate to="/hr/paperwork?view=ids" replace />} />
            <Route path="capability" element={<Navigate to="/hr/skills" replace />} />
            <Route path="deployment" element={<Navigate to="/hr/where?view=coverage" replace />} />
            <Route path="utilisation" element={<Navigate to="/hr/where?view=workload" replace />} />
            <Route path="activity" element={<Navigate to="/hr/where?view=changes" replace />} />
          </Route>
          <Route path="/clients" element={<Clients />} />
          <Route path="/billing" element={<Billing />} />
          <Route path="/billing/statement" element={<AssayerStatementPage />} />
          <Route path="/admin/rule-bypass" element={<RuleBypassPanel />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/holidays" element={<Holidays />} />
          <Route path="/transport-costs" element={<TransportCosts />} />
          <Route path="/admin/notifications" element={<NotificationAdmin />} />
          <Route path="/admin/settings" element={<PlatformSettings />} />
          <Route path="/zones" element={<Zones />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/feedback" element={<FeedbackPage />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
        {/* Validation is now part of the merged data-entry board. */}
        <Route path="/validation" element={<Navigate to="/data-entry" replace />} />
        {/* The roster now lives inside the workforce console; keep the old path working. */}
        <Route path="/assayers" element={<Navigate to="/hr/roster" replace />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
      </RouteErrorBoundary>
    </Layout>
    </ErrorBoundary>
    </CallProvider>
  );
};

export default App;
