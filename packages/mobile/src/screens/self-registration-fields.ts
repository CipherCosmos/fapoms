/**
 * The record-shaped half of self-registration, by the assayer record's own field names.
 *
 * Its own module so the guard spec can read it without pulling a React Native screen into a Node
 * test — and so the phone and the web form have one list between them rather than two that drift.
 * The server filters what it will keep against `REGISTRATION_RECORD_FIELD_KEYS` in the shared
 * package; this is the subset a candidate is actually asked for.
 */
export const RECORD_FIELD_KEYS = [
  'panNumber', 'aadhaarNumber', 'bankAccountNumber', 'ifscCode', 'bankName',
  'qualification', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
  // A second number, and the district the address sits in. `district` is NOT NULL on the record
  // and defaults to an empty string when nobody supplies it, so every remote registrant landed
  // with a blank one; `alternatePhone` matters because `phone` is critical and often the only one.
  'alternatePhone', 'district',
] as const;

export type RecordFieldKey = typeof RECORD_FIELD_KEYS[number];
