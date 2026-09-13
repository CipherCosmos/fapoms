/**
 * The operational limits `GET /platform-settings/limits` answers with, and the shipped defaults
 * to render before that answer arrives (or if it never does).
 *
 * `maxNegotiationRounds` is deliberately absent from the type: in-app fee negotiation was removed
 * (2026-09), and the endpoint still returns `maxNegotiationRounds: 0` purely as a kill-switch old,
 * already-shipped mobile builds read — a current build has no counter-offer button left to gate
 * with it, so there is nothing here for either client to read that field into.
 *
 * Both clients hand-declared an identical `{ checkInGeofenceMeters, maxSingleExpenseClaim }`
 * fallback, matching the settings registry's own defaults so a first paint (or a failed lookup)
 * is never wrong for an unconfigured platform. One copy, so a registry default that changes has
 * exactly one fallback to update in step with it, not two found by grepping for the number.
 */
export interface PlatformLimits {
  checkInGeofenceMeters: number;
  maxSingleExpenseClaim: number;
}

export const PLATFORM_LIMIT_FALLBACK: PlatformLimits = {
  checkInGeofenceMeters: 2000,
  maxSingleExpenseClaim: 50_000,
};
