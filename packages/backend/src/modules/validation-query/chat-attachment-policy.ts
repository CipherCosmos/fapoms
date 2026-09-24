import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SystemRole } from '@fapoms/shared';
import {
  AttachmentUploader,
  attachmentGrantIsValid,
  issueAttachmentGrant,
  storageKeyFromIssuedUrl,
} from './attachment-grant';

/** Exactly the prefix the clarification upload routes put in front of an encoded storage key. */
export const CHAT_ATTACHMENT_URL_PREFIX = '/api/v1/validation-queries/attachment/';

/** What a clarification message stores for one file. The grant is proof for the post, not data. */
export interface StoredChatAttachment {
  url: string;
  s3Key: string;
  fileName: string;
  fileType: string;
  size?: number;
  uploadedBy?: string;
  timestamp?: string;
}

export interface AcceptedChatReferences {
  attachments: StoredChatAttachment[] | null;
  snapshotPath: string | null;
  voiceNote: { url: string; durationSeconds: number; mimeType?: string } | null;
}

/**
 * The caller as an uploader. An assayer token carries exactly the synthetic ['ASSAYER'] role; the
 * same test decides the identity on the upload and on the post, so the two always agree.
 */
export function chatUploader(req: any): AttachmentUploader {
  const roles: string[] = (req?.user?.roles ?? []).map((r: any) => r?.name ?? r).filter(Boolean);
  const isAssayer = roles.length === 1 && roles[0] === SystemRole.ASSAYER;
  return { kind: isAssayer ? 'assayer' : 'user', id: String(req?.user?.id ?? '') };
}

/** Minted by the upload routes, for the descriptor they return. */
export function issueChatUploadToken(uploader: AttachmentUploader, storageKey: string): string {
  return issueAttachmentGrant('clarification', uploader, storageKey);
}

/** The key an issued URL names, after checking the poster was granted it — or a refusal. */
function grantedKey(url: unknown, token: unknown, uploader: AttachmentUploader, what: string): string {
  const key = storageKeyFromIssuedUrl(url, CHAT_ATTACHMENT_URL_PREFIX);
  if (!key) {
    throw new BadRequestException(`${what} must be a file uploaded through the clarification upload route.`);
  }
  if (!attachmentGrantIsValid('clarification', uploader, key, token)) {
    throw new ForbiddenException(
      'You can only attach files you uploaded yourself. Upload the file again and resend.',
    );
  }
  return key;
}

/**
 * Every storage key a clarification message may reference, checked against its poster.
 *
 * `attachments[]`: each must carry an issued URL and the upload route's grant for that key and
 * this poster; the stored `s3Key` is read out of the URL, and a posted `s3Key` that disagrees is
 * refused. Entries with no URL at all are dropped, as the services always did.
 *
 * `snapshotPath` (legacy crops): accepted only when it names one of this same message's granted
 * attachments — no current client sends one, and a bare key has no grant to check.
 *
 * `voiceNote`: its URL must be an issued one with a grant in `voiceNote.uploadToken`.
 */
export function acceptChatAttachments(
  posted: unknown,
  uploader: AttachmentUploader,
  extra: { snapshotPath?: string | null; voiceNote?: any } = {},
): AcceptedChatReferences {
  const raw = Array.isArray(posted) ? (posted as unknown[]).flat(Infinity) : [];
  const list = raw.filter((a: any) => a && a.url) as any[];

  const attachments = list.map((a): StoredChatAttachment => {
    const key = grantedKey(a.url, a.uploadToken, uploader, 'An attachment');
    if (a.s3Key != null && a.s3Key !== key) {
      throw new BadRequestException('An attachment names two different files. Attach it again.');
    }
    const stored: StoredChatAttachment = {
      url: a.url,
      s3Key: key,
      fileName: String(a.fileName ?? ''),
      fileType: String(a.fileType ?? ''),
    };
    if (typeof a.size === 'number') stored.size = a.size;
    if (typeof a.uploadedBy === 'string') stored.uploadedBy = a.uploadedBy;
    if (typeof a.timestamp === 'string') stored.timestamp = a.timestamp;
    return stored;
  });

  let snapshotPath: string | null = null;
  if (extra.snapshotPath) {
    const s = extra.snapshotPath;
    const key = storageKeyFromIssuedUrl(s, CHAT_ATTACHMENT_URL_PREFIX) ?? s;
    if (!attachments.some((a) => a.s3Key === key)) {
      throw new ForbiddenException(
        'A marked snapshot must be one of the files attached to the same message.',
      );
    }
    snapshotPath = s;
  }

  let voiceNote: AcceptedChatReferences['voiceNote'] = null;
  if (extra.voiceNote != null) {
    const v = extra.voiceNote;
    grantedKey(v?.url, v?.uploadToken, uploader, 'A voice note');
    voiceNote = { url: v.url, durationSeconds: Number(v.durationSeconds) || 0 };
    if (typeof v.mimeType === 'string') voiceNote.mimeType = v.mimeType;
  }

  return { attachments: attachments.length ? attachments : null, snapshotPath, voiceNote };
}
