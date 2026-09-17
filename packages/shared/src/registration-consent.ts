/**
 * WHAT A CANDIDATE IS TOLD BEFORE THEY TYPE ANYTHING.
 *
 * The form used to ask for a name, a PAN, an Aadhaar number, a bank account and a folder of scans,
 * and only then — on the last step, beside the Submit button — show a tick-box declaring the
 * answers true. Everything had already been collected and saved by that point, so the tick could
 * not be a decision about whether to hand it over. The DPDP Act asks for the opposite order: tell
 * the person what you want, why, how long you will keep it and how they can take it back, and only
 * then collect it.
 *
 * The text lives here rather than in the form because three separate things need the same words:
 * the page that shows the notice, the row that records which notice was accepted, and whatever has
 * to be produced later to show what somebody actually agreed to. A notice is therefore VERSIONED
 * and IMMUTABLE — the current one is what new candidates see, and every earlier one stays here so a
 * stored acceptance can still be read back years later.
 *
 * Changing a notice means ADDING a version, never editing one in place: an accepted version is a
 * record of a conversation that already happened.
 */

export interface ConsentNoticePurpose {
  /** What is collected, in the candidate's words. */
  what: string;
  /** Why this application needs it. */
  why: string;
}

export interface ConsentNotice {
  /** Stamped on the application when accepted; identifies the exact wording. */
  version: string;
  title: string;
  /** Who is asking. Filled from platform settings when the notice is served. */
  collectedBy: string;
  intro: string;
  purposes: ConsentNoticePurpose[];
  /** How long the answers are kept, and what happens at the end of it. */
  retention: string;
  /** What the person may ask for afterwards. */
  rights: string[];
  /** How withdrawal works and what it costs them. */
  withdrawal: string;
  /** The sentence beside the tick-box. */
  declaration: string;
}

const NOTICE_2026_09: ConsentNotice = {
  version: '2026-09',
  title: 'What we are asking for, and why',
  collectedBy: 'Sumeru Global',
  intro:
    'Before you fill anything in, here is exactly what this form collects and what happens to it. '
    + 'Nothing is saved until you agree to this.',
  purposes: [
    {
      what: 'Your name, date of birth, gender, address and phone number',
      why: 'To know who you are, to reach you about this application, and to plan work near you.',
    },
    {
      what: 'Your PAN and Aadhaar number',
      why: 'To confirm you are who you say you are, and because the law requires a PAN for payment and tax.',
    },
    {
      what: 'Your bank account and IFSC code',
      why: 'To pay you. Nothing else uses these.',
    },
    {
      what: 'Your qualifications, experience and references',
      why: 'To judge whether you can be empanelled, and for which kind of work.',
    },
    {
      what: 'Scans of your documents and a photograph',
      why: 'To verify the numbers above against the documents themselves, and to issue your identity card.',
    },
  ],
  retention:
    'If you are taken on, your details stay for as long as you work with us and for eight years after '
    + 'that, because tax and payment records must be kept that long. If the application does not go '
    + 'ahead, it is deleted within twelve months.',
  rights: [
    'Ask us what we hold about you, and get a copy.',
    'Have anything wrong corrected.',
    'Ask for your details to be erased, unless the law requires us to keep them.',
    'Withdraw your consent at any time, using the link below or the contact given.',
    'Nominate somebody to act for you if you cannot.',
    'Complain to us first, and to the Data Protection Board of India if we do not put it right.',
  ],
  withdrawal:
    'You can withdraw at any time before a decision is made. We then stop processing your '
    + 'application and delete what you have given us, apart from the fact that an application was '
    + 'made and withdrawn, which we keep as a record. Withdrawing means the application cannot go '
    + 'ahead.',
  declaration:
    'I have read the above. The details I am about to give are true and complete to the best of my '
    + 'knowledge, and I agree to them being used for the purposes listed.',
};

/** Every notice ever shown, newest first. Entries are never edited — only added. */
export const CONSENT_NOTICE_VERSIONS: readonly ConsentNotice[] = [NOTICE_2026_09];

/** What a candidate opening the form today is shown. */
export const CURRENT_CONSENT_NOTICE: ConsentNotice = NOTICE_2026_09;

export const CURRENT_CONSENT_VERSION = CURRENT_CONSENT_NOTICE.version;

/**
 * The wording behind a stored acceptance.
 *
 * `v1` is what the old tick-box recorded: a declaration of accuracy with no notice behind it. It is
 * not in the list above because it was never a notice, and `null` here is the honest answer —
 * pretending those candidates were shown today's text would be the one mistake worth avoiding.
 */
export function consentNoticeFor(version: string | null | undefined): ConsentNotice | null {
  if (!version) return null;
  return CONSENT_NOTICE_VERSIONS.find((notice) => notice.version === version) ?? null;
}
