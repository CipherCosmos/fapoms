import { DocumentVerification } from '@fapoms/shared';

/**
 * WHAT MAY BE CLAIMED ABOUT A PAYOUT DESTINATION, AND ON WHAT EVIDENCE.
 *
 * `assayer_payables.destination_verified_at` and `billing_payments.destination_verified_at` are
 * not decoration: a timestamp in either column is an assertion that somebody verified the bank
 * account this money is being sent to, at that moment. Certification found five payables — all of
 * them covering money that had actually left the business — carrying that assertion for an
 * assayer with no bank passbook document at all and `identity_verified_at` NULL. Both writers
 * (`approvePayableInTx` and `recordDisbursement`) ended the same expression with `?? new Date()`:
 *
 *     destinationVerifiedAt = isVerifiedDoc ? (bankDoc.verifiedAt ?? new Date())
 *                                           : (assayer.identityVerifiedAt ?? new Date());
 *
 * so the absence of every piece of evidence produced the strongest possible claim — "verified,
 * just now" — rather than the honest one, which is nothing.
 *
 * ## The evidence the business actually requires
 *
 * The ladder below is not invented here; it is the one the rest of the codebase already
 * describes, with the fabrication removed:
 *
 *  1. **A verified BANK_PASSBOOK document** is the primary evidence, and the only evidence that
 *     points at a stored artefact. `payout_evidence_version_id` is set from
 *     `assayer_documents.current_version_id` ONLY when that document reads VERIFIED — that column
 *     has always been the evidence pointer, and it was never fabricated. Its verification
 *     timestamp is `assayer_documents.verified_at`, which `RosterRecordsService.verifyDocument`
 *     stamps on every non-PENDING verdict, so a VERIFIED row always has one.
 *     `assayer-phase3-lifecycle.spec.ts` ("3. Payout Destination Snapshotting") documents exactly
 *     this pairing: `payoutEvidenceVersionId = bankDoc.currentVersionId` beside
 *     `destinationVerifiedAt = bankDoc.verifiedAt`.
 *
 *  2. **An established identity** (`assayers.identity_verified_at`) is the documented fallback,
 *     and it is a real fact rather than a convenience. `RosterRecordsService.deriveLegalName` is
 *     its only writer and sets it from a verified identity document — "Null again when the last
 *     verification is undone: 'identity was established' must not survive the evidence being
 *     withdrawn". Crucially it is also bank-specific in one direction that matters here: editing
 *     an assayer's account number or IFSC invalidates their BANK_PASSBOOK evidence and clears
 *     `identity_verified_at` (`AssayerService.update`, `RosterRecordsService
 *     .invalidateDocumentForFieldChange`). So a non-null `identity_verified_at` asserts that
 *     somebody checked a document while these exact bank details were on the record.
 *
 *  3. **Neither** — then `destination_verified_at` is NULL. Not `now()`. A payout to an
 *     unverified destination is a decision the business is allowed to make (nothing here refuses
 *     the approval; the account number, IFSC and PAN guards above the caller are what refuse),
 *     but it must be visibly unverified afterwards.
 *
 * ## Why the source is recorded on the row
 *
 * A timestamp alone cannot be checked. `destination_verified_source` names which rung of the
 * ladder produced it, which is what lets the database itself refuse the impossible combination
 * (see `chk_assayer_payables_destination_evidence`) instead of trusting two call sites to keep
 * agreeing. It is also the only way to tell tier 2 apart from a fabrication after the fact —
 * which is precisely the question certification could not answer about the five rows it found.
 *
 * One definition, two callers. The duplicated expression is what let the defect exist in two
 * places at once and be fixed in neither.
 */
export enum PayoutDestinationEvidence {
  /** A VERIFIED, active BANK_PASSBOOK document. `payoutEvidenceVersionId` points at its version. */
  BANK_PASSBOOK = 'BANK_PASSBOOK',
  /** `assayers.identity_verified_at`: identity established from a document, not since invalidated. */
  IDENTITY_DOCUMENT = 'IDENTITY_DOCUMENT',
}

/** The subset of an assayer this decision reads. Kept structural so tests need no entity. */
export interface PayoutDestinationAssayer {
  bankAccountNumber?: string | null;
  ifscCode?: string | null;
  bankName?: string | null;
  legalName?: string | null;
  displayName?: string | null;
  identityVerifiedAt?: Date | null;
}

/** The subset of the active BANK_PASSBOOK document this decision reads. */
export interface PayoutDestinationBankDocument {
  verificationStatus?: DocumentVerification | string | null;
  verifiedAt?: Date | null;
  currentVersionId?: string | null;
}

/** Exactly the six columns both `assayer_payables` and `billing_payments` carry. */
export interface PayoutDestinationSnapshot {
  destinationBankAccountNumber: string;
  destinationIfsc: string;
  destinationBankName: string | null;
  destinationAccountHolderName: string | null;
  payoutEvidenceVersionId: string | null;
  destinationVerifiedAt: Date | null;
  destinationVerifiedSource: PayoutDestinationEvidence | null;
}

/**
 * Freeze the destination, and claim verification only where verification actually happened.
 *
 * `bankDoc` is the active BANK_PASSBOOK row or null/undefined when the person has none. A
 * VERIFIED document with no `verified_at` — which this application never writes, but an imported
 * row could hold — falls through to the identity tier rather than being stamped with the current
 * time: there is nothing to record as the moment of verification, and inventing one is the
 * defect this whole module exists to remove.
 *
 * Throws nothing. The caller has already refused a missing account number, IFSC or PAN; whether
 * an unverified destination may be paid at all is that caller's decision, not this function's.
 */
export function resolvePayoutDestination(
  assayer: PayoutDestinationAssayer,
  bankDoc: PayoutDestinationBankDocument | null | undefined,
): PayoutDestinationSnapshot {
  const base = {
    destinationBankAccountNumber: (assayer.bankAccountNumber ?? '').trim(),
    destinationIfsc: (assayer.ifscCode ?? '').trim().toUpperCase(),
    destinationBankName: assayer.bankName?.trim() || null,
    destinationAccountHolderName: assayer.legalName?.trim() || assayer.displayName?.trim() || null,
  };

  const passbookVerified =
    bankDoc?.verificationStatus === DocumentVerification.VERIFIED && !!bankDoc?.verifiedAt;

  if (passbookVerified) {
    return {
      ...base,
      payoutEvidenceVersionId: bankDoc!.currentVersionId ?? null,
      destinationVerifiedAt: bankDoc!.verifiedAt!,
      destinationVerifiedSource: PayoutDestinationEvidence.BANK_PASSBOOK,
    };
  }

  if (assayer.identityVerifiedAt) {
    return {
      ...base,
      payoutEvidenceVersionId: null,
      destinationVerifiedAt: assayer.identityVerifiedAt,
      destinationVerifiedSource: PayoutDestinationEvidence.IDENTITY_DOCUMENT,
    };
  }

  // No evidence. Say so.
  return {
    ...base,
    payoutEvidenceVersionId: null,
    destinationVerifiedAt: null,
    destinationVerifiedSource: null,
  };
}
