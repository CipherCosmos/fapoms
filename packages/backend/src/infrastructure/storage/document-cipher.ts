import { createCipheriv, randomBytes } from 'crypto';
import { Transform, type TransformCallback } from 'stream';
import { deriveSubkey } from '../security/field-encryption';

/**
 * EVERY STORED FILE ENCRYPTED BY THE APP, BEFORE IT REACHES THE OBJECT STORE.
 *
 * An audit of the running stack read the MinIO disk directly: 123 of 124 stored objects — Aadhaar
 * and PAN scans, photographs, bank passbooks, audit packets — opened as ordinary PDFs and images.
 * The bucket had no server-side encryption (community MinIO cannot provide it without a KMS), the
 * app logged a warning and carried on, and the nightly backup copied the same plaintext files to a
 * second disk. Whoever could read the disk, a backup, or a snapshot could read every identity
 * document the business holds.
 *
 * Encrypting in the app rather than in the store was the owner's choice, for one reason: it is the
 * same on MinIO, on the homeserver and on AWS, and does not depend on each one being configured
 * correctly — which is exactly what had failed.
 *
 * WHY AES-256-CTR AND NOT GCM. Field downloads resume with HTTP Range requests, so a file has to be
 * decryptable from any byte offset. Counter mode is length-preserving and seekable: byte N of the
 * ciphertext is byte N of the plaintext, and decryption can start at any block. GCM authenticates
 * the whole object and cannot hand back a verified middle. Tampering is a separate concern with its
 * own control here — every stored document already carries a SHA-256 of its plaintext
 * (`content_sha256`) — and anybody able to overwrite ciphertext in the bucket could equally replace
 * the file outright.
 *
 * WHAT IS STORED. The object body is ciphertext; the per-object IV and a key identifier ride in the
 * object's user metadata. The key is derived from the root PII key (`deriveSubkey`), so there is
 * still exactly one secret to protect and back up.
 */

export const CIPHER = 'aes-256-ctr';
const BLOCK = 16;

/** S3 user-metadata keys. The SDK lowercases them on the way back, so they are lowercase here. */
export const META = {
  scheme: 'fapoms-enc',
  iv: 'fapoms-iv',
  keyId: 'fapoms-kid',
} as const;

export const SCHEME_V1 = 'ctr-v1';
export const KEY_ID_V1 = 'pii-hkdf-documents-v1';

/** The document key, or null when no root key is configured (development without encryption). */
export function documentKey(): Buffer | null {
  return deriveSubkey('fapoms/documents/v1');
}

export interface Seal {
  iv: Buffer;
  metadata: Record<string, string>;
}

/** A fresh IV and the metadata that must be stored beside the ciphertext. */
export function newSeal(): Seal {
  const iv = randomBytes(BLOCK);
  return {
    iv,
    metadata: { [META.scheme]: SCHEME_V1, [META.iv]: iv.toString('hex'), [META.keyId]: KEY_ID_V1 },
  };
}

/** Whether an object's metadata says its body is ciphertext from this module. */
export function isSealed(metadata: Record<string, string> | undefined | null): boolean {
  return !!metadata && metadata[META.scheme] === SCHEME_V1 && typeof metadata[META.iv] === 'string';
}

export function ivOf(metadata: Record<string, string>): Buffer {
  const iv = Buffer.from(metadata[META.iv], 'hex');
  if (iv.length !== BLOCK) throw new Error('Stored document has a malformed encryption IV.');
  return iv;
}

/** The counter block for a given block index: the IV read as a 128-bit big-endian number, plus the index. */
function counterFor(iv: Buffer, blockIndex: bigint): Buffer {
  let value = BigInt(`0x${iv.toString('hex')}`) + blockIndex;
  value &= (1n << 128n) - 1n;
  return Buffer.from(value.toString(16).padStart(32, '0'), 'hex');
}

/** Encrypt a whole buffer. */
export function encryptBuffer(plain: Buffer, key: Buffer, iv: Buffer): Buffer {
  const cipher = createCipheriv(CIPHER, key, iv);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/** A stream that encrypts from byte 0. */
export function encryptingStream(key: Buffer, iv: Buffer): Transform {
  return createCipheriv(CIPHER, key, iv);
}

/**
 * Where a ranged read has to start in the ciphertext, and how many leading plaintext bytes to throw
 * away. Counter mode decrypts from a block boundary, so a read starting mid-block fetches from the
 * start of that block and discards the difference.
 */
export function alignedRange(start: number): { alignedStart: number; skip: number } {
  const skip = start % BLOCK;
  return { alignedStart: start - skip, skip };
}

/**
 * A stream that decrypts ciphertext which begins at `alignedOffset` (a block boundary), then drops
 * the first `skip` bytes of plaintext so the output begins exactly where the caller asked.
 */
export function decryptingStream(key: Buffer, iv: Buffer, alignedOffset = 0, skip = 0): Transform {
  if (alignedOffset % BLOCK !== 0) throw new Error('Decryption must start on a block boundary.');
  const decipher = createCipheriv(CIPHER, key, counterFor(iv, BigInt(alignedOffset / BLOCK)));
  let toSkip = skip;
  return new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback) {
      let out = decipher.update(chunk);
      if (toSkip > 0) {
        const drop = Math.min(toSkip, out.length);
        out = out.subarray(drop);
        toSkip -= drop;
      }
      done(null, out);
    },
    flush(done: TransformCallback) {
      const tail = decipher.final();
      done(null, tail.length ? tail : undefined);
    },
  });
}
