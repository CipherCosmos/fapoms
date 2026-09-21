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
  if (delivery?.channel === 'SMS' && delivery.sentTo) {
    return { key: 'selfRegistration.otp.sentBodySms', vars: { phone: delivery.sentTo } };
  }
  if (delivery?.channel === 'EMAIL' && delivery.sentTo) {
    return { key: 'selfRegistration.otp.sentBody', vars: { email: delivery.sentTo } };
  }
  return { key: 'selfRegistration.otp.sentBody', vars: { email: inviteEmail || yourEmail } };
}
