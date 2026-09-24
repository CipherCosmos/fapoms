import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SystemRole } from '@fapoms/shared';
import { ValidationQueryController } from './validation-query.controller';
import { CHAT_ATTACHMENT_URL_PREFIX } from './chat-attachment-policy';
import { issueAttachmentGrant } from './attachment-grant';

/**
 * A clarification message may only reference files its poster uploaded.
 *
 * `attachments[].s3Key`, `snapshotPath` and a voice note's url were stored as posted.
 * `GET attachment-token?key=` then signs a download for any key a message references, and
 * `listMessages` signs every `snapshotPath` it returns — so naming somebody else's storage key on
 * a message was enough to download it. Every object in the bucket shares one key namespace, so
 * "somebody else's key" included ID scans and audit packets, not just chat files.
 *
 * The upload routes now return an `uploadToken` bound to (uploader, key); the three write paths
 * (post a message, respond, raise) refuse anything without a matching one.
 */
describe('clarification attachments are bound to their uploader', () => {
  const OLD_ENV = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-chat-grants'; });
  afterAll(() => { process.env.JWT_SECRET = OLD_ENV; });

  const assayer = (id = 'assayer-1') => ({ user: { id, roles: [SystemRole.ASSAYER] } });
  const desk = (id = 'desk-1') => ({ user: { id, roles: [SystemRole.DESK] } });

  let service: any;
  let thread: any;
  let storage: any;
  let controller: ValidationQueryController;

  beforeEach(() => {
    service = {
      respondToQuery: jest.fn().mockResolvedValue({ id: 'q-1' }),
      createQuery: jest.fn().mockResolvedValue({ id: 'q-1' }),
      ownerAssayerId: jest.fn().mockResolvedValue('assayer-1'),
    };
    thread = { postMessage: jest.fn().mockResolvedValue({ id: 'm-1' }) };
    storage = { saveFile: jest.fn() };
    controller = new ValidationQueryController(service, thread, storage, {} as any, { assertRegionAllowedStaged: jest.fn() } as any);
  });

  const file = (name = 'p.pdf') => ({ originalname: name, mimetype: 'application/pdf', size: 900, buffer: Buffer.from('%PDF') }) as any;

  async function uploadAs(req: any, key: string) {
    storage.saveFile.mockResolvedValueOnce(key);
    const [d] = await controller.uploadAttachments([file()], req);
    return d;
  }

  const forgedFor = (key: string, extra: Record<string, unknown> = {}) => ({
    url: `${CHAT_ATTACHMENT_URL_PREFIX}${encodeURIComponent(key)}`,
    s3Key: key, fileName: 'x.pdf', fileType: 'application/pdf', ...extra,
  });

  describe('POST :id/messages', () => {
    it('accepts the poster’s own upload, stores the key its URL names, and drops the token', async () => {
      const d = await uploadAs(assayer(), 'uploads/2026/09/own.pdf');
      expect(d.uploadToken).toEqual(expect.any(String));
      await controller.postMessage('q-1', { body: 'here', attachments: [d] } as any, assayer());
      const posted = thread.postMessage.mock.calls[0][4];
      expect(posted.attachments).toHaveLength(1);
      expect(posted.attachments[0].s3Key).toBe('uploads/2026/09/own.pdf');
      expect(posted.attachments[0]).not.toHaveProperty('uploadToken');
    });

    it('upload-single issues a working grant too', async () => {
      storage.saveFile.mockResolvedValueOnce('uploads/2026/09/single.pdf');
      const d = await controller.uploadSingleAttachment(file(), desk());
      await controller.postMessage('q-1', { attachments: [d] } as any, desk());
      expect(thread.postMessage).toHaveBeenCalledTimes(1);
    });

    it('refuses a key with no grant — the attack as it used to be written', async () => {
      await expect(controller.postMessage('q-1', { attachments: [forgedFor('uploads/2026/09/victim.pdf')] } as any, assayer()))
        .rejects.toThrow(ForbiddenException);
      expect(thread.postMessage).not.toHaveBeenCalled();
    });

    it("refuses somebody else's upload, even with its genuine grant", async () => {
      const d = await uploadAs(desk(), 'uploads/2026/09/desk-file.pdf');
      await expect(controller.postMessage('q-1', { attachments: [d] } as any, assayer()))
        .rejects.toThrow(ForbiddenException);
      const d2 = await uploadAs(assayer('assayer-2'), 'uploads/2026/09/other.pdf');
      await expect(controller.postMessage('q-1', { attachments: [d2] } as any, assayer('assayer-1')))
        .rejects.toThrow(ForbiddenException);
      expect(thread.postMessage).not.toHaveBeenCalled();
    });

    it('refuses an s3Key that disagrees with the URL (the URL is the truth)', async () => {
      const d = await uploadAs(assayer(), 'uploads/2026/09/own.pdf');
      await expect(controller.postMessage('q-1', { attachments: [{ ...d, s3Key: 'uploads/2026/09/victim.pdf' }] } as any, assayer()))
        .rejects.toThrow(BadRequestException);
    });

    it('refuses a grant minted for the feedback channel', async () => {
      const key = 'uploads/2026/09/fb.png';
      const token = issueAttachmentGrant('feedback', { kind: 'assayer', id: 'assayer-1' }, key);
      await expect(controller.postMessage('q-1', { attachments: [forgedFor(key, { uploadToken: token })] } as any, assayer()))
        .rejects.toThrow(ForbiddenException);
    });

    it('refuses a snapshotPath that is not one of the same message’s granted files', async () => {
      await expect(controller.postMessage('q-1', { body: 'x', snapshotPath: 'uploads/2026/09/victim.pdf' } as any, desk()))
        .rejects.toThrow(ForbiddenException);
      expect(thread.postMessage).not.toHaveBeenCalled();

      const d = await uploadAs(desk(), 'uploads/2026/09/crop.png');
      await controller.postMessage('q-1', { attachments: [d], snapshotPath: d.url } as any, desk());
      expect(thread.postMessage.mock.calls[0][4].snapshotPath).toBe(d.url);
    });

    it('refuses a voice note without a grant for its file', async () => {
      await expect(controller.postMessage('q-1', {
        voiceNote: { url: `${CHAT_ATTACHMENT_URL_PREFIX}${encodeURIComponent('uploads/2026/09/victim.m4a')}`, durationSeconds: 3 },
      } as any, assayer())).rejects.toThrow(ForbiddenException);
    });
  });

  describe('POST :id/respond and POST / (raise)', () => {
    it('respond refuses a forged key before recording the answer', async () => {
      await expect(controller.respondToQuery('q-1', { response: 'ok', attachments: [forgedFor('uploads/2026/09/victim.pdf')] } as any, desk()))
        .rejects.toThrow(ForbiddenException);
      expect(service.respondToQuery).not.toHaveBeenCalled();
    });

    it('respond passes the poster’s own file through', async () => {
      const d = await uploadAs(assayer(), 'uploads/2026/09/answer.pdf');
      await controller.respondToQuery('q-1', { response: 'ok', attachments: [[d]] } as any, assayer());
      const attachments = service.respondToQuery.mock.calls[0][3];
      expect(attachments.map((a: any) => a.s3Key)).toEqual(['uploads/2026/09/answer.pdf']);
    });

    it('raise refuses a forged key, even nested', async () => {
      await expect(controller.createQuery({
        validationCaseId: 'vc-1', queryText: 'q', attachments: [[forgedFor('uploads/2026/09/victim.pdf')]],
      } as any, desk())).rejects.toThrow(ForbiddenException);
      expect(service.createQuery).not.toHaveBeenCalled();
    });
  });
});
