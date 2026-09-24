import { randomBytes } from 'crypto';
import { Readable } from 'stream';
import { S3StorageService } from './s3-storage.service';
import { isSealed } from './document-cipher';
import { __resetKeyCacheForTests } from '../security/field-encryption';

/**
 * `saveFileAt` is how a finalized direct upload reaches its server-owned key. It must seal exactly
 * as `saveFile` does — the object it replaces was sealed in place before, and a move that dropped
 * the encryption would put plaintext KYC scans back in the bucket.
 */
function fakeStore() {
  const objects = new Map<string, { body: Buffer; metadata?: Record<string, string>; contentType?: string }>();
  const send = jest.fn(async (command: any) => {
    const name = command.constructor.name;
    const input = command.input;
    if (name === 'PutObjectCommand') {
      objects.set(input.Key, { body: Buffer.from(input.Body), metadata: input.Metadata, contentType: input.ContentType });
      return {};
    }
    const obj = objects.get(input.Key);
    if (!obj) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    if (name === 'HeadObjectCommand') return { ContentLength: obj.body.length, Metadata: obj.metadata, ContentType: obj.contentType };
    if (name === 'GetObjectCommand') {
      // Honour `Range` as S3 does, so the ranged-read assertion tests the decryptor, not the fake.
      const range = /^bytes=(\d+)-(\d+)$/.exec(input.Range ?? '');
      const body = range ? obj.body.subarray(Number(range[1]), Number(range[2]) + 1) : obj.body;
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

describe('S3StorageService.saveFileAt', () => {
  const originalKey = process.env.PII_ENCRYPTION_KEY;
  const scan = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(5003)]);
  let service: S3StorageService;
  let store: ReturnType<typeof fakeStore>;

  beforeEach(() => {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    __resetKeyCacheForTests();
    service = new S3StorageService({ get: (_k: string, d?: unknown) => d } as never);
    store = fakeStore();
    (service as any).client = { send: store.send };
    (service as any).bucket = 'fapoms-documents';
  });
  afterEach(() => { process.env.PII_ENCRYPTION_KEY = originalKey; __resetKeyCacheForTests(); });

  it('writes at exactly the key it was given', async () => {
    expect(await service.saveFileAt('documents/final/abc.pdf', scan, 'application/pdf')).toBe('documents/final/abc.pdf');
    expect([...store.objects.keys()]).toEqual(['documents/final/abc.pdf']);
    expect(store.objects.get('documents/final/abc.pdf')!.contentType).toBe('application/pdf');
  });

  it('stores ciphertext with a seal, and reads back the original bytes', async () => {
    await service.saveFileAt('documents/final/abc.pdf', scan, 'application/pdf');
    const stored = store.objects.get('documents/final/abc.pdf')!;
    expect(isSealed(stored.metadata)).toBe(true);
    expect(stored.body.equals(scan)).toBe(false);
    expect(stored.body.includes(Buffer.from('%PDF'))).toBe(false);
    expect(await collect(await service.getFileStream('documents/final/abc.pdf'))).toEqual(scan);
    expect(await collect(await service.getFileStream('documents/final/abc.pdf', 20, 99))).toEqual(scan.subarray(20, 100));
  });

  it('without a root key (development) stores the bytes as given, as saveFile does', async () => {
    delete process.env.PII_ENCRYPTION_KEY;
    __resetKeyCacheForTests();
    await service.saveFileAt('documents/final/dev.pdf', scan);
    expect(store.objects.get('documents/final/dev.pdf')!.body).toEqual(scan);
  });
});
