/**
 * The vocabularies the assayer roster is imported into, and the rules for reading the
 * spreadsheet's own words as those vocabularies.
 *
 * The roster arrives as a spreadsheet maintained by hand over several years, and one column in
 * it — "Active / Inactive" — carries **29 distinct values** across 1,155 people. It is not a
 * status column. It is three facts written into one cell with a slash:
 *
 *     "Active / Regular"            → working, and works regularly
 *     "Inactive / Sumeru Rejected"  → not working, because we rejected them
 *     "Active / Back up"            → working, but only as cover
 *     "Staff doing audit"           → neither: a note that somebody else is doing the work
 *
 * Splitting those apart is most of what "structured" means here. A person's availability, the
 * reason for it, and how we engage them are three different questions, asked at different times
 * by different people, and they belong in three fields.
 *
 * The same is true in smaller ways throughout: `west` and `West` are one region; `clear soft
 * copy`, `Clear soft copy` and `Clear Soft Copy` are one answer; "Terminated in Sumeru" and
 * "terminated in Sumeru" are one outcome. Case and spacing are noise and are folded away here
 * rather than being carried into the database and dealt with by every reader forever.
 *
 * What is *not* folded away is anything genuinely ambiguous. `normalise` returns what it could
 * read and what it could not, and the caller records the unreadable part against the row for a
 * human to decide. Guessing would be worse than either importing nothing or asking.
 */

/** How the business engages this person — orthogonal to whether they are currently available. */
export enum AssayerEngagementType {
  /** The default: takes work in the ordinary rotation. */
  REGULAR = 'REGULAR',
  /** Works their own town only; not offered travel. */
  LOCAL = 'LOCAL',
  /** Cover. Offered work when the regular assayer for an area cannot take it. */
  BACK_UP = 'BACK_UP',
  /** Empanelled for agency audits rather than the standard branch audit. */
  AGENCY_AUDIT = 'AGENCY_AUDIT',
  /** Mystery-shopper style audits. */
  MYSTERY_AUDIT = 'MYSTERY_AUDIT',
}

/**
 * Why somebody is not available. Recorded separately from the lifecycle status because
 * "Inactive" alone does not tell an operations lead whether to try again next month.
 */
export enum AssayerUnavailableReason {
  /** We turned them down. */
  REJECTED_BY_US = 'REJECTED_BY_US',
  /** They turned us down. */
  NOT_INTERESTED = 'NOT_INTERESTED',
  /** Deceased. The spreadsheet's word for this is "Expired". */
  DECEASED = 'DECEASED',
  MOVED_ABROAD = 'MOVED_ABROAD',
  /** Empanelled, but there is no branch near them to send them to. */
  NO_WORK_IN_AREA = 'NO_WORK_IN_AREA',
  /** Now engaged through a company rather than as an individual. */
  MOVED_TO_COMPANY = 'MOVED_TO_COMPANY',
}

/** The outcome of a background check, separate from how risky it was judged to be. */
export enum BackgroundCheckVerdict {
  CLEAR = 'CLEAR',
  CIVIL_CASE = 'CIVIL_CASE',
  CRIMINAL_CASE = 'CRIMINAL_CASE',
  /** Something came back that is neither a civil nor a criminal matter — a cheque dishonour,
   *  a discrepancy in what was declared. Recorded rather than rounded to "clear". */
  ADVERSE_FINDING = 'ADVERSE_FINDING',
  NOT_CHECKED = 'NOT_CHECKED',
}

export enum RiskGrade {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  VERY_HIGH = 'VERY_HIGH',
}

/** The credit-score band. The raw score is kept alongside it. */
export enum CibilBand {
  GOOD = 'GOOD',
  AVERAGE = 'AVERAGE',
  POOR = 'POOR',
  BAD = 'BAD',
  /**
   * Checked, and the bureau holds no history — 67 people in the roster. Distinct from not
   * having looked: a first-time borrower with no file is not the same as an unknown risk.
   */
  NO_CREDIT_HISTORY = 'NO_CREDIT_HISTORY',
  /** The check was attempted and did not come back. */
  CHECK_FAILED = 'CHECK_FAILED',
  NOT_CHECKED = 'NOT_CHECKED',
}

/**
 * Where an assayer stands with one client.
 *
 * In the spreadsheet this is a column per client — `ICICI Status`, and remarks mentioning AU
 * Small and RBL. Every new client would mean another column, and the answer for one client
 * says nothing about another. It is a fact about the pair, so it is stored as one.
 */
export enum EmpanelmentStatus {
  /** Put forward, awaiting the client's decision. */
  RECOMMENDED = 'RECOMMENDED',
  /** We are not putting them forward. */
  NOT_RECOMMENDED = 'NOT_RECOMMENDED',
  /** Empanelled and taking work. */
  ACTIVE = 'ACTIVE',
  /** The client turned them down. */
  REJECTED = 'REJECTED',
  /** They stopped working for this client. */
  RESIGNED = 'RESIGNED',
  /** Recommended, but the client's document requirements are outstanding. */
  DOCUMENTS_PENDING = 'DOCUMENTS_PENDING',
  /** Empanelled once, dormant now. */
  INACTIVE = 'INACTIVE',
  /** The client ended the empanelment. The roster records why alongside it. */
  TERMINATED = 'TERMINATED',
}

/**
 * The onboarding paperwork the roster tracks, one column per item.
 *
 * Fifteen Yes/No columns in the spreadsheet — every one of them the same question about a
 * different document. As columns they cannot be counted, cannot carry a date, and cannot grow
 * without another migration. As rows they answer "what is outstanding for this person" and
 * "who is missing an NDA" with the same query.
 */
/**
 * Every document the company holds about an appraiser, whatever it is for.
 *
 * There used to be three answers to "have we got their PAN?": a column on the assayer record
 * holding the number, an identity register holding a verified document with a file, and this
 * checklist holding whether a copy had arrived. The register was never used — no rows in any
 * environment — while this list carried 11,021, and the two vocabularies had already begun to
 * collide (the shared label map carries both `PAN` and `PAN_CARD`, both `AADHAAR` and
 * `AADHAAR_CARD`). They are one thing now.
 *
 * The last four are what the register could name and this list could not. Identity documents
 * are the ones that carry a number and an expiry and are worth verifying; the rest are papers
 * that either arrived or did not. `IDENTITY_DOCUMENTS` below is what separates them.
 */
export enum OnboardingDocument {
  JOINING_FORM = 'JOINING_FORM',
  NDA = 'NDA',
  CODE_OF_CONDUCT = 'CODE_OF_CONDUCT',
  APPOINTMENT_LETTER = 'APPOINTMENT_LETTER',
  ID_CARD = 'ID_CARD',
  PHOTOGRAPH = 'PHOTOGRAPH',
  AADHAAR_FRONT = 'AADHAAR_FRONT',
  AADHAAR_BACK = 'AADHAAR_BACK',
  PAN_CARD = 'PAN_CARD',
  BANK_PASSBOOK = 'BANK_PASSBOOK',
  REFERENCE_CHECK = 'REFERENCE_CHECK',
  PENALTY_FORM = 'PENALTY_FORM',
  COMPANY_STAMP = 'COMPANY_STAMP',
  GOVERNANCE_AUDIT = 'GOVERNANCE_AUDIT',
  ETHICAL_CONDUCT_LETTER = 'ETHICAL_CONDUCT_LETTER',
  ID_PROOF = 'ID_PROOF',
  ADDRESS_PROOF = 'ADDRESS_PROOF',
  OFFICE_ADDRESS_PROOF = 'OFFICE_ADDRESS_PROOF',
  DRIVING_LICENCE = 'DRIVING_LICENCE',
  VOTER_ID = 'VOTER_ID',
  PASSPORT = 'PASSPORT',
}

/**
 * The documents that prove who somebody is.
 *
 * These are the ones a client's branch asks for before letting a person near a vault, so they
 * are the ones that carry a number, an expiry and a verification — the rest of the list is
 * paperwork that either arrived or did not. Nothing else in the record distinguishes them, and
 * showing an expiry field against a code-of-conduct letter is how a form teaches people to
 * ignore it.
 */
export const IDENTITY_DOCUMENTS: readonly OnboardingDocument[] = [
  OnboardingDocument.AADHAAR_FRONT,
  OnboardingDocument.AADHAAR_BACK,
  OnboardingDocument.PAN_CARD,
  OnboardingDocument.DRIVING_LICENCE,
  OnboardingDocument.VOTER_ID,
  OnboardingDocument.PASSPORT,
  OnboardingDocument.ID_PROOF,
  OnboardingDocument.ADDRESS_PROOF,
];

export const isIdentityDocument = (d: OnboardingDocument | string): boolean =>
  IDENTITY_DOCUMENTS.includes(d as OnboardingDocument);

/** Where a document is up to. Only identity documents are verified; the rest just arrive. */
export enum DocumentVerification {
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

/** Which spreadsheet column carries each requirement, so the importer needs no second list. */
/**
 * The spreadsheet's own column headings, spelling included.
 *
 * "Buisness", "Paasbook" and "Refference" are how the file writes them, and this map exists to
 * *find* those columns — correcting them here would mean finding nothing. What a person reads on
 * screen comes from `ONBOARDING_DOCUMENT_LABELS` instead.
 */
export const ONBOARDING_DOCUMENT_COLUMNS: Record<OnboardingDocument, string> = {
  [OnboardingDocument.JOINING_FORM]: 'Sumeru Joining Form',
  [OnboardingDocument.NDA]: 'NDA',
  [OnboardingDocument.CODE_OF_CONDUCT]: 'COC (Buisness Ethics)',
  [OnboardingDocument.APPOINTMENT_LETTER]: 'Appointment Letter',
  [OnboardingDocument.ID_CARD]: 'ID card',
  [OnboardingDocument.PHOTOGRAPH]: 'Photo',
  [OnboardingDocument.AADHAAR_FRONT]: 'Aadhar front',
  [OnboardingDocument.AADHAAR_BACK]: 'Aadhar Back',
  [OnboardingDocument.PAN_CARD]: 'PAN',
  [OnboardingDocument.BANK_PASSBOOK]: 'Bank Paasbook',
  [OnboardingDocument.REFERENCE_CHECK]: 'Refference Check',
  [OnboardingDocument.PENALTY_FORM]: 'Penalty Form',
  [OnboardingDocument.COMPANY_STAMP]: 'Sumeru Stamp',
  [OnboardingDocument.GOVERNANCE_AUDIT]: 'Governance Audit',
  [OnboardingDocument.ETHICAL_CONDUCT_LETTER]: 'Letter for Commitment on Ethical Conduct',
  [OnboardingDocument.ID_PROOF]: 'ID Proof',
  [OnboardingDocument.ADDRESS_PROOF]: 'Address Proof',
  [OnboardingDocument.OFFICE_ADDRESS_PROOF]: 'Office Address Proof',
  // The roster spreadsheet has no column for these three; they came from the identity register.
  // An empty string means "no column to read", which `rowReader` treats as absent.
  [OnboardingDocument.DRIVING_LICENCE]: '',
  [OnboardingDocument.VOTER_ID]: '',
  [OnboardingDocument.PASSPORT]: '',
};

/** What the paperwork is called on screen — the same list, spelled properly. */
export const ONBOARDING_DOCUMENT_LABELS: Record<OnboardingDocument, string> = {
  [OnboardingDocument.JOINING_FORM]: 'Joining form',
  [OnboardingDocument.NDA]: 'Non-disclosure agreement',
  [OnboardingDocument.CODE_OF_CONDUCT]: 'Code of conduct',
  [OnboardingDocument.APPOINTMENT_LETTER]: 'Appointment letter',
  [OnboardingDocument.ID_CARD]: 'Company ID card',
  [OnboardingDocument.PHOTOGRAPH]: 'Photograph',
  [OnboardingDocument.AADHAAR_FRONT]: 'Aadhaar — front',
  [OnboardingDocument.AADHAAR_BACK]: 'Aadhaar — back',
  [OnboardingDocument.PAN_CARD]: 'PAN card',
  [OnboardingDocument.BANK_PASSBOOK]: 'Bank passbook',
  [OnboardingDocument.REFERENCE_CHECK]: 'Reference check',
  [OnboardingDocument.PENALTY_FORM]: 'Penalty form',
  [OnboardingDocument.COMPANY_STAMP]: 'Company stamp',
  [OnboardingDocument.GOVERNANCE_AUDIT]: 'Governance audit',
  [OnboardingDocument.ETHICAL_CONDUCT_LETTER]: 'Ethical conduct commitment',
  [OnboardingDocument.ID_PROOF]: 'Identity proof',
  [OnboardingDocument.ADDRESS_PROOF]: 'Address proof',
  [OnboardingDocument.OFFICE_ADDRESS_PROOF]: 'Office address proof',
  [OnboardingDocument.DRIVING_LICENCE]: 'Driving licence',
  [OnboardingDocument.VOTER_ID]: 'Voter ID',
  [OnboardingDocument.PASSPORT]: 'Passport',
};

/** Case, spacing and punctuation are noise. Fold them before matching anything. */
export function vocabularyKey(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** `null` for the spreadsheet's many ways of writing "nothing here". */
export function blankToNull(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const key = vocabularyKey(s);
  // `vocabularyKey` strips punctuation, so a cell holding only "-" or "--" reduces to an empty
  // key rather than matching a placeholder by name. Both mean the same thing: nothing here.
  if (!key) return null;
  return ['n a', 'na', 'nil', 'none'].includes(key) ? null : s;
}

/**
 * What one "Active / Inactive" cell actually said.
 *
 * `available` is `null` when the cell described something else entirely — "Staff doing audit"
 * says nothing about whether the person is available, only that somebody else is doing their
 * work. That is a compliance matter, not a status, and it is surfaced rather than swallowed.
 */
export interface RosterAvailability {
  available: boolean | null;
  onHold: boolean;
  engagement: AssayerEngagementType | null;
  reason: AssayerUnavailableReason | null;
  /** Set when the cell reports that somebody other than the assayer is doing the work. */
  workDoneBySomeoneElse: boolean;
  /** The parts of the cell nothing could be made of, for a human to look at. */
  unreadable: string[];
}

const ENGAGEMENT: Record<string, AssayerEngagementType> = {
  'regular': AssayerEngagementType.REGULAR,
  'local': AssayerEngagementType.LOCAL,
  'back up': AssayerEngagementType.BACK_UP,
  'backup': AssayerEngagementType.BACK_UP,
  'agency audit': AssayerEngagementType.AGENCY_AUDIT,
  'mystry audit': AssayerEngagementType.MYSTERY_AUDIT,
  'mystery audit': AssayerEngagementType.MYSTERY_AUDIT,
  'mystry audit agency audit': AssayerEngagementType.MYSTERY_AUDIT,
};

const UNAVAILABLE: Record<string, AssayerUnavailableReason> = {
  'sumeru rejected': AssayerUnavailableReason.REJECTED_BY_US,
  'not interested': AssayerUnavailableReason.NOT_INTERESTED,
  'expired': AssayerUnavailableReason.DECEASED,
  'moved to out of india': AssayerUnavailableReason.MOVED_ABROAD,
  'no location': AssayerUnavailableReason.NO_WORK_IN_AREA,
  'company profile added': AssayerUnavailableReason.MOVED_TO_COMPANY,
};

/** Phrases that report somebody else covering the work rather than a status. */
const SOMEONE_ELSE = ['staff doing audit', 'staff is doing audit', 'friend is doing audit', 'husband doing audit'];

/** Phrases that mean "empanelled but idle" rather than a status of their own. */
const IDLE = ['not getting audit regular', 'not doing audit regular', 'work not assigned'];

/**
 * Read one "Active / Inactive" cell into its parts.
 *
 * The cell is a slash-separated list whose first element is usually the availability and whose
 * remainder is usually a reason or an engagement type — but not always, and the exceptions are
 * why this returns `unreadable` rather than a best guess.
 */
export function readAvailability(raw: unknown): RosterAvailability {
  const out: RosterAvailability = {
    available: null, onHold: false, engagement: null, reason: null,
    workDoneBySomeoneElse: false, unreadable: [],
  };
  const cell = blankToNull(raw);
  if (!cell) return out;

  for (const part of cell.split('/')) {
    const key = vocabularyKey(part);
    if (!key) continue;

    if (key === 'active') { out.available = true; continue; }
    if (key === 'inactive') { out.available = false; continue; }
    if (key === 'hold') { out.onHold = true; out.available = false; continue; }
    if (SOMEONE_ELSE.includes(key)) { out.workDoneBySomeoneElse = true; continue; }
    if (IDLE.some((p) => key.startsWith(p))) {
      // Still empanelled — simply not being given work. Availability is unchanged by this.
      out.reason ??= AssayerUnavailableReason.NO_WORK_IN_AREA;
      continue;
    }
    if (ENGAGEMENT[key]) {
      out.engagement = ENGAGEMENT[key];
      // "Back up" on its own means engaged as cover, and says nothing about availability.
      out.available ??= true;
      continue;
    }
    if (UNAVAILABLE[key]) {
      out.reason = UNAVAILABLE[key];
      out.available ??= false;
      continue;
    }
    out.unreadable.push(part.trim());
  }
  return out;
}

/** "Clear Soft Copy" / "clear soft copy" / "soft copy not clear" → a yes, a no, or nothing. */
export function readYesNo(raw: unknown): boolean | null {
  const key = vocabularyKey(blankToNull(raw));
  if (!key) return null;
  if (['yes', 'y', 'received', 'done', 'clear', 'completed', 'true'].includes(key)) return true;
  if (['no', 'n', 'pending', 'not received', 'false'].includes(key)) return false;
  if (key.includes('not clear')) return false;
  if (key.includes('clear')) return true;
  return null;
}

export function readCibilBand(raw: unknown): CibilBand | null {
  const key = vocabularyKey(blankToNull(raw));
  if (!key) return null;
  if (key.includes('no credit')) return CibilBand.NO_CREDIT_HISTORY;
  if (key === 'error') return CibilBand.CHECK_FAILED;
  if (key === 'good') return CibilBand.GOOD;
  if (key === 'average') return CibilBand.AVERAGE;
  if (key === 'poor') return CibilBand.POOR;
  if (key === 'bad') return CibilBand.BAD;
  if (key === 'inactive' || key === 'not checked') return CibilBand.NOT_CHECKED;
  return null;
}

/** The background-check cell reports a verdict and, sometimes, a risk grade beside it. */
export function readBackgroundCheck(raw: unknown): { verdict: BackgroundCheckVerdict | null; risk: RiskGrade | null } {
  const key = vocabularyKey(blankToNull(raw));
  if (!key) return { verdict: null, risk: null };

  const risk =
    key.includes('very high') ? RiskGrade.VERY_HIGH
    : key.includes('high') ? RiskGrade.HIGH
    : key.includes('medium') ? RiskGrade.MEDIUM
    : key.includes('low') ? RiskGrade.LOW
    : null;

  const verdict =
    key.includes('criminal') ? BackgroundCheckVerdict.CRIMINAL_CASE
    // A divorce and a dishonoured cheque are civil matters; the roster names them directly
    // rather than by category.
    : key.includes('civil') || key.includes('divorce') || key.includes('dishonor') || key.includes('dishonour')
      ? BackgroundCheckVerdict.CIVIL_CASE
    : key.includes('discrepancy') ? BackgroundCheckVerdict.ADVERSE_FINDING
    : key.includes('clear') ? BackgroundCheckVerdict.CLEAR
    : key.includes('inactive') || key.includes('work not asigned') || key.includes('work not assigned')
      ? BackgroundCheckVerdict.NOT_CHECKED
      : null;

  return { verdict, risk };
}

export function readEmpanelment(raw: unknown): EmpanelmentStatus | null {
  const key = vocabularyKey(blankToNull(raw));
  if (!key) return null;
  if (key.includes('not recommended')) return EmpanelmentStatus.NOT_RECOMMENDED;
  if (key.includes('no documents') || key.includes('documents required')) return EmpanelmentStatus.DOCUMENTS_PENDING;
  if (key.includes('recommended')) return EmpanelmentStatus.RECOMMENDED;
  if (key.includes('terminated')) return EmpanelmentStatus.TERMINATED;
  if (key.includes('rejected')) return EmpanelmentStatus.REJECTED;
  if (key.includes('resigned') || key.includes('not interested')) return EmpanelmentStatus.RESIGNED;
  if (key === 'active') return EmpanelmentStatus.ACTIVE;
  if (key === 'inactive') return EmpanelmentStatus.INACTIVE;
  return null;
}

/**
 * The two phone columns hold up to three numbers between them, some in one cell separated by a
 * slash. Splitting them is the difference between a callable number and a string.
 */
export function readPhoneNumbers(...cells: unknown[]): string[] {
  const seen = new Set<string>();
  for (const cell of cells) {
    for (const part of String(blankToNull(cell) ?? '').split(/[/,;]/)) {
      const digits = part.replace(/\D/g, '');
      // Indian mobile numbers, with or without the country code.
      const national = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
      if (national.length === 10) seen.add(`+91${national}`);
    }
  }
  return [...seen];
}

/**
 * Where a signed original is physically kept.
 *
 * This column was free text, and one place was typed five different ways — "Sent to Bangalore
 * office", "Sent to Bangalore Office", "Bangalore office", "Bangalore Office", "sent to
 * Bangalore office" — across 112 rows, so "which documents are in Bangalore?" had no answer any
 * query could give. Two of the values were not places at all ("Recieved", "Recived"): they were
 * saying the original had arrived, in the column meant for where it went.
 *
 * A short list a clerk picks from. Add an office here rather than letting one be typed.
 */
export const HARD_COPY_LOCATIONS = [
  'Bangalore office',
  'Vasai office',
] as const;

/** Folds the spellings the file already contains onto the canonical name; null if not a place. */
export function readHardCopyLocation(raw: unknown): string | null {
  const key = vocabularyKey(blankToNull(raw));
  if (!key) return null;
  if (key.includes('bangalore')) return 'Bangalore office';
  if (key.includes('vasai')) return 'Vasai office';
  return null;
}
