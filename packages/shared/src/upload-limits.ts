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

// ---------------------------------------------------------------------------
// Scan accept-list (2026-09-07)
// ---------------------------------------------------------------------------
// The server's accepted-type list, lifted here so the backend guard and every file picker's
// `accept` attribute are built from one list. NOTE the decision documented above still stands:
// clients must not REFUSE on type — browsers report MIME strings too inconsistently (empty,
// octet-stream) and the false refusal is the costlier mistake. Use this for the picker's
// `accept` filter and, at most, a soft "this may be refused" caption; `uploadSizeProblem`
// remains the only client-side hard check. The server stays the authority on both.

export const SCAN_UPLOAD_MIME_TYPES: string[] = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  // Desk-scanner output: a flatbed or feeder scanner at the desk writes TIFF (often multi-page)
  // or BMP, and refusing those meant a clerk who had just scanned a whole file had to convert
  // every page before the registration would take it. Still images only — never spreadsheets,
  // archives or executables — so the identity-document routes keep their narrower door.
  'image/tiff',
  'image/bmp',
  'image/gif',
];

/** The same list in `<input accept>` form, so the picker and the guard cannot drift. */
export const SCAN_UPLOAD_ACCEPT = SCAN_UPLOAD_MIME_TYPES.join(',');

/**
 * The same list minus PDF, for the two rows that take a picture of a person rather than a document
 * — a candidate photograph is not a three-page PDF. Derived, never typed out again: the surfaces
 * that wanted "images only" had `accept="image/*"` hand-written, which quietly also meant SVG.
 */
export const SCAN_UPLOAD_IMAGE_ACCEPT = SCAN_UPLOAD_MIME_TYPES
  .filter((type) => type.startsWith('image/'))
  .join(',');

/**
 * WHAT KIND OF FILE A STORED SCAN IS, WORKED OUT FROM ITS NAME.
 *
 * Every document route streams its bytes with no usable `Content-Type` — some send
 * `application/octet-stream` outright, the rest send none at all, and `X-Content-Type-Options:
 * nosniff` stops the browser guessing. So a blob taken straight off one of those responses has an
 * empty or opaque type, and a viewer handed that shows a download button instead of the scan.
 *
 * The filename is the only thing that still knows, which is why this exists — and why it is here,
 * beside the list of types an upload is allowed to be, rather than copied into each screen that
 * opens a document. It was copied into each screen: one had a nine-entry table, one had a regular
 * expression for images, the viewer had a third version whose fallback never ran, and two screens
 * had nothing at all and simply trusted the empty type. The same scan rendered on one screen and
 * offered itself as a download on the next.
 *
 * Unknown extensions return null on purpose: opaque is the safe answer, and the viewer already
 * degrades to a download for anything it cannot show.
 */
const SCAN_EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  gif: 'image/gif',
};

export function scanMimeType(fileName: string | null | undefined): string | null {
  const name = (fileName ?? '').trim();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return SCAN_EXTENSION_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Whether a stored scan is something a browser can draw, as opposed to a PDF or an unknown.
 *
 * TIFF is deliberately absent from what browsers draw even though it is an accepted upload — a
 * branch flatbed writes it and no browser renders it, so a TIFF page stays a link rather than
 * becoming a broken thumbnail.
 */
const BROWSER_DRAWABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/bmp', 'image/gif']);

export function isDrawableScanType(mimeType: string | null | undefined): boolean {
  return !!mimeType && BROWSER_DRAWABLE.has(mimeType);
}

/** The same question asked of a filename, for the callers that only have one. */
export function isDrawableScan(fileName: string | null | undefined): boolean {
  return isDrawableScanType(scanMimeType(fileName));
}

/**
 * What a scan is called once it is filed.
 *
 * Named after the document it answers — `pan-card.pdf` — because a record that holds eight files
 * all called `Scan_2026-09-16_14-05-11` is a record nobody can read. The timestamp survives only
 * where nothing can name the scan: an audit packet the assayer names, a photo on a query.
 *
 * Shared because both apps produce scans and both were slugifying the label their own way.
 */
export function scanFileName(
  documentLabel: string | null | undefined,
  extension: string,
  at: Date,
  page?: number,
): string {
  const slug = (documentLabel ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (slug) return page && page > 0 ? `${slug}-page-${page}.${extension}` : `${slug}.${extension}`;

  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + `_${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
  return `Scan_${stamp}.${extension}`;
}

/**
 * Alias kept for callers written against the brief-lived rewrite of this file (2026-09-07,
 * restored the same day after it clobbered the feedback constants): same figure as
 * MAX_UPLOAD_MB, one rule.
 */
export const DEFAULT_MAX_UPLOAD_MB = MAX_UPLOAD_MB;
