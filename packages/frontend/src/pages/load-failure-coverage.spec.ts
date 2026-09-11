import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The screens that were repaired stay repaired.
 *
 * Fifty-four files in this app fetched data with no failure path of any kind, so a 403 rendered as
 * "0 records", a 404 as a spinner that never stopped, and a failed load as a successful empty one.
 * The behaviour of the repaired ones is pinned by the four suites named at the bottom of this
 * file, which render the real components against a refusing API. Those are the real guard.
 *
 * This is the cheaper, wider one: a file in the list below must go on *consulting* the shared
 * failure machinery. It cannot tell you the banner is rendered in the right branch — only a
 * rendering test can — but it does catch the specific regression these files are prone to, which
 * is somebody simplifying a query back to `const { data } = useQuery(...)` while tidying, and the
 * failure path silently going with it. That change compiles, passes every other test, and
 * restores the original bug.
 *
 * Two rules for keeping this honest:
 *
 *  - **Comments are stripped before scanning.** Every one of these files now carries a paragraph
 *    explaining what `loadFailed` is for. Scanning the raw text would match those words and pass
 *    on a file whose code had been gutted, which is the failure mode a source-scanning test is
 *    most prone to and the reason several of them are worthless.
 *  - **Removing a name from this list is a decision, not a tidy-up.** If a screen genuinely stops
 *    fetching, delete its entry in the same commit that deletes its fetch.
 */

const SRC = join(__dirname, '..');

/**
 * Source with comments removed, so a file cannot satisfy this test by talking about the thing it
 * no longer does. Strings are left alone: no token this scans for appears inside one, and a real
 * comment stripper that also understood strings and regex literals would be more machinery than
 * the check is worth.
 */
function code(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The screens repaired in this pass, and the sentence each one used to print over a failed load.
 * The sentence is here so that whoever trips this test can see what is at stake in that file
 * rather than just a missing identifier.
 */
const REPAIRED: Array<[path: string, whatItUsedToSay: string, ownMarker?: string]> = [
  // ── Money ──────────────────────────────────────────────────────────────────
  ['pages/billing/PayoutsTab.tsx', '"No payouts yet. They appear here the moment an assignment completes."'],
  ['pages/billing/InvoicesTab.tsx', '"Nothing to invoice. Completed assignments appear here automatically."'],
  ['pages/billing/AssayerInvoicesTab.tsx', '"No assayer invoices yet."'],
  ['pages/billing/InvoiceDetailDrawer.tsx', 'a drawer titled "Loading…" that never resolved'],
  ['pages/billing/AssignmentMoneyCard.tsx', '"Loading…", forever, on one assignment\'s money'],
  ['pages/billing/AssayerStatementPage.tsx', 'the raw text of the throw, in red'],
  ['pages/billing/OverviewTab.tsx', 'full chrome and no figures'],
  ['pages/hr/HrPayPage.tsx', 'four tiles counting a roster that never loaded'],
  ['pages/ExpenseReview.tsx', '"No expense claims are awaiting review."'],
  ['pages/Billing.tsx', '"Could not count." beside a button reading "Nothing to book"'],

  // ── People ─────────────────────────────────────────────────────────────────
  ['pages/hr/AssayerRoster.tsx', '"Workforce roster is empty", under a dismissible banner'],
  ['pages/hr/roster/useRosterQuery.ts', 'isError, which is false for a query that failed and paused'],
  ['pages/hr/AssayerRecord.tsx', 'an empty Current work list, an empty history, no empanelments'],
  ['pages/hr/AssayerSkillsPanel.tsx', '"planning cannot match this person on competency"'],
  ['pages/hr/AssayerQualificationTab.tsx', 'a skeleton that never resolved'],
  ['pages/hr/AssayerVettingTab.tsx', 'an empty div, once the error banner was dismissed'],
  ['pages/users/ActivityFeed.tsx', '"Nothing recorded for this person yet."'],
  ['pages/users/DirectoryPanel.tsx', '"No users yet", beside an Add User button'],

  // ── Work ───────────────────────────────────────────────────────────────────
  ['pages/PlanningWorkspace.tsx', '"No branches in this project yet. Add branches to the project…"'],
  /*
   * The one presentational exception. This panel does not decide anything: PlanningWorkspace asks
   * `loadFailed` and hands the ready-made banner down as `failure`, which the panel renders BEFORE
   * its loading and empty branches. So the thing that must not disappear from this file is the
   * prop itself — delete it and the page's banner has nowhere to go, silently.
   */
  ['pages/planning/BranchListPanel.tsx', 'the same, with no way for the page to say otherwise', 'failure'],
  ['pages/planning/BranchHistoryDrawer.tsx', '(error as Error).message, raw'],
  ['pages/assignments/AssignmentTable.tsx', 'a FORBIDDEN branch that could never fire (error.statusCode)'],
  ['pages/assignments/AssignmentDetailDrawer.tsx', '"No timeline events yet"'],
  ['pages/assignments/useAssignmentQueue.ts', 'isError, missing the paused case'],
  ['pages/OperationsInbox.tsx', '"Inbox zero — the operation is healthy."'],
  ['pages/Branches.tsx', 'console.error, then "No branches to show…clear your search and filters"'],
  ['pages/Projects.tsx', '"Select a project to view details." right after one was selected'],
  ['pages/Documents.tsx', '"Couldn\'t load the document workspace." and a Retry for everyone'],

  // ── Data entry ─────────────────────────────────────────────────────────────
  ['pages/dataentry/DataEntryOverview.tsx', 'seven tiles of "…" and no "Needs attention" banner'],
  ['pages/dataentry/PacketsQueue.tsx', '"No packets in this lane."'],
  ['pages/dataentry/ReviewsQueue.tsx', '"No report is waiting to be reviewed."'],
  ['pages/dataentry/ClarificationsPage.tsx', '"Nothing is waiting on you."'],
  ['pages/dataentry/CaseWorkspace.tsx', 'no packets, no clarifications, and an empty audit trail'],
  ['pages/dataentry/ThreadPanel.tsx', '"Nothing has been said on this question yet."'],

  // ── Outward ────────────────────────────────────────────────────────────────
  ['pages/Holidays.tsx', '"No holidays registered for 2026."'],
  ['pages/Zones.tsx', '"No zones defined yet. Create one to group branches…"'],
  ['pages/ExecutiveMap.tsx', '"Loading geographic intelligence…", forever'],
  ['pages/Settings.tsx', 'a blank name and email over a live Save Profile button'],
  ['pages/Rules.tsx', '"No rules yet…every assayer is eligible for every job"'],
  ['pages/TransportCosts.tsx', '"No active transport rates yet."'],
  ['pages/admin/NotificationAdmin.tsx', '"0 emailing · 0 customised · 0 off"'],
  ['pages/admin/PlatformSettings.tsx', 'a settings section with zero rows'],
  ['pages/admin/RuleBypassPanel.tsx', '"All rules are being enforced."'],
  ['pages/users/RolesPermissionsPanel.tsx', 'a roles screen with no roles'],
  ['components/RuleBypassBanner.tsx', 'silence, which is how it says "these are real records"'],
  ['pages/work/AuditWork.tsx', 'nothing at all, when the browser was offline'],
];

/**
 * The names that mean "this file decides failure the shared way". `loadFailed` is the predicate,
 * `LoadFailure` the banner, `caughtLoad` the adapter for screens that fetch without React Query,
 * and `classifyError`/`translateError` the two functions that decide what a status means. One of
 * them is enough: `useRosterQuery.ts` exports a query for its page to test and renders nothing.
 */
const MARKERS = ['loadFailed', 'LoadFailure', 'caughtLoad', 'classifyError', 'translateError'];

describe('every repaired screen still consults the shared failure machinery', () => {
  it('is scanning a list long enough to be worth having', () => {
    // A regex that stops matching, or a list somebody emptied, would pass silently otherwise.
    expect(REPAIRED.length).toBeGreaterThan(40);
  });

  it('strips comments before deciding, so prose about loadFailed cannot stand in for it', () => {
    const withOnlyComments = `
      // loadFailed is what this file should use
      /* LoadFailure belongs here, and caughtLoad too */
      export const X = 1;
    `;
    const stripped = withOnlyComments
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const marker of MARKERS) expect(stripped).not.toContain(marker);
    // And the stripper must not eat the `//` in a URL, which these files are full of.
    expect('api.request("https://x/y") // gone'.replace(/(^|[^:])\/\/.*$/gm, '$1')).toContain('https://x/y');
  });

  /**
   * Every row is padded to three columns before `it.each` sees it, and that is not cosmetic.
   *
   * When a callback declares more parameters than the row supplies, jest fills the gap with its
   * own `done` callback — a FUNCTION, which is truthy. Written as `(path, was, ownMarker)` over
   * rows of length two, `ownMarker` was therefore `done`, `ownMarker ? [ownMarker] : MARKERS`
   * took the wrong branch, and all forty-six files "failed" for looking for a marker that was a
   * function. A test that fails for the wrong reason is only marginally better than one that
   * passes for the wrong reason, and it is the same mistake in the other direction.
   */
  const ROWS: Array<[string, string, string]> = REPAIRED.map(([path, was, own]) => [path, was, own ?? '']);

  it.each(ROWS)('%s — used to render %s', (path, _was, ownMarker) => {
    const src = code(path);
    const wanted = ownMarker ? [ownMarker] : MARKERS;
    const found = wanted.filter((m) => src.includes(m));
    expect(found.length).toBeGreaterThan(0);
  });
});

/**
 * Where the behaviour itself is checked — that the banner is in the right BRANCH, that the empty
 * sentence is gone, that Retry appears for a 500 and not for a 403:
 *
 *   components/LoadFailure.spec.tsx                     — the component's three decisions
 *   pages/billing/money-refusal-is-not-zero.spec.tsx    — payouts, invoices, the money card
 *   pages/hr/people-refusal-is-not-absence.spec.tsx     — audit trail, skills, qualification
 *   pages/planning/work-refusal-is-not-emptiness.spec.tsx — coverage queue, history, assignments
 *   pages/dataentry/desk-refusal-is-not-a-clear-desk.spec.tsx — the desk's five swallowed reads
 *   pages/outward-refusal-is-not-emptiness.spec.tsx     — holidays, zones, rules, bypass, rates
 *   pages/ExpenseReview.spec.tsx                        — the useState/useEffect path
 */
