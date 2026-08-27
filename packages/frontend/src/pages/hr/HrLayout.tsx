import React from 'react';
import { NavLink, Navigate, Outlet, useOutletContext, useSearchParams } from 'react-router-dom';
import {
  Users, MapPin, ClipboardList, Wallet,
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
 * SEVEN TABS BECAME FOUR — the WHY, so nobody re-splits them.
 *
 * The section had grown a page per concern, and every one of them was a cross-roster view of a
 * fact that also lived on the person. So HR carried two mental models for the same work: find
 * the concern then find the person, or find the person then find the concern. Both existed for
 * everything, neither was named in a way that said which, and the editing was split between them
 * — Skills & Certificates was a person-picker with the write controls, while the same rows sat
 * read-only on the record with a link across to it. A dead end that sent you elsewhere to do the
 * obvious thing.
 *
 * What is left is the shape of the work rather than the shape of the data:
 *
 *   Overview        what needs doing today, ranked
 *   People          the roster; a chip for every "who needs X", and the whole record on opening
 *                   somebody — including everything the retired pages could edit
 *   Pay & terms     the one screen that is genuinely a comparison: rate cards side by side, which
 *                   is a question about the roster and not about a person
 *   Where people are  utilisation, coverage and recent changes — the only concern here that is
 *                   not a per-person fact at all
 *
 * ONBOARDING, PAPERWORK and SKILLS are gone as destinations. Each was a list of people needing
 * something, which is what the roster's chips are, plus an editor for one person, which is what
 * the record is. Their URLs still resolve, landing on the chip that answers the same question.
 *
 * BADGE RULE, unchanged and now easier to hold: a number appears on exactly one tab — the one
 * that can resolve it — and `tone` says whether it is a PROBLEM or a SIZE. People's badge is the
 * headcount, which is neutral at any value; a fully-staffed team must not look like an
 * outstanding task.
 */
/**
 * `tone` is declared rather than inferred. Every destination that is left carries a neutral
 * count — the alarming numbers are all on the Overview now, which is where "what needs doing"
 * belongs — and letting `as const` narrow the type to `'count'` would delete the alert branch
 * below, so the next badge that ought to go red would quietly not.
 */
const PAGES: readonly {
  to: string; end?: boolean; label: string; icon: React.ElementType;
  tone: 'count' | 'alert';
  badge: (d: HrWorkforceOverview) => number | null;
  hint: (d: HrWorkforceOverview) => string;
}[] = [
  { to: '/hr', end: true, label: 'Overview', icon: ClipboardList, badge: () => null, tone: 'count', hint: () => 'Everything that needs attention today, in one list' },
  {
    to: '/hr/roster', label: 'People', icon: Users, tone: 'count',
    badge: (d: HrWorkforceOverview) => d.headcount.total,
    hint: (d: HrWorkforceOverview) => `${d.headcount.total} people on the books — open anyone to see and edit their whole record`,
  },
  { to: '/hr/pay', label: 'Pay & terms', icon: Wallet, badge: () => null, tone: 'count', hint: () => 'What each person is paid, and on what terms, side by side' },
  { to: '/hr/where', label: 'Where people are', icon: MapPin, badge: () => null, tone: 'count', hint: () => 'Who is busy, which states are covered, and what changed recently' },
];

/**
 * Old URLs must keep resolving: `?tab=` values live in notification payloads and bookmarks, and
 * the per-concern paths (`/hr/records`, `/hr/compliance`, …) are what the backend's worklist
 * actions link to (hr-workforce.service.ts). Each one lands on the merged page with the chip it
 * used to be already selected, so an old link still shows the same content, not just the same
 * neighbourhood.
 */
/**
 * Every screen this section has ever had, pointed at what answers the same question now.
 *
 * These are not decoration: the backend worklist hands the Overview `link: '/hr/records'` and
 * friends, notification payloads carry `?tab=` values, and people bookmark. A retired page must
 * land on the thing that replaced it, not on the section's front door — arriving somewhere
 * plausible with no idea which of four tabs held the answer is how a redirect wastes more time
 * than a dead link.
 *
 * The concern pages now resolve to the roster chip that lists the same people.
 */
const LEGACY_TABS: Record<string, string> = {
  overview: '/hr',
  roster: '/hr/roster',
  people: '/hr/roster',
  pay: '/hr/pay',

  // Retired: each was a list of people needing something, which is a chip, plus an editor for
  // one person, which is the record.
  onboarding: '/hr/roster?segment=onboarding',
  paperwork: '/hr/roster?segment=incomplete',
  records: '/hr/roster?segment=incomplete',
  compliance: '/hr/roster?segment=lapsed',
  documents: '/hr/roster?segment=incomplete',
  skills: '/hr/roster?segment=lapsed',
  capability: '/hr/roster?segment=lapsed',

  // Merged into "Where people are" and still reachable by their own chips.
  deployment: '/hr/where?view=coverage',
  utilisation: '/hr/where?view=workload',
  activity: '/hr/where?view=changes',
};

/** The retired paths, keyed without the `/hr/` prefix — same destinations as the tab keys. */
export const LEGACY_PATHS: Record<string, string> = {
  onboarding: LEGACY_TABS.onboarding,
  paperwork: LEGACY_TABS.paperwork,
  records: LEGACY_TABS.records,
  compliance: LEGACY_TABS.compliance,
  documents: LEGACY_TABS.documents,
  skills: LEGACY_TABS.skills,
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
