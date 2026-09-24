/**
 * WHAT AN ASSAYER MAY CHANGE ON THEIR OWN RECORD — the decisions, lifted out of the routes so the
 * field app can be told them in advance (`GET /assayers/me/capabilities`, contract
 * `AssayerSelfCapabilities` in `@fapoms/shared` record-capabilities.ts).
 *
 *   fields     evaluateSelfFieldChange     PUT /assayers/:id (the self-edit refusal)
 *   documents  evaluateSelfDocumentChange  RosterRecordsService.assertSelfMayChangeDocument, which
 *                                          the document upload and document-number routes call
 *
 * Pure: the caller loads the document row and the person.
 */
import {
  ASSAYER_ERROR_CODES,
  DOCUMENT_REJECTION_GUIDANCE,
  DocumentRejectionReason,
  DocumentVerification,
  HR_MAINTAINED_ASSAYER_FIELDS,
  OnboardingDocument,
  SELF_EDITABLE_ASSAYER_FIELDS,
  hasPassedFinalApproval,
  type DocumentGate,
  type FieldGate,
} from '@fapoms/shared';

// ── Fields ────────────────────────────────────────────────────────────────────────────────────

export const HR_MAINTAINED_REASON = 'HR maintains this. Ask your HR contact if it needs changing.';

/**
 * May the assayer set this field on their own record? Only what `SELF_EDITABLE_ASSAYER_FIELDS`
 * names — the self-edit route refuses everything else with `HR_MAINTAINED_FIELD`.
 */
export function evaluateSelfFieldChange(field: string): FieldGate {
  if (SELF_EDITABLE_ASSAYER_FIELDS.includes(field)) return { field, mode: 'direct' };
  return { field, mode: 'locked', code: ASSAYER_ERROR_CODES.HR_MAINTAINED_FIELD, reason: HR_MAINTAINED_REASON };
}

/** The field half of the capabilities: every self-editable field, then every HR-maintained one. */
export function selfFieldGates(): FieldGate[] {
  return [...SELF_EDITABLE_ASSAYER_FIELDS, ...HR_MAINTAINED_ASSAYER_FIELDS].map(evaluateSelfFieldChange);
}

// ── Documents ─────────────────────────────────────────────────────────────────────────────────

/** The document row, as far as these rules read it. */
export interface SelfDocumentRow {
  isActive?: boolean | null;
  verificationStatus?: DocumentVerification | string | null;
  filePaths?: string[] | null;
  rejectionReason?: string | null;
  /** HR's own sentence from "Ask to re-upload" (`requestReupload`). */
  reuploadNote?: string | null;
}

/** The person, as far as the photograph rule reads them. */
export interface SelfDocumentPerson {
  lifecycleStatus?: string | null;
  unavailableReason?: string | null;
  photograph?: string | null;
}

export const PHOTOGRAPH_LOCKED_REASON = 'Your photo is locked. Ask HR if it needs changing.';
export const DOCUMENT_VERIFIED_LOCKED_REASON = 'HR has verified this. Ask HR if it needs changing.';

/**
 * May the ASSAYER THEMSELF replace this document (or its number/expiry) right now?
 *
 * Owner decision (2026-09-24): verified details can't be changed until HR asks for that.
 *  - Sent back by HR (REJECTED, whether from review or from "Ask to re-upload") → `reopened`, with
 *    HR's note: their own sentence when they asked for a re-upload, otherwise the guidance the
 *    rejection notification sent.
 *  - The photograph, once it exists and the person has passed final approval → `locked`
 *    (PHOTOGRAPH_LOCKED). It is never VERIFIED, so approval is what locks it.
 *  - VERIFIED → `locked` (DOCUMENT_VERIFIED_LOCKED).
 *  - Anything else → `direct`.
 *
 * `person` is read only for the photograph; pass null for any other requirement.
 */
export function evaluateSelfDocumentChange(
  requirement: OnboardingDocument | string,
  row: SelfDocumentRow | null | undefined,
  person: SelfDocumentPerson | null | undefined,
): DocumentGate {
  if (row?.isActive !== false && row?.verificationStatus === DocumentVerification.REJECTED) {
    const guidance = row?.rejectionReason
      ? DOCUMENT_REJECTION_GUIDANCE[row.rejectionReason as DocumentRejectionReason] ?? null
      : null;
    return { requirement, mode: 'reopened', hrNote: row?.reuploadNote?.trim() || guidance };
  }

  if (requirement === OnboardingDocument.PHOTOGRAPH) {
    const hasPhoto = !!person?.photograph || (row?.filePaths ?? []).length > 0;
    if (hasPhoto && hasPassedFinalApproval(person?.lifecycleStatus, person?.unavailableReason)) {
      return { requirement, mode: 'locked', code: ASSAYER_ERROR_CODES.PHOTOGRAPH_LOCKED, reason: PHOTOGRAPH_LOCKED_REASON };
    }
    return { requirement, mode: 'direct' };
  }

  if (row?.isActive !== false && row?.verificationStatus === DocumentVerification.VERIFIED) {
    return {
      requirement,
      mode: 'locked',
      code: ASSAYER_ERROR_CODES.DOCUMENT_VERIFIED_LOCKED,
      reason: DOCUMENT_VERIFIED_LOCKED_REASON,
    };
  }
  return { requirement, mode: 'direct' };
}
