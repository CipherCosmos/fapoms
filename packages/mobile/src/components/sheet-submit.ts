/**
 * Running a bottom sheet's submit so it can never leave the sheet spinning.
 *
 * The Time off and Report a problem sheets set `busy`, awaited the parent's handler, then cleared
 * `busy` on the next line. If the handler threw, that line never ran: the button spun for ever and
 * the sheet could only be closed. And a failure message raised as a toast by the parent lands
 * behind the sheet — a React Native Modal draws above the app's toast layer — so the assayer saw
 * nothing at all. The sheet now shows the failure itself, in its own body.
 *
 * A handler may answer `true` (done), `false` (failed; nothing more to say), or
 * `{ ok: false, error }` with the words to show.
 */
export type SheetSubmitAnswer = boolean | { ok: boolean; error?: string };

export interface SheetSubmitOutcome {
  ok: boolean;
  /** What to show inside the sheet, or `null` when it succeeded. */
  error: string | null;
}

export async function runSheetSubmit(
  submit: () => Promise<SheetSubmitAnswer>,
  fallbackError: string,
): Promise<SheetSubmitOutcome> {
  try {
    const answer = await submit();
    if (answer === true) return { ok: true, error: null };
    if (answer === false) return { ok: false, error: fallbackError };
    if (answer.ok) return { ok: true, error: null };
    return { ok: false, error: answer.error?.trim() ? answer.error : fallbackError };
  } catch {
    // A thrown error's own message is technical ("Network request failed") and English-only, so
    // the sheet says its own plain sentence instead.
    return { ok: false, error: fallbackError };
  }
}
