import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  AttachmentUploader,
  attachmentGrantIsValid,
  issueAttachmentGrant,
  storageKeyFromIssuedUrl,
} from '../validation-query/attachment-grant';
import type { FeedbackActor } from './feedback-thread.service';

/** Exactly the prefix the upload route puts in front of an encoded storage key. */
export const FEEDBACK_ATTACHMENT_URL_PREFIX = '/api/v1/feedback/attachments/';

/** What a message stores for one file. The grant token is proof for the post, not data to keep. */
export interface StoredFeedbackAttachment {
  url: string;
  storageKey: string;
  fileName: string;
  fileType: string;
  size?: number;
}

export interface PostedFeedbackAttachment {
  url: string;
  fileName: string;
  fileType: string;
  storageKey?: string;
  size?: number;
  uploadToken?: string;
}

/** The feedback actor as an uploader identity — the same on the upload and the post. */
export function feedbackUploader(actor: FeedbackActor): AttachmentUploader {
  return actor.assayerId
    ? { kind: 'assayer', id: actor.assayerId }
    : { kind: 'user', id: actor.userId ?? '' };
}

/** Minted by the upload route, for the descriptor it returns. */
export function issueFeedbackUploadToken(actor: FeedbackActor, storageKey: string): string {
  return issueAttachmentGrant('feedback', feedbackUploader(actor), storageKey);
}

/**
 * The attachments a message may actually carry, or null for none.
 *
 * Every file must be one THIS poster uploaded through the feedback upload route: the key is read
 * out of the issued URL (a separately posted `storageKey` must agree with it, or the post is
 * refused), and the upload route's grant for that key and this poster must be present. Anything
 * else is somebody else's object, or never an upload at all, and would otherwise become readable
 * to the poster through the download route — which serves any key a readable message references.
 */
export function acceptFeedbackAttachments(
  posted: PostedFeedbackAttachment[] | undefined | null,
  actor: FeedbackActor,
): StoredFeedbackAttachment[] | null {
  const list = posted ?? [];
  if (!list.length) return null;
  const uploader = feedbackUploader(actor);

  return list.map((a) => {
    const key = storageKeyFromIssuedUrl(a?.url, FEEDBACK_ATTACHMENT_URL_PREFIX);
    if (!key) {
      throw new BadRequestException('An attachment must be a file uploaded through the feedback upload route.');
    }
    if (a.storageKey != null && a.storageKey !== key) {
      throw new BadRequestException('An attachment names two different files. Attach it again.');
    }
    if (!attachmentGrantIsValid('feedback', uploader, key, a.uploadToken)) {
      throw new ForbiddenException(
        'You can only attach files you uploaded yourself. Upload the file again and resend.',
      );
    }
    const stored: StoredFeedbackAttachment = {
      url: a.url,
      storageKey: key,
      fileName: a.fileName,
      fileType: a.fileType,
    };
    if (typeof a.size === 'number') stored.size = a.size;
    return stored;
  });
}
