import type { CSSProperties } from 'react';
import {
  AssayerLifecycleStatus, AssayerUnavailableReason, ASSAYER_RECORD_FIELDS, CRITICAL_ASSAYER_RECORD_FIELDS, missingAssayerRecordFields, nextAssayerLifecycleStates, ONBOARDING_STAGES, ONBOARDING_NEXT_STEP, isOnboardingStage, onboardingNextStep as sharedOnboardingNextStep, looksMasked, hasLeftWorkforce,
} from '@fapoms/shared';

/** Shared shape and colours for the workforce record, used by the roster and its forms. */

export interface Assayer {
  id: string;
  assayerCode: string;
  employeeId: string | null;
  employeeCode: string | null;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string | null;
  phone: string;
  alternatePhone: string | null;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  status: string;
  lifecycleStatus: string;
  organizationId: string | null;
  panNumber: string | null;
  bankAccountNumber: string | null;
  ifscCode: string | null;
  notes: string | null;
  employmentType: string;
  joiningDate: string | null;
  exitDate: string | null;
  terminationDate: string | null;
  managerId: string | null;
  department: string | null;
  region: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactRelation: string | null;
  photograph: string | null;
  skills: string[] | null;
  certifications: { name: string; expiryDate: string }[] | null;
  languages: string[] | null;
  preferredRegions: string[] | null;
  specializations: string[] | null;
  experienceYears: number;
  performanceRating: number;
  leaves: { startDate: string; endDate: string }[] | null;
  workingHours: { start: string; end: string } | null;
  maxDailyWorkload: number;
  maxWeeklyWorkload: number;

  /**
   * Facts the appraiser roster carries that the record had no home for.
   *
   * `engagementType`, `unavailableReason` and `workDoneBySomeoneElse` come out of the roster's
   * single "Active / Inactive" column, which was holding three separate things in one cell.
   * The last is a compliance matter — the person empanelled is not the person attending — and
   * 21 rows of the roster say so.
   *
   * Optional because a record created in this app rather than imported has none of them.
   */
  aadhaarNumber?: string | null;
  bankName?: string | null;
  dateOfBirth?: string | null;
  qualification?: string | null;
  vstsCode?: string | null;
  documentsLink?: string | null;
  hrOwnerName?: string | null;
  engagementType?: string | null;
  unavailableReason?: string | null;
  workDoneBySomeoneElse?: boolean;

  /**
   * How the coordinate above got there, so the record can say whether to trust it.
   *
   * Columns on the entity since the precision work; the record page was simply not reading
   * them, so a home pin sitting on the middle of a state looked exactly like one somebody had
   * placed on the front door. 98 people have no coordinate at all and 76 of those are ACTIVE —
   * `geoSource` null reads as "not confirmed", which is the honest answer for all of them.
   * See components/GeoPrecisionBadge.tsx for the nine sources and the three verdicts.
   */
  geoSource?: string | null;
  geoAccuracyMeters?: number | null;
  geoMatchedName?: string | null;
}

/**
 * What has to happen next for somebody who is still joining, and the stages that count as
 * joining — both now read from `@fapoms/shared`, where the planner reads them too.
 *
 * They used to be a hand-written copy of the map in the backend's `recommendation.engine.ts`,
 * held in step by a spec that pinned the strings word for word. The planner prints those words
 * when it refuses to offer an unfinished joiner work ("Onboarding not finished: in training —
 * mark training complete on the HR roster to activate") and this is the screen it sends people
 * to, so the two have to agree; a spec pinning a copy notices a disagreement only after it has
 * been written, and could never guard the four keys or the stage list behind them.
 *
 * Re-exported rather than left for each caller to import from `@fapoms/shared` directly, because
 * these sit beside `isReadyToActivate` and the queue predicates that use them, and moving the
 * import would have been a second edit in nine files for no reader's benefit.
 */
export { ONBOARDING_NEXT_STEP, ONBOARDING_STAGES, isOnboardingStage };

/** The next-step sentence for this person, or null once they are past joining. */
export const onboardingNextStep = (a: Pick<Assayer, 'lifecycleStatus'>): string | null =>
  sharedOnboardingNextStep(a.lifecycleStatus);

/**
 * Is this person waiting on somebody in HR to check their documents?
 *
 * DOCUMENT_VERIFICATION and BACKGROUND_VERIFICATION are real, enforced lifecycle stages, and
 * until now no screen listed the people sitting in either of them — the roster's "Onboarding"
 * chip put all four joining stages in one pile, so "whose papers am I supposed to check today"
 * had no answer anywhere in the application.
 *
 * WHAT THIS CANNOT SEE, stated rather than papered over: the roster list endpoint returns the
 * assayer row and nothing else — no document rows — so this queue is "at the document stage",
 * not "has scans waiting for a verdict". Those differ, and they differ badly on this data:
 * `soft_copy_received` is ticked on 10,977 document rows that carry zero files. A per-assayer
 * document summary on `GET /assayers` (files attached, verified, awaiting a verdict) is what
 * would make this queue mean the stronger thing; it is written up in the handover as a backend
 * ask rather than guessed at here.
 */
export const isAwaitingDocumentCheck = (a: Pick<Assayer, 'lifecycleStatus'>): boolean =>
  a.lifecycleStatus === AssayerLifecycleStatus.DOCUMENT_VERIFICATION;

/** Waiting on a background check to be recorded against them. */
export const isAwaitingBackgroundCheck = (a: Pick<Assayer, 'lifecycleStatus'>): boolean =>
  a.lifecycleStatus === AssayerLifecycleStatus.BACKGROUND_VERIFICATION;

/**
 * Nothing left blocking: the state machine allows the step to ACTIVE and the record has no
 * critical field missing.
 *
 * Both halves are asked of the one authority that already answers them —
 * `nextAssayerLifecycleStates` for the legal move, `missingCriticalFields` for the record — so
 * this queue cannot start disagreeing with the button on the record page or with the gap chips
 * beside it. It deliberately does NOT re-check the person's documents or background check:
 * those are what the two stages before this one are for, and re-judging them here would put a
 * second opinion on screen next to the queue that owns the question.
 */
export const isReadyToActivate = (a: Pick<Assayer, 'lifecycleStatus'> & Partial<Assayer>): boolean =>
  nextAssayerLifecycleStates(a.lifecycleStatus).includes(AssayerLifecycleStatus.ACTIVE)
  && isOnboardingStage(a.lifecycleStatus)
  && missingCriticalFields(a).length === 0;

/**
 * Recorded as having died — which this system files as a reason, not as a stage.
 *
 * There is no DECEASED lifecycle value. The roster importer maps a Status cell reading "Expired"
 * to INACTIVE plus `unavailableReason = DECEASED`, so the fact lives in a different column from
 * every other way of leaving, and any rule written by listing lifecycle values misses it.
 *
 * Kept as its own name because two callers need the narrower question — the gap chips say "no
 * longer with us" rather than "left" — but the broad question is answered by shared code now.
 */
export const isRecordedDeceased = (a: Partial<Assayer>): boolean =>
  a.lifecycleStatus === AssayerLifecycleStatus.INACTIVE
  && String(a.unavailableReason ?? '').toUpperCase() === AssayerUnavailableReason.DECEASED;

/**
 * Has this person left, by status? Delegated to `@fapoms/shared`.
 *
 * This screen kept its own list of exit stages, and that list is precisely what went stale: the
 * deceased arm was added to both backend copies of the rule and never to this one, so a man
 * recorded as having died stayed in "Incomplete record" and "Cannot be paid", where the screen
 * asked a clerk to chase his bank details. Two of three copies being right is what hid it.
 */
const hasLeftByStatus = (a: Partial<Assayer>): boolean =>
  hasLeftWorkforce({ lifecycleStatus: a.lifecycleStatus, unavailableReason: a.unavailableReason });

/**
 * Still on the books and still workable — the population the server's compliance figures count
 * (`ON_ROSTER` in hr-workforce.service.ts), and the one the roster's gap chips are allowed to nag
 * about. Those chips are worklists: every row is somebody a clerk is meant to ring up.
 *
 * They used to match anybody with a blank field, so 444 people who had resigned or been
 * terminated sat in "Incomplete record" and "Cannot be paid" as though their bank details were
 * worth chasing, and the chip and the Overview described different populations from the same data
 * — the Overview said 717, the chip counted from 1,163 — with nothing on either screen to say why.
 *
 * Shaped like the server's rule on purpose: gone by their stage, OR gone by a date. Both halves
 * are needed. The date alone misses 25 people carrying a departed lifecycle and no leaving date —
 * the roster import never had one — and the stage alone misses a departure typed as a date while
 * the lifecycle was left where it was.
 *
 * The deceased arm is the one this copy was still missing, and it cost exactly one person: AS0055,
 * recorded deceased with no leaving date, counted as current staff here while the server counted
 * 717. He was therefore in both worklists — asking a clerk to go and chase a dead colleague's bank
 * details. The server had already been fixed for this (`HAS_LEFT` in hr-workforce.service.ts,
 * `hasLeft` in data-integrity.service.ts); the fix never crossed to this side, which is what a
 * rule written out three times does.
 */
export const stillWorkable = (a: Partial<Assayer> & Pick<Assayer, 'lifecycleStatus'>): boolean =>
  !hasLeftByStatus(a)
  && !a.exitDate
  && !a.terminationDate;

/**
 * The three record fields that are never printed in full without a deliberate, recorded click.
 *
 * Keyed by the column the record carries. `segment` is what `GET /assayers/:id/sensitive/:field`
 * takes, `what` is the name a clerk uses for it in the reveal control's own sentences ("Show the
 * whole Aadhaar number"). Three vocabularies for one set of fields — column, route, English — is a
 * copy waiting to happen, so they are paired once here rather than at each screen that shows one.
 */
export const SENSITIVE_FIELDS = {
  panNumber: { segment: 'pan', what: 'PAN' },
  aadhaarNumber: { segment: 'aadhaar', what: 'Aadhaar number' },
  bankAccountNumber: { segment: 'bank', what: 'account number' },
} as const;

export type SensitiveRecordKey = keyof typeof SENSITIVE_FIELDS;

export const isSensitiveKey = (key: string): key is SensitiveRecordKey =>
  Object.prototype.hasOwnProperty.call(SENSITIVE_FIELDS, key);

/**
 * Is this string a mask rather than a number?
 *
 * No PAN, Aadhaar or bank account contains a bullet or an asterisk, so their presence is a
 * reliable "this is not the value, it is a picture of it". The server refuses a write whose value
 * looks like a mask; this is the same test on the near side, so a masked value is caught before it
 * is sent rather than coming back as a 400 the clerk has to interpret.
 *
 * It is now the same test rather than a matching copy of it. The copy asked for three or more
 * covering characters while the server asks for one, so the server's own mask of a five- or
 * six-character value — `*2345`, `**3456` — was a mask this side did not recognise: the form sent
 * it back, the server refused it, and the clerk was shown a 400 about a field they never opened.
 * That is the failure this check exists to prevent, and it was a live one on every short bank
 * account and document number. Two implementations of one rule cannot be held in step by care, so
 * there is one, and it lives beside the guard that does the refusing.
 */
export { looksMasked as looksLikeMask };

/**
 * An identifier as it is allowed to appear on screen: last four characters, the rest covered.
 *
 * The server masks these on the way out, so on a healthy stack this passes its answer straight
 * through. It masks anyway when handed something unmasked, and that is the point rather than
 * belt-and-braces caution: this function is the screen's own promise that it does not print a
 * whole Aadhaar. A backend that regressed, a cached payload from before the change, a fixture in
 * a test — each of those would otherwise put a complete KYC identifier on a screen that a clerk's
 * colleague can read over their shoulder, and nothing in the frontend would have noticed.
 *
 * Note what this is NOT saying. The number is stored complete and encrypted; only the display is
 * partial. Seeing all of it is a click away for the two roles entitled to it, and that click is
 * recorded.
 */
export function maskedIdentifier(raw?: string | null): string | null {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  if (looksMasked(v)) return v;
  const tail = v.slice(-4);
  return `${'•'.repeat(Math.max(v.length - tail.length, 4))}${tail}`;
}

export const STATUS_COLORS: Record<string, string> = {
  [AssayerLifecycleStatus.ACTIVE]: 'var(--success)',
  [AssayerLifecycleStatus.ON_LEAVE]: 'var(--warning)',
  [AssayerLifecycleStatus.INVITED]: 'var(--accent)',
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: 'var(--accent)',
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: 'var(--accent)',
  [AssayerLifecycleStatus.TRAINING]: 'var(--warning)',
  [AssayerLifecycleStatus.SUSPENDED]: 'var(--danger)',
  [AssayerLifecycleStatus.INACTIVE]: 'var(--text-muted)',
  [AssayerLifecycleStatus.RESIGNED]: 'var(--text-muted)',
  [AssayerLifecycleStatus.TERMINATED]: 'var(--danger)',
  [AssayerLifecycleStatus.ARCHIVED]: 'var(--text-muted)',
};

/**
 * "blocks payouts", but never "blocks tDS deduction and statutory filing".
 *
 * The shared list stores each consequence sentence-cased ("TDS deduction and statutory filing",
 * "Payouts"), and the screens print it mid-sentence after the word "blocks", so it has to be
 * de-capitalised. Doing that with a blind `charAt(0).toLowerCase()` mangles the two entries that
 * begin with an acronym — a clerk reading "needed — blocks tDS deduction" is being shown a typo
 * by the software, on the field most likely to make them stop and ask whether the screen is
 * trustworthy. A leading run of capitals is a name, not a first letter, so it is left alone.
 *
 * It lives here, beside the two lists that need it, because it did not: the rule was written out
 * by hand in four places and only fixed in two, so the wizard printed the acronym correctly while
 * the roster drawer and the record summary beside it still printed "tDS". One copy is the only
 * arrangement in which fixing it once fixes it everywhere.
 */
export const blocksPhrase = (blocks: string): string =>
  (/^[A-Z]{2}/.test(blocks) ? blocks : blocks.charAt(0).toLowerCase() + blocks.slice(1));

/**
 * The fields that must be present before an assayer can be paid or sent to a site.
 * Both the full profile page and the roster drawer show the same gap list from here,
 * so the two surfaces can never disagree about who is missing what — the earlier
 * copy-paste had already begun to drift ("payouts" vs "Payouts").
 */
/**
 * The record's critical fields, and what each blank one blocks.
 *
 * These lived here and again in the HR service's SQL, and the two disagreed — this side counted
 * a missing phone as an incomplete record and that side did not, so the roster's "Incomplete
 * record" filter and the paperwork page's incomplete list named different people. The imported
 * client rosters have no phone column at all, so the disagreement fired on the common case
 * rather than an edge one. One list now, in `@fapoms/shared`, read from both.
 */
export const CRITICAL_FIELDS = CRITICAL_ASSAYER_RECORD_FIELDS.map((f) => ({
  key: f.key as keyof Assayer,
  label: f.label,
  // The screens phrase this as "blocks X"; the shared list carries it sentence-cased.
  why: blocksPhrase(f.blocks),
}));

/**
 * Column name to the words a person reads, derived from the one list of record fields.
 *
 * This was a third hand-written copy of that list, and it covered five of the eleven columns —
 * so anything outside those five printed its raw database name on screen: a page telling an HR
 * clerk that someone is missing their `emergency_contact_phone`. Deriving it means a field
 * added to the record cannot arrive unlabelled.
 */
export const FIELD_LABELS: Record<string, string> = Object.fromEntries(
  ASSAYER_RECORD_FIELDS.map((f) => [f.column, f.label]),
);

/** The critical fields this record is still missing (blank or whitespace-only). */
export function missingCriticalFields(a: Partial<Assayer> | null | undefined) {
  return missingAssayerRecordFields(a as Record<string, unknown> | null | undefined).map((f) => ({
    key: f.key as keyof Assayer,
    label: f.label,
    why: blocksPhrase(f.blocks),
  }));
}

/** Rupees with an em-dash for empty, matching the workforce screens. */
export { money } from '../../utils/money';

/**
 * The small uppercase caption style repeated across the workforce record surfaces.
 *
 * Was 10.5px. On the record page this caption is the ONLY thing that names each of the forty
 * facts — "IFSC", "Emergency relation", "Engaged as" — and at 10.5px in capitals it is a
 * footnote sitting over the value it is supposed to label. 12px is the floor for this area; see
 * `label` in hr-ui.tsx, which this deliberately matches so the record and the pages around it
 * do not caption the same kind of thing at two different sizes.
 */
export const fieldLabelStyle: CSSProperties = {
  fontSize: '12px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)',
};

/** The subset of a form field's definition that decides how its value is sent. */
export interface EditableFieldShape {
  key: string;
  type?: string;
  vocab?: 'skills' | 'languages' | 'certifications';
  /** Only used to name the field in a refusal; every real definition already carries one. */
  label?: string;
}

/** Phone fields, which carry a country code everywhere else in the system. */
const TEL_FIELDS = new Set(['phone', 'alternatePhone', 'emergencyContactPhone']);

/**
 * The four columns that are NOT NULL with a database default.
 *
 * Experience, the HR rating and the two workload caps have no "empty": sending null for any of
 * them is a constraint violation, which surfaces as a bare 500. A blank box means "leave it
 * alone", which is the only honest reading available.
 */
const NO_EMPTY_VALUE = new Set(['experienceYears', 'performanceRating', 'maxDailyWorkload', 'maxWeeklyWorkload']);

const parseListValue = (raw?: string): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch { /* legacy comma text — fall through */ }
  return raw.split(',').map((x) => x.trim()).filter(Boolean);
};

/**
 * Turn the edit form's string state into the body of a PUT.
 *
 * Extracted from the submit handler so the one rule that matters here can be tested: a box the
 * operator emptied must reach the server as an empty value, not vanish from the request. It
 * used to vanish — every field whose value was `''` was skipped — so clearing a phone number,
 * an address, a note or the last skill in a list saved nothing while reporting success.
 * Deleting a value was the single edit this form could not perform.
 *
 * "Empty" is per type, because the columns differ: a date takes null, a list takes `[]`, text
 * takes `''`, and the four NOT NULL numerics have no empty at all.
 */
export function buildAssayerEditBody(
  fields: EditableFieldShape[],
  form: Record<string, string | undefined>,
  /**
   * What the record holds now. The hours and certifications pairs need it; the three masked
   * identifiers need it to tell "nobody touched this" from "somebody typed over the mask", so it
   * is optional in their part of it — a create has no record and nothing masked to compare with.
   */
  current: Pick<Assayer, 'workingHours' | 'certifications'>
    & Partial<Pick<Assayer, SensitiveRecordKey>>,
): { body: Record<string, unknown>; problems: string[] } {
  const body: Record<string, any> = {};
  const problems: string[] = [];

  /**
   * The working day is a pair, and the server will only store a complete one.
   *
   * Both boxes empty means "no hours recorded", which the column holds as null. Both filled is
   * a range. One filled is neither, and the two obvious ways to handle it are both wrong:
   * dropping it silently is the bug this function exists to fix, and storing null throws away
   * the time the operator just typed. So it is reported, and the form says which box is missing
   * instead of letting the server answer with "2 fields need attention".
   */
  const editsHours = form.workingHoursStart !== undefined || form.workingHoursEnd !== undefined;
  if (editsHours) {
    const start = form.workingHoursStart ?? current.workingHours?.start ?? '';
    const end = form.workingHoursEnd ?? current.workingHours?.end ?? '';
    if (start && end) body.workingHours = { start, end };
    else if (!start && !end) body.workingHours = null;
    else problems.push(start ? 'Working hours need an end time as well as a start.'
                             : 'Working hours need a start time as well as an end.');
  }

  for (const field of fields) {
    const val = form[field.key];
    if (val === undefined) continue;
    const cleared = val === '';

    /**
     * Never save a picture of a number over the number.
     *
     * PAN, Aadhaar and bank accounts come back from the server masked, so any box that was filled
     * from the record rather than from a deliberate reveal holds `******234F`. Saving that would
     * destroy a real KYC identifier and replace it with something that looks plausible on every
     * screen afterwards — a data loss with no symptom. The server refuses any write containing a
     * mask for exactly that reason.
     *
     * Two cases, and they must not be treated alike. A mask IDENTICAL to what the record holds is
     * a field nobody touched — every form here fills its boxes from the record — and dropping it
     * is simply the truth: nothing about it changed. Refusing instead would fail an unrelated
     * save, on a field the clerk never went near, with a message about revealing something they
     * were not editing. Anything else masked is a value somebody typed on top of a mask, which is
     * the destructive case, and that is refused in words that say what to do.
     */
    if (isSensitiveKey(field.key) && !cleared && looksMasked(val)) {
      if (val === String((current as Record<string, unknown>)[field.key] ?? '')) continue;
      problems.push(
        `The ${(field.label ?? field.key).toLowerCase()} on screen is only the last few digits, `
        + 'not the whole number. Show it in full first, then change it.',
      );
      continue;
    }

    if (field.key === 'workingHoursStart' || field.key === 'workingHoursEnd') {
      continue; // handled as a pair above
    } else if (field.key === 'certifications') {
      const expiryByName = new Map((current.certifications || []).map((c) => [c.name, c.expiryDate]));
      body.certifications = parseListValue(val).map((name) => ({ name, expiryDate: expiryByName.get(name) || '' }));
    } else if (field.vocab) {
      body[field.key] = parseListValue(val);
    } else if (field.type === 'number') {
      if (!cleared) body[field.key] = Number(val);
      else if (!NO_EMPTY_VALUE.has(field.key)) body[field.key] = null;
    } else if (field.type === 'date') {
      body[field.key] = cleared ? null : new Date(val).toISOString();
    } else if (TEL_FIELDS.has(field.key)) {
      // The same +91 normalisation the create form applies. Without it a number edited here is
      // stored bare while every number created there carries a country code, and the two forms
      // of the same phone compare as different everywhere downstream.
      const digits = val.replace(/\D/g, '');
      body[field.key] = digits ? (digits.startsWith('91') ? `+${digits}` : `+91${digits}`) : val;
    } else {
      body[field.key] = val;
    }
  }

  return { body, problems };
}

/**
 * The boxes whose value differs from what the record held when the form opened.
 *
 * The edit form pre-fills every field with its current value, which is right — an edit screen
 * shows what is there. But handing all of that to `buildAssayerEditBody` meant every save
 * rewrote every column: correcting a phone number sent the address, the bank account and the
 * workload caps back with whatever they held when the modal opened, so two people editing
 * different sections of the same person silently overwrote each other. Both saves returned 200.
 *
 * Working hours travel as a pair whenever either half moved. The server stores them as one
 * object, so a changed start without the unchanged end reads as "clear the end time".
 */
export function changedFormKeys(
  form: Record<string, string>,
  initial: Record<string, string>,
): string[] {
  const changed = Object.keys(form).filter((k) => form[k] !== initial[k]);
  const HOURS = ['workingHoursStart', 'workingHoursEnd'];
  if (HOURS.some((k) => changed.includes(k))) {
    for (const k of HOURS) if (!changed.includes(k)) changed.push(k);
  }
  return changed;
}
