/**
 * Where an old link to this section lands.
 *
 * Extracted from `HrLayout` for two reasons. It is pure routing logic with no React in it, so it
 * belongs somewhere it can be tested — this project's test runner only picks up `.ts`, and a
 * redirect table that silently stops redirecting is exactly the kind of thing that needs a test.
 * And `App.tsx` needs the same list to declare its routes: it used to carry a hand-maintained
 * copy with a comment asking the next person to keep the two in step, because importing
 * `HrLayout` as a value would have dragged it out of its lazy chunk. This module is small enough
 * to import from both.
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
export const LEGACY_TABS: Record<string, string> = {
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
  const [path0, query] = raw.split('?');
  const path = path0.replace(/\/+$/, '');
  const key = path.startsWith('/hr/') ? path.slice(4) : path.replace(/^\//, '');
  if (!key || key === 'hr' || key === 'overview') return '/hr';

  const mapped = LEGACY_PATHS[key] ?? LEGACY_TABS[key] ?? (path.startsWith('/hr/') ? path : `/hr/${key}`);

  // A mapped destination brings its own chip — `/hr/records` means the incomplete-record
  // segment, whatever the caller appended — so its query wins. Otherwise the caller's is
  // carried, which is how the worklist's `/hr/roster?segment=lapsed` reaches the chip at all:
  // this dropped every query string, so those rows landed on the roster showing everyone.
  if (mapped.includes('?') || !query) return mapped;
  return `${mapped}?${query}`;
}
