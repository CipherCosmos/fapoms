import { ValidationQueryStatus } from '@fapoms/shared';
import type {
  AssayerStatement as SharedAssayerStatement,
  AssayerStatementPayable as SharedAssayerStatementPayable,
  AssayerStatementPayment as SharedAssayerStatementPayment,
} from '@fapoms/shared';

export interface CustomerRecord {
  id: string;
  customerName: string;
  accountNumber: string;
  pledgedPacketNo: string;
  pledgedGrossWeightGrams: number;
  pledgedNetWeightGrams: number;
  pledgedItemDescription: string;
  // Audit entry fields filled by Assayer
  auditedGrossWeightGrams?: number;
  auditedNetWeightGrams?: number;
  purityKarat?: number;
  sealIntact?: boolean;
  remarks?: string;
  status: 'PENDING' | 'AUDITED' | 'QUERY_RAISED';
}

export interface ValidationQuery {
  id: string;
  customerRecordId: string;
  accountNumber: string;
  customerName: string;
  fieldId: string;
  validatorName: string;
  queryText: string;
  // RESPONDED = assayer has submitted a response but a validator hasn't closed it yet.
  // Derived from the shared enum (as a string union, so `=== 'RESOLVED'` comparisons still typecheck)
  // rather than a hand-copied literal set that could drift from @fapoms/shared.
  status: `${ValidationQueryStatus}`;
  createdAt: string;
}

export interface AssayerExpense {
  id: string;
  assignmentId: string;
  branchName: string;
  category: 'TRAVEL_KM' | 'TOLL' | 'FOOD' | 'OTHER';
  amount: number;
  description: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  receiptUrl?: string;
  /** Set when the claim is read back from `/expenses/mine`; absent on locally-built rows. */
  createdAt?: string;
  /**
   * The desk's reason for rejecting (or, less often, approving) this claim — required by the
   * backend on rejection (`expense.service.ts` throws without one). Silently dropped by this
   * app's mapping until now, even though the frontend's equivalent
   * (`AssignmentDetailDrawer.tsx`) already shows it: an assayer whose reimbursement was rejected
   * had no way, anywhere in this app, to learn why.
   */
  reviewNotes?: string | null;
}

/**
 * The assayer's financial statement from the billing engine.
 *
 * These are the figures finance works from. The earnings screen previously derived its own
 * totals by summing agreed fees off the loaded assignments, which could not see TDS, part
 * payments, or anything on hold — so the app and the desk disagreed about what was owed.
 *
 * All three used to be hand-declared here, independently of the backend response they describe —
 * and the hand-declared `totals` silently had no `tdsWithheld` field at all, nor did the payable
 * row carry `invoiceNumber`/`invoiceStatus`, even though the backend always sends both and the
 * staff-facing web statement already displays them. Aliased onto the shared, canonical shape now
 * (`packages/shared/src/assayer-invoicing.ts`) so a field the backend adds only has to be typed
 * once, and mapping code that forgets to copy a field becomes a type error here instead of a
 * silent gap an assayer discovers by comparing notes with the desk.
 */
export type AssayerPayable = SharedAssayerStatementPayable;
export type AssayerPayment = SharedAssayerStatementPayment;
export type AssayerStatement = SharedAssayerStatement;

/** Claim totals from `/expenses/mine/summary`, in rupees. */
export interface ExpenseSummary {
  pending: number;
  approved: number;
  rejected: number;
  totalClaimed: number;
}

export interface AssayerAssignment {
  id: string;
  assignmentCode: string;
  projectBranchId: string;
  assayerId?: string;
  branchName: string;
  solId: string;
  bankName: string;
  branchAddress: string;
  /**
   * The branch's coordinates, or `null` when the branch has none on record. Never 0: a missing
   * coordinate used to be mapped to `0`, which is a real place — Null Island, in the Gulf of
   * Guinea — and "Navigate" happily routed there. Every reader must handle `null`; a distance or
   * a route to an unknown place is worse than none.
   */
  latitude: number | null;
  longitude: number | null;
  scheduledDate: string;
  sequenceOrder: number;
  estimatedCustomerCount: number;
  estimatedAuditHours: number;
  // Mirrors AssignmentStatus in @fapoms/shared. CANCELLED was missing here even though the
  // API layer already passed it through, so a cancelled job fell through every status map and
  // rendered as a raw uppercase string — or worse, was offered as the assayer's next job.
  status: 'PENDING' | 'ACCEPTED' | 'CHECKED_IN' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'CANCELLED';
  /**
   * Soft-delete flag from the server. Assignments with `isActive === false` were removed by
   * the desk and must never be offered, shown as current work, or counted as earnings — even
   * when a cached copy still carries an open (PENDING/ACCEPTED/CHECKED_IN) status. Absent on
   * legacy cached rows, which we treat as active.
   */
  isActive?: boolean;
  /*
   * There are deliberately NO fee fields here (`proposedFee`, `agreedBaseFee`,
   * `quotedTravelFee`, `counterTravelFee`, `negotiationCount` all used to live at this spot).
   * Fee negotiation was removed from the app and the assayer is money-blind until invoicing:
   * the server's assayer-money-redaction interceptor strips every fee key from every response
   * an assayer principal receives, so a field here could only ever hold undefined — and a fee
   * an assayer first sees is the one on their invoice invitation (`AssayerInvoiceInvitation`),
   * never one on an assignment.
   */
  distanceKm?: number;
  /** The transport mode the desk's quote assumed (a shared TravelMode value), if any.
   *  An operational fact, not money — kept because it still reaches assayer responses. */
  quotedTransportMode?: string | null;
  /** One-way routed km the quote priced, as recorded at offer time. Operational, not money. */
  quotedDistanceKm?: number | null;
  checkedInAt?: string;
  /** When they left the branch. Present only once checked out; closes the on-site window. */
  checkedOutAt?: string;
  checkInGeoLat?: number;
  checkInGeoLng?: number;
  customerPdfUrl?: string;
  completedPdfUrl?: string;
  instructions?: string;
  remarks?: string;
  /**
   * Whether this branch's audit packet has actually been dispatched, from the server.
   *
   * The app used to offer a "Packet PDF" button on every checked-in assignment and only find
   * out whether anything existed after the assayer tapped it — so the ordinary case (ops has
   * not sent the paperwork yet) presented as a failed download.
   */
  documentReadiness?: { state: 'READY' | 'PREPARING' | 'NONE'; dispatchedCount: number; message: string };
  queries: ValidationQuery[];
  expenses: AssayerExpense[];
}

export interface AppNotification {
  id: string;
  title: string;
  message: string;
  isRead: boolean;
  link: string | null;
  createdAt: string;
  assignmentId?: string;
  /**
   * The catalog event key (`ASSIGNMENT_OFFERED`, `QUERY_RAISED`, …).
   *
   * The list used to choose its icon by searching the *title* for English words. The title is
   * an operator-editable template in the notification catalog, so rewording "Assignment offered"
   * to "New work available" silently changed the icon to the generic bell — and the assayer
   * language work makes that certain rather than hypothetical. The type is the stable identity
   * of the event; the title is a presentation of it.
   */
  type?: string;
}

export interface AssayerProfile {
  id: string;
  name: string;
  phone: string;
  code: string;
  city: string;
  rating: number;
  qualityScorePercent: number;
  totalAuditsCount: number;
  completedAuditsCount: number;
  totalCustomersAudited: number;
  queryResolutionRatePercent: number;
}

/** One message in a clarification thread (`/validation-queries/:id/messages`). */
export interface QueryMessage {
  id: string;
  authorType: 'STAFF' | 'ASSAYER';
  authorId: string;
  authorName: string | null;
  body: string | null;
  attachments: { url: string; fileName: string; fileType: string; s3Key?: string }[];
  /** Set when the desk anchored the question to a region of the audit PDF. */
  pageNumber: number | null;
  region: { x: number; y: number; w: number; h: number } | null;
  /**
   * Absolute link to the read-only web viewer that shows the desk's mark ON the assayer's own
   * packet — the real page with the questioned rectangle highlighted, opened in the phone's
   * browser. Preferred over the old cropped snapshot: a crop loses all the surrounding context.
   * Absent on older backends and on messages the desk did not pin to a region — the bubble then
   * degrades to opening the packet at the page number, or to the plain page line.
   */
  markUrl?: string | null;
  /**
   * A cropped snapshot of the exact cell the desk marked, so the assayer SEES the spot in
   * question rather than a bare "Refers to page N". Two shapes, whichever the server sends:
   * `regionImageUrl` is a ready-to-load signed URL, and `regionImageS3Key` is an object key
   * resolved to a signed URL the same way chat attachments are (React Native's <Image> cannot
   * send an auth header, so a tokened URL is required either way). Absent on messages the desk
   * did not pin to a region, and on older backends — the thread degrades to the page-number line.
   */
  regionImageUrl: string | null;
  regionImageS3Key: string | null;
  createdAt: string;
}
