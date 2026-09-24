/**
 * Every platform knob an operator may turn, declared in one place.
 *
 * The problem this solves: business policy was scattered across environment variables and
 * hardcoded constants, so changing what an audit is worth, when the morning email goes out, or
 * which mailbox sends it meant editing a file and restarting a process. None of those are
 * engineering decisions — they are the operator's, and they should not require a deploy.
 *
 * The registry is deliberately a declaration rather than a schema generator. Each entry names
 * the environment variable it falls back to, so nothing that works today stops working: a
 * deployment that sets `GMAIL_USER` keeps using it until somebody saves a value here, and the
 * settings screen shows plainly which of the two is in force. Resolution order everywhere is
 * **saved value → environment → shipped default**.
 *
 * Infrastructure — database hosts, Redis, JWT secrets, ports — is deliberately absent. Those
 * are properties of where the software is running, not decisions about how the business runs,
 * and a UI that can point the application at a different database is a UI that can take the
 * application down.
 */

import { CANONICAL_STATE_NAMES } from '@fapoms/shared';

export type SettingType = 'string' | 'number' | 'boolean' | 'password' | 'select' | 'cron' | 'json';

/**
 * Who a setting belongs to, since the DEVELOPER/ADMIN split (2026-09-05).
 *
 * 'business' settings are the operator's decisions about how the business runs — fees, tax
 * identity, travel policy — and stay writable by administrators. 'technical' settings are
 * platform plumbing (mail transports, cron schedules, retention floors, security rollouts):
 * they decide how the machine behaves, not what the business charges, and only a Developer
 * may change them. The registry stays one list; the audience is a property of each group,
 * overridable per key for the odd setting living in the wrong group's clothes.
 */
export type SettingAudience = 'technical' | 'business';

export interface SettingDef {
  key: string;
  label: string;
  /** Plain-language explanation shown under the field. Say what changes, in the operator's terms. */
  description: string;
  group: string;
  type: SettingType;
  /** The value used when nothing is saved and no environment variable is set. */
  default: string | number | boolean | null;
  /** The environment variable consulted before the default. */
  envVar?: string;
  /** Never returned to a client, encrypted at rest, and only ever written. */
  secret?: boolean;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  unit?: string;
  /**
   * What it takes for a saved change to take effect. Shown in the UI, because "saved" and
   * "in force" being different things is exactly the kind of surprise that erodes trust in a
   * settings screen.
   */
  applies: 'immediately' | 'next-run' | 'restart';
  /**
   * Per-key override of the group's audience, for a setting whose group is one kind and whose
   * nature is the other. Unset means "whatever my group is" — see `audienceOfSetting`.
   */
  audience?: SettingAudience;
}

/**
 * The `audience` on each group is what fences the DEVELOPER/ADMIN write split (2026-09-05).
 * Technical groups — plumbing: the mail transport, cron schedules, retention floors, identity
 * enforcement and access-boundary rollouts, and the Support SLA (the desk moved to the
 * developer) — are the Developer's alone. Business groups — money, tax identity, travel and
 * planning policy — remain the administrator's. Enforced in PlatformSettingsService.set/reset
 * and reflected in what GET /platform-settings shows each role.
 */
export const SETTINGS_GROUPS = [
  { key: 'company', label: 'Company & tax identity', audience: 'business', description: 'Your firm\'s legal identity as it appears on the GST invoices you send bank clients, and the tax labels on statements. These are printed exactly as entered — set them before sending a real invoice.' },
  { key: 'email', label: 'Email delivery', audience: 'technical', description: 'The mailbox the platform sends from, and where its links point.' },
  { key: 'sms', label: 'SMS delivery', audience: 'technical', description: 'The text-message company the platform sends through, and the DLT registration every text to an Indian number is checked against. Until this is set up, one-time codes and sign-in details go by email only.' },
  { key: 'schedule', label: 'Schedules', audience: 'technical', description: 'When recurring work runs — the morning brief and the SLA sweep.' },
  { key: 'fees', label: 'Fees & pricing', audience: 'business', description: 'What an audit is worth when no client or assayer contract says otherwise.' },
  { key: 'transport', label: 'Transport recommendation', audience: 'business', description: 'How the recommended way to travel is chosen — the speed assumed for each mode when no timetable exists, when a mode is ruled out, and how cost is weighed against time.' },
  { key: 'billing', label: 'Billing & claims', audience: 'business', description: 'Tax withholding and the ceiling on a single expense claim.' },
  { key: 'retention', label: 'Data retention', audience: 'technical', description: 'How long movement and operational records are kept.' },
  { key: 'dpdp', label: 'Data protection (DPDP)', audience: 'business', description: 'The Grievance Officer / DPO contact published to Data Principals, and how long the platform has to answer a rights request. Required by the Digital Personal Data Protection Act.' },
  // User-facing group name is "Support SLA" — the channel itself renamed from "Feedback" to
  // "Support" / "Help & Support" (see feedback.service.ts). The key stays 'feedback' so saved
  // settings, the individual keys below (feedback.firstResponseHours, …) and their env vars
  // keep resolving. Technical audience: the support desk belongs to the developer now
  // (see feedback-roles.ts), so its SLA knobs follow the desk.
  { key: 'feedback', label: 'Support SLA', audience: 'technical', description: 'How long the product team has to answer, and to resolve, before it escalates.' },
  { key: 'onboarding', label: 'Joining and identity', audience: 'technical', description: 'What an appraiser must prove about who they are before they can be activated, and how strictly it is enforced.' },
  { key: 'rechecks', label: 'Re-checks over time', audience: 'business', description: 'How often a working appraiser is re-checked — background, police, credit and identity documents — how early HR is reminded, and how long an overdue check is allowed before they are held from new work.' },
  { key: 'field', label: 'In the field', audience: 'business', description: 'What the app enforces on an assayer while they are out on a job.' },
  { key: 'planning', label: 'Planning', audience: 'business', description: 'How the recommendation engine spreads work across the people who are eligible for it.' },
  { key: 'roster', label: 'Roster import', audience: 'business', description: 'How the appraiser roster spreadsheet is brought in.' },
  { key: 'security', label: 'Access boundaries', audience: 'technical', description: 'Rollout controls for access checks being tightened — a value here is a staged switch, never a permanent policy.' },
  { key: 'qualification', label: 'Assayer qualification', audience: 'business', description: 'How the qualification scores on an assayer\'s profile weigh their verification, background, credentials and track record. Weights are relative — they are normalized over whichever dimensions have data.' },
  { key: 'registration', label: 'Self-registration', audience: 'technical', description: 'How the candidate-facing registration link and OTP verification behave — the entry point alongside the HR desk, not a replacement for it.' },
  { key: 'email_templates', label: 'Email Templates', audience: 'business', description: 'Versioned overrides and custom layouts for platform notification emails.' },
] as const;

/**
 * The payout maker-checker key, named once.
 *
 * `BillingEngineService` reads this key and falls back to its shipped default when the settings
 * store cannot answer, so the string and the default must not be able to drift apart into a
 * service that quietly asks for a key nobody defines.
 */
export const SEGREGATION_OF_DUTIES_SETTING_KEY = 'security.segregationOfDuties.mode';

export const SETTINGS_REGISTRY: SettingDef[] = [
  // ── Company & tax identity ────────────────────────────────────────────────
  //
  // The seller side of every GST invoice. Nothing here is hardcoded in the invoice document: an
  // unset value prints as a clearly-marked placeholder ("‹set company GSTIN in Settings›") so a
  // half-configured system produces an obviously-incomplete invoice rather than a plausible one
  // with a wrong or blank identity. The GSTIN's first two digits are also what decides CGST+SGST
  // versus IGST, so a correct GSTIN here is what makes the tax split correct.
  {
    key: 'company.legalName',
    label: 'Company legal name',
    description: 'The registered name of your firm, printed as the seller on every client invoice. Use the exact legal name on your GST registration.',
    group: 'company',
    type: 'string',
    default: null,
    applies: 'immediately',
  },
  {
    key: 'company.address',
    label: 'Company address',
    description: 'The registered address printed under the seller name on invoices (commas become line breaks there), and at the bottom of every appraiser ID card.',
    group: 'company',
    type: 'string',
    default: null,
    applies: 'immediately',
  },
  {
    key: 'company.gstin',
    label: 'Company GSTIN',
    description: 'Your 15-character GST identification number. It appears on the invoice AND its first two digits set your state, which decides whether a line is taxed CGST+SGST (same state as the client) or IGST (different state). Get this wrong and the tax split is wrong.',
    group: 'company',
    type: 'string',
    default: null,
    applies: 'immediately',
  },
  {
    key: 'company.state',
    label: 'Company state',
    description: 'The state your GST registration is in. Used to decide CGST+SGST versus IGST only when the GSTIN above has not been entered — set the GSTIN and this is derived from it.',
    group: 'company',
    type: 'select',
    // Same closed set every other state-scoped field in this app draws from (see
    // TransportCosts.tsx), rather than a free string that can drift from the canonical spelling
    // the rest of the platform matches against.
    options: CANONICAL_STATE_NAMES.map((s) => ({ value: s, label: s })),
    default: null,
    applies: 'immediately',
  },
  {
    key: 'company.pan',
    label: 'Company PAN',
    description: 'Your firm\'s 10-character PAN, printed on the invoice for the client\'s TDS records.',
    group: 'company',
    type: 'string',
    default: null,
    applies: 'immediately',
  },
  {
    key: 'invoice.defaultSac',
    label: 'Default HSN/SAC code',
    description: 'The service accounting code printed against each audit line unless a more specific one is set. Audit services fall under SAC heading 9982; the default 998222 is "financial auditing services". Change it to the SAC your firm actually bills under.',
    group: 'company',
    type: 'string',
    default: '998222',
    applies: 'immediately',
  },
  // The appraiser ID card's printed text. Read by RosterRecordsService.idCardPrintedText for BOTH
  // the downloaded PDF and the on-screen preview, so the two cannot disagree. Nothing here has a
  // made-up fallback: an unset key leaves its line off the card rather than printing somebody who
  // does not exist. The office address on the card is `company.address` above — one address.
  {
    key: 'idCard.signatoryName',
    label: 'ID card: signed by (name)',
    description: 'The name printed under the signature line on every appraiser ID card, for example the person who authorises the cards. Leave it empty and no name is printed under the line.',
    group: 'company',
    type: 'string',
    default: null,
    applies: 'immediately',
  },
  {
    key: 'idCard.signatoryTitle',
    label: 'ID card: signed by (job title)',
    description: 'The job title printed under the signatory\'s name on every appraiser ID card, for example "Director - Operations". Leave it empty and no title is printed.',
    group: 'company',
    type: 'string',
    default: null,
    applies: 'immediately',
  },
  {
    key: 'idCard.helplinePhone',
    label: 'ID card: phone number to call if the card is found',
    description: 'Printed at the bottom of every appraiser ID card as "If found, please call …", next to the Company address set above. Leave it empty and the line is left off the card.',
    group: 'company',
    type: 'string',
    default: null,
    applies: 'immediately',
  },

  // ── Email ───────────────────────────────────────────────────────────────
  {
    key: 'email.transport',
    label: 'Transport',
    description: 'Gmail uses a Google Workspace account with an app password. SMTP is any other mail provider. Off stops all outbound email — notifications still reach the in-app bell.',
    group: 'email',
    type: 'select',
    options: [
      { value: 'GMAIL', label: 'Gmail / Google Workspace' },
      { value: 'SMTP', label: 'Other SMTP server' },
      { value: 'NONE', label: 'Off — send no email' },
    ],
    default: 'NONE',
    applies: 'immediately',
  },
  {
    key: 'email.gmailUser',
    label: 'Gmail address',
    description: 'The Workspace account that sends. It needs 2-step verification switched on.',
    group: 'email',
    type: 'string',
    default: null,
    envVar: 'GMAIL_USER',
    applies: 'immediately',
  },
  {
    key: 'email.gmailAppPassword',
    label: 'Gmail app password',
    description: 'A 16-character app password from myaccount.google.com/apppasswords — not the account password, which Google refuses over SMTP.',
    group: 'email',
    type: 'password',
    default: null,
    envVar: 'GMAIL_APP_PASSWORD',
    secret: true,
    applies: 'immediately',
  },
  {
    key: 'email.smtpHost',
    label: 'SMTP host',
    description: 'Server name, e.g. smtp.yourprovider.com.',
    group: 'email',
    type: 'string',
    default: null,
    envVar: 'SMTP_HOST',
    applies: 'immediately',
  },
  {
    key: 'email.smtpPort',
    label: 'SMTP port',
    description: '587 for STARTTLS, 465 for implicit TLS.',
    group: 'email',
    type: 'number',
    default: 587,
    envVar: 'SMTP_PORT',
    min: 1,
    max: 65535,
    applies: 'immediately',
  },
  {
    key: 'email.smtpUser',
    label: 'SMTP username',
    description: 'Leave blank if the server accepts unauthenticated relay from this host.',
    group: 'email',
    type: 'string',
    default: null,
    envVar: 'SMTP_USER',
    applies: 'immediately',
  },
  {
    key: 'email.smtpPassword',
    label: 'SMTP password',
    description: 'Stored encrypted and never shown again once saved.',
    group: 'email',
    type: 'password',
    default: null,
    envVar: 'SMTP_PASSWORD',
    secret: true,
    applies: 'immediately',
  },
  {
    key: 'email.smtpSecure',
    label: 'Use implicit TLS',
    description: 'On for port 465, off for 587 — 587 with STARTTLS is the usual choice. Getting this wrong is the most common reason an otherwise-correct SMTP setup refuses to connect.',
    group: 'email',
    type: 'boolean',
    default: false,
    envVar: 'SMTP_SECURE',
    applies: 'immediately',
  },
  {
    key: 'email.from',
    label: 'Sender name and address',
    description: 'What recipients see in the From line, e.g. FAPOMS <it@sumeruglobal.in>. Defaults to the account above.',
    group: 'email',
    type: 'string',
    default: null,
    envVar: 'EMAIL_FROM',
    applies: 'immediately',
  },
  {
    key: 'app.publicUrl',
    label: 'Application address',
    description: 'The address staff use to reach FAPOMS. Every link inside an email is built from it, so a wrong value here produces emails whose buttons go nowhere.',
    group: 'email',
    type: 'string',
    default: 'http://localhost:5173',
    envVar: 'APP_PUBLIC_URL',
    applies: 'immediately',
  },

  // ── SMS ─────────────────────────────────────────────────────────────────
  //
  // Read by SmsProvider (saved → environment → default, rebuilt on every save under `sms.`). India's
  // DLT rules are why there are more fields than a key: operators block any commercial text whose
  // sender header, Principal Entity and content template are not registered together.
  {
    key: 'sms.provider',
    label: 'SMS company',
    description: 'Which company sends the platform\'s text messages. Off sends no texts — one-time codes and sign-in details then go by email only. Choose Pinnacle once its API key and the details below are filled in.',
    group: 'sms',
    type: 'select',
    options: [
      { value: 'PINNACLE', label: 'Pinnacle' },
      { value: 'NONE', label: 'Off — send no texts' },
    ],
    default: 'NONE',
    // So a deployment can name its company in the environment beside the key, and the screen still
    // wins once somebody chooses there.
    envVar: 'SMS_PROVIDER',
    applies: 'immediately',
  },
  {
    key: 'sms.pinnacle.apiKey',
    label: 'Pinnacle API key',
    description: 'The key from your Pinnacle account, sent as the `apikey` header on every text. It works like a password: stored encrypted and never shown again once saved.',
    group: 'sms',
    type: 'password',
    default: null,
    envVar: 'SMS_PINNACLE_API_KEY',
    secret: true,
    applies: 'immediately',
  },
  {
    key: 'sms.senderId',
    label: 'Sender header',
    description: 'The 6-letter name texts arrive from, e.g. SUMERU — exactly as approved on your DLT portal under Headers. Texts sent under any other header are blocked by the phone companies. Must be exactly 6 letters.',
    group: 'sms',
    type: 'string',
    default: null,
    envVar: 'SMS_SENDER_ID',
    applies: 'immediately',
  },
  {
    key: 'sms.dltEntityId',
    label: 'DLT Principal Entity ID',
    description: 'Your company\'s ID from your DLT portal — a long number (usually 19 digits) shown on your DLT registration. Once this is filled in, every text must also carry its own DLT Template ID: add those under Email Templates → Text messages. Also link this ID to your sender header in the Pinnacle panel — it is set up there, not sent with each text.',
    group: 'sms',
    type: 'string',
    default: null,
    envVar: 'SMS_DLT_ENTITY_ID',
    applies: 'immediately',
  },
  {
    key: 'sms.templates',
    label: 'Text message wording',
    description: 'Edited wording and the DLT Template ID for each text the platform sends. Managed on the Text messages screen, which checks each one before saving.',
    group: 'sms',
    type: 'json',
    default: null,
    applies: 'immediately',
    // The wording is the business's, like the email templates; the gateway above is plumbing. The
    // Text messages screen that writes it is open to administrators, so the key must be too.
    audience: 'business',
  },

  // ── Schedules ───────────────────────────────────────────────────────────
  {
    key: 'digest.enabled',
    label: 'Send the morning brief',
    description: 'One email per person covering what is waiting on a decision. People with nothing waiting receive nothing.',
    group: 'schedule',
    type: 'boolean',
    default: true,
    applies: 'immediately',
  },
  {
    key: 'digest.cron',
    label: 'Morning brief schedule',
    description: 'Standard cron, read in India time. The default 30 8 * * 1-6 means 08:30, Monday to Saturday.',
    group: 'schedule',
    type: 'cron',
    default: '30 8 * * 1-6',
    envVar: 'EMAIL_DIGEST_CRON',
    applies: 'immediately',
  },

  // ── Fees ────────────────────────────────────────────────────────────────
  {
    key: 'fees.platformBaseFee',
    label: 'Default audit fee',
    description: 'Used only when neither the assayer’s contract nor the client’s rate card sets one. Contracted rates always win.',
    group: 'fees',
    type: 'number',
    default: 1200,
    min: 0,
    max: 1_000_000,
    unit: '₹',
    applies: 'immediately',
  },
  {
    key: 'fees.platformTravelPerKm',
    label: 'Default travel rate',
    description: 'The fallback per-kilometre rate when no client rate and no transport rate card applies.',
    group: 'fees',
    type: 'number',
    default: 8,
    min: 0,
    max: 10_000,
    unit: '₹/km',
    applies: 'immediately',
  },
  {
    key: 'fees.platformFreeTravelKm',
    label: 'Free commute allowance',
    description: 'Kilometres an assayer travels without being paid for the journey. Travel is '
      + 'charged only beyond this. Zero means charge from the first kilometre.',
    group: 'fees',
    type: 'number',
    /**
     * 50 km, because a branch inside an assayer's own city is their commute, not a journey the
     * company sends them on. At 10 km almost every audit carried a travel line — most of them
     * for a few rupees — and each one had to be quoted, agreed, carved out of the payable and
     * reconciled against a claim.
     *
     * A client's rate card still overrides this, so a contract that pays travel from the first
     * kilometre keeps doing so. Quotes already agreed are frozen and are not recalculated: an
     * assignment somebody accepted at a stated fee keeps that fee.
     */
    default: 50,
    min: 0,
    max: 1000,
    unit: 'km',
    applies: 'immediately',
  },
  {
    key: 'fees.flagMultiplier',
    label: 'Fee warning threshold',
    description: 'A quoted base fee above this multiple of the client’s reference rate is flagged for a human to look at. It is never blocked — a mis-typed contract rate becomes a visible warning instead of silently becoming money.',
    group: 'fees',
    type: 'number',
    default: 1.5,
    envVar: 'FEE_FLAG_MULTIPLIER',
    min: 1,
    max: 100,
    unit: '×',
    applies: 'immediately',
  },

  // ── Transport recommendation ─────────────────────────────────────────────
  //
  // Everything `TransportRateService.estimate()` needs beyond the rate card itself: how long
  // each way of travelling takes, when a mode is not sensible at all, and how cheapness is
  // traded against speed. All of these are ESTIMATES and POLICY, not measurements — there is no
  // free, reliable API for Indian rail or bus timetables and fares, and we refuse to invent or
  // scrape one. Road modes (car, taxi, auto, two-wheeler) get their time from the routing
  // engine when a route is supplied and only fall back to the speed here when it is not.
  //
  // Speeds are door-to-door averages, not top speeds. Indian Railways mail/express services
  // average roughly 50–60 km/h once station dwell is included (Rajdhani/Shatabdi are faster,
  // passenger trains far slower); interstate buses on Indian highways average 35–45 km/h; a
  // domestic jet cruises at ~800 km/h but taxi, climb and descent bring the airborne average
  // nearer 500 km/h over typical 600–1,500 km sectors, and the airport overhead below is what
  // actually dominates a flight's door-to-door time.
  {
    key: 'transport.avgSpeedKmh.CAR',
    label: 'Average speed — car',
    description: 'Used only when no road route is available for the journey; a routed journey uses the real drive time. Door-to-door average including town traffic, not the highway limit.',
    group: 'transport',
    type: 'number',
    default: 45,
    min: 1, max: 1000, unit: 'km/h',
    applies: 'immediately',
  },
  {
    key: 'transport.avgSpeedKmh.TAXI',
    label: 'Average speed — taxi',
    description: 'Same vehicle as a car; kept separate so a city where taxis crawl can say so. Used only when no road route is available.',
    group: 'transport',
    type: 'number',
    default: 45,
    min: 1, max: 1000, unit: 'km/h',
    applies: 'immediately',
  },
  {
    key: 'transport.avgSpeedKmh.TWO_WHEELER',
    label: 'Average speed — two-wheeler',
    description: 'Used only when no road route is available. Quicker than a car through town, slower on an open highway; 40 km/h is a fair middle.',
    group: 'transport',
    type: 'number',
    default: 40,
    min: 1, max: 1000, unit: 'km/h',
    applies: 'immediately',
  },
  {
    key: 'transport.avgSpeedKmh.AUTO_RICKSHAW',
    label: 'Average speed — auto-rickshaw',
    description: 'Used only when no road route is available. Autos live in town traffic; 25 km/h door to door is typical.',
    group: 'transport',
    type: 'number',
    default: 25,
    min: 1, max: 1000, unit: 'km/h',
    applies: 'immediately',
  },
  {
    key: 'transport.avgSpeedKmh.BUS',
    label: 'Average speed — bus',
    description: 'There is no reliable timetable feed for Indian buses, so journey time is the road distance at this speed. State transport and interstate coaches average 35–45 km/h with stops. An estimate — shown as one.',
    group: 'transport',
    type: 'number',
    default: 40,
    min: 1, max: 1000, unit: 'km/h',
    applies: 'immediately',
  },
  {
    key: 'transport.avgSpeedKmh.TRAIN',
    label: 'Average speed — train',
    description: 'There is no free, reliable timetable feed for Indian Railways, so journey time is the road distance at this speed. Mail/express services average 50–60 km/h door to door once halts are counted; raise it where Shatabdi/Vande Bharat cover the route. An estimate — shown as one.',
    group: 'transport',
    type: 'number',
    default: 55,
    min: 1, max: 1000, unit: 'km/h',
    applies: 'immediately',
  },
  {
    key: 'transport.avgSpeedKmh.FLIGHT',
    label: 'Average speed — flight (airborne)',
    description: 'Cruise speed averaged over take-off, climb and descent on a typical domestic sector. Airport time is added separately below — that, not the flying, is most of a flight’s door-to-door time.',
    group: 'transport',
    type: 'number',
    default: 500,
    min: 1, max: 1000, unit: 'km/h',
    applies: 'immediately',
  },
  {
    key: 'transport.avgSpeedKmh.OTHER',
    label: 'Average speed — other',
    description: 'For rate rows on the “Other” mode (ferry, shared jeep). A road-like guess; tune it if you actually price such a mode.',
    group: 'transport',
    type: 'number',
    default: 40,
    min: 1, max: 1000, unit: 'km/h',
    applies: 'immediately',
  },
  {
    key: 'transport.flightOverheadMinutes',
    label: 'Flight fixed overhead',
    description: 'Added to every flight leg on top of the airborne time: getting to the airport, check-in, security, boarding, baggage, and the transfer at the other end. Three hours is a realistic Indian domestic figure; it is what makes a 500 km flight lose to a 5-hour train.',
    group: 'transport',
    type: 'number',
    default: 180,
    min: 0, max: 600, unit: 'minutes',
    applies: 'immediately',
  },
  {
    key: 'transport.flightMinKm',
    label: 'Flights only from',
    description: 'A flight is not offered as a viable option for a journey shorter than this, one way. Below it the airport overhead swallows any time saved. The option is still shown, marked not viable, so the desk can see and override.',
    group: 'transport',
    type: 'number',
    default: 500,
    min: 0, max: 5000, unit: 'km',
    applies: 'immediately',
  },
  {
    key: 'transport.twoWheelerMaxKm',
    label: 'Two-wheeler at most',
    description: 'An own two-wheeler is not offered as viable beyond this distance one way. Riding 150 km each way is a full working day on the saddle before any audit begins. Still shown, marked not viable.',
    group: 'transport',
    type: 'number',
    default: 150,
    min: 0, max: 2000, unit: 'km',
    applies: 'immediately',
  },
  {
    key: 'transport.autoMaxKm',
    label: 'Auto-rickshaw at most',
    description: 'An auto-rickshaw is not offered as viable beyond this distance one way — autos are town transport and rarely leave it. Still shown, marked not viable.',
    group: 'transport',
    type: 'number',
    default: 40,
    min: 0, max: 500, unit: 'km',
    applies: 'immediately',
  },
  {
    key: 'transport.weightCost',
    label: 'Weight on cost',
    description: 'How much a mode’s cost counts when choosing the recommended one, against its journey time. Cost and time are each scaled 0–1 across the viable modes, then combined with these two weights; the lowest total wins. 0.6 cost / 0.4 time means a mode must save real time to justify costing more.',
    group: 'transport',
    type: 'number',
    default: 0.6,
    min: 0, max: 1, unit: '×',
    applies: 'immediately',
  },
  {
    key: 'transport.weightTime',
    label: 'Weight on time',
    description: 'The other half of the balance above. Set cost 1 / time 0 to recommend the cheapest viable mode regardless of how long it takes — the behaviour before journey time was considered at all.',
    group: 'transport',
    type: 'number',
    default: 0.4,
    min: 0, max: 1, unit: '×',
    applies: 'immediately',
  },

  // ── Billing ─────────────────────────────────────────────────────────────
  {
    key: 'billing.tdsRate',
    label: 'TDS we withhold from assayer payments',
    description: 'Withholding tax deducted from what field workers are paid. Applies to payables created from now on; existing payables keep the rate they were booked at.',
    group: 'billing',
    type: 'number',
    default: 10,
    min: 0,
    max: 100,
    unit: '%',
    applies: 'immediately',
  },
  {
    key: 'billing.tdsRateNoPan',
    label: 'TDS when the assayer has no PAN on file',
    description: 'Section 206AA: payments to a deductee who has not furnished a PAN must be withheld at a higher rate (20%) instead of the normal one. Applied automatically whenever a payable is booked for an assayer whose PAN is missing; add their PAN on the roster to return them to the normal rate.',
    group: 'billing',
    type: 'number',
    default: 20,
    min: 0,
    max: 100,
    unit: '%',
    applies: 'immediately',
  },
  {
    key: 'billing.tdsSection',
    label: 'TDS section quoted on statements',
    description: 'The Income-tax Act section the TDS you withhold from field workers is deducted under, printed on the PAN-wise TDS report. Payments to auditors for professional/technical work are usually 194J (10%); use 194C for payments to contractors. This is a label only — it does not change the amount withheld.',
    group: 'billing',
    type: 'select',
    options: [
      { value: '194J', label: '194J — professional / technical services' },
      { value: '194C', label: '194C — payments to contractors' },
      { value: '194H', label: '194H — commission or brokerage' },
    ],
    default: '194J',
    applies: 'immediately',
  },
  {
    key: 'billing.defaultClientGstRate',
    label: 'GST added to client invoices',
    description: 'Used only when a client has no billing profile of its own. What we charge the client, not what we withhold from an assayer.',
    group: 'billing',
    type: 'number',
    default: 18,
    min: 0,
    max: 100,
    unit: '%',
    applies: 'immediately',
  },
  {
    key: 'billing.defaultClientTdsRate',
    label: 'TDS the client withholds from us',
    description: 'Used only when a client has no billing profile of its own. The mirror of the setting above: what a client deducts before paying our invoice.',
    group: 'billing',
    type: 'number',
    default: 10,
    min: 0,
    max: 100,
    unit: '%',
    applies: 'immediately',
  },
  {
    key: 'expense.maxSingleClaim',
    label: 'Largest single expense claim',
    description: 'A claim above this is refused at submission, so a mistyped amount is caught in the field rather than in an approval queue.',
    group: 'billing',
    type: 'number',
    default: 50_000,
    min: 0,
    max: 10_000_000,
    unit: '₹',
    applies: 'immediately',
  },


  // ── Support SLA ────────────────────────────────────────────────────────
  // These were readable only as environment variables, evaluated once at import. The people who
  // own the response commitment are the product team, not whoever can restart a container.
  {
    key: 'feedback.firstResponseHours',
    label: 'First response due within',
    description: 'How long a new message may sit unanswered before it escalates. Measured from when it was raised, not from when someone opened it.',
    group: 'feedback',
    type: 'number',
    default: 24,
    envVar: 'FEEDBACK_FIRST_RESPONSE_SLA_HOURS',
    min: 1, max: 720, unit: 'hours',
    applies: 'immediately',
  },
  {
    key: 'feedback.resolveCriticalHours',
    label: 'Resolve critical within',
    description: 'Something is broken and blocking work. The tightest of the four resolution clocks.',
    group: 'feedback',
    type: 'number',
    default: 8,
    envVar: 'FEEDBACK_RESOLUTION_CRITICAL_SLA_HOURS',
    min: 1, max: 720, unit: 'hours',
    applies: 'immediately',
  },
  {
    key: 'feedback.resolveHighHours',
    label: 'Resolve high within',
    description: 'Painful but there is a way around it.',
    group: 'feedback',
    type: 'number',
    default: 24,
    envVar: 'FEEDBACK_RESOLUTION_HIGH_SLA_HOURS',
    min: 1, max: 720, unit: 'hours',
    applies: 'immediately',
  },
  {
    key: 'feedback.resolveMediumHours',
    label: 'Resolve medium within',
    description: 'Worth fixing, not worth interrupting anyone for.',
    group: 'feedback',
    type: 'number',
    default: 72,
    envVar: 'FEEDBACK_RESOLUTION_MEDIUM_SLA_HOURS',
    min: 1, max: 2160, unit: 'hours',
    applies: 'immediately',
  },
  {
    key: 'feedback.resolveLowHours',
    label: 'Resolve low within',
    description: 'Ideas and small annoyances. A week by default.',
    group: 'feedback',
    type: 'number',
    default: 168,
    envVar: 'FEEDBACK_RESOLUTION_LOW_SLA_HOURS',
    min: 1, max: 8760, unit: 'hours',
    applies: 'immediately',
  },

  // ── Field rules ─────────────────────────────────────────────────────────
  {
    key: 'field.checkInGeofenceMeters',
    label: 'Check-in must be within',
    description: 'How close to the branch an assayer must be to check in. GPS accuracy is added on top of this, so a poor fix is not treated as being in the wrong place. Too tight and honest workers are locked out of their own job; too loose and check-in stops being evidence of attendance.',
    group: 'field',
    type: 'number',
    default: 2000,
    envVar: 'CHECK_IN_GEOFENCE_METERS',
    min: 50, max: 50_000, unit: 'metres',
    applies: 'immediately',
  },
  {
    key: 'field.arrivalRadiusMeters',
    label: 'The app treats them as arrived within',
    description: 'How close to the branch the phone must be before the app treats the assayer as having arrived — that is when it offers them the Check in button and notes their arrival time. It only decides when the app speaks up: checking in is still allowed anywhere inside the check-in distance above. If this is set larger than that distance, the check-in distance is used.',
    group: 'field',
    type: 'number',
    default: 200,
    min: 25, max: 2000, unit: 'metres',
    applies: 'immediately',
  },
  // The arrival-time rule (owner decision 2026-09-24): when the phone's own "I arrived at" time is
  // written as the check-in time instead of the moment the server received it. Both keys are read
  // through the constants in `@fapoms/shared` check-in-rules.ts, which also hold the defaults.
  {
    key: 'field.checkInArrivalMaxAgeHours',
    label: 'Accept the phone\'s arrival time for up to',
    description: 'When an assayer checks in from somewhere with no signal, the check-in reaches us late. The app also sends the time the phone actually arrived, and we record that instead — but only if it is the same day, no older than this, and the phone\'s location history shows it at the branch around then. Anything older is recorded at the time it reached us. Set it lower to trust late check-ins less; the location-history check applies either way.',
    group: 'field',
    type: 'number',
    default: 4,
    min: 0, max: 24, unit: 'hours',
    applies: 'immediately',
  },
  {
    key: 'field.checkInArrivalTrailWindowMinutes',
    label: 'Location history must show them at the branch within',
    description: 'To accept the phone\'s arrival time, its location history must have a reading inside the check-in zone this close to that time, before or after. Wider accepts phones that record their position less often; narrower makes the arrival time harder to claim without really being there.',
    group: 'field',
    type: 'number',
    default: 15,
    min: 1, max: 120, unit: 'minutes',
    applies: 'immediately',
  },
  // `field.maxNegotiationRounds` and `field.maxCounterOfferTravelFee` lived here until in-app
  // fee negotiation was removed. Their orphaned DB rows are left in place (harmless, historical);
  // the limits endpoint still answers `maxNegotiationRounds: 0` as the old-APK kill-switch — see
  // platform-settings.controller.ts.
  {
    /**
     * The rollout gate for assayer invoicing — the flow where an assayer, invited by the desk,
     * first SEES the fees for their completed work, submits them as one invoice, and gains
     * visible earnings once they have sent it (owner decision 2026-09-24; it was once the desk's
     * approval). Off (the default) keeps the assayer's
     * statement in its full pre-gate shape and hides every invite control, so the code can ship
     * dark and the switch is flipped only once the mobile build that renders the invitation
     * states is distributed. Old apps degrade safely either way — the gated statement is a
     * strict subset plus one optional block — but flipping early would show assayers fewer
     * rows with no way to act on them yet.
     */
    key: 'billing.assayerInvoicingEnabled',
    label: 'Assayer invoicing',
    description: 'The invoicing round, which is how assayers are paid: the desk invites them to review and submit their unbilled completed work as an invoice, fees become visible to them only inside that review, and their earnings appear as soon as they send the invoice. On by default, because this IS the payment flow. Switch it off only for a deployment whose field app predates the invoicing round — assayers there will not see their fees at all.',
    group: 'billing',
    type: 'boolean',
    default: true,
    // Stays the Developer's, though it sits in a business group. It reads like a business dial
    // and is not one: switching it off does not change a policy, it withdraws the only surface on
    // which an assayer can ever see what they are owed. The rollout it once gated is finished —
    // the default is ON — so what remains is a compatibility escape hatch for an estate still on
    // an older field app, which is a deployment decision, not an everyday one.
    audience: 'technical',
    applies: 'immediately',
  },

  // ── Access boundaries ─────────────────────────────────────────────────────
  {
    // Read by RegionGuardService.assertRegionAllowedStaged and by each of the six modules that
    // adopt it (document, billing-engine, expense, customer-master, validation-query, client) —
    // the ones that had NO region boundary at all until this rollout. Every OTHER module that
    // already called the region ceiling (branch, assignment, project, planning, scheduling,
    // assayer, reports, search, system-dashboard) is untouched by this setting: their check was
    // already correct and unconditional, and stays that way regardless of this value.
    key: 'onboarding.identityGate.mode',
    label: 'Identity check before activation',
    description: 'Whether an appraiser can be activated before their identity documents have been '
      + 'checked against the originals. "Enforce" refuses to move anyone from Training to Active '
      + 'until their Aadhaar and PAN are verified — so the person who values a vault of pledged '
      + 'gold is somebody the company has actually identified. "Warn" runs the same check, records '
      + 'what it would have refused, and lets the activation through; that is the DEFAULT, because '
      + 'on the day this shipped not one document in the estate had ever been verified and '
      + 'enforcing immediately would have blocked every new joiner against a process the desk had '
      + 'never operated once. Move it to Enforce as soon as the identity queue on the roster is '
      + 'being worked. "Off" skips the check entirely. Nothing here stops work already assigned, '
      + 'and no earlier joining stage is affected. Background verification is NOT governed by this '
      + 'switch: a clear check and its uploaded report are always required to finish onboarding.',
    group: 'onboarding',
    type: 'select',
    options: [
      { value: 'off', label: 'Off — no check' },
      { value: 'warn', label: 'Warn — record what would be refused, activate anyway' },
      { value: 'enforce', label: 'Enforce — refuse to activate an unverified person' },
    ],
    /**
     * Warn, not enforce, and the difference is a backlog rather than a principle.
     *
     * `security.regionScope.mode` below shipped as 'log' for exactly this reason and earned
     * 'enforce' after an observation phase. This is the same rollout against a much larger
     * backlog — 1,163 people and, on the day it shipped, not one verified document anywhere.
     * Enforcing from the first boot would refuse every activation in the company against a process
     * nobody had run once, which is how a control gets switched off permanently instead of adopted.
     */
    default: 'warn',
    envVar: 'IDENTITY_GATE_MODE',
    applies: 'immediately',
  },
  // ── Checks done over time (2026-09-23) ──────────────────────────────────
  // Read by ComplianceStandingService on every read — a change applies to the next person looked
  // at, the next planning run and the next reminder sweep. See periodic-checks.ts in shared.
  {
    key: 'recheck.bgv.intervalMonths',
    label: 'Background verification — repeat every',
    description: 'How many months after the last background verification a working appraiser is due for the next one. '
      + 'HR is reminded before it falls due; once it is overdue past the grace period below, they are '
      + 'held from new work until it is done. Work already assigned is never affected.',
    group: 'rechecks',
    type: 'number',
    default: 24,
    min: 1,
    max: 120,
    unit: 'months',
    applies: 'immediately',
  },
  {
    key: 'recheck.police.intervalMonths',
    label: 'Police verification — repeat every',
    description: 'How many months after the last police verification a working appraiser is due for the next one. '
      + 'HR is reminded before it falls due; once it is overdue past the grace period below, they are '
      + 'held from new work until it is done. Work already assigned is never affected.',
    group: 'rechecks',
    type: 'number',
    default: 12,
    min: 1,
    max: 120,
    unit: 'months',
    applies: 'immediately',
  },
  {
    key: 'recheck.credit.intervalMonths',
    label: 'Credit (CIBIL) check — repeat every',
    description: 'How many months after the last credit check a working appraiser is due for the next one. '
      + 'HR is reminded before it falls due; once it is overdue past the grace period below, they are '
      + 'held from new work until it is done. Work already assigned is never affected.',
    group: 'rechecks',
    type: 'number',
    default: 12,
    min: 1,
    max: 120,
    unit: 'months',
    applies: 'immediately',
  },
  {
    key: 'recheck.identity.intervalMonths',
    label: 'Identity documents re-check — repeat every',
    description: 'How many months after the last identity-documents re-check a working appraiser is due for the next one. '
      + 'HR is reminded before it falls due; once it is overdue past the grace period below, they are '
      + 'held from new work until it is done. Work already assigned is never affected.',
    group: 'rechecks',
    type: 'number',
    default: 24,
    min: 1,
    max: 120,
    unit: 'months',
    applies: 'immediately',
  },
  {
    key: 'recheck.graceDays',
    label: 'Re-check grace period',
    description: 'Days after a re-check falls due before the appraiser is held from new work. During '
      + 'these days they keep working and HR is reminded; after them, planning will not offer them and '
      + 'no new assignment can be created for them until the check is recorded.',
    group: 'rechecks',
    type: 'number',
    default: 30,
    min: 0,
    max: 365,
    unit: 'days',
    applies: 'immediately',
  },
  {
    key: 'recheck.remindDaysBefore',
    label: 'Re-check reminder lead time',
    description: 'How many days before a re-check falls due HR starts being reminded about it.',
    group: 'rechecks',
    type: 'number',
    default: 30,
    min: 0,
    max: 180,
    unit: 'days',
    applies: 'immediately',
  },
  {
    key: 'recheck.firstRoundDueOn',
    label: 'First re-check due by (YYYY-MM-DD)',
    description: 'For a working appraiser who has never had a given check recorded, the date that '
      + 'first check falls due. The roster predates these checks, so this is a date you choose rather '
      + 'than "today" — otherwise the whole field would be held from work after one grace period.',
    group: 'rechecks',
    type: 'string',
    default: '2026-12-31',
    applies: 'immediately',
  },
  {
    // Read by RosterRecordsService.idCardIssuance, computed fresh on every download — a card is
    // never stored, so changing this changes the next card printed, not any card already printed.
    key: 'onboarding.idCard.validityMode',
    label: 'ID card validity rule',
    description: 'How long a printed appraiser ID card is valid. "Calendar year" expires every '
      + 'card on December 31st, so the whole field re-issues on one known day — with the grace '
      + 'window below protecting late-year joiners. "Rolling months" gives each card the same '
      + 'length of validity from its own issue date, at the cost of expiries spread across the '
      + 'year. The card prints its issue date and its valid-until date; validity is computed at '
      + 'download time, never stored.',
    group: 'onboarding',
    type: 'select',
    options: [
      { value: 'CALENDAR_YEAR', label: 'Calendar year — every card expires December 31st' },
      { value: 'ROLLING_MONTHS', label: 'Rolling — a fixed number of months from issue' },
    ],
    default: 'CALENDAR_YEAR',
    envVar: 'ID_CARD_VALIDITY_MODE',
    applies: 'immediately',
  },
  {
    key: 'onboarding.idCard.rollingMonths',
    label: 'ID card validity (months, rolling mode)',
    description: 'Rolling mode only: how many months from the issue date a card stays valid. '
      + 'Ignored under the calendar-year rule.',
    group: 'onboarding',
    type: 'number',
    default: 12,
    envVar: 'ID_CARD_ROLLING_MONTHS',
    applies: 'immediately',
  },
  {
    key: 'onboarding.idCard.graceDays',
    label: 'ID card year-end grace window (days)',
    description: 'Calendar-year mode only. A card issued with fewer than this many days left in '
      + 'the year is made valid to December 31st of the NEXT year instead — otherwise somebody '
      + 'joining on December 31st would be handed a card that expires the same day. Set to 0 to '
      + 'disable the grace and expire strictly on December 31st of the issue year.',
    group: 'onboarding',
    type: 'number',
    default: 45,
    envVar: 'ID_CARD_GRACE_DAYS',
    applies: 'immediately',
  },
  {
    key: 'security.regionScope.mode',
    label: 'New region boundaries: rollout mode',
    description: 'Six screens (documents, billing, expenses, customer master, validation queries, clients) had no region boundary at all — a region-restricted account could read every region\'s rows through them. "Enforce" (the default) refuses a cross-region read, exactly as every other screen already does. "Log" runs the same check but only records what it would have refused, letting the request through — use it TEMPORARILY if a data-quality problem is causing false refusals and you need to watch real traffic before tightening. "Off" skips the check entirely. An account with no region assignment is unrestricted and is unaffected by any mode, so enforcing is safe wherever staff are national by default.',
    group: 'security',
    type: 'select',
    options: [
      { value: 'off', label: 'Off — no check, no log' },
      { value: 'log', label: 'Log — record what would be refused, refuse nothing' },
      { value: 'enforce', label: 'Enforce — actually refuse' },
    ],
    // Enforce by default. This shipped as 'log' during rollout; the observation phase is complete —
    // a SOUTH-scoped account was confirmed reading WEST records through all six screens under 'log',
    // and enforce was confirmed to leave unrestricted (region=NULL) and correctly-scoped accounts
    // untouched. A fail-open access boundary must not be the default a fresh deployment inherits.
    default: 'enforce',
    envVar: 'REGION_SCOPE_MODE',
    applies: 'immediately',
  },
  {
    // Read by BillingEngineService.approvePayouts (approver vs. the ASSIGNMENT's creator — the
    // person who booked the work, not the automated on-completion event that usually creates the
    // payable itself) and .recordDisbursement (disburser vs. payable.approvedBy, already on the
    // row). BILLING_ROLES and DISBURSEMENT_ROLES are the identical set today — see
    // billing-roles.ts — so this is the only technical control standing between "one person books
    // an audit, approves the resulting payout, and pays it" and that not being possible.
    //
    // ENFORCE by default, since 2026-09-09. It shipped 'off', and because no row was ever written
    // to `platform_settings` the check was simply not running anywhere: certification had one
    // OPERATIONS account approve a payable and then pay it, 122 ms apart, both HTTP 201.
    //
    // The comment that stood here justified the 'off' default like this: "With two people on the
    // roles today, Enforce would mean neither could ever pay the other's work." That is the wrong
    // way round, and it is the whole reason the control was never switched on.
    // `assertSegregationOfDuties` refuses one thing: the SAME account id on both sides. Two people
    // is exactly the number Enforce needs — A approves, B pays, and each may pay the other's work.
    // What Enforce refuses is one person doing both. (The premise was also out of date: four
    // active accounts hold ADMIN or OPERATIONS on this deployment, five counting the developer who
    // reaches them through the ADMIN implication in role-hierarchy.ts.)
    //
    // Three things settle the default, all of them already in the codebase:
    //  • `expense.service.ts` refuses the raiser of an expense claim their own approval —
    //    unconditionally, no setting — because "approving writes an assayer_payables row — money
    //    out". Payout approval writes the same row for the same reason and was the one left
    //    configurable.
    //  • `security.regionScope.mode` above shipped 'log', ran its observation phase and moved to
    //    'enforce' on the stated principle that "a fail-open access boundary must not be the
    //    default a fresh deployment inherits". This is that same class of boundary, over money.
    //  • `security-defaults.spec.ts` opens by saying TWO security settings are boundaries whose
    //    absence is silent and that it pins their safe defaults; it pinned one. This is the other.
    //
    // 'warn' and 'off' remain for the deployment genuinely run by one person, where a maker-checker
    // split would stop payouts altogether — but that is now a deliberate, recorded change by a
    // Developer on the settings screen, not the posture every installation silently inherits.
    key: SEGREGATION_OF_DUTIES_SETTING_KEY,
    label: 'Payout maker-checker: rollout mode',
    description: 'Stops one person booking a completed audit, approving its payout and paying it — the separation expense claims already enforce for the same act (the raiser of a claim cannot approve it). "Enforce" (the DEFAULT) refuses the same account on both sides: whoever booked the assignment cannot approve its payout, and whoever approved a payout cannot be the one who marks it paid. It does not need a big team — two accounts are enough, each approving the other\'s work — and every refusal is written to the audit trail. "Warn" records the same-person cases and lets them through, for watching real traffic before tightening. "Off" skips the check entirely: appropriate only where one person genuinely runs the whole payout process alone, and it means nothing stands between that person and paying themselves.',
    group: 'security',
    type: 'select',
    options: [
      { value: 'off', label: 'Off — no check, no warning' },
      { value: 'warn', label: 'Warn — record same-person approvals, block nothing' },
      { value: 'enforce', label: 'Enforce — actually refuse' },
    ],
    default: 'enforce',
    envVar: 'SEGREGATION_OF_DUTIES_MODE',
    applies: 'immediately',
  },
  {
    // Enforced on EVERY authenticated request (SessionService.touchIfUsable), not only on refresh —
    // so an inactive session becomes unusable, it does not merely fail to renew. "Idle" is measured
    // from the last authenticated request. 0 disables the idle arm (absolute + revocation still bite).
    key: 'security.session.idleTimeoutMinutes',
    label: 'Session idle timeout',
    description: 'Sign a session out after this many minutes with NO activity at all. An open app in active use keeps itself alive (every request and token refresh resets the clock), so this only ends a session that has gone completely quiet — a laptop left logged in and walked away from. DEFAULT 0 (off) so nobody is ever logged out in the middle of their work; raise it (e.g. 30–60) only if you want an abandoned-but-open device to expire on its own, accepting that a long on-screen pause with no requests could then log someone out. The absolute limit below and "log out all devices" bound a stolen session without this.',
    group: 'security',
    type: 'number',
    default: 0,
    envVar: 'SESSION_IDLE_TIMEOUT_MINUTES',
    min: 0,
    max: 43200,
    unit: 'minutes',
    // Read from the environment at boot by AuthService (the per-request hot path deliberately does
    // not couple to the live settings store), so a change needs a restart to take effect.
    applies: 'restart',
  },
  {
    // The session's absolute lifetime, set as `expires_at` when the session is minted and never
    // extended by a refresh — so a session cannot outlive this no matter how actively it is used.
    // This is the cap that bounds an actively-exploited stolen session.
    key: 'security.session.absoluteHours',
    label: 'Session absolute lifetime',
    description: 'The longest a single sign-in may last before a full re-login is required, regardless of activity — the hard ceiling on how long a stolen but actively-used session can live (the idle timeout cannot cap that, since activity keeps resetting it). Default 168h (7 days): a weekly boundary that falls in a natural gap rather than mid-work. Lower it for a tighter stolen-session cap, accepting that a shorter value can force a re-login while someone is still working. Applies to sessions created after the change.',
    group: 'security',
    type: 'number',
    default: 168,
    envVar: 'SESSION_ABSOLUTE_HOURS',
    min: 1,
    max: 8760,
    unit: 'hours',
    // Applied when a session is minted; read from the environment at boot (see idle timeout above).
    applies: 'restart',
  },

  // ── Retention ───────────────────────────────────────────────────────────
  {
    key: 'locationTrail.retentionDays',
    label: 'Keep movement records for',
    description: 'How long the GPS trail behind travel claims is kept. Blank keeps it indefinitely — deliberately, because how long to hold continuous movement records of identifiable people is an employment and data-protection decision, not a technical one. Set it once that decision is made.',
    group: 'retention',
    type: 'number',
    default: null,
    envVar: 'LOCATION_TRAIL_RETENTION_DAYS',
    min: 1,
    max: 3650,
    unit: 'days',
    applies: 'next-run',
  },
  {
    key: 'retention.sessionHistoryDays',
    label: 'Keep login/session history for',
    description: 'How long ended (signed-out or expired) login sessions are kept for the sessions & devices history. Blank keeps them indefinitely. The law sets a FLOOR, not a ceiling: a value below 180 days (the CERT-In minimum for access logs) is raised to 180 automatically. Live sessions are never removed, whatever this is set to.',
    group: 'retention',
    type: 'number',
    default: null,
    envVar: 'SESSION_HISTORY_RETENTION_DAYS',
    min: 1,
    max: 3650,
    unit: 'days',
    applies: 'next-run',
  },
  /*
    The two knobs below govern PERSONAL DATA, not logs, so their descriptions say "deleted" rather
    than "kept": what they control is a promise made to candidates in the consent notice, and an
    administrator lengthening one is deciding to hold somebody's Aadhaar scan for longer.
  */
  {
    key: 'retention.closedApplicationDays',
    label: 'Delete rejected and withdrawn applications after',
    description: 'How long a candidate application is kept once it has been rejected or withdrawn, after which their answers are erased and their uploaded scans are deleted. The consent notice promises candidates twelve months, so 365 is the default — changing this changes what you have told them in writing. 0 keeps them indefinitely, which is a decision to hold identity documents for people you turned down.',
    group: 'retention',
    type: 'number',
    default: null,
    envVar: 'CLOSED_APPLICATION_RETENTION_DAYS',
    min: 1,
    max: 3650,
    unit: 'days',
    applies: 'next-run',
  },
  {
    key: 'retention.abandonedApplicationDays',
    label: 'Delete never-submitted applications after',
    description: 'How long an unsubmitted registration form is kept after its invite link expires, after which anything typed into it is erased and any scans uploaded are deleted. Nobody applied, so there is nothing to keep — the default is 90 days. 0 keeps them indefinitely.',
    group: 'retention',
    type: 'number',
    default: null,
    envVar: 'ABANDONED_APPLICATION_RETENTION_DAYS',
    min: 1,
    max: 3650,
    unit: 'days',
    applies: 'next-run',
  },
  {
    key: 'retention.uiTelemetryDays',
    label: 'Keep UI activity telemetry for',
    description: 'How long fine-grained UI interaction telemetry (page views, clicks, filters) is kept. Unlike the other records this is analytics, not evidence, so it is purged by default on a short window in the spirit of data-minimisation. Blank uses that default; a value below 90 days is raised to 90; 0 keeps it indefinitely.',
    group: 'retention',
    type: 'number',
    default: null,
    envVar: 'UI_TELEMETRY_RETENTION_DAYS',
    min: 1,
    max: 3650,
    unit: 'days',
    applies: 'next-run',
  },

  // ── Data protection (DPDP) ─────────────────────────────────────────────────
  {
    key: 'dpdp.grievanceOfficerName',
    label: 'Grievance Officer / DPO name',
    description: 'The person a Data Principal contacts about their personal data. DPDP requires this contact to be published; it appears wherever the platform surfaces a privacy contact.',
    group: 'dpdp',
    type: 'string',
    default: null,
    applies: 'immediately',
  },
  {
    key: 'dpdp.grievanceOfficerEmail',
    label: 'Grievance Officer / DPO email',
    description: 'The email address for data-protection grievances and rights requests.',
    group: 'dpdp',
    type: 'string',
    default: null,
    applies: 'immediately',
  },
  {
    key: 'dpdp.grievanceOfficerPhone',
    label: 'Grievance Officer / DPO phone',
    description: 'A contact number for data-protection grievances (optional).',
    group: 'dpdp',
    type: 'string',
    default: null,
    applies: 'immediately',
  },
  {
    key: 'dpdp.rightsRequestSlaDays',
    label: 'Rights-request response SLA',
    description: 'How many days the platform has to answer a Data Principal rights request (access, correction, erasure, grievance) before it is flagged overdue. Industry standard is 30 days.',
    group: 'dpdp',
    type: 'number',
    default: 30,
    min: 1,
    max: 90,
    unit: 'days',
    applies: 'immediately',
  },
  // The four below are plumbing, not policy — how many rows one internal read pulls before
  // rendering — so they carry the group's own `dpdp` home (this IS where they're read from) but
  // an `audience: 'technical'` override, the same mechanism `billing.assayerInvoicingEnabled`
  // uses to sit in a business group while staying the Developer's to flip. No route accepts a
  // `?limit=` for any of the four reads these cap; each was a bare `take:` no query parameter
  // could reach, hence a setting instead of a pipe.
  {
    key: 'dpdp.securityIncidentListCap',
    label: 'Security incident list size',
    description: 'How many security incidents the incident register shows at once, newest first.',
    group: 'dpdp',
    type: 'number',
    default: 500,
    min: 50,
    max: 5000,
    unit: 'rows',
    applies: 'immediately',
    audience: 'technical',
  },
  {
    key: 'dpdp.securityIncidentSummaryScanCap',
    label: 'Security incident summary scan size',
    description: 'How many incident rows the compliance-health summary counts over (open, overdue by clock) before it stops. Raise it only if the incident register itself is expected to exceed this many rows.',
    group: 'dpdp',
    type: 'number',
    default: 2000,
    min: 500,
    max: 20000,
    unit: 'rows',
    applies: 'immediately',
    audience: 'technical',
  },
  {
    key: 'dpdp.rightsRequestListCap',
    label: 'Rights-request list size',
    description: 'How many rights requests the register shows at once, newest first.',
    group: 'dpdp',
    type: 'number',
    default: 500,
    min: 50,
    max: 5000,
    unit: 'rows',
    applies: 'immediately',
    audience: 'technical',
  },
  {
    key: 'dpdp.rightsRequestSummaryScanCap',
    label: 'Rights-request summary scan size',
    description: 'How many rights-request rows the compliance-health summary counts over (open, overdue by SLA) before it stops. Raise it only if the register itself is expected to exceed this many rows.',
    group: 'dpdp',
    type: 'number',
    default: 2000,
    min: 500,
    max: 20000,
    unit: 'rows',
    applies: 'immediately',
    audience: 'technical',
  },

  // ── Planning ────────────────────────────────────────────────────────────
  {
    // Read by RecommendationEngine once per recommendation for the `fairness` dimension —
    // see modules/assayer-remarks/assayer-remark.contract.ts (DEFAULT_FAIRNESS_OFFER_CAP).
    key: 'planning.fairnessOfferCap',
    label: 'Rotation: offers before "well used"',
    description: 'How many offers in the last 30 days it takes for an assayer to score zero on the rotation-fairness dimension. Below this the score falls off gradually; at or above it the person is treated as fully used for the month. This is a gentle nudge worth 4% of a recommendation, not a quota — a strong assayer still wins on merit, they just stop winning every tie. Lower it to spread work more aggressively; raise it to let proven people take more.',
    group: 'planning',
    type: 'number',
    default: 8,
    envVar: 'PLANNING_FAIRNESS_OFFER_CAP',
    min: 1, max: 100, unit: 'offers / 30 days',
    applies: 'immediately',
  },
  {
    // Read by ClientEligibilityFilter (one settings read per recommendation, preloaded into
    // branch facts). The empanelment gate itself is not configurable — ACTIVE and RECOMMENDED
    // standings qualify, negative standings exclude, always. This knob decides only the
    // in-between case: a person with NO empanelment record for the client at all.
    key: 'planning.eligibility.noEmpanelmentRow',
    label: 'Assayer with no empanelment record',
    description: 'What planning does with an assayer who has no recorded standing with the client being staffed. "Block" is compliance-strict: only people vetted for that specific bank (standing Active or Recommended) are ever recommended, and everyone else appears in the excluded list with the reason. "Allow" treats an absent record as no objection — useful only while a new client\'s vetting is still being backfilled. People whose standing with the client is negative (rejected, terminated, resigned, dormant or not recommended) are excluded under either setting.',
    group: 'planning',
    type: 'select',
    default: 'BLOCK',
    envVar: 'PLANNING_NO_EMPANELMENT_ROW',
    options: [
      { value: 'BLOCK', label: 'Block — only vetted standings are planned (strict)' },
      { value: 'ALLOW', label: 'Allow — an absent record does not exclude' },
    ],
    applies: 'immediately',
  },

  // ── Roster import ───────────────────────────────────────────────────────
  {
    // Read by RosterImportService once per import run.
    key: 'roster.autoCreateClients',
    label: 'Create missing clients automatically',
    description: 'When the roster names a bank that is not a client in this system yet ("Project Name" lists ~20 lenders), create the client on the spot with minimal details and link the appraisers to it, instead of dropping the fact and asking you to create the client and re-import. Created clients are named in the import summary so you can complete their details. Matching is careful — known misspellings are corrected first, and a name that could mean two existing clients creates nothing and asks instead. Turn off to restore the old behavior: unknown banks are only counted in the summary.',
    group: 'roster',
    type: 'boolean',
    default: true,
    envVar: 'ROSTER_AUTO_CREATE_CLIENTS',
    applies: 'immediately',
  },

  // ── Assayer qualification ───────────────────────────────────────────────
  //
  // The relative weights of the profile-score dimensions (see packages/shared
  // assayer-qualification.ts for what each measures, and qualification-score.contract.ts for
  // the formulas). Relative, not percentages: the mean is normalized over whichever dimensions
  // actually have data, so an unvetted person is scored on what is known rather than punished
  // for what nobody has recorded yet.
  {
    key: 'qualification.weight.identityVerification',
    label: 'Weight: identity verification',
    description: 'How heavily the verified-identity-paperwork dimension counts in the overall qualification score.',
    group: 'qualification', type: 'number', default: 20, min: 0, max: 100, applies: 'immediately',
  },
  {
    key: 'qualification.weight.payability',
    label: 'Weight: record completeness',
    description: 'How heavily the critical-record-fields dimension (phone, PAN, bank, location) counts.',
    group: 'qualification', type: 'number', default: 15, min: 0, max: 100, applies: 'immediately',
  },
  {
    key: 'qualification.weight.backgroundCheck',
    label: 'Weight: background check',
    description: 'How heavily the background-check verdict and risk grade count.',
    group: 'qualification', type: 'number', default: 25, min: 0, max: 100, applies: 'immediately',
  },
  {
    key: 'qualification.weight.references',
    label: 'Weight: references',
    description: 'How heavily checked references count.',
    group: 'qualification', type: 'number', default: 10, min: 0, max: 100, applies: 'immediately',
  },
  {
    key: 'qualification.weight.credentials',
    label: 'Weight: skills & certifications',
    description: 'How heavily recorded skills and current certifications count.',
    group: 'qualification', type: 'number', default: 15, min: 0, max: 100, applies: 'immediately',
  },
  {
    key: 'qualification.weight.trackRecord',
    label: 'Weight: track record',
    description: 'How heavily completed work, punctuality, acceptance behaviour and staff remarks count.',
    group: 'qualification', type: 'number', default: 15, min: 0, max: 100, applies: 'immediately',
  },
  {
    key: 'qualification.weight.partnerRequirements',
    label: 'Weight: partner requirements',
    description: "On a per-partner score only: how heavily meeting that partner's own required skills and certifications counts.",
    group: 'qualification', type: 'number', default: 25, min: 0, max: 100, applies: 'immediately',
  },
  {
    key: 'qualification.referencesTarget',
    label: 'References for full marks',
    description: 'How many CHECKED referees earn the full references score. Referees recorded but never called count for nothing.',
    group: 'qualification', type: 'number', default: 2, min: 1, max: 10, unit: 'checked referees', applies: 'immediately',
  },
  {
    key: 'qualification.cap.negativeStanding',
    label: 'Score ceiling: negative standing',
    description: 'The most a partner score can show while that partner\'s empanelment is REJECTED, TERMINATED or NOT RECOMMENDED. A ceiling, never a floor.',
    group: 'qualification', type: 'number', default: 25, min: 0, max: 100, applies: 'immediately',
  },
  {
    key: 'qualification.cap.dormantStanding',
    label: 'Score ceiling: dormant standing',
    description: 'The ceiling while the empanelment is RESIGNED or INACTIVE — they were acceptable once, but are not currently placed there.',
    group: 'qualification', type: 'number', default: 49, min: 0, max: 100, applies: 'immediately',
  },
  {
    key: 'qualification.cap.documentsPending',
    label: 'Score ceiling: documents pending',
    description: 'The ceiling while the partner\'s document requirements are still outstanding.',
    group: 'qualification', type: 'number', default: 69, min: 0, max: 100, applies: 'immediately',
  },
  {
    key: 'qualification.backgroundCheckValidityMonths',
    label: 'Background check validity',
    description: 'How long a background check stays fully trusted. Past this age the dimension is halved and the profile says a re-check is due — an old CLEAR still says something, just not enough to lean on.',
    group: 'qualification', type: 'number', default: 24, min: 1, max: 120, unit: 'months', applies: 'immediately',
  },

  // ── Document pipeline ───────────────────────────────────────────────────
  {
    /**
     * Off by default, and deliberately opt-*in* rather than opt-out.
     *
     * "Send to OCR" does not send anything. The external OCR application is out of scope
     * (spec §1) and there is no integration with it: the endpoint only records that a person
     * has carried the packet across by hand. Flipping that stamp automatically when a return
     * arrives would therefore write "sent to external OCR, by SYSTEM, at 14:02" into the chain
     * of custody of a bank collateral audit for a hand-off nobody performed — the document
     * would sit untouched in the OCR app's inbox while every screen reported it in progress,
     * and the operator would lose the queue that tells them there is work to carry across.
     *
     * The automation is still built and ready (DocumentDispatchWorker.autoSendToOcr) for the
     * deployment that *does* wire a real OCR integration behind this endpoint; until then a
     * site turns it on knowingly rather than inheriting it.
     */
    key: 'document.autoSendToExternalOcr',
    label: 'Auto-send returned packets to OCR',
    description: 'When an audited return is received, mark it sent to the external OCR application without waiting for someone to press "Send to OCR". Leave this off unless your OCR application is genuinely fed automatically — the stamp is a chain-of-custody record of a hand-off, and turning it on where the hand-off is still manual records something that did not happen. The manual button keeps working either way.',
    group: 'schedule',
    type: 'boolean',
    default: false,
    envVar: 'DOCUMENT_AUTO_SEND_TO_OCR',
    applies: 'next-run',
  },

  // ── Self-registration ───────────────────────────────────────────────────
  {
    key: 'registration.inviteExpiryHours',
    label: 'Registration link expiry',
    description: 'How long an emailed self-registration link stays valid before a candidate must be re-invited from the interview log.',
    group: 'registration', type: 'number', default: 72, min: 1, max: 720, unit: 'hours', applies: 'immediately',
  },
  /**
   * Invite links that open the field app instead of the browser (2026-09-24). Android checks
   * `https://<host>/.well-known/assetlinks.json` for the app's package and signing-certificate
   * fingerprint; iOS checks `/.well-known/apple-app-site-association` for Team ID + bundle id. Both
   * files are served by `AppLinksController` from these two values. Not secrets — both files are
   * public by design.
   */
  {
    key: 'registration.androidAppCertSha256',
    label: 'Android app signing fingerprint',
    description: 'The SHA-256 fingerprint of the certificate the field app is signed with, so invite links open the app on Android instead of the browser. Change it only if the app is ever signed with a different key (for example after moving to Google Play app signing, which re-signs the app). Several can be listed, separated by commas.',
    group: 'registration', type: 'string',
    default: '65:EC:61:13:9B:44:E5:07:96:8E:92:78:37:F4:05:F1:42:BA:8D:A3:A3:0B:AA:64:90:24:B9:07:BD:17:A6:23',
    applies: 'immediately',
  },
  {
    key: 'registration.iosAppTeamId',
    label: 'Apple Team ID for the iPhone app',
    description: 'The 10-character Apple Developer Team ID the iPhone app is published under. Until it is filled in, invite links open in the browser on iPhones (they still work there). Android is not affected by this.',
    group: 'registration', type: 'string', default: '', applies: 'immediately',
  },
  {
    key: 'registration.otpResendCooldownSeconds',
    label: 'OTP resend cooldown',
    description: 'How long a candidate must wait before requesting another mobile verification code on the same registration link.',
    group: 'registration', type: 'number', default: 60, min: 15, max: 600, unit: 'seconds', applies: 'immediately',
  },
  {
    key: 'references.notifyOnApproval',
    label: 'Tell referees when a candidate is approved',
    description: 'When an application is approved, each person the candidate named as a reference is told that HR may call them — by email where there is an address, and by text where there is a mobile number and the text has a registered DLT template. Anybody who could not be reached is shown as such on the record, where HR can send it again. Switch off to contact referees only by hand.',
    group: 'registration', type: 'boolean', default: true, applies: 'immediately',
  },
  // ── Email Templates ───────────────────────────────────────────────────────
  {
    key: 'email.template.otp-verification',
    label: 'Template: OTP Verification',
    description: 'Versioned configuration and overrides for registration OTP email.',
    group: 'email_templates', type: 'json', default: null, applies: 'immediately',
  },
  {
    key: 'email.template.registration-invite',
    label: 'Template: Registration Invitation',
    description: 'Versioned configuration and overrides for appraiser registration invite email.',
    group: 'email_templates', type: 'json', default: null, applies: 'immediately',
  },
  {
    key: 'email.template.app-credentials',
    label: 'Template: App Access Credentials',
    description: 'Versioned configuration and overrides for app access credentials delivery email.',
    group: 'email_templates', type: 'json', default: null, applies: 'immediately',
  },
  {
    key: 'email.template.application-approved',
    label: 'Template: Application Approved',
    description: 'Versioned configuration and overrides for application approval and assayer code email.',
    group: 'email_templates', type: 'json', default: null, applies: 'immediately',
  },
  {
    key: 'email.template.application-rejected',
    label: 'Template: Application Rejected',
    description: 'Versioned configuration and overrides for application rejection email.',
    group: 'email_templates', type: 'json', default: null, applies: 'immediately',
  },
  {
    key: 'email.template.application-info-requested',
    label: 'Template: Application Needs Attention',
    description: 'Versioned configuration and overrides for the email listing what HR asked a candidate to fix.',
    group: 'email_templates', type: 'json', default: null, applies: 'immediately',
  },
  {
    key: 'email.template.reference-notice',
    label: 'Template: Reference Heads-up',
    description: 'Versioned configuration and overrides for the email telling a referee that HR may call them.',
    group: 'email_templates', type: 'json', default: null, applies: 'immediately',
  },
  {
    key: 'email.template.branch-audit-paperwork',
    label: 'Template: Branch Audit Documentation',
    description: 'Versioned configuration and overrides for branch audit paperwork email.',
    group: 'email_templates', type: 'json', default: null, applies: 'immediately',
  },
  {
    key: 'email.template.morning-digest',
    label: 'Template: Operations Morning Brief',
    description: 'Versioned configuration and overrides for daily morning operations brief email.',
    group: 'email_templates', type: 'json', default: null, applies: 'immediately',
  },
];

export const SETTING_BY_KEY: Record<string, SettingDef> = Object.fromEntries(
  SETTINGS_REGISTRY.map((s) => [s.key, s]),
);

const GROUP_BY_KEY: Record<string, (typeof SETTINGS_GROUPS)[number]> = Object.fromEntries(
  SETTINGS_GROUPS.map((g) => [g.key, g]),
);

/** A group's audience. Unknown groups default to 'business' — the narrower write reach. */
export function audienceOfGroup(groupKey: string): SettingAudience {
  return GROUP_BY_KEY[groupKey]?.audience ?? 'business';
}

/**
 * A setting's audience: its own override when it carries one, else its group's, else
 * 'business'. The write fence (PlatformSettingsService.set/reset) and the admin read filter
 * (PlatformSettingsController.findAll) both consult this one function, so an administrator is
 * never shown a key the fence would refuse them for a reason the screen cannot explain.
 */
export function audienceOfSetting(key: string): SettingAudience {
  const def = SETTING_BY_KEY[key];
  if (!def) return 'business';
  return def.audience ?? audienceOfGroup(def.group);
}
