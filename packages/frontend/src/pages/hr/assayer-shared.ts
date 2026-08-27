import type { CSSProperties } from 'react';
import { AssayerLifecycleStatus, ASSAYER_RECORD_FIELDS, CRITICAL_ASSAYER_RECORD_FIELDS, missingAssayerRecordFields } from '@fapoms/shared';

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
  hrOwnerName?: string | null;
  engagementType?: string | null;
  unavailableReason?: string | null;
  workDoneBySomeoneElse?: boolean;
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
  why: f.blocks.charAt(0).toLowerCase() + f.blocks.slice(1),
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
    why: f.blocks.charAt(0).toLowerCase() + f.blocks.slice(1),
  }));
}

/** Rupees with an em-dash for empty, matching the workforce screens. */
export { money } from '../../utils/money';

/** The small uppercase caption style repeated across the workforce record surfaces. */
export const fieldLabelStyle: CSSProperties = {
  fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)',
};

/** The subset of a form field's definition that decides how its value is sent. */
export interface EditableFieldShape {
  key: string;
  type?: string;
  vocab?: 'skills' | 'languages' | 'certifications';
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
  current: Pick<Assayer, 'workingHours' | 'certifications'>,
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
