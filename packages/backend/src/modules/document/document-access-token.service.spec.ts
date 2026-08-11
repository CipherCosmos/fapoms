import { UnauthorizedException } from '@nestjs/common';
import { DocumentAccessTokenService } from './document-access-token.service';

describe('DocumentAccessTokenService', () => {
  const DOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const DOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let service: DocumentAccessTokenService;
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-for-document-tokens';
    service = new DocumentAccessTokenService();
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalSecret;
  });

  it('accepts a freshly issued token for the same document', () => {
    const { token } = service.issue(DOC_A);
    expect(() => service.verify(DOC_A, token)).not.toThrow();
  });

  // The whole point of binding the signature to the document id: a token legitimately issued
  // for a document the caller may read must not unlock a different one.
  it('rejects a valid token replayed against a different document', () => {
    const { token } = service.issue(DOC_A);
    expect(() => service.verify(DOC_B, token)).toThrow(UnauthorizedException);
  });

  it('rejects a token whose expiry has been tampered with to extend it', () => {
    const { token } = service.issue(DOC_A);
    const [, signature] = token.split('.');
    const farFuture = Math.floor(Date.now() / 1000) + 999999;
    expect(() => service.verify(DOC_A, `${farFuture}.${signature}`)).toThrow(UnauthorizedException);
  });

  it('rejects an expired token', () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    // Sign a genuinely-expired token via the service's own secret by reaching through issue()
    // is not possible, so assert the expiry branch through a hand-built value.
    expect(() => service.verify(DOC_A, `${past}.whatever`)).toThrow(/expired/i);
  });

  it.each([undefined, '', 'garbage', 'no-dot-separator'])('rejects malformed token %p', (bad) => {
    expect(() => service.verify(DOC_A, bad as any)).toThrow(UnauthorizedException);
  });

  it('refuses to sign when no secret is configured, rather than using a guessable default', () => {
    delete process.env.JWT_SECRET;
    delete process.env.DOCUMENT_TOKEN_SECRET;
    expect(() => new DocumentAccessTokenService().issue(DOC_A)).toThrow(/secret/i);
  });
});
