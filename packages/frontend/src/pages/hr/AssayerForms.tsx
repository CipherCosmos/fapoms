import { useEffect, useState } from 'react';
import {
  INDIAN_STATES, REGION_ORDER, REGION_LABELS, AssayerEngagementType, AssayerUnavailableReason,
  isValidPan, isValidIfsc, isValidAadhaar, AADHAAR_PATTERN, CRITICAL_ASSAYER_RECORD_FIELDS,
} from '@fapoms/shared';
import { fetchWholeAssayerRoster } from '../../services/assayer-roster';
import { Select } from '../../components/ui';
import { Autocomplete } from '../../components/ui/Autocomplete';
import { ChipMultiSelect } from '../../components/ui/ChipMultiSelect';
import { asOptions } from '../../hooks/useWorkforceVocabulary';
import { blocksPhrase, type Assayer } from './assayer-shared';
import { userMessage } from '../../services/errors';
import { fetchWithTimeout } from '../../services/http';

/**
 * Assayer field definitions and the one renderer that draws them.
 *
 * Split out of the old Assayers page so the redesigned roster can reuse the exact
 * same field definitions and validation instead of growing a second, drifting copy
 * of the workforce form.
 *
 * The create form that used to live at the bottom of this file — an "Express / Advanced (6 Tabs)"
 * mode switch — is gone; registering somebody is now the stepped flow in `registration/`, which
 * renders these same definitions through `renderFormField`. What stays here is only what both
 * that flow and the record page need, so neither can grow its own idea of what a PAN box is.
 */

// 12px, not the 11px this was. Every field the registration flow draws goes through this label,
// and the flow's audience is a desk clerk who may not read English comfortably; 11px captions
// over 13px inputs is the size at which a hint stops being read at all.
const labelStyle = { display: 'block', fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' };
const formFieldStyle = { padding: '10px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' as const, outline: 'none', fontSize: '13px' };

const FIELD_TEXTAREA = new Set(['address', 'notes']);
const FIELD_MONO = new Set(['assayerCode', 'employeeCode', 'employeeId', 'panNumber', 'aadhaarNumber', 'bankAccountNumber', 'ifscCode']);
const FIELD_TEL = new Set(['phone', 'alternatePhone', 'emergencyContactPhone']);
const FIELD_NUM = new Set(['experienceYears', 'maxDailyWorkload', 'maxWeeklyWorkload']);
const FIELD_TIME = new Set(['workingHoursStart', 'workingHoursEnd']);



const EMPLOYMENT_TYPES: { value: string; label: string }[] = [
  { value: 'FULL_TIME', label: 'Full Time' }, { value: 'PART_TIME', label: 'Part Time' },
  { value: 'CONTRACT', label: 'Contract' }, { value: 'INTERN', label: 'Intern' },
  { value: 'CONSULTANT', label: 'Consultant' }, { value: 'FREELANCE', label: 'Freelance' },
];

const DEPARTMENTS: { value: string; label: string }[] = [
  { value: 'Operations', label: 'Operations' }, { value: 'Gold Testing', label: 'Gold Testing' },
  { value: 'Diamond Testing', label: 'Diamond Testing' }, { value: 'KYC Verification', label: 'KYC Verification' },
  { value: 'Cash Management', label: 'Cash Management' }, { value: 'Logistics', label: 'Logistics' },
  { value: 'Quality Assurance', label: 'Quality Assurance' }, { value: 'Administration', label: 'Administration' },
  { value: 'Finance', label: 'Finance' }, { value: 'Human Resources', label: 'Human Resources' },
  { value: 'Information Technology', label: 'Information Technology' },
];

/**
 * The two halves of the roster's "Active / Inactive" column, which held an availability, a
 * reason and an engagement type in one cell. Labels match the record's Summary so a clerk does
 * not meet "Back-up" in one place and `BACK_UP` in the other.
 */
const ENGAGEMENT_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Not recorded' },
  { value: AssayerEngagementType.REGULAR, label: 'Regular' },
  { value: AssayerEngagementType.LOCAL, label: 'Local' },
  { value: AssayerEngagementType.BACK_UP, label: 'Back-up' },
  { value: AssayerEngagementType.AGENCY_AUDIT, label: 'Agency audits' },
  { value: AssayerEngagementType.MYSTERY_AUDIT, label: 'Mystery audits' },
];

const UNAVAILABLE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'They are available' },
  { value: AssayerUnavailableReason.REJECTED_BY_US, label: 'We rejected them' },
  { value: AssayerUnavailableReason.NOT_INTERESTED, label: 'Not interested' },
  // The spreadsheet's word for this is "Expired"; it means the person has died, and the form
  // should not ask a clerk to pick a word that reads like a lapsed certificate.
  { value: AssayerUnavailableReason.DECEASED, label: 'Deceased' },
  { value: AssayerUnavailableReason.NO_WORK_IN_AREA, label: 'No work in their area' },
  { value: AssayerUnavailableReason.MOVED_ABROAD, label: 'Moved out of India' },
  { value: AssayerUnavailableReason.MOVED_TO_COMPANY, label: 'Now engaged through a company' },
];

const EMERGENCY_CONTACT_RELATIONS: { value: string; label: string }[] = [
  { value: 'Spouse', label: 'Spouse' }, { value: 'Parent', label: 'Parent' },
  { value: 'Sibling', label: 'Sibling' }, { value: 'Child', label: 'Child' },
  { value: 'Friend', label: 'Friend' }, { value: 'Colleague', label: 'Colleague' },
  { value: 'Other', label: 'Other' },
];

const PERFORMANCE_RATINGS: { value: string; label: string }[] = [
  { value: '1', label: '1 - Poor' }, { value: '2', label: '2 - Below Average' },
  { value: '3', label: '3 - Average' }, { value: '4', label: '4 - Good' },
  { value: '5', label: '5 - Excellent' },
];

/**
 * The six operational regions, offered as a list instead of a text box.
 *
 * `region` looked like free text on this form, and it is not: the server runs every value
 * through `resolveRegion()` (packages/shared/src/regions.ts) and stores one of six enum values,
 * and that stored value is what region-scoped desks are filtered by
 * (`AssayerService.findAll`: `where.region = In(scope.regions)`). So a clerk who typed
 * "Delhi NCR", "Western India" or their zone name was not recording a region — the server could
 * not resolve it, fell back to deriving one from the state, and the typing was discarded with no
 * message. Worse, someone who typed a region that *did* resolve but was not the one their state
 * belongs to could file the person out of their own desk's view.
 *
 * Six named choices, and a hint saying that leaving it blank is the normal, correct answer.
 */
const REGION_OPTIONS: { value: string; label: string }[] =
  REGION_ORDER.map((r) => ({ value: r, label: REGION_LABELS[r] }));

export interface FieldDef {
  key: string;
  label: string;
  required?: boolean;
  type?: string;
  full?: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** Renders a ChipMultiSelect fed by the roster's own vocabulary instead of a text box. */
  vocab?: 'skills' | 'languages' | 'certifications';
  /**
   * Renders a tick-list of the six operational regions, held as a JSON array string like the
   * `vocab` fields. `preferredRegions` is a `text[]` column and the API's `@IsArray()` refuses a
   * bare string, so a field marked this way must have its value parsed back to an array before it
   * is sent — see `finaliseAssayerBody` in registration/persist.ts, the only writer of it.
   */
  regions?: true;
  /**
   * Renders a searchable list of people instead of a text box, storing the id behind the name.
   * Used for the reporting manager, which is an id nobody can be expected to know by heart.
   */
  people?: true;
  hint?: string;
}

/**
 * The people who can be named as somebody's reporting manager.
 *
 * `assayers.manager_id` points at another row of `assayers` — that is what the original
 * foreign key on the column declared — so the roster is the candidate list, and
 * `GET /assayers` is an endpoint this screen's own roster already calls. No new backend
 * route, and no second idea of who a manager is.
 *
 * Loaded only where the field is actually shown. `null` means "still loading", which the
 * picker renders as such rather than as "there is nobody to choose".
 *
 * EVERY page of the roster, not the first thousand rows. This asked for `?limit=1000` and took
 * whatever came back: on the customer's roster of 1,155 appraisers the 155 oldest records were
 * absent from the dropdown, so those people could not be named as anybody's manager and nothing
 * on the form said why. A warning would not have helped — the person choosing needs the name to
 * be *in the list* — so the list is now complete instead. `incomplete` covers the case a warning
 * is the only honest answer to: a roster past the loader's ceiling, or somebody enrolled while
 * these requests were in flight.
 */
export const useManagerOptions = (enabled: boolean, excludeId?: string) => {
  const [people, setPeople] = useState<{ value: string; label: string }[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** Set only when the roster genuinely could not all be loaded; null when the list is everyone. */
  const [incomplete, setIncomplete] = useState<{ shown: number; total: number } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetchWholeAssayerRoster<Assayer>()
      .then(({ people: roster, total, missing }) => {
        if (!alive) return;
        const list = roster.filter((a) => a.id !== excludeId).map((a) => ({
          value: a.id,
          // Code included because two people on a national roster share a name often enough
          // that a bare name would make the choice a coin toss.
          label: a.assayerCode ? `${a.displayName} · ${a.assayerCode}` : a.displayName,
        })).sort((x, y) => x.label.localeCompare(y.label));
        setPeople(list);
        setIncomplete(missing > 0 ? { shown: roster.length, total } : null);
      })
      .catch((e) => { if (alive) { setPeople([]); setFailed(userMessage(e)); } });
    return () => { alive = false; };
  }, [enabled, excludeId]);
  return { people, failed, incomplete };
};

/**
 * Skills, languages and certifications are lists, and this form's state is a flat
 * Record<string, string> shared by every field renderer.
 *
 * They are therefore held as a JSON array string rather than the comma-separated text the
 * other forms used to use. The distinction matters: a vocabulary entry may legitimately
 * contain a comma ("Assaying, Hallmarked"), and splitting on it silently invented two
 * requirements that match nobody. The catch branch still accepts old comma text so a value
 * saved by the previous version of this form survives being opened for edit.
 */
export const parseList = (raw?: string): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch { /* legacy comma text — fall through */ }
  return raw.split(',').map((x) => x.trim()).filter(Boolean);
};
export const stringifyList = (list: string[]): string => (list.length > 0 ? JSON.stringify(list) : '');

/**
 * Format checks that tell the operator what is wrong while they are still in the field.
 *
 * These are advisory hints, never a submit blocker: the server is the authority, and a
 * legitimate-but-unusual value must not be made unsaveable by a regex on this screen.
 *
 * They call the SHARED rulebook (`@fapoms/shared/identity-validation`) — the same functions
 * `POST/PUT /assayers` runs through `IsPanFormat` / `IsAadhaarNumber` / `IsIfscFormat`. This
 * file used to carry its own three regexes, and one of them was weaker than the server's: the
 * local Aadhaar check was twelve digits and nothing else, so a mistyped or transposed digit
 * showed no hint here and was then refused by the Verhoeff checksum on save — after the whole
 * form had been filled. Sharing the rule means the hint appears while the card is still in the
 * clerk's hand, and the two can never disagree about what "looks right" means.
 */
const formatHint = (key: string, value: string): string | null => {
  const v = (value || '').trim();
  if (!v) return null;
  if (key === 'panNumber' && !isValidPan(v)) return 'A PAN looks like ABCDE1234F — five letters, four digits, one letter.';
  if (key === 'ifscCode' && !isValidIfsc(v)) return 'An IFSC code looks like HDFC0001234 — four letters, a zero, then six characters.';
  if (key === 'aadhaarNumber' && !isValidAadhaar(v.replace(/\s/g, ''))) {
    // Two failure modes, two sentences: a wrong-length value is a typing slip the clerk can see,
    // while twelve digits that fail the checksum look perfectly right on screen — that one has to
    // send them back to the card rather than back to the keyboard.
    return AADHAAR_PATTERN.test(v.replace(/\s/g, ''))
      ? 'These 12 digits do not add up to a real Aadhaar number — check them against the card.'
      : 'An Aadhaar number is 12 digits.';
  }
  if (key === 'pincode' && !/^\d{6}$/.test(v)) return 'A pincode is exactly 6 digits.';
  return null;
};

/**
 * Ask the postal directory what a pincode actually is, and hand the answer back.
 *
 * This used to be a submit-time consistency *check*: the operator filled the whole form, hit
 * save, and was told "Pincode 682001 is in Kerala but you selected Delhi" — after the typing,
 * with no offer to fix it. Worse, the old submit handler awaited it and then read the error
 * from state in the same tick it was set, so the state it tested was always the previous
 * render's value: a real conflict sailed through on the first attempt and only blocked the second.
 *
 * So it returns its finding instead of writing it to state, which makes it usable both on
 * blur (to fill state/district in for the operator) and at save (to test the fresh answer).
 */
export const resolvePincode = async (pincode: string): Promise<{ state: string; district: string } | null> => {
  if (!/^\d{6}$/.test(pincode || '')) return null;
  try {
    /**
     * Five seconds, not the usual thirty, because of who is on the other end and who is waiting.
     *
     * This is a third-party host we neither operate nor monitor, and a caller may await it before
     * saving — so whatever this does, the operator watches it do. An unbounded fetch to an
     * unreachable third party froze the whole submit with the button disabled and nothing to click.
     *
     * The check is advisory: the catch below already swallows every failure because the backend
     * enforces address consistency regardless. Waiting thirty seconds to discard the answer
     * anyway is strictly worse than giving up at five and letting the save proceed.
     */
    const res = await fetchWithTimeout(`https://api.postalpincode.in/pincode/${pincode}`, {
      timeoutMs: 5_000,
    });
    const data = await res.json();
    const ok = data?.[0];
    const po = ok && ok.Status === 'Success' ? ok.PostOffice?.[0] : null;
    return po ? { state: String(po.State || ''), district: String(po.District || '') } : null;
  } catch { return null; /* can't verify client-side; backend enforces */ }
};

/** A contradiction between what the directory says and what the operator typed, in plain words. */
export const addressConflict = (
  po: { state: string; district: string },
  pincode: string,
  state: string,
  district: string,
): { message: string; blocking: boolean } | null => {
  if (state && po.state && state.trim().toLowerCase() !== po.state.trim().toLowerCase()) {
    return {
      message: `Pincode ${pincode} is in ${po.state}, but the state is set to ${state}. Change one of the two before saving.`,
      blocking: true,
    };
  }
  // A district named differently from the postal directory is normal — post offices and revenue
  // districts are named differently across most of India — so it is said out loud and saved
  // anyway. Dressing it in the same red as an unsaveable state is how a real warning gets ignored.
  if (district && po.district && district.trim().toLowerCase() !== po.district.trim().toLowerCase()) {
    return {
      message: `Pincode ${pincode} is usually recorded as ${po.district} district. "${district}" will be saved as entered.`,
      blocking: false,
    };
  }
  return null;
};

/**
 * The three identifier fields, defined once so the create and edit forms cannot drift apart.
 *
 * There genuinely are three columns, and they are not duplicates of each other — but only one of
 * them is used for anything, and the form gave all three the same weight and no explanation. On
 * the live roster `employee_id` and `employee_code` are populated on 0 of 8 rows, nothing in the
 * backend reads either one, and `employee_id` carries a UNIQUE constraint while `employee_code`
 * does not. So a clerk faced with "Assayer Code / Employee ID / Employee Code" had no way to know
 * which one the login uses, which one payroll means, or which one would refuse a second person
 * with the same value. They are kept — every one still saves exactly as before — and each now
 * says who assigns it and what happens if it is wrong.
 */
const EMPLOYEE_ID_FIELD: FieldDef = {
  key: 'employeeId', label: 'Employee ID (payroll)',
  hint: 'Optional. The number your HR or payroll system knows this person by. No two people may share one.',
};
const EMPLOYEE_CODE_FIELD: FieldDef = {
  key: 'employeeCode', label: 'Employee Code (your own reference)',
  hint: 'Optional and free-form. Kept on the record for you to look at; nothing in the system uses it.',
};
const REGION_FIELD: FieldDef = {
  key: 'region', label: 'Region', options: REGION_OPTIONS,
  hint: 'Best left blank — it is worked out from the state. Set it only to override that.',
};

/**
 * The code, which is the only identifier that does anything, and is create-time only.
 *
 * Exported rather than declared inside the registration flow because the hint below is the
 * whole point of the field: `AuthService` looks an assayer up by this at sign-in
 * (`{ assayerCode: ILike(cleanKey) }`) and uses it as their username. A clerk who overwrote the
 * assigned code to match a payroll number was changing somebody's login without being told so.
 *
 * Not required: blank means "allocate the next free one", which is the normal case, and only the
 * server can see the codes that deleted assayers still hold.
 */
export const ASSAYER_CODE_FIELD: FieldDef = {
  key: 'assayerCode', label: 'Assayer code', placeholder: 'Left blank, one is given',
  // Kept to two short lines. The hint sits in an auto-fit grid cell, so a paragraph here stretches
  // its row and pushes the next field a screen down — which is what a four-line version of this
  // did to "Qualification" on the first page.
  hint: 'Given automatically when you save. It is also their sign-in username.',
};

export const EDIT_FIELDS: FieldDef[] = [
  { key: 'firstName', label: 'First Name', required: true },
  { key: 'lastName', label: 'Last Name', required: true },
  { key: 'email', label: 'Email', type: 'email' },
  // Not required here either: this is the form the gap list sends people to via "Fill them in",
  // and a form that refuses to save without a phone cannot be used to fill in anything else.
  { key: 'phone', label: 'Phone' },
  { key: 'alternatePhone', label: 'Alternate Phone' },
  { key: 'address', label: 'Address', full: true },
  { key: 'state', label: 'State', options: INDIAN_STATES },
  { key: 'district', label: 'District' },
  { key: 'city', label: 'City' },
  { key: 'pincode', label: 'Pincode' },
  REGION_FIELD,
  EMPLOYEE_ID_FIELD,
  EMPLOYEE_CODE_FIELD,
  { key: 'employmentType', label: 'Employment Type', options: EMPLOYMENT_TYPES },
  { key: 'department', label: 'Department', options: DEPARTMENTS },
  { key: 'joiningDate', label: 'Joining Date', type: 'date' },
  /**
   * Two leaving dates, and they are not a duplicate pair — but nothing on screen said so.
   *
   * `AssayerStateMachine` stamps `exitDate` when somebody is moved to RESIGNED and
   * `terminationDate` when they are moved to TERMINATED, and the roster reads
   * `COALESCE(exit_date, termination_date)` as "the day they left". A clerk who saw two date
   * boxes and filled in whichever they reached first was recording *how* the person left, not
   * just when — and filling in both says the person both resigned and was dismissed. The labels
   * now carry the reason, and both say that the usual way to set them is to change the person's
   * status, which stamps the right one automatically.
   */
  {
    key: 'exitDate', label: 'Last day — resigned', type: 'date',
    hint: 'Filled in automatically when the status is set to Resigned. Only change it if that date is wrong.',
  },
  {
    key: 'terminationDate', label: 'Last day — terminated', type: 'date',
    hint: 'Filled in automatically when the status is set to Terminated. Use this one only for a dismissal, not a resignation.',
  },
  // Was a box asking for a raw UUID, which nobody in the office has ever been able to type,
  // so the reporting line simply went unrecorded. It is a pick from the roster now: the name
  // is shown, the id is what gets stored. Still optional — the server treats it as optional,
  // and an assayer who reports to nobody on the roster is a normal record, not an error.
  { key: 'managerId', label: 'Reporting Manager', people: true, full: true, hint: 'Optional. Who this person reports to.' },
  { key: 'panNumber', label: 'PAN Number' },
  { key: 'aadhaarNumber', label: 'Aadhaar Number' },
  { key: 'bankAccountNumber', label: 'Bank Account' },
  { key: 'ifscCode', label: 'IFSC Code' },
  { key: 'experienceYears', label: 'Experience (years)', type: 'number' },
  { key: 'skills', label: 'Skills', vocab: 'skills', full: true },
  { key: 'languages', label: 'Languages', vocab: 'languages', full: true },
  { key: 'certifications', label: 'Certifications', vocab: 'certifications', full: true },
  /**
   * A hand-set rating that the planning engine really does read — and a second, computed rating
   * that this field is not.
   *
   * `assayers.performance_rating` is set by HR only (the mobile app lists it in
   * HR_MAINTAINED_FIELDS and renders it read-only) and is scored by the recommendation engine
   * when it ranks candidates for a job, so it is not a decorative note. The separate
   * `average_rating` column is computed from remarks by `recomputeAverageRating()` and is never
   * touched from here. Nobody reading "Performance Rating" could tell which of the two they were
   * about to overwrite, or that typing a number here changes who gets offered work.
   *
   * The list also only ever offered whole numbers while the column stores two decimals: a person
   * on 4.80 opened this form showing an empty dropdown — reading as "not rated" — and any pick
   * silently rounded them down. `renderFormField` now offers the recorded value back as its own
   * choice, so opening the form cannot round anybody.
   */
  {
    key: 'performanceRating', label: 'HR performance rating', type: 'number', options: PERFORMANCE_RATINGS,
    hint: 'Set by HR. Used when the system suggests who to send to a job. Separate from the rating worked out from remarks.',
  },
  {
    key: 'maxDailyWorkload', label: 'Most jobs per day', type: 'number',
    hint: 'How many jobs this person may be given in one day.',
  },
  {
    key: 'maxWeeklyWorkload', label: 'Most jobs per week', type: 'number',
    hint: 'How many jobs this person may be given in one week.',
  },
  // Facts the appraiser roster carries that this form had no field for, so 1,155 imported
  // records could be read but not corrected. `engagementType` and `unavailableReason` are the
  // two halves of the roster's "Active / Inactive" column, which was one cell holding several
  // separate things.
  { key: 'dateOfBirth', label: 'Date of Birth', type: 'date' },
  { key: 'qualification', label: 'Qualification', placeholder: 'e.g. B.Com, C.A Final' },
  { key: 'bankName', label: 'Bank Name' },
  { key: 'vstsCode', label: 'VSTS Code', placeholder: 'Their code in the vault system' },
  { key: 'hrOwnerName', label: 'HR Owner', placeholder: 'Who in HR looks after this person' },
  { key: 'engagementType', label: 'Engaged As', options: ENGAGEMENT_OPTIONS },
  { key: 'unavailableReason', label: 'Unavailable Because', options: UNAVAILABLE_OPTIONS },
  { key: 'emergencyContactName', label: 'Emergency Contact Name' },
  { key: 'emergencyContactPhone', label: 'Emergency Contact Phone' },
  { key: 'emergencyContactRelation', label: 'Emergency Contact Relation', options: EMERGENCY_CONTACT_RELATIONS },
  { key: 'workingHoursStart', label: 'Working Hours Start', placeholder: '09:00' },
  { key: 'workingHoursEnd', label: 'Working Hours End', placeholder: '18:00' },
  { key: 'notes', label: 'Notes', full: true },
];

const GEO_AUTO_FIELDS = new Set(['district', 'city', 'pincode']);

/** Apply a selected real place to the whole address group so state/district/city/pincode stay consistent. */
const applyPlace = (fieldKey: string, place: { label: string; state: string; district: string; pincode: string }, form: Record<string, string>, setForm: (v: Record<string, string>) => void) => {
  const primary = (place.label || '').split(',')[0].trim();
  const next = { ...form };
  if (fieldKey === 'city' || fieldKey === 'pincode') {
    if (place.district) next.district = place.district;
    if (place.state) next.state = place.state;
  }
  if (fieldKey === 'city') next.city = primary;
  if (fieldKey === 'district') {
    next.district = place.district || primary;
    if (place.state) next.state = place.state;
    if (!next.city) next.city = primary;
  }
  if (fieldKey === 'pincode') {
    if (place.pincode) next.pincode = place.pincode;
    next.district = place.district || next.district;
    next.state = place.state || next.state;
    if (!next.city) next.city = primary;
  }
  setForm(next);
};

export const renderFormField = (
  field: FieldDef,
  form: Record<string, string>,
  setForm: (v: Record<string, string>) => void,
  vocabulary?: { skills: string[] | null; languages: string[] | null; certifications: string[] | null },
  onBlurField?: (key: string) => void,
  people?: {
    options: { value: string; label: string }[] | null;
    failed: string | null;
    /** Present only when some of the roster could not be loaded — see `useManagerOptions`. */
    incomplete?: { shown: number; total: number } | null;
  },
) => {
  const val = form[field.key] || '';
  const isTextarea = FIELD_TEXTAREA.has(field.key);
  const isMono = FIELD_MONO.has(field.key);
  const isTel = FIELD_TEL.has(field.key);
  const isNum = FIELD_NUM.has(field.key);
  const isTime = FIELD_TIME.has(field.key);

  const handleChange = (v: string) => {
    if (field.key === 'panNumber' || field.key === 'ifscCode') {
      setForm({ ...form, [field.key]: v.toUpperCase() });
    } else {
      setForm({ ...form, [field.key]: v });
    }
  };

  /**
   * What this field being empty stops the company doing.
   *
   * `CRITICAL_ASSAYER_RECORD_FIELDS` has carried this sentence all along — the record's Summary prints
   * "Bank account — blocks payouts" and offers a Fill them in button. Pressing it opened a grid
   * of identical grey boxes with none of that. Shown only while the box is still empty: once it
   * is filled, the consequence has stopped applying and the line is noise.
   */
  const gap = CRITICAL_ASSAYER_RECORD_FIELDS.find((c) => c.key === field.key);
  const blocking = gap && !String(val ?? '').trim() ? blocksPhrase(gap.blocks) : null;

  /**
   * A caption is not a label until something ties it to the box.
   *
   * These were bare `<label>` elements with no `for`, sitting above inputs with no `id` — so a
   * screen reader announced every one of them as an unnamed edit box, and the caption as loose
   * text belonging to nothing. The three place fields go through `Autocomplete`, which takes no
   * id, so they are named by wrapping the control in a group that points back at the caption
   * instead; the effect is the same and it needs no change to a shared component.
   */
  const inputId = `assayer-field-${field.key}`;
  const labelId = `${inputId}-label`;

  return (
    <div key={field.key} style={field.full ? { gridColumn: '1 / -1' } : {}}>
      <label id={labelId} htmlFor={inputId} style={labelStyle}>
        {field.label}
        {field.required && <span style={{ color: 'var(--danger)', marginLeft: '2px' }}>*</span>}
        {blocking && (
          <span
            style={{
              marginLeft: '6px', fontWeight: 600, fontSize: '12px', color: 'var(--danger)',
              textTransform: 'none', letterSpacing: 0,
            }}
          >
            needed — blocks {blocking}
          </span>
        )}
      </label>
      {field.people ? (
        /**
         * A person picker, not a UUID box. `single` gives it radio behaviour, and an id that is
         * not in the list is still offered back marked "(as recorded)" — so opening the form to
         * change a phone number cannot silently erase a manager who has since been archived off
         * the roster, which is exactly what a plain dropdown would have done.
         */
        (() => {
          const opts = people?.options ?? null;
          // Kept out of the orphan path ChipMultiSelect would otherwise take, because that one
          // labels an unrecognised value with the raw id — which is the very thing this field
          // stopped showing people. Applies while the roster is still loading too.
          const known = (opts || []).some((o) => o.value === val);
          return (
            <>
              <ChipMultiSelect
                single
                options={val && !known ? [...(opts || []), { value: val, label: 'Manager recorded earlier' }] : (opts || [])}
                value={val ? [val] : []}
                onChange={(next) => setForm({ ...form, [field.key]: next[0] || '' })}
                searchPlaceholder="Search by name or code…"
                searchThreshold={5}
                emptyText={opts === null ? 'Loading the roster…' : 'No one else is on the roster yet.'}
                aria-label={field.label}
              />
              {people?.failed && (
                <div style={{ fontSize: '12px', color: 'var(--warning)', marginTop: '4px' }}>
                  {/* Named, not swallowed: without the list the field looks empty by choice. */}
                  Could not load the list of people. {people.failed}
                </div>
              )}
              {/* A short list is worse than an empty one: it looks complete. Say what is not in it. */}
              {people?.incomplete && (
                <div style={{ fontSize: '12px', color: 'var(--warning)', marginTop: '4px' }}>
                  Only {people.incomplete.shown} of the {people.incomplete.total} people on the
                  roster could be loaded, so {people.incomplete.total - people.incomplete.shown} are
                  not in this list. Reload the page to try again.
                </div>
              )}
            </>
          );
        })()
      ) : field.regions ? (
        /**
         * The six regions as a tick-list, because this column really is a list.
         *
         * `preferred_regions` is `text[]`, and the create/update DTOs declare it `@IsArray()`.
         * A single-choice dropdown would have recorded one region for somebody who covers three
         * and, worse, would have sent a bare string the API refuses outright. The value rides in
         * form state as a JSON array string exactly like skills and languages do.
         */
        (() => (
          <ChipMultiSelect
            options={REGION_OPTIONS}
            value={parseList(val)}
            onChange={(next) => setForm({ ...form, [field.key]: stringifyList(next) })}
            searchThreshold={99}
            emptyText="No regions are set up."
            aria-label={field.label}
          />
        ))()
      ) : field.vocab ? (
        /**
         * The vocabulary endpoint is HR-scoped, so a coordinator may legitimately get an empty
         * list back. ChipMultiSelect treats that as a real state and still keeps any value
         * already recorded, which is why the field is safe to show either way.
         */
        (() => {
          const names = vocabulary ? vocabulary[field.vocab] : null;
          const selected = parseList(val);
          return (
            <ChipMultiSelect
              options={asOptions(names)}
              value={selected}
              onChange={(next) => setForm({ ...form, [field.key]: stringifyList(next) })}
              searchPlaceholder={`Search ${field.label.toLowerCase()}…`}
              emptyText={names === null ? 'Loading…' : `No ${field.label.toLowerCase()} have been set up yet.`}
              aria-label={field.label}
            />
          );
        })()
      ) : field.options ? (
        /**
         * A value already on the record that is not one of the offered choices is shown as its
         * own choice, marked "as recorded", instead of leaving the box looking unanswered.
         *
         * The rating is the case that bit: it is stored to two decimals, the list offers whole
         * numbers, and a person on 4.80 therefore opened with an empty dropdown that read as
         * "never rated" — so the obvious repair was to pick 5, or 4, quietly changing a figure
         * the assignment recommendations are scored on. The same protects a department or
         * employment type that was recorded before this list was last edited.
         */
        (() => {
          const known = field.options.some((o) => o.value === val);
          const opts = val && !known
            ? [...field.options, { value: val, label: `${val} — as recorded` }]
            : field.options;
          return (
            <Select
              id={inputId}
              aria-label={field.label}
              value={val}
              onChange={(v) => setForm({ ...form, [field.key]: v })}
              options={opts.map(o => ({ value: o.value, label: o.label }))}
              placeholder={`-- Select ${field.label.replace(' *', '')} --`}
              style={{ width: '100%' }}
            />
          );
        })()
      ) : GEO_AUTO_FIELDS.has(field.key) ? (
        // `Autocomplete` takes no id, so the caption is tied to it through a named group instead
        // of a `for` — without either, the search box is announced with no name at all.
        <div role="group" aria-labelledby={labelId}>
        <Autocomplete
          value={val}
          onChange={(v) => handleChange(v)}
          onSelect={(place) => applyPlace(field.key, place, form, setForm)}
          // Real prop now, instead of a wrapper <div> listening for bubbled focusout. The
          // wrapper fired on the way into the suggestion list too, so the pincode check ran
          // against the fragment the user was still replacing.
          onBlur={() => onBlurField?.(field.key)}
          placeholder={field.placeholder || (field.key === 'pincode' ? 'Search pincode…' : `Type to search ${field.label.toLowerCase()}…`)}
          filterType={(r) => field.key === 'pincode' ? !!r.pincode : true}
        />
        </div>
      ) : isTextarea ? (
        <textarea id={inputId} value={val} onChange={(e) => handleChange(e.target.value)} placeholder={field.placeholder || `Enter ${field.label.toLowerCase().replace(' *', '')}`}
          rows={3} style={{ ...formFieldStyle, resize: 'vertical', minHeight: '60px', fontFamily: 'inherit' }} />
      ) : (
        <div style={{ position: 'relative' }}>
          {isTel && <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '12px', pointerEvents: 'none' }}>+91</span>}
          <input
            id={inputId}
            type={isTime ? 'time' : isTel ? 'tel' : isNum ? 'number' : field.type || 'text'}
            value={val}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={() => onBlurField?.(field.key)}
            required={field.required}
            placeholder={
              field.placeholder ||
              (isTel ? '9876543210' : field.key === 'pincode' ? '6-digit pincode' : field.key === 'email' ? 'name@example.com' : field.key === 'panNumber' ? 'ABCDE1234F' : field.key === 'ifscCode' ? 'HDFC0001234' : field.key === 'bankAccountNumber' ? 'Account number' : `Enter ${field.label.toLowerCase().replace(' *', '')}`)
            }
            inputMode={isNum || field.key === 'pincode' || isTel ? 'numeric' : field.key === 'email' ? 'email' : 'text'}
            maxLength={field.key === 'pincode' ? 6 : field.key === 'panNumber' ? 10 : field.key === 'ifscCode' ? 11 : undefined}
            min={isNum ? 0 : undefined}
            step={isNum ? '1' : undefined}
            autoComplete="off"
            style={{
              ...formFieldStyle,
              fontFamily: isMono ? 'monospace' : 'inherit',
              textTransform: (field.key === 'panNumber' || field.key === 'ifscCode') ? 'uppercase' : 'none',
              letterSpacing: isMono ? '0.5px' : 'normal',
              ...(isTel ? { paddingLeft: '42px' } : {}),
            }} />
        </div>
      )}
      {/* Advisory, shown while the operator is still on the field — never a reason to refuse a save. */}
      {(formatHint(field.key, val) || field.hint) && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
          {formatHint(field.key, val) || field.hint}
        </div>
      )}
    </div>
  );
};

// The Express/Advanced create modal that used to close this file is gone. Registering a person
// is now a stepped flow with its own folder (see registration/RegistrationWizard), because the
// thing it has to get right is a SEQUENCE — create, then pin, then identity, then scans — and a
// mode switch with a Previous/Next pair and no progress could not express one. The field
// definitions and `renderFormField` above are what it draws; the single-record edit modal that
// preceded both was removed earlier for the same reason (a record is edited on its own page).
