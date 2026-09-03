import {
  AssayerEngagementType, AssayerLifecycleStatus, AssayerUnavailableReason,
  assayerLifecycleLabel, employmentTypeLabel, daysUntilExpiry, isPlaceholderPin,
} from '@fapoms/shared';

import {
  missingCriticalFields, stillWorkable, isOnboardingStage,
  isAwaitingDocumentCheck, isAwaitingBackgroundCheck, isReadyToActivate,
  type Assayer,
} from './assayer-shared';

/**
 * Everything the roster can be narrowed by, written as data.
 *
 * The screen offered three: a search box, "Stage with HR" and "State they live in". Every other
 * question HR actually asks — who has no region, whose documents are sitting unverified, who
 * joined in April, who is a back-up rather than a regular, whose home pin is a state centroid —
 * had no answer on this page at all, and the only way to get one was to export the whole roster
 * and filter it in Excel. That is what "better filters so we can filter by anything we require"
 * means, and it is why this file is a LIST rather than a component: adding an axis is one entry
 * in `ROSTER_FILTERS`, not a new piece of state, a new dropdown and a new clause in the filter
 * loop — which is the shape that kept the count at three.
 *
 * Two kinds of axis, because the roster genuinely has two kinds of question:
 *
 *   `field` — "which of the values on this column", with the options READ OFF the people who
 *             arrived. Nobody has to maintain a list of districts, skills or qualifications,
 *             and a value that appears in the data can never be missing from its own filter.
 *   `rule`  — "which of these named situations", where the option is a sentence rather than a
 *             stored value: cannot be paid, scans waiting for a verdict, certificate lapsed.
 *
 * Plus `date`, which is a range rather than a set of choices.
 *
 * Chosen values inside one filter are OR (Kerala **or** Goa); separate filters are AND (Kerala
 * **and** cannot be paid). That is the only combination rule, it is the one people expect from
 * every shopping site they have ever used, and it is stated on the panel rather than left to be
 * discovered.
 */

/** The per-person paperwork tally `GET /assayers` attaches to every row. */
export interface RosterDocumentTally {
  /** How many requirements the checklist has — the denominator, from the server's own list. */
  required: number;
  /** Requirements with a file actually attached. NOT the `soft_copy_received` tick box. */
  withScan: number;
  verified: number;
  /** A scan is on file and nobody has said verified or rejected yet: the review queue proper. */
  awaitingVerdict: number;
}

/**
 * A roster row as the list endpoint really sends it.
 *
 * `documents` is hydrated per page by `AssayerService.hydrateDocumentSummaries` and is not on the
 * `Assayer` shape, which describes the record rather than the roster row. Declared here as
 * optional rather than added to that interface for two reasons: an older server (or a cached
 * response) sends rows without it, and this file is the only thing that reads it — the documents
 * filter hides itself entirely when no row carries a tally, so a missing key shows nothing rather
 * than filtering everybody out.
 */
export type RosterPerson = Assayer & { documents?: RosterDocumentTally };

/**
 * Which gaps stop a payout, as opposed to merely leaving the record untidy.
 *
 * The roster's "Record" column used to say only "3 missing", which reads as paperwork. It is
 * not: with no bank account, IFSC or PAN, that person cannot be paid at all, and today every
 * single assayer on the books is in exactly that state while showing a green ACTIVE stage.
 */
const PAYOUT_BLOCKING_KEYS: (keyof Assayer)[] = ['bankAccountNumber', 'ifscCode', 'panNumber'];

/** The payout-blocking gaps on one record, by their shared human labels. */
export function payoutBlockers(a: Partial<Assayer>): string[] {
  return missingCriticalFields(a)
    .filter((f) => PAYOUT_BLOCKING_KEYS.includes(f.key))
    .map((f) => f.label);
}

/**
 * The gaps in one record, by label.
 *
 * The roster used to carry its own second copy of the critical-field list, and the two had
 * already drifted — the shared one counts a missing phone number, that one ignored phone
 * entirely — so the drawer and the roster row disagreed about whether the same person's record
 * was complete. One list, in `@fapoms/shared`, used by both.
 */
export function missingFields(a: Partial<Assayer>): string[] {
  return missingCriticalFields(a).map((f) => f.label);
}

/** Tenure in whole months, or null when the joining date was never captured. */
export function tenureMonths(a: Pick<Assayer, 'joiningDate'>): number | null {
  if (!a.joiningDate) return null;
  const start = new Date(a.joiningDate).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.floor((Date.now() - start) / (1000 * 60 * 60 * 24 * 30.44)));
}

/** The day somebody left, however it was recorded. The roster reads these as one date. */
const leavingDate = (a: RosterPerson): string | null => a.exitDate ?? a.terminationDate ?? null;

/** Whether any certificate on this record has already run out. */
const hasLapsedCertificate = (a: RosterPerson): boolean =>
  (a.certifications ?? []).some((c) => c.expiryDate && (daysUntilExpiry(c.expiryDate) ?? 1) < 0);

/**
 * How much of a home address the stored pin actually is.
 *
 * The same three-way reading the live map applies (`approxLocation` in assayer.service.ts: no
 * source, or coarser than 3 km, is an area rather than an address) plus the centroid case the
 * record already counts as a missing field (`isPlaceholderPin`, ≥100 km — a state or district
 * centre, which is the geocoder's own way of saying it could not find the address).
 *
 * One function because the filter and the export column must agree: an export saying "Confirmed"
 * for somebody the filter puts in "no pin at all" is worse than either alone.
 */
export type PinQuality = 'exact' | 'area' | 'placeholder' | 'none';

export const PIN_QUALITY_LABELS: Record<PinQuality, string> = {
  exact: 'Confirmed to an address',
  area: 'An area only, not an address',
  placeholder: 'A state or district centre, not a home',
  none: 'No pin at all',
};

export function pinQuality(a: RosterPerson): PinQuality {
  if (a.latitude == null) return 'none';
  // The shared check reads `geoAccuracyMeters` off a bag of columns, which is how the backend
  // hands it a row; a typed record has to be widened to be passed to it.
  if (isPlaceholderPin(a as unknown as Record<string, unknown>)) return 'placeholder';
  if (!a.geoSource || Number(a.geoAccuracyMeters ?? 0) > 3000) return 'area';
  return 'exact';
}

/**
 * How they are engaged, and why they are not available.
 *
 * HANDOFF, and it is the one wart in this file: these two maps already exist twice, privately,
 * in `AssayerRecord.tsx` (ENGAGEMENT_LABELS / UNAVAILABLE_LABELS) and `AssayerForms.tsx`
 * (ENGAGEMENT_OPTIONS / UNAVAILABLE_OPTIONS). Neither is exported, so a filter that must show
 * the same words as the record it filters cannot borrow either. The words are copied exactly —
 * a clerk must not meet "Back-up" on the record and "Back up" in the filter — and all three
 * copies want collapsing into `@fapoms/shared/assayer-roster-vocabulary.ts`, beside the enums
 * that define the values.
 */
export const ENGAGEMENT_LABELS: Record<string, string> = {
  [AssayerEngagementType.REGULAR]: 'Regular',
  [AssayerEngagementType.LOCAL]: 'Local',
  [AssayerEngagementType.BACK_UP]: 'Back-up',
  [AssayerEngagementType.AGENCY_AUDIT]: 'Agency audits',
  [AssayerEngagementType.MYSTERY_AUDIT]: 'Mystery audits',
};

export const UNAVAILABLE_LABELS: Record<string, string> = {
  [AssayerUnavailableReason.REJECTED_BY_US]: 'We rejected them',
  [AssayerUnavailableReason.NOT_INTERESTED]: 'Not interested',
  [AssayerUnavailableReason.DECEASED]: 'Deceased',
  [AssayerUnavailableReason.NO_WORK_IN_AREA]: 'No work in their area',
  [AssayerUnavailableReason.MOVED_ABROAD]: 'Moved out of India',
  [AssayerUnavailableReason.MOVED_TO_COMPANY]: 'Now engaged through a company',
};

/**
 * One-click views onto the questions HR ask most.
 *
 * `hint` is not decoration. Several of these are worklists — a queue of people somebody is
 * supposed to do something to today — and the label alone ("Documents to check") does not say
 * what the work is or where it is done. The hint is shown as a sentence under the chips whenever
 * that chip is the selected one, so the queue explains itself on arrival rather than on hover.
 *
 * `queue` splits the two jobs this row was doing at once. Four of these answer "who am I looking
 * at" (everyone, the working ones, the joining ones, the gone ones); the rest are lists of people
 * somebody must chase. Twelve chips in one undifferentiated row made those read as one kind of
 * thing, so the queues — the whole point of the row — were the hardest part of it to find.
 *
 * They live here rather than in the roster component because a segment is a filter: it is shown
 * in the same "currently applied" bar as the rest, and cleared by the same one action.
 */
export interface RosterSegment {
  key: string;
  label: string;
  hint?: string;
  /** True for the chips that are worklists rather than populations. */
  queue?: boolean;
  match: (a: RosterPerson) => boolean;
}

export const ROSTER_SEGMENTS: RosterSegment[] = [
  { key: 'all', label: 'Everyone', match: () => true },
  { key: 'active', label: 'Active', match: (a) => a.lifecycleStatus === AssayerLifecycleStatus.ACTIVE },
  { key: 'onboarding', label: 'Onboarding', match: (a) => isOnboardingStage(a.lifecycleStatus) },
  /*
   * THE THREE JOINING QUEUES.
   *
   * "Onboarding" above lumps all four joining stages into one pile, and it was the only view this
   * screen had of them. So the two stages the platform actually enforces — document verification
   * and background verification — had no worklist at all: a clerk asking "whose papers am I meant
   * to check today" had nowhere in the application to look, and people sat in a stage for months
   * because nothing counted them.
   *
   * Each queue's rule comes from the one place that already owns it — see assayer-shared.ts — so
   * a chip can never disagree with the button on the record page.
   */
  {
    key: 'to-verify',
    label: 'Documents to check',
    queue: true,
    hint: 'These people are at the document-verification stage. Open anyone, go to Documents, '
      + 'enter each document number and confirm it against the original — then move them on to '
      + 'the background check.',
    match: isAwaitingDocumentCheck,
  },
  {
    key: 'background-due',
    label: 'Background check due',
    queue: true,
    hint: 'Their documents are done and the background check has not been recorded. Open anyone, '
      + 'go to Vetting, and record a check — then move them on to training.',
    match: isAwaitingBackgroundCheck,
  },
  {
    key: 'ready',
    label: 'Ready to activate',
    queue: true,
    hint: 'Nothing is left blocking these people: the next legal step is Active and no required '
      + 'field is missing. Open anyone and press "Move to Active", or tick several and use the '
      + 'bar at the top.',
    match: isReadyToActivate,
  },
  {
    key: 'incomplete',
    label: 'Incomplete record',
    queue: true,
    match: (a) => stillWorkable(a) && missingFields(a).length > 0,
  },
  {
    key: 'unpayable',
    label: 'Cannot be paid',
    queue: true,
    match: (a) => stillWorkable(a) && payoutBlockers(a).length > 0,
  },
  {
    key: 'unprofiled',
    label: 'No skills',
    queue: true,
    match: (a) => stillWorkable(a) && (!a.skills || a.skills.length === 0),
  },
  // Exactly the people the chips above leave alone, written as the complement rather than as a
  // second list of ways to have left. Spelled out separately, the two drifted: this one knew
  // about RESIGNED, TERMINATED, ARCHIVED and the dates, and neither knew that a death is filed as
  // INACTIVE with a reason — so the one person in that state was in no exit view and in both
  // worklists at once.
  { key: 'exited', label: 'Exited', match: (a) => !stillWorkable(a) },
  // 21 people on the roster have audits attended by a member of staff, a relative or a friend
  // rather than by the person empanelled. The record says so once it is open; without a chip
  // there is no way to ask who they all are, and that is the only question worth asking about a
  // compliance flag.
  {
    key: 'someone-else',
    label: 'Work done by somebody else',
    queue: true,
    match: (a) => stillWorkable(a) && a.workDoneBySomeoneElse === true,
  },
  // An expired certificate is refused by the eligibility gate, so the person is quietly
  // unassignable. This was the one question the retired compliance page answered that nothing
  // else did — "who has lapsed" — and it belongs with the other "who needs something" chips.
  {
    key: 'lapsed',
    label: 'Certificate lapsed',
    queue: true,
    match: (a) => stillWorkable(a) && hasLapsedCertificate(a),
  },
];

export const segmentFor = (key: string): RosterSegment =>
  ROSTER_SEGMENTS.find((s) => s.key === key) ?? ROSTER_SEGMENTS[0];

/**
 * The four headings the panel groups filters under, in the order a clerk works through them.
 * Grouping is not decoration on nineteen controls: ungrouped, the only way to find "district" is
 * to read all of them.
 */
export const FILTER_GROUPS = [
  { key: 'person', label: 'The person' },
  { key: 'place', label: 'Where they are' },
  { key: 'paperwork', label: 'Paperwork and money' },
  { key: 'dates', label: 'Dates' },
] as const;

export type FilterGroupKey = (typeof FILTER_GROUPS)[number]['key'];

/** The value standing for "this person has nothing recorded here". Never a real stored value. */
export const NOT_RECORDED = '__none__';

interface FilterBase {
  key: string;
  label: string;
  group: FilterGroupKey;
  /** One line under the filter's name, when the name alone leaves a real question open. */
  hint?: string;
}

export interface FieldFilter extends FilterBase {
  kind: 'field';
  /** What this person holds on this axis. Several for the list columns (skills, languages). */
  valuesOf: (a: RosterPerson) => string[];
  /** Stored value to the words shown. Defaults to the value, which is right for place names. */
  labelOf?: (value: string) => string;
  /** Wording for the people holding nothing here. `null` drops the option entirely. */
  blankLabel?: string | null;
}

export interface RuleFilter extends FilterBase {
  kind: 'rule';
  choices: { value: string; label: string; match: (a: RosterPerson) => boolean }[];
  /** Hides the whole filter when the data it reads is not present — see the documents filter. */
  available?: (rows: RosterPerson[]) => boolean;
}

export interface DateFilter extends FilterBase {
  kind: 'date';
  dateOf: (a: RosterPerson) => string | null | undefined;
}

export type RosterFilter = FieldFilter | RuleFilter | DateFilter;

/** A single stored value, as a one-entry list, for the many columns that hold one thing. */
const one = (pick: (a: RosterPerson) => string | null | undefined) =>
  (a: RosterPerson): string[] => {
    const v = pick(a);
    return v == null || String(v).trim() === '' ? [] : [String(v)];
  };

/** Every axis this roster can be narrowed by. Add one here and it appears, filters and counts. */
export const ROSTER_FILTERS: RosterFilter[] = [
  // ── The person ──────────────────────────────────────────────────────────────────────────
  {
    kind: 'field',
    key: 'stage',
    label: 'Stage with HR',
    group: 'person',
    valuesOf: one((a) => a.lifecycleStatus),
    labelOf: assayerLifecycleLabel,
  },
  {
    kind: 'rule',
    key: 'onbooks',
    label: 'Still with us',
    group: 'person',
    choices: [
      { value: 'yes', label: 'Still on the books', match: (a) => stillWorkable(a) },
      // Not "inactive": this is the population the server counts as gone, which includes a
      // departure entered only as a date and the one person recorded as having died.
      { value: 'no', label: 'Has left', match: (a) => !stillWorkable(a) },
    ],
  },
  {
    kind: 'field',
    key: 'engagement',
    label: 'How they are engaged',
    group: 'person',
    hint: 'Regular, local-only, back-up cover, agency or mystery audits.',
    valuesOf: one((a) => a.engagementType),
    labelOf: (v) => ENGAGEMENT_LABELS[v] ?? v,
    blankLabel: 'Not recorded',
  },
  {
    kind: 'field',
    key: 'employment',
    label: 'Employment type',
    group: 'person',
    valuesOf: one((a) => a.employmentType),
    labelOf: employmentTypeLabel,
    blankLabel: 'Not recorded',
  },
  {
    kind: 'field',
    key: 'unavailable',
    label: 'Why they are unavailable',
    group: 'person',
    valuesOf: one((a) => a.unavailableReason),
    labelOf: (v) => UNAVAILABLE_LABELS[v] ?? v,
    // Most of the roster is available, so "nothing recorded" here is not a gap to chase — it is
    // the ordinary case, and saying so stops the option reading as 1,100 missing values.
    blankLabel: 'No reason recorded',
  },
  {
    kind: 'field',
    key: 'qualification',
    label: 'Qualification',
    group: 'person',
    valuesOf: one((a) => a.qualification),
    blankLabel: 'Not recorded',
  },
  {
    kind: 'rule',
    key: 'experience',
    label: 'Years of experience',
    group: 'person',
    choices: [
      { value: 'lt2', label: 'Under 2 years', match: (a) => (a.experienceYears ?? 0) < 2 },
      { value: '2to5', label: '2 to 5 years', match: (a) => (a.experienceYears ?? 0) >= 2 && (a.experienceYears ?? 0) < 5 },
      { value: '5to10', label: '5 to 10 years', match: (a) => (a.experienceYears ?? 0) >= 5 && (a.experienceYears ?? 0) < 10 },
      { value: 'gte10', label: '10 years or more', match: (a) => (a.experienceYears ?? 0) >= 10 },
    ],
  },
  {
    kind: 'field',
    key: 'skill',
    label: 'Skill',
    group: 'person',
    hint: 'Somebody with any one of the skills ticked.',
    valuesOf: (a) => (a.skills ?? []).filter(Boolean),
    blankLabel: 'No skills recorded',
  },
  {
    kind: 'field',
    key: 'language',
    label: 'Language spoken',
    group: 'person',
    hint: 'What a branch visit in that state usually needs.',
    valuesOf: (a) => (a.languages ?? []).filter(Boolean),
    blankLabel: 'Not recorded',
  },

  // ── Where they are ──────────────────────────────────────────────────────────────────────
  {
    kind: 'field',
    key: 'state',
    label: 'State they live in',
    group: 'place',
    valuesOf: one((a) => a.state),
    blankLabel: 'Not recorded',
  },
  {
    kind: 'field',
    key: 'district',
    label: 'District',
    group: 'place',
    valuesOf: one((a) => a.district),
    blankLabel: 'Not recorded',
  },
  {
    kind: 'field',
    key: 'region',
    label: 'Region',
    group: 'place',
    hint: 'The desk that covers them. A blank region keeps somebody out of region-scoped views.',
    valuesOf: one((a) => a.region),
    blankLabel: 'No region set',
  },
  {
    kind: 'rule',
    key: 'pin',
    label: 'Home location on the map',
    group: 'place',
    hint: 'A pin nobody has confirmed is what makes a candidate four states away pass the '
      + '"near enough" check on the planning screen.',
    choices: (Object.keys(PIN_QUALITY_LABELS) as PinQuality[]).map((q) => ({
      value: q,
      label: PIN_QUALITY_LABELS[q],
      match: (a: RosterPerson) => pinQuality(a) === q,
    })),
  },

  // ── Paperwork and money ─────────────────────────────────────────────────────────────────
  {
    kind: 'rule',
    key: 'record',
    label: 'Record completeness',
    group: 'paperwork',
    choices: [
      { value: 'complete', label: 'Nothing missing', match: (a) => missingFields(a).length === 0 },
      { value: 'incomplete', label: 'Something missing', match: (a) => missingFields(a).length > 0 },
      // Named by its consequence rather than by the three columns, because that is the
      // difference between a gap somebody gets to next month and one that stops a payout run.
      { value: 'unpayable', label: 'Cannot be paid yet', match: (a) => payoutBlockers(a).length > 0 },
      { value: 'payable', label: 'Can be paid', match: (a) => payoutBlockers(a).length === 0 },
    ],
  },
  {
    kind: 'rule',
    key: 'documents',
    label: 'Documents',
    group: 'paperwork',
    hint: 'Counts files actually attached, not the "soft copy received" tick box the imported '
      + 'sheet set on nearly every row.',
    // The tally is hydrated per page by the list endpoint. An older server sends rows without
    // it, and a filter reading an absent key would put everybody in "nothing uploaded".
    available: (rows) => rows.some((a) => a.documents !== undefined),
    choices: [
      {
        value: 'awaiting',
        label: 'Scans waiting for a verdict',
        match: (a) => (a.documents?.awaitingVerdict ?? 0) > 0,
      },
      { value: 'nothing', label: 'Nothing uploaded at all', match: (a) => (a.documents?.withScan ?? 0) === 0 },
      {
        value: 'complete',
        label: 'Every requirement verified',
        match: (a) => !!a.documents && a.documents.required > 0 && a.documents.verified >= a.documents.required,
      },
      {
        value: 'short',
        label: 'Some still to verify',
        match: (a) => !!a.documents && a.documents.verified < a.documents.required,
      },
    ],
  },
  {
    kind: 'rule',
    key: 'certificate',
    label: 'Certificates',
    group: 'paperwork',
    choices: [
      { value: 'lapsed', label: 'Already run out', match: hasLapsedCertificate },
      {
        value: 'soon',
        // 90 days is the notice a renewal actually needs; sooner than that and the person is
        // unassignable before anybody has chased it.
        label: 'Runs out within 90 days',
        match: (a) => (a.certifications ?? []).some((c) => {
          const days = c.expiryDate ? daysUntilExpiry(c.expiryDate) : null;
          return days !== null && days >= 0 && days <= 90;
        }),
      },
      { value: 'none', label: 'None recorded', match: (a) => (a.certifications ?? []).length === 0 },
    ],
  },
  {
    kind: 'rule',
    key: 'attendance',
    label: 'Who attends the audit',
    group: 'paperwork',
    choices: [
      {
        value: 'other',
        // The compliance concern: the person attending is not the person we vetted.
        label: 'Somebody other than the person empanelled',
        match: (a) => a.workDoneBySomeoneElse === true,
      },
      { value: 'self', label: 'The person themselves', match: (a) => a.workDoneBySomeoneElse !== true },
    ],
  },

  // ── Dates ───────────────────────────────────────────────────────────────────────────────
  { kind: 'date', key: 'joined', label: 'Joined between', group: 'dates', dateOf: (a) => a.joiningDate },
  {
    kind: 'date',
    key: 'left',
    label: 'Left between',
    group: 'dates',
    hint: 'Resignation and termination dates together — the roster reads them as one leaving date.',
    dateOf: leavingDate,
  },
];

/**
 * What is currently narrowing the list.
 *
 * One object rather than a state variable per axis, because "show me what is applied and let me
 * clear it in one action" is only cheap when there is one thing to read and one thing to reset.
 */
export interface RosterFilterState {
  /** Chosen values per filter key. An absent or empty entry narrows nothing. */
  choices: Record<string, string[]>;
  /** Inclusive `from`/`to` per date filter, as `YYYY-MM-DD`. Either half may stand alone. */
  ranges: Record<string, { from?: string; to?: string }>;
  segment: string;
  search: string;
}

export const EMPTY_FILTERS: RosterFilterState = { choices: {}, ranges: {}, segment: 'all', search: '' };

/**
 * How many criteria are in force — the number on the Filters button.
 *
 * Counted per chosen VALUE, not per axis, so it is always exactly the number of pills in the
 * bar underneath. A badge saying 3 above four pills is a badge the reader has to reconcile.
 */
export function activeFilterCount(state: RosterFilterState): number {
  return Object.values(state.choices).reduce((n, v) => n + v.length, 0)
    + Object.values(state.ranges).filter((r) => r.from || r.to).length
    + (state.segment !== 'all' ? 1 : 0)
    + (state.search.trim() ? 1 : 0);
}

/** The calendar day of a stored timestamp, so a range compares dates with dates. */
const dayOf = (value?: string | null): string | null => {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
};

/** Does this person satisfy one filter's chosen values? Values within a filter are OR. */
function matchesFilter(def: RosterFilter, a: RosterPerson, state: RosterFilterState): boolean {
  if (def.kind === 'date') {
    const range = state.ranges[def.key];
    if (!range || (!range.from && !range.to)) return true;
    const day = dayOf(def.dateOf(a));
    // No date on the record cannot satisfy a date range, and saying "include it anyway" would
    // quietly widen every joined-between question by the 25 people carrying no joining date.
    if (!day) return false;
    if (range.from && day < range.from) return false;
    if (range.to && day > range.to) return false;
    return true;
  }
  const chosen = state.choices[def.key];
  if (!chosen || chosen.length === 0) return true;
  if (def.kind === 'field') {
    const values = def.valuesOf(a);
    if (values.length === 0) return chosen.includes(NOT_RECORDED);
    return values.some((v) => chosen.includes(v));
  }
  return def.choices.some((c) => chosen.includes(c.value) && c.match(a));
}

/** The one text search, over the fields somebody would type to find a person. */
function matchesSearch(a: RosterPerson, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return `${a.displayName} ${a.assayerCode} ${a.city} ${a.district} ${a.state} ${a.phone} ${a.email ?? ''} ${(a.skills ?? []).join(' ')}`
    .toLowerCase().includes(q);
}

/**
 * The people left after everything currently applied. Separate filters are AND.
 *
 * `except` leaves one axis out, which is how each option shows the count it would give you: a
 * facet count that included its own filter would read "Kerala 214, Goa 0" the moment Kerala was
 * ticked, and every other option on that axis would look empty.
 */
export function applyRosterFilters(
  rows: RosterPerson[],
  state: RosterFilterState,
  defs: RosterFilter[] = ROSTER_FILTERS,
  except?: string,
): RosterPerson[] {
  const segment = segmentFor(state.segment);
  return rows.filter((a) => {
    if (!segment.match(a)) return false;
    if (!matchesSearch(a, state.search)) return false;
    return defs.every((d) => d.key === except || matchesFilter(d, a, state));
  });
}

/** The options for one field filter, read off the people who arrived, commonest first. */
export function fieldChoices(
  def: FieldFilter,
  rows: RosterPerson[],
): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  let blank = 0;
  for (const a of rows) {
    const values = def.valuesOf(a);
    if (values.length === 0) { blank += 1; continue; }
    // A person with three skills counts once against each, never three times against one.
    for (const v of new Set(values)) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const out = [...counts.entries()]
    .map(([value, count]) => ({ value, label: def.labelOf ? def.labelOf(value) : value, count }))
    .sort((x, y) => x.label.localeCompare(y.label));
  if (blank > 0 && def.blankLabel !== null) {
    out.push({ value: NOT_RECORDED, label: def.blankLabel ?? 'Not recorded', count: blank });
  }
  return out;
}

/** The options for one rule filter, with the count each would leave on screen. */
export function ruleChoices(
  def: RuleFilter,
  rows: RosterPerson[],
): { value: string; label: string; count: number }[] {
  return def.choices.map((c) => ({
    value: c.value,
    label: c.label,
    count: rows.reduce((n, a) => n + (c.match(a) ? 1 : 0), 0),
  }));
}

/** The filters worth showing against the roster that actually arrived. */
export function availableFilters(rows: RosterPerson[], defs: RosterFilter[] = ROSTER_FILTERS): RosterFilter[] {
  return defs.filter((d) => (d.kind === 'rule' && d.available ? d.available(rows) : true));
}

/**
 * Every criterion in force, as removable pills.
 *
 * `value` names the one choice to drop; a pill without one clears its whole filter. The reader
 * has to be able to undo exactly the thing they can see, which is the difference between a
 * filter bar and a status line.
 */
export interface AppliedFilter {
  key: string;
  /** The individual choice this pill stands for, when it stands for one. */
  value?: string;
  /** What the filter is called, for a screen reader's "remove X" and for grouping. */
  filterLabel: string;
  /** The words on the pill. */
  label: string;
}

export function describeFilters(
  state: RosterFilterState,
  defs: RosterFilter[] = ROSTER_FILTERS,
): AppliedFilter[] {
  const out: AppliedFilter[] = [];
  if (state.segment !== 'all') {
    const segment = segmentFor(state.segment);
    out.push({ key: 'segment', filterLabel: 'View', label: segment.label });
  }
  if (state.search.trim()) {
    out.push({ key: 'search', filterLabel: 'Search', label: `Search "${state.search.trim()}"` });
  }
  for (const def of defs) {
    if (def.kind === 'date') {
      const range = state.ranges[def.key];
      if (!range || (!range.from && !range.to)) continue;
      const words = range.from && range.to
        ? `${range.from} to ${range.to}`
        : (range.from ? `on or after ${range.from}` : `on or before ${range.to}`);
      out.push({ key: def.key, filterLabel: def.label, label: `${def.label} ${words}` });
      continue;
    }
    for (const value of state.choices[def.key] ?? []) {
      out.push({ key: def.key, value, filterLabel: def.label, label: `${def.label}: ${choiceLabel(def, value)}` });
    }
  }
  return out;
}

/** The words for one chosen value — the option's own label, never the stored code. */
function choiceLabel(def: RosterFilter, value: string): string {
  if (def.kind === 'field') {
    if (value === NOT_RECORDED) return def.blankLabel ?? 'Not recorded';
    return def.labelOf ? def.labelOf(value) : value;
  }
  if (def.kind === 'rule') return def.choices.find((c) => c.value === value)?.label ?? value;
  return value;
}

/**
 * The filter state in the query string, so a narrowed roster can be bookmarked and pasted to a
 * colleague — which is how "the 47 people in Kerala who cannot be paid" becomes a thing two
 * people can look at rather than a thing one person re-derives.
 *
 * `f_` prefixes every key so nothing here can collide with the params this screen already uses
 * (`assayer`, `register`, `view`, `edit`), and repeated params carry a multi-select rather than
 * inventing a separator that a state or skill name could contain.
 */
const PREFIX = 'f_';
const RANGE_SEPARATOR = '..';

export function parseFilters(
  params: URLSearchParams,
  defs: RosterFilter[] = ROSTER_FILTERS,
): RosterFilterState {
  const choices: Record<string, string[]> = {};
  const ranges: Record<string, { from?: string; to?: string }> = {};
  for (const def of defs) {
    const raw = params.getAll(`${PREFIX}${def.key}`).filter(Boolean);
    if (raw.length === 0) continue;
    if (def.kind === 'date') {
      const [from, to] = raw[0].split(RANGE_SEPARATOR);
      if (from || to) ranges[def.key] = { from: from || undefined, to: to || undefined };
    } else {
      choices[def.key] = raw;
    }
  }
  const wanted = params.get('segment');
  return {
    choices,
    ranges,
    // An unrecognised segment (an old link, a typo) shows everybody rather than an empty page.
    segment: wanted && ROSTER_SEGMENTS.some((s) => s.key === wanted) ? wanted : 'all',
    search: params.get('q') ?? '',
  };
}

/**
 * Writes the state back, leaving every param this screen does not own untouched — `?assayer=`
 * and `?register=` are in bookmarks and notification payloads, and a filter change must not
 * drop them.
 */
export function writeFilters(
  params: URLSearchParams,
  state: RosterFilterState,
  defs: RosterFilter[] = ROSTER_FILTERS,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const def of defs) next.delete(`${PREFIX}${def.key}`);
  next.delete('segment');
  next.delete('q');
  for (const def of defs) {
    if (def.kind === 'date') {
      const range = state.ranges[def.key];
      if (range && (range.from || range.to)) {
        next.append(`${PREFIX}${def.key}`, `${range.from ?? ''}${RANGE_SEPARATOR}${range.to ?? ''}`);
      }
    } else {
      for (const v of state.choices[def.key] ?? []) next.append(`${PREFIX}${def.key}`, v);
    }
  }
  if (state.segment !== 'all') next.set('segment', state.segment);
  if (state.search.trim()) next.set('q', state.search.trim());
  return next;
}

/** Ticking and unticking one option, without the caller touching the shape of the state. */
export function toggleChoice(state: RosterFilterState, key: string, value: string): RosterFilterState {
  const current = state.choices[key] ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  const choices = { ...state.choices };
  if (next.length) choices[key] = next; else delete choices[key];
  return { ...state, choices };
}

/**
 * Dropping one pill: a single value, a whole axis, the segment, or the search.
 *
 * Removing rather than toggling. A pill is only ever shown for something already applied, but a
 * clear that could also *add* is a function whose worst case is the opposite of its name.
 */
export function clearFilter(state: RosterFilterState, key: string, value?: string): RosterFilterState {
  if (key === 'segment') return { ...state, segment: 'all' };
  if (key === 'search') return { ...state, search: '' };
  if (value !== undefined) {
    const left = (state.choices[key] ?? []).filter((v) => v !== value);
    const remaining = { ...state.choices };
    if (left.length) remaining[key] = left; else delete remaining[key];
    return { ...state, choices: remaining };
  }
  const choices = { ...state.choices };
  const ranges = { ...state.ranges };
  delete choices[key];
  delete ranges[key];
  return { ...state, choices, ranges };
}
