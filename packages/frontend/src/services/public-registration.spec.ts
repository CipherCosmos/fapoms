import * as fs from 'fs';
import * as path from 'path';
import { fetchWithTimeout } from './http';
import { OTP_BEFORE_SEND_WORDS, otpSentWords, requestRegistrationOtp } from './public-registration';

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

  it('names both channels before sending, since the server decides which one carries it', () => {
    expect(OTP_BEFORE_SEND_WORDS).toMatch(/mobile/);
    expect(OTP_BEFORE_SEND_WORDS).toMatch(/email if texts are not available/);
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
    expect(page).toContain('6-digit verification code');
    expect(page).not.toMatch(/code from your email/i);
    expect(page).not.toMatch(/emailed to \$\{application/);
  });
});
