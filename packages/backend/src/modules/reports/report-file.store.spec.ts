import { Test, TestingModule } from '@nestjs/testing';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis-client.module';
import { ReportFileStore, ReportTooLargeError } from './report-file.store';
import { MAX_EXPORT_BYTES, REPORT_RESULT_TTL_SECONDS } from './report-jobs.contract';

describe('ReportFileStore', () => {
  let store: ReportFileStore;

  const redis = {
    set: jest.fn(),
    getBuffer: jest.fn(),
    pttl: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ReportFileStore, { provide: REDIS_CLIENT, useValue: redis }],
    }).compile();

    store = module.get(ReportFileStore);
    jest.clearAllMocks();
  });

  describe('put', () => {
    it('always writes with an expiry', async () => {
      // The TTL is the whole safety story: this is the same Redis that backs the socket adapter,
      // the RBAC cache and the throttler, and unlike Bull's age-based retention (which only
      // prunes when later jobs complete) an EX is enforced whether or not anything else happens.
      const buffer = Buffer.from('PK');
      await store.put('11', buffer);

      expect(redis.set).toHaveBeenCalledWith('report-export:11', buffer, 'EX', REPORT_RESULT_TTL_SECONDS);
    });

    it('namespaces its keys', async () => {
      await store.put('11', Buffer.from('x'));
      expect(redis.set.mock.calls[0][0]).toMatch(/^report-export:/);
    });

    it('writes the buffer as binary rather than a string', async () => {
      // The default client decodes replies as UTF-8, which corrupts every byte of a zip
      // container that is not valid UTF-8 — the file downloads and Excel refuses to open it.
      await store.put('11', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]));
      expect(Buffer.isBuffer(redis.set.mock.calls[0][1])).toBe(true);
    });

    it('refuses an oversized workbook instead of storing part of it', async () => {
      // Half a spreadsheet that opens and shows wrong totals is a worse outcome than an error
      // naming the filter to narrow.
      const tooBig = Buffer.alloc(MAX_EXPORT_BYTES + 1);

      await expect(store.put('11', tooBig)).rejects.toBeInstanceOf(ReportTooLargeError);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('tells the operator what to do about an oversized workbook', async () => {
      await expect(store.put('11', Buffer.alloc(MAX_EXPORT_BYTES + 1))).rejects.toThrow(/Narrow the filter/);
    });

    it('accepts a workbook exactly at the ceiling', async () => {
      await expect(store.put('11', Buffer.alloc(MAX_EXPORT_BYTES))).resolves.toBeUndefined();
    });
  });

  describe('get', () => {
    it('reads the raw bytes back', async () => {
      redis.getBuffer.mockResolvedValue(Buffer.from('PK'));
      await expect(store.get('11')).resolves.toEqual(Buffer.from('PK'));
      expect(redis.getBuffer).toHaveBeenCalledWith('report-export:11');
    });

    it('reports an expired file as absent rather than as an error', async () => {
      redis.getBuffer.mockResolvedValue(null);
      await expect(store.get('11')).resolves.toBeNull();
    });
  });

  describe('secondsRemaining', () => {
    it('converts the millisecond TTL Redis reports into whole seconds', async () => {
      redis.pttl.mockResolvedValue(880_400);
      await expect(store.secondsRemaining('11')).resolves.toBe(881);
    });

    it('reports a missing key as no time remaining', async () => {
      redis.pttl.mockResolvedValue(-2); // Redis: no such key
      await expect(store.secondsRemaining('11')).resolves.toBeNull();
    });

    it('treats a key with no expiry as absent rather than as eternal', async () => {
      // -1 means the EX was lost. Reporting "available forever" would be the one wrong answer:
      // these keys are only ever written with an expiry, so its absence is a fault, not a grant.
      redis.pttl.mockResolvedValue(-1);
      await expect(store.secondsRemaining('11')).resolves.toBeNull();
    });
  });
});
