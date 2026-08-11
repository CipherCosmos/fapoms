import {
  encryptField,
  decryptField,
  isEncrypted,
  encryptedColumn,
  __resetKeyCacheForTests,
} from './field-encryption';

const KEY = 'a'.repeat(64); // 32 bytes as hex

describe('field-encryption', () => {
  describe('with a key configured', () => {
    beforeEach(() => {
      process.env.PII_ENCRYPTION_KEY = KEY;
      __resetKeyCacheForTests();
    });
    afterAll(() => {
      delete process.env.PII_ENCRYPTION_KEY;
      __resetKeyCacheForTests();
    });

    it('round-trips a value', () => {
      const plain = 'ABCDE1234F';
      const enc = encryptField(plain);
      expect(enc).toMatch(/^enc:v1:/);
      expect(enc).not.toContain(plain);
      expect(decryptField(enc)).toBe(plain);
    });

    it('produces a different ciphertext each time (random IV) but decrypts to the same value', () => {
      const a = encryptField('1234567890');
      const b = encryptField('1234567890');
      expect(a).not.toBe(b);
      expect(decryptField(a)).toBe('1234567890');
      expect(decryptField(b)).toBe('1234567890');
    });

    it('detects tampering via the GCM auth tag', () => {
      const enc = encryptField('sensitive');
      // Flip a character in the base64 body.
      const body = enc.slice('enc:v1:'.length);
      const tampered = 'enc:v1:' + (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
      expect(() => decryptField(tampered)).toThrow();
    });

    it('passes through legacy plaintext on read', () => {
      expect(isEncrypted('legacy-plain')).toBe(false);
      expect(decryptField('legacy-plain')).toBe('legacy-plain');
    });

    it('transformer handles null and empty without encrypting', () => {
      expect(encryptedColumn.to(null)).toBeNull();
      expect(encryptedColumn.to(undefined)).toBeNull();
      expect(encryptedColumn.to('')).toBe(''); // empty stays empty, never encrypted
      expect(encryptedColumn.from(null)).toBeNull();
    });

    it('transformer round-trips a real value', () => {
      const stored = encryptedColumn.to('AAAPZ1234C') as string;
      expect(isEncrypted(stored)).toBe(true);
      expect(encryptedColumn.from(stored)).toBe('AAAPZ1234C');
    });
  });

  describe('without a key (passthrough mode)', () => {
    beforeEach(() => {
      delete process.env.PII_ENCRYPTION_KEY;
      __resetKeyCacheForTests();
    });

    it('stores plaintext and still reads it back (dev-friendly, warns at startup)', () => {
      const v = encryptField('no-key-here');
      expect(v).toBe('no-key-here');
      expect(isEncrypted(v)).toBe(false);
      expect(decryptField(v)).toBe('no-key-here');
    });
  });
});
