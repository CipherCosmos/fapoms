import { ASSAYER_RECORD_FIELDS, CRITICAL_ASSAYER_RECORD_FIELDS } from './assayer-record';
import type { AssayerRecordField } from './assayer-record';
import { maskTail } from './assayer-qualification';

/**
 * One registration, whoever is typing.
 *
 * The roster used to have four front doors, and each one collected a different amount of the same
 * person. The desk wizard asked for identity, bank and emergency contact; the candidate's own form
 * asked for none of them and uploaded a scan of the PAN card without ever asking for the number;
 * the bulk import asked for whatever the spreadsheet happened to hold. A candidate approved through
 * the newest of those doors reached the roster with 48 of 86 columns filled and could not be paid,
 * assigned, carded, or signed in — which is the whole of the complaint that produced this file.
 *
 * So the answers live in ONE place and are described ONCE. An application carries its own columns
 * for the things only an application has (the token, the review, the employment category the
 * candidate chose), and everything else is carried under `extendedProfile.fields` KEYED BY THE
 * ASSAYER RECORD'S OWN FIELD NAMES. Promotion then needs no mapping table: it hands the object to
 * the same guarded `AssayerService.update` the desk has always used.
 *
 * The list below is therefore not a second dictionary. It is a statement about which of the
 * record's fields registration is allowed to fill in, and `registration-fields.spec.ts` fails if a
 * field the record calls critical is not collectable here.
 */

/**
 * Fields an application may carry for the person it will become.
 *
 * Names are `AssayerEntity` property names, because that is what `extendedProfile.fields` is fed
 * to. Anything not on this list is refused rather than silently dropped — an application must not
 * become a channel for setting fields the desk cannot set on the record itself.
 */
export const REGISTRATION_RECORD_FIELD_KEYS = [
  // Reachability. `phone` is critical: no phone, no dispatch call.
  'phone', 'alternatePhone',
  // Identity. The numbers, not only the scans — a scan cannot be matched against a TDS filing.
  'panNumber', 'aadhaarNumber', 'legalName',
  // Money. All three, or the person cannot be paid at all.
  'bankAccountNumber', 'ifscCode', 'bankName',
  // Duty of care. A field worker with no reachable contact is the gap nobody notices until it
  // is the only thing that matters.
  'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
  // Competence. Terms are NOT here — see `EMPLOYMENT_TERM_FIELD_KEYS`: a candidate must not be
  // able to set their own joining date, employment type or region by putting one in their form.
  'qualification', 'experienceYears',
  // Where they are.
  //
  // `preferredRegions`, `languages` and `skills` are deliberately NOT here. They are the assayer's
  // own to maintain from their profile once they have an account — the same decision the desk
  // wizard records as THEIRS_TO_MAINTAIN — and a key on this list that no form asks for is the
  // dead definition this file exists to prevent.
  'latitude', 'longitude', 'district',
] as const;

export type RegistrationRecordFieldKey = typeof REGISTRATION_RECORD_FIELD_KEYS[number];

/**
 * The three an application must never hold in the clear.
 *
 * The record encrypts these columns; the application — the same numbers, typed by the same person,
 * minutes earlier — stored them as plain text in a jsonb column, kept them after approval, and
 * returned them whole to every HR screen. They are the numbers that open a bank account, file a tax
 * return and prove an identity, so they are encrypted in the application too, shown to staff as
 * their last four, and cleared from the application once the record holds them.
 *
 * `ifscCode` and `bankName` are deliberately NOT here: a branch code identifies a bank, not a
 * person, and masking it would only stop the desk seeing which bank it is.
 */
export const REGISTRATION_SECRET_FIELD_KEYS: readonly RegistrationRecordFieldKey[] = [
  'panNumber', 'aadhaarNumber', 'bankAccountNumber',
];

export function isRegistrationSecretField(key: string): boolean {
  return (REGISTRATION_SECRET_FIELD_KEYS as readonly string[]).includes(key);
}

/**
 * The same fields with their secrets reduced to a last-four mask, for any response a staff screen
 * receives. Values that are already masked, empty or not strings are left as they are.
 */
export function maskRegistrationFields(
  fields: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(fields ?? {}) };
  for (const key of REGISTRATION_SECRET_FIELD_KEYS) {
    const value = out[key];
    if (typeof value === 'string' && value.trim() !== '') out[key] = maskTail(value);
  }
  return out;
}

/**
 * HOW THOSE FIELDS REACH THE RECORD: IN GROUPS THAT FAIL ALONE.
 *
 * Approving an application used to hand every one of the fields above to a single
 * `AssayerService.update`. That call validates as it goes — a PAN already on somebody else, an
 * IFSC that does not exist, a district that contradicts the pincode — and one refusal threw away
 * the entire payload. The approval still completed, the person appeared on the roster, and the
 * onboarding drawer then asked the desk for the PAN, the Aadhaar, the bank account, the emergency
 * contact and the qualification all over again, from an empty record, for data the candidate had
 * already typed in. That is the "we are asking for things we already have" report.
 *
 * So each group is applied on its own, and a refusal costs that group and nothing else. The
 * boundaries are not arbitrary — each is a set the update genuinely validates TOGETHER:
 *
 *  - `location` must travel as one: coordinates are taken only when latitude AND longitude arrive
 *    together, and a district is checked against the stored pincode.
 *  - `bank` is the three things a payout needs; half of them is no more payable than none.
 *  - `identity` is what the duplicate check looks at, so its refusal is the likeliest one.
 *
 * `registration-field-groups.spec.ts` fails if a key on the allow-list is in no group, or in two.
 */
export const REGISTRATION_FIELD_GROUPS: ReadonlyArray<{
  name: 'identity' | 'bank' | 'contact' | 'competence' | 'location';
  label: string;
  keys: readonly RegistrationRecordFieldKey[];
}> = [
  { name: 'identity', label: 'identity numbers', keys: ['panNumber', 'aadhaarNumber', 'legalName'] },
  { name: 'bank', label: 'bank details', keys: ['bankAccountNumber', 'ifscCode', 'bankName'] },
  {
    name: 'contact',
    label: 'contact details',
    keys: ['phone', 'alternatePhone', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation'],
  },
  { name: 'competence', label: 'qualification and experience', keys: ['qualification', 'experienceYears'] },
  { name: 'location', label: 'location', keys: ['latitude', 'longitude', 'district'] },
];

/**
 * An application's fields split into the groups above, dropping empty groups.
 *
 * Keys not on the allow-list are left out entirely — the allow-list is the rule for what an
 * application may set, and grouping must never become a way around it.
 */
export function groupRegistrationRecordFields(
  fields: Record<string, unknown>,
): Array<{ name: string; label: string; values: Record<string, unknown> }> {
  const out: Array<{ name: string; label: string; values: Record<string, unknown> }> = [];
  for (const group of REGISTRATION_FIELD_GROUPS) {
    const values: Record<string, unknown> = {};
    for (const key of group.keys) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) values[key] = fields[key];
    }
    if (Object.keys(values).length > 0) out.push({ name: group.name, label: group.label, values });
  }
  return out;
}


/** Is this key one an application is allowed to carry into the record? */
export function isRegistrationRecordField(key: string): key is RegistrationRecordFieldKey {
  return (REGISTRATION_RECORD_FIELD_KEYS as readonly string[]).includes(key);
}

/**
 * Keep only the keys registration may set, from an object that may hold anything.
 *
 * Used on both intake paths so the candidate's form and the desk's wizard are filtered by the
 * same rule, and used before the object is stored rather than after — an application should never
 * hold a field that promotion would refuse to apply.
 */
export function pickRegistrationRecordFields(
  input: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isRegistrationRecordField(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * What only the desk can decide, entered when the application is approved.
 *
 * These are not registration answers and never were: a joining date is an employment decision, a
 * reporting line is an org chart, and a workload ceiling is a scheduling policy. They were
 * therefore collected by nothing at all — `joiningDate` is a CRITICAL record field, is on the
 * registration allow-list, and no form in the product has ever asked for it, so every person
 * promoted through the pipeline landed with it blank.
 *
 * Approval is where they belong: it is the moment somebody with the authority to hire is looking
 * at the person, and the alternative was a reviewer who had to remember to open the new record
 * afterwards and fill in the half the candidate could not.
 *
 * Kept separate from `REGISTRATION_RECORD_FIELD_KEYS` deliberately. A candidate must never be able
 * to set their own joining date or workload ceiling by putting it in their form.
 */
export const EMPLOYMENT_TERM_FIELD_KEYS = [
  'joiningDate', 'employmentType', 'engagementType',
  'managerId', 'department', 'region', 'hrOwnerName',
  'maxDailyWorkload', 'maxWeeklyWorkload',
] as const;

export type EmploymentTermFieldKey = typeof EMPLOYMENT_TERM_FIELD_KEYS[number];

/** Keep only the terms the desk may set at approval, from an object that may hold anything. */
export function pickEmploymentTermFields(
  input: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(EMPLOYMENT_TERM_FIELD_KEYS as readonly string[]).includes(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The fields registration should have collected, with what each one blocks when it did not.
 *
 * The order is the record dictionary's own, so a screen listing gaps and a screen listing the form
 * cannot disagree about what matters most.
 */
export const REGISTRATION_COLLECTABLE_FIELDS: readonly AssayerRecordField[] =
  ASSAYER_RECORD_FIELDS.filter((f) => isRegistrationRecordField(f.key));

/**
 * What an application is still missing, judged against the record it is about to become.
 *
 * Deliberately answered from the MERGED view — the application's own columns plus its
 * `extendedProfile.fields` — because a candidate types their address into one and their bank
 * details into the other, and a gap list that could only see half of that would tell HR to chase
 * things the candidate had already supplied.
 *
 * This does not refuse an approval. The owner's decision, recorded here because the code has to
 * carry it: an approved person IS created, and the gaps travel with them so that the actions that
 * genuinely need the missing field are the ones that refuse, each naming its own reason. A person
 * who cannot yet be paid can still be trained, vetted and put on the roster.
 */
export function missingRegistrationFields(
  merged: Record<string, unknown> | null | undefined,
): AssayerRecordField[] {
  if (!merged) return [...CRITICAL_ASSAYER_RECORD_FIELDS];
  return CRITICAL_ASSAYER_RECORD_FIELDS.filter((f) => {
    const value = merged[f.key];
    return value == null || String(value).trim() === '';
  });
}

/**
 * The application's own columns and its extended profile, seen as one person.
 *
 * `fullName` is the application's word for the record's `displayName`, and `mobile` for `phone`.
 * Those two renames are the only mapping in the whole pipeline, and they live here so that nothing
 * downstream has to remember them.
 */
export function mergedRegistrationView(application: {
  fullName?: string | null;
  mobile?: string | null;
  email?: string | null;
  dateOfBirth?: unknown;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  experienceYears?: number | null;
  employmentCategory?: string | null;
  extendedProfile?: unknown;
}): Record<string, unknown> {
  const profile = (application.extendedProfile ?? null) as { fields?: Record<string, unknown> } | null;
  return {
    displayName: application.fullName ?? null,
    phone: application.mobile ?? null,
    email: application.email ?? null,
    dateOfBirth: application.dateOfBirth ?? null,
    address: application.address ?? null,
    city: application.city ?? null,
    state: application.state ?? null,
    pincode: application.pincode ?? null,
    experienceYears: application.experienceYears ?? null,
    employmentType: application.employmentCategory ?? null,
    ...(profile?.fields ?? {}),
  };
}
