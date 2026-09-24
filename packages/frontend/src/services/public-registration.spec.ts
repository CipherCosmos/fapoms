import * as fs from 'fs';
import * as path from 'path';
import { fetchWithTimeout } from './http';
import {
  OTP_BEFORE_SEND_WORDS, otpSentWords, requestRegistrationOtp,
  uploadRegistrationDocument, removeRegistrationDocumentFile, isUploadRejected,
} from './public-registration';
import { AppError } from './errors';

jest.mock('./http', () => ({
  ...jest.requireActual('./http'),
  fetchWithTimeout: jest.fn(),
}));

const mockFetch = fetchWithTimeout as jest.Mock;

/**
 * WHERE THE VERIFICATION CODE WENT.
 *
 * The server now texts the code to the mobile being verified when SMS is set up, and emails it
 * otherwise. The page used to say "emailed to <the application's address>" unconditionally, which
 * would send a candidate to their inbox for a code sitting on their phone. It must say what the
 * server says, and before sending it must not promise a channel it cannot know yet.
 */
describe('the registration verification code wording', () => {
  it('says the code was texted, to the masked number the server names', () => {
    expect(otpSentWords({ channel: 'SMS', sentTo: '••••• 4455' }))
      .toBe('A 6-digit code has been texted to ••••• 4455. It expires in 5 minutes.');
  });

  it('says the code was emailed, to the masked address the server names', () => {
    expect(otpSentWords({ channel: 'EMAIL', sentTo: 'r•••@example.com' }))
      .toBe('A 6-digit code has been emailed to r•••@example.com. It expires in 5 minutes.');
  });

  /**
   * One short line before sending. It names no email address: where the code actually went is
   * said after sending, in the server's own words (the two tests above).
   */
  it('says one short line before sending, and promises no particular destination', () => {
    expect(OTP_BEFORE_SEND_WORDS).toBe("We'll send you a 6-digit code.");
    expect(OTP_BEFORE_SEND_WORDS).not.toMatch(/@|emailed to/);
  });

  it('hands the page the channel and masked destination the server answered with', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      headers: { get: () => null },
      json: async () => ({ success: true, data: { sent: true, channel: 'SMS', sentTo: '••••• 4455' } }),
    });

    await expect(requestRegistrationOtp('tok', '9822014455'))
      .resolves.toEqual({ sent: true, channel: 'SMS', sentTo: '••••• 4455' });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/tok/otp/request'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ phone: '9822014455' }) }),
    );
  });

  /**
   * The page itself: it shows the server's answer and never names the application's email as the
   * destination, and its code box does not say "from your email" when the code may be a text.
   */
  it('the page shows the server\'s answer rather than assuming email', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'PublicRegistration.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(page).toMatch(/setOtpInfo\(otpSentWords\(/);
    expect(page).toContain('{OTP_BEFORE_SEND_WORDS}');
    expect(page).not.toMatch(/No \+91 needed/);
    expect(page).toContain('6-digit verification code');
    expect(page).not.toMatch(/code from your email/i);
    expect(page).not.toMatch(/emailed to \$\{application/);
  });
});

/**
 * "Retake" replaces; a new file on an empty row is added; the × takes one file off by position.
 * The replace used to be sent as a plain add, so a retaken scan left the old one on the record too.
 */
describe('attaching and removing registration files', () => {
  const ok = (data: unknown) => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ success: true, data }),
  });

  beforeEach(() => mockFetch.mockReset());

  it('adds a file without asking to replace anything', async () => {
    mockFetch.mockResolvedValueOnce(ok({ requirement: 'PAN_CARD', filePaths: ['a'] }));
    await uploadRegistrationDocument('tok', 'PAN_CARD', new File(['x'], 'pan.jpg', { type: 'image/jpeg' }));
    expect(mockFetch.mock.calls[0][0]).toMatch(/\/tok\/documents\/PAN_CARD$/);
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
  });

  it('asks the server to replace what is there on a retake', async () => {
    mockFetch.mockResolvedValueOnce(ok({ requirement: 'PAN_CARD', filePaths: ['b'] }));
    await uploadRegistrationDocument('tok', 'PAN_CARD', new File(['x'], 'pan.jpg', { type: 'image/jpeg' }), { replace: true });
    expect(mockFetch.mock.calls[0][0]).toMatch(/\/tok\/documents\/PAN_CARD\?replace=true$/);
  });

  it('removes one file by its position, and hands back what is left', async () => {
    mockFetch.mockResolvedValueOnce(ok({ requirement: 'RENT_AGREEMENT', filePaths: [] }));
    await expect(removeRegistrationDocumentFile('tok', 'RENT_AGREEMENT', 1))
      .resolves.toEqual({ requirement: 'RENT_AGREEMENT', filePaths: [] });
    expect(mockFetch.mock.calls[0][0]).toMatch(/\/tok\/documents\/RENT_AGREEMENT\/file\/1$/);
    expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
  });

  it('recognises the server refusing the file itself, and keeps its plain words', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 400, headers: { get: () => null },
      json: async () => ({ code: 'UPLOAD_REJECTED', message: 'That file is not a real PDF. Take the photo again.' }),
    });
    const err = await uploadRegistrationDocument('tok', 'PAN_CARD', new File(['x'], 'pan.pdf')).catch((e) => e);
    expect(isUploadRejected(err)).toBe(true);
    expect((err as AppError).userMessage).toMatch(/not a real PDF/);
    expect(isUploadRejected(new AppError('Network down', 'x', 0))).toBe(false);
  });
});
