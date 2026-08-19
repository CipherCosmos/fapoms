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
import { counted } from '../../utils/plural';

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
 *
 * A badge also has to say whether it is a PROBLEM or just a SIZE. Every badge here used to be
 * painted red as soon as it was above zero, so Roster's headcount — a perfectly healthy "8 people
 * on the books" — was drawn in the same alarm colour as "8 people with no bank account", and a
 * fully-staffed team looked like an outstanding task. `tone` now marks which is which: 'count'
 * badges are neutral at any value, 'alert' badges go red only when there is something to do.
 */
const PAGES = [
  { to: '/hr', end: true, label: 'Overview', icon: ClipboardList, badge: () => null, tone: 'count', hint: () => 'Everything that needs attention today, in one list' },
  {
    to: '/hr/roster', label: 'Roster', icon: Users, tone: 'count',
    badge: (d: HrWorkforceOverview) => d.headcount.total,
    hint: (d: HrWorkforceOverview) => `${d.headcount.total} people on the books — this is a total, not a task`,
  },
  {
    to: '/hr/onboarding', label: 'Onboarding', icon: UserPlus, tone: 'alert',
    badge: (d: HrWorkforceOverview) => d.pipeline.stalled.length,
    hint: (d: HrWorkforceOverview) =>
      `${d.pipeline.stalled.length} joining ${d.pipeline.stalled.length === 1 ? 'has' : 'have'} not moved on in over ${d.pipeline.stalledAfterDays} days`,
  },
  {
    to: '/hr/paperwork',
    label: 'Paperwork',
    icon: FileCheck,
    tone: 'alert',
    badge: (d: HrWorkforceOverview) =>
      d.compliance.incompleteCount + Math.max(d.compliance.roster - d.compliance.governmentDocuments.withGovDoc, 0),
    hint: (d: HrWorkforceOverview) =>
      `${d.compliance.incompleteCount} with missing bank or personal details, plus ${Math.max(d.compliance.roster - d.compliance.governmentDocuments.withGovDoc, 0)} with no ID document on file`,
  },
  {
    to: '/hr/skills', label: 'Skills & Certificates', icon: Award, tone: 'alert',
    badge: (d: HrWorkforceOverview) => d.expiries.certifications.expired,
    hint: (d: HrWorkforceOverview) => `${counted(d.expiries.certifications.expired, 'certificate')} ${d.expiries.certifications.expired === 1 ? 'has' : 'have'} already run out and need renewing`,
  },
  { to: '/hr/pay', label: 'Pay & Terms', icon: Wallet, badge: () => null, tone: 'count', hint: () => 'What each person is paid, and on what terms' },
  { to: '/hr/where', label: 'Where people are', icon: MapPin, badge: () => null, tone: 'count', hint: () => 'Who is busy, which states are covered, and what changed recently' },
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

  /*
   * "Loading workforce position…" is the system describing its own data model. It also arrived
   * bare on a white page with no heading, so for the second or two it is on screen there was
   * nothing to say which part of the app you had landed in. Say what is coming, in the words of
   * the tab that asked for it, under the section's own title.
   */
  if (isLoading) {
    return (
      <div style={{ padding: '20px 24px', maxWidth: '1500px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 700, margin: 0 }}>Workforce</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '10px' }}>
          Getting the latest figures for everyone on the roster…
        </p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ padding: '24px', color: 'var(--danger)' }}>
        <div style={{ fontWeight: 600 }}>The workforce figures could not be loaded just now.</div>
        <div style={{ fontSize: 12, marginTop: 4 }}>{userMessage(error)}</div>
        <div style={{ fontSize: 12, marginTop: 6, color: 'var(--text-muted)' }}>
          Nothing has been lost — try again, and tell IT if it keeps happening.
        </div>
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

      {/*
        * ONE SCROLLING STRIP, NEVER A WRAPPED STACK.
        *
        * `flexWrap: 'wrap'` was fine at desk width and wrong everywhere else: on a phone the seven
        * tabs wrapped to one per line, so arriving at Workforce filled the entire first screen
        * with a vertical list of tab names. It read as a navigation drawer that had opened by
        * itself, and the page's actual content — the list of what needs attention — started below
        * the fold, where nobody scrolled to find it.
        *
        * Nowrap plus horizontal scroll keeps the strip one row tall at every width. The tabs that
        * do not fit are reached by swiping the strip sideways, which is the same gesture the
        * detail drawer's own tab row already uses.
        */}
      <nav
        className="hr-tab-strip"
        style={{
          display: 'flex', gap: '4px', margin: '18px 0',
          flexWrap: 'nowrap', overflowX: 'auto', overflowY: 'hidden',
          borderBottom: '1px solid var(--border-color)',
          scrollbarWidth: 'none',
        }}
      >
        {PAGES.map((p) => {
          const Icon = p.icon;
          const badge = p.badge(d);
          /*
           * A bare red number beside a tab name is a puzzle: "Paperwork 34" says a quantity but
           * not of what, and not whether 34 is a workload or a warning. The hint spells the
           * number out in a sentence on hover, in the same words the destination screen uses.
           */
          const hint = p.hint(d);
          // Red means "there is something here for you to do", never "this number is large" —
          // see the badge rule above.
          const alarming = p.tone === 'alert' && badge !== null && badge > 0;
          return (
            <NavLink
              key={p.to}
              to={p.to}
              title={hint}
              end={'end' in p ? p.end : false}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '9px 14px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                textDecoration: 'none',
                // Without these the strip stops being a strip: flex items shrink by default, so
                // narrow widths squeezed the tabs into each other and wrapped their labels onto
                // two lines instead of letting the row scroll.
                flexShrink: 0, whiteSpace: 'nowrap',
                borderBottom: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
                color: isActive ? 'var(--accent)' : 'var(--text-muted)',
              })}
            >
              <Icon size={14} /> {p.label}
              {badge !== null && (
                <span style={{
                  fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: '9px',
                  background: alarming ? 'var(--status-cancelled-bg)' : 'var(--bg-surface-2)',
                  color: alarming ? 'var(--danger)' : 'var(--text-muted)',
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
