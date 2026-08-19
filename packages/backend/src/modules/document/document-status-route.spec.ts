import { BadRequestException } from '@nestjs/common';
import { DocumentStatus } from '@fapoms/shared';
import { DocumentController } from './document.controller';

/**
 * `PATCH /documents/:id/status` is the back-office end of the pipeline, not a way around it.
 *
 * Dispatching, receiving, delegating and sending to OCR are acts: each stamps who did it and
 * when, syncs the assessment, and — for a dispatch — notifies the assayer. Writing the status
 * directly skipped all of that, and since the assayer's view keys off DISPATCHED, it released
 * client paperwork to the field with no record of anyone having released it.
 */
describe('PATCH /documents/:id/status', () => {
  const updateStatus = jest.fn(async (_id: string, status: DocumentStatus) => ({ id: 'doc-1', status }));
  const controller = new DocumentController(
    { updateStatus } as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
  );
  const req = { user: { id: 'u-1' } };

  beforeEach(() => updateStatus.mockClear());

  it.each([
    [DocumentStatus.DISPATCHED, '/dispatch'],
    [DocumentStatus.RECEIVED, '/receive'],
    [DocumentStatus.SENT_TO_DATA_ENTRY, '/assign-data-entry'],
    [DocumentStatus.SENT_TO_EXTERNAL_OCR, '/send-external-ocr'],
  ])('refuses %s and names the route that records the hand-off', async (status, route) => {
    await expect(controller.updateStatus('doc-1', { status } as any, req))
      .rejects.toThrow(BadRequestException);
    await expect(controller.updateStatus('doc-1', { status } as any, req))
      .rejects.toThrow(new RegExp(route));

    // Nothing reached the service: the packet must not half-move.
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it.each([DocumentStatus.EXCEL_GENERATED, DocumentStatus.PROCESSED, DocumentStatus.COMPLETED, DocumentStatus.ARCHIVED])(
    'still sets %s, which no other route owns',
    async (status) => {
      await expect(controller.updateStatus('doc-1', { status } as any, req)).resolves.toBeTruthy();
      expect(updateStatus).toHaveBeenCalledWith('doc-1', status, 'u-1');
    },
  );
});
