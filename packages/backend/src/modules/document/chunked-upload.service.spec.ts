import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis-client.module';
import { ChunkedUploadService } from './chunked-upload.service';

/**
 * Covers the consolidation onto `StorageEngine` — this service used to build its own `S3Client`
 * and had zero test coverage of any kind. The fake storage engine below stands in for
 * `S3StorageService`, so these tests exercise the real contract the two are expected to agree on:
 * `createMultipartUpload` derives the key, part numbers are 1-indexed on the wire and 0-indexed on
 * this service's own public API, and multipart is optional on the interface (a store without it
 * must be refused with a clear message, not "storage.uploadPart is not a function").
 */
describe('ChunkedUploadService', () => {
  let service: ChunkedUploadService;
  let redisStore: Map<string, string>;

  const redis = {
    set: jest.fn((key: string, value: string) => {
      redisStore.set(key, value);
      return Promise.resolve('OK');
    }),
    get: jest.fn((key: string) => Promise.resolve(redisStore.get(key) ?? null)),
    del: jest.fn((key: string) => {
      redisStore.delete(key);
      return Promise.resolve(1);
    }),
    keys: jest.fn((pattern: string) => {
      // Only ever called with the fixed 'chunked_upload:*' pattern in this service.
      void pattern;
      return Promise.resolve([...redisStore.keys()]);
    }),
  };

  /** Uploaded parts, keyed by `${key}:${uploadId}`, so multiple sessions don't collide. */
  let uploadedParts: Map<string, Set<number>>;
  const partsKey = (key: string, uploadId: string) => `${key}:${uploadId}`;

  const fullStorage = {
    createMultipartUpload: jest.fn(async (fileName: string) => ({
      uploadId: `up-${fileName}`,
      key: `uploads/${fileName}`,
    })),
    uploadPart: jest.fn(async (key: string, uploadId: string, partNumber: number) => {
      const k = partsKey(key, uploadId);
      if (!uploadedParts.has(k)) uploadedParts.set(k, new Set());
      uploadedParts.get(k)!.add(partNumber);
    }),
    listUploadedParts: jest.fn(async (key: string, uploadId: string) =>
      [...(uploadedParts.get(partsKey(key, uploadId)) ?? [])].sort((a, b) => a - b),
    ),
    getSignedPartUploadUrl: jest.fn(async (key: string, uploadId: string, partNumber: number) =>
      `https://example-storage/${key}?uploadId=${uploadId}&partNumber=${partNumber}`,
    ),
    completeMultipartUpload: jest.fn(async () => undefined),
    abortMultipartUpload: jest.fn(async () => undefined),
  };

  async function build(storage: Partial<typeof fullStorage> | Record<string, never> = fullStorage) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChunkedUploadService,
        { provide: 'StorageEngine', useValue: storage },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();
    return module.get(ChunkedUploadService);
  }

  beforeEach(async () => {
    redisStore = new Map();
    uploadedParts = new Map();
    jest.clearAllMocks();
    service = await build();
  });

  describe('createSession', () => {
    it('opens a multipart upload through the storage engine and derives totalChunks from the file size', async () => {
      const session = await service.createSession({
        assessmentId: 'a1',
        fileName: 'scan.pdf',
        fileSize: 12 * 1024 * 1024, // 12 MB, over the 5 MB floor
        createdBy: 'u1',
      });

      expect(fullStorage.createMultipartUpload).toHaveBeenCalledWith('scan.pdf', 'application/pdf');
      expect(session.s3Key).toBe('uploads/scan.pdf');
      expect(session.s3UploadId).toBe('up-scan.pdf');
      expect(session.chunkSize).toBe(ChunkedUploadService.MIN_CHUNK_SIZE);
      expect(session.totalChunks).toBe(Math.ceil((12 * 1024 * 1024) / ChunkedUploadService.MIN_CHUNK_SIZE));
    });

    it('floors a caller-supplied chunkSize at the S3 multipart minimum, unconditionally', async () => {
      // A smaller chunkSize would let every UploadPart succeed and only fail at
      // CompleteMultipartUpload, after the whole file has already been sent — see MIN_CHUNK_SIZE's
      // own comment. The floor must apply even when the caller explicitly asked for less.
      const session = await service.createSession({
        assessmentId: 'a1',
        fileName: 'scan.pdf',
        fileSize: 20 * 1024 * 1024,
        createdBy: 'u1',
        chunkSize: 512 * 1024,
      });
      expect(session.chunkSize).toBe(ChunkedUploadService.MIN_CHUNK_SIZE);
    });

    it('refuses a non-positive file size before ever touching storage', async () => {
      await expect(
        service.createSession({ assessmentId: 'a1', fileName: 'x.pdf', fileSize: 0, createdBy: 'u1' }),
      ).rejects.toThrow(BadRequestException);
      expect(fullStorage.createMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('the chunk lifecycle', () => {
    async function openSession() {
      return service.createSession({
        assessmentId: 'a1',
        fileName: 'scan.pdf',
        fileSize: 11 * 1024 * 1024, // 3 chunks at the 5 MB floor
        createdBy: 'u1',
      });
    }

    it('reports chunks received (0-indexed) as they are uploaded, even though S3 parts are 1-indexed', async () => {
      const session = await openSession();
      expect(await service.receivedChunks(session.uploadId)).toEqual([]);

      const data = Buffer.from('x'.repeat(10));
      await service.saveChunk(session.uploadId, 0, data);
      expect(fullStorage.uploadPart).toHaveBeenCalledWith(session.s3Key, session.s3UploadId, 1, data);
      expect(await service.receivedChunks(session.uploadId)).toEqual([0]);

      await service.saveChunk(session.uploadId, 2, data);
      expect(fullStorage.uploadPart).toHaveBeenCalledWith(session.s3Key, session.s3UploadId, 3, data);
      expect(await service.receivedChunks(session.uploadId)).toEqual([0, 2]);
    });

    it('refuses a chunk index outside the session\'s declared range', async () => {
      const session = await openSession();
      await expect(service.saveChunk(session.uploadId, -1, Buffer.from('x'))).rejects.toThrow(BadRequestException);
      await expect(service.saveChunk(session.uploadId, session.totalChunks, Buffer.from('x'))).rejects.toThrow(
        BadRequestException,
      );
      expect(fullStorage.uploadPart).not.toHaveBeenCalled();
    });

    it('refuses an empty chunk', async () => {
      const session = await openSession();
      await expect(service.saveChunk(session.uploadId, 0, Buffer.alloc(0))).rejects.toThrow(BadRequestException);
    });

    it('mints a presigned URL for one part, addressed to this exact session', async () => {
      const session = await openSession();
      const { presignedUrl, partNumber } = await service.getPresignedPartUrl(session.uploadId, 1);
      expect(partNumber).toBe(2); // 0-indexed 1 -> S3's 2
      expect(fullStorage.getSignedPartUploadUrl).toHaveBeenCalledWith(session.s3Key, session.s3UploadId, 2, 3600);
      expect(presignedUrl).toContain(session.s3Key);
    });

    it('assembles once every declared chunk has landed', async () => {
      const session = await openSession();
      const data = Buffer.from('x'.repeat(10));
      for (let i = 0; i < session.totalChunks; i++) await service.saveChunk(session.uploadId, i, data);

      const { s3Key } = await service.assemble(session.uploadId);
      expect(s3Key).toBe(session.s3Key);
      expect(fullStorage.completeMultipartUpload).toHaveBeenCalledWith(session.s3Key, session.s3UploadId);
    });

    it('refuses to assemble while chunks are missing, naming which ones', async () => {
      const session = await openSession();
      await service.saveChunk(session.uploadId, 0, Buffer.from('x'));
      // totalChunks is 3; chunks 1 and 2 were never sent.

      await expect(service.assemble(session.uploadId)).rejects.toThrow(/2 chunk\(s\) still missing \(1, 2\)/);
      expect(fullStorage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('discards a session and tells storage to abort, but tolerates storage refusing', async () => {
      const session = await openSession();
      await service.discard(session.uploadId);
      expect(fullStorage.abortMultipartUpload).toHaveBeenCalledWith(session.s3Key, session.s3UploadId);
      await expect(service.getSession(session.uploadId)).rejects.toThrow(NotFoundException);

      // A second discard on an already-gone session is a no-op, not an error.
      await expect(service.discard(session.uploadId)).resolves.toBeUndefined();
    });

    it('discarding still deletes the session even when the storage-side abort itself throws', async () => {
      const session = await openSession();
      fullStorage.abortMultipartUpload.mockRejectedValueOnce(new Error('storage unreachable'));
      await expect(service.discard(session.uploadId)).resolves.toBeUndefined();
      await expect(service.getSession(session.uploadId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('when the injected storage engine has no multipart support (e.g. STORAGE_DRIVER=local)', () => {
    it('refuses with a clear message rather than throwing "is not a function"', async () => {
      const bareService = await build({});
      await expect(
        bareService.createSession({ assessmentId: 'a1', fileName: 'x.pdf', fileSize: 1024, createdBy: 'u1' }),
      ).rejects.toThrow(/STORAGE_DRIVER=s3/);
    });
  });
});
