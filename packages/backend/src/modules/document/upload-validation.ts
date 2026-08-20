import { BadRequestException } from '@nestjs/common';
import { MAX_UPLOAD_MB, MAX_RESUMABLE_UPLOAD_MB } from '@fapoms/shared';

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
 *
 * The default comes from `@fapoms/shared` because the web and mobile file pickers need to state
 * the limit *before* a file is chosen, and a hand-copied 50 in a React component is exactly the
 * copy that would still say 50 the day this becomes 80.
 */
export const MAX_UPLOAD_BYTES = (Number(process.env.DOCUMENT_MAX_UPLOAD_MB) || MAX_UPLOAD_MB) * 1024 * 1024;

/**
 * Multer options for FileInterceptor. `NestJS`'s FileInterceptor defaults to memoryStorage with NO
 * size limit, so without this multer buffers the ENTIRE request body into memory before any handler
 * (or `assertUploadAllowed`) can look at it — a request with a multi-gigabyte body exhausts the
 * process before a single line of our code runs. This caps the buffer at the same ceiling the
 * storage check enforces, so the two agree and the memory can never exceed the disk limit.
 */
export const UPLOAD_INTERCEPTOR_OPTIONS = { limits: { fileSize: MAX_UPLOAD_BYTES } };

/**
 * Hard ceiling on a *resumable* (chunked) upload — deliberately higher than the single-request one.
 *
 * These two numbers disagreeing is not drift, it is the point. A one-shot upload has to survive as
 * one HTTP request: on the rural mobile links assayers work over, a 50 MB single POST is already at
 * the edge of what completes before something drops it, and when it drops the whole thing restarts
 * from zero. The chunked path exists precisely so that size stops being the risk — the file goes up
 * as 512 KB parts that MinIO stores independently, a reconnect re-sends only the gaps, and a
 * 100 MB colour scan of a thick branch file is therefore a reasonable thing to accept there and an
 * unreasonable thing to accept on the plain route.
 *
 * What *was* wrong is that the chunked service kept its own private literal, so the two rules could
 * drift apart without anyone noticing and neither number was stated anywhere a user could read it
 * before choosing a file. Both now live here, both are enforced through `assertUploadAllowed`, and
 * `DOCUMENT_MAX_RESUMABLE_UPLOAD_MB` is the deployment escape hatch — the same shape as the other
 * cap, so raising one does not silently teach anybody to edit the other by hand.
 */
export const MAX_RESUMABLE_UPLOAD_BYTES =
  (Number(process.env.DOCUMENT_MAX_RESUMABLE_UPLOAD_MB) || MAX_RESUMABLE_UPLOAD_MB) * 1024 * 1024;

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
  /**
   * Which ceiling applies. Defaults to the single-request one; the resumable route passes
   * `MAX_RESUMABLE_UPLOAD_BYTES`. Callers pass a constant from this module, never a literal.
   */
  maxBytes?: number;
}): void {
  const maxBytes = input.maxBytes ?? MAX_UPLOAD_BYTES;
  const declared = (input.contentType || 'application/octet-stream').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_UPLOAD_TYPES.has(declared)) {
    throw new BadRequestException(
      `Files of type "${declared}" are not accepted. Allowed: ${HUMAN_ALLOWED}.`,
    );
  }
  if (input.size != null && input.size > maxBytes) {
    throw new BadRequestException(
      `That file is ${mb(input.size)} MB, over the ${mb(maxBytes)} MB limit.` +
        (input.hint ? ` ${input.hint}` : ''),
    );
  }
}
