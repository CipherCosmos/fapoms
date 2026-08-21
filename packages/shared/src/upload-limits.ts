/**
 * The upload limits, in one place, so the number a user is told is the number the server enforces.
 *
 * The rules themselves — what is accepted and what is refused — belong to the backend's
 * `modules/document/upload-validation.ts`, and that file remains the only thing that can reject an
 * upload. What lives here is the *defaults those rules are built from*, in the one package all
 * three clients can import, because the previous arrangement had the numbers written down in the
 * backend only. The consequence was a user experience that could not be fixed locally: the web
 * client had no way to know a file was too big, so a coordinator on a slow office link picked a
 * 70 MB scan, waited for it to crawl up, and was told at the very end that it was never going to
 * be accepted. Saying "up to 50 MB" next to the file picker costs nothing and saves that upload.
 *
 * A deployment may raise either ceiling through DOCUMENT_MAX_UPLOAD_MB /
 * DOCUMENT_MAX_RESUMABLE_UPLOAD_MB, which the clients cannot see. That is deliberate and safe in
 * one direction only: the client-side figure is advisory and never more permissive than the server,
 * so a raised server cap means the hint is merely conservative, never wrong in a way that loses
 * someone's work. The server is always the thing that decides.
 */

/** Single-request uploads (web multipart, presigned PUT, mobile binary). */
export const MAX_UPLOAD_MB = 50;

/**
 * Resumable chunked uploads. Higher on purpose: a chunked upload survives a dropped connection by
 * re-sending only the missing 512 KB parts, so size stops being the thing that makes an upload
 * fail. See the WHY in `upload-validation.ts` — this is two rules, not one rule that drifted.
 */
export const MAX_RESUMABLE_UPLOAD_MB = 100;

/**
 * Files attached to a piece of feedback. Far smaller than the audit-document ceiling, on purpose.
 *
 * These are screenshots and short logs — the thing somebody grabs to show that a screen is wrong.
 * The document limit exists for multi-hundred-page colour scans of a branch file and has no
 * business applying here: at 50 MB apiece, five attachments is a quarter of a gigabyte buffered
 * in the server's memory for one report, and on the connections this is actually used over it is
 * an upload nobody will wait for. A screenshot is under a megabyte; ten leaves generous room for
 * a photo of a screen taken on a phone.
 */
export const MAX_FEEDBACK_ATTACHMENT_MB = 10;

/** How many files one report may carry. */
export const MAX_FEEDBACK_ATTACHMENTS = 5;

/** What to put next to a file picker, before anything is chosen. */
export const UPLOAD_LIMIT_HINT =
  `PDF, image, Excel or CSV — up to ${MAX_UPLOAD_MB} MB per file.`;

/**
 * Why this file cannot be uploaded, or `null` when it can — checked before a single byte is sent.
 *
 * Only size is checked here. Type is left to the server: browsers report content types
 * inconsistently enough (empty strings, `application/octet-stream` for anything Android does not
 * recognise) that a client-side type check would refuse legitimate scans, which is the more
 * expensive mistake. Size is unambiguous.
 */
export function uploadSizeProblem(
  file: { name: string; size: number },
  maxMb: number = MAX_UPLOAD_MB,
): string | null {
  const max = maxMb * 1024 * 1024;
  if (file.size <= max) return null;
  const mb = (file.size / 1024 / 1024).toFixed(file.size < 10 * 1024 * 1024 ? 1 : 0);
  return `"${file.name}" is ${mb} MB, over the ${maxMb} MB limit. Scan it at a lower resolution or split it, then try again.`;
}
