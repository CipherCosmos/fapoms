import { BadRequestException } from '@nestjs/common';
import { AssayerController } from './assayer.controller';

/**
 * `POST /assayers/roster/import` — the upload that starts a roster import or its rehearsal.
 *
 * Two failures pinned here, both of which put a real import in motion that nobody had confirmed:
 *
 *  1. **The rehearsal ran inside the upload request.** A rehearsal is the entire import inside a
 *     transaction that is rolled back — about seven minutes for the real 1,155-person roster,
 *     holding a pool connection and row locks, against a three-minute web timeout. It is now queued
 *     on the roster queue and polled, like the import.
 *  2. **The web's rehearsal was read as a real import.** The page sent `?dryRun=true` in the query
 *     string; this route read only the multipart body, so the "rehearsal" was queued as a real
 *     import with no confirmation and the overwrite choice dropped. A web bundle from before the
 *     fix still sends the query form.
 *
 * The controller is built without Nest's DI on purpose: the route touches two collaborators, and
 * this suite should not break each time the controller gains an unrelated constructor dependency.
 */
describe('AssayerController — roster import route', () => {
  const upload = { buffer: Buffer.from('xlsx'), originalname: 'roster.xlsx' };
  const req = { user: { id: 'u-1' } };

  const build = () => {
    const rosterImport = {
      inspectSheet: jest.fn().mockReturnValue({ sheetName: 'Assayer', rowsRead: 1155, headers: [] }),
      importAssayerSheet: jest.fn(),
    };
    const importJobService = {
      enqueueRosterImport: jest.fn().mockResolvedValue({ jobId: '7', state: 'waiting', totalRows: 1155 }),
    };
    const controller: AssayerController = Object.assign(
      Object.create(AssayerController.prototype),
      { rosterImport, importJobService },
    );
    const res = { status: jest.fn() };
    return { controller, rosterImport, importJobService, res };
  };

  it('queues a rehearsal instead of running the import inside the upload request', async () => {
    const { controller, rosterImport, importJobService, res } = build();

    const out: any = await controller.importRoster(upload, { dryRun: 'true' }, {}, req, res as any);

    expect(rosterImport.importAssayerSheet).not.toHaveBeenCalled();
    expect(importJobService.enqueueRosterImport).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, totalRows: 1155 }));
    expect(res.status).toHaveBeenCalledWith(202);
    expect(out).toMatchObject({ queued: true, dryRun: true, jobId: '7', statusUrl: '/assayers/roster/import-jobs/7' });
  });

  it('treats a rehearsal asked for in the query string as a rehearsal, never as a real import', async () => {
    const { controller, importJobService, res } = build();

    await controller.importRoster(upload, {}, { dryRun: 'true', overwrite: 'true' }, req, res as any);

    expect(importJobService.enqueueRosterImport).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, overwrite: true }),
    );
  });

  /** Multipart and query values are text: "false" is a non-empty string and must not read as true. */
  it('queues a real import that does not overwrite when the flags are absent or say anything but "true"', async () => {
    const { controller, importJobService, res } = build();

    await controller.importRoster(upload, { dryRun: 'false', overwrite: 'yes' }, {}, req, res as any);

    expect(importJobService.enqueueRosterImport).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false, overwrite: false }),
    );
  });

  /** Queuing must not cost the immediate 400 a wrong file used to get from the in-request rehearsal. */
  it('refuses an unreadable workbook before anything is queued', async () => {
    const { controller, rosterImport, importJobService, res } = build();
    rosterImport.inspectSheet.mockImplementation(() => {
      throw new BadRequestException('This does not look like the appraiser roster.');
    });

    await expect(controller.importRoster(upload, { dryRun: 'true' }, {}, req, res as any))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(importJobService.enqueueRosterImport).not.toHaveBeenCalled();
  });
});
