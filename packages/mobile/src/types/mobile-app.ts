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
  status: 'PENDING' | 'ACCEPTED' | 'CHECKED_IN' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED';
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
