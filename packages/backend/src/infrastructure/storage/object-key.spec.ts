import { objectKeyFor } from './object-key';

/**
 * Keys used to be `uploads/<timestamp>-<the file's own name>`, and people name files after
 * themselves. The contents were encrypted; the key was a caption saying what the ciphertext was
 * and whose it was, and it travelled into every log line and error message a key appears in.
 */
describe('the key an uploaded file is stored under', () => {
  const at = new Date('2026-09-17T10:00:00.000Z');

  it('keeps nothing of the name it was given', () => {
    const key = objectKeyFor('Ramesh_Kulkarni_Aadhaar_front.pdf', at);
    expect(key).not.toMatch(/ramesh/i);
    expect(key).not.toMatch(/kulkarni/i);
    expect(key).not.toMatch(/aadhaar/i);
  });

  it('files it by when it arrived, which identifies nobody', () => {
    expect(objectKeyFor('x.pdf', at)).toMatch(/^uploads\/2026\/09\/[0-9a-f-]{36}\.pdf$/);
  });

  /** The browser decides from the extension whether a scan can be drawn; the store infers a type. */
  it('carries the extension over, lowercased', () => {
    expect(objectKeyFor('SCAN.JPEG', at).endsWith('.jpeg')).toBe(true);
    expect(objectKeyFor('no-extension', at)).toMatch(/[0-9a-f-]{36}$/);
  });

  /** An "extension" is a few letters — anything else is somebody's name after a full stop. */
  it('refuses an extension that is really part of the name', () => {
    expect(objectKeyFor('report.final draft', at)).not.toMatch(/draft/);
    expect(objectKeyFor('photo.aadhaar_ramesh', at)).not.toMatch(/ramesh/);
    expect(objectKeyFor('x.php%00.jpg', at).endsWith('.jpg')).toBe(true);
  });

  it('never gives two uploads the same key', () => {
    const keys = new Set(Array.from({ length: 200 }, () => objectKeyFor('same.pdf', at)));
    expect(keys.size).toBe(200);
  });
});
