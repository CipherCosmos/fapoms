import React, { Suspense, useEffect, useMemo } from 'react';
import { NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Inbox, Map as MapIcon, CalendarDays, ClipboardList } from 'lucide-react';

import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { useCurrentRoles } from '../../hooks/useCurrentRoles';
import { canAccessRoute } from '../../config/route-permissions';
import {
  WORK_TABS,
  isWorkTabPath,
  tabForAssignment,
  tabForBranchStatus,
  type WorkItemAssignment,
  type WorkTabPath,
} from './workTabs';

/**
 * Audit Work — the single destination that used to be four.
 *
 * See the long comment at the top of `workTabs.ts` for WHY these were merged. This file is only
 * the shell: it draws the tab strip, decides which tab is in front, and mounts the existing page
 * component underneath. The four pages themselves are untouched — same props, same queries, same
 * permission checks. This was a re-parenting, not a rewrite; the only thing removed from them was
 * the stage stepper each had grown to compensate for the split, because the tab strip below IS
 * that stepper now.
 */

/**
 * Still code-split per tab, exactly as App.tsx used to split them per route: the planning
 * workspace alone is thousands of lines with a map engine attached, and a coordinator who only
 * ever works the calendar should not be made to download it.
 */
const OperationsInbox = React.lazy(() => import('../OperationsInbox').then((m) => ({ default: m.OperationsInbox })));
const PlanningWorkspace = React.lazy(() => import('../PlanningWorkspace').then((m) => ({ default: m.PlanningWorkspace })));
const Scheduling = React.lazy(() => import('../Scheduling').then((m) => ({ default: m.Scheduling })));
const Assignments = React.lazy(() => import('../Assignments').then((m) => ({ default: m.Assignments })));

const PAGE_FOR_TAB: Record<WorkTabPath, React.ComponentType> = {
  '/inbox': OperationsInbox,
  '/planning': PlanningWorkspace,
  '/scheduling': Scheduling,
  '/assignments': Assignments,
};

const ICON_FOR_TAB: Record<WorkTabPath, React.ComponentType<{ size?: number }>> = {
  '/inbox': Inbox,
  '/planning': MapIcon,
  '/scheduling': CalendarDays,
  '/assignments': ClipboardList,
};

/** Plain-language quiet notice — used for "we're looking" and "we couldn't look". */
const QuietNote: React.FC<{ children: React.ReactNode; tone?: 'muted' | 'warning' }> = ({ children, tone = 'muted' }) => (
  <div
    style={{
      margin: '0 0 14px',
      padding: '8px 12px',
      borderRadius: 'var(--radius-sm)',
      background: tone === 'warning' ? 'var(--status-pending-bg)' : 'var(--bg-surface-2)',
      color: tone === 'warning' ? 'var(--warning)' : 'var(--text-muted)',
      fontSize: '12px',
    }}
  >
    {children}
  </div>
);

/**
 * "Take me to where this branch actually is."
 *
 * A link that names a branch or a job — from a notification, a dashboard card, the search box, a
 * message a colleague pasted — arrives on the destination's front door (`/inbox`) carrying an
 * identifier. Rather than showing today's queue and leaving the person to work out for themselves
 * which stage that particular branch is sitting in (the exact guessing game this merge exists to
 * end), we ask the server what state it is in and open the tab that can act on it.
 *
 * The identifiers it understands are the ones the app and the backend already put in links:
 * `assignmentId` (the inbox's "Put on calendar" and the assignment panel's "Schedule") and
 * `projectId` + `branchId` (the inbox's "Reassign" and the panel's "Planning" — `branchId` being
 * the PROJECT-branch id, which is what the planning workspace selects on).
 *
 * Only the front door does this. A link that names a stage outright — `/scheduling?assignmentId=…`
 * from the inbox's "Put on calendar", say — is a statement of intent, not a question, and is
 * honoured as written; overriding it would break "I want to book this" into "here is where the
 * database thinks it is", which is the opposite of helpful.
 */
function useResolvedWorkTab(activeTab: WorkTabPath, params: URLSearchParams) {
  const assignmentId = params.get('assignmentId');
  const projectId = params.get('projectId');
  const branchId = params.get('branchId');

  // Only from the front door, and only when there is genuinely something to locate.
  const enabled = activeTab === '/inbox' && Boolean(assignmentId || (projectId && branchId));

  const query = useQuery({
    queryKey: ['work', 'locate', assignmentId ?? '', projectId ?? '', branchId ?? ''],
    enabled,
    // A branch does not change stage while somebody is following a link to it, and a failure here
    // is cosmetic (they simply stay on today's actions), so this neither retries nor refetches.
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<WorkTabPath | null> => {
      if (assignmentId) {
        const assignment = await api.request<WorkItemAssignment>(`/assignments/${assignmentId}`);
        return tabForAssignment(assignment);
      }
      if (projectId && branchId) {
        const rows = await api.request<Array<{ id: string; status?: string | null }>>(
          `/projects/${projectId}/branches`,
        );
        return tabForBranchStatus(rows.find((row) => row.id === branchId)?.status);
      }
      return null;
    },
  });

  return { enabled, ...query };
}

export const AuditWork: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const roles = useCurrentRoles();

  /**
   * A role sees exactly the tabs it could already open as pages, read from the one place that
   * decides that — `route-permissions.ts`. Nothing is duplicated here, so a permission change
   * there moves the tabs with it, and a role can never be shown a tab that would then bounce it
   * off a denied page.
   */
  const visibleTabs = useMemo(
    () => WORK_TABS.filter((tab) => canAccessRoute(roles, tab.path)),
    [roles],
  );

  const activeTab: WorkTabPath = isWorkTabPath(location.pathname) ? location.pathname : '/inbox';

  const { enabled: isLocating, data: resolvedTab, isLoading, error } = useResolvedWorkTab(activeTab, searchParams);

  /**
   * Hand over to the tab the work is actually on, carrying the identifying parameters with it so
   * the destination still opens on that item — `replace` so the browser Back button returns to
   * wherever the person came from rather than bouncing them through the redirect again.
   */
  useEffect(() => {
    if (!isLocating || !resolvedTab || resolvedTab === activeTab) return;
    // Never land somebody on a tab their role cannot open.
    if (!visibleTabs.some((tab) => tab.path === resolvedTab)) return;

    const next = new URLSearchParams(searchParams);
    // The field-work list selects on `id`, not `assignmentId`; translate so following the link
    // opens the job rather than merely the right list.
    const assignmentId = next.get('assignmentId');
    if (resolvedTab === '/assignments' && assignmentId && !next.get('id')) {
      next.set('id', assignmentId);
      next.delete('assignmentId');
    }
    const qs = next.toString();
    navigate(qs ? `${resolvedTab}?${qs}` : resolvedTab, { replace: true });
  }, [isLocating, resolvedTab, activeTab, visibleTabs, searchParams, navigate]);

  const ActivePage = PAGE_FOR_TAB[activeTab];

  /**
   * While we are looking the item up, hold the screen rather than painting today's queue and then
   * yanking it away a moment later — a flash of the wrong screen is what made the old split feel
   * like the app had lost the branch.
   */
  const isHandingOver = isLocating && (isLoading || Boolean(resolvedTab && resolvedTab !== activeTab));

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/*
        The strip is pulled out to the full width of the content area (Layout gives its children
        20px of padding) so it reads as the top of one screen rather than a widget floating on it.
        `WORK_TAB_STRIP_HEIGHT` is exported because the planning workspace sizes itself against the
        viewport and has to subtract this; keep the two in step if the padding here changes.
      */}
      <nav
        aria-label="Audit work"
        style={{
          display: 'flex',
          gap: '4px',
          margin: '-20px -20px 0',
          padding: '0 20px',
          flexWrap: 'wrap',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-color)',
          flexShrink: 0,
        }}
      >
        {visibleTabs.map((tab) => {
          const Icon = ICON_FOR_TAB[tab.path];
          return (
            <NavLink
              key={tab.path}
              to={tab.path}
              title={tab.hint}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '11px 14px',
                fontSize: '13px',
                fontWeight: 600,
                textDecoration: 'none',
                whiteSpace: 'nowrap',
                borderBottom: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
                color: isActive ? 'var(--accent)' : 'var(--text-muted)',
              })}
            >
              <Icon size={14} /> {tab.label}
            </NavLink>
          );
        })}
      </nav>

      <div style={{ paddingTop: '20px' }}>
        {isHandingOver ? (
          <div style={{ padding: '24px', color: 'var(--text-muted)', fontSize: '13px' }}>
            Finding where this work has got to…
          </div>
        ) : (
          <>
            {isLocating && error && (
              <div>
                <QuietNote tone="warning">
                  We could not check where that branch has got to, so you are on today's actions.
                  Pick a tab above to carry on. ({userMessage(error)})
                </QuietNote>
              </div>
            )}
            <Suspense fallback={<div style={{ padding: '24px', color: 'var(--text-muted)' }}>Loading…</div>}>
              <ActivePage />
            </Suspense>
          </>
        )}
      </div>
    </div>
  );
};

export default AuditWork;
