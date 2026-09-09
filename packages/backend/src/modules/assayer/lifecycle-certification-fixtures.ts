import { AssayerLifecycleStatus, EmpanelmentStatus, AssignmentStatus } from '@fapoms/shared';

/**
 * THE TEN LIFECYCLE FIXTURES, NAMED AND FIXED.
 *
 * Every lifecycle question this system gets asked in anger — "does suspending someone cancel
 * their work?", "can a leaver still be picked by the planner?", "why is this person not
 * deployable?" — needs a record in a specific state WITH specific things hanging off it. Building
 * one ad hoc per test is how two tests end up disagreeing about what "a suspended assayer" means,
 * and how a failure becomes unreproducible: the row that failed was assembled inside the test that
 * failed, and it is gone.
 *
 * So the population is declared once, here, and it is DETERMINISTIC in both directions:
 *
 *   - the assayer code is fixed per scenario, so a failure names a row you can go and look at;
 *   - the id is derived from that code (`md5('lcert:' || code)::uuid`), so re-running reuses the
 *     same row rather than accumulating a new one per run, and so a test can reference a fixture
 *     by id without first querying for it.
 *
 * Deliberately NOT random. A generated roster finds different bugs on every run and can reproduce
 * none of them, which is the opposite of what a certification needs.
 *
 * Nothing here is created against the live roster: every code carries the `LCERT-` prefix, and
 * `LIFECYCLE_FIXTURE_CLEANUP_SQL` at the bottom removes exactly that prefix and its dependants.
 */

export const LIFECYCLE_FIXTURE_PREFIX = 'LCERT-FIX-';

/** The operational projection the DB CHECK constraint demands — mirrors `operationalStatusFor`. */
export function projectionFor(lifecycle: AssayerLifecycleStatus): 'ACTIVE' | 'SUSPENDED' | 'INACTIVE' {
  if (lifecycle === AssayerLifecycleStatus.ACTIVE) return 'ACTIVE';
  if (lifecycle === AssayerLifecycleStatus.SUSPENDED) return 'SUSPENDED';
  return 'INACTIVE';
}

/** `chk_assayers_is_active_consistency`: only ARCHIVED is inactive. */
export function isActiveFor(lifecycle: AssayerLifecycleStatus): boolean {
  return lifecycle !== AssayerLifecycleStatus.ARCHIVED;
}

export interface LifecycleFixture {
  /** Stable suffix; the full code is `LCERT-FIX-<key>`. */
  key: string;
  /** What this row is for, in one sentence — read it before changing the row. */
  purpose: string;
  lifecycle: AssayerLifecycleStatus;
  /** Bank account, IFSC and PAN present? Absent means "cannot be paid". */
  payoutDetails: boolean;
  /** Identity documents verified? Absent is what the activation identity gate is about. */
  kycVerified: boolean;
  /** Client standings to create, if any. */
  empanelments: EmpanelmentStatus[];
  /** Assignments to create, if any. */
  assignments: AssignmentStatus[];
  /** Set on the row; `hasLeftWorkforce` treats INACTIVE + DECEASED as departed. */
  unavailableReason?: string;
  exitDate?: string;
  terminationDate?: string;
}

export const LIFECYCLE_FIXTURES: LifecycleFixture[] = [
  {
    key: 'CLEAN-ONBOARDING',
    purpose: 'A new joiner at the top of the chain, with nothing wrong. The control for every '
      + 'onboarding assertion — if this one is blocked, the blocker is not what the test thinks.',
    lifecycle: AssayerLifecycleStatus.INVITED,
    payoutDetails: true, kycVerified: true, empanelments: [], assignments: [],
  },
  {
    key: 'KYC-INCOMPLETE',
    purpose: 'Mid-onboarding with documents unverified. Exercises the activation identity gate '
      + '(`onboarding.identityGate.mode`) — warn lets it through and leaves a remark, enforce refuses.',
    lifecycle: AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
    payoutDetails: true, kycVerified: false, empanelments: [], assignments: [],
  },
  {
    key: 'BGV-PENDING',
    purpose: 'Waiting on the background check. The stage that must not be skippable to ACTIVE.',
    lifecycle: AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
    payoutDetails: true, kycVerified: true, empanelments: [], assignments: [],
  },
  {
    key: 'ACTIVE-DEPLOYABLE',
    purpose: 'Fully deployable: ACTIVE, paid-up details, verified, with a plannable empanelment. '
      + 'The only fixture that should ever pass every gate at once.',
    lifecycle: AssayerLifecycleStatus.ACTIVE,
    payoutDetails: true, kycVerified: true,
    empanelments: [EmpanelmentStatus.ACTIVE], assignments: [],
  },
  {
    key: 'ACTIVE-PAYOUT-BLOCKED',
    purpose: 'ACTIVE and workable but missing bank account, IFSC and PAN. The population '
      + '`cannotBePaid` exists to chase — and the one a departed person must NOT join.',
    lifecycle: AssayerLifecycleStatus.ACTIVE,
    payoutDetails: false, kycVerified: true,
    empanelments: [EmpanelmentStatus.ACTIVE], assignments: [],
  },
  {
    key: 'ACTIVE-MIXED-PANELS',
    purpose: 'ACTIVE with one plannable standing and one that is not. Proves the per-client gate '
      + 'is read per standing rather than "has any empanelment".',
    lifecycle: AssayerLifecycleStatus.ACTIVE,
    payoutDetails: true, kycVerified: true,
    empanelments: [EmpanelmentStatus.ACTIVE, EmpanelmentStatus.RECOMMENDED, EmpanelmentStatus.INACTIVE],
    assignments: [],
  },
  {
    key: 'SUSPENDED-WITH-WORK',
    purpose: 'THE suspension fixture. Holds a PENDING and an ACCEPTED assignment and two open '
      + 'standings, because the thing that must be proven about suspension is that none of them '
      + 'move. Auto-cancelling on a status meant to be temporary is a defect in the other direction.',
    lifecycle: AssayerLifecycleStatus.SUSPENDED,
    payoutDetails: true, kycVerified: true,
    empanelments: [EmpanelmentStatus.ACTIVE, EmpanelmentStatus.RECOMMENDED],
    assignments: [AssignmentStatus.PENDING, AssignmentStatus.ACCEPTED],
  },
  {
    key: 'RESIGNED-WITH-HISTORY',
    purpose: 'A leaver carrying a COMPLETED assignment alongside cancelled ones. The COMPLETED '
      + 'row is billable history and must survive the departure cascade untouched.',
    lifecycle: AssayerLifecycleStatus.RESIGNED,
    payoutDetails: true, kycVerified: true,
    empanelments: [EmpanelmentStatus.INACTIVE],
    assignments: [AssignmentStatus.COMPLETED, AssignmentStatus.CANCELLED],
    exitDate: '2026-06-30',
  },
  {
    key: 'TERMINATED',
    purpose: 'A dismissal, reached the only way it can be — through suspension. Carries both '
      + 'departure columns, because a termination that filled only `termination_date` would be '
      + 'invisible to every reader (they all read `exit_date`).',
    lifecycle: AssayerLifecycleStatus.TERMINATED,
    payoutDetails: true, kycVerified: true,
    empanelments: [EmpanelmentStatus.INACTIVE], assignments: [AssignmentStatus.CANCELLED],
    exitDate: '2026-05-31', terminationDate: '2026-05-31',
  },
  {
    key: 'ARCHIVED',
    purpose: 'The terminal state, and the only fixture with `is_active = false`. That flag is '
      + 'what makes `AssayerService.findOne` refuse to load the row at all, which is the real '
      + 'guard behind "an archived record cannot be reactivated" — the transition map alone '
      + 'would give a 400, this gives a 404 before the map is consulted.',
    lifecycle: AssayerLifecycleStatus.ARCHIVED,
    payoutDetails: true, kycVerified: true,
    empanelments: [EmpanelmentStatus.INACTIVE], assignments: [AssignmentStatus.CANCELLED],
    exitDate: '2026-04-30',
  },
  {
    key: 'DECEASED',
    purpose: 'The awkward case `hasLeftWorkforce` exists for: a death is not a lifecycle value, '
      + 'it is filed as INACTIVE with `unavailableReason = DECEASED`. Reading the lifecycle alone '
      + 'left one man on the roster worklists, being chased for his missing bank details.',
    lifecycle: AssayerLifecycleStatus.INACTIVE,
    payoutDetails: false, kycVerified: true,
    empanelments: [], assignments: [],
    unavailableReason: 'DECEASED',
  },
];

/** `LCERT-FIX-<key>` — the code a failure will name. */
export function fixtureCode(f: LifecycleFixture): string {
  return `${LIFECYCLE_FIXTURE_PREFIX}${f.key}`;
}

/**
 * The fixture's id, derived from its code rather than generated.
 *
 * `md5(...)::uuid` is not a v4 uuid — the version nibble is whatever the digest happened to
 * produce. That is fine for a row inserted directly, and it is deliberately NOT fine for
 * `POST /assayers/bulk/lifecycle`, whose DTO validates `@IsUUID('4')`: a bulk test therefore has
 * to create its own v4 row, and finding that out from a 400 rather than from a silent skip is
 * worth the inconvenience.
 */
export function fixtureIdSql(code: string): string {
  return `md5('lcert:${code}')::uuid`;
}

/**
 * Removes the fixture population and everything hanging off it, children first.
 *
 * Scoped to the prefix, so it can never reach a real roster row.
 *
 * `audit_events` is deliberately NOT cleaned, because it CANNOT be: the table carries a
 * `BEFORE DELETE OR UPDATE` trigger (`audit_events_immutable`) that rejects both with
 * "audit_events is append-only". That is the correct behaviour and a thing worth knowing before
 * writing a test around it — the trail outlives the record on purpose, so a re-run inherits the
 * previous run's audit rows for the same fixture ids.
 *
 * The consequence for tests: assert on the LATEST audit row, or on a delta measured across the
 * call, never on an absolute count. A spec that expects "exactly one audit row for this fixture"
 * passes once and fails for ever after, for a reason that has nothing to do with the code.
 */
export const LIFECYCLE_FIXTURE_CLEANUP_SQL = `
DELETE FROM assayer_activities WHERE assayer_id IN
  (SELECT id FROM assayers WHERE assayer_code LIKE '${LIFECYCLE_FIXTURE_PREFIX}%');
DELETE FROM schedules WHERE assignment_id IN
  (SELECT id FROM assignments WHERE assayer_id IN
    (SELECT id FROM assayers WHERE assayer_code LIKE '${LIFECYCLE_FIXTURE_PREFIX}%'));
DELETE FROM assignments WHERE assayer_id IN
  (SELECT id FROM assayers WHERE assayer_code LIKE '${LIFECYCLE_FIXTURE_PREFIX}%');
DELETE FROM assayer_client_empanelments WHERE assayer_id IN
  (SELECT id FROM assayers WHERE assayer_code LIKE '${LIFECYCLE_FIXTURE_PREFIX}%');
DELETE FROM assayers WHERE assayer_code LIKE '${LIFECYCLE_FIXTURE_PREFIX}%';
DELETE FROM projects WHERE project_number LIKE '${LIFECYCLE_FIXTURE_PREFIX}%';
DELETE FROM clients WHERE client_code LIKE '${LIFECYCLE_FIXTURE_PREFIX}%';
`;
