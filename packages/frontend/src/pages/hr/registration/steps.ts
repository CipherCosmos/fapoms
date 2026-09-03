import { INDIAN_STATES, missingAssayerRecordFields } from '@fapoms/shared';
import type { FieldDef } from '../AssayerForms';
import { ASSAYER_CODE_FIELD, EDIT_FIELDS } from '../AssayerForms';
import { blocksPhrase, type Assayer } from '../assayer-shared';

/**
 * Registering somebody, as the sequence it actually is.
 *
 * The screen this replaces was a mode switch — "⚡ Express Mode" beside "📋 Advanced (6 Tabs)" —
 * and neither mode was a registration. Express was one flat grid of eleven boxes; Advanced was
 * six tabs with a Previous/Next pair, no progress indicator and no per-step validation. Both
 * ended at the same single `POST /assayers`, so the parts of registration that are not a form
 * field — the map pin, the scans of the papers the person brought in, the document numbers a
 * verification refuses without — had no home at all and were left to be discovered later on the
 * record, two tabs deep, by somebody who was not holding the paperwork.
 *
 * The ordering is the order the desk actually works in, and one constraint forces most of it:
 * **the map pin, the scans and the references all need an id**, because they post to
 * `/geo/precision/assayer/:id/pin`, `/assayers/:id/document/:requirement/file` and
 * `/assayers/:id/reference`. So the record is created at the end of step 1 and every later step
 * edits a real row. That is also what makes a half-finished registration resumable: there is no
 * draft store to lose, only a person on the roster with some fields still blank.
 *
 * What no step may do is require a device. The whole point of this flow is that a person with no
 * smartphone is registerable to fully ACTIVE from the desk, so phone, email and app access are
 * optional at every step and the Review step says so in as many words.
 */

export type RegistrationStepKey =
  | 'person' | 'address' | 'identity' | 'documents' | 'people' | 'review';

export const REGISTRATION_STEP_KEYS: readonly RegistrationStepKey[] = [
  'person', 'address', 'identity', 'documents', 'people', 'review',
] as const;

export interface RegistrationStep {
  key: RegistrationStepKey;
  /** The words on the progress rail. Short enough to read at a glance, no jargon. */
  title: string;
  /** One line under the step heading saying what this step is for. */
  caption: string;
}

export const REGISTRATION_STEPS: readonly RegistrationStep[] = [
  {
    key: 'person',
    title: 'The person',
    caption: 'Who they are, and which state they will work in. Saving this page creates their record.',
  },
  {
    key: 'address',
    title: 'Where they live',
    caption: 'Their address, and the exact spot on the map that travel and day planning use.',
  },
  {
    key: 'identity',
    title: 'ID and bank',
    caption: 'The numbers off their cards and passbook. Nothing here is needed to save the record.',
  },
  {
    key: 'documents',
    title: 'Papers and scans',
    caption: 'Scan or photograph each paper they brought in, and type the number written on it.',
  },
  {
    key: 'people',
    title: 'Contacts and pay',
    caption: 'Who to call, who vouches for them, what they can do, and what they are paid.',
  },
  {
    key: 'review',
    title: 'Check and finish',
    caption: 'What is on file, and what is still missing. Nothing here has to be full to finish.',
  },
];

/**
 * The two facts about a person that only exist at admission.
 *
 * `assayerCode` cannot be edited afterwards (it is their login username), and the six regions
 * they are willing to travel to have never had a box on any form despite being a real `text[]`
 * column the planner reads. Everything else the flow collects comes from `EDIT_FIELDS`, so the
 * wizard and the record page cannot drift into two different ideas of what a PAN box is.
 */
const PREFERRED_REGIONS_FIELD: FieldDef = {
  key: 'preferredRegions', label: 'Regions they will travel to', regions: true, full: true,
  hint: 'Optional. Tick every region they are willing to work in. Leave it blank if they only work near home.',
};

/**
 * The state box, made mandatory here and nowhere else.
 *
 * `EDIT_FIELDS` leaves it optional on purpose — the record page is where a gap gets filled in,
 * and a form that refuses to save without a state cannot be used to fill in anything else. At
 * admission it is different: `CreateAssayerRequestDto` declares `@IsString() @IsNotEmpty()` on
 * state, so a create without one is a 400 the clerk would meet after typing the whole page.
 */
const STATE_AT_ADMISSION: FieldDef = {
  key: 'state', label: 'State they work in', required: true, options: INDIAN_STATES,
  hint: 'This sets their region, their zone and which public holidays apply to them.',
};

const OVERRIDES: Record<string, FieldDef> = { state: STATE_AT_ADMISSION };

/**
 * Fields a registration must never offer, even though the record has them.
 *
 * `exitDate` and `terminationDate` are the day somebody left, stamped automatically when their
 * status is changed; `unavailableReason` is why they are off the roster. A form that asks a clerk
 * when a person they are enrolling today resigned is inviting a value that means nothing. The two
 * ratings are the same kind of mistake in the other direction: `performanceRating` is scored by
 * the recommendation engine when it ranks candidates, and a number typed before the person has
 * done a single job is an opinion the engine cannot tell from a measurement.
 */
const NOT_AT_ADMISSION = new Set([
  'exitDate', 'terminationDate', 'unavailableReason', 'performanceRating',
]);

/** Every record field the flow can write, defined once, in the record's own vocabulary. */
export const REGISTRATION_FIELDS: FieldDef[] = [
  ASSAYER_CODE_FIELD,
  ...EDIT_FIELDS.filter((f) => !NOT_AT_ADMISSION.has(f.key)).map((f) => OVERRIDES[f.key] ?? f),
  PREFERRED_REGIONS_FIELD,
];

/**
 * The pay rates, which are NOT columns on `assayers`.
 *
 * They post to `POST /assayers/:id/commercial` as a dated profile of their own, and the API runs
 * `ValidationPipe({ forbidNonWhitelisted: true })` — so a rate that leaked into the record's own
 * PUT body would not be quietly ignored, it would 400 the whole save. Kept in a separate list for
 * exactly that reason: they share the form's state, and nothing else.
 */
export const RATE_FIELDS: FieldDef[] = [
  { key: 'baseFee', label: 'Fee per audit (₹)', type: 'number' },
  { key: 'dailyRate', label: 'Daily rate (₹)', type: 'number' },
  { key: 'hourlyRate', label: 'Hourly rate (₹)', type: 'number' },
  { key: 'travelReimbursement', label: 'Travel allowance (₹)', type: 'number' },
  { key: 'accommodationAllowance', label: 'Stay allowance (₹)', type: 'number' },
  { key: 'mealAllowance', label: 'Meal allowance (₹)', type: 'number' },
];

export const RATE_KEYS: readonly string[] = RATE_FIELDS.map((f) => f.key);

/** Which boxes appear on which step. Order within a step is the order they are drawn in. */
export const STEP_FIELDS: Record<RegistrationStepKey, readonly string[]> = {
  person: [
    'firstName', 'lastName', 'assayerCode', 'dateOfBirth', 'qualification',
    'phone', 'alternatePhone', 'email',
    'state', 'engagementType', 'employmentType', 'department', 'joiningDate',
  ],
  // `state` appears here as well as on step 1 and that is deliberate: the pincode lookup on this
  // step writes it, and a box that changes under you on a page you cannot see is how the old form
  // filed people into the wrong region. One form key, shown wherever its value is being decided.
  address: ['address', 'pincode', 'city', 'district', 'state', 'region', 'preferredRegions'],
  identity: ['panNumber', 'aadhaarNumber', 'bankAccountNumber', 'ifscCode', 'bankName', 'vstsCode'],
  documents: [],
  people: [
    'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
    'skills', 'languages', 'certifications', 'experienceYears',
    'workingHoursStart', 'workingHoursEnd', 'maxDailyWorkload', 'maxWeeklyWorkload',
    'managerId', 'hrOwnerName', 'employeeId', 'employeeCode',
    'notes',
  ],
  review: [],
};

/**
 * The three boxes a save genuinely cannot go without, and nothing else.
 *
 * Everything else on every step is optional, and the steps say so out loud. This list exists
 * because `CreateAssayerRequestDto` declares exactly these three `@IsNotEmpty()` — so blocking on
 * them here turns a 400 after a full page of typing into a red asterisk before it. A rule that is
 * not the server's rule does not belong in this function: the identity numbers, for instance, are
 * checked live in the field for the clerk's benefit but are never a reason to refuse a step,
 * because the server's message is the authoritative one and it is shown when it arrives.
 */
export function validateStep(step: RegistrationStepKey, form: Record<string, string>): string[] {
  if (step !== 'person') return [];
  const problems: string[] = [];
  if (!(form.firstName || '').trim()) problems.push('a first name');
  if (!(form.lastName || '').trim()) problems.push('a last name');
  if (!(form.state || '').trim()) problems.push('the state they work in');
  return problems;
}

/** The step a field is filled in on, so "Bank account is missing" can offer the way to fix it. */
export function stepOfField(fieldKey: string): RegistrationStepKey | null {
  for (const step of REGISTRATION_STEP_KEYS) {
    if (STEP_FIELDS[step].includes(fieldKey)) return step;
  }
  // The coordinate pair has no box — it is placed with the map pin control on the address step.
  if (fieldKey === 'latitude' || fieldKey === 'longitude') return 'address';
  return null;
}

export interface ActivationGap {
  key: string;
  label: string;
  /** What stays blocked while it is blank, in the words every other HR screen uses. */
  why: string;
  step: RegistrationStepKey | null;
}

/**
 * What is still missing, and what each gap costs — read from the one shared list.
 *
 * `CRITICAL_ASSAYER_RECORD_FIELDS` in `@fapoms/shared` is what the roster's "Incomplete record"
 * filter, the paperwork page and the record's own Summary all count, so a registration that
 * invented its own list would send people away believing a record was complete that those three
 * screens then flagged. The step is attached here so Review can offer a way back to each gap
 * rather than naming it and leaving the clerk to hunt.
 */
export function activationGaps(record: Partial<Assayer> | null | undefined): ActivationGap[] {
  // `missingAssayerRecordFields` rather than the local `missingCriticalFields` wrapper, because
  // this needs the untouched `blocks` sentence AND a step to send the clerk back to, and the
  // wrapper returns neither. Both now de-capitalise through the same `blocksPhrase`, so the
  // acronym survives on either route — that was not true when this was written.
  return missingAssayerRecordFields(record as Record<string, unknown> | null | undefined).map((f) => ({
    key: f.key,
    label: f.label,
    why: blocksPhrase(f.blocks),
    step: stepOfField(f.key),
  }));
}

/**
 * Where to reopen a half-finished registration.
 *
 * A record that exists but has no address goes back to the address step, not to page one — the
 * clerk resuming it should not have to click through what is already done to reach what is not.
 * Falls through to Review when nothing critical is outstanding, because at that point the only
 * useful thing left to show is the summary of what is on file.
 */
export function firstIncompleteStep(record: Partial<Assayer> | null | undefined): RegistrationStepKey {
  if (!record) return 'person';
  const gaps = activationGaps(record);
  for (const step of REGISTRATION_STEP_KEYS) {
    if (gaps.some((g) => g.step === step)) return step;
  }
  return 'review';
}
