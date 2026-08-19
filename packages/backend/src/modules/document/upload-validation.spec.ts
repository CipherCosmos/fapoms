import { BadRequestException } from '@nestjs/common';
import { assertUploadAllowed, MAX_UPLOAD_BYTES, MAX_RESUMABLE_UPLOAD_BYTES } from './upload-validation';

/**
 * These rules are the only thing standing between an authenticated caller and arbitrary bytes in
 * the audit-evidence pipeline, and they were previously applied by hand at each route — which is
 * how the multipart path came to have none of them. Pinned here so the shared helper cannot be
 * loosened without a test saying so.
 */
describe('assertUploadAllowed', () => {
  it('accepts the audit formats', () => {
    expect(() => assertUploadAllowed({ contentType: 'application/pdf', size: 1024 })).not.toThrow();
    expect(() => assertUploadAllowed({ contentType: 'image/jpeg', size: 1024 })).not.toThrow();
  });

  it('ignores charset parameters and case, which browsers add freely', () => {
    expect(() => assertUploadAllowed({ contentType: 'TEXT/CSV; charset=utf-8' })).not.toThrow();
  });

  it('refuses archives and executables', () => {
    expect(() => assertUploadAllowed({ contentType: 'application/zip', size: 10 })).toThrow(BadRequestException);
  });

  it('caps the size', () => {
    expect(() => assertUploadAllowed({ contentType: 'application/pdf', size: MAX_UPLOAD_BYTES + 1 }))
      .toThrow(BadRequestException);
    expect(() => assertUploadAllowed({ contentType: 'application/pdf', size: MAX_UPLOAD_BYTES })).not.toThrow();
  });

  it('lets the resumable route use its own, higher ceiling', () => {
    // The two limits differ on purpose (a chunked upload survives a dropped link, a single POST
    // does not), so the thing worth pinning is that the difference is real and in the right
    // direction — and that a file over the resumable cap is still refused.
    expect(MAX_RESUMABLE_UPLOAD_BYTES).toBeGreaterThan(MAX_UPLOAD_BYTES);
    expect(() => assertUploadAllowed({
      contentType: 'application/pdf', size: MAX_UPLOAD_BYTES + 1, maxBytes: MAX_RESUMABLE_UPLOAD_BYTES,
    })).not.toThrow();
    expect(() => assertUploadAllowed({
      contentType: 'application/pdf', size: MAX_RESUMABLE_UPLOAD_BYTES + 1, maxBytes: MAX_RESUMABLE_UPLOAD_BYTES,
    })).toThrow(BadRequestException);
  });

  it('treats a missing content type as the generic fallback rather than a refusal', () => {
    // Android and older browsers send nothing for unrecognised extensions; refusing would reject
    // legitimate scans. It is still size-capped and still malware-scanned.
    expect(() => assertUploadAllowed({ contentType: null, size: 1024 })).not.toThrow();
  });

  it('skips the size check when no size is known yet (the presign step)', () => {
    expect(() => assertUploadAllowed({ contentType: 'application/pdf' })).not.toThrow();
  });
});
