import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { FeedbackStatus } from '@fapoms/shared';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { FeedbackThreadService, FeedbackActor } from './feedback-thread.service';
import { acceptFeedbackAttachments, FEEDBACK_ATTACHMENT_URL_PREFIX } from './feedback-attachment-policy';
import { issueAttachmentGrant } from '../validation-query/attachment-grant';

/**
 * A feedback message may only carry files its poster uploaded.
 *
 * The reply and create routes used to store whatever `storageKey` the client posted, and the
 * download route serves any key a message on a readable thread references. Every object in the
 * bucket shares one key namespace — ID scans, passbooks, audit packets — so any signed-in account
 * could file a report naming somebody else's key and then download it from its own thread.
 *
 * The upload route now returns an `uploadToken` bound to (uploader, key); create and reply
 * refuse any attachment without a matching one, and read the key out of the issued URL rather
 * than trusting a separate field.
 */
describe('feedback attachments are bound to their uploader', () => {
  const OLD_ENV = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-feedback-grants'; });
  afterAll(() => { process.env.JWT_SECRET = OLD_ENV; });

  const alice: FeedbackActor = { userId: 'user-alice', assayerId: null, name: 'Alice', isTeam: false };
  const mallory: FeedbackActor = { userId: 'user-mallory', assayerId: null, name: 'Mallory', isTeam: false };
  const aliceAsAssayer: FeedbackActor = { userId: null, assayerId: 'user-alice', name: 'Alice', isTeam: false };

  /** Stand in for the upload route: store a file for `actor` and return its descriptor. */
  async function uploadAs(actor: FeedbackActor, key: string) {
    const storage = { saveFile: jest.fn().mockResolvedValue(key) };
    const controller = new FeedbackController({} as any, {} as any, {} as any, storage as any);
    const req = actor.assayerId
      ? { user: { id: actor.assayerId, roles: ['ASSAYER'] } }
      : { user: { id: actor.userId, roles: ['DESK'] } };
    const [descriptor] = await controller.uploadAttachments(
      [{ originalname: 'shot.png', mimetype: 'image/png', size: 1200, buffer: Buffer.from('x') } as any],
      req,
    );
    return descriptor;
  }

  describe('acceptFeedbackAttachments', () => {
    it('accepts a file the poster uploaded, and stores the key the URL names without the token', async () => {
      const d = await uploadAs(alice, 'uploads/2026/09/aaa.png');
      expect(d.uploadToken).toEqual(expect.any(String));
      const stored = acceptFeedbackAttachments([d], alice)!;
      expect(stored).toEqual([{
        url: `${FEEDBACK_ATTACHMENT_URL_PREFIX}${encodeURIComponent('uploads/2026/09/aaa.png')}`,
        storageKey: 'uploads/2026/09/aaa.png',
        fileName: 'shot.png',
        fileType: 'image/png',
        size: 1200,
      }]);
      expect(stored[0]).not.toHaveProperty('uploadToken');
    });

    it("refuses another person's upload, even with its genuine token", async () => {
      const d = await uploadAs(alice, 'uploads/2026/09/aaa.png');
      expect(() => acceptFeedbackAttachments([d], mallory)).toThrow(ForbiddenException);
    });

    it('refuses a key with no token at all — the attack as it used to be written', () => {
      const victim = 'uploads/2026/09/victim-aadhaar.pdf';
      expect(() => acceptFeedbackAttachments([{
        url: `${FEEDBACK_ATTACHMENT_URL_PREFIX}${encodeURIComponent(victim)}`,
        storageKey: victim, fileName: 'a.pdf', fileType: 'application/pdf',
      }], mallory)).toThrow(ForbiddenException);
    });

    it('refuses a url and storageKey that name different files (url is the truth)', async () => {
      const d = await uploadAs(mallory, 'uploads/2026/09/mine.png');
      expect(() => acceptFeedbackAttachments([{ ...d, storageKey: 'uploads/2026/09/victim.pdf' }], mallory))
        .toThrow(BadRequestException);
    });

    it('refuses a url the upload route never issues', async () => {
      const d = await uploadAs(mallory, 'uploads/2026/09/mine.png');
      for (const url of [
        '/api/v1/feedback/attachments/uploads/2026/09/mine.png', // unencoded: not the issued shape
        '/api/v1/documents/1/download',
        `${FEEDBACK_ATTACHMENT_URL_PREFIX}${encodeURIComponent('uploads/../secret.pdf')}`,
      ]) {
        expect(() => acceptFeedbackAttachments([{ ...d, url }], mallory)).toThrow(BadRequestException);
      }
    });

    it('does not let a user token stand in for an assayer with the same id', async () => {
      const d = await uploadAs(alice, 'uploads/2026/09/aaa.png');
      expect(() => acceptFeedbackAttachments([d], aliceAsAssayer)).toThrow(ForbiddenException);
    });

    it('does not accept a grant minted for the clarification chat', () => {
      const key = 'uploads/2026/09/chat.png';
      const token = issueAttachmentGrant('clarification', { kind: 'user', id: 'user-mallory' }, key);
      expect(() => acceptFeedbackAttachments([{
        url: `${FEEDBACK_ATTACHMENT_URL_PREFIX}${encodeURIComponent(key)}`,
        fileName: 'c.png', fileType: 'image/png', uploadToken: token,
      }], mallory)).toThrow(ForbiddenException);
    });
  });

  describe('the two write paths refuse before anything is saved', () => {
    const forged = () => {
      const victim = 'uploads/2026/09/victim.pdf';
      return [{
        url: `${FEEDBACK_ATTACHMENT_URL_PREFIX}${encodeURIComponent(victim)}`,
        storageKey: victim, fileName: 'v.pdf', fileType: 'application/pdf', uploadToken: 'forged',
      }];
    };

    it('reply: FeedbackThreadService.postMessage', async () => {
      const threadRepo = {
        findOne: jest.fn().mockResolvedValue({ id: 't-1', reporterUserId: 'user-mallory', status: FeedbackStatus.OPEN }),
        save: jest.fn(),
      };
      const messageRepo = { create: jest.fn((x: any) => x), save: jest.fn(async (m: any) => ({ ...m, id: 'm-1' })) };
      const svc = new FeedbackThreadService(threadRepo as any, messageRepo as any, { emitSafe: jest.fn() } as any, { publish: jest.fn() } as any);

      await expect(svc.postMessage('t-1', mallory, { body: 'look', attachments: forged() })).rejects.toThrow(ForbiddenException);
      expect(messageRepo.save).not.toHaveBeenCalled();

      // And the legitimate path still works end to end.
      const own = await uploadAs(mallory, 'uploads/2026/09/mine.png');
      await svc.postMessage('t-1', mallory, { body: 'mine', attachments: [own] });
      expect(messageRepo.save).toHaveBeenCalledTimes(1);
      expect(messageRepo.create.mock.calls[0][0].attachments[0].storageKey).toBe('uploads/2026/09/mine.png');
    });

    it('create: FeedbackService.create', async () => {
      const threadRepo = { create: jest.fn((x: any) => x), save: jest.fn() };
      const svc = new FeedbackService(
        threadRepo as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
        { classify: jest.fn() } as any,
      );
      await expect(svc.create({ body: 'broken', attachments: forged() }, mallory)).rejects.toThrow(ForbiddenException);
      expect(threadRepo.save).not.toHaveBeenCalled();
    });
  });
});
