import type { TranslationKey, TranslationVars } from '../../i18n/i18n';
import type { OtpDelivery } from '../../services/self-registration.service';

/**
 * What the phone says about where a registration verification code went.
 *
 * The server texts the code to the number being verified when SMS is set up, and emails it
 * otherwise, and answers with which channel carried it and a destination it has already masked
 * ("••••• 4455", "r•••@example.com"). This screen used to say "emailed to <the invite's address>"
 * whatever happened, which would send somebody to their inbox for a code sitting on their phone.
 *
 * Pure, so it can be tested without the React Native runtime (`otp-delivery.spec.ts`).
 */
export interface OtpWords {
  key: TranslationKey;
  vars: TranslationVars;
}

/** Before any code is requested: the server decides the channel, so both are named. */
export const OTP_BEFORE_SEND: OtpWords = { key: 'selfRegistration.otp.body', vars: {} };

/**
 * After a code was requested. `inviteEmail` is only for a server too old to say where it sent the
 * code — every such server emailed it to the invite's address.
 */
export function otpSentWords(
  delivery: Partial<OtpDelivery> | null | undefined,
  inviteEmail: string | null,
  yourEmail: string,
): OtpWords {
  // Every server before `expiresInSeconds` existed kept a code for five minutes.
  const minutes = codeLifetimeMinutes(delivery) ?? 5;
  if (delivery?.channel === 'SMS' && delivery.sentTo) {
    return { key: 'selfRegistration.otp.sentBodySms', vars: { phone: delivery.sentTo, minutes } };
  }
  if (delivery?.channel === 'EMAIL' && delivery.sentTo) {
    return { key: 'selfRegistration.otp.sentBody', vars: { email: delivery.sentTo, minutes } };
  }
  return { key: 'selfRegistration.otp.sentBody', vars: { email: inviteEmail || yourEmail, minutes } };
}

/** What the server's own settings default to; used only when an older server does not say. */
export const DEFAULT_RESEND_COOLDOWN_SECONDS = 60;

/** How long before Resend is allowed — the server's `cooldownSeconds`, never a number of our own. */
export function resendCooldownSeconds(delivery: Partial<OtpDelivery> | null | undefined): number {
  const s = Number(delivery?.cooldownSeconds);
  return Number.isFinite(s) && s > 0 ? Math.ceil(s) : DEFAULT_RESEND_COOLDOWN_SECONDS;
}

/**
 * The seconds a server refusal says to wait ("Please wait 42 seconds before requesting another
 * code."), so the countdown restarts at the server's number instead of the button staying live.
 */
export function waitSecondsFromRefusal(message: string | null | undefined): number | null {
  const match = /wait\s+(\d+)\s+second/i.exec(message ?? '');
  return match ? Number(match[1]) : null;
}

/** `0:45`, `1:30` — a countdown people read at a glance. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Whole minutes the code lasts, from the server's `expiresInSeconds`; null when it does not say. */
export function codeLifetimeMinutes(delivery: Partial<OtpDelivery> | null | undefined): number | null {
  const s = Number(delivery?.expiresInSeconds);
  return Number.isFinite(s) && s > 0 ? Math.max(1, Math.round(s / 60)) : null;
}
