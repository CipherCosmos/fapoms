import {
  base32Encode, base32Decode, generateTotpSecret, totp, verifyTotp, otpauthUri,
  generateRecoveryCodes, hashRecoveryCode,
} from './totp';

/**
 * Correctness is pinned to the OFFICIAL RFC 6238 Appendix B test vectors — the guarantee that this
 * from-scratch implementation is interoperable with every standard authenticator app. The SHA-1
 * seed in the RFC is the ASCII string "12345678901234567890".
 */
describe('TOTP (RFC 6238)', () => {
  const seed = base32Encode(Buffer.from('12345678901234567890'));

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('matches the RFC 6238 vector at T=%is (8-digit)', (t, expected) => {
    expect(totp(seed, t * 1000, 30, 8)).toBe(expected);
  });

  it('base32 round-trips', () => {
    const b = Buffer.from('hello world secret!!');
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });

  it('generates a 160-bit (32-char base32) secret', () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('verifies the current code and rejects a wrong one', () => {
    const s = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(s, totp(s, now), now)).toBe(true);
    expect(verifyTotp(s, '000000', now)).toBe(false);
    expect(verifyTotp(s, 'abc', now)).toBe(false);
    expect(verifyTotp(s, '', now)).toBe(false);
  });

  it('accepts the previous/next step within the skew window but not two steps away', () => {
    const s = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(s, totp(s, now - 30_000), now, 1)).toBe(true);  // previous step
    expect(verifyTotp(s, totp(s, now + 30_000), now, 1)).toBe(true);  // next step
    expect(verifyTotp(s, totp(s, now - 90_000), now, 1)).toBe(false); // 3 steps back
  });

  it('builds a scannable otpauth URI with issuer and secret', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'user@example.com', 'FAPOMS');
    expect(uri).toContain('otpauth://totp/FAPOMS:user%40example.com');
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=FAPOMS');
  });
});

describe('recovery codes', () => {
  it('generates N codes, returns plaintext once and hashes separately (never the same value stored)', () => {
    const { plaintext, hashes } = generateRecoveryCodes(10);
    expect(plaintext).toHaveLength(10);
    expect(hashes).toHaveLength(10);
    expect(plaintext[0]).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
    // the stored hash is not the plaintext
    expect(hashes[0]).not.toContain(plaintext[0]);
    // hashing is stable and case/space-insensitive
    expect(hashRecoveryCode(plaintext[0])).toBe(hashes[0]);
    expect(hashRecoveryCode(` ${plaintext[0].toLowerCase()} `)).toBe(hashes[0]);
  });

  it('produces unique codes', () => {
    const { plaintext } = generateRecoveryCodes(20);
    expect(new Set(plaintext).size).toBe(20);
  });
});
