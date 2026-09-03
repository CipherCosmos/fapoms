import { BadRequestException } from '@nestjs/common';
import { MAX_UPLOAD_MB, MAX_RESUMABLE_UPLOAD_MB } from '@fapoms/shared';
import { ASSAYER_ERROR_CODES } from '@fapoms/shared';
import { withCode } from '../../infrastructure/http/api-error';

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

/** What the narrower set is called when a route refuses something for being outside it. */
const HUMAN_SCANS = 'PDF or an image (JPEG/PNG/WebP/HEIC)';

/**
 * The refusal names what *this* route takes, not what the system takes somewhere else.
 *
 * Telling somebody uploading a passport scan that Excel is allowed, on the route that had just
 * refused their file, is a message that sends them to try a spreadsheet.
 */
const humanList = (allowed: Set<string>): string =>
  allowed === SCAN_UPLOAD_TYPES ? HUMAN_SCANS : HUMAN_ALLOWED;

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
/** PDFs and pictures. What an identity document or a signed form can actually be. */
export const SCAN_UPLOAD_TYPES = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);

/**
 * What an extension says, for the cases where the declared type says nothing.
 *
 * `application/octet-stream` is in `ALLOWED_UPLOAD_TYPES` on purpose — mobile clients send it
 * for perfectly ordinary scans — but it means the declared type is not, on its own, a check.
 * A caller that passes `fileName` gets the extension consulted instead, which is what stops
 * `payload.exe` walking through the door marked "unknown type".
 */
const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
};

export function assertUploadAllowed(input: {
  contentType?: string | null;
  size?: number | null;
  /**
   * Consulted when the declared type is `application/octet-stream`, which tells us nothing.
   * An extension nothing recognises is refused rather than waved through.
   */
  fileName?: string | null;
  /** A narrower set than `ALLOWED_UPLOAD_TYPES` — see `SCAN_UPLOAD_TYPES`. */
  allowed?: Set<string>;
  /** Appended to the size message so an assayer is told what to do about a huge scan. */
  hint?: string;
  /**
   * Which ceiling applies. Defaults to the single-request one; the resumable route passes
   * `MAX_RESUMABLE_UPLOAD_BYTES`. Callers pass a constant from this module, never a literal.
   */
  maxBytes?: number;
}): void {
  const maxBytes = input.maxBytes ?? MAX_UPLOAD_BYTES;
  const allowed = input.allowed ?? ALLOWED_UPLOAD_TYPES;
  let declared = (input.contentType || 'application/octet-stream').toLowerCase().split(';')[0].trim();

  // An unknown declared type is not an answer. Where the caller gave a filename, the extension
  // is asked instead — and an extension nothing recognises is refused, rather than passing
  // because "unknown" happens to be on the list.
  if (declared === 'application/octet-stream' && input.fileName) {
    const ext = input.fileName.toLowerCase().split('.').pop() ?? '';
    const fromExtension = EXTENSION_TYPES[ext];
    if (!fromExtension) {
      throw withCode(
        new BadRequestException(
          `"${input.fileName}" is not a kind of file this accepts. Allowed: ${humanList(allowed)}.`,
        ),
        ASSAYER_ERROR_CODES.UPLOAD_TYPE_NOT_ALLOWED,
      );
    }
    declared = fromExtension;
  }

  if (!allowed.has(declared)) {
    throw withCode(
      new BadRequestException(
        `Files of type "${declared}" are not accepted. Allowed: ${humanList(allowed)}.`,
      ),
      ASSAYER_ERROR_CODES.UPLOAD_TYPE_NOT_ALLOWED,
    );
  }
  if (input.size != null && input.size > maxBytes) {
    // The size ceiling is the one upload refusal a client can act on beyond showing a sentence:
    // knowing it was size, not type or content, is what lets the phone offer to re-take the photo
    // at a lower resolution instead of sending the person back to the office.
    throw withCode(
      new BadRequestException(
        `That file is ${mb(input.size)} MB, over the ${mb(maxBytes)} MB limit.` +
          (input.hint ? ` ${input.hint}` : ''),
      ),
      ASSAYER_ERROR_CODES.UPLOAD_TOO_LARGE,
    );
  }
}
