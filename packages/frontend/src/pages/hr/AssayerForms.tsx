import React, { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import {
  INDIAN_STATES, REGION_ORDER, REGION_LABELS, AssayerEngagementType, AssayerUnavailableReason,
  isValidPan, isValidIfsc, isValidAadhaar, AADHAAR_PATTERN, CRITICAL_ASSAYER_RECORD_FIELDS,
  normalisePhone, todayDateKey,
} from '@fapoms/shared';
import { fetchWholeAssayerRoster } from '../../services/assayer-roster';
import { fetchStaffDirectory } from '../../services/staff-directory';
import { Select } from '../../components/ui';
import { Autocomplete } from '../../components/ui/Autocomplete';
import { ChipMultiSelect } from '../../components/ui/ChipMultiSelect';
import { asOptions } from '../../hooks/useWorkforceVocabulary';
import { blocksPhrase, parseListValue, type Assayer } from './assayer-shared';
import { userMessage } from '../../services/errors';
import { fetchWithTimeout } from '../../services/http';
import { api } from '../../services/api';

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
// `--bg-input`, not `--bg-page`: in the dark themes the two are literally the same colour, so a
// plain text box drawn against the page was indistinguishable from the page itself — every
// select, date and number box on this form (which already used `--bg-input` via the shared
// Select/StyledInput primitives) stood out while every text box vanished into the background.
const formFieldStyle = { padding: '10px 12px', background: 'var(--bg-input)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' as const, outline: 'none', fontSize: '13px' };

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

// Exported so the record's Summary can print the same words ("4 - Good") the edit dropdown
// offers, rather than a bare number nobody has defined the scale for on that screen.
export const PERFORMANCE_RATINGS: { value: string; label: string }[] = [
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
  /**
   * Renders the same searchable list, but stores the picked NAME rather than an id. Used for
   * `hrOwnerName`, which is a plain text column (`assayers.hr_owner_name`) naming a staff
   * member, not a foreign key — there is nothing on the record to look an id back up against,
   * so the column has to hold what a human reads. The candidate list still comes from a real
   * roster (`useHrOwnerOptions`) rather than a free box, so the value on file is a name that
   * roster actually recognises.
   */
  hrOwnerPicker?: true;
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
 * The staff who can be named as "who in HR looks after this person".
 *
 * `GET /users/directory` (`fetchStaffDirectory`) rather than `GET /assayers`: this is an
 * internal staff member, not an appraiser, and the assayer roster this screen already holds for
 * `useManagerOptions` would not contain them. It is also not `GET /users` — that route needs
 * `user:view:organization`, which a desk clerk filling in this form does not hold; the directory
 * route is gated the same way `/hr` itself is, so whoever can reach this screen can call it.
 *
 * One request, no `missing`/`incomplete` tracking: the server itself returns everyone up to its
 * own 5,000-row ceiling rather than paging, so there is no partial page for this hook to detect.
 */
export const useHrOwnerOptions = (enabled: boolean) => {
  const [people, setPeople] = useState<{ value: string; label: string }[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetchStaffDirectory()
      .then(({ people: staff }) => {
        if (!alive) return;
        setPeople(
          staff
            .map((u) => ({ value: u.displayName, label: u.displayName }))
            .sort((x, y) => x.label.localeCompare(y.label)),
        );
      })
      .catch((e) => { if (alive) { setPeople([]); setFailed(userMessage(e)); } });
    return () => { alive = false; };
  }, [enabled]);
  return { people, failed };
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
 *
 * The parse side is `parseListValue` from `./assayer-shared` — this file used to carry an
 * identical copy under the name `parseList`, and `buildAssayerEditBody` (assayer-shared.ts)
 * carried the same body a third time under `parseListValue`. One implementation now; imported
 * here rather than re-declared, since nothing else in the app imported this file's copy by name.
 */
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

/** A bank/branch/city/state lookup for a shape-valid IFSC code — see `resolveIfsc`. */
export interface IfscInfo {
  bankName: string;
  branchName: string;
  city: string | null;
  state: string | null;
  address: string | null;
}

/**
 * One roster row that already carries the phone/PAN/Aadhaar the clerk just typed — one row of
 * `GET /assayers/identifier-check`'s `matches[]`. Defined here rather than in `registration/`
 * because it is this file's `renderFormField` that renders the warning card; the fetching hook
 * (`registration/useDuplicateCheck.ts`) imports the shape from here, the same direction
 * `FieldDef`/`IfscInfo` already flow.
 */
export interface DuplicateMatch {
  id: string;
  assayerCode: string;
  displayName: string;
  lifecycleStatus: string;
  matchedOn: string;
}

/**
 * IFSC → bank/branch lookup, on the same "advisory, never blocking" terms as `resolvePincode`.
 *
 * Unlike the pincode check this goes through OUR backend (`GET /geo/ifsc/:code`, not a third
 * party this browser talks to directly) — the server holds the 8-second budget and the "never
 * throws" contract with the actual provider, and hands back `null` for a malformed code, an
 * unknown one, or a provider outage. So the shape check here is only to avoid spending a request
 * on a code that is obviously still being typed; the server would refuse it anyway.
 */
export const resolveIfsc = async (code: string): Promise<IfscInfo | null> => {
  const v = (code || '').trim().toUpperCase();
  if (!isValidIfsc(v)) return null;
  try {
    return await api.request<IfscInfo | null>(`/geo/ifsc/${encodeURIComponent(v)}`);
  } catch { return null; /* a lookup failure must never block the form */ }
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
  key: 'assayerCode', label: 'Assayer code', placeholder: 'Leave blank — given automatically',
  // Kept to two short lines. The hint sits in an auto-fit grid cell, so a paragraph here stretches
  // its row and pushes the next field a screen down — which is what a four-line version of this
  // did to "Qualification" on the first page.
  hint: 'Given automatically when you save. It is also their sign-in username.',
};

/**
 * The person's name, as ONE box now, not two.
 *
 * India-first naming: "First Name" + "Last Name" was a Western assumption this roster never
 * matched — Tamil initial-style names ("A K Venkatesan"), father's-name middles, and genuinely
 * single-token names all exist on the live roster, and none of them has a "last name" to put in
 * a second box. The authored truth is now the FULL name exactly as printed on the Aadhaar or
 * PAN — what banks, TDS and background checks are actually run against — and `POST/PUT
 * /assayers` takes it as `fullName`: stored verbatim (whitespace-squeezed) as `displayName`,
 * with the legacy `firstName`/`lastName` pair derived by the server itself (all-but-last / last)
 * for whatever still reads them. A single-token name is valid; there is nothing to split it into.
 *
 * No format check beyond non-empty, unlike PAN/Aadhaar/IFSC above and below — a name is not an
 * identifier with a fixed shape, and policing how many words or which characters somebody's own
 * name is allowed to contain is not this screen's job.
 */
const FULL_NAME_FIELD: FieldDef = {
  key: 'fullName', label: 'Full name', required: true, full: true,
  placeholder: 'As printed on their Aadhaar or PAN',
  hint: 'Type it letter for letter as on the card — banks and tax filings check this name. Initials, middle names and single names are all fine.',
};

export const EDIT_FIELDS: FieldDef[] = [
  FULL_NAME_FIELD,
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
  { key: 'hrOwnerName', label: 'HR Owner', hrOwnerPicker: true, hint: 'Who in HR looks after this person.' },
  { key: 'engagementType', label: 'Engaged As', options: ENGAGEMENT_OPTIONS },
  { key: 'unavailableReason', label: 'Unavailable Because', options: UNAVAILABLE_OPTIONS },
  { key: 'emergencyContactName', label: 'Emergency Contact Name' },
  { key: 'emergencyContactPhone', label: 'Emergency Contact Phone' },
  { key: 'emergencyContactRelation', label: 'Emergency Contact Relation', options: EMERGENCY_CONTACT_RELATIONS },
  { key: 'workingHoursStart', label: 'Working Hours Start', placeholder: '09:00' },
  { key: 'workingHoursEnd', label: 'Working Hours End', placeholder: '18:00' },
  { key: 'notes', label: 'Notes', full: true },
];

/**
 * Which fields route through the live geo lookup rather than a plain box.
 *
 * Exported so a second screen editing the same address facts — the record's inline Summary
 * editor — can ask this list rather than growing its own idea of which three fields those are.
 */
export const GEO_AUTO_FIELDS = new Set(['district', 'city', 'pincode']);

/**
 * Apply a selected real place to the whole address group so state/district/city/pincode stay
 * consistent.
 *
 * Exported (rather than kept private to the wizard's own render call) so the record page's
 * inline Summary editor — a second screen editing these same four fields — can call this
 * directly instead of growing a second, drifting copy of the cross-fill rule.
 */
export const applyPlace = (fieldKey: string, place: { label: string; state: string; district: string; pincode: string }, form: Record<string, string>, setForm: (v: Record<string, string>) => void) => {
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

/**
 * What a caller passes in that is not a form value — the wizard's "did you try to move on" flag
 * and the duplicate-roster warning for this one field.
 */
export interface FieldRenderExtras {
  /**
   * True once the clerk has tried to leave or save the step this field lives on, successfully or
   * not. Gates the "needed — blocks X" suffix below — see the comment on `blockingUrgent`.
   */
  advanceAttempted?: boolean;
  /** Roster rows already carrying this value — see `registration/useDuplicateCheck.ts`. */
  duplicateMatches?: DuplicateMatch[];
  onOpenDuplicate?: (match: DuplicateMatch) => void;
  /** "This is a different person" — dismisses the card for the value that produced it. */
  onDismissDuplicate?: () => void;
}

/** The look of a plain text action — "Edit anyway", "Open their record", "This is a different person". */
const linkBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--accent-primary)', fontWeight: 600, fontSize: '12px', textDecoration: 'underline',
};

/** Trims and drops the spaces and dashes a clerk pastes from a printed card — nothing cleverer. */
const stripSeparators = (v: string): string => v.trim().replace(/[\s-]/g, '');

/**
 * What leaving the box should tidy up, and whether that actually changed anything — the caller
 * only shows the "Cleaned up: X → Y" caption when this returns non-null.
 *
 * Deliberately narrow: this fixes the punctuation a person pastes from a printed card or a phone's
 * own contact sheet, never a genuinely wrong value. A PAN that still fails after the spaces and
 * dashes are gone is `formatHint`'s job to flag, not this function's to keep guessing at.
 */
const normaliseOnBlur = (key: string, raw: string): string | null => {
  const v = raw ?? '';
  if (!v.trim()) return null;
  if (key === 'pincode') {
    const clean = stripSeparators(v);
    return clean !== v ? clean : null;
  }
  if (key === 'panNumber' || key === 'ifscCode') {
    const clean = stripSeparators(v).toUpperCase();
    return clean !== v ? clean : null;
  }
  if (FIELD_TEL.has(key)) {
    const clean = normalisePhone(v);
    return clean && clean !== v ? clean : null;
  }
  return null;
};

/** Nobody currently on any roster this system holds was born before 1930. */
const DOB_MIN = '1930-01-01';
/** The company has no record predating this system; a year out covers a genuine forward-dated hire. */
const JOINING_MIN = '2000-01-01';
const oneYearFromToday = (): string => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
};
/** min/max for the two date boxes a clerk can otherwise walk into any century with a native picker. */
const DATE_BOUNDS: Record<string, { min: string; max: string }> = {
  dateOfBirth: { min: DOB_MIN, max: todayDateKey() },
  joiningDate: { min: JOINING_MIN, max: oneYearFromToday() },
};

/** "NAME_MISMATCH" -> "Name mismatch" — so a raw enum value can never reach the screen unworded. */
export const humanize = (raw: string): string => {
  const spaced = raw.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** What the identifier-check endpoint calls each field, in the words a clerk reads instead. */
const MATCHED_ON_LABEL: Record<string, string> = {
  phone: 'phone', panNumber: 'PAN', aadhaarNumber: 'Aadhaar',
};

/**
 * One field: its caption, its box, and everything that can appear under the box.
 *
 * A real component now, not a plain function returning JSX — it needs state of its own
 * (`touched`, the "cleaned up" caption, the bank-name lock) that a function called inline like
 * `renderFormField(...)` cannot safely hold: React hooks would attach to whichever component
 * happens to be calling it, and the number of fields — and therefore the number of hook calls —
 * changes from step to step. `renderFormField` below stays the same plain function every existing
 * caller already has; it now just returns this component instead of building the JSX itself.
 */
const FieldRenderer: React.FC<{
  field: FieldDef;
  form: Record<string, string>;
  setForm: (v: Record<string, string>) => void;
  vocabulary?: { skills: string[] | null; languages: string[] | null; certifications: string[] | null };
  onBlurField?: (key: string, value: string) => void;
  people?: {
    options: { value: string; label: string }[] | null;
    failed: string | null;
    incomplete?: { shown: number; total: number } | null;
  };
  hrOwners?: { options: { value: string; label: string }[] | null; failed: string | null };
  ifscInfo?: IfscInfo | null;
  extras?: FieldRenderExtras;
}> = ({ field, form, setForm, vocabulary, onBlurField, people, hrOwners, ifscInfo, extras }) => {
  const val = form[field.key] || '';
  const isTextarea = FIELD_TEXTAREA.has(field.key);
  const isMono = FIELD_MONO.has(field.key);
  const isTel = FIELD_TEL.has(field.key);
  const isNum = FIELD_NUM.has(field.key);
  const isTime = FIELD_TIME.has(field.key);

  /** Set once the box has been left at least once — see `blockingUrgent` and the invalid caption. */
  const [touched, setTouched] = useState(false);
  /** "Cleaned up: X → Y", shown once and cleared the moment the clerk types again. */
  const [cleanedNote, setCleanedNote] = useState<string | null>(null);
  /**
   * `bankName` locks to what `resolveIfsc` filled in rather than staying an ordinary overwritable
   * box — see the note this replaces on `ifscInfo` below. "Edit anyway" is the escape hatch: a
   * resolved branch name can still be wrong (a bank renames one, a code covers more than one), and
   * a clerk who knows better must not be locked out of correcting it. Re-locks on the next fresh
   * resolution, so a new IFSC code does not inherit a stale "already unlocked" state.
   */
  const [editBankAnyway, setEditBankAnyway] = useState(false);
  useEffect(() => { setEditBankAnyway(false); }, [ifscInfo?.bankName, ifscInfo?.branchName]);

  const handleChange = (v: string) => {
    setCleanedNote(null);
    if (field.key === 'panNumber' || field.key === 'ifscCode') {
      setForm({ ...form, [field.key]: v.toUpperCase() });
    } else {
      setForm({ ...form, [field.key]: v });
    }
  };

  /**
   * Leaving the box: mark it touched, so an invalid format finally gets to look like one, tidy up
   * what was pasted without being asked, and pass the CLEANED value on to whatever the step itself
   * does on blur (the pincode/IFSC lookups, the duplicate check) — never the stale pre-clean one,
   * which a pincode with a stray space would otherwise send `resolvePincode` to fail on.
   */
  const finishBlur = (raw: string) => {
    setTouched(true);
    const cleaned = normaliseOnBlur(field.key, raw);
    const next = cleaned ?? raw;
    if (cleaned) {
      setForm({ ...form, [field.key]: cleaned });
      setCleanedNote(`Cleaned up: ${raw} → ${cleaned}`);
    }
    onBlurField?.(field.key, next);
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
   * The audit's finding: this used to render in `--danger` red the instant the page opened, on
   * every critical box that was still empty — Phone included, one line under a header reading
   * "All optional". Red ink before a clerk has done anything reads as a mistake already made. It
   * earns the colour once they have actually left the box empty, or tried to move past the whole
   * step while it still was — `extras.advanceAttempted`, set by the step's own Continue button.
   */
  const blockingUrgent = Boolean(blocking) && (touched || Boolean(extras?.advanceAttempted));

  /**
   * The caption under the box, and whether it is bad news.
   *
   * The text is the same either way — a format failure is still the most useful thing to say
   * under the box — but it only reads as an ERROR (red, with an icon, and the box outlined to
   * match) once the clerk has actually left the box with it still wrong. Before that, or once the
   * value is fine, it is exactly the muted routine hint every other field shows.
   */
  const rawHint = formatHint(field.key, val);
  const captionText = rawHint || field.hint;
  const showInvalid = Boolean(rawHint) && touched;

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
    <div style={field.full ? { gridColumn: '1 / -1' } : {}}>
      <label id={labelId} htmlFor={inputId} style={labelStyle}>
        {field.label}
        {field.required && <span style={{ color: 'var(--danger)', marginLeft: '2px' }}>*</span>}
        {blocking && (
          <span
            style={{
              marginLeft: '6px', fontWeight: 600, fontSize: '12px',
              color: blockingUrgent ? 'var(--danger)' : 'var(--text-muted)',
              textTransform: 'none', letterSpacing: 0,
            }}
          >
            needed — blocks {blocking}
          </span>
        )}
      </label>
      {field.key === 'bankName' && ifscInfo && !editBankAnyway ? (
        /**
         * Resolved, not merely suggested. `resolveIfsc` already wrote this into the box on the
         * caller's `ifscCode` blur — showing it as an ordinary editable input beside a code that
         * just resolved invited a clerk to "correct" a value the server had just supplied, which
         * is how a real bank name got quietly typo'd back over itself. Locked, with a way out.
         */
        <>
          <input
            id={inputId}
            value={val}
            readOnly
            aria-readonly="true"
            style={{ ...formFieldStyle, background: 'var(--bg-surface-2)', color: 'var(--text-secondary)', cursor: 'default' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
            <span>Filled in from the IFSC code.</span>
            <button type="button" onClick={() => setEditBankAnyway(true)} style={linkBtnStyle}>
              Edit anyway
            </button>
          </div>
        </>
      ) : field.people ? (
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
      ) : field.hrOwnerPicker ? (
        /**
         * Same picker shape as `field.people` above, but the value stored is the picked NAME —
         * `hrOwnerName` is free text, not a foreign key, so there is no id to store instead. A
         * value already on file that matches nobody in the directory (someone who has since left,
         * or a name typed before this field was a picker) is still offered back rather than
         * silently dropped, exactly as an orphaned manager id is above.
         */
        (() => {
          const opts = hrOwners?.options ?? null;
          const known = (opts || []).some((o) => o.value === val);
          return (
            <>
              <ChipMultiSelect
                single
                options={val && !known ? [...(opts || []), { value: val, label: 'Recorded earlier' }] : (opts || [])}
                value={val ? [val] : []}
                onChange={(next) => setForm({ ...form, [field.key]: next[0] || '' })}
                searchPlaceholder="Search by name…"
                searchThreshold={5}
                emptyText={opts === null ? 'Loading staff…' : 'No staff found.'}
                aria-label={field.label}
              />
              {hrOwners?.failed && (
                <div style={{ fontSize: '12px', color: 'var(--warning)', marginTop: '4px' }}>
                  Could not load the staff list. {hrOwners.failed}
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
            value={parseListValue(val)}
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
          const selected = parseListValue(val);
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
          // against the fragment the user was still replacing. Passed the LIVE value Autocomplete
          // hands back, not the closed-over `val` — `finishBlur` needs the text as it stood the
          // instant focus left, not whatever this render started with.
          onBlur={(v) => finishBlur(v)}
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
            onBlur={(e) => finishBlur(e.target.value)}
            // A wheel event over a focused number spinner changes its value, which is a scroll
            // gesture doing the box's job by accident — the fee/workload boxes sit in a page that
            // scrolls, so the natural gesture to move past one silently edited it instead. Every
            // native number input this form draws goes through this one branch, so the blur fixes
            // it everywhere at once rather than field by field.
            onWheel={isNum ? (e) => (e.target as HTMLInputElement).blur() : undefined}
            required={field.required}
            placeholder={
              field.placeholder ||
              (isTel ? '9876543210' : field.key === 'pincode' ? '6-digit pincode' : field.key === 'email' ? 'name@example.com' : field.key === 'panNumber' ? 'ABCDE1234F' : field.key === 'ifscCode' ? 'HDFC0001234' : field.key === 'bankAccountNumber' ? 'Account number' : `Enter ${field.label.toLowerCase().replace(' *', '')}`)
            }
            inputMode={isNum || field.key === 'pincode' || isTel ? 'numeric' : field.key === 'email' ? 'email' : 'text'}
            // No more hard `maxLength` on pincode/PAN/IFSC: a clerk pasting "ABCDE 1234 F" or
            // "682 001" used to have the tail of it silently swallowed at the character cap,
            // which looks like the box ate a keystroke. `finishBlur` above cleans the punctuation
            // out on the way out instead, so nothing is ever truncated on the way in.
            min={isNum ? 0 : DATE_BOUNDS[field.key]?.min}
            max={DATE_BOUNDS[field.key]?.max}
            step={isNum ? '1' : undefined}
            autoComplete="off"
            style={{
              ...formFieldStyle,
              fontFamily: isMono ? 'monospace' : 'inherit',
              textTransform: (field.key === 'panNumber' || field.key === 'ifscCode') ? 'uppercase' : 'none',
              letterSpacing: isMono ? '0.5px' : 'normal',
              ...(isTel ? { paddingLeft: '42px' } : {}),
              ...(showInvalid ? { borderColor: 'var(--danger)' } : {}),
            }} />
        </div>
      )}
      {/*
        Routine hint, or a real error — same text, different weight. Muted for a field that is
        blank, unremarkable, or simply not yet finished; red with a small icon only once the clerk
        has left it behind still wrong, which is the "real invalid state" a plain muted caption
        could never tell apart from ordinary help text.
      */}
      {captionText && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: '4px', fontSize: '12px', marginTop: '4px',
          color: showInvalid ? 'var(--danger)' : 'var(--text-muted)', fontWeight: showInvalid ? 600 : 400,
        }}>
          {showInvalid && <AlertCircle size={12} style={{ flexShrink: 0, marginTop: '1px' }} aria-hidden />}
          <span>{captionText}</span>
        </div>
      )}
      {/* What leaving the box just tidied up, said once rather than left for the clerk to notice on their own. */}
      {cleanedNote && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', fontStyle: 'italic' }}>
          {cleanedNote}
        </div>
      )}
      {/*
        What the code resolved to, printed beside the code — `ifscCode` itself stays a plain,
        overwritable box even after this fires; `bankName` is the field this changes, and it is
        handled above (locked, with "Edit anyway") rather than here.
      */}
      {field.key === 'ifscCode' && ifscInfo && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
          {ifscInfo.bankName}
          {ifscInfo.branchName ? ` — ${ifscInfo.branchName}` : ''}
          {ifscInfo.city ? `, ${ifscInfo.city}` : ''}
          {ifscInfo.state ? `, ${ifscInfo.state}` : ''}
        </div>
      )}
      {/*
        Already on the roster, maybe. Never a reason to refuse the save — the two actions either
        send the clerk to look, or dismiss the card for exactly this value, which is what makes it
        safe to show again if the box changes to something that matches somebody else.
      */}
      {extras?.duplicateMatches && extras.duplicateMatches.length > 0 && (
        <div style={{
          marginTop: '6px', padding: '9px 11px', borderRadius: 'var(--radius-md)',
          background: 'var(--status-pending-bg)', border: '1px solid var(--warning)',
          display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12.5px',
        }}>
          {extras.duplicateMatches.map((m) => (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                <AlertCircle size={13} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '1px' }} aria-hidden />
                <span style={{ color: 'var(--text-primary)' }}>
                  Already on the roster: <strong>{m.displayName}</strong> ({m.assayerCode}, {humanize(m.lifecycleStatus)})
                  {' '}— matched by {MATCHED_ON_LABEL[m.matchedOn] ?? humanize(m.matchedOn)}.
                </span>
              </div>
              <div style={{ display: 'flex', gap: '16px', marginLeft: '19px' }}>
                <button type="button" onClick={() => extras.onOpenDuplicate?.(m)} style={linkBtnStyle}>
                  Open their record
                </button>
                <button
                  type="button"
                  onClick={() => extras.onDismissDuplicate?.()}
                  style={{ ...linkBtnStyle, color: 'var(--text-muted)', textDecoration: 'none' }}
                >
                  This is a different person
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * The one entry point every caller already has. Same name, same positional arguments in the same
 * order as before `FieldRenderer` existed — this file's only real caller (`RegistrationWizard.tsx`)
 * and any other that calls this directly keep working unchanged; `extras` is new and optional, so
 * a call site that never heard of duplicate warnings or progressive disclosure gets the plain,
 * always-muted-until-touched behaviour and nothing else changes shape under it.
 */
export const renderFormField = (
  field: FieldDef,
  form: Record<string, string>,
  setForm: (v: Record<string, string>) => void,
  vocabulary?: { skills: string[] | null; languages: string[] | null; certifications: string[] | null },
  onBlurField?: (key: string, value: string) => void,
  people?: {
    options: { value: string; label: string }[] | null;
    failed: string | null;
    /** Present only when some of the roster could not be loaded — see `useManagerOptions`. */
    incomplete?: { shown: number; total: number } | null;
  },
  /** The HR-owner picker's own candidate list — see `useHrOwnerOptions`. */
  hrOwners?: {
    options: { value: string; label: string }[] | null;
    failed: string | null;
  },
  /**
   * The last successful `resolveIfsc` lookup for THIS form's `ifscCode` box, if any — shown as
   * small read-only supporting text under that field, and also what locks `bankName` to a
   * resolved-read-only box with an "Edit anyway" way out (see `FieldRenderer`). The caller — not
   * this renderer — is what actually calls `resolveIfsc` and writes the resolved name into
   * `bankName`; this only decides how the two fields are drawn once that has happened.
   */
  ifscInfo?: IfscInfo | null,
  extras?: FieldRenderExtras,
) => (
  <FieldRenderer
    key={field.key}
    field={field}
    form={form}
    setForm={setForm}
    vocabulary={vocabulary}
    onBlurField={onBlurField}
    people={people}
    hrOwners={hrOwners}
    ifscInfo={ifscInfo}
    extras={extras}
  />
);

// The Express/Advanced create modal that used to close this file is gone. Registering a person
// is now a stepped flow with its own folder (see registration/RegistrationWizard), because the
// thing it has to get right is a SEQUENCE — create, then pin, then identity, then scans — and a
// mode switch with a Previous/Next pair and no progress could not express one. The field
// definitions and `renderFormField` above are what it draws; the single-record edit modal that
// preceded both was removed earlier for the same reason (a record is edited on its own page).
