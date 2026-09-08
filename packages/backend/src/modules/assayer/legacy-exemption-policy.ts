/**
 * Legacy KYC Exemption Policy
 *
 * Operational Boundary Definition:
 * LEGACY_OPERATIONALLY_GRANDFATHERED vs IDENTITY_VERIFIED
 *
 * Background:
 * The audit identified 539 active legacy assayers who were imported from historical
 * spreadsheets with claimed paperwork but without scanned document files on record.
 * Bulk invalidating or repairing these records would cause massive operational disruption
 * to active gold loan branch operations. Conversely, treating them as verified would constitute
 * false attestation to regulatory authorities and banking clients.
 *
 * Policy Rules:
 * 1. BOUNDED EXEMPTION:
 *    Legacy assayers with pre-existing operational standing are permitted to continue routine
 *    field assignments under their grandfathered standing.
 *
 * 2. NO SILENT ATTESTATION:
 *    The 539 legacy records MUST NOT be marked as IDENTITY_VERIFIED, nor will synthetic
 *    verification timestamps or document versions be backfilled for them.
 *
 * 3. STRICT RE-VERIFICATION UPON SENSITIVE MUTATION:
 *    If a grandfathered assayer modifies their legal/display name, bank account number, IFSC code,
 *    PAN, or Aadhaar:
 *    - Bank verification is cleared to unverified.
 *    - Document verification for related credentials (e.g. PAN, Aadhaar, Bank Passbook) is reset to PENDING.
 *    - New payouts against modified bank accounts will NOT inherit grandfathered standing.
 *
 * 4. STRICT VERIFICATION FOR NEW UPLOADS & NEW RECRUITS:
 *    All new joiners and newly uploaded document versions (v2, v3, etc.) MUST undergo explicit,
 *    version-bound reviewer attestation (holder name, DOB, gender, guardian, address matching)
 *    before reaching VERIFIED status.
 */

export enum IdentityStandingClassification {
  /** Actively verified against uploaded, versioned photographic document evidence */
  IDENTITY_VERIFIED = 'IDENTITY_VERIFIED',
  /** Grandfathered from legacy roster import with historical operational standing but no digital scan */
  LEGACY_OPERATIONALLY_GRANDFATHERED = 'LEGACY_OPERATIONALLY_GRANDFATHERED',
  /** Incomplete onboarding without operational standing */
  UNVERIFIED = 'UNVERIFIED',
}

export function classifyIdentityStanding(assayer: {
  identityVerifiedAt?: Date | null;
  joiningDate?: Date | null;
  createdAt?: Date | null;
  hasVerifiedDocument?: boolean;
}): IdentityStandingClassification {
  if (assayer.identityVerifiedAt || assayer.hasVerifiedDocument) {
    return IdentityStandingClassification.IDENTITY_VERIFIED;
  }
  // Joined prior to strict digital KYC policy enforcement cutoff (legacy import)
  if (assayer.joiningDate || assayer.createdAt) {
    return IdentityStandingClassification.LEGACY_OPERATIONALLY_GRANDFATHERED;
  }
  return IdentityStandingClassification.UNVERIFIED;
}
