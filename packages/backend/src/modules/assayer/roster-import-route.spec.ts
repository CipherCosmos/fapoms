import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AssayerController, rosterImportParams } from './assayer.controller';

/**
 * `POST /assayers/roster/import` — the upload that starts a roster rehearsal or import.
 *
 * It answers at once with a background job (`ROSTER_IMPORT`) and does none of the work: the file is
 * handed to `BackgroundJobsService.create`, which stores it, records the job and queues it. Pinned
 * here too, because each put a real import in motion that nobody had confirmed:
 *
 *  - **The web's rehearsal was read as a real import.** An old page sent `?dryRun=true` in the query
 *    string while this route read only the multipart body. The query form, the old multipart
 *    fields and the new `params` JSON are all honoured, and "false" (a non-empty string) never
 *    reads as true.
 *
 * The controller is built without Nest's DI on purpose: the route touches one collaborator, and
 * this suite should not break each time the controller gains an unrelated constructor dependency.
 */
describe('AssayerController — roster import route', () => {
  const upload = { path: '/tmp/fapoms-upload-batches/abc', originalname: 'roster.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 2048 };
  const req = { user: { id: 'u-1', roles: [{ name: 'OPERATIONS' }], regions: ['NORTH'], organizationId: 'org-1' } };
  const ACCEPTED = { job: { id: 'job-1', kind: 'ROSTER_IMPORT', status: 'QUEUED' }, deduplicated: false };

  const build = () => {
    const backgroundJobs = { create: jest.fn().mockResolvedValue(ACCEPTED) };
    const controller: AssayerController = Object.assign(
      Object.create(AssayerController.prototype),
      { backgroundJobs },
    );
    return { controller, backgroundJobs };
  };

  it('answers with the accepted job and hands the file ON DISK to the foundation — no work in the request', async () => {
    const { controller, backgroundJobs } = build();

    const out = await controller.importRoster(upload, { params: JSON.stringify({ dryRun: true, overwrite: false }) }, {}, req);

    expect(out).toBe(ACCEPTED);
    expect(backgroundJobs.create).toHaveBeenCalledTimes(1);
    const [request] = backgroundJobs.create.mock.calls[0];
    expect(request).toMatchObject({
      kind: 'ROSTER_IMPORT',
      scope: { type: 'ROSTER', id: null },
      params: { dryRun: true, overwrite: false, sheetName: null },
      actor: expect.objectContaining({ userId: 'u-1' }),
      regions: ['NORTH'],
      file: { path: upload.path, originalName: 'roster.xlsx', size: 2048 },
    });
    // Streamed from its temp file, never read into memory here.
    expect(request.file.buffer).toBeUndefined();
  });

  it('is declared 202 and is scanned by the disk-upload interceptor', () => {
    const source = readFileSync(join(__dirname, 'assayer.controller.ts'), 'utf8');
    const start = source.indexOf("@Post('/roster/import')");
    const decorators = source.slice(start, source.indexOf('async importRoster(', start));
    expect(decorators).toMatch(/@HttpCode\(202\)/);
    expect(decorators).toMatch(/@Roles\(SystemRole\.ADMIN, SystemRole\.OPERATIONS\)/);
    expect(decorators).toMatch(/@RequirePermissions\('assayer:create:organization'\)/);
    expect(decorators).toMatch(/FileInterceptor\('file', rosterImportMulterOptions\), DiskUploadScanInterceptor/);
    expect(source).toMatch(/rosterImportMulterOptions = diskUploadMulterOptions\(/);
  });

  it('treats a rehearsal asked for in the query string as a rehearsal, never as a real import', async () => {
    const { controller, backgroundJobs } = build();

    await controller.importRoster(upload, {}, { dryRun: 'true', overwrite: 'true' }, req);

    expect(backgroundJobs.create.mock.calls[0][0].params).toEqual({ dryRun: true, overwrite: true, sheetName: null });
  });

  it('still honours the old multipart fields', async () => {
    const { controller, backgroundJobs } = build();

    await controller.importRoster(upload, { dryRun: 'true', sheetName: ' Assayer ' }, {}, req);

    expect(backgroundJobs.create.mock.calls[0][0].params).toEqual({ dryRun: true, overwrite: false, sheetName: 'Assayer' });
  });

  /** Multipart and query values are text: "false" is a non-empty string and must not read as true. */
  it('starts a real import that does not overwrite when the flags are absent or say anything but "true"', async () => {
    const { controller, backgroundJobs } = build();

    await controller.importRoster(upload, { dryRun: 'false', overwrite: 'yes' }, {}, req);

    expect(backgroundJobs.create.mock.calls[0][0].params).toEqual({ dryRun: false, overwrite: false, sheetName: null });
  });

  it('refuses a request with no file before anything is started', async () => {
    const { controller, backgroundJobs } = build();

    await expect(controller.importRoster(undefined, {}, {}, req)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.importRoster({ ...upload, size: 0 }, {}, {}, req)).rejects.toBeInstanceOf(BadRequestException);
    expect(backgroundJobs.create).not.toHaveBeenCalled();
  });

  it('refuses params that are not a JSON object', () => {
    expect(() => rosterImportParams({ params: '[1,2]' }, {})).toThrow(BadRequestException);
    expect(() => rosterImportParams({ params: '{nope' }, {})).toThrow(BadRequestException);
  });

  /**
   * The wrong file is refused by the job's `prepare` inside `create`, before anything is stored —
   * the route passes that 400 straight through rather than answering 202 over it.
   */
  it('passes a wrong-file refusal from the job straight back to the person', async () => {
    const { controller, backgroundJobs } = build();
    backgroundJobs.create.mockRejectedValue(new BadRequestException('This does not look like the appraiser roster.'));

    await expect(controller.importRoster(upload, {}, {}, req)).rejects.toThrow('This does not look like the appraiser roster.');
  });
});
