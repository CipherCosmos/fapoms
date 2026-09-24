import type { InterviewFile } from '../hiring/pipeline';
import type {
  ApplicationStatus, ApplicationDocumentReviewStatus, ApplicationInfoRequestItem,
} from '@fapoms/shared';

/**
 * The shapes `GET /hr/applications` and `GET /hr/applications/:id` answer with.
 *
 * They used to live in the Applications PAGE, which the hiring pipeline replaced — the review
 * drawer and the pipeline list both read these, and neither should have to import a screen to
 * learn the shape of a row.
 */
export interface AssayerApplicationRow {
  id: string;
  fullName: string | null;
  mobile: string;
  email: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  address: string | null;
  state: string | null;
  city: string | null;
  pincode: string | null;
  experienceYears: number | null;
  currentEmployer: string | null;
  expertise: string | null;
  availability: string | null;
  employmentCategory: 'FREELANCER' | 'PROPRIETOR' | null;
  consentAcceptedAt: string | null;
  status: ApplicationStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  promotedAssayerId: string | null;
  createdAt: string;
}

export interface AssayerApplicationDocumentRow {
  id: string;
  requirement: string;
  filePaths: string[];
  /**
   * HR's verdict on this requirement. `NEEDS_RESUBMIT` means the candidate was asked to
   * re-upload it on the same link — the row stays flagged until fresh scans land.
   */
  reviewStatus?: ApplicationDocumentReviewStatus | string | null;
  rejectionReason?: string | null;
  rejectionNote?: string | null;
  reviewedAt?: string | null;
}

/** A gap the record dictionary ranks as critical, with what it stops. */
export interface RegistrationGap {
  key: string;
  label: string;
  blocks: string;
}

export interface AssayerApplicationDetail {
  application: AssayerApplicationRow & {
    /**
     * Everything the candidate answered beyond the application's own columns — identity numbers,
     * bank details, emergency contact, qualification. The row type did not carry it, so the person
     * approving could not see the PAN or the bank account they were approving.
     *
     * `references` rides beside the fields: people who can vouch for the candidate, replayed
     * onto the record at approval.
     */
    extendedProfile?: {
      fields?: Record<string, string | number | null>;
      references?: Array<{ fullName?: string; phone?: string; relationship?: string; email?: string }>;
    } | null;
  };
  documents: AssayerApplicationDocumentRow[];
  /** What is still missing, judged against the record this is about to become. */
  gaps: RegistrationGap[];
  /**
   * The number HR typed at the interview, present only when it differs from the one the candidate
   * confirmed. The candidate's answer wins — they know their own number — but a mismatch is worth
   * a reviewer's eye.
   */
  invitedMobile: string | null;
  /**
   * What happened at the interview. The notes were written down every time and shown on no screen,
   * so the reviewer deciding the application had to go and ask the interviewer. Null without one.
   */
  interview?: ApplicationInterview & {
    /** The attempt that did not pass before this one, when they were interviewed again. */
    earlier?: ApplicationInterview | null;
  } | null;
  /** Present when application's phone conflicts with an active assayer or another application. */
  phoneConflict?: {
    message: string;
    assayerCode?: string;
    displayName?: string;
  } | null;
  /** Which scans this candidate is asked for, given their employment category. */
  documentsRequested?: string[];
  /**
   * Exactly what HR ticked the last time they asked for more — one entry per document or
   * field, each with its own instruction. Rendered as the outstanding checklist so a second
   * reviewer sees what was already asked instead of asking it again.
   */
  infoRequests?: ApplicationInfoRequestItem[];
}

/**
 * The statuses HR filters by. The backend's own default (`GET /hr/applications` with no `status`)
 * returns every row, so this screen always sends one explicitly rather than rendering that
 * unfiltered list.
 *
 * `DRAFT` was originally left out on the grounds that somebody mid-form has nothing for HR to act
 * on. That is true of half the people in it. The other half were invited and never arrived —
 * their email bounced, was filtered, or (with email delivery switched off) was never sent — and
 * they are invisible to everyone while the interview log cheerfully reports an invite. "Not
 * started" is where those are found, and the drawer's Resend link is what it is for.
 */

/** One interview as the review shows it — with the test papers it rested on. */
export interface ApplicationInterview {
  id?: string;
  outcome: string;
  notes: string | null;
  interviewedAt: string;
  interviewedByName: string | null;
  attachments?: InterviewFile[];
}
