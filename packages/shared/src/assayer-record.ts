/**
 * What every assayer's record needs, and what it costs when a field is blank.
 *
 * This list existed twice, and the two copies disagreed. The web app kept `CRITICAL_FIELDS`
 * (six fields, including the phone number) and the HR service kept `RECORD_FIELDS` (five
 * critical columns, without it). So the roster's "Incomplete record" filter and the paperwork
 * page's incomplete list counted different people — and precisely in the common case, because
 * the client rosters this system imports arrive with no phone column at all, which is the
 * reason the phone was made a gap in the record rather than a barrier to admission.
 *
 * One list, read by both. `column` is for SQL, `key` for the API's camelCase records.
 */
export interface AssayerRecordField {
  /** Postgres column on `assayers`. */
  column: string;
  /** Property on the API's assayer record. */
  key: string;
  label: string;
  /** Critical fields are the ones the roster and the paperwork page both call "incomplete". */
  critical: boolean;
  /** What stays blocked while it is blank, in the words the screen shows. */
  blocks: string;
}

export const ASSAYER_RECORD_FIELDS: AssayerRecordField[] = [
  // Blocks calling and phone-channel dispatch. Critical, but never a barrier to admission —
  // a record without one is imported and then worked, rather than refused at the door.
  { column: 'phone', key: 'phone', critical: true, label: 'Phone', blocks: 'Calling and phone-channel dispatch' },
  { column: 'pan_number', key: 'panNumber', critical: true, label: 'PAN', blocks: 'TDS deduction and statutory filing' },
  { column: 'bank_account_number', key: 'bankAccountNumber', critical: true, label: 'Bank account', blocks: 'Payouts' },
  { column: 'ifsc_code', key: 'ifscCode', critical: true, label: 'IFSC', blocks: 'Payouts' },
  { column: 'joining_date', key: 'joiningDate', critical: true, label: 'Joining date', blocks: 'Tenure, leave accrual and exit settlement' },
  { column: 'emergency_contact_phone', key: 'emergencyContactPhone', critical: true, label: 'Emergency contact', blocks: 'Duty-of-care for field staff' },
  { column: 'email', key: 'email', critical: false, label: 'Email', blocks: 'System notifications' },
  { column: 'employment_type', key: 'employmentType', critical: false, label: 'Employment type', blocks: 'Contract terms' },
  { column: 'manager_id', key: 'managerId', critical: false, label: 'Reporting manager', blocks: 'Escalation path' },
  { column: 'photograph', key: 'photograph', critical: false, label: 'Photograph', blocks: 'Field ID verification' },
  { column: 'address', key: 'address', critical: false, label: 'Address', blocks: 'Travel planning' },

  /**
   * Fields the record has always held and this list never mentioned, so nothing counted them
   * and no screen flagged them. Measured against the imported roster of 1,163 people: 1,155
   * with no coordinates, 1,155 with no pincode, 456 with no Aadhaar, 450 with no city.
   *
   * `latitude` stands for the pair — coordinates are written together or not at all, and two
   * entries would report one gap twice. It is the only critical one here, and it is critical
   * because of what happens silently without it: `recommendation.engine.ts` returns `true` from
   * its distance check when either side has no coordinates, so a candidate who lives four
   * states away passes the "near enough" filter rather than being excluded by it. Nothing on
   * any screen said those records were being planned blind.
   *
   * They are blank because the bulk importer writes entities straight through the transaction
   * manager, which skips the geocoding `create()` and `update()` do. Fixing the data is a
   * geocoding run; this is the part that makes the gap visible in the meantime.
   */
  { column: 'latitude', key: 'latitude', critical: true, label: 'Map location', blocks: 'Distance filtering, travel costs and day planning' },
  { column: 'pincode', key: 'pincode', critical: false, label: 'Pincode', blocks: 'Geocoding and travel estimates' },
  { column: 'city', key: 'city', critical: false, label: 'City or town', blocks: 'Local dispatch and travel planning' },
  { column: 'region', key: 'region', critical: false, label: 'Region', blocks: 'Regional scoping and work allocation' },
  { column: 'aadhaar_number', key: 'aadhaarNumber', critical: false, label: 'Aadhaar', blocks: 'Identity verification for branch access' },
  { column: 'bank_name', key: 'bankName', critical: false, label: 'Bank name', blocks: 'Payment reconciliation' },
  { column: 'date_of_birth', key: 'dateOfBirth', critical: false, label: 'Date of birth', blocks: 'Statutory records' },
  { column: 'qualification', key: 'qualification', critical: false, label: 'Qualification', blocks: 'Evidence of competence' },
];

export const CRITICAL_ASSAYER_RECORD_FIELDS = ASSAYER_RECORD_FIELDS.filter((f) => f.critical);

/**
 * The critical fields a record is still missing. Blank means null, absent, or whitespace only —
 * the same test the SQL side applies with `IS NULL OR ::text = ''`.
 */
export function missingAssayerRecordFields(
  record: Record<string, unknown> | null | undefined,
): AssayerRecordField[] {
  if (!record) return [];
  return CRITICAL_ASSAYER_RECORD_FIELDS.filter((f) => {
    const value = record[f.key];
    return value == null || String(value).trim() === '';
  });
}

/**
 * The operational status planning reads, derived from the HR lifecycle.
 *
 * Two columns describe whether somebody can be sent to work: `lifecycle_status` is what HR
 * decided, and `status` is the projection every planner filters on — the recommendation engine,
 * the day planner, the command centre's capacity figures, the operations snapshot.
 *
 * The projection is not a second opinion. It exists so those queries can filter on one indexed
 * column, and it is only ever correct if every writer of the lifecycle derives it. The state
 * machine did; the roster importer wrote `lifecycleStatus` straight onto the entity and left
 * `status` at its column default of ACTIVE, so 536 people who had resigned, been terminated,
 * suspended or gone inactive were operationally active and offered as audit candidates.
 *
 * Lives here, in shared, so the entity can apply it in a lifecycle hook without importing the
 * state machine that imports the entity.
 *
 * `ON_LEAVE` deliberately maps to INACTIVE rather than ACTIVE: leave means not available, and
 * folding it into ACTIVE left somebody marked away in HR sitting in the candidate pool and
 * counted as capacity. The dated rows in `leaves` remain the per-date check — "is this person
 * away on the 14th" is a different question from "is this person away at all".
 */
export function operationalStatusFor(lifecycle: string | null | undefined): 'ACTIVE' | 'SUSPENDED' | 'INACTIVE' {
  if (lifecycle === 'ACTIVE') return 'ACTIVE';
  if (lifecycle === 'SUSPENDED') return 'SUSPENDED';
  return 'INACTIVE';
}
