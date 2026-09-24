import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PublicRegistrationController } from './public-registration.controller';

/**
 * The two doors the candidate's "Replace" and "Remove" buttons knock on.
 *
 * The web and mobile forms are coded against these exact paths and the `replace` query flag; a
 * renamed route or a flag read the wrong way sends every "Replace" back to appending.
 */
describe('the candidate replacing or removing a scan', () => {
  const file = { originalname: 'pan.png', buffer: Buffer.from('x'), mimetype: 'image/png', size: 1 };
  const make = () => {
    const service = {
      uploadDocument: jest.fn(async () => ({ id: 'doc-1', requirement: 'PAN_CARD', filePaths: ['k'] })),
      removeDocumentFile: jest.fn(async () => ({ id: 'doc-1', requirement: 'PAN_CARD', filePaths: [] })),
    };
    return { service, controller: new PublicRegistrationController(service as never) };
  };

  it('replaces only when asked with replace=true (or 1), and appends otherwise', async () => {
    for (const [flag, replace] of [['true', true], ['1', true], [undefined, false], ['false', false], ['yes', false]] as const) {
      const { service, controller } = make();
      await controller.uploadDocument('tok', 'PAN_CARD', file, flag);
      expect(service.uploadDocument).toHaveBeenCalledWith('tok', 'PAN_CARD', expect.any(Object), { replace });
    }
  });

  it('removes one file by index and answers the row as it now stands', async () => {
    const { service, controller } = make();
    await expect(controller.removeDocumentFile('tok', 'PAN_CARD', 2))
      .resolves.toEqual({ id: 'doc-1', requirement: 'PAN_CARD', filePaths: [] });
    expect(service.removeDocumentFile).toHaveBeenCalledWith('tok', 'PAN_CARD', 2);
  });

  it('is DELETE :token/documents/:requirement/file/:index — the path the forms call', () => {
    const handler = PublicRegistrationController.prototype.removeDocumentFile;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.DELETE);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':token/documents/:requirement/file/:index');
  });

  it('is throttled exactly like the upload it undoes', () => {
    const upload = PublicRegistrationController.prototype.uploadDocument;
    const remove = PublicRegistrationController.prototype.removeDocumentFile;
    const throttleOf = (fn: object) => Reflect.getMetadataKeys(fn)
      .filter((k) => typeof k === 'string' && k.startsWith('THROTTLER:'))
      .sort()
      .map((k) => [k, Reflect.getMetadata(k, fn)]);
    expect(throttleOf(upload).length).toBeGreaterThan(0);
    expect(throttleOf(remove)).toEqual(throttleOf(upload));
  });
});
