/**
 * FAPOMS — the words of every SMS the application sends, in one place.
 *
 * Under DLT every text must match a registered content template, with `{#var#}` where the variable
 * parts go. So SMS wording is never free text at a call site: a sender names one of these keys, and
 * the DLT form of each (`toDltForm`) is what gets registered on the operator's portal. An
 * administrator can override the text and record its DLT template id on the settings screen
 * (`SmsTemplateService`); these are the defaults and the fallback.
 */

export type SmsTemplateKey =
  | 'mfa-code'
  | 'registration-otp'
  | 'app-credentials'
  | 'notification'
  | 'transport-test';

/**
 * Every template also accepts the values in `COMMON_MESSAGE_TOKENS` ({{name}}, {{phone}},
 * {{companyName}}, {{portalUrl}}, {{time}}, {{date}}) — the platform fills them on every text, so an
 * administrator can use the same names in any wording. `requiredTokens` below are the ones this
 * particular text cannot be sent without.
 */
export interface SmsTemplateDefinition {
  key: SmsTemplateKey;
  name: string;
  description: string;
  /** Default text with `{{token}}` placeholders. */
  defaultText: string;
  /**
   * The DLT content template id this DEFAULT wording is registered under, when the operations team
   * has supplied one. It travels with the wording, not with the template key: wording edited on the
   * settings screen is no longer what was registered, so it does not inherit this id.
   */
  defaultDltTemplateId?: string;
  requiredTokens: readonly string[];
  /** Extra values this text may use, beyond the common ones every message gets. */
  optionalTokens?: readonly string[];
  sampleData: Record<string, string>;
}

export const SMS_TEMPLATE_REGISTRY: Record<SmsTemplateKey, SmsTemplateDefinition> = {
  'mfa-code': {
    key: 'mfa-code',
    name: 'Sign-in verification code',
    description: 'The one-time code for signing in or setting up SMS as a second factor.',
    /*
      Written in the same shape as the registration template the operations team already had
      approved — same opening, same closing sentence — because a DLT reviewer approving one is the
      best evidence available that they will approve its sibling. Awaiting its own id.
    */
    defaultText: 'Greetings from Sumeru Global Support Solutions Pvt. Ltd.! Use {{code}} to sign in. '
      + 'The code is valid for {{validMinutes}} minutes. Do not share this code with anyone.',
    requiredTokens: ['code', 'validMinutes'],
    sampleData: { code: '482910', validMinutes: '5' },
  },
  'registration-otp': {
    key: 'registration-otp',
    name: 'Registration mobile verification code',
    description: 'Sent to the mobile number a candidate enters on the registration form, to prove it is theirs.',
    /*
      WORD FOR WORD what the operations team registered on DLT (supplied 2026-09-19 with the id
      below). Under DLT the operator matches the text it receives against the registered template,
      so this is not wording anybody may improve in passing: the company's name is spelled out here
      rather than using {{companyName}}, because a placeholder resolving to "Sumeru Global" would no
      longer match "Sumeru Global Support Solutions Pvt. Ltd." and every registration code would be
      refused. Change the words only alongside a new registration and a new id.
    */
    defaultText: 'Greetings from Sumeru Global Support Solutions Pvt. Ltd.! Use {{code}} to verify your '
      + 'profile. OTP is valid for {{validMinutes}} minutes. Do not share this OTP with anyone.',
    defaultDltTemplateId: '1777178971152755392',
    requiredTokens: ['code', 'validMinutes'],
    sampleData: { code: '849201', validMinutes: '5' },
  },
  'app-credentials': {
    key: 'app-credentials',
    name: 'App access credentials',
    description: 'The username and temporary password issued to an assayer for the field app.',
    defaultText: 'Greetings from Sumeru Global Support Solutions Pvt. Ltd.! Your app sign-in is {{username}} '
      + 'and temporary password {{temporaryPassword}}, valid for {{validDays}} days. Do not share it.',
    requiredTokens: ['username', 'temporaryPassword', 'validDays'],
    sampleData: { username: 'AS0323', temporaryPassword: 'tiger-mango-9', validDays: '7' },
  },
  notification: {
    key: 'notification',
    name: 'Notification alert',
    description: 'A notification event an administrator has switched on for SMS: what happened, in one line.',
    /*
      The TITLE only, and then "open the app".

      This was `FAPOMS: {{title}}. {{message}}` — a template that is almost entirely variable, which
      a DLT reviewer routinely refuses, and whose second variable was in any case cut to DLT's
      30-character limit and arrived as half a sentence. One framed variable reads properly, costs
      one part even at the full 30 characters, and the whole notification is one tap away in the app.
    */
    defaultText: 'Greetings from Sumeru Global Support Solutions Pvt. Ltd.! You have an update on FAPOMS: '
      + '{{title}}. Open the app to see the details.',
    requiredTokens: ['title'],
    /** Still passed by the notification worker; usable by anyone who registers a wording that has it. */
    optionalTokens: ['message'],
    sampleData: { title: 'Assignment escalated', message: 'Thrissur has been marked critical.' },
  },
  'transport-test': {
    key: 'transport-test',
    name: 'SMS delivery test',
    description: 'Sent from Platform Settings to check that SMS delivery works.',
    /*
      No variables at all. A template with nothing to fill in is the easiest thing a DLT reviewer can
      approve, and who pressed the button belongs in the audit row rather than in a stranger's inbox.
    */
    defaultText: 'This is a test message from Sumeru Global Support Solutions Pvt. Ltd. to check that '
      + 'FAPOMS SMS delivery is working. No action is needed.',
    requiredTokens: [],
    sampleData: {},
  },
};

/**
 * The text as it must be registered on the DLT portal: every `{{token}}` becomes `{#var#}`.
 *
 * Lives in `@fapoms/shared` so the settings screen shows, while an administrator types, exactly the
 * form the server will send under — re-exported here because senders know this module.
 */
export { toDltForm } from '@fapoms/shared';
