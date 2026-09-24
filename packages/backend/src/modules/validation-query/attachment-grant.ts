import { createHmac } from 'crypto';
import { constantTimeEqual } from '../../infrastructure/security/token-utils';

/**
 * PROOF THAT THIS PERSON UPLOADED THIS FILE, HERE.
 *
 * Two chat channels — feedback threads and clarification threads — take a file in two steps:
 * an upload route stores it and answers with a descriptor, and the client posts that descriptor
 * back on a message. The message route used to believe whatever storage key the descriptor
 * named. Every object in the bucket lives in one flat `uploads/YYYY/MM/<uuid>` namespace (see
 * `object-key.ts`) — Aadhaar scans, bank passbooks, audit packets — so anybody who could post a
 * message could name somebody else's key on it, and the download route, which serves any key a
 * readable message references, then handed that file to them.
 *
 * The descriptor now carries `uploadToken`: an HMAC over (channel, uploader, key). The upload
 * route mints it; the message route recomputes it and refuses a key the poster was not issued
 * on that channel. Nothing is stored — the check is pure recomputation — and there is no
 * expiry, because the mobile app queues replies offline and must still be able to send a file
 * it uploaded hours earlier. Binding to the uploader is what makes that safe: a token is worth
 * nothing to anyone else, and "attach my own file to a thread I can post in" is the permitted act.
 *
 * Keyed off the same server secret the document download tokens use, never a hardcoded default.
 */

export type AttachmentChannel = 'feedback' | 'clarification';

/** Who uploaded: the two identity spaces share nothing, so the kind is part of the identity. */
export interface AttachmentUploader {
  kind: 'user' | 'assayer';
  id: string;
}

function channelKey(channel: AttachmentChannel): Buffer {
  const secret = process.env.DOCUMENT_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('Cannot sign attachment grants: neither DOCUMENT_TOKEN_SECRET nor JWT_SECRET is set.');
  }
  // A key per channel, so a grant minted on one chat can never be replayed on the other.
  return createHmac('sha256', secret).update(`fapoms/attachment-grant/v1/${channel}`).digest();
}

/** The token the upload route hands back with a stored file. */
export function issueAttachmentGrant(
  channel: AttachmentChannel,
  uploader: AttachmentUploader,
  storageKey: string,
): string {
  return createHmac('sha256', channelKey(channel))
    .update(`${uploader.kind}\n${uploader.id}\n${storageKey}`)
    .digest('base64url');
}

/** True only for a token this server minted for exactly this uploader, channel and key. */
export function attachmentGrantIsValid(
  channel: AttachmentChannel,
  uploader: AttachmentUploader,
  storageKey: string,
  token: unknown,
): boolean {
  if (typeof token !== 'string' || !token || !storageKey || !uploader?.id) return false;
  return constantTimeEqual(issueAttachmentGrant(channel, uploader, storageKey), token);
}

/**
 * The storage key an issued attachment URL names, or null when the URL is not exactly
 * `<prefix><one encoded key>` — no query string, no second segment, nothing undecodable.
 * The key is always read from the URL, never taken from a separate field, so the two cannot
 * disagree about which file a message points at.
 */
export function storageKeyFromIssuedUrl(url: unknown, prefix: string): string | null {
  if (typeof url !== 'string' || !url.startsWith(prefix)) return null;
  const encoded = url.slice(prefix.length);
  if (!encoded || /[?#/]/.test(encoded)) return null;
  let key: string;
  try { key = decodeURIComponent(encoded); } catch { return null; }
  if (!key || key.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  return key;
}
