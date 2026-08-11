import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Short-lived signed tokens for document downloads.
 *
 * The download endpoint could not simply be put behind the normal JWT guard: the assayer app
 * opens PDFs with `Linking.openURL()`, which hands the URL to the OS browser and cannot attach
 * an Authorization header. That constraint is why the endpoint was left `@Public()` — meaning
 * anyone who could reach the API could enumerate and download bank customer paperwork.
 *
 * Instead the client asks an authenticated endpoint for a token scoped to one document, then
 * opens a URL carrying it. The token is an HMAC over the document id and an expiry, so it is
 * unforgeable without the server secret, useless for any other document, and dies quickly.
 * Nothing is persisted — verification is pure recomputation.
 */
@Injectable()
export class DocumentAccessTokenService {
  /** Deliberately short: long enough to hand off to the browser, not to circulate. */
  private static readonly TTL_SECONDS = 300;

  private get secret(): string {
    // Falls back to the JWT secret so there is no new required config, but never to a
    // hardcoded default — an unset secret must fail loudly rather than sign with something
    // guessable.
    const secret = process.env.DOCUMENT_TOKEN_SECRET || process.env.JWT_SECRET;
    if (!secret) {
      throw new Error(
        'Cannot sign document download tokens: neither DOCUMENT_TOKEN_SECRET nor JWT_SECRET is set.',
      );
    }
    return secret;
  }

  private sign(documentId: string, expiresAt: number): string {
    return createHmac('sha256', this.secret)
      .update(`${documentId}.${expiresAt}`)
      .digest('base64url');
  }

  /** Issues `<expiry>.<signature>` for one document. */
  issue(documentId: string): { token: string; expiresAt: number } {
    const expiresAt = Math.floor(Date.now() / 1000) + DocumentAccessTokenService.TTL_SECONDS;
    return { token: `${expiresAt}.${this.sign(documentId, expiresAt)}`, expiresAt };
  }

  /** Throws unless `token` is a valid, unexpired token for exactly this document. */
  verify(documentId: string, token: string | undefined): void {
    if (!token) {
      throw new UnauthorizedException('A download token is required.');
    }

    const [expiryPart, signature] = token.split('.');
    const expiresAt = Number(expiryPart);
    if (!expiryPart || !signature || !Number.isFinite(expiresAt)) {
      throw new UnauthorizedException('Malformed download token.');
    }

    if (expiresAt < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Download token has expired. Request a new one.');
    }

    // Binding the signature to documentId is what stops a token issued for a document the
    // caller may legitimately read being replayed against one they may not.
    const expected = Buffer.from(this.sign(documentId, expiresAt));
    const provided = Buffer.from(signature);
    // timingSafeEqual throws on length mismatch, so guard before comparing.
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new UnauthorizedException('Invalid download token.');
    }
  }
}
