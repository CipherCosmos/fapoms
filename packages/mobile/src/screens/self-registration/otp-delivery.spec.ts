import { en } from '../../i18n/locales/en';
import {
  DEFAULT_RESEND_COOLDOWN_SECONDS, OTP_BEFORE_SEND, codeLifetimeMinutes, formatCountdown, otpSentWords,
  resendCooldownSeconds, waitSecondsFromRefusal,
} from './otp-delivery';

/**
 * Where the phone says a registration code went, and how long before another may be asked for.
 *
 * The server texts the code to the number being verified when SMS is set up and emails it otherwise.
 * The screen used to say "emailed to <the invite's address>" unconditionally — once texts are on,
 * that sends a candidate to their inbox for a code that is sitting on their phone. It also counted
 * down a hard-coded 60 seconds whatever the server's setting was.
 */

/** The English sentence a key and its values produce, the way the catalogue fills `%{name}`. */
const say = ({ key, vars }: { key: string; vars: Record<string, string | number> }): string => {
  const template = key.split('.').reduce<any>((node, part) => node?.[part], en);
  expect(typeof template).toBe('string');
  return (template as string).replace(/%\{(\w+)\}/g, (_m, name: string) => String(vars[name] ?? `%{${name}}`));
};

describe('the registration code: where the phone says it went', () => {
  it('says it was texted, to the masked number the server names, when it went by SMS', () => {
    const words = otpSentWords({ channel: 'SMS', sentTo: '••••• 4455', expiresInSeconds: 300 }, 'r@example.com', 'your email address');
    expect(say(words)).toBe('Code texted to ••••• 4455. It works for 5 minutes.');
  });

  it('says it was emailed, to the masked address the server names — not the address on the invite', () => {
    const words = otpSentWords({ channel: 'EMAIL', sentTo: 'r•••@example.com', expiresInSeconds: 600 }, 'ramesh@example.com', 'your email address');
    expect(say(words)).toBe('Code emailed to r•••@example.com. It works for 10 minutes.');
  });

  /** Every server before this change emailed the invite's address and said nothing about where. */
  it('falls back to the invite\'s address, and five minutes, when an older server does not say', () => {
    expect(say(otpSentWords({}, 'ramesh@example.com', 'your email address')))
      .toBe('Code emailed to ramesh@example.com. It works for 5 minutes.');
    expect(say(otpSentWords(undefined, null, 'your email address')))
      .toBe('Code emailed to your email address. It works for 5 minutes.');
  });

  it('before sending, says plainly what will happen', () => {
    expect(say(OTP_BEFORE_SEND)).toBe('We\'ll send you a 6-digit code.');
  });

  it('labels the code box without assuming email', () => {
    expect(en.selfRegistration.otp.codeLabel).toBe('6-digit verification code');
  });
});

describe('the resend countdown', () => {
  it('counts down from the server\'s cooldownSeconds, not a number of its own', () => {
    expect(resendCooldownSeconds({ channel: 'SMS', sentTo: 'x', cooldownSeconds: 90 })).toBe(90);
    expect(resendCooldownSeconds({ channel: 'SMS', sentTo: 'x', cooldownSeconds: 30.2 })).toBe(31);
  });

  it('falls back to the server default only when the server does not say', () => {
    expect(resendCooldownSeconds({ channel: 'SMS', sentTo: 'x' })).toBe(DEFAULT_RESEND_COOLDOWN_SECONDS);
    expect(resendCooldownSeconds(null)).toBe(DEFAULT_RESEND_COOLDOWN_SECONDS);
    expect(resendCooldownSeconds({ cooldownSeconds: 0 })).toBe(DEFAULT_RESEND_COOLDOWN_SECONDS);
  });

  it('restarts at the number a "please wait" refusal names', () => {
    expect(waitSecondsFromRefusal('Please wait 42 seconds before requesting another code.')).toBe(42);
    expect(waitSecondsFromRefusal('Please wait 1 second before requesting another code.')).toBe(1);
    expect(waitSecondsFromRefusal('Something else went wrong.')).toBeNull();
    expect(waitSecondsFromRefusal(undefined)).toBeNull();
  });

  it('reads as minutes and seconds', () => {
    expect(formatCountdown(59)).toBe('0:59');
    expect(formatCountdown(60)).toBe('1:00');
    expect(formatCountdown(125)).toBe('2:05');
    expect(formatCountdown(-3)).toBe('0:00');
    expect(say({ key: 'selfRegistration.otp.resendIn', vars: { time: formatCountdown(45) } })).toBe('Resend code in 0:45');
  });

  it('turns expiresInSeconds into whole minutes', () => {
    expect(codeLifetimeMinutes({ expiresInSeconds: 300 })).toBe(5);
    expect(codeLifetimeMinutes({ expiresInSeconds: 30 })).toBe(1);
    expect(codeLifetimeMinutes({})).toBeNull();
  });
});
