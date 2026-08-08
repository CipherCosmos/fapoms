import React from 'react';
import { NavLink, Navigate, Outlet, useOutletContext, useSearchParams } from 'react-router-dom';
import {
  Users, UserPlus, ShieldCheck, MapPin, Activity, ClipboardList, TrendingDown, Wallet,
} from 'lucide-react';

import { useHrWorkforce } from '../../hooks/useHrWorkforce';
import type { HrWorkforceOverview } from '../../hooks/useHrWorkforce';
import { useCurrentRoles, canManageAssayers } from '../../hooks/useCurrentRoles';
import { HrHeader } from './hr-ui';

/**
 * The shell every HR page sits in.
 *
 * HR used to be a single page carrying eight tabs, so the whole workforce position had to be
 * expressed in one screen and each concern got a fraction of it. Each of those concerns is now
 * its own page with its own URL — linkable, bookmarkable, and free to grow the controls the job
 * actually needs rather than the ones that fitted.
 *
 * The overview payload is fetched once here and shared through the outlet, because every page
 * reads some part of it and refetching per page would show the same numbers moving between
 * screens.
 */

export interface HrContext {
  data: HrWorkforceOverview;
  canManage: boolean;
  refetch: () => void;
}

export function useHr(): HrContext {
  return useOutletContext<HrContext>();
}

const PAGES = [
  { to: '/hr', end: true, label: 'Overview', icon: ClipboardList, badge: () => null },
  { to: '/hr/roster', label: 'Roster', icon: Users, badge: (d: HrWorkforceOverview) => d.headcount.total },
  { to: '/hr/onboarding', label: 'Onboarding', icon: UserPlus, badge: (d: HrWorkforceOverview) => d.pipeline.stalled.length },
  { to: '/hr/compliance', label: 'Compliance', icon: ShieldCheck, badge: (d: HrWorkforceOverview) => d.compliance.incompleteCount },
  { to: '/hr/pay', label: 'Pay & Terms', icon: Wallet, badge: () => null },
  { to: '/hr/deployment', label: 'Deployment', icon: MapPin, badge: () => null },
  { to: '/hr/utilisation', label: 'Utilisation', icon: TrendingDown, badge: () => null },
  { to: '/hr/activity', label: 'Activity', icon: Activity, badge: () => null },
] as const;

/** The tab keys the single-page version used, mapped to the pages that replaced them. */
const LEGACY_TABS: Record<string, string> = {
  overview: '/hr', roster: '/hr/roster', onboarding: '/hr/onboarding', records: '/hr/records',
  compliance: '/hr/compliance', deployment: '/hr/deployment', utilisation: '/hr/utilisation',
  activity: '/hr/activity',
};

export const HrLayout: React.FC = () => {
  const { data, isLoading, error, refetch } = useHrWorkforce();
  const [params] = useSearchParams();
  const roles = useCurrentRoles();
  const canManage = canManageAssayers(roles);

  // Links to ?tab=compliance are in notification payloads and people's bookmarks; forward them
  // to the page that concern now lives on rather than dropping them on the overview.
  const legacy = params.get('tab');
  if (legacy && LEGACY_TABS[legacy]) return <Navigate to={LEGACY_TABS[legacy]} replace />;

  if (isLoading) return <div style={{ padding: '24px' }}>Loading workforce position…</div>;

  if (error || !data) {
    return (
      <div style={{ padding: '24px', color: 'var(--danger)' }}>
        <div style={{ fontWeight: 600 }}>Could not load the workforce overview.</div>
        <div style={{ fontSize: 12, marginTop: 4 }}>{(error as Error)?.message}</div>
        <button onClick={() => refetch()} className="btn btn-primary" style={{ marginTop: 14, padding: '8px 16px', fontSize: 12 }}>
          Retry
        </button>
      </div>
    );
  }

  const d = data as HrWorkforceOverview;

  return (
    <div style={{ padding: '20px 24px', maxWidth: '1500px' }}>
      <HrHeader data={d} canManage={canManage} />

      <nav style={{ display: 'flex', gap: '4px', margin: '18px 0', flexWrap: 'wrap', borderBottom: '1px solid var(--border-color)' }}>
        {PAGES.map((p) => {
          const Icon = p.icon;
          const badge = p.badge(d);
          return (
            <NavLink
              key={p.to}
              to={p.to}
              end={'end' in p ? p.end : false}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '9px 14px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                textDecoration: 'none',
                borderBottom: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
                color: isActive ? 'var(--accent)' : 'var(--text-muted)',
              })}
            >
              <Icon size={14} /> {p.label}
              {badge !== null && (
                <span style={{
                  fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: '9px',
                  background: badge > 0 ? 'var(--status-cancelled-bg)' : 'var(--bg-surface-2)',
                  color: badge > 0 ? 'var(--danger)' : 'var(--text-muted)',
                }}>{badge}</span>
              )}
            </NavLink>
          );
        })}
      </nav>

      <Outlet context={{ data: d, canManage, refetch } satisfies HrContext} />
    </div>
  );
};
