import { fieldFingerprint, __resetKeyCacheForTests } from './field-encryption';

/**
 * The property the duplicate check needs and encryption cannot give it.
 *
 * `encryptField` uses a fresh IV per call, so two encryptions of one PAN never compare equal and
 * `WHERE pan_number = :pan` matched nothing on any deployment with a key set. The fingerprint is
 * the equality the roster needs, without giving back the value.
 */
describe('fieldFingerprint', () => {
  const KEY = 'a'.repeat(64);

  beforeEach(() => {
    process.env.PII_ENCRYPTION_KEY = KEY;
    __resetKeyCacheForTests();
  });

  afterEach(() => {
    delete process.env.PII_ENCRYPTION_KEY;
    __resetKeyCacheForTests();
  });

  it('is the same every time for the same value — the whole point', () => {
    expect(fieldFingerprint('ABCDE1234F')).toBe(fieldFingerprint('ABCDE1234F'));
  });

  it('ignores the case and spacing somebody typed it with', () => {
    expect(fieldFingerprint(' abcde1234f ')).toBe(fieldFingerprint('ABCDE1234F'));
  });

  it('differs for a different value', () => {
    expect(fieldFingerprint('ABCDE1234F')).not.toBe(fieldFingerprint('ABCDE1234G'));
  });

  it('gives nothing back for a blank, so an empty column is not a match on every other empty one', () => {
    expect(fieldFingerprint('')).toBeNull();
    expect(fieldFingerprint('   ')).toBeNull();
    expect(fieldFingerprint(null)).toBeNull();
  });

  it('does not contain the value it fingerprints', () => {
    expect(fieldFingerprint('ABCDE1234F')).not.toContain('ABCDE');
  });

  /**
   * Keyed, not a plain hash. A PAN has a small enough space to enumerate, and this column is in
   * every backup — an unkeyed digest of one is the value itself to anybody holding the file.
   */
  it('changes with the key, so a stolen column cannot be cracked without it', () => {
    const withFirstKey = fieldFingerprint('ABCDE1234F');
    process.env.PII_ENCRYPTION_KEY = 'b'.repeat(64);
    __resetKeyCacheForTests();
    expect(fieldFingerprint('ABCDE1234F')).not.toBe(withFirstKey);
  });

  it('answers null with no key configured, rather than indexing plaintext', () => {
    delete process.env.PII_ENCRYPTION_KEY;
    __resetKeyCacheForTests();
    expect(fieldFingerprint('ABCDE1234F')).toBeNull();
  });
});
