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
  { key: 'company', label: 'Company & tax identity', description: 'Your firm\'s legal identity as it appears on the GST invoices you send bank clients, and the tax labels on statements. These are printed exactly as entered — set them before sending a real invoice.' },
  { key: 'email', label: 'Email delivery', description: 'The mailbox the platform sends from, and where its links point.' },
  { key: 'schedule', label: 'Schedules', description: 'When recurring work runs — the morning brief and the SLA sweep.' },
  { key: 'fees', label: 'Fees & pricing', description: 'What an audit is worth when no client or assayer contract says otherwise.' },
  { key: 'transport', label: 'Transport recommendation', description: 'How the recommended way to travel is chosen — the speed assumed for each mode when no timetable exists, when a mode is ruled out, and how cost is weighed against time.' },
  { key: 'billing', label: 'Billing & claims', description: 'Tax withholding and the ceiling on a single expense claim.' },
  { key: 'retention', label: 'Data retention', description: 'How long movement and operational records are kept.' },
  { key: 'feedback', label: 'Feedback SLA', description: 'How long the product team has to answer, and to resolve, before it escalates.' },
  { key: 'field', label: 'In the field', description: 'What the app enforces on an assayer while they are out on a job, and how far a negotiation may run.' },
  { key: 'planning', label: 'Planning', description: 'How the recommendation engine spreads work across the people who are eligible for it.' },
  { key: 'roster', label: 'Roster import', description: 'How the appraiser roster spreadsheet is brought in.' },
  { key: 'security', label: 'Access boundaries', description: 'Rollout controls for access checks being tightened — a value here is a staged switch, never a permanent policy.' },
  { key: 'qualification', label: 'Assayer qualification', description: 'How the qualification scores on an assayer\'s profile weigh their verification, background, credentials and track record. Weights are relative — they are normalized over whichever dimensions have data.' },
] as const;

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
    description: 'The registered address printed under the seller name. Commas become line breaks on the invoice.',
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
    description: 'The state your GST registration is in, e.g. Karnataka. Used to decide CGST+SGST versus IGST only when the GSTIN above has not been entered — set the GSTIN and this is derived from it.',
    group: 'company',
    type: 'string',
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

  // ── Access boundaries ─────────────────────────────────────────────────────
  {
    // Read by RegionGuardService.assertRegionAllowedStaged and by each of the six modules that
    // adopt it (document, billing-engine, expense, customer-master, validation-query, client) —
    // the ones that had NO region boundary at all until this rollout. Every OTHER module that
    // already called the region ceiling (branch, assignment, project, planning, scheduling,
    // assayer, reports, search, system-dashboard) is untouched by this setting: their check was
    // already correct and unconditional, and stays that way regardless of this value.
    key: 'security.regionScope.mode',
    label: 'New region boundaries: rollout mode',
    description: 'Six screens (documents, billing, expenses, customer master, validation queries, clients) had no region boundary at all — a region-restricted account could read every region\'s rows through them. "Log" runs the same check every other screen already enforces, but only records what it would have refused instead of refusing it, so you can watch real traffic before anything changes. "Enforce" makes the refusal real. "Off" skips the check entirely. Start on Log, read the logs for a while, then switch to Enforce.',
    group: 'security',
    type: 'select',
    options: [
      { value: 'off', label: 'Off — no check, no log' },
      { value: 'log', label: 'Log — record what would be refused, refuse nothing' },
      { value: 'enforce', label: 'Enforce — actually refuse' },
    ],
    default: 'log',
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
    // Defaults OFF, deliberately, and should stay off until there are enough people holding these
    // roles that a real maker-checker split doesn't just stop payouts from happening. With two
    // people on the roles today, Enforce would mean neither could ever pay the other's work.
    key: 'security.segregationOfDuties.mode',
    label: 'Payout maker-checker: rollout mode',
    description: 'One person can currently book a completed audit, approve its payout, and pay it — the same technical gap "Log" for regions closes for reads, this closes for money leaving the business. "Warn" records every same-person approval/disbursement without blocking it, so you can see how often it would actually bite before anyone is locked out. "Enforce" refuses it: the account that booked the assignment cannot approve its payout, and the approver cannot also be the one who marks it paid. Leave this off until enough people hold these roles that enforcing it does not simply stop payouts.',
    group: 'security',
    type: 'select',
    options: [
      { value: 'off', label: 'Off — no check, no warning' },
      { value: 'warn', label: 'Warn — record same-person approvals, block nothing' },
      { value: 'enforce', label: 'Enforce — actually refuse' },
    ],
    default: 'off',
    envVar: 'SEGREGATION_OF_DUTIES_MODE',
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
];

export const SETTING_BY_KEY: Record<string, SettingDef> = Object.fromEntries(
  SETTINGS_REGISTRY.map((s) => [s.key, s]),
);
