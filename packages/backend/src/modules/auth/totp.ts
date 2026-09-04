import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * RFC 6238 (TOTP) / RFC 4226 (HOTP), implemented directly on node's crypto rather than pulling a
 * dependency — the algorithm is small, and doing it here keeps the one security-critical primitive
 * auditable and free of supply-chain surface. Correctness is pinned against the official RFC 6238
 * Appendix B test vectors in totp.spec.ts.
 *
 * Base32 (RFC 4648, no padding) is used for the shared secret because that is what authenticator
 * apps and the otpauth:// URI expect.
 */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character in TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh, high-entropy TOTP secret (20 bytes = 160 bits, the RFC-recommended size), base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP (RFC 4226): the counter-based one-time password `digits` long. */
export function hotp(secretBase32: string, counter: number, digits = 6, algorithm = 'sha1'): string {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter. Split to stay within 32-bit bitwise ops.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac(algorithm, key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** TOTP (RFC 6238): the time-based code for `atMs`, with `stepSeconds` (default 30). */
export function totp(secretBase32: string, atMs = Date.now(), stepSeconds = 30, digits = 6, algorithm = 'sha1'): string {
  return hotp(secretBase32, Math.floor(atMs / 1000 / stepSeconds), digits, algorithm);
}

/**
 * Verify a presented code, allowing ±`window` steps of clock skew (default 1 = ±30s), constant-time.
 * Bounded skew per the directive; window 1 is the common, safe choice.
 */
export function verifyTotp(secretBase32: string, token: string, atMs = Date.now(), window = 1, stepSeconds = 30, digits = 6): boolean {
  const t = (token || '').trim();
  if (!/^\d{6,8}$/.test(t)) return false;
  const counter = Math.floor(atMs / 1000 / stepSeconds);
  for (let w = -window; w <= window; w++) {
    const candidate = hotp(secretBase32, counter + w, digits);
    const a = Buffer.from(candidate);
    const b = Buffer.from(t);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** The otpauth:// provisioning URI an authenticator app reads from a QR code. */
export function otpauthUri(secretBase32: string, account: string, issuer = 'FAPOMS'): string {
  // Label is `issuer:account` with the colon kept literal (the conventional, widely-compatible
  // form) and each part percent-encoded individually.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Recovery codes: `count` high-entropy single-use codes, returned in PLAINTEXT once (for the user to
 * store) and separately as SHA-256 hashes for storage — the plaintext is never persisted.
 */
export function generateRecoveryCodes(count = 10): { plaintext: string[]; hashes: string[] } {
  const plaintext: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    // 10 hex chars grouped as XXXXX-XXXXX — ~40 bits, ample for a single-use, rate-limited code.
    const raw = randomBytes(5).toString('hex');
    const code = `${raw.slice(0, 5)}-${raw.slice(5, 10)}`.toUpperCase();
    plaintext.push(code);
    hashes.push(hashRecoveryCode(code));
  }
  return { plaintext, hashes };
}

/** Stable SHA-256 of a normalised recovery code — what is stored and compared (never the plaintext). */
export function hashRecoveryCode(code: string): string {
  const normalised = (code || '').trim().toUpperCase();
  return createHmac('sha256', 'fapoms-recovery-code').update(normalised).digest('hex');
}
