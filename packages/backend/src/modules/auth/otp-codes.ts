import * as crypto from 'crypto';

/**
 * The short-code hashing/generation primitives behind delivered verification codes.
 *
 * Extracted out of `mfa.service.ts` (where they started as module-private functions) so the
 * public, pre-account self-registration OTP flow (`public-registration.controller.ts`) can use
 * the exact same hashing discipline without duplicating it or depending on a service whose every
 * route requires an authenticated JWT. `MfaService` now imports these instead of declaring its
 * own — one implementation, two callers.
 */

/** SHA-256 hex of a short code — codes are never stored or logged in the clear. */
export function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code.trim()).digest('hex');
}

/** A cryptographically-random numeric code (leading zeros kept), for email/SMS delivery. */
export function numericCode(digits = 6): string {
  const max = 10 ** digits;
  return (crypto.randomInt(0, max)).toString().padStart(digits, '0');
}

/** Constant-time compare of two equal-length hex digests; false (not throw) on any mismatch. */
export function hashesEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
