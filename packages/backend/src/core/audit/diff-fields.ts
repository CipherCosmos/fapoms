/**
 * Field-level diffing for audit metadata.
 *
 * Extracted from `ClientService`'s billing-field diff (`client.service.ts` ~:1009), which
 * compared a fixed field list before/after and recorded only what actually changed instead of
 * one generic "record updated" sentence. Pulled out here so other services with the same
 * "which fields changed, from what, to what" need (assayer bank/identity/contact edits) do not
 * re-derive it, without touching `client.service.ts` itself — its owner can adopt this helper
 * later.
 */

export interface FieldDiffEntry {
  field: string;
  label: string;
  fromValue: string | null;
  toValue: string | null;
}

export interface DiffFieldSpec<T> {
  key: keyof T & string;
  label: string;
  /** True for values that must never be written to the audit trail in clear (PAN, Aadhaar,
   *  account numbers). The diff still records that the field changed, but both sides are
   *  masked to their last 4 characters. */
  sensitive?: boolean;
}

function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/** Masks everything but the last 4 characters, e.g. "ABCDE1234F" -> "******234F". Short values
 *  (4 chars or fewer) are masked entirely so a short identifier is never fully exposed. */
export function maskToLast4(value: string | null): string | null {
  if (value === null) return null;
  if (value.length <= 4) return '*'.repeat(value.length);
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

/**
 * Compares `before` and `after` across `fields`, returning one entry per field whose value
 * actually changed. Fields absent from `after` (undefined) are treated as "not supplied" and
 * skipped, matching the fill-only-what-was-sent semantics callers need for partial updates.
 * Sensitive fields are masked to their last 4 characters on both sides — the metadata must
 * prove a field changed without ever storing the clear value.
 */
export function diffFields<T extends Record<string, any>>(
  before: T,
  after: Partial<T>,
  fields: DiffFieldSpec<T>[],
): FieldDiffEntry[] {
  const changes: FieldDiffEntry[] = [];
  for (const spec of fields) {
    const incoming = after[spec.key];
    if (incoming === undefined) continue;
    let fromValue = stringify(before[spec.key]);
    let toValue = stringify(incoming);
    if (fromValue === toValue) continue;
    if (spec.sensitive) {
      fromValue = maskToLast4(fromValue);
      toValue = maskToLast4(toValue);
    }
    changes.push({ field: spec.key, label: spec.label, fromValue, toValue });
  }
  return changes;
}
