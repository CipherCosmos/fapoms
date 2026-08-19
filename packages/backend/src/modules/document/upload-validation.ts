import { BadRequestException } from '@nestjs/common';

/**
 * The one place the document pipeline decides what a file is allowed to be.
 *
 * These rules used to be a constant declared in `document.controller.ts` and then *applied by
 * hand* at each upload route — which is exactly the shape that drifts. It had already drifted:
 * `/documents/upload/presign` checked the type, `/documents/upload/finalize` checked the size,
 * `/documents/mobile-upload-binary` re-implemented both inline, and the plain multipart
 * `POST /documents/upload` checked neither. That last gap was not academic, because the web
 * client falls back to multipart on *any* presign failure (`Documents.tsx: uploadDocumentSmart`
 * catches everything and retries as multipart). A file the presign path had just refused as a
 * disallowed type therefore re-entered through the unchecked door on the very next request —
 * the rejection was a speed bump, not a control.
 *
 * So the rules and their enforcement now live together, and every upload route calls
 * `assertUploadAllowed`. Adding a route without calling it is still possible, but adding one
 * that *silently disagrees* with the others is not.
 */

/**
 * Content types the document pipeline accepts: audit PDFs, the photo formats field devices
 * produce, and the spreadsheet/CSV formats customer-master imports use. Anything else
 * (executables, archives, HTML) is refused.
 *
 * `application/octet-stream` is tolerated because browsers and Android send it for files whose
 * extension they do not recognise, and refusing it would reject legitimate scans; it is still
 * size-capped, and full magic-byte + malware scanning is the next layer (see
 * docs/integration-audit-handoff.md). A declared type is only ever a declaration — this is a
 * gate against the obviously-wrong, not content verification.
 */
export const ALLOWED_UPLOAD_TYPES = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv', 'application/csv',
  'application/octet-stream',
]);

/**
 * Hard ceiling on a single uploaded file.
 *
 * 50 MB is the documented limit this project has always claimed and the presigned path has
 * always enforced on finalize; the multipart path enforced nothing, so "no size cap" was true
 * of whichever door a client happened to use. The number is deliberately generous — the worst
 * real audit packet we have seen is a multi-hundred-page colour scan in the low tens of
 * megabytes — so bringing the unchecked routes up to it rejects nothing that is currently
 * both legitimate and in use. Raise it via DOCUMENT_MAX_UPLOAD_MB rather than editing here, so
 * one deployment with unusual scans does not loosen the cap for everyone.
 */
export const MAX_UPLOAD_BYTES = (Number(process.env.DOCUMENT_MAX_UPLOAD_MB) || 50) * 1024 * 1024;

const HUMAN_ALLOWED = 'PDF, images (JPEG/PNG/WebP/HEIC), Excel and CSV';

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0);
}

/**
 * Refuse a file that is the wrong type or too large, identically on every upload route.
 *
 * `size` is optional only because the presign step mints a URL before any bytes exist — there
 * the type is all we can know, and the cap is applied again on finalize once the object's real
 * size is observable. Every route that already holds the bytes must pass both.
 */
export function assertUploadAllowed(input: {
  contentType?: string | null;
  size?: number | null;
  /** Appended to the size message so an assayer is told what to do about a huge scan. */
  hint?: string;
}): void {
  const declared = (input.contentType || 'application/octet-stream').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_UPLOAD_TYPES.has(declared)) {
    throw new BadRequestException(
      `Files of type "${declared}" are not accepted. Allowed: ${HUMAN_ALLOWED}.`,
    );
  }
  if (input.size != null && input.size > MAX_UPLOAD_BYTES) {
    throw new BadRequestException(
      `That file is ${mb(input.size)} MB, over the ${mb(MAX_UPLOAD_BYTES)} MB limit.` +
        (input.hint ? ` ${input.hint}` : ''),
    );
  }
}
