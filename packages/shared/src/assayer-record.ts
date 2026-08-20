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
