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
  assayerResponse?: string;
  // RESPONDED = assayer has submitted a response but a validator hasn't closed it yet.
  status: 'OPEN' | 'RESPONDED' | 'RESOLVED';
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
}

/**
 * The assayer's financial statement from the billing engine.
 *
 * These are the figures finance works from. The earnings screen previously derived its own
 * totals by summing agreed fees off the loaded assignments, which could not see TDS, part
 * payments, or anything on hold — so the app and the desk disagreed about what was owed.
 */
export interface AssayerPayable {
  id: string;
  payableNumber: string;
  status: string;
  assignmentId?: string;
  baseAmount: number;
  travelAmount: number;
  tdsAmount: number;
  totalAmount: number;
  paidAmount: number;
  outstanding: number;
  createdAt: string;
}

export interface AssayerPayment {
  id: string;
  paymentReference: string;
  method: string;
  amount: number;
  paidDate: string;
  balanceAfter: number | null;
  notes?: string;
}

export interface AssayerStatement {
  totals: {
    earned: number;
    paid: number;
    outstanding: number;
    awaitingApproval: number;
    onHoldOrDisputed: number;
    payableCount: number;
  };
  payables: AssayerPayable[];
  payments: AssayerPayment[];
}

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
  branchCode: string;
  bankName: string;
  branchAddress: string;
  latitude: number;
  longitude: number;
  scheduledDate: string;
  sequenceOrder: number;
  estimatedCustomerCount: number;
  estimatedAuditHours: number;
  // Mirrors AssignmentStatus in @fapoms/shared. CANCELLED was missing here even though
  // BACKEND_TO_MOBILE_STATUS already passes it through, so a cancelled job fell through
  // every status map and rendered as a raw uppercase string.
  status: 'PENDING' | 'ACCEPTED' | 'CHECKED_IN' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'CANCELLED';
  proposedFee: number;
  standardBaseFee?: number;
  agreedBaseFee: number;
  agreedTravelFee: number;
  distanceKm?: number;
  checkedInAt?: string;
  checkInGeoLat?: number;
  checkInGeoLng?: number;
  customerPdfUrl?: string;
  completedPdfUrl?: string;
  instructions?: string;
  negotiationCount?: number;
  remarks?: string;
  customers: CustomerRecord[];
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
  totalEarnings: number;
  pendingEarnings: number;
}
