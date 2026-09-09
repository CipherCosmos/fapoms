import { execFileSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deriveFileIntegrity, sniffMimeType, verifyClientHash } from './document-integrity';

/**
 * Integrity fields must describe the bytes, not the request.
 *
 * `documents.mime_type` was whatever `Content-Type` the uploading client wrote into its multipart
 * header, and there was no content hash at all — so nothing on the row could tell you whether the
 * file on disk today is the file that was uploaded. For a system whose documents are the evidence
 * an audit rests on, that is the property that matters most.
 *
 * The hash assertions here are checked against `sha256sum` running on the same bytes, not against
 * a digest this module produced earlier: a test that compares an implementation to itself proves
 * only that it is deterministic.
 */
describe('document content integrity', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fapoms-integrity-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  /** The digest according to coreutils, computed on the same bytes and nothing else. */
  const independentSha256 = (buf: Buffer): string => {
    const path = join(dir, `probe-${Math.random().toString(36).slice(2)}.bin`);
    writeFileSync(path, buf);
    return execFileSync('sha256sum', [path]).toString().split(/\s+/)[0];
  };

  const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('body bytes here'), Buffer.from('\n%%EOF')]);
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
  const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 3)]);

  describe('sha256', () => {
    it('matches an independently computed digest', () => {
      expect(deriveFileIntegrity(PDF).sha256).toBe(independentSha256(PDF));
    });

    it('matches for an empty file too — zero bytes still has a digest', () => {
      const empty = Buffer.alloc(0);
      expect(deriveFileIntegrity(empty).sha256).toBe(independentSha256(empty));
    });

    it('changes when a single byte changes', () => {
      const a = Buffer.from(PDF);
      const b = Buffer.from(PDF); b[10] = b[10] ^ 0xff;
      expect(deriveFileIntegrity(a).sha256).not.toBe(deriveFileIntegrity(b).sha256);
      expect(deriveFileIntegrity(b).sha256).toBe(independentSha256(b));
    });

    it('is lower-case hex of exactly 64 characters, which the column CHECK also requires', () => {
      expect(deriveFileIntegrity(PDF).sha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('byte length', () => {
    it('is counted from the buffer, not taken from any header', () => {
      expect(deriveFileIntegrity(PDF).byteLength).toBe(PDF.length);
      expect(deriveFileIntegrity(Buffer.alloc(0)).byteLength).toBe(0);
    });
  });

  describe('mime type', () => {
    it('reads a PDF from its own leading bytes', () => {
      expect(sniffMimeType(PDF)).toBe('application/pdf');
    });

    it('reads a PNG from its own leading bytes', () => {
      expect(sniffMimeType(PNG)).toBe('image/png');
    });

    it('returns null rather than guessing at an unrecognised signature', () => {
      expect(sniffMimeType(Buffer.from('just some text, no signature'))).toBeNull();
    });

    /** The case that motivated this: a file renamed to look like something it is not. */
    it('records what the bytes are, not what the uploader called them', () => {
      const d = deriveFileIntegrity(PNG, 'application/pdf');
      expect(d.sniffedMimeType).toBe('image/png');
      expect(d.declaredMimeType).toBe('application/pdf');
      expect(d.mimeTypeMismatch).toBe(true);
      // And the value that reaches the column is the observed one.
      expect(d.effectiveMimeType).toBe('image/png');
    });

    it('does not flag a spreadsheet for being a ZIP container, because it legitimately is one', () => {
      const d = deriveFileIntegrity(
        XLSX,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(d.mimeTypeMismatch).toBe(false);
    });

    it('ignores charset parameters when comparing a declared type', () => {
      const d = deriveFileIntegrity(PDF, 'application/pdf; charset=binary');
      expect(d.declaredMimeType).toBe('application/pdf');
      expect(d.mimeTypeMismatch).toBe(false);
    });

    it('falls back to the claim when the bytes are unreadable, and says the bytes were unreadable', () => {
      const d = deriveFileIntegrity(Buffer.from('plain text'), 'text/plain');
      expect(d.sniffedMimeType).toBeNull();
      expect(d.effectiveMimeType).toBe('text/plain');
      // Not a mismatch: nothing was observed to disagree with.
      expect(d.mimeTypeMismatch).toBe(false);
    });

    it('falls back to octet-stream when there is neither a signature nor a claim', () => {
      expect(deriveFileIntegrity(Buffer.from('plain text')).effectiveMimeType).toBe('application/octet-stream');
    });
  });

  describe('client-supplied hashes', () => {
    it('accepts an upload whose supplied hash matches the bytes', () => {
      const d = deriveFileIntegrity(PDF);
      expect(verifyClientHash(d, d.sha256)).toEqual({ supplied: true, matches: true });
    });

    it('accepts a supplied hash in upper case', () => {
      const d = deriveFileIntegrity(PDF);
      expect(verifyClientHash(d, d.sha256.toUpperCase()).matches).toBe(true);
    });

    it('rejects an upload whose supplied hash does not match the bytes', () => {
      const d = deriveFileIntegrity(PDF);
      expect(verifyClientHash(d, 'f'.repeat(64)).matches).toBe(false);
    });

    it('treats a missing hash as no claim, not as a failed one', () => {
      const d = deriveFileIntegrity(PDF);
      expect(verifyClientHash(d, null)).toEqual({ supplied: false, matches: true });
      expect(verifyClientHash(d, '   ')).toEqual({ supplied: false, matches: true });
    });

    /**
     * The rule the brief names directly: a client hash is checked, never stored in place of the
     * one computed here. Even a matching claim leaves the derived value untouched.
     */
    it('never lets a supplied hash become the recorded one', () => {
      const d = deriveFileIntegrity(PDF, 'application/pdf');
      const lie = 'a'.repeat(64);
      verifyClientHash(d, lie);
      expect(d.sha256).not.toBe(lie);
      expect(d.sha256).toBe(independentSha256(PDF));
    });
  });
});
