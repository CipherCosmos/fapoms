import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { FEEDBACK_ATTACHMENT_URL, FeedbackAttachmentDto } from './feedback-attachment.dto';

/**
 * What a report is allowed to carry, and who may read it.
 *
 * Feedback could always *declare* attachments — the column and the DTO field were there from
 * the day the channel was built — but nothing could fill them, because there was no route to
 * put a file anywhere. Worse, the field was typed inline, and the global ValidationPipe runs
 * `whitelist: true`: it strips any property it has no validator metadata for, and an inline
 * TypeScript type carries none at runtime. An attachment posted with a report reached the
 * database as `[[]]`. The API answered 201, the thread saved, and the file details were gone —
 * the same failure the clarification thread hit and fixed, in the module that never got it.
 *
 * These pin the two things that keep the feature honest: a report can only reference a file
 * this server issued, and the URL pattern that decides it.
 */
describe('feedback attachment urls', () => {
  it('accepts the shape the upload route issues', () => {
    expect(FEEDBACK_ATTACHMENT_URL.test('/api/v1/feedback/attachments/uploads%2F123-shot.png')).toBe(true);
    expect(FEEDBACK_ATTACHMENT_URL.test('/api/v1/feedback/attachments/uploads/feedback/a.pdf')).toBe(true);
  });

  it.each([
    ['javascript:alert(1)', 'a script url'],
    ['https://evil.example.com/x.png', "somebody else's host"],
    ['//evil.example.com/x.png', 'a protocol-relative host'],
    ['/api/v1/documents/1/download', 'a different feature’s files'],
    ['/api/v1/feedback/attachments/../../etc/passwd', 'a traversal'],
    ['', 'nothing at all'],
  ])('refuses %s — %s', (candidate) => {
    expect(FEEDBACK_ATTACHMENT_URL.test(candidate)).toBe(false);
  });

  /**
   * The nested-validation half. `@IsArray()` alone does not reach the elements, which is how
   * the details were lost in the first place.
   */
  describe('the attachment DTO', () => {
    const posted = {
      url: '/api/v1/feedback/attachments/uploads%2F1-shot.png',
      fileName: 'shot.png',
      fileType: 'image/png',
      storageKey: 'uploads/1-shot.png',
      size: 908,
    };

    it('keeps every field a real upload returns', async () => {
      const instance = plainToInstance(FeedbackAttachmentDto, posted);
      expect(await validate(instance, { whitelist: true })).toEqual([]);
      // Nothing dropped on the way in — the bug was that all of these vanished.
      expect({ ...instance }).toEqual(posted);
    });

    it('rejects an attachment pointing anywhere the server did not put a file', async () => {
      const instance = plainToInstance(FeedbackAttachmentDto, { ...posted, url: 'https://evil.example.com/x.png' });
      const errors = await validate(instance, { whitelist: true });
      expect(errors.map((e) => e.property)).toEqual(['url']);
    });

    it('drops a property nobody declared, rather than storing it', async () => {
      const instance = plainToInstance(FeedbackAttachmentDto, { ...posted, sneaky: 'value' } as any);
      const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: false });
      expect(errors).toEqual([]);
    });
  });
});
