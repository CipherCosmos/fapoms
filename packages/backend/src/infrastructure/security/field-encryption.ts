import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac, hkdfSync } from 'crypto';
import { Logger } from '@nestjs/common';
import type { ValueTransformer } from 'typeorm';

/**
 * Column-level encryption for sensitive personal data at rest (PAN, bank account, government-ID
 * numbers). Banks' vendors handling this data are expected under the DPDP Act 2023 to protect it at
 * rest; a plaintext `pan_number` column is the gap this closes.
 *
 * Design:
 * - AES-256-GCM (authenticated) with a random 96-bit IV per value, so identical inputs differ on disk
 *   and any tampering is detected on read.
 * - Stored as `enc:v1:<base64(iv | tag | ciphertext)>`. The version tag lets the scheme rotate later.
 * - Reads are backward-compatible: a value without the prefix is treated as legacy plaintext and
 *   returned as-is, so the switch can roll out before existing rows are back-filled. Every write
 *   re-stores the value encrypted, so data migrates itself as it is touched.
 * - Key comes from `PII_ENCRYPTION_KEY` (64 hex chars or a 32-byte base64 string; anything else is
 *   hashed to 32 bytes). If it is absent the fields are stored UNENCRYPTED and a loud warning is
 *   logged — dev keeps working, production must set the key. Encryption is never silently assumed.
 *
 * Note: GCM is non-deterministic, so an encrypted column cannot be queried by exact value or LIKE.
 * These fields are looked up by the assayer, never searched directly, so that is acceptable.
 */

const logger = new Logger('FieldEncryption');
const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

// undefined = not yet resolved, null = intentionally absent (passthrough mode)
let keyCache: Buffer | null | undefined;

function resolveKey(): Buffer | null {
  if (keyCache !== undefined) return keyCache;
  const raw = process.env.PII_ENCRYPTION_KEY;
  if (!raw) {
    logger.warn(
      'PII_ENCRYPTION_KEY is not set — sensitive fields (PAN, bank account, government IDs) are stored ' +
        'UNENCRYPTED. Set a 32-byte key (64 hex chars or base64) before production.',
    );
    keyCache = null;
    return null;
  }
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) {
      key = b;
    } else {
      /**
       * A key that is neither 64 hex chars nor 32 base64 bytes is stretched to 32 bytes so dev
       * keeps working — but silently, this let `PII_ENCRYPTION_KEY=hello` masquerade as
       * encryption. Production refuses this shape at boot (`assertProductionSafeConfig`); here it
       * is named out loud so nobody mistakes a passphrase for a key.
       */
      logger.warn(
        'PII_ENCRYPTION_KEY is not a canonical 32-byte key (64 hex chars or 32-byte base64) — ' +
          'deriving one from it via SHA-256. Fine for development; production requires the real ' +
          'format and will refuse to boot with this value.',
      );
      key = createHash('sha256').update(raw).digest();
    }
  }
  keyCache = key;
  return key;
}

/**
 * A deterministic fingerprint of an encrypted value, for equality searches only.
 *
 * `encryptField` uses a fresh random IV per call, so the same PAN encrypts to different ciphertext
 * every time and `WHERE pan_number = :pan` matches nothing — ever. That is correct for secrecy and
 * fatal for the one thing the roster needs from these columns: telling whether this person is
 * already on it. The duplicate check has carried a `DEFINITE_DUPLICATE: An assayer with PAN … already
 * exists` branch since it was written, and under encryption it could not fire once. It read, to
 * anyone auditing it, like a working control.
 *
 * So the ciphertext stays as it is, and a keyed hash of the NORMALISED plaintext sits beside it.
 * Keyed, not plain: an unkeyed hash of a PAN is trivially reversible — the space is small enough to
 * enumerate — and this column is in every backup. The key is derived from `PII_ENCRYPTION_KEY` with
 * its own label, so nothing new has to be configured and the fingerprint cannot be computed by
 * anybody who does not already hold the decryption key.
 *
 * Equality only. There is no ordering, no prefix search, and no way back to the value.
 *
 * Returns null with no key configured, so a deployment without encryption keeps whatever behaviour
 * it had rather than silently indexing plaintext.
 */
export function fieldFingerprint(plain: string | null | undefined): string | null {
  const normalised = (plain ?? '').trim().toUpperCase();
  if (normalised === '') return null;
  const key = resolveKey();
  if (!key) return null;
  return createHmac('sha256', createHash('sha256').update(key).update('fingerprint-v1').digest())
    .update(normalised)
    .digest('hex');
}

/**
 * A key for one purpose, derived from the one root key with HKDF-SHA256.
 *
 * Why derive rather than add a second secret: the audit that led here found the root key has no
 * escrow copy, and losing it loses every encrypted PAN, Aadhaar and bank number. A second
 * independent key for documents would be a second thing to lose, with the same consequence for
 * every scanned ID card. Deriving keeps one secret to protect and back up, while each purpose still
 * gets its own key — a document key cannot decrypt a field, nor the other way round.
 *
 * Null with no root key configured, like everything else here.
 */
export function deriveSubkey(purpose: string): Buffer | null {
  const root = resolveKey();
  if (!root) return null;
  return Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), Buffer.from(purpose, 'utf8'), 32));
}

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptField(plain: string): string {
  const key = resolveKey();
  if (!key) return plain; // passthrough mode (no key configured)
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptField(value: string): string {
  if (!isEncrypted(value)) return value; // legacy plaintext row, not yet migrated
  const key = resolveKey();
  if (!key) {
    logger.error('Encrypted value found but PII_ENCRYPTION_KEY is not set — returning it unreadable.');
    return value;
  }
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * TypeORM column transformer. Encrypts on the way to the database, decrypts on the way back, and
 * leaves null/empty untouched so nullable columns behave normally.
 */
export const encryptedColumn: ValueTransformer = {
  to: (value: string | null | undefined): string | null => {
    if (value == null || value === '') return value ?? null;
    return encryptField(value);
  },
  from: (value: string | null | undefined): string | null => {
    if (value == null) return null;
    return decryptField(value);
  },
};

/** Test-only: force the key to be re-read from the environment. */
export function __resetKeyCacheForTests(): void {
  keyCache = undefined;
}
