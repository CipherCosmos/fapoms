/**
 * How a check-in or check-out answer is read. Pure (no React Native), so the node tests run it.
 *
 * The two attendance routes refuse in TWO shapes, and both must yield the machine code:
 *
 *  - a thrown HTTP error (4xx) — the global filter puts the code in `code`, the sentence in
 *    `message`;
 *  - an HTTP 200 `{ success: false, error: CODE, message }` — what `recordCheckIn`/`recordCheckOut`
 *    return for business refusals (wrong day, too far, not active). Here the code rides in
 *    `error`, not `code`.
 *
 * Reading only `code` lost every 200-shaped refusal's code, so neither app could translate
 * "NOT_SCHEDULED_TODAY" or "TOO_FAR_FROM_BRANCH" and both fell back to the English sentence.
 */
export interface AttendanceResult {
  success: boolean;
  /** The human sentence (never the bare code when a sentence exists). */
  error?: string;
  /** The machine code, from `code` or, on a 200 refusal, from `error`. */
  code?: string;
  status?: number;
}

/** A value shaped like one of `@fapoms/shared`'s error codes (UPPER_SNAKE). */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]+$/;

export function readAttendanceResponse(ok: boolean, status: number | undefined, body: unknown): AttendanceResult {
  const data = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const success = ok && data.success !== false;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const rawError = str(data.error);
  // `error` is the code only when it looks like one; an older server put a sentence there.
  const code = str(data.code) ?? (rawError && CODE_SHAPE.test(rawError) ? rawError : undefined);
  return {
    success,
    error: success ? undefined : str(data.message) ?? rawError,
    code: success ? undefined : code,
    status,
  };
}
