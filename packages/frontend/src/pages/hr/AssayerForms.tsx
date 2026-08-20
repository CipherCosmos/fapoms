import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { User, MapPin, Briefcase, Award, CreditCard, Clock, Phone, X, CheckCircle, Edit2, AlertTriangle } from 'lucide-react';
import { INDIAN_STATES, todayDateKey, REGION_ORDER, REGION_LABELS } from '@fapoms/shared';
import { api } from '../../services/api';
import { Modal, Select, useToast } from '../../components/ui';
import { Autocomplete } from '../../components/ui/Autocomplete';
import { ChipMultiSelect } from '../../components/ui/ChipMultiSelect';
import { useWorkforceVocabulary, asOptions } from '../../hooks/useWorkforceVocabulary';
import type { Assayer } from './assayer-shared';
import { STATUS_COLORS, buildAssayerEditBody } from './assayer-shared';
import { userMessage } from '../../services/errors';
import { fetchWithTimeout } from '../../services/http';

/**
 * Assayer create/edit forms.
 *
 * Split out of the old Assayers page so the redesigned roster can reuse the exact
 * same field definitions and validation instead of growing a second, drifting copy
 * of the workforce form.
 */

const labelStyle = { display: 'block', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' };
const formFieldStyle = { padding: '10px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' as const, outline: 'none', fontSize: '13px' };

const FIELD_TEXTAREA = new Set(['address', 'notes']);
const FIELD_MONO = new Set(['assayerCode', 'employeeCode', 'employeeId', 'panNumber', 'bankAccountNumber', 'ifscCode']);
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

interface FieldDef {
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
 */
const useManagerOptions = (enabled: boolean, excludeId?: string) => {
  const [people, setPeople] = useState<{ value: string; label: string }[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api.request<Assayer[]>('/assayers?limit=1000')
      .then((res) => {
        if (!alive) return;
        const list = (Array.isArray(res) ? res : []).filter((a) => a.id !== excludeId).map((a) => ({
          value: a.id,
          // Code included because two people on a national roster share a name often enough
          // that a bare name would make the choice a coin toss.
          label: a.assayerCode ? `${a.displayName} · ${a.assayerCode}` : a.displayName,
        })).sort((x, y) => x.label.localeCompare(y.label));
        setPeople(list);
      })
      .catch((e) => { if (alive) { setPeople([]); setFailed(userMessage(e)); } });
    return () => { alive = false; };
  }, [enabled, excludeId]);
  return { people, failed };
};

/**
 * Deep link support: `?section=<tab>` opens this form on that section instead of at the top.
 *
 * The pay screen and the assayer drawer both link people here *because* their bank details are
 * missing, and both landed on the first tab — the person then had to know that "Financial" is
 * three clicks away, in a mode they may not be in. The section named in the URL is matched to a
 * tab by title, case-insensitively, so the link reads in plain words and survives re-ordering
 * of the tabs. An unknown or absent section leaves the form exactly as it was.
 *
 * A tab may also claim old names through `aliases`. "Financial" and "Pay" are now one tab called
 * "Money", and both old names still land on it — a link that another screen, a bookmark or a
 * pasted URL already carries must not start silently opening the form on Personal.
 */
const sectionTabIndex = (section: string | null, groups: FieldGroup[]): number | null => {
  const want = (section || '').trim().toLowerCase();
  if (!want) return null;
  const i = groups.findIndex((g) => (
    g.title.toLowerCase() === want || (g.aliases || []).some((a) => a.toLowerCase() === want)
  ));
  return i >= 0 ? i : null;
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
const parseList = (raw?: string): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch { /* legacy comma text — fall through */ }
  return raw.split(',').map((x) => x.trim()).filter(Boolean);
};
const stringifyList = (list: string[]): string => (list.length > 0 ? JSON.stringify(list) : '');

/**
 * Format checks that tell the operator what is wrong while they are still in the field.
 *
 * These are advisory hints, never a submit blocker: the server is the authority, and a
 * legitimate-but-unusual value must not be made unsaveable by a regex on this screen.
 */
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const formatHint = (key: string, value: string): string | null => {
  const v = (value || '').trim();
  if (!v) return null;
  if (key === 'panNumber' && !PAN_PATTERN.test(v)) return 'A PAN looks like ABCDE1234F — five letters, four digits, one letter.';
  if (key === 'ifscCode' && !IFSC_PATTERN.test(v)) return 'An IFSC code looks like HDFC0001234 — four letters, a zero, then six characters.';
  if (key === 'pincode' && !/^\d{6}$/.test(v)) return 'A pincode is exactly 6 digits.';
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
 * Admission asks for who this is and where they work, and nothing else.
 *
 * This form used to make eight fields mandatory — phone, address, district and city among them —
 * which is more than a real intake has on day one and more than the roster files this product is
 * fed even contain. The rest are not gone: they are collected here when known, and whatever is
 * still blank is listed on the record as a gap (CRITICAL_FIELDS) with what it blocks, so the
 * record gets completed rather than never created. State stays mandatory because it is what
 * makes an assayer plannable at all — it sets their region, zone and holiday calendar.
 */
const CREATE_FIELDS: FieldDef[] = [
  // Not required: blank means "allocate the next free one", which is the normal case.
  {
    key: 'assayerCode', label: 'Assayer Code', placeholder: 'Left blank, one is assigned for you',
    // Said out loud because this is the one identifier that *does* something: AuthService looks
    // an assayer up by it at sign-in (`{ assayerCode: ILike(cleanKey) }`) and uses it as their
    // username. A clerk who overwrote the assigned code to match a payroll number was changing
    // somebody's login without being told so.
    hint: 'Assigned by the system, and it is also their login username. Leave blank unless you have been given a specific code.',
  },
  { key: 'firstName', label: 'First Name', required: true },
  { key: 'lastName', label: 'Last Name', required: true },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone' },
  { key: 'alternatePhone', label: 'Alternate Phone' },
  { key: 'address', label: 'Address', full: true },
  { key: 'state', label: 'State', required: true, options: INDIAN_STATES },
  { key: 'district', label: 'District' },
  { key: 'city', label: 'City' },
  { key: 'pincode', label: 'Pincode' },
  REGION_FIELD,
  EMPLOYEE_ID_FIELD,
  EMPLOYEE_CODE_FIELD,
  { key: 'employmentType', label: 'Employment Type', options: EMPLOYMENT_TYPES },
  { key: 'department', label: 'Department', options: DEPARTMENTS },
  { key: 'joiningDate', label: 'Joining Date', type: 'date' },
  { key: 'panNumber', label: 'PAN Number' },
  { key: 'bankAccountNumber', label: 'Bank Account' },
  { key: 'ifscCode', label: 'IFSC Code' },
  { key: 'experienceYears', label: 'Experience (years)', type: 'number' },
  // Picked from the roster's own vocabulary, not typed. These three feed the branch/project
  // matching engine by exact string comparison, so a typo here is never rejected — it just
  // becomes a capability nobody holds, and the person looks unassignable for no visible reason.
  { key: 'skills', label: 'Skills', vocab: 'skills', full: true },
  { key: 'languages', label: 'Languages', vocab: 'languages', full: true },
  { key: 'certifications', label: 'Certifications', vocab: 'certifications', full: true },
  { key: 'notes', label: 'Notes', full: true },
  { key: 'baseFee', label: 'Base Fee (₹/audit)', type: 'number' },
  { key: 'hourlyRate', label: 'Hourly Rate (₹)', type: 'number' },
  { key: 'dailyRate', label: 'Daily Rate (₹)', type: 'number' },
];

const CREATE_FIELD_GROUPS: FieldGroup[] = [
  { title: 'Personal', icon: <User size={13} />, fields: ['assayerCode', 'firstName', 'lastName', 'email', 'phone', 'alternatePhone'] },
  { title: 'Address', icon: <MapPin size={13} />, fields: ['address', 'city', 'district', 'state', 'pincode', 'region'] },
  { title: 'Employment', icon: <Briefcase size={13} />, fields: ['employeeId', 'employeeCode', 'employmentType', 'department', 'joiningDate'] },
  /**
   * "Financial" and "Pay" were two tabs, side by side, both with a card icon — one holding the
   * bank account and PAN, the other the rates. Nothing on either title said which was which, so
   * a clerk holding a new joiner's paperwork had to open both to find out where the account
   * number goes, and anyone who found the rates first assumed they had done the money tab and
   * left the bank details empty. One tab now, in the order the paperwork is read: where the
   * money goes, then how much it is. Both old `?section=` names still open it.
   */
  {
    title: 'Money', icon: <CreditCard size={13} />, aliases: ['financial', 'pay', 'bank'],
    fields: ['panNumber', 'bankAccountNumber', 'ifscCode', 'baseFee', 'hourlyRate', 'dailyRate'],
    blocks: [
      { title: 'How we pay them', note: 'Bank and tax details. Needed before this person can be paid.', fields: ['panNumber', 'bankAccountNumber', 'ifscCode'] },
      { title: "What they're paid", note: 'Leave at zero if the rates are not agreed yet — they can be set later.', fields: ['baseFee', 'hourlyRate', 'dailyRate'] },
    ],
  },
  { title: 'Skills', icon: <Award size={13} />, fields: ['experienceYears', 'skills', 'languages', 'certifications'] },
  { title: 'Other', icon: <Clock size={13} />, fields: ['notes'] },
];

const EDIT_FIELDS: FieldDef[] = [
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

const renderFormField = (
  field: FieldDef,
  form: Record<string, string>,
  setForm: (v: Record<string, string>) => void,
  vocabulary?: { skills: string[] | null; languages: string[] | null; certifications: string[] | null },
  onBlurField?: (key: string) => void,
  people?: { options: { value: string; label: string }[] | null; failed: string | null },
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

  return (
    <div key={field.key} style={field.full ? { gridColumn: '1 / -1' } : {}}>
      <label style={labelStyle}>
        {field.label}{field.required && <span style={{ color: 'var(--danger)', marginLeft: '2px' }}>*</span>}
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
                <div style={{ fontSize: '10.5px', color: 'var(--warning)', marginTop: '4px' }}>
                  {/* Named, not swallowed: without the list the field looks empty by choice. */}
                  Could not load the list of people. {people.failed}
                </div>
              )}
            </>
          );
        })()
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
              value={val}
              onChange={(v) => setForm({ ...form, [field.key]: v })}
              options={opts.map(o => ({ value: o.value, label: o.label }))}
              placeholder={`-- Select ${field.label.replace(' *', '')} --`}
              style={{ width: '100%' }}
            />
          );
        })()
      ) : GEO_AUTO_FIELDS.has(field.key) ? (
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
      ) : isTextarea ? (
        <textarea value={val} onChange={(e) => handleChange(e.target.value)} placeholder={field.placeholder || `Enter ${field.label.toLowerCase().replace(' *', '')}`}
          rows={3} style={{ ...formFieldStyle, resize: 'vertical', minHeight: '60px', fontFamily: 'inherit' }} />
      ) : (
        <div style={{ position: 'relative' }}>
          {isTel && <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '12px', pointerEvents: 'none' }}>+91</span>}
          <input
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
        <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '4px' }}>
          {formatHint(field.key, val) || field.hint}
        </div>
      )}
    </div>
  );
};

/**
 * The body of one tab: either a plain grid of fields, or sub-headed blocks when the group
 * defines them.
 *
 * Anything in `group.fields` that no block claims is still rendered, after the blocks. That is
 * deliberate belt-and-braces: a field added to a group but forgotten in its blocks would
 * otherwise disappear from the form while still being saved from `form` state, which is the
 * quietest possible way to lose a value.
 */
const renderGroupBody = (
  group: FieldGroup,
  fieldsMap: Map<string, FieldDef>,
  renderOne: (field: FieldDef) => React.ReactNode,
): React.ReactNode => {
  const gridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' } as const;
  if (!group.blocks || group.blocks.length === 0) {
    return <div style={gridStyle}>{group.fields.map((key) => { const f = fieldsMap.get(key); return f ? renderOne(f) : null; })}</div>;
  }
  const claimed = new Set(group.blocks.flatMap((b) => b.fields));
  const leftover = group.fields.filter((k) => !claimed.has(k));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {group.blocks.map((block) => (
        <div key={block.title}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '2px' }}>{block.title}</div>
          {block.note && <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>{block.note}</div>}
          <div style={gridStyle}>
            {block.fields.map((key) => { const f = fieldsMap.get(key); return f ? renderOne(f) : null; })}
          </div>
        </div>
      ))}
      {leftover.length > 0 && (
        <div style={gridStyle}>
          {leftover.map((key) => { const f = fieldsMap.get(key); return f ? renderOne(f) : null; })}
        </div>
      )}
    </div>
  );
};

export const CreateAssayerModal: React.FC<{
  onClose: () => void;
  onCreated: () => void;
  /** Overrides `?section=` when the opening screen already knows which section it wants. */
  initialSection?: string;
}> = ({ onClose, onCreated, initialSection }) => {
  const { toast } = useToast();
  const [urlParams] = useSearchParams();
  const wantedTab = sectionTabIndex(initialSection ?? urlParams.get('section'), CREATE_FIELD_GROUPS);
  const [mode, setMode] = useState<'express' | 'advanced'>('express');
  const [form, setForm] = useState<Record<string, string>>(() => {
    // Deliberately blank: the server allocates the code, because it is the only side that can see
    // the codes deleted assayers still hold and can settle a race between two people creating at
    // once. Guessing it from the number of rows on screen produced a duplicate after any delete.
    return {
      assayerCode: '',
      employmentType: 'FULL_TIME',
      department: 'Gold Testing',
      // No state/district/city default. This form used to open pre-filled with Delhi, Central
      // Delhi and New Delhi, which is only correct for one hire in a national roster and wrong
      // for the rest — and wrong in the quietest way, because a pre-filled field reads as
      // already-answered. Everyone outside Delhi had to notice and correct three fields; anyone
      // who didn't notice filed the person into the wrong region, zone and holiday calendar.
      // Experience years had the same problem seeded as "5": a number nobody entered, saved as
      // if they had. Blank now, and the pincode lookup below fills the address for real.
      joiningDate: todayDateKey(),
    };
  });
  const [activeTab, setActiveTab] = useState(wantedTab ?? 0);
  const [submitting, setSubmitting] = useState(false);

  const [addrError, setAddrError] = useState<string | null>(null);
  const [addrLookup, setAddrLookup] = useState(false);
  const { skills, languages, certifications } = useWorkforceVocabulary();
  const vocabulary = { skills, languages, certifications };
  /**
   * Express mode has no tabs, so a `?section=financial` link opens the collapsed bank block
   * instead — otherwise the deep link works in Advanced and silently does nothing in the mode
   * most people are actually in, which is the failure it was added to prevent.
   */
  // Every name the Money tab answers to, not just "financial" — the tab merge would otherwise
  // have left `?section=money` and `?section=pay` opening Express mode with the bank block still
  // collapsed, which is precisely the failure the collapsed-block deep link was added to prevent.
  const [showBank, setShowBank] = useState(
    ['financial', 'money', 'pay', 'bank'].includes((initialSection ?? urlParams.get('section') ?? '').trim().toLowerCase()),
  );

  /**
   * Ask the postal directory what a pincode actually is, and hand the answer back.
   *
   * This used to be a submit-time consistency *check*: the operator filled the whole form, hit
   * save, and was told "Pincode 682001 is in Kerala but you selected Delhi" — after the typing,
   * with no offer to fix it. Worse, `handleSubmit` awaited it and then read `addrError` in the
   * same tick it was set, so the state it tested was always the previous render's value: a real
   * conflict sailed through on the first attempt and only blocked the second.
   *
   * So it returns its finding instead of writing it to state, which makes it usable both on
   * blur (to fill state/district in for the operator) and at submit (to test the fresh answer).
   */
  const resolvePincode = async (pincode: string): Promise<{ state: string; district: string } | null> => {
    if (!/^\d{6}$/.test(pincode || '')) return null;
    try {
      /**
       * Five seconds, not the usual thirty, because of who is on the other end and who is waiting.
       *
       * This is a third-party host we neither operate nor monitor, and `handleSubmit` *awaits*
       * this call before saving — so whatever this does, the operator watches it do. An unbounded
       * fetch to an unreachable third party therefore froze the whole submit with the button
       * disabled and nothing to click.
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
  const addressConflict = (po: { state: string; district: string }, pincode: string, state: string, district: string): string | null => {
    if (state && po.state && state.trim().toLowerCase() !== po.state.trim().toLowerCase()) {
      return `Pincode ${pincode} is in ${po.state}, but the state is set to ${state}. Change one of the two before saving.`;
    }
    if (district && po.district && district.trim().toLowerCase() !== po.district.trim().toLowerCase()) {
      return `Pincode ${pincode} is usually recorded as ${po.district} district. "${district}" will be saved as entered.`;
    }
    return null;
  };

  /**
   * On blur of the pincode: fill in whatever the operator has not typed, warn only about a real
   * contradiction. Filling blanks rather than demanding them is the whole point — a pincode is
   * six digits the office always has, and state and district follow from it.
   */
  const applyPincodeLookup = async (pincode: string) => {
    if (!/^\d{6}$/.test((pincode || '').trim())) { setAddrError(null); return; }
    setAddrLookup(true);
    const po = await resolvePincode(pincode.trim());
    setAddrLookup(false);
    if (!po) { setAddrError(null); return; }
    setForm((prev) => ({
      ...prev,
      state: prev.state || po.state,
      district: prev.district || po.district,
      city: prev.city || po.district,
    }));
    setAddrError(addressConflict(po, pincode.trim(), form.state, form.district));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // The select-backed required fields (State) used to be blocked from submitting empty by the
    // browser's own <select required> constraint validation; the custom dropdown doesn't
    // participate in that, so the check is re-asserted explicitly here.
    const missingRequired = CREATE_FIELDS.filter((f) => f.required && f.options && !form[f.key]?.trim());
    if (missingRequired.length > 0) {
      toast({ type: 'error', title: 'Missing required field', message: `${missingRequired.map((f) => f.label).join(', ')} must be set.` });
      return;
    }
    setSubmitting(true);
    try {
      // Tested against the value this call just returned, not against `addrError` state written
      // in the same tick — that was always one render stale, so the first submit ignored it.
      const po = await resolvePincode(form.pincode || '');
      const conflict = po ? addressConflict(po, (form.pincode || '').trim(), form.state || '', form.district || '') : null;
      if (po && form.state && po.state && form.state.trim().toLowerCase() !== po.state.trim().toLowerCase()) {
        setAddrError(conflict);
        setSubmitting(false);
        toast({ type: 'error', title: 'Pincode and state disagree', message: conflict || '' });
        return;
      }
      // A district that reads differently from the postal directory is normal (post offices and
      // revenue districts are named differently), so it is shown and saved, never blocked.
      setAddrError(conflict);
      const firstName = form.firstName?.trim() || '';
      const lastName = form.lastName?.trim() || '';
      // Left blank, the server allocates the next free code. It used to be guessed here from the
      // number of assayers on screen — a count of active people, blind to the codes that deleted
      // assayers keep — so the first create after any delete was refused as a duplicate.
      const autoCode = form.assayerCode?.trim();

      const rawPhone = form.phone?.replace(/\D/g, '') || '';
      const formattedPhone = rawPhone ? (rawPhone.startsWith('91') ? `+${rawPhone}` : `+91${rawPhone}`) : '';

      const body: any = {
        // Omitted entirely when blank rather than sent as "", so the server takes it as "allocate
        // one for me". An empty string is a value, and the DTO rejects it as empty.
        ...(autoCode ? { assayerCode: autoCode } : {}),
        firstName: firstName,
        lastName: lastName,
        phone: formattedPhone,
        // No invented address. This used to fabricate first.last@fapoms.com for anyone without
        // an email — a mailbox that does not exist, that notifications were then sent to, and
        // that collides outright for the second "Ravi Kumar" on the roster.
        email: form.email?.trim() || null,
        address: form.address?.trim() || '',
        city: form.city?.trim() || '',
        district: form.district?.trim() || form.city?.trim() || '',
        state: form.state?.trim() || '',
        pincode: form.pincode?.trim() || null,
        employmentType: form.employmentType || 'FULL_TIME',
        department: form.department || 'Operations',
        experienceYears: form.experienceYears ? Number(form.experienceYears) : 0,
        joiningDate: form.joiningDate ? new Date(form.joiningDate).toISOString() : new Date().toISOString(),
        alternatePhone: form.alternatePhone?.trim() || null,
        region: form.region?.trim() || null,
        employeeId: form.employeeId?.trim() || null,
        employeeCode: form.employeeCode?.trim() || null,
        panNumber: form.panNumber?.trim() || null,
        bankAccountNumber: form.bankAccountNumber?.trim() || null,
        ifscCode: form.ifscCode?.trim() || null,
        notes: form.notes?.trim() || null,
        // Picked from the roster vocabulary; omitted entirely when nothing was chosen so an
        // untouched field never blanks out what is already on the record.
        ...(parseList(form.skills).length ? { skills: parseList(form.skills) } : {}),
        ...(parseList(form.languages).length ? { languages: parseList(form.languages) } : {}),
        ...(parseList(form.certifications).length
          ? { certifications: parseList(form.certifications).map((name) => ({ name, expiryDate: '' })) }
          : {}),
      };

      const created = await api.request<any>('/assayers', { method: 'POST', body: JSON.stringify(body) });
      const createdId = created?.id ?? (created?.data as any)?.id;
      const baseFee = Number(form.baseFee) || 0;
      const hourlyRate = Number(form.hourlyRate) || 0;
      const dailyRate = Number(form.dailyRate) || 0;
      if (createdId && (baseFee > 0 || hourlyRate > 0 || dailyRate > 0)) {
        await api.request(`/assayers/${createdId}/commercial`, {
          method: 'POST',
          body: JSON.stringify({
            baseFee, hourlyRate, dailyRate,
            travelReimbursement: Number(form.travelReimbursement) || 0,
            accommodationAllowance: Number(form.accommodationAllowance) || 0,
            mealAllowance: Number(form.mealAllowance) || 0,
            currency: 'INR',
            effectiveStartDate: new Date().toISOString(),
          }),
        });
      }
      onCreated();
    } catch (err) {
      toast({ type: 'error', title: 'Could not create assayer', message: userMessage(err) });
    } finally {
      setSubmitting(false);
    }
  };

  const fieldsMap = new Map(CREATE_FIELDS.map(f => [f.key, f]));
  const currentGroup = CREATE_FIELD_GROUPS[activeTab];
  /** Only a state that disagrees with the pincode stops a save; see addressConflict. */
  const addrBlocking = !!addrError && addrError.includes('Change one of the two');

  return (
    <Modal
      open
      onClose={onClose}
      width="720px"
      height="min(680px, 85vh)"
      closeIcon={<X size={18} />}
      asForm
      onSubmit={handleSubmit}
      title={<><User size={18} style={{ color: 'var(--accent-primary)' }} /> Enroll New Assayer</>}
      footer={
        mode === 'express' ? (
          <>
            <button type="button" onClick={onClose} className="btn btn-secondary" style={{ padding: '9px 18px', fontSize: '13px' }}>Cancel</button>
            <button type="submit" disabled={submitting} className="btn btn-primary" style={{ padding: '9px 22px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--gradient-neon)', color: 'var(--on-gradient)' }}>
              {submitting ? 'Enrolling...' : <><CheckCircle size={16} /> Enroll Assayer Instantly ⚡</>}
            </button>
          </>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              {activeTab > 0 && (
                <button type="button" onClick={() => setActiveTab(activeTab - 1)} className="btn btn-secondary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  ← Previous
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" onClick={onClose} className="btn btn-secondary" style={{ padding: '8px 16px', fontSize: '12px' }}>Cancel</button>
              {activeTab < CREATE_FIELD_GROUPS.length - 1 ? (
                <button type="button" onClick={() => setActiveTab(activeTab + 1)} className="btn btn-primary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  Next →
                </button>
              ) : (
                <button type="submit" disabled={submitting} className="btn btn-primary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {submitting ? 'Saving...' : <><CheckCircle size={14} /> Create Assayer</>}
                </button>
              )}
            </div>
          </div>
        )
      }
    >
      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
        Only a first name, a last name and a state are needed to create the record. Everything
        else can be filled in now or later — anything left blank is listed on the record as a gap.
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <div style={{ background: 'rgba(255,255,255,0.06)', padding: '3px', borderRadius: '8px', display: 'flex', gap: '2px', border: '1px solid var(--border-color)' }}>
          <button
            type="button"
            onClick={() => setMode('express')}
            style={{
              padding: '5px 12px',
              fontSize: '11px',
              fontWeight: 700,
              borderRadius: '6px',
              border: 'none',
              cursor: 'pointer',
              background: mode === 'express' ? 'var(--accent-primary)' : 'transparent',
              color: mode === 'express' ? 'var(--on-accent)' : 'var(--text-muted)',
            }}
          >
            ⚡ Express Mode
          </button>
          <button
            type="button"
            onClick={() => setMode('advanced')}
            style={{
              padding: '5px 12px',
              fontSize: '11px',
              fontWeight: 700,
              borderRadius: '6px',
              border: 'none',
              cursor: 'pointer',
              background: mode === 'advanced' ? 'var(--accent-primary)' : 'transparent',
              color: mode === 'advanced' ? 'var(--on-accent)' : 'var(--text-muted)',
            }}
          >
            📋 Advanced ({CREATE_FIELD_GROUPS.length} Tabs)
          </button>
        </div>
      </div>

      {mode === 'express' ? (
        <>
          <div style={{ background: 'var(--status-pending-bg)', border: '1px solid rgba(216,174,71,0.25)', padding: '12px 16px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>Auto-Generated Assayer Code</span>
              <span style={{ fontSize: '15px', fontWeight: 800, fontFamily: 'monospace', color: 'var(--accent-primary)' }}>
                {form.assayerCode || 'Assigned when you save'}
              </span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>Department</span>
              {/* Echoes the value actually on the form — it used to print "Gold Testing & Assay"
                  as a fixed string, which stayed on screen after Advanced mode changed it. */}
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--success)' }}>{form.department || 'Operations'}</span>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '14px' }}>
            <div>
              <label style={labelStyle}>First Name <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input
                type="text"
                required
                placeholder="e.g. Deepak"
                className="form-input"
                style={formFieldStyle}
                value={form.firstName || ''}
                onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              />
            </div>

            <div>
              <label style={labelStyle}>Last Name <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input
                type="text"
                required
                placeholder="e.g. Verma"
                className="form-input"
                style={formFieldStyle}
                value={form.lastName || ''}
                onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              />
            </div>

            <div>
              <label style={labelStyle}>Mobile Phone Number</label>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '12px', pointerEvents: 'none' }}>+91</span>
                <input
                  type="tel"
                  placeholder="9876543217"
                  maxLength={10}
                  style={{ ...formFieldStyle, paddingLeft: '42px' }}
                  value={form.phone || ''}
                  onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, '') })}
                />
              </div>
            </div>

            <div>
              <label style={labelStyle}>Email Address (Optional)</label>
              <input
                type="email"
                placeholder="deepak.verma@fapoms.com"
                className="form-input"
                style={formFieldStyle}
                value={form.email || ''}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              {/* Not required. Express mode marked phone, address, pincode and city mandatory
                  while the field table beside it, and the server DTO behind both, treated all
                  four as optional — so the "fast" path was the strict one, and a roster row that
                  genuinely has no phone could not be entered at all. Only first name, last name
                  and state are required, which is exactly what CreateAssayerRequestDto demands. */}
              <label style={labelStyle}>Base Street Address</label>
              <input
                type="text"
                placeholder="e.g. Connaught Place, Radial Road 1"
                className="form-input"
                style={formFieldStyle}
                value={form.address || ''}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
            </div>

            <div>
              <label style={labelStyle}>Pincode {addrLookup && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· looking up…</span>}</label>
              {/* Autocomplete now has a real `onBlur`, which fires only once focus has left the
                  whole control. The previous wrapper <div> caught bubbled focusout, so moving
                  the mouse into the suggestion list counted as leaving the field and looked up
                  a half-typed pincode — reporting it as unknown a moment before the click that
                  would have filled in a valid one. */}
              <Autocomplete
                value={form.pincode || ''}
                onBlur={(v) => { void applyPincodeLookup(v); }}
                onChange={(v) => setForm({ ...form, pincode: v })}
                onSelect={(place) => {
                  const next: Record<string, string> = { ...form, pincode: place.pincode || form.pincode || '' };
                  if (place.district) { next.district = place.district; }
                  if (place.state) { next.state = place.state; }
                  if (!next.city) next.city = (place.label || '').split(',')[0].trim();
                  setForm(next);
                  setAddrError(null);
                }}
                placeholder="Search pincode, e.g. 110001"
                filterType={(r) => !!r.pincode}
              />
              <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '4px' }}>Fills in city and state for you.</div>
            </div>

            <div>
              <label style={labelStyle}>City / Base District</label>
              <Autocomplete
                value={form.city || ''}
                onChange={(v) => setForm({ ...form, city: v, district: v })}
                onSelect={(place) => {
                  const next: Record<string, string> = { ...form, city: (place.label || '').split(',')[0].trim() };
                  if (place.district) next.district = place.district;
                  if (place.state) next.state = place.state;
                  setForm(next);
                }}
                placeholder="Type to search city / district…"
              />
            </div>

            <div>
              <label style={labelStyle}>State <span style={{ color: 'var(--danger)' }}>*</span></label>
              <Select
                value={form.state || ''}
                onChange={(v) => {
                  setForm({ ...form, state: v });
                  // Re-check against the pincode with the state the operator just picked, not the
                  // one still in `form` — reading it back from state here compared the old value.
                  void resolvePincode(form.pincode || '').then((po) => setAddrError(po ? addressConflict(po, (form.pincode || '').trim(), v, form.district || '') : null));
                }}
                options={INDIAN_STATES.map(st => ({ value: st.value, label: st.label }))}
                placeholder="-- Select State --"
                style={{ width: '100%' }}
              />
              <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '4px' }}>Sets their region, zone and holiday calendar.</div>
            </div>

            {addrError && (
              <div style={{
                gridColumn: '1 / -1', padding: '9px 12px', borderRadius: '8px', fontSize: '12.5px',
                // A district named differently from the postal directory is normal and saves fine,
                // so it must not be dressed up in the same red as a state that cannot be saved.
                background: addrBlocking ? 'var(--status-cancelled-bg)' : 'var(--status-pending-bg)',
                color: addrBlocking ? 'var(--danger)' : 'var(--warning)',
                display: 'flex', gap: '7px', alignItems: 'center',
              }}>
                <AlertTriangle size={14} /> {addrError}
              </div>
            )}

            <div>
              <label style={labelStyle}>Employment Type</label>
              <Select
                value={form.employmentType || 'FULL_TIME'}
                onChange={(v) => setForm({ ...form, employmentType: v })}
                options={EMPLOYMENT_TYPES.map(o => ({ value: o.value, label: o.label }))}
                style={{ width: '100%' }}
              />
            </div>

            {/**
              * Bank and tax details, offered here rather than only on Advanced tab four.
              *
              * Not one assayer on the roster has a bank account recorded. The fields were never
              * missing — they were three clicks into a mode most people never switch to, on a tab
              * called "Financial", at the moment when whoever is enrolling the person is holding
              * exactly the paperwork these come from. Collapsed by default so the express path
              * stays short, but one click away and saying out loud what it is for.
              */}
            <div style={{ gridColumn: '1 / -1' }}>
              <button
                type="button"
                onClick={() => setShowBank(!showBank)}
                style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-primary)', fontSize: '12px', fontWeight: 600 }}
              >
                {showBank ? '▾' : '▸'} Bank &amp; tax details (optional)
              </button>
              <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '3px' }}>
                Needed before this person can be paid. Can be added later from Edit.
              </div>
              {showBank && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginTop: '10px' }}>
                  {['panNumber', 'bankAccountNumber', 'ifscCode'].map((key) => {
                    const field = CREATE_FIELDS.find((f) => f.key === key);
                    return field ? renderFormField(field, form, setForm, vocabulary) : null;
                  })}
                </div>
              )}
            </div>

            {/* Competencies, in express too: these decide what work the person can be given, so
                collecting them at enrolment is what makes the record assignable straight away. */}
            <div style={{ gridColumn: '1 / -1', display: 'grid', gap: '12px' }}>
              {['skills', 'languages'].map((key) => {
                const field = CREATE_FIELDS.find((f) => f.key === key);
                return field ? renderFormField(field, form, setForm, vocabulary) : null;
              })}
            </div>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '0', borderBottom: '1px solid var(--border-color)', overflowX: 'auto' }}>
            {CREATE_FIELD_GROUPS.map((group, i) => (
              <button key={group.title} type="button" onClick={() => setActiveTab(i)}
                style={{
                  padding: '8px 14px', background: 'transparent', border: 'none',
                  borderBottom: activeTab === i ? '2px solid var(--accent-primary)' : '2px solid transparent',
                  color: activeTab === i ? 'var(--accent-primary)' : 'var(--text-muted)',
                  fontWeight: activeTab === i ? 700 : 500, fontSize: '12px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap',
                  transition: 'all 0.15s', opacity: activeTab === i ? 1 : 0.6,
                }}>
                {group.icon} {group.title}
              </button>
            ))}
          </div>
          <div key={activeTab} className="tab-pane" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>{currentGroup.title}</div>
            {renderGroupBody(currentGroup, fieldsMap, (field) => renderFormField(
              field, form, setForm, vocabulary,
              (k) => { if (k === 'pincode') void applyPincodeLookup(form.pincode || ''); },
            ))}
          </div>
        </>
      )}
    </Modal>
  );
};

interface FieldGroup {
  title: string;
  icon: React.ReactNode;
  fields: string[];
  /**
   * Other names a `?section=` link may use for this tab. Renaming a tab must never break a link
   * that another screen already sends people through — see `sectionTabIndex`.
   */
  aliases?: string[];
  /**
   * Optional sub-headings inside one tab. Used by "Money", which holds two things a clerk thinks
   * of separately — where the money goes, and how much it is — and which were two tabs before.
   * The keys listed here must all appear in `fields`; anything in `fields` that no block claims
   * is rendered after the blocks, so a field can never be lost by forgetting to list it.
   */
  blocks?: { title: string; note?: string; fields: string[] }[];
}

const EDIT_FIELD_GROUPS: FieldGroup[] = [
  { title: 'Personal', icon: <User size={13} />, fields: ['firstName', 'lastName', 'email', 'phone', 'alternatePhone'] },
  { title: 'Address', icon: <MapPin size={13} />, fields: ['address', 'city', 'district', 'state', 'pincode', 'region'] },
  { title: 'Employment', icon: <Briefcase size={13} />, fields: ['employeeId', 'employeeCode', 'employmentType', 'department', 'joiningDate', 'exitDate', 'terminationDate', 'managerId'] },
  // Named "Money" to match the create form, so the same thing is not called two different things
  // in the two places a clerk meets it. The old `?section=financial` links still land here.
  {
    title: 'Money', icon: <CreditCard size={13} />, aliases: ['financial', 'pay', 'bank'],
    fields: ['panNumber', 'bankAccountNumber', 'ifscCode'],
    blocks: [
      { title: 'How we pay them', note: 'Bank and tax details. Needed before this person can be paid. Rates are set on the Pay screen.', fields: ['panNumber', 'bankAccountNumber', 'ifscCode'] },
    ],
  },
  { title: 'Skills', icon: <Award size={13} />, fields: ['experienceYears', 'skills', 'languages', 'certifications', 'performanceRating', 'maxDailyWorkload', 'maxWeeklyWorkload'] },
  { title: 'Emergency', icon: <Phone size={13} />, fields: ['emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation'] },
  { title: 'Other', icon: <Clock size={13} />, fields: ['workingHoursStart', 'workingHoursEnd', 'notes'] },
];

export const EditAssayerModal: React.FC<{
  assayer: Assayer;
  onClose: () => void;
  onUpdated: () => void;
  /** Overrides `?section=` when the opening screen already knows which section it wants. */
  initialSection?: string;
}> = ({ assayer, onClose, onUpdated, initialSection }) => {
  const { toast } = useToast();
  const [urlParams] = useSearchParams();
  const wantedTab = sectionTabIndex(initialSection ?? urlParams.get('section'), EDIT_FIELD_GROUPS);
  const [form, setForm] = useState<Record<string, string>>(() => {
    const f: Record<string, string> = {};
    EDIT_FIELDS.forEach(field => {
      let val = (assayer as any)[field.key];
      if (field.key === 'workingHoursStart') val = assayer.workingHours?.start || '';
      else if (field.key === 'workingHoursEnd') val = assayer.workingHours?.end || '';
      // Certifications are stored as {name, expiryDate}; the picker works in names, and the
      // expiry dates already on the record are re-attached on save rather than being dropped.
      else if (field.key === 'certifications') val = stringifyList((assayer.certifications || []).map((c) => c.name).filter(Boolean));
      else if (field.vocab) val = stringifyList(Array.isArray(val) ? val.map(String).filter(Boolean) : []);
      else if (field.key === 'latitude' || field.key === 'longitude') val = val !== null && val !== undefined ? String(val) : '';
      else if (field.key === 'joiningDate' || field.key === 'exitDate' || field.key === 'terminationDate') val = val ? new Date(val).toISOString().split('T')[0] : '';
      else val = val !== null && val !== undefined ? String(val) : '';
      f[field.key] = val;
    });
    return f;
  });
  const [activeEditTab, setActiveEditTab] = useState(wantedTab ?? 0);
  const [submitting, setSubmitting] = useState(false);
  const { skills, languages, certifications } = useWorkforceVocabulary();
  const vocabulary = { skills, languages, certifications };
  // Loaded for the reporting-manager picker on the Employment tab. `assayer.id` is excluded
  // so nobody can be saved as their own manager, which the column would happily have stored.
  const managers = useManagerOptions(true, assayer.id);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true);
    try {
      const { body, problems } = buildAssayerEditBody(EDIT_FIELDS, form, assayer);
      if (problems.length) {
        toast({ type: 'error', title: 'Could not save changes', message: problems.join(' ') });
        return;
      }
      await api.request(`/assayers/${assayer.id}`, { method: 'PUT', body: JSON.stringify(body) });
      onUpdated();
    } catch (err) { toast({ type: 'error', title: 'Could not save changes', message: userMessage(err) }); }
    finally { setSubmitting(false); }
  };

  const statusColor = STATUS_COLORS[assayer.lifecycleStatus || assayer.status] || 'var(--text-muted)';

  const fieldsMap = new Map(EDIT_FIELDS.map(f => [f.key, f]));
  const currentGroup = EDIT_FIELD_GROUPS[activeEditTab];

  return (
    <Modal
      open
      onClose={onClose}
      width="720px"
      height="min(680px, 85vh)"
      closeIcon={<X size={18} />}
      asForm
      onSubmit={handleSubmit}
      title={<><Edit2 size={18} style={{ color: 'var(--accent-primary)' }} /> Edit Assayer</>}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            {activeEditTab > 0 && (
              <button type="button" onClick={() => setActiveEditTab(activeEditTab - 1)} className="btn btn-secondary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                ← Previous
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" onClick={onClose} className="btn btn-secondary" style={{ padding: '8px 16px', fontSize: '12px' }}>Cancel</button>
            {activeEditTab < EDIT_FIELD_GROUPS.length - 1 ? (
              <>
                {/* Someone sent here by a "no bank details" link came to fill in one section and
                    leave. Without this they would have to press Next through four tabs they were
                    never asked about before the only Save button appeared. */}
                {wantedTab !== null && (
                  <button type="submit" disabled={submitting} className="btn btn-secondary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {submitting ? 'Saving...' : <><CheckCircle size={14} /> Save Changes</>}
                  </button>
                )}
                <button type="button" onClick={() => setActiveEditTab(activeEditTab + 1)} className="btn btn-primary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  Next →
                </button>
              </>
            ) : (
              <button type="submit" disabled={submitting} className="btn btn-primary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                {submitting ? 'Saving...' : <><CheckCircle size={14} /> Save Changes</>}
              </button>
            )}
          </div>
        </div>
      }
    >
      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ fontFamily: 'monospace' }}>{assayer.assayerCode}</span>
        <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: statusColor }} />
          {assayer.lifecycleStatus || assayer.status}
        </span>
        <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
        <span>{assayer.displayName}</span>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: '0', borderBottom: '1px solid var(--border-color)', overflowX: 'auto' }}>
        {EDIT_FIELD_GROUPS.map((group, i) => (
          <button key={group.title} type="button" onClick={() => setActiveEditTab(i)}
            style={{
              padding: '8px 14px', background: 'transparent', border: 'none',
              borderBottom: activeEditTab === i ? '2px solid var(--accent-primary)' : '2px solid transparent',
              color: activeEditTab === i ? 'var(--accent-primary)' : 'var(--text-muted)',
              fontWeight: activeEditTab === i ? 700 : 500, fontSize: '12px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap',
              transition: 'all 0.15s', opacity: activeEditTab === i ? 1 : 0.6,
            }}>
            {group.icon} {group.title}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div key={activeEditTab} className="tab-pane" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>{currentGroup.title}</div>
        {renderGroupBody(currentGroup, fieldsMap, (field) => renderFormField(
          field, form, setForm, vocabulary, undefined,
          { options: managers.people, failed: managers.failed },
        ))}
      </div>
    </Modal>
  );
};
