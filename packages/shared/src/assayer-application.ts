/**
 * The Appraiser Recruitment application — the record a self-registering candidate builds before
 * anyone touches the live roster.
 *
 * Deliberately separate from `AssayerLifecycleStatus` (see `assayer-lifecycle.ts`): that enum is
 * guarded (`derived-status.spec.ts`, the transition-map waypoint rules) precisely because it
 * governs a real, working assayer, and none of that machinery has any meaning for somebody who
 * does not have a roster record yet. An application is promoted into a real `AssayerEntity` only
 * on approval — see `AssayerApplicationEntity.promotedAssayerId`.
 *
 * The HR-desk registration wizard (`RegistrationWizard.tsx`) never touches this — it still writes
 * a live assayer directly, ungated, exactly as it always has. This status only governs the NEW
 * self-registration entry points (web link, mobile app).
 */
export enum ApplicationStatus {
  /** Being filled in, autosaved, not yet submitted. Only the candidate (via their token) can see it. */
  DRAFT = 'DRAFT',
  /** Submitted, awaiting HR review. */
  PENDING_VALIDATION = 'PENDING_VALIDATION',
  /** HR asked for a correction or an additional document; the candidate can resume via the same link. */
  AWAITING_INFO = 'AWAITING_INFO',
  /** Terminal. HR declined the application; a reason is required. */
  REJECTED = 'REJECTED',
  /** Terminal (successful). Promoted to a real assayer — see `promotedAssayerId`. */
  APPROVED = 'APPROVED',
  /**
   * Terminal. The candidate withdrew their consent, so the application stops where it is and what
   * they had given us is erased. Distinct from REJECTED on purpose: nobody judged this person, and
   * a register of people we turned down should not quietly fill up with people who simply left.
   */
  WITHDRAWN = 'WITHDRAWN',
}

/** States that accept no further action from either the candidate or HR. */
export const APPLICATION_TERMINAL_STATUSES: ApplicationStatus[] = [
  ApplicationStatus.REJECTED,
  ApplicationStatus.APPROVED,
];

/** Whether the candidate may still edit and (re)submit through their invite link. */
export function applicationIsEditableByCandidate(status: ApplicationStatus): boolean {
  return status === ApplicationStatus.DRAFT || status === ApplicationStatus.AWAITING_INFO;
}

/**
 * HR's verdict on one document requirement inside a hiring application.
 *
 * Lives apart from the roster's `DocumentVerification` on purpose: a roster document carries
 * scans, versions and holder-name matching, while an application document is just
 * `{requirement, filePaths}`. Reusing that enum would promise machinery this row cannot hold.
 */
export enum ApplicationDocumentReviewStatus {
  /** Nobody has judged this requirement yet. */
  PENDING = 'PENDING',
  /** HR looked at the attached scans and accepted them. */
  APPROVED = 'APPROVED',
  /** HR sent this requirement back; the candidate must re-upload it on the same link. */
  NEEDS_RESUBMIT = 'NEEDS_RESUBMIT',
}

/**
 * One targeted ask inside a request for more information: either a document requirement to
 * re-upload or a form field to correct, each with its own instruction for the candidate.
 *
 * Stored as an array on the application (`infoRequests`, jsonb) so the candidate's link can
 * render a to-do list instead of one free-text banner nobody can act on without guessing.
 */
export interface ApplicationInfoRequestItem {
  kind: 'document' | 'field';
  /** An `OnboardingDocument` value for documents, a form/record field key for fields. */
  key: string;
  /** Human words for the item, resolved server-side so the candidate never sees a raw key. */
  label: string;
  /** What HR needs for this item — shown beside it on the candidate's link. */
  message: string;
  /** Structured send-back reason for documents (a `DocumentRejectionReason` value, if any). */
  reason?: string | null;
}

/**
 * The form fields HR may tick when asking for corrections, with the words both screens use.
 *
 * Keys match the candidate form's field names (application columns) or the record field names
 * under `extendedProfile.fields` — the same names the draft PATCH already accepts, so a ticked
 * field is always something the candidate can actually fix on their link.
 */
export const APPLICATION_INFO_REQUESTABLE_FIELDS: ReadonlyArray<{ key: string; label: string; step: number }> = [
  { key: 'fullName', label: 'Full name', step: 1 },
  { key: 'dateOfBirth', label: 'Date of birth', step: 1 },
  { key: 'gender', label: 'Gender', step: 1 },
  { key: 'address', label: 'Address', step: 2 },
  { key: 'city', label: 'City', step: 2 },
  { key: 'state', label: 'State', step: 2 },
  { key: 'pincode', label: 'Pincode', step: 2 },
  { key: 'email', label: 'Email', step: 1 },
  { key: 'mobile', label: 'Mobile number', step: 1 },
  { key: 'employmentCategory', label: 'Employment category', step: 3 },
  { key: 'experienceYears', label: 'Experience', step: 2 },
  { key: 'currentEmployer', label: 'Current employer', step: 2 },
  { key: 'expertise', label: 'Expertise', step: 2 },
  { key: 'availability', label: 'Availability', step: 2 },
  { key: 'panNumber', label: 'PAN number', step: 3 },
  { key: 'aadhaarNumber', label: 'Aadhaar number', step: 3 },
  { key: 'bankAccountNumber', label: 'Bank account number', step: 3 },
  { key: 'ifscCode', label: 'IFSC code', step: 3 },
  { key: 'bankName', label: 'Bank name', step: 3 },
  { key: 'qualification', label: 'Qualification', step: 3 },
  { key: 'emergencyContactName', label: 'Emergency contact name', step: 3 },
  { key: 'emergencyContactPhone', label: 'Emergency contact phone', step: 3 },
];

/**
 * Which form step a correctable field is on — where a "Fix" beside HR's ask should take the
 * candidate. The same four steps on the web link and the phone app.
 *
 * Carried on the list above rather than kept by each screen, because the web form kept its own
 * copy and it had already drifted: it sent a fix to the employment category to step 2, while both
 * forms ask for it on step 3. A field this does not know goes to step 1 — the top of the form —
 * rather than nowhere.
 */
export function applicationFieldStep(key: string): number {
  return APPLICATION_INFO_REQUESTABLE_FIELDS.find((f) => f.key === key)?.step ?? 1;
}


/**
 * Read the structured asks back out of untyped jsonb.
 *
 * Shape-checked rather than cast: `infoRequests` is a column anything can have been written
 * into, including by an older build that only knew free-text `reviewNotes`. Unknown shapes
 * become no items rather than a banner that says "undefined".
 */
export function readApplicationInfoRequests(raw: unknown): ApplicationInfoRequestItem[] {
  if (!Array.isArray(raw)) return [];
  const items: ApplicationInfoRequestItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Partial<ApplicationInfoRequestItem>;
    if (row.kind !== 'document' && row.kind !== 'field') continue;
    if (typeof row.key !== 'string' || !row.key) continue;
    if (typeof row.label !== 'string' || !row.label) continue;
    if (typeof row.message !== 'string' || !row.message.trim()) continue;
    items.push({
      kind: row.kind,
      key: row.key,
      label: row.label,
      message: row.message.trim(),
      reason: typeof row.reason === 'string' && row.reason ? row.reason : null,
    });
  }
  return items;
}

/**
 * Who authored the substance of an application — the rule maker–checker keys on.
 *
 * SELF_SERVICE: the candidate filled it in through their invite link (web or mobile). The HR
 * user who sent the invite is not the maker and may review it.
 * HR_DESK: a staff account typed the candidate in through the portal wizard. That account is
 * the maker, and approval must come from somebody else — the same segregation this product
 * already enforces for money.
 */
export enum ApplicationSource {
  SELF_SERVICE = 'SELF_SERVICE',
  HR_DESK = 'HR_DESK',
}

export enum InterviewOutcome {
  PASS = 'PASS',
  FAIL = 'FAIL',
}
