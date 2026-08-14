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

export type SettingType = 'string' | 'number' | 'boolean' | 'password' | 'select' | 'cron';

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
}

export const SETTINGS_GROUPS = [
  { key: 'email', label: 'Email delivery', description: 'The mailbox the platform sends from, and where its links point.' },
  { key: 'schedule', label: 'Schedules', description: 'When recurring work runs — the morning brief and the SLA sweep.' },
  { key: 'fees', label: 'Fees & pricing', description: 'What an audit is worth when no client or assayer contract says otherwise.' },
  { key: 'billing', label: 'Billing & claims', description: 'Tax withholding and the ceiling on a single expense claim.' },
  { key: 'retention', label: 'Data retention', description: 'How long movement and operational records are kept.' },
  { key: 'feedback', label: 'Feedback SLA', description: 'How long the product team has to answer, and to resolve, before it escalates.' },
  { key: 'field', label: 'Field rules', description: 'What the app enforces on an assayer in the field, and how far a negotiation may run.' },
] as const;

export const SETTINGS_REGISTRY: SettingDef[] = [
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
    description: 'Kilometres not charged before travel starts counting. Zero means charge from the first kilometre.',
    group: 'fees',
    type: 'number',
    default: 10,
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


  // ── Feedback SLA ────────────────────────────────────────────────────────
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
    key: 'field.maxNegotiationRounds',
    label: 'Counter-offers allowed',
    description: 'How many times an assayer may counter before the offer auto-declines and goes back to the desk. Raising it lets a negotiation run longer; lowering it forces a decision sooner.',
    group: 'field',
    type: 'number',
    default: 3,
    envVar: 'MAX_NEGOTIATION_ROUNDS',
    min: 1, max: 20, unit: 'rounds',
    applies: 'immediately',
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
];

export const SETTING_BY_KEY: Record<string, SettingDef> = Object.fromEntries(
  SETTINGS_REGISTRY.map((s) => [s.key, s]),
);
