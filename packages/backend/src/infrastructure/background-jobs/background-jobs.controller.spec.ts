import { ForbiddenException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BackgroundJobsController, readerFrom } from './background-jobs.controller';

/**
 * The `/jobs` routes: who they read as, and that the generic upload door asks the kind before it
 * stores anything.
 */
describe('BackgroundJobsController', () => {
  const user = {
    id: 'u-1',
    roles: [{ name: 'OPERATIONS', permissions: [] }],
    regions: ['NORTH'],
    organizationId: 'org-1',
  };

  it('reads as the live principal: id, every role name, assigned regions, organisation', () => {
    expect(readerFrom({ user })).toEqual({ userId: 'u-1', roleNames: ['OPERATIONS'], regions: ['NORTH'], organizationId: 'org-1' });
    expect(readerFrom({ user: { ...user, regions: [] } }).regions).toBeNull();
  });

  const jobs = () => ({
    assertMayStart: jest.fn(),
    create: jest.fn(async () => ({ job: { id: 'j-1' }, deduplicated: false })),
    list: jest.fn(async () => ({ active: [], recent: [] })),
  });

  it('refuses a start the caller may not make before anything is stored or queued', async () => {
    const service = jobs();
    service.assertMayStart.mockImplementation(() => { throw new ForbiddenException('Insufficient permissions'); });
    const controller = new BackgroundJobsController(service as any);
    await expect(controller.start({ user }, { kind: 'BRANCH_IMPORT' } as any, undefined)).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('hands a disk-backed upload over by path, never as a buffer, with the caller\'s regions', async () => {
    const service = jobs();
    const controller = new BackgroundJobsController(service as any);
    await controller.start(
      { user },
      { kind: 'BRANCH_IMPORT', scopeType: 'CLIENT', scopeId: 'c-1', params: '{"overwrite":true}' } as any,
      { path: '/tmp/abc', originalname: 'sbi.xlsx', mimetype: 'application/vnd.ms-excel', size: 10, buffer: undefined } as any,
    );
    expect(service.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'BRANCH_IMPORT',
      regions: ['NORTH'],
      scope: { type: 'CLIENT', id: 'c-1' },
      params: { overwrite: true },
      file: expect.objectContaining({ path: '/tmp/abc', buffer: undefined, originalName: 'sbi.xlsx' }),
    }));
  });

  it('refuses params that are not a JSON object', async () => {
    const controller = new BackgroundJobsController(jobs() as any);
    await expect(controller.start({ user }, { kind: 'BRANCH_IMPORT', params: '[1,2]' } as any)).rejects.toThrow(/JSON object/);
    await expect(controller.start({ user }, { kind: 'BRANCH_IMPORT', params: 'nope' } as any)).rejects.toThrow(/JSON object/);
  });

  it('lists active and recent by default', async () => {
    const service = jobs();
    await new BackgroundJobsController(service as any).list({ user });
    expect(service.list).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ include: ['active', 'recent'], all: false }));
  });

  /**
   * The upload route writes to disk (a 50 MB sheet is not held in the API's memory) and so must be
   * scanned by the interceptor that can read a disk-backed file — `FileScanInterceptor` would have
   * failed closed on it. Comments stripped so prose cannot satisfy the check.
   */
  it('stores uploads on disk and scans them with the disk-aware interceptor', () => {
    const source = readFileSync(join(__dirname, 'background-jobs.controller.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(source).toMatch(/diskUploadMulterOptions\(/);
    expect(source).toMatch(/UseInterceptors\(FileInterceptor\('file', jobUploadMulterOptions\), DiskUploadScanInterceptor\)/);
  });
});
