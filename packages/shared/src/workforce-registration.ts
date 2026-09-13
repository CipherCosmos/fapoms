import { ASSAYER_RECORD_FIELDS, CRITICAL_ASSAYER_RECORD_FIELDS } from './assayer-record';
import type { AssayerRecordField } from './assayer-record';

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
