import { timingSafeEqual } from 'crypto';

/**
 * Constant-time comparison for values that may legitimately differ in length — an attacker's
 * guess almost always will. `timingSafeEqual` throws on a length mismatch instead of returning
 * false, so every caller needs the same length guard in front of it; this used to be
 * hand-duplicated, identically, at the metrics endpoint and the document-download-token check.
 */
export function constantTimeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const ab = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
