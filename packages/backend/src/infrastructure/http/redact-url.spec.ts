import { redactUrl } from './redact-url';

/**
 * An audit of the running stack found 398 log lines, each holding a working registration link —
 * and a registration link opens a candidate's PAN, Aadhaar, bank account and scanned ID. These pin
 * that a URL has its secrets taken out before it is written anywhere a person can read it.
 */
describe('a URL on its way into a log', () => {
  const token = 'a3f9c2e17b8d4c5fa0e6b2d9c1f4e7a8b3c6d9e2f5a8b1c4';

  it('takes the token out of a registration link', () => {
    expect(redactUrl(`/api/v1/public/registration/${token}`)).toBe('/api/v1/public/registration/[token]');
    expect(redactUrl(`/api/v1/public/registration/${token}/documents/PAN_CARD/file/0`))
      .toBe('/api/v1/public/registration/[token]/documents/PAN_CARD/file/0');
  });

  it('takes the token out of the candidate page address', () => {
    expect(redactUrl(`/register/${token}`)).toBe('/register/[token]');
  });

  /** A staff password-setup link is that person's password until it is spent. */
  it('takes the token out of a password-setup link, page and API alike', () => {
    expect(redactUrl(`/account-setup/${token}`)).toBe('/account-setup/[token]');
    expect(redactUrl(`/api/v1/public/account-setup/${token}`)).toBe('/api/v1/public/account-setup/[token]');
    expect(redactUrl(`https://app.example.in/account-setup/${token}?from=email`))
      .toBe('https://app.example.in/account-setup/[token]?from=email');
    expect(redactUrl(`/api/v1/public/account-setup/${token}`)).not.toContain(token);
  });

  it('takes identity numbers and tokens out of a query string', () => {
    const out = redactUrl('/api/v1/assayers/identifier-check?panNumber=ABCDE1234F&aadhaarNumber=234567890124&phone=9822014455');
    expect(out).not.toContain('ABCDE1234F');
    expect(out).not.toContain('234567890124');
    expect(out).toContain('panNumber=[redacted]');
    // A phone number is how duplicates are found and is not what this protects; it stays readable.
    expect(out).toContain('phone=9822014455');
    expect(redactUrl('/api/v1/documents/9/download?token=eyJhbGciOi')).toBe('/api/v1/documents/9/download?token=[redacted]');
  });

  it('leaves an ordinary route exactly as it was', () => {
    expect(redactUrl('/api/v1/assayers/7c1e/dossier')).toBe('/api/v1/assayers/7c1e/dossier');
    expect(redactUrl('/api/v1/hr/applications?status=DRAFT')).toBe('/api/v1/hr/applications?status=DRAFT');
  });

  it('has nothing to say about nothing', () => {
    expect(redactUrl(undefined)).toBe('');
    expect(redactUrl('')).toBe('');
  });
});
