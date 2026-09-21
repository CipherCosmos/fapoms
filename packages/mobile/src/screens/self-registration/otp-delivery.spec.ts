import { en } from '../../i18n/locales/en';
import { OTP_BEFORE_SEND, otpSentWords } from './otp-delivery';

/**
 * Where the phone says a registration code went.
 *
 * The server texts the code to the number being verified when SMS is set up and emails it otherwise.
 * The screen used to say "emailed to <the invite's address>" unconditionally — once texts are on,
 * that sends a candidate to their inbox for a code that is sitting on their phone.
 */

/** The English sentence a key and its values produce, the way the catalogue fills `%{name}`. */
const say = ({ key, vars }: { key: string; vars: Record<string, string | number> }): string => {
  const template = key.split('.').reduce<any>((node, part) => node?.[part], en);
  expect(typeof template).toBe('string');
  return (template as string).replace(/%\{(\w+)\}/g, (_m, name: string) => String(vars[name] ?? `%{${name}}`));
};

describe('the registration code: where the phone says it went', () => {
  it('says it was texted, to the masked number the server names, when it went by SMS', () => {
    const words = otpSentWords({ sent: true, channel: 'SMS', sentTo: '••••• 4455' }, 'r@example.com', 'your email address');
    expect(say(words)).toBe('A 6-digit code was texted to ••••• 4455. It expires in 5 minutes.');
  });

  it('says it was emailed, to the masked address the server names — not the address on the invite', () => {
    const words = otpSentWords({ sent: true, channel: 'EMAIL', sentTo: 'r•••@example.com' }, 'ramesh@example.com', 'your email address');
    expect(say(words)).toBe('A 6-digit code was emailed to r•••@example.com. It expires in 5 minutes.');
  });

  /** Every server before this change emailed the invite's address and said nothing about where. */
  it('falls back to the invite\'s address when an older server does not say where it went', () => {
    expect(say(otpSentWords({ sent: true }, 'ramesh@example.com', 'your email address')))
      .toBe('A 6-digit code was emailed to ramesh@example.com. It expires in 5 minutes.');
    expect(say(otpSentWords(undefined, null, 'your email address')))
      .toBe('A 6-digit code was emailed to your email address. It expires in 5 minutes.');
  });

  it('before sending, names both channels rather than promising one', () => {
    const before = say(OTP_BEFORE_SEND);
    expect(before).toMatch(/to your mobile, or to your email if texts are not available/);
    expect(before).not.toMatch(/%\{/);
  });

  it('labels the code box without assuming email', () => {
    expect(en.selfRegistration.otp.codeLabel).toBe('6-digit verification code');
  });
});
