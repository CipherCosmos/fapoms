import { randomBytes } from 'crypto';
import { Readable } from 'stream';
import { S3StorageService } from './s3-storage.service';
import { isSealed } from './document-cipher';
import { __resetKeyCacheForTests } from '../security/field-encryption';

/**
 * THE STORE NEVER HOLDS A READABLE DOCUMENT; THE APP ALWAYS GETS ONE BACK.
 *
 * Driven through the real storage service against an in-memory object store, so what is asserted is
 * what actually crosses the wire to MinIO or S3 — the thing a disk, a snapshot or a backup would
 * contain — and what every download route receives.
 */
type Stored = { body: Buffer; metadata?: Record<string, string>; contentType?: string };

function fakeStore() {
  const objects = new Map<string, Stored>();
  const send = jest.fn(async (command: any) => {
    const name = command.constructor.name;
    const input = command.input;
    if (name === 'PutObjectCommand') {
      const body = Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(input.Body);
      objects.set(input.Key, { body, metadata: input.Metadata, contentType: input.ContentType });
      return {};
    }
    const obj = objects.get(input.Key);
    if (!obj) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    if (name === 'HeadObjectCommand') {
      return { ContentLength: obj.body.length, Metadata: obj.metadata, ContentType: obj.contentType, LastModified: new Date() };
    }
    if (name === 'GetObjectCommand') {
      let body = obj.body;
      if (input.Range) {
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(input.Range)!;
        body = body.subarray(Number(a), Number(b) + 1);
      }
      return { Body: Readable.from([body]), Metadata: obj.metadata, ContentType: obj.contentType };
    }
    return {};
  });
  return { objects, send };
}

const collect = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
};

describe('documents at rest', () => {
  const originalKey = process.env.PII_ENCRYPTION_KEY;
  let service: S3StorageService;
  let store: ReturnType<typeof fakeStore>;
  // An identity scan: recognisable header, then noise, and not a whole number of blocks.
  const scan = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF'), randomBytes(9000 + 5)]);

  beforeEach(() => {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    __resetKeyCacheForTests();
    service = new S3StorageService({ get: (_k: string, d?: unknown) => d } as never);
    store = fakeStore();
    (service as any).client = { send: store.send };
    (service as any).bucket = 'fapoms-documents';
  });
  afterEach(() => { process.env.PII_ENCRYPTION_KEY = originalKey; __resetKeyCacheForTests(); });

  it('stores ciphertext, never the scan', async () => {
    const key = await service.saveFile('aadhaar-front.jpg', scan, 'image/jpeg');
    const stored = store.objects.get(key)!;

    expect(stored.body.includes(Buffer.from('JFIF'))).toBe(false);
    expect(stored.body.equals(scan)).toBe(false);
    expect(isSealed(stored.metadata)).toBe(true);
    expect(stored.body.length).toBe(scan.length);
  });

  it('gives every download the original bytes back', async () => {
    const key = await service.saveFile('aadhaar-front.jpg', scan, 'image/jpeg');
    expect(await collect(await service.getFileStream(key))).toEqual(scan);
  });

  /** Resumed field downloads ask for byte ranges; those must decrypt exactly, from anywhere. */
  it.each([[0, 99], [3, 3], [16, 47], [17, 4096], [8999, 9012]])(
    'serves bytes %i..%i of an encrypted document exactly',
    async (start, end) => {
      const key = await service.saveFile('passbook.pdf', scan, 'application/pdf');
      expect(await collect(await service.getFileStream(key, start, end))).toEqual(scan.subarray(start, end + 1));
    },
  );

  /** Everything stored before this change is read as it was, until the one-off run seals it. */
  it('still reads a document stored before encryption existed', async () => {
    store.objects.set('uploads/legacy.jpg', { body: scan, contentType: 'image/jpeg' });
    expect(await collect(await service.getFileStream('uploads/legacy.jpg'))).toEqual(scan);
    expect(await collect(await service.getFileStream('uploads/legacy.jpg', 10, 40))).toEqual(scan.subarray(10, 41));
  });

  it('seals a document a client uploaded straight into the store, and only once', async () => {
    store.objects.set('documents/direct/abc/packet.pdf', { body: scan, contentType: 'application/pdf' });

    expect(await service.sealObject('documents/direct/abc/packet.pdf')).toBe(true);
    const sealed = store.objects.get('documents/direct/abc/packet.pdf')!;
    expect(sealed.body.includes(Buffer.from('JFIF'))).toBe(false);
    expect(sealed.contentType).toBe('application/pdf');
    expect(await collect(await service.getFileStream('documents/direct/abc/packet.pdf'))).toEqual(scan);

    // A second seal would encrypt ciphertext — and the file would be unreadable for ever.
    expect(await service.sealObject('documents/direct/abc/packet.pdf')).toBe(false);
    expect(await collect(await service.getFileStream('documents/direct/abc/packet.pdf'))).toEqual(scan);
  });

  it('refuses to hand out a presigned download that would return ciphertext', async () => {
    await expect(service.getSignedUrl('uploads/anything.jpg')).rejects.toThrow(/encrypted/);
  });

  it('refuses to read an encrypted document with no key, rather than returning ciphertext', async () => {
    const key = await service.saveFile('pan.jpg', scan, 'image/jpeg');
    delete process.env.PII_ENCRYPTION_KEY;
    __resetKeyCacheForTests();
    await expect(service.getFileStream(key)).rejects.toThrow(/no PII_ENCRYPTION_KEY/);
  });
});
