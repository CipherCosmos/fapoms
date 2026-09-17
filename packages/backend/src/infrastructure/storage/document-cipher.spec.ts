import { randomBytes } from 'crypto';
import { Readable } from 'stream';
import {
  documentKey, newSeal, isSealed, ivOf, encryptBuffer, encryptingStream, decryptingStream, alignedRange,
} from './document-cipher';
import { __resetKeyCacheForTests } from '../security/field-encryption';

/**
 * 123 of 124 stored documents opened as plain PDFs and images straight off the storage disk. These
 * pin the cipher that closes that: nothing readable at rest, and every byte still recoverable —
 * including from the middle of a file, because field downloads resume with Range requests.
 */
const collect = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
};

/** Feeds a buffer in deliberately awkward chunk sizes, the way a network delivers it. */
const chunked = (buf: Buffer, sizes = [7, 1, 33, 16, 5, 250]): Readable => {
  const pieces: Buffer[] = [];
  for (let i = 0, k = 0; i < buf.length; k++) {
    const n = sizes[k % sizes.length];
    pieces.push(buf.subarray(i, i + n));
    i += n;
  }
  return Readable.from(pieces);
};

describe('encrypting a stored document', () => {
  const key = randomBytes(32);
  // A plausible scan: a PDF header, then noise, and not a multiple of the block size.
  const plain = Buffer.concat([Buffer.from('%PDF-1.7\n%âãÏÓ\n'), randomBytes(5000 + 13)]);

  it('leaves nothing recognisable in what is stored', () => {
    const { iv } = newSeal();
    const cipher = encryptBuffer(plain, key, iv);
    expect(cipher.includes(Buffer.from('%PDF'))).toBe(false);
    // Counter mode is length-preserving, so sizes, Content-Length and Range offsets stay true.
    expect(cipher.length).toBe(plain.length);
  });

  it('uses a different IV for every file, so two copies of one scan do not match on disk', () => {
    const a = newSeal();
    const b = newSeal();
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(encryptBuffer(plain, key, a.iv).equals(encryptBuffer(plain, key, b.iv))).toBe(false);
  });

  it('gives back exactly the original bytes', async () => {
    const { iv } = newSeal();
    const cipher = encryptBuffer(plain, key, iv);
    expect((await collect(chunked(cipher).pipe(decryptingStream(key, iv))))).toEqual(plain);
  });

  it('streams the same ciphertext as the buffer path', async () => {
    const { iv } = newSeal();
    const streamed = await collect(chunked(plain).pipe(encryptingStream(key, iv)));
    expect(streamed).toEqual(encryptBuffer(plain, key, iv));
  });

  /**
   * A resumed download asks for bytes N..M. Counter mode can start mid-file, but only on a block
   * boundary, so the read starts at the block and discards the difference. Every awkward offset is
   * checked: block boundaries, one past, one before, and the very end.
   */
  it.each([0, 1, 15, 16, 17, 31, 32, 1000, 4095, 4096, 5020, 5028])(
    'decrypts a range starting at byte %i exactly',
    async (start) => {
      const { iv } = newSeal();
      const cipher = encryptBuffer(plain, key, iv);
      const end = Math.min(plain.length - 1, start + 777);
      const { alignedStart, skip } = alignedRange(start);
      const fetched = cipher.subarray(alignedStart, end + 1);   // what a Range GET returns

      const out = await collect(chunked(fetched).pipe(decryptingStream(key, iv, alignedStart, skip)));
      expect(out).toEqual(plain.subarray(start, end + 1));
    },
  );

  it('refuses to start decrypting off a block boundary rather than returning garbage', () => {
    expect(() => decryptingStream(key, randomBytes(16), 17)).toThrow(/block boundary/);
  });

  /** An IV counter at its maximum must wrap, not overflow into a wrong or longer counter block. */
  it('decrypts correctly across a counter that wraps', async () => {
    const iv = Buffer.alloc(16, 0xff);
    const cipher = encryptBuffer(plain, key, iv);
    const { alignedStart, skip } = alignedRange(40);
    const out = await collect(Readable.from([cipher.subarray(alignedStart)]).pipe(decryptingStream(key, iv, alignedStart, skip)));
    expect(out).toEqual(plain.subarray(40));
  });
});

describe('knowing whether a stored object is encrypted', () => {
  it('recognises its own metadata and nothing else', () => {
    const { metadata, iv } = newSeal();
    expect(isSealed(metadata)).toBe(true);
    expect(ivOf(metadata).equals(iv)).toBe(true);
    // Objects written before this existed carry no metadata, and are read as they are.
    expect(isSealed({})).toBe(false);
    expect(isSealed(undefined)).toBe(false);
    expect(isSealed({ 'fapoms-enc': 'something-else', 'fapoms-iv': 'aa' })).toBe(false);
  });
});

describe('the document key', () => {
  const original = process.env.PII_ENCRYPTION_KEY;
  afterEach(() => { process.env.PII_ENCRYPTION_KEY = original; __resetKeyCacheForTests(); });

  it('is derived from the one root key, and is not the root key itself', () => {
    const root = randomBytes(32);
    process.env.PII_ENCRYPTION_KEY = root.toString('hex');
    __resetKeyCacheForTests();
    const k = documentKey();
    expect(k).not.toBeNull();
    expect(k!.length).toBe(32);
    expect(k!.equals(root)).toBe(false);
    // Stable: the same root always yields the same document key, or old files would be unreadable.
    __resetKeyCacheForTests();
    expect(documentKey()!.equals(k!)).toBe(true);
  });

  it('is absent when there is no root key, rather than inventing one', () => {
    delete process.env.PII_ENCRYPTION_KEY;
    __resetKeyCacheForTests();
    expect(documentKey()).toBeNull();
  });
});
