import React from 'react';
import { NavLink, Navigate, Outlet, useOutletContext, useSearchParams } from 'react-router-dom';
import {
  Users, UserPlus, MapPin, ClipboardList, Wallet, Award, FileCheck,
} from 'lucide-react';

import { useHrWorkforce } from '../../hooks/useHrWorkforce';
import type { HrWorkforceOverview } from '../../hooks/useHrWorkforce';
import { useCurrentRoles, canManageAssayers } from '../../hooks/useCurrentRoles';
import { HrHeader } from './hr-ui';
import { userMessage } from '../../services/errors';

/**
 * The shell every HR page sits in.
 *
 * HR used to be a single page carrying eight tabs, so the whole workforce position had to be
 * expressed in one screen and each concern got a fraction of it. Each of those concerns is now
 * its own page with its own URL — linkable, bookmarkable, and free to grow the controls the job
 * actually needs rather than the ones that fitted.
 *
 * Splitting it produced the opposite problem — eleven tabs for what is really six or seven jobs,
 * three of which badged off the same number — so the closely related ones have since been merged
 * back into single destinations with filter chips. See the comment above PAGES for which, and
 * why, before adding a twelfth.
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

/**
 * ELEVEN TABS BECAME SEVEN — the WHY, so nobody re-splits them.
 *
 * Records, Compliance and Documents all badged off the same underlying number: Records and
 * Compliance both showed `compliance.incompleteCount`, and Documents showed the government-
 * document gap, which is the other half of the same "this person's file is incomplete" problem.
 * An HR manager reading "26 missing bank accounts" on the Overview therefore had three tabs to
 * guess between, and no way to tell which one fixed it. Records made that worse: it was built
 * and routed but left out of this list entirely, so the only way in was an old `?tab=records`
 * bookmark — the alert the Overview shouts loudest about had no reachable answer at all.
 * The three are now one destination, **Paperwork**, with plain-language filter chips.
 *
 * Utilisation, Deployment and Activity carried no badge between them and answered one question
 * asked in one breath — "where is everybody, and are they busy?" — across three visits. They are
 * now **Where people are**, again with chips.
 *
 * Capability is renamed **Skills & Certificates**: the audience is non-technical HR staff, and
 * "capability" is not a word they use for "does this person's certificate still hold".
 *
 * Pay & Terms is deliberately left on its own. It is the only screen backed by the commercial-
 * profile API rather than the workforce overview, and "what is this person paid" is not a
 * question anyone asks while chasing a missing bank account or a lapsed licence — folding it
 * into Paperwork would have recreated exactly the ambiguity the merge removed.
 *
 * BADGE RULE, now that badges are the navigation: a number appears on exactly one tab — the one
 * that can resolve it. Paperwork counts incomplete personnel fields plus people with no identity
 * document. Expired certifications stay on Skills & Certificates because that is the only screen
 * that can record a renewal, even though Paperwork also *shows* the expiry list.
 */
const PAGES = [
  { to: '/hr', end: true, label: 'Overview', icon: ClipboardList, badge: () => null },
  { to: '/hr/roster', label: 'Roster', icon: Users, badge: (d: HrWorkforceOverview) => d.headcount.total },
  { to: '/hr/onboarding', label: 'Onboarding', icon: UserPlus, badge: (d: HrWorkforceOverview) => d.pipeline.stalled.length },
  {
    to: '/hr/paperwork',
    label: 'Paperwork',
    icon: FileCheck,
    badge: (d: HrWorkforceOverview) =>
      d.compliance.incompleteCount + Math.max(d.compliance.roster - d.compliance.governmentDocuments.withGovDoc, 0),
  },
  { to: '/hr/skills', label: 'Skills & Certificates', icon: Award, badge: (d: HrWorkforceOverview) => d.expiries.certifications.expired },
  { to: '/hr/pay', label: 'Pay & Terms', icon: Wallet, badge: () => null },
  { to: '/hr/where', label: 'Where people are', icon: MapPin, badge: () => null },
] as const;

/**
 * Old URLs must keep resolving: `?tab=` values live in notification payloads and bookmarks, and
 * the per-concern paths (`/hr/records`, `/hr/compliance`, …) are what the backend's worklist
 * actions link to (hr-workforce.service.ts). Each one lands on the merged page with the chip it
 * used to be already selected, so an old link still shows the same content, not just the same
 * neighbourhood.
 */
const LEGACY_TABS: Record<string, string> = {
  overview: '/hr',
  roster: '/hr/roster',
  onboarding: '/hr/onboarding',
  records: '/hr/paperwork?view=details',
  compliance: '/hr/paperwork?view=certificates',
  documents: '/hr/paperwork?view=ids',
  capability: '/hr/skills',
  pay: '/hr/pay',
  deployment: '/hr/where?view=coverage',
  utilisation: '/hr/where?view=workload',
  activity: '/hr/where?view=changes',
};

/** The retired paths, keyed without the `/hr/` prefix — same destinations as the tab keys. */
export const LEGACY_PATHS: Record<string, string> = {
  records: LEGACY_TABS.records,
  compliance: LEGACY_TABS.compliance,
  documents: LEGACY_TABS.documents,
  capability: LEGACY_TABS.capability,
  deployment: LEGACY_TABS.deployment,
  utilisation: LEGACY_TABS.utilisation,
  activity: LEGACY_TABS.activity,
};

/**
 * Resolves anything that used to identify an HR screen — a bare tab key (`compliance`), a path
 * (`/hr/compliance`), or a full legacy link with a query string — to a live destination.
 *
 * The Overview worklist needs this: the backend hands it `link: '/hr/records'` and friends, and
 * those paths no longer exist as pages.
 */
export function resolveHrDestination(raw: string): string {
  if (!raw) return '/hr';
  const path = raw.split('?')[0].replace(/\/+$/, '');
  const key = path.startsWith('/hr/') ? path.slice(4) : path.replace(/^\//, '');
  if (!key || key === 'hr' || key === 'overview') return '/hr';
  return LEGACY_PATHS[key] ?? LEGACY_TABS[key] ?? (path.startsWith('/hr/') ? path : `/hr/${key}`);
}

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
        <div style={{ fontSize: 12, marginTop: 4 }}>{userMessage(error)}</div>
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
