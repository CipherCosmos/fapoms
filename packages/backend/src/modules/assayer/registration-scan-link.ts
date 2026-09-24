import { createHash, createHmac } from 'crypto';
import { constantTimeEqual } from '../../infrastructure/security/token-utils';

/**
 * A short-lived link to ONE registration scan, for a viewer that cannot send headers.
 *
 * A candidate's saved scans are locked behind the code they verified this session
 * (`x-registration-session`). An image preview sends that header; a PDF has to be handed to the
 * phone's browser or PDF viewer, which cannot. So a caller who IS unlocked asks for a link, and
 * the link carries a signature over exactly this invite, requirement and page, valid for
 * `REGISTRATION_SCAN_LINK_TTL_SECONDS`. It opens nothing else, and it does not unlock the form.
 *
 * The invite token itself is hashed into the subject rather than embedded, so the signature is
 * useless for any other invite even if both leak together.
 */
export const REGISTRATION_SCAN_LINK_TTL_SECONDS = 120;

function secret(): string {
  const s = process.env.DOCUMENT_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error('Cannot sign scan links: neither DOCUMENT_TOKEN_SECRET nor JWT_SECRET is set.');
  return s;
}

function subject(rawToken: string, requirement: string, index: number, expiresAt: number): string {
  const invite = createHash('sha256').update(rawToken).digest('base64url');
  return `regscan:${invite}:${requirement}:${index}:${expiresAt}`;
}

function sign(rawToken: string, requirement: string, index: number, expiresAt: number): string {
  return createHmac('sha256', secret()).update(subject(rawToken, requirement, index, expiresAt)).digest('base64url');
}

/** `<expiry>.<signature>` for one scan of one invite. */
export function issueRegistrationScanLink(rawToken: string, requirement: string, index: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const expiresAt = nowSeconds + REGISTRATION_SCAN_LINK_TTL_SECONDS;
  return `${expiresAt}.${sign(rawToken, requirement, index, expiresAt)}`;
}

/** True only for an unexpired link signed for exactly this invite, requirement and page. */
export function registrationScanLinkIsValid(
  link: string | undefined,
  rawToken: string,
  requirement: string,
  index: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!link) return false;
  const [expiryPart, signature] = link.split('.');
  const expiresAt = Number(expiryPart);
  if (!expiryPart || !signature || !Number.isFinite(expiresAt) || expiresAt < nowSeconds) return false;
  return constantTimeEqual(signature, sign(rawToken, requirement, index, expiresAt));
}
