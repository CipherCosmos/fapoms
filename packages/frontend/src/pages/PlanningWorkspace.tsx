import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Compass, Check, X, AlertTriangle, CheckCircle, Search, Briefcase, MapPin, Phone, Mail, Clock, DollarSign, Calendar, TrendingUp, Building2, Route, Users, Layers, Smartphone, Package, Car, Flame, BarChart3, Zap, ClipboardList, Send, Bus, Download, Eye, MessageCircle, Map as MapIcon, Home, Hourglass } from 'lucide-react';
import { ProjectBranchStatus, roleLabel, formatDateOnly, formatRouteDistance, formatTravelTime, type RouteSource, callOutcomeLabel, CALL_OUTCOME_LABELS } from '@fapoms/shared';
import { branchStatusLabel, isBranchCovered, coverageFromStatuses, localDateKey, todayDateKey } from '../utils/statusLabels';
import { api } from '../services/api';
import { userMessage } from '../services/errors';
import { LoadFailure } from '../components/LoadFailure';
import { loadFailed } from '../queryClient';
import { queryKeys } from '../hooks/queryKeys';
import { useScope, withScope, scopeConflict } from '../context/ScopeContext';
import { useUrlSelection } from '../hooks/useUrlSelection';
import { InteractivePlanningMap } from '../components/InteractivePlanningMap';
import { BranchHistoryDrawer } from './planning/BranchHistoryDrawer';
import { useToast, Modal, Select, useConfirm } from '../components/ui';
import { ScoreBreakdown } from './planning/ScoreBreakdown';
import { AssayerDetailModal } from './planning/AssayerDetailModal';
import { type RemarkSummary } from '../components/AssayerRemarks';
import { ExcludedCandidatesPanel } from './planning/ExcludedCandidatesPanel';
import { CoveragePlanModal } from './planning/CoveragePlanModal';
import { BranchListPanel, RecommendationPanel, ProjectBranch } from './planning';
import {
  getProjects,
  getZones,
  getProjectBranches,
  getPricingRates,
  getDayPlans,
  getRecommendations,
  suggestAuditDate,
  optimizeRoute,
  offerBranchesInBulk,
  markBranchesUnableToCover,
} from '../services/planning';
import { WORK_TAB_STRIP_HEIGHT } from './work/workTabs';

import { money } from '../utils/money';
import { visibleSelection, hiddenSelectionNote } from '../utils/selection';
import { counted } from '../utils/plural';
import { PLANNING_JOBS, DEFAULT_PLANNING_JOB, PLANNING_JOB_STORAGE_KEY, MAP_PANEL, feeReferenceLine, type PlanningJob } from './planning/vocabulary';

/** Why the card's fee is not the fee. Shared with the candidate-detail modal. */
export const NOTE_AUDIT_FEE = "The audit fee only. Travel is priced on top from the client's rate card, using the distance shown here — the total is confirmed before anything is sent.";

/**
 * "Unable to cover" reasons, seeded from context rather than mined from real history (no
 * assignment has hit this path yet on this database). This is the desk-side equivalent of the
 * assignment controller's own decline-reason comment (`assignment.controller.ts`, ~line 620) —
 * "Assayer unavailable" is kept as the exact same string on purpose since it names the same real
 * event there. The rest of the two lists genuinely differ: a decline is the assayer's own reason
 * for turning down one offer, this is the desk's reason nobody could be found or sent at all, so
 * they are not merged into a single shared list.
 */
const UNABLE_TO_COVER_REASON_PRESETS = [
  'No assayer in this area',
  'Distance/logistics infeasible',
  'Client access denied',
  'Assayer unavailable',
] as const;
const UNABLE_REASON_OTHER = 'Other';

/** Mirrors FeeBreakdown from packages/backend/src/modules/pricing/fee-policy.service.ts. */
interface FeeQuote {
  baseFee: number;
  branchCount: number;
  baseComponent: number;
  distanceKm: number;
  chargeableKm: number;
  travelFee: number;
  total: number;
  usedFallbackBaseFee: boolean;
  rates: {
    travelFeePerKm: number;
    freeTravelAllowanceKm: number;
    defaultBaseFee: number;
    clientConfigured: boolean;
  };
  /** Where the travel figure came from — the transport rate card, or the legacy per-km contract. */
  travelSource?: 'TRANSPORT_RATE_CARD' | 'CLIENT_RATE_CARD' | 'PLATFORM_DEFAULT';
  transport?: {
    distanceKm: number;
    options: Array<TransportOption>;
    recommended: TransportOption | null;
  } | null;
  /** Mode and one-way minutes of the recommended option; null on the legacy per-km path. */
  travelMode?: string | null;
  travelDurationMinutes?: number | null;
}

/** One priced mode from the transport rate card, as `TransportRateService.estimate()` returns it. */
interface TransportOption {
  mode: string; modeLabel: string; baseFare: number; perKmRate: number;
  oneWayCost: number; roundTripCost: number; preferred: boolean;
  /** One-way minutes; `timeSource` says whether that is a road route or an average-speed estimate. */
  oneWayMinutes?: number; roundTripMinutes?: number;
  timeSource?: 'ROAD_ROUTE' | 'RATE_CARD_ESTIMATE';
  /** False when a business rule ruled it out (e.g. flight under 500 km); `whyNot` says which. */
  viable?: boolean; whyNot?: string | null;
  rank?: number;
  /** Set on the recommended option only: "cheapest viable", "best cost-time balance: …", "preferred for X". */
  reason?: string | null;
}

/**
 * The six arrangements this workspace can take, and the plain names shown for them.
 *
 * Module-level so the `Layout ▾` button can name the current arrangement without duplicating
 * the list; previously the labels existed only inside the six buttons that rendered them.
 */
interface ProjectOption {
  id: string;
  name: string;
  projectNumber: string;
  /** Whose zones and branches this project draws on — see `loadZones`. */
  clientId?: string;
}



export interface Candidate {
  id: string;
  assayerCode: string;
  displayName: string;
  phone: string;
  email: string | null;
  status: string;
  state: string;
  district: string;
  city: string;
  distanceKm: number | null;
  /**
   * Straight-line km from branch to HOME — the metric the map circle draws and the engine's
   * radius pre-filter measures. Radius comparisons use this (falling back to `distanceKm` for
   * payloads predating it); `distanceKm` (road) is for display, cost and ETA. Road runs ~1.28×
   * the straight line, so mixing the two made "inside the circle" and "within the radius"
   * disagree about the same person.
   */
  straightDistanceKm?: number | null;
  /** One-way minutes, same provenance as distanceKm. */
  durationMinutes?: number | null;
  /** 'OSRM' = measured by road; 'ESTIMATE' = straight line at an assumed speed (routing was down). */
  distanceSource?: 'OSRM' | 'ESTIMATE' | null;
  latitude: number | null;
  longitude: number | null;
  score?: number;
  baseFee?: number;
  /** True when `baseFee` is the platform-wide default, not this assayer's own contracted rate. */
  usedFallbackBaseFee?: boolean;
  pendingOnThisBranch?: boolean;
  /** Backend already computes these; the UI previously discarded them. */
  readableReasons?: { label: string; detail?: string; sentiment?: string }[];
  scoreBreakdown?: Record<string, number>;
  /** What each dimension actually added to the score, in points. */
  scoreContribution?: Record<string, number>;
  /**
   * Set only when "Ignore date availability" is on and this candidate has a clash on the
   * planned date ("Already booked that day on ASG-0042.", "On leave 2026-08-10 to 2026-08-14.").
   * Null means genuinely free. Relaxing the filter reveals the person; it must not conceal the
   * clash, or the operator dispatches into a double-booking believing the list was clean.
   */
  dateConflict?: string | null;
  /** The client's service limit, set only when this candidate is beyond it. */
  exceedsClientRange?: number | null;
  /** The client standing this candidate was let through on, when that rule was relaxed. */
  clientStandingIssue?: string | null;
  /**
   * What staff have said about this person, exactly as the engine's `remarksScore` read it —
   * count of rated remarks in the last year, their recency-weighted mean (−2…+2), the latest
   * one. Drives the "N remarks · avg −0.7" chip so a moved score is never a mystery.
   */
  remarkSummary?: RemarkSummary;
}

/** A candidate the engine filtered out, and why. */
interface ExcludedCandidate {
  assayerId: string;
  displayName: string;
  reason: string;
  detail?: string;
  kind?: 'DATE' | 'ROTATION' | 'DISTANCE' | 'POLICY' | 'SKILLS' | 'ONBOARDING';
  distanceKm?: number | null;
  /** 'OSRM' by road, 'ESTIMATE' straight line — the panel labels the figure accordingly. */
  distanceSource?: RouteSource | null;
  nextAvailableDate?: string | null;
}

export interface AssayerDetail {
  id: string;
  assayerCode: string;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode: string | null;
  status: string;
  lifecycleStatus: string;
  employmentType: string;
  joiningDate: string | null;
  department: string | null;
  region: string | null;
  skills: string[] | null;
  certifications: { name: string; expiryDate: string }[] | null;
  languages: string[] | null;
  specializations: string[] | null;
  experienceYears: number;
  performanceRating: number;
  totalAssignments: number;
  completedAssignments: number;
  cancelledAssignments: number;
  onTimeCompletions: number;
  lastAssignmentDate: string | null;
  averageRating: number;
  notes: string | null;
  queryCount?: number;
  acceptanceRate?: number;
  rejectionRate?: number;
  auditHistory?: Array<{
    id: string;
    assignment_number: string;
    status: string;
    agreed_fee: number;
    proposed_fee: number;
    scheduled_date: string;
    completion_date: string;
    branch_name: string;
    branch_city: string;
    branch_state: string;
    project_name: string;
  }>;
  activeCommercialProfile?: {
    baseFee: number;
    hourlyRate?: number;
    dailyRate?: number;
    travelReimbursement?: number;
  } | null;
}

interface DayPlanStop {
  order: number;
  branchId: string;
  branchName: string;
  solId: string;
  address: string;
  estimatedAuditHours: number;
  travelFromPreviousKm: number;
  travelFromPreviousMinutes: number;
  estimatedArrival: string;
  estimatedDeparture: string;
}

interface DayPlanCandidate {
  assayerId: string;
  assayerName: string;
  assayerCode: string;
  assayerCity: string;
  assayerPhone: string;
  overallScore: number;
  totalBranches: number;
  totalAuditHours: number;
  totalTravelKm: number;
  totalTravelMinutes: number;
  totalDayHours: number;
  estimatedBaseFee: number;
  estimatedTravelFee: number;
  estimatedTotalCost: number;
  dayStartTime: string;
  dayEndTime: string;
  utilizationPercent: number;
  totalPackets: number;
  costPerPacket: number | null;
  idleHours: number;
  stops: DayPlanStop[];
  clientPreferencesMatch: {
    skillsMatch: boolean;
    certificationsMatch: boolean;
    distanceWithinRange: boolean;
    isPreferredAssayer: boolean;
  };
}

interface BranchCluster {
  clusterId: string;
  radiusKm: number;
  // `id` (the project-branch id) was missing from this type though the backend always sends
  // it — assigning a day plan needs it for POST /assignments, which takes projectBranchId,
  // not the bare branch id.
  branches: Array<{
    id: string; branchId: string; branchName: string; solId: string;
    estimatedDurationHours: number; city: string; district: string;
    /** Packets in THIS cycle — what actually determines how long the branch takes. */
    packetCount: number | null;
    /** True when hours came from the stale per-branch estimate, not this cycle's packets. */
    durationFromStaticFallback: boolean;
  }>;
  totalPackets: number;
  totalEstimatedAuditHours: number;
  feasibleForOneDay: boolean;
}

interface ProjectDayPlan {
  projectId: string;
  projectName: string;
  targetDate: string;
  /** Stricter of the operator's manual filter and the client's own configured floor; null when neither applies. */
  effectiveMinDistanceKm: number | null;
  clusters: Array<{
    cluster: BranchCluster;
    dayPlans: DayPlanCandidate[];
    bestPlan: DayPlanCandidate | null;
    excludedAssayers: ExcludedCandidate[];
  }>;
  unclusteredBranches: Array<{ branchId: string; branchName: string; reason: string }>;
  /** Requested date wasn't workable (holiday/weekend) and the planner moved forward. */
  dateAdjustment: { requestedDate: string; reason: string } | null;
  /** Lone branches that would consume a full paid day for a few hours of work. */
  underutilizedBranches: Array<{
    branchId: string; branchName: string; packetCount: number | null;
    auditHours: number; idleHours: number; note: string;
  }>;
  /**
   * Branches whose own workload exceeds one working day, with the assayer-days each needs.
   * These used to appear as "cluster exceeds daily capacity" in unclusteredBranches — true,
   * unactionable, and repeated on every visit.
   */
  multiDayBranches: Array<{
    branchId: string; branchName: string; packetCount: number | null;
    auditHours: number; daysRequired: number; note: string;
  }>;
  summary: {
    totalClusters: number;
    totalBranchesCovered: number;
    totalAssayersNeeded: number;
    estimatedTotalCost: number;
    averageUtilization: number;
    totalPackets: number;
    averagePacketsPerDay: number;
    averageCostPerPacket: number | null;
  };
}

// Values derive straight from the shared enum, wording from the shared status
// vocabulary — so this page can never drift from Field Execution or Scheduling
// in either the set of statuses it offers or what it calls them.
const STATUS_OPTIONS = [
  { value: 'ALL', label: 'All Statuses' },
  ...Object.values(ProjectBranchStatus).map(value => ({ value, label: branchStatusLabel(value) })),
];

/**
 * Frozen empties for the "query has not answered yet" case.
 *
 * `data ?? []` looks harmless and is not: it mints a new array on every render, so anything that
 * depends on it — a `useMemo`, a `useEffect`, `React.memo` on the map — sees a change every time
 * this component renders, and this component has some sixty pieces of state. Reusing one constant
 * keeps "no data" referentially stable, which is what lets the map skip rebuilding several hundred
 * Leaflet markers because an unrelated checkbox moved.
 */
const NO_BRANCHES: ProjectBranch[] = [];
const NO_CANDIDATES: Candidate[] = [];
const NO_EXCLUDED: ExcludedCandidate[] = [];
const NO_PROJECTS: ProjectOption[] = [];
const NO_ZONES: { id: string; name: string }[] = [];
const NO_CONTACT: Record<string, { outcome: string; timestamp: string; negotiatedFee: number | null }> = {};





/**
 * Shows the strongest and weakest dimensions behind a candidate's score.
 *
 * The engine has always returned a full per-dimension breakdown; the UI discarded it and
 * showed only a single "% Match" number with a hardcoded tooltip listing six dimensions
 * (there are fifteen). Ops had no way to tell a candidate who is close-but-unreliable from
 * one who is distant-but-excellent.
 */










/**
 * What staff have said about an assayer, said in words a clerk already understands.
 *
 * The chip used to read "1 remark · avg +2.0". That +2.0 is the raw internal remark scale
 * (−2…+2, see modules/assayer-remarks and migration AssayerRemarkRatings1791430000000): a
 * signed number, out of nothing stated, on a scale that appears nowhere in front of a user.
 * A clerk cannot tell whether +2.0 is excellent or barely adequate, and a *negative* average
 * — the one that actually matters before dispatching someone — is even easier to misread.
 *
 * The backend already owns the conversion the rest of the product shows: `recomputeAverageRating`
 * in assayer.service.ts stores `3 + mean`, clamped to 1–5, which is the figure the assayer
 * profile and the mobile "out of 5" tile display. Applying the same arithmetic here means the
 * planning desk quotes ONE scale with everything else, and the word in front of it means the
 * number never has to be interpreted at all.
 *
 * The figure itself is unchanged — this is presentation only. Note the engine's mean is
 * recency-weighted while the profile's lifetime average is not, so the wording says
 * "recently" rather than implying the two are the same number.
 */
const remarkVerdict = (mean: number): { word: string; outOfFive: string } => ({
  word:
    mean >= 1.5 ? 'very good' :
    mean >= 0.5 ? 'good' :
    mean > -0.5 ? 'mixed' :
    mean > -1.5 ? 'poor' : 'very poor',
  // Same mapping the backend uses for every other "out of 5" surface in the product.
  outOfFive: Math.max(1, Math.min(5, 3 + mean)).toFixed(1),
});

export const PlanningWorkspace: React.FC = () => {
  // The header's global scope narrows the coverage queue. This page keeps its own project
  // selector — planning is inherently one project at a time — so only the geographic
  // dimensions are taken from the header here.
  const { scopeParams, scopeKey, setScope } = useScope();
  const scopeQuery = withScope(scopeParams);
  const queryClient = useQueryClient();

  const { toast } = useToast();
  /**
   * The project is url-backed both ways now.
   *
   * It used to *seed* from `?projectId=` and then live in `useState`, so an inbound link worked
   * but the operator's own choice never reached the address bar — a refresh dropped back to
   * whichever project sorted first. Reading and writing the same place removes the asymmetry.
   */
  const [projectIdParam, setProjectIdParam] = useUrlSelection('projectId');
  const selectedProjectId = projectIdParam ?? '';
  const setSelectedProjectId = setProjectIdParam;
  /**
   * The selected branch lives in the URL, like the project above it.
   *
   * It was plain `useState`, so a refresh — or stepping to another screen to reschedule or
   * reassign and coming back — dropped the branch the operator was working on, and they had to
   * find it in the list again. The project was already deep-linkable; the branch inside it was
   * not, which is the half that costs the most to re-establish.
   */
  const [selectedBranchId, setSelectedBranchId] = useUrlSelection('branchId');
  const [historyBranchId, setHistoryBranchId] = useState<string | null>(null);
  const [routePoints, setRoutePoints] = useState<{ latitude: number; longitude: number }[] | undefined>(undefined);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizedSummary, setOptimizedSummary] = useState<{ totalDistanceKm: number; totalDurationMinutes: number } | null>(null);
  /**
   * The visit order the solver actually returned, kept as project-branch ids in the order they
   * should be driven.
   *
   * "Optimise route" always called a real TSP solver, but the answer was used only to bend the
   * blue line on the map — the branch queue underneath stayed in whatever order it happened to
   * be in, so the coordinator re-sorted by hand the very stops the solver had just sorted. The
   * order is now first-class state: the queue is re-ordered by it (see `filteredBranches`) and
   * the route card lists the stops as "1 → 2 → 3", so pressing the button changes the plan
   * rather than only the picture.
   *
   * Cleared whenever the project changes, or a different assayer is routed, because an order is
   * only meaningful for the set of branches it was computed over.
   */
  const [optimizedStops, setOptimizedStops] = useState<{
    candidateId: string;
    /** projectBranch ids, first stop first. */
    branchIds: string[];
    /** Display names in the same order, so the card need not re-look-them-up. */
    stopNames: string[];
  } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [stateFilter, setStateFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [cityFilter, setCityFilter] = useState('');
  const [districtFilter, setDistrictFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('ALL');
  const [zoneFilter, setZoneFilter] = useState('ALL');

  // The Call & Assign confirmation modal — the desk settles the fee on the phone and records
  // the result here. (Formerly the "negotiation modal", which also had a counter-back mode;
  // in-app fee negotiation was removed 2026-09 and only this flow remains.)
  const [showAssignModal, setShowAssignModal] = useState(false);
  /**
   * The reason that lets a blocked-but-overridable candidate through, typed in the assign modal.
   *
   * Seeded when the modal opens for someone the client's distance limit would refuse, so the
   * operator is answering a question the screen asked rather than decoding a refusal afterwards.
   */
  const [overrideReasonInput, setOverrideReasonInput] = useState('');
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null);
  const [selectedCandidateForMap, setSelectedCandidateForMap] = useState<Candidate | null>(null);
  // The server's quote for the currently selected candidate, so every fee figure on this
  // page comes from one place instead of being recomputed inline in three of them.
  const [feeQuote, setFeeQuote] = useState<FeeQuote | null>(null);
  /** Failed day-plan legs, keyed by `clusterId:assayerId`, so they can be retried on their own. */
  /** Branches ticked for bulk assignment. Distinct from `selectedBranchId`, which is the one
      branch whose candidates are shown. */
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [bulkScheduledDate, setBulkScheduledDate] = useState('');
  const [bulkFailures, setBulkFailures] = useState<Array<{ branchId: string; branchName: string; error: string }>>([]);
  /**
   * Where a bulk run on the server has got to ("Offering branches (37/120)"). Bulk offer and bulk
   * unable-to-cover are jobs now, and a few hundred branches is minutes, not a moment.
   */
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const [dayPlanFailures, setDayPlanFailures] = useState<Record<string, Array<{ branchId: string; branchName: string; error: string }>>>({});
  /** The total fee (base + travel) agreed on the call, as typed into the assign modal. */
  const [agreedFeeInput, setAgreedFeeInput] = useState('');
  const [loadingCommercial, setLoadingCommercial] = useState(false);
  const [autoDispatch, setAutoDispatch] = useState(true);
  /**
   * Whether the desk confirms the assignment itself instead of leaving the assayer an offer
   * to accept.
   *
   * Defaults ON for this screen, because both flows that use it are phone calls: Call & Assign
   * exists to reach agreement out loud (a call that ends any other way is recorded through
   * "Log call outcome…" instead), and bulk assign offers a run of branches to one assayer the
   * operator has just spoken to. Leaving an offer for someone who already said yes only delays
   * the branch — and an unanswered offer past its SLA is auto-declined, so it can silently
   * come back unstaffed.
   *
   * Sticky per operator: whoever works the phones differently should not have to re-tick it on
   * every call.
   */
  // Kept for the host below. Nothing on this screen dispatches work on one click any more —
  // both assign buttons open the form, and the form's own Confirm is the confirmation.
  const { confirmDialog } = useConfirm();
  const [assignDirectly, setAssignDirectly] = useState<boolean>(
    () => localStorage.getItem('planning_assignDirectly') !== 'false',
  );
  useEffect(() => {
    localStorage.setItem('planning_assignDirectly', String(assignDirectly));
  }, [assignDirectly]);
  const [scheduledAuditDate, setScheduledAuditDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return localDateKey(d);
  });
  /**
   * Auto vs manual date mode. While false (auto), selecting a branch asks the backend for the
   * first workable audit date (skips Sundays, state holidays, off Saturdays) and seeds the
   * picker with it. The moment ops touches the picker, their choice is pinned and branch
   * switches stop overwriting it — manual mode until the page reloads.
   *
   * State rather than the ref it used to be, so it can also switch OFF the suggestion query
   * below. As a ref it could only guard the assignment after the fact, which meant the desk kept
   * asking the server for a date it had already decided to ignore on every branch click.
   */
  const [planDatePinned, setPlanDatePinned] = useState(false);
  const pinPlanDate = (v: string) => { setPlanDatePinned(true); setScheduledAuditDate(v); };

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showAssayerDetailModal, setShowAssayerDetailModal] = useState(false);
  const [detailAssayer, setDetailAssayer] = useState<AssayerDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  /**
   * Why the detail modal has no profile in it.
   *
   * The load was `catch { console.error('Failed to load assayer details'); }`, leaving
   * `detailAssayer` null — and null is the modal's "Assayer not found." state. So a 403, a 500 or
   * a dropped connection told a planner that the person whose card they had just clicked does not
   * exist, on the screen where they decide whether to offer that person a day's work.
   */
  const [detailError, setDetailError] = useState<unknown>(null);
  /** The card the detail modal was opened from — its branch-specific match context. */
  const [detailCandidate, setDetailCandidate] = useState<Candidate | null>(null);
  const [showAllCandidates, setShowAllCandidates] = useState(false);
  /**
   * Rank the whole nearby workforce, treating a booking or leave on the planned date as
   * advisory rather than disqualifying.
   *
   * Off by default, because the ranked list should normally mean "these people can actually do
   * it that day". It exists because the date filter answers a narrower question than the one
   * ops asks first — "who could cover this branch at all?" — and a diary clash is usually
   * resolved by moving the date, not by removing the person. Candidates kept this way come back
   * with `dateConflict` set and are labelled on the row, so nothing is hidden.
   */
  const [ignoreDateAvailability, setIgnoreDateAvailability] = useState(false);
  /**
   * Rank people the client has not empanelled — ON by default, at operations' request.
   *
   * The reason it defaults on is the data: more than half the active workforce has no Active or
   * Recommended standing recorded with any client, so the compliance-strict list is frequently
   * empty, and an empty candidate list gets worked around outside the system rather than inside
   * it. Relaxed is not ignored — the standing is stated on every card it applies to, and the
   * write path still refuses to create the assignment without a recorded reason.
   */
  const [ignoreClientPolicy, setIgnoreClientPolicy] = useState(true);
  /**
   * Search the whole workforce rather than a disc around the branch.
   *
   * Off by default: it is the wider, slower search, and the narrower one is right most of the
   * time. This turns off the distance PRE-FILTER only — the client's conflict-of-interest
   * minimum still excludes, and says so on the excluded panel.
   */
  const [ignoreDistancePolicy, setIgnoreDistancePolicy] = useState(false);
  /**
   * The conflict-of-interest independence floor — an optional manual override, OFF by default.
   *
   * This is not an SLA. The backend uses "SLA" for travel time and scores a nearby assayer
   * *higher* for it (`recommendation.engine.ts`: `dist <= 15` earns +20, "High SLA guarantee
   * zone"). What this control does is the opposite thing: hide candidates who live too CLOSE to
   * the branch, because auditing somewhere you have local ties is a conflict of interest.
   *
   * It used to default to ON at 50 km, and `PlanningWorkspace` sent that figure to the backend
   * as `minDistanceKm`, where `resolveMinDistanceKm` takes `Math.max` of it and the client's own
   * value. Clients contract this floor at 5–10 km. So the screen silently overrode the contract
   * by a factor of five to ten and hid every genuinely nearby assayer, by default, from every
   * planner — who then dispatched someone 50 km away and billed the travel. Worse, the page's
   * own empty-list warning describes the symptom without naming the cause.
   *
   * Default OFF: the backend already enforces the client's real floor through
   * `DistancePolicyFilter`, so leaving this alone gets the contracted behaviour. Turning it on is
   * a deliberate act of tightening beyond the contract for one session.
   */
  const [slaEnabled, setSlaEnabled] = useState(false);
  const [slaRadius, setSlaRadius] = useState(50);
  /**
   * The map's search radius, owned here so one number governs the whole screen.
   *
   * This is the control the operator actually reaches for ("Search Radius (350km)" on the map),
   * and until now it only decided which pins were drawn — the engine searched a fixed 200 km
   * that nothing on screen mentioned. Setting 350 km therefore produced markers for assayers
   * who were never candidates, with an empty list beside them and no way to connect the two.
   *
   * Seeded from the key the map itself persisted, so an operator's existing choice carries over
   * rather than silently resetting the first time they open this page after the change.
   */
  const [searchRadiusKm, setSearchRadiusKm] = useState<number>(() => {
    const saved = Number(localStorage.getItem('map_radiusKm'));
    return Number.isFinite(saved) && saved > 0 ? saved : 300;
  });
  // Unified radius: the panel's "Nearby (within X km)" IS the map's search radius. One number now
  // governs both the circle the map draws and which candidates the list keeps, so the two can no
  // longer disagree about who is "nearby". This was a separate `maxRadius` filter (default 200 km)
  // that diverged from the map's `searchRadiusKm` (default 300) — the map drew pins the list hid,
  // and vice versa. It is now DERIVED, not its own state: the radius always applies unless "Any
  // distance" (`showAllCandidates`) lifts the list bound, and the panel's Nearby control writes
  // straight to `searchRadiusKm`. The min-distance independence floor (`slaRadius`) is untouched.
  const maxRadius = searchRadiusKm;
  const setMaxRadius = setSearchRadiusKm;
  const maxRadiusEnabled = !showAllCandidates;
  const setMaxRadiusEnabled = (_on: boolean) => { /* radius always applies; "Any distance" is the escape hatch */ };
  // The excluded candidate whose "assign anyway" override is currently being persisted.
  const [assigningExcludedId, setAssigningExcludedId] = useState<string | null>(null);
  // Whole-project coverage-plan (generate → approve → deploy) modal.
  const [showCoveragePlan, setShowCoveragePlan] = useState(false);
  // Structured "unable to cover" reason capture (replaces window.prompt). Holds the target branch
  // ids and a label; one flow serves both the single-branch and bulk cases.
  const [unableModal, setUnableModal] = useState<{ ids: string[]; label: string } | null>(null);
  const [unableReason, setUnableReason] = useState('');
  const [unableSubmitting, setUnableSubmitting] = useState(false);
  // Escape closes this dialog, matching every other overlay in the app — it had no keyboard
  // dismissal at all, only the backdrop click (itself guarded so a submit-in-flight can't be lost).
  useEffect(() => {
    if (!unableModal) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape' && !unableSubmitting) setUnableModal(null); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [unableModal, unableSubmitting]);

  // ── Server reads ────────────────────────────────────────────────────────────────
  /**
   * Everything this desk loads is a React Query, and none of it is a socket subscription.
   *
   * What was here before: seven `useState` + `fetch` loaders, two independent socket
   * subscriptions covering eight events between them, and two `useEffect`s that depended on the
   * `branches` ARRAY rather than on an id. Because one of those effects wrote state that another
   * one depended on, a single `assignment:status-changed` cascaded into roughly six requests —
   * the whole unpaginated coverage queue, the recommendation engine, the call log and the date
   * suggestion — with nothing aborted, so a slow response for a branch the operator had already
   * left could land afterwards and repaint the panel with the wrong candidates. A 500-branch
   * bulk import cost thousands of requests per open desk.
   *
   * Keys instead. `useSocketInvalidation` (mounted once in the Layout) coalesces every one of
   * those events into a single invalidation of `['planning', 'branches']` and
   * `['planning', 'recommendations']`; React Query dedupes concurrent fetches, keeps the previous
   * data on screen while refetching, and passes a `signal` that actually cancels the superseded
   * request. Reference data — the project list, zones, the rate card — is not in that map at all,
   * because no assignment event can change it.
   */
  const projectsQuery = useQuery({
    queryKey: queryKeys.planning.projects,
    queryFn: ({ signal }) => getProjects(signal),
    staleTime: 5 * 60_000,
  });
  const projects = (projectsQuery.data ?? NO_PROJECTS) as ProjectOption[];

  /**
   * Land on a project without fighting the URL.
   *
   * The old `loadProjects` set `selectedProjectId` to `response[0].id` unconditionally, which
   * silently overrode the `?projectId=` the page had just read out of the query string — so a
   * link to a specific project always opened whichever project happened to sort first. Only fill
   * in a project when there is none, or when the one asked for is not in this user's list at all
   * (a stale bookmark, or a project outside their scope), which is the one case where falling
   * back to the first is better than showing an empty screen.
   */
  /**
   * ...and do not fight the header either.
   *
   * The condition above used to also re-select when the chosen project was absent from `projects`.
   * But `projects` is scoped: narrowing the header's scope shrinks that list, so the effect fired
   * and moved the operator to `projects[0]` — a project they had not chosen, with no indication
   * that their selection had been discarded. Changing the header is exactly when someone is
   * paying attention to what changed, and this changed something else.
   *
   * So it fills a blank and nothing more. A selection that falls outside the current scope is
   * kept, the request carries the header's value (see `withScope`), and `conflict` below puts the
   * disagreement on screen with both ways out of it.
   */
  useEffect(() => {
    if (projects.length === 0) return;
    if (!selectedProjectId) setSelectedProjectId(projects[0].id);
    // `setSelectedProjectId` is useUrlSelection's setter, which is rebuilt when the query string
    // changes (react-router keys `setSearchParams` on `searchParams`). Listing it is still safe, and
    // cheaper than it looks: the guard above reads `projectIdParam` out of that same query string,
    // so the moment this writes a project the guard closes and every later re-run is a no-op. It
    // cannot feed itself.
  }, [projects, selectedProjectId, setSelectedProjectId]);

  /** Set when the chosen project contradicts the header's project, rather than narrowing under it. */
  const scopeMismatch = useMemo(
    () => scopeConflict(scopeParams, { projectId: selectedProjectId || undefined }),
    [scopeParams, selectedProjectId],
  );

  const selectedProjectClientId = useMemo(
    () => projects.find(p => p.id === selectedProjectId)?.clientId,
    [projects, selectedProjectId],
  );

  /**
   * Only the selected project's client's zones — see `getZones`. Without the client filter the
   * dropdown listed every client's zones under identical names, and the ones that did not belong
   * to this project could never match a branch.
   */
  const zonesQuery = useQuery({
    queryKey: queryKeys.planning.zones(selectedProjectClientId),
    queryFn: ({ signal }) => getZones(selectedProjectClientId, signal),
    staleTime: 5 * 60_000,
  });
  const zones = zonesQuery.data ?? NO_ZONES;

  const branchesQuery = useQuery({
    // `scopeKey` is part of the key because the coverage queue is filtered server-side by the
    // header's region/zone selection — a scope change is a different result set, not a re-slice.
    queryKey: queryKeys.planning.branches(selectedProjectId, scopeKey),
    queryFn: ({ signal }) => getProjectBranches<ProjectBranch>(selectedProjectId, scopeQuery, signal),
    enabled: !!selectedProjectId,
    staleTime: 30_000,
  });
  const branches = branchesQuery.data ?? NO_BRANCHES;
  /**
   * `isLoading`, not `isFetching`: the panel must not blank itself back to a spinner every time a
   * socket event refreshes the queue underneath it. A background refetch keeps the current rows
   * on screen and swaps them when the answer arrives; only the first load of a project (or a
   * scope change, which is a different query) shows the loading state.
   */
  const isLoadingQueue = branchesQuery.isLoading;
  /**
   * The coverage queue had NO failure path at all: `branchesQuery.data ?? NO_BRANCHES` and
   * nothing else, so a refused or failed queue arrived at the panel as an empty list and the
   * panel said "No branches in this project yet. Add branches to the project before visits can
   * be planned for them." That is an instruction to import a branch file, given to a planner
   * whose project already has its branches and whose request was refused. Planning is
   * region-scoped, so a 403 here is an everyday answer for a desk outside the region.
   *
   * Built once and passed to all four layouts' panels, so they cannot disagree about it.
   */
  const queueFailure = loadFailed(branchesQuery)
    ? <LoadFailure style={{ margin: 8 }} loads={[{ label: 'the coverage queue', query: branchesQuery }]} />
    : null;

  /**
   * Keep whatever branch is already selected if the refresh still contains it.
   *
   * The queue reloads after nearly every action on this page — assign, bulk-assign, a
   * coverage-plan deploy, or a realtime event for a branch that is not even the one open — and it
   * used to snap back to `data[0]` every single time. Confirming an assignment on branch #12
   * would refresh the queue and silently swap the open panel to branch #1, so finishing one call
   * meant re-finding whichever branch you had actually been working on. Only fall back to the
   * first branch (or none) when the previous selection is genuinely gone — completed, reassigned
   * elsewhere, or this is the first load.
   *
   * This runs on `branches` identity, which React Query only changes when the data actually
   * changed (structural sharing); an unchanged refetch is a no-op here.
   */
  useEffect(() => {
    // Reads the selection rather than taking a functional update, because it now lives in the URL
    // and the url is the value. Keeping a valid choice is a no-op, so re-running on the selection
    // itself is harmless.
    // An empty list is "not loaded yet", never "your branch is gone".
    //
    // This is what still dropped a refreshed selection after the url work. On reload `branches`
    // is `[]` for a beat, so `branches.some(...)` was false, and the line below wrote `null` —
    // erasing the very query parameter the page had just been opened with. The data then
    // arrived, found no selection, and filled in `branches[0]`. Asking for the tenth branch and
    // getting the first was not a race in the loader; it was this effect deleting the answer
    // before the question could be checked.
    if (branches.length === 0) return;

    const stillThere = selectedBranchId && branches.some(b => b.id === selectedBranchId);
    if (stillThere) return;

    // Loaded, and the selection genuinely is not in it — a branch from another project, or a
    // stale link. Landing on the first is better than an empty workspace.
    setSelectedBranchId(branches[0].id);
  }, [branches, selectedBranchId, setSelectedBranchId]);

  const selectedPb = useMemo(
    () => branches.find(b => b.id === selectedBranchId),
    [branches, selectedBranchId],
  );
  /**
   * The BRANCH id, which is what the engine takes — `selectedBranchId` is a PROJECT-branch id.
   * Passing the wrong one 404s ("Branch … not found"), which the panel reports as "could not load
   * recommendations", and the two ids are indistinguishable at a glance.
   */
  const selectedBranchKey = selectedPb?.branchId ?? null;

  /**
   * The radius the engine actually searches: the map's radius control, widened by the panel's
   * "Within X km" when that is set further out. Neither control may promise a distance the engine
   * did not look at — that mismatch is what produced map pins with no matching candidate row.
   */
  const engineRadiusKm = Math.max(searchRadiusKm, maxRadiusEnabled ? maxRadius : 0);

  const candidatesQuery = useQuery({
    // Date, availability rule and radius are all in the key because each one changes the answer:
    // recommendations are evaluated FOR a date (availability and fees differ by day), the
    // "ignore date availability" toggle changes which candidates the engine returns at all, and
    // the radius bounds its search. Re-slicing a cached list would silently cap the radius at
    // whatever the last request found.
    queryKey: queryKeys.planning.recommendations(
      selectedBranchKey ?? '', scheduledAuditDate, ignoreDateAvailability, engineRadiusKm,
      ignoreClientPolicy, ignoreDistancePolicy,
    ),
    queryFn: ({ signal }) => getRecommendations<Candidate, ExcludedCandidate>(
      selectedBranchKey!, scheduledAuditDate, ignoreDateAvailability, engineRadiusKm, signal,
      ignoreClientPolicy, ignoreDistancePolicy,
    ),
    enabled: !!selectedBranchKey,
    staleTime: 30_000,
  });
  const candidates = candidatesQuery.data?.data ?? NO_CANDIDATES;
  const excludedCandidates = candidatesQuery.data?.meta?.excluded ?? NO_EXCLUDED;
  const isLoadingCandidates = candidatesQuery.isLoading;
  /**
   * A failure has to look different from "nobody suitable".
   *
   * This was a bare `catch { console.error(...) }`, so a 500 from the engine and a genuinely
   * empty candidate list rendered identically — an empty panel, with no indication that anything
   * had broken. That was fixed with a `userMessage(candidatesQuery.error)` line; `loadFailed`
   * finishes the job, because `isError` is false for a query that failed and PAUSED, which put
   * the panel straight back on the "nobody is eligible for this date" branch with no error to
   * show. It also stops offering Retry on a 403 or a 404 — the branch-id mix-up this panel is
   * known for 404s every time, and a Retry button on it only teaches the operator to press it.
   */
  const candidatesFailed = loadFailed(candidatesQuery);

  /** "Have we already tried this person?" — the question ops otherwise answers by redialling. */
  const lastContactQuery = useQuery({
    queryKey: queryKeys.planning.lastContact(selectedBranchId ?? ''),
    queryFn: ({ signal }) => api.request<Record<string, { outcome: string; timestamp: string; negotiatedFee: number | null }>>(
      `/call-logs/last-contact?projectBranchId=${selectedBranchId}`,
      { method: 'GET', signal },
    ),
    enabled: !!selectedBranchId,
    staleTime: 60_000,
  });
  const lastContact = lastContactQuery.data ?? NO_CONTACT;

  /**
   * The client's contracted travel rates for the selected project, so the map quotes travel the
   * way the platform bills it rather than with its own hardcoded per-km figure.
   */
  const travelRatesQuery = useQuery({
    queryKey: queryKeys.planning.pricingRates(selectedProjectId),
    queryFn: ({ signal }) => getPricingRates(selectedProjectId, signal),
    enabled: !!selectedProjectId,
    staleTime: 10 * 60_000,
  });
  const travelRates = travelRatesQuery.data ?? null;

  /**
   * Auto date mode: the first workable audit date for THIS branch (its state's holidays, working
   * Saturdays), used to seed the picker. Disabled outright once ops pins a date, so the desk
   * stops asking the server for an answer it has already decided to ignore.
   */
  const suggestedDateQuery = useQuery({
    queryKey: queryKeys.planning.suggestedDate(selectedBranchKey ?? ''),
    queryFn: ({ signal }) => suggestAuditDate(selectedBranchKey!, signal),
    enabled: !!selectedBranchKey && !planDatePinned,
    staleTime: 10 * 60_000,
  });
  useEffect(() => {
    const suggested = suggestedDateQuery.data?.date;
    // The suggestion is best-effort; if it fails or the operator has pinned a date in the
    // meantime, the existing value (tomorrow, or their choice) stands.
    if (suggested && !planDatePinned) setScheduledAuditDate(suggested);
  }, [suggestedDateQuery.data, planDatePinned]);

  /**
   * The two ways this page asks for fresh server state.
   *
   * Both invalidate a PREFIX rather than refetching one query object, because the same data is
   * cached per project, per scope and per set of engine parameters — after a bulk assign the
   * operator may well switch scope, and a queue left stale under the old key would come back
   * showing branches that have since been staffed. Only the queries actually mounted refetch;
   * the rest are simply marked stale.
   */
  const refreshBranches = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.planning.queue });
  }, [queryClient]);
  const refreshCandidates = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.planning.recommendationsAll });
  }, [queryClient]);

  // Single source of truth for "which candidates are actually eligible right now". The map
  // previously ranked off the raw `candidates` array, so an assayer who fails the min-radius
  // check (too close to the branch — see the "Inside Radius" flag below) could still show a
  // gold #1 badge on the map, contradicting the sidebar which excludes/flags them. Both now
  // read from this one filtered list.
  const displayCandidates = useMemo(() => {
    // Compose the two radius bounds instead of short-circuiting. Min-radius is the audit-independence
    // floor (hide too-close assayers); max-radius is the service radius (show only within X km).
    // Both can apply at once. Unknown distance is always shown.
    // `showAllCandidates` lifts the max bound entirely for a full sweep.
    //
    // BOTH cuts measure straight-line from home (`straightDistanceKm`), the same metric the map
    // circle draws and the server's own distance-policy floor uses (haversine on home coords —
    // recommendation.engine DistancePolicyFilter). Cutting by road distance here disagreed with
    // both: road runs ~1.28× straight, so the max cut dropped people whose pins sat inside the
    // circle, and the min cut showed people the server's independence floor would refuse.
    return candidates.filter(c => {
      const radial = c.straightDistanceKm ?? c.distanceKm;
      if (slaEnabled && radial != null && radial < slaRadius) return false;
      if (!showAllCandidates && maxRadiusEnabled && radial != null && radial > maxRadius) return false;
      return true;
    });
  }, [candidates, slaEnabled, slaRadius, maxRadiusEnabled, maxRadius, showAllCandidates]);
  /**
   * Why the list is this short, when the list is not empty.
   *
   * The "no candidates" panel below explains itself well, but it only renders when the list is
   * *empty*. The case that actually confuses operators is a list with one name on it: the screen
   * shows a single distant assayer and says nothing about the twenty-five who were removed, so
   * the natural reading is that the engine is broken or that nobody else exists.
   *
   * On this deployment that is exactly what happens — one assayer holds the skills and the
   * certification the gold-audit projects require, so every branch of those projects matches him
   * and only him, whatever the distance. The engine is right; the roster is thin. That is a
   * sentence the screen has to say, because no amount of re-picking dates or widening radii will
   * change it.
   */
  const qualificationBlock = useMemo(() => {
    const skills = excludedCandidates.filter(e => e.kind === 'SKILLS');
    if (skills.length === 0) return null;
    // The engine names the missing attributes per assayer; they are the same list in the common
    // case, so the first one reads as the requirement rather than as one person's gap.
    const detail = skills.find(e => e.detail)?.detail ?? null;
    return { count: skills.length, considered: skills.length + displayCandidates.length, detail };
  }, [excludedCandidates, displayCandidates]);

  /**
   * Listed candidates the map will not draw, because they fall outside its search radius.
   * Measured the way the map measures — straight-line — so this count names exactly the pins
   * that are missing, not people whose road distance merely exceeds the number.
   */
  const offMapCount = useMemo(
    () => displayCandidates.filter(c => {
      const radial = c.straightDistanceKm ?? c.distanceKm;
      return radial != null && radial > searchRadiusKm;
    }).length,
    [displayCandidates, searchRadiusKm],
  );

  const drawerRef = useRef<HTMLDivElement>(null);
  const [dayPlanData, setDayPlanData] = useState<ProjectDayPlan | null>(null);
  /**
   * Projects to plan together. Empty means "just the one currently selected", which keeps the
   * screen behaving as before until an operator deliberately widens the scope.
   */
  const [dayPlanProjectIds, setDayPlanProjectIds] = useState<string[]>([]);
  const [isLoadingDayPlans, setIsLoadingDayPlans] = useState(false);
  /**
   * Why the day plans are not on screen, when they are not.
   *
   * A failed generate used to reach `console.error` and nowhere else, and because the loader
   * clears `dayPlanData` first, the panel fell back to its untouched prompt — "Click Generate
   * Day Plans to cluster branches…" — to a planner who had just clicked exactly that. Kept out
   * of the page-wide `message` banner because that one carries the result of the last commit,
   * which runs a reload immediately afterwards and would otherwise overwrite itself.
   */
  const [dayPlanError, setDayPlanError] = useState<string | null>(null);
  /** The day-plan job's stage label while it runs. */
  const [dayPlanProgress, setDayPlanProgress] = useState<string | null>(null);
  /**
   * The day-plan job this screen is following. A newer request (a project chip, a date change)
   * stops following the older one, so a slow earlier plan cannot land after — and over — a newer one.
   */
  const dayPlanWatch = useRef<{ cancelled: boolean }>({ cancelled: false });
  // Leaving the page stops following the job (it carries on, on the server).
  useEffect(() => () => { dayPlanWatch.current.cancelled = true; }, []);
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null);
  // Day plans previously had no date picker at all — always locked to the backend's default
  // of "right now", with no way to ask "what would tomorrow's coverage look like". Defaults to
  // tomorrow since field audits are scheduled ahead, not same-day.
  const [dayPlanTargetDate, setDayPlanTargetDate] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return localDateKey(d);
  });
  const [dayPlanAssigning, setDayPlanAssigning] = useState<string | null>(null);

  /**
   * A different project is a different route and a different optimisation — the old one's
   * polyline and distance summary describe branches that are no longer on screen.
   */
  useEffect(() => {
    setRoutePoints(undefined);
    setOptimizedSummary(null);
    // The visit order belongs to the previous project's branches; leaving it would re-sort a
    // queue it knows nothing about.
    setOptimizedStops(null);
  }, [selectedProjectId]);

  /**
   * The map's highlighted assayer belongs to the branch that was open, so it is cleared when the
   * branch changes rather than left pointing at a route between two unrelated places.
   */
  useEffect(() => {
    setSelectedCandidateForMap(null);
  }, [selectedBranchId]);

  useEffect(() => {
    if (selectedBranchId && drawerRef.current) {
      drawerRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedBranchId]);

  const handleOptimizeRoute = async (candidate: Candidate) => {
    let assignedBranches = branches.filter(b => b.assignment && b.assignment.assayer?.displayName === candidate.displayName);
    if (assignedBranches.length === 0 && selectedBranchId) {
      const currentPb = branches.find(b => b.id === selectedBranchId);
      if (currentPb) {
        assignedBranches = [currentPb];
      }
    }
    if (assignedBranches.length === 0) {
      toast({ type: 'warning', title: 'Nothing to route', message: `${candidate.displayName} has no branches selected yet. Pick at least one branch first.` });
      return;
    }
    const originLat = candidate.latitude ?? assignedBranches[0].branch.latitude;
    const originLng = candidate.longitude ?? assignedBranches[0].branch.longitude;
    if (!originLat || !originLng) { toast({ type: 'warning', title: 'No starting location', message: 'This assayer has no saved location yet, so a route cannot be worked out. Add their address in Workforce first.' }); return; }
    const destinations = assignedBranches.filter(b => b.branch.latitude !== null && b.branch.longitude !== null).map(b => ({ id: b.branch.id, latitude: b.branch.latitude!, longitude: b.branch.longitude! }));
    if (destinations.length === 0) { toast({ type: 'warning', title: 'No branch locations', message: 'None of these branches have a location saved, so a route cannot be worked out.' }); return; }
    setIsOptimizing(true);
    setOptimizedSummary(null);
    setRoutePoints(undefined);
    setOptimizedStops(null);
    try {
      const data = await optimizeRoute({ origin: { latitude: originLat, longitude: originLng }, destinations, roundTrip: true, mode: 'driving' });
      const { optimizedSequence, totalDistanceKm, totalDurationMinutes } = data;
      const points = [{ latitude: originLat, longitude: originLng }];
      // Same walk over the solver's answer now records the order as well as the geometry. The
      // solver speaks in *branch* ids; the queue and every selection on this page are keyed by
      // *project-branch* id, so translate once here rather than at each place that consumes it.
      const orderedBranchIds: string[] = [];
      const orderedStopNames: string[] = [];
      for (const destId of optimizedSequence) {
        const matchedBranch = assignedBranches.find(b => b.branch.id === destId);
        if (!matchedBranch) continue;
        orderedBranchIds.push(matchedBranch.id);
        orderedStopNames.push(matchedBranch.branch.name);
        if (matchedBranch.branch.latitude && matchedBranch.branch.longitude) points.push({ latitude: matchedBranch.branch.latitude, longitude: matchedBranch.branch.longitude });
      }
      points.push({ latitude: originLat, longitude: originLng });
      setRoutePoints(points);
      setOptimizedSummary({ totalDistanceKm, totalDurationMinutes });
      // Only worth keeping when there is genuinely something to order: a single stop has no
      // sequence, and pretending otherwise would re-sort the queue for no reason.
      if (orderedBranchIds.length > 1) {
        setOptimizedStops({ candidateId: candidate.id, branchIds: orderedBranchIds, stopNames: orderedStopNames });
        toast({
          type: 'success',
          title: 'Visit order applied',
          message: `The ${orderedBranchIds.length} branches are now listed in the shortest driving order, starting with ${orderedStopNames[0]}.`,
        });
      }
    } catch { toast({ type: 'error', title: 'Route could not be calculated', message: 'Could not reach the routing service. Check your connection and try again.' }); }
    finally { setIsOptimizing(false); }
  };

  /**
   * `projectIdsOverride` lets the project chips reload immediately on click rather than
   * waiting for the next render to observe the new state.
   */
  const loadDayPlans = async (projectIdsOverride?: string[]) => {
    if (!selectedProjectId) return;
    dayPlanWatch.current.cancelled = true;
    const watch = { cancelled: false };
    dayPlanWatch.current = watch;
    setIsLoadingDayPlans(true);
    setDayPlanData(null);
    setDayPlanError(null);
    setDayPlanProgress(null);
    try {
      // Reuses the exact "Min Radius Filter" control already on this page (slaEnabled/
      // slaRadius) instead of a separate day-plans-only control — one setting, consistent
      // everywhere. Previously this request sent no params at all: no date (always locked to
      // the backend's "right now" default) and no radius (the endpoint had no minimum-distance
      // concept whatsoever until this fix).
      // Several projects can be planned together so an assayer's day is built from every
      // nearby branch, not just those in one engagement.
      const projectIdsForPlan = Array.from(
        new Set([...(selectedProjectId ? [selectedProjectId] : []), ...(projectIdsOverride ?? dayPlanProjectIds)]),
      );
      const data = await getDayPlans<ProjectDayPlan>({
        targetDate: dayPlanTargetDate,
        projectIds: projectIdsForPlan,
        minDistanceKm: slaEnabled ? slaRadius : undefined,
      }, { signal: watch, onProgress: (p) => { if (!watch.cancelled) setDayPlanProgress(p.stage); } });
      if (watch.cancelled) return;
      setDayPlanData(data);
      if (data.clusters?.length > 0) setExpandedCluster(data.clusters[0].cluster.clusterId);
    } catch (err) { if (!watch.cancelled) setDayPlanError(userMessage(err)); }
    finally {
      if (!watch.cancelled) {
        setIsLoadingDayPlans(false);
        setDayPlanProgress(null);
      }
    }
  };

  /**
   * Commits a day-plan candidate: creates a real assignment for every branch in the cluster,
   * all with this assayer and the plan's target date.
   *
   * Previously this whole screen was read-only — a detailed, correctly-computed report of the
   * optimal multi-branch route and cost that ops could only look at, then had to go re-create
   * by hand, branch by branch, through the single-branch flow. That defeats the point of
   * clustering in the first place: the value is committing to all N branches in one action.
   *
   * Base + travel cost is split evenly across the cluster's branches so each created
   * assignment carries a real proposed fee (summing back to the plan's estimatedTotalCost)
   * rather than 0 or a guess.
   */
  /**
   * Assign a day plan's stops to one assayer.
   *
   * `onlyBranchIds` re-runs just the legs that failed last time. A day plan is a single
   * physical route, so a partial failure used to leave the assayer with a broken day and ops
   * with nothing but an error string naming the branches — every retry meant re-assigning the
   * whole route and hitting "Branch Busy" on the legs that had already succeeded.
   *
   * No `proposedFee` is sent: the server prices each branch from the client's contracted rate
   * card for that specific assayer and distance. This used to divide the plan's total by the
   * branch count and send that as an override, which is how the day-planner's figures reached
   * the database in place of the assign path's.
   */
  const handleAssignDayPlan = async (
    cluster: BranchCluster,
    plan: DayPlanCandidate,
    onlyBranchIds?: string[],
  ) => {
    const key = `${cluster.clusterId}:${plan.assayerId}`;
    setDayPlanAssigning(key);

    const stops = onlyBranchIds
      ? plan.stops.filter((s) => onlyBranchIds.includes(s.branchId))
      : plan.stops;

    // Each stop is a distinct branch → distinct assignment record, so these are independent and run
    // concurrently rather than one serial round-trip per stop (a 10-branch route was 10x slower than
    // it needed to be). Per-item results are still collected for the retry-failed-only flow below.
    const results = await Promise.all(
      stops.map(async (stop) => {
        const branchMeta = cluster.branches.find((b) => b.branchId === stop.branchId);
        if (!branchMeta) {
          return { branchId: stop.branchId, branchName: stop.branchName, ok: false, error: 'Branch missing from cluster data' };
        }
        try {
          await api.request('/assignments', {
            method: 'POST',
            body: JSON.stringify({
              projectBranchId: branchMeta.id,
              assayerId: plan.assayerId,
              // The date the plan was actually built for, not the operator's raw request. The
              // planner moves off weekends and holidays and reports the shift in the banner
              // above; sending dayPlanTargetDate committed the rejected date instead, so an
              // audit could be booked onto the very Saturday the planner had just refused.
              scheduledDate: dayPlanData?.targetDate ?? dayPlanTargetDate,
              remarks: `Assigned via Day Plan ${cluster.clusterId} — ${plan.totalBranches}-branch route with ${plan.assayerName}`,
            }),
          });
          return { branchId: stop.branchId, branchName: stop.branchName, ok: true };
        } catch (err: any) {
          return { branchId: stop.branchId, branchName: stop.branchName, ok: false, error: err?.message || 'Failed' };
        }
      }),
    );

    setDayPlanAssigning(null);
    const failed = results.filter((r) => !r.ok);

    if (failed.length === 0) {
      setDayPlanFailures((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setMessage({
        type: 'success',
        text: onlyBranchIds
          ? `Retry succeeded — all ${results.length} remaining branch(es) assigned to ${plan.assayerName}.`
          : `Assigned all ${results.length} branch(es) in ${cluster.clusterId} to ${plan.assayerName}.`,
      });
    } else {
      // Held in state so the failures survive the next message and can be retried directly,
      // rather than existing only inside a transient error string.
      setDayPlanFailures((prev) => ({
        ...prev,
        [key]: failed.map((f) => ({ branchId: f.branchId, branchName: f.branchName, error: f.error || 'Failed' })),
      }));
      setMessage({
        type: 'error',
        text: `${results.length - failed.length}/${results.length} branches assigned to ${plan.assayerName}. Failed: ${failed.map((f) => `${f.branchName} (${f.error})`).join('; ')}`,
      });
    }
    refreshBranches();
    void loadDayPlans();
  };

  const toggleBulkSelect = (id: string) => {
    setBulkSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  /**
   * Tick (or untick) every unassigned branch the queue is showing right now.
   *
   * Scoped to the shown branches on both halves: unticking used to throw the whole selection away,
   * including branches the current filter happens to hide, which is the same silent surprise from
   * the other direction.
   */
  const toggleBulkSelectAll = () => {
    const selectable = filteredBranches.filter((b) => !b.assignment && b.status !== 'UNABLE_TO_COVER');
    if (selectable.length === 0) return;
    setBulkSelectedIds((prev) => {
      const allShownTicked = selectable.every((b) => prev.has(b.id));
      const next = new Set(prev);
      for (const b of selectable) { if (allShownTicked) next.delete(b.id); else next.add(b.id); }
      return next;
    });
  };

  /**
   * Offer every ticked branch to one assayer.
   *
   * Each branch is still its own assignment — this is a batch of individual offers, not a
   * routed day plan, so no travel is shared and the server prices each one independently
   * against the assayer's real distance to that branch. Failures are collected rather than
   * aborting the run: one "Branch Busy" collision shouldn't cost the other nine offers.
   */
  const handleBulkAssign = async (assayerId: string, assayerName: string) => {
    const targets = bulkTargetBranches.rows;
    if (targets.length === 0) return;

    setBulkAssigning(true);
    setBulkFailures([]);
    setBulkProgress(null);
    const nameById = new Map(targets.map((pb) => [pb.id, pb.branch?.name || pb.id]));

    /**
     * One request for the whole selection, run on the server and polled.
     *
     * This was one `POST /assignments` per ticked branch from the browser, five at a time — up to 500
     * requests against the 300-a-minute per-user limit, so a large selection had some offers refused
     * with 429. The job offers each branch in turn and reports every one as offered or refused, with
     * the refusal in its own words.
     */
    let outcome: Awaited<ReturnType<typeof offerBranchesInBulk>>;
    try {
      outcome = await offerBranchesInBulk({
        projectBranchIds: targets.map((pb) => pb.id),
        assayerId,
        assayerName,
        scheduledDate: bulkScheduledDate || undefined,
        acceptOnBehalf: assignDirectly,
        acceptanceReason: assignDirectly
          ? `Agreed by phone — bulk-assigned to ${assayerName} from the planning queue.`
          : undefined,
      }, { onProgress: (p) => setBulkProgress(p.stage) });
    } catch (err: any) {
      // The run as a whole did not report back (it failed, or it is still going past the wait). The
      // selection is left exactly as it was, because nothing here knows which branches it reached.
      setBulkAssigning(false);
      setBulkProgress(null);
      setMessage({
        type: 'error',
        text: `The bulk offer did not report back: ${err?.message || 'unknown error'} Refresh the queue to see which branches it reached before trying again.`,
      });
      refreshBranches();
      return;
    }

    const failures = outcome.failed.map((f) => ({
      branchId: f.projectBranchId,
      branchName: nameById.get(f.projectBranchId) || f.projectBranchId,
      error: f.error || 'Failed',
    }));
    const succeeded = outcome.succeeded.length;
    // Counted separately from `succeeded`: with "assign directly" on, a branch can be created
    // successfully and still come back as a PENDING offer if the confirmation could not be
    // applied. Reporting all of them as confirmed would hide exactly that.
    const confirmed = outcome.succeeded.filter((r) => r.status === 'ACCEPTED').length;

    setBulkAssigning(false);
    setBulkProgress(null);
    setBulkFailures(failures);
    // Only the branches that actually went through are cleared, so the selection still holds
    // exactly what remains to be dealt with.
    setBulkSelectedIds(new Set(failures.map((f) => f.branchId)));

    // "Confirmed" and "offered" are different outcomes for the branch and for whoever reads this
    // next, so the summary names whichever actually happened rather than one word for both.
    const verb = confirmed === succeeded && succeeded > 0 ? 'confirmed for' : 'offered to';
    const partial = confirmed > 0 && confirmed < succeeded
      ? ` ${confirmed} confirmed directly, ${succeeded - confirmed} left pending acceptance.`
      : '';
    setMessage(
      failures.length === 0
        ? { type: 'success', text: `All ${succeeded} branch(es) ${verb} ${assayerName}.${partial}` }
        : { type: 'error', text: `${succeeded}/${targets.length} ${verb} ${assayerName}.${partial} ${failures.length} failed — still selected for retry.` },
    );
    refreshBranches();
  };

  /**
   * Record that a branch cannot be staffed. Until now there was no way to say this: an
   * unstaffable branch stayed in IMPORTED, indistinguishable from one nobody had looked at.
   */
  const handleMarkUnableToCover = (projectBranchId: string, branchName: string) => {
    setUnableReason('');
    setUnableModal({ ids: [projectBranchId], label: branchName });
  };

  /**
   * Persist the "unable to cover" reason for one or many branches (from the modal).
   *
   * One request for the whole selection, run on the server and polled. This used to fire one POST per
   * branch all at once; past the per-user rate limit some were refused with 429 and the message named
   * them without saying why. Every branch now comes back recorded or refused with its reason.
   */
  const submitUnableToCover = async () => {
    if (!unableModal) return;
    const reason = unableReason.trim();
    if (!reason) return;
    setUnableSubmitting(true);
    setBulkProgress(null);
    const nameById = new Map(branches.map((b) => [b.id, b.branch?.name || b.id]));

    let outcome: Awaited<ReturnType<typeof markBranchesUnableToCover>>;
    try {
      outcome = await markBranchesUnableToCover(unableModal.ids, reason, {
        onProgress: (p) => setBulkProgress(p.stage),
        // Usually one branch or a handful: poll a little faster than the default so the modal
        // does not sit for a second and a half on a job that took a tenth of that.
        pollMs: 750,
      });
    } catch (err: any) {
      setUnableSubmitting(false);
      setBulkProgress(null);
      // The modal stays open with the reason still typed, so the coordinator can try again.
      setMessage({
        type: 'error',
        text: `Could not record ${unableModal.label} as unable to cover: ${err?.message || 'unknown error'} Refresh the queue to see what was recorded.`,
      });
      refreshBranches();
      return;
    }

    const recorded = new Set(outcome.succeeded.map((o) => o.projectBranchId));
    const failed = outcome.failed.map((f) => `${nameById.get(f.projectBranchId) || f.projectBranchId} (${f.error})`);
    const ok = recorded.size;
    const total = ok + outcome.failed.length;
    setUnableSubmitting(false);
    setBulkProgress(null);
    // Only what was actually recorded is unticked. A branch the server refused stays selected so
    // the coordinator can simply try again, instead of hunting it back down in the queue.
    if (unableModal.ids.length > 1) {
      setBulkSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of recorded) next.delete(id);
        return next;
      });
    }
    setUnableModal(null);
    setUnableReason('');
    setMessage(
      failed.length === 0
        ? { type: 'success', text: `${ok} branch(es) recorded as unable to cover.` }
        : { type: 'error', text: `${ok}/${total} recorded. Failed: ${failed.join('; ')}` },
    );
    refreshBranches();
  };

  /** Put an uncoverable branch back into the planning pool. */
  const handleReopenCoverage = async (projectBranchId: string, branchName: string) => {
    try {
      await api.request(`/projects/branches/${projectBranchId}/reopen-coverage`, { method: 'POST' });
      setMessage({ type: 'success', text: `${branchName} returned to planning.` });
      refreshBranches();
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Could not reopen this branch.' });
    }
  };

  const loadAssayerDetail = async (candidate: Candidate) => {
    setDetailCandidate(candidate);
    setLoadingDetail(true);
    setDetailError(null);
    setShowAssayerDetailModal(true);
    try {
      // Remarks, qualification, eligibility and live workload are fetched inside the modal
      // itself (each its own API, one of them shared with the HR drawer) — only the base
      // profile is loaded here.
      const profile = await api.request<AssayerDetail>(`/assayers/${candidate.id}/profile`, { method: 'GET' });
      setDetailAssayer(profile);
    } catch (e) { setDetailError(e); }
    finally { setLoadingDetail(false); }
  };

  /**
   * What this candidate would actually cost — from the server's calculator, never recomputed here.
   *
   * Lifted out of `handleCallAndAssign` because "Send to app" needs the same number and did not
   * have it: its confirmation said the fee would be "recorded on our side at the quoted amount"
   * without ever naming the amount, so the one control on this screen that commits money without
   * a form was also the one that showed none. The card above shows `baseFee` alone, and the
   * figure the server records is `baseComponent + travelFee` — on a distant branch those are not
   * close.
   *
   * Returns null rather than throwing: a quote that cannot be fetched must not block the action
   * (the server quotes it again regardless), but the operator has to be told they are committing
   * without seeing it.
   */
  const fetchFeeQuote = async (c: Candidate): Promise<FeeQuote | null> => {
    try {
      return await api.request<FeeQuote>('/pricing/quote', {
        method: 'POST',
        body: JSON.stringify({
          assayerId: c.id,
          projectId: selectedProjectId || undefined,
          distanceKm: c.distanceKm || 0,
          durationMinutes: c.durationMinutes && c.durationMinutes > 0 ? c.durationMinutes : undefined,
          roadSource: c.durationMinutes && c.durationMinutes > 0 ? (c.distanceSource ?? 'ESTIMATE') : undefined,
          branchId: branches.find((b) => b.id === selectedBranchId)?.branchId || undefined,
        }),
      });
    } catch {
      return null;
    }
  };

  /**
   * Quotes the client's contracted fee and opens the assign modal. Named (rather than left
   * as the card button's inline handler) so the candidate-detail modal can trigger the exact
   * same flow without a second copy of the fee-quote logic.
   */
  const openAssignment = async (c: Candidate, agreedOnCall: boolean) => {
    setSelectedCandidate(c);
    setLoadingCommercial(true);
    // The only thing the two buttons disagree about: whether somebody has already said yes.
    // The money is typed in the same box either way.
    setAssignDirectly(agreedOnCall);
    try {
      // Quoted by the server against the client's contracted rate card — `fetchFeeQuote` above
      // is the single request both this and "Send to app" make. This used to recompute the fee
      // here from a hardcoded ₹8/km and a ₹1200 fallback, which meant the recommended fee shown
      // to ops could differ from what the server actually stored on assign.
      const quote = await fetchFeeQuote(c);
      if (!quote) throw new Error('quote unavailable');
      setFeeQuote(quote);
      setAgreedFeeInput(String(Math.round(Number(quote.total))));
    } catch {
      // No silent second formula: if the quote fails, show what we know rather than inventing
      // a number that the server would then reject or override.
      setFeeQuote(null);
      setAgreedFeeInput('');
      setMessage({ type: 'error', text: 'Could not retrieve the contracted fee for this assayer. Enter the agreed fee manually.' });
    } finally {
      setLoadingCommercial(false);
      // Pre-filled, not pre-decided: the operator can replace or clear it, and the button below
      // stays disabled until something is there.
      setOverrideReasonInput(
        c.clientStandingIssue
          ? 'Not on this client\'s panel — cleared by ops for this branch.'
          : c.exceedsClientRange != null
            ? `Beyond the client's ${c.exceedsClientRange} km limit — nobody nearer is available.`
            : '',
      );
      setShowAssignModal(true);
    }
  };

  /**
   * Send to app — the SAME form as Call & Assign, with nobody having agreed yet.
   *
   * It used to be a different mechanism entirely: a confirm dialog and a direct POST with no fee
   * field at all, so the rate card's number became the recorded number with nobody typing it.
   * That is not how this business prices work. The desk rings the assayer, they settle on a
   * figure, and THAT figure is what the assignment must carry — the rate card is a reference the
   * desk reads, not a decision the system makes.
   *
   * So there is one form now. Both buttons quote the rate card, pre-fill it as a starting point,
   * and let the desk type what was actually agreed. They differ only in `assignDirectly`: after
   * a call the assayer has already accepted, so the assignment goes straight to ACCEPTED; sent
   * to the app it stays PENDING until they accept there. Price and acceptance are separate
   * questions and are asked separately.
   */
  const handleSendToApp = (c: Candidate) => openAssignment(c, false);

  const handleConfirmAssignment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBranchId || !selectedCandidate) return;
    setMessage(null);
    /**
     * The modal closes on success, not on submit.
     *
     * Closing it up-front threw away everything typed the moment the server refused — a fee
     * rejected for being below zero, a date that turned out to be a holiday, a rule the assayer
     * failed. The operator was left on the branch list with an error banner and had to reopen the
     * candidate and re-enter the fee, the date and both checkboxes to correct one field.
     */
    try {
      const created = await api.request<{ status?: string }>('/assignments', {
        method: 'POST',
        body: JSON.stringify({
          projectBranchId: selectedBranchId,
          assayerId: selectedCandidate.id,
          proposedFee: Number(agreedFeeInput),
          scheduledDate: scheduledAuditDate,
          autoSchedule: autoDispatch,
          acceptOnBehalf: assignDirectly,
          acceptanceReason: assignDirectly
            ? `Agreed at ${money(agreedFeeInput)} during Call & Assign.`
            : undefined,
          /**
           * Sent only when a rule on this candidate actually needs waiving.
           *
           * The engine ranks a candidate beyond the client's service limit rather than hiding
           * them — distance is a cost preference, not the compliance floor — but the write path
           * requires a stated reason for it. Without this the modal collected a fee, a date and
           * two checkboxes, posted, and was refused for a rule it had never mentioned. Sending it
           * unconditionally would be worse: an override recorded against every ordinary
           * assignment is an audit trail nobody can read.
           */
          overrideReason: overrideReasonInput.trim() || undefined,
        })
      });
      // The call that produced this agreement is the record of who committed to what fee, and
      // when. `call_logs` has existed since the first migration with nowhere writing to it, so
      // a negotiated fee had no supporting record if the assayer later disputed it. Logged
      // after the assignment so a logging failure can never cost the assignment itself.
      recordCall(selectedCandidate.id, 'AGREED', Number(agreedFeeInput), 'Agreed during Call & Assign');

      // Reports what the server actually did, not what was asked for. Direct assignment can fall
      // back to a PENDING offer if the confirmation could not be applied, and telling ops the job
      // is locked when it is still waiting on someone is the failure this whole change is about.
      // Only now is it safe to dismiss: the assignment exists.
      setShowAssignModal(false);
      const confirmed = created?.status === 'ACCEPTED';
      setMessage({
        type: 'success',
        text: confirmed
          ? `${selectedCandidate.displayName} is confirmed for this branch — no acceptance needed. They have been notified on the mobile app.`
          : `Offered this branch to ${selectedCandidate.displayName}. It stays pending until they accept on the mobile app${assignDirectly ? ', or you accept it from the Operations Inbox' : ''}.`,
      });
      refreshBranches();
    } catch (err: any) {
      setMessage({ type: 'error', text: userMessage(err) });
    }
  };

  /**
   * Record the outcome of phoning an assayer.
   *
   * Deliberately fire-and-forget: this is a supporting record, and losing it must never block
   * or undo the operational action it accompanies.
   */
  const recordCall = (
    assayerId: string,
    outcome: 'AGREED' | 'DECLINED' | 'NO_ANSWER' | 'CALLBACK_REQUESTED' | 'WRONG_NUMBER',
    // The call-log API's own field name: the fee agreed out loud on the phone. Historical rows
    // with a NEGOTIATING outcome still display through `callOutcomeLabel`; this page just no
    // longer records that outcome since in-app fee negotiation was removed.
    negotiatedFee?: number,
    notes?: string,
  ) => {
    if (!selectedBranchId) return;
    api.request('/call-logs', {
      method: 'POST',
      body: JSON.stringify({
        projectBranchId: selectedBranchId,
        assayerId,
        outcome,
        // The server rejects a fee on outcomes where no fee was discussed.
        negotiatedFee: outcome === 'AGREED' ? negotiatedFee : undefined,
        notes,
      }),
    })
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.planning.lastContact(selectedBranchId) }))
      .catch(() => { /* supporting record only */ });
  };

  const handleExportCoverageReport = async () => {
    if (!selectedProjectId || branches.length === 0) return;

    const data = branches.map((b) => ({
      'SOL ID': b.branch?.solId || '',
      'Branch Name': b.branch?.name || '',
      'City': b.branch?.city || '',
      'District': b.branch?.district || '',
      'State': b.branch?.state || '',
      'Priority': b.priority || '',
      'Zone ID': b.zoneId || '',
      'Status': b.status,
      'Audit Coverage Possible': isBranchCovered(b.status) ? 'YES' : 'NO (Uncovered)',
      'Assigned Assayer': b.assignment?.assayer?.displayName || 'Unassigned',
      'Assignment Status': b.assignment?.status || '—',
      'Proposed Fee (₹)': b.assignment?.proposedFee ?? '—',
      'Agreed Fee (₹)': b.assignment?.agreedFee ?? '—',
      'Scheduled Date': b.assignment?.scheduledDate
        ? formatDateOnly(b.assignment.scheduledDate)
        : b.scheduledDate
        ? formatDateOnly(b.scheduledDate)
        : 'N/A',
      'Remarks': b.remarks || '',
    }));

    /**
     * SheetJS is fetched here, on the click, and not before.
     *
     * It was a static `import * as xlsx from 'xlsx'` at the top of this file — ~333 kB of
     * spreadsheet engine which, because Rollup routes unmatched node_modules into the eager
     * `vendor` chunk that `index.html` modulepreloads, was downloaded by the LOGIN page. Every
     * user paid for it on every cold visit; this one button is the only thing in the application
     * that uses it. `vite.config.ts` gives it a chunk of its own so this import fetches exactly
     * that and nothing else.
     */
    try {
      const xlsx = await import('xlsx');
      const ws = xlsx.utils.json_to_sheet(data);
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, ws, 'Branch Coverage Schedule');
      xlsx.writeFile(wb, `Branch_Coverage_Report_${selectedProjectId}.xlsx`);
    } catch {
      // A failed chunk fetch (offline, a deploy that rotated the filename mid-session) must say
      // so — silently doing nothing reads as a broken button.
      toast({
        type: 'error',
        title: 'Export unavailable',
        message: 'The spreadsheet exporter could not be loaded. Check your connection and try again.',
      });
    }
  };

  const statesList = useMemo(
    () => Array.from(new Set(branches.map(b => b.branch?.state).filter(Boolean))),
    [branches],
  );
  /**
   * Memoised because this array is the map's input.
   *
   * As a bare `branches.filter(...)` it was a fresh array on every render of a component holding
   * some sixty pieces of state — typing in an unrelated search box, moving a radius slider,
   * opening a modal. The map takes it as a prop, so every one of those renders looked to the map
   * like "the branches changed", and it responded by removing and rebuilding every Leaflet marker
   * on screen and re-adding the tile layer.
   */
  const filteredBranches = useMemo(() => {
    const matched = branches.filter(b => {
      const q = searchTerm.toLowerCase();
      return (b.branch?.name.toLowerCase().includes(q) || b.branch?.solId?.toLowerCase().includes(q)) &&
        (stateFilter === 'ALL' || b.branch?.state === stateFilter) &&
        (statusFilter === 'ALL' || b.status === statusFilter) &&
        (cityFilter === '' || (b.branch?.city || '').toLowerCase().includes(cityFilter.toLowerCase())) &&
        (districtFilter === '' || (b.branch?.district || '').toLowerCase().includes(districtFilter.toLowerCase())) &&
        (priorityFilter === 'ALL' || b.priority === priorityFilter) &&
        (zoneFilter === 'ALL' || b.zoneId === zoneFilter);
    });
    if (!optimizedStops) return matched;
    // "Optimise route" solved the visit order; this is where that answer reaches the list the
    // coordinator actually works down. Routed branches float to the top in driving order and
    // everything else keeps its existing relative position, so the screen never silently
    // reshuffles branches the solver said nothing about.
    const rank = new Map(optimizedStops.branchIds.map((id, i) => [id, i]));
    return [...matched].sort((a, b) => {
      const ra = rank.get(a.id);
      const rb = rank.get(b.id);
      if (ra == null && rb == null) return 0;
      if (ra == null) return 1;
      if (rb == null) return -1;
      return ra - rb;
    });
  }, [branches, searchTerm, stateFilter, statusFilter, cityFilter, districtFilter, priorityFilter, zoneFilter, optimizedStops]);

  /**
   * The branches a bulk action will actually change: ticked, still listed under the current
   * search and filters, and still in a state a bulk action may touch.
   *
   * The two bulk buttons on this bar used to disagree. "Offer all to …" re-filtered against
   * `filteredBranches`, but "Mark unable to cover" posted the raw `bulkSelectedIds`, so ticking
   * branches, narrowing the state filter and pressing it recorded — permanently, and reported to
   * the client — branches the coordinator could not see and had not chosen. The count in the bar
   * agreed with neither. Both now read this one list, and so does the count. See
   * `utils/selection.ts` for why the selection is narrowed here rather than wiped on every
   * filter change.
   */
  const bulkTargetBranches = useMemo(
    () => visibleSelection(
      bulkSelectedIds,
      filteredBranches.filter((b) => !b.assignment && b.status !== 'UNABLE_TO_COVER'),
      (b) => b.id,
    ),
    [bulkSelectedIds, filteredBranches],
  );
  const bulkHiddenNote = hiddenSelectionNote(bulkTargetBranches.hiddenCount, 'branch');

  /**
   * The branch points the map actually draws, derived once instead of inline at four call sites.
   *
   * It used to be `branches={filteredBranches.map(b => ({...}))}` written out in each of the four
   * layouts — a brand-new array of brand-new objects on every render, which defeated the map's
   * `React.memo` completely no matter what the memo compared.
   */
  const mapBranches = useMemo(
    () => filteredBranches.map(b => ({
      id: b.id,
      name: b.branch.name,
      latitude: b.branch.latitude,
      longitude: b.branch.longitude,
      status: b.status,
      // One project = one client, so every branch pin in this workspace shares the project
      // client's colour in the map's colour-by-bank mode.
      clientId: selectedProjectClientId ?? undefined,
    })),
    [filteredBranches, selectedProjectClientId],
  );

  // The header badge is the same coverage figure `GET /planning/projects/:id/coverage` and the
  // client workbook report. It used to be a third hand-rolled copy of the arithmetic; the two
  // server-side copies had already drifted from each other by 36 percentage points.
  const { total: totalCount, covered: confirmedCount, coveragePercentage: coveragePct } =
    coverageFromStatuses(branches.map(b => b.status));

  /**
   * Which of the two jobs this screen does — see `planning/vocabulary.ts`.
   *
   * This replaces a Simple/Advanced toggle crossed with a six-item Layout menu. That gave
   * eleven arrangements of one screen, and the default (Simple) pinned one of them and ignored
   * the menu entirely — so the layout picker was dead controls for most people, while the map
   * it picked between was unreachable for them. One of the six entries, "Day Plans", was not an
   * arrangement at all but a separate job; it is a tab now, where somebody looking for it can
   * find it.
   */
  const [job, setJob] = useState<PlanningJob>(
    () => (localStorage.getItem(PLANNING_JOB_STORAGE_KEY) === 'day' ? 'day' : DEFAULT_PLANNING_JOB),
  );
  const setJobPersisted = (j: PlanningJob) => { setJob(j); localStorage.setItem(PLANNING_JOB_STORAGE_KEY, j); };

  /**
   * The map is a panel you open, not an arrangement you choose.
   *
   * Four of the six old layouts existed only to decide whether the map was on screen and where.
   * Worse, the per-candidate "Map" button reached the map by REWRITING the page's stored layout
   * preference to `three-col` — a global setting mutated as a local toggle, so looking at one
   * candidate's position silently changed how the page opened next time. That button now sets
   * this, which is what it always meant.
   */
  const [showMap, setShowMap] = useState<boolean>(
    () => localStorage.getItem(MAP_PANEL.storageKey) === 'true',
  );
  const setShowMapPersisted = (v: boolean) => { setShowMap(v); localStorage.setItem(MAP_PANEL.storageKey, String(v)); };
  /** Open the map because the user asked to look at something on it. */
  const revealMap = () => { if (!showMap) setShowMapPersisted(true); };

  /**
   * The one obvious starting point.
   *
   * "Which branch do I do next?" was previously answered by reading a queue of dozens and
   * judging priority by eye. This picks the highest-priority branch that still has nobody on it
   * and opens it, then scrolls its best match into view so the next click is the assign button.
   */
  const PRIORITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

  /**
   * Every branch still needing somebody, most urgent first — INCLUDING whichever is open.
   *
   * Keeping the open one in the list is the whole point. The first version excluded it and then
   * took the top of what remained, which walks the queue only while priorities differ: with two
   * equally urgent branches A and B, opening A makes B the top of the rest, and opening B makes
   * A the top again, so the button flipped between those two forever and never reached the third.
   * Reported exactly that way — "next branch to staff just moves within 2 branches only".
   *
   * `sort` is stable, so equal priorities keep the queue's own order and the walk is repeatable.
   */
  const pendingBranchesInOrder = useMemo(() => {
    const pending = filteredBranches.filter(b =>
      !b.assignment &&
      !['AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED', 'UNABLE_TO_COVER', 'CANCELLED'].includes(b.status));
    return [...pending].sort((a, b) =>
      (PRIORITY_ORDER[a.priority ?? ''] ?? 9) - (PRIORITY_ORDER[b.priority ?? ''] ?? 9));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredBranches]);

  /**
   * A cursor over that list rather than "the best one that isn't this one": step to whatever
   * follows the open branch and wrap at the end, so repeated presses visit every branch in turn
   * and come back round instead of oscillating between the top two.
   */
  const nextUnassignedBranch = useMemo(() => {
    if (pendingBranchesInOrder.length === 0) return null;
    const current = pendingBranchesInOrder.findIndex(b => b.id === selectedBranchId);
    // Nothing relevant open yet — start at the most urgent.
    if (current === -1) return pendingBranchesInOrder[0];
    // The open branch is the only one left to staff; there is nowhere to move on to.
    if (pendingBranchesInOrder.length === 1) return null;
    return pendingBranchesInOrder[(current + 1) % pendingBranchesInOrder.length] ?? null;
  }, [pendingBranchesInOrder, selectedBranchId]);

  /**
   * Set when the coordinator pressed "Next branch to staff", so the effect below knows to scroll
   * to the top match once the candidate list for the newly selected branch has rendered. A plain
   * scroll at click time would run against the previous branch's list.
   */
  const [scrollToTopMatch, setScrollToTopMatch] = useState(false);
  const topCandidateRef = useRef<HTMLDivElement>(null);
  const handleNextUnassigned = () => {
    if (!nextUnassignedBranch) return;
    setSelectedBranchId(nextUnassignedBranch.id);
    setScrollToTopMatch(true);
  };
  useEffect(() => {
    if (!scrollToTopMatch) return;
    if (!topCandidateRef.current) return;
    topCandidateRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setScrollToTopMatch(false);
  }, [scrollToTopMatch, displayCandidates]);

  const s = (sel: string, set: (v: string) => void, opts: { value: string; label: string }[]) => (
    <Select value={sel} onChange={set} options={opts} compact style={{ background: 'var(--bg-primary)' }} />
  );

  /**
   * Assign an assayer the engine had filtered out, to the currently selected branch, recording the
   * operator's reason on the assignment. The engine's filters (min-radius, workload, soft rules) are
   * advisory; this is the deliberate, auditable override for when a human knows better.
   */
  const handleAssignExcluded = async (candidate: ExcludedCandidate, reason: string, scheduledDate?: string) => {
    const selectedPb = branches.find(b => b.id === selectedBranchId);
    if (!selectedPb) {
      setMessage({ type: 'error', text: 'Select a branch before assigning an excluded candidate.' });
      return;
    }
    setAssigningExcludedId(candidate.assayerId);
    try {
      await api.request('/assignments', {
        method: 'POST',
        body: JSON.stringify({
          projectBranchId: selectedPb.id,
          assayerId: candidate.assayerId,
          // Date-bound exclusions (booked / on leave today) are assigned FOR a chosen date the
          // assayer is free — the whole point of surfacing them instead of hiding them. Every
          // other exclusion kind (POLICY/SKILLS/ROTATION/DISTANCE) leaves the panel's own
          // `scheduledDate` empty, so this used to fall through to `undefined` and let the
          // server default the assignment to its own idea of "today" — silently different from
          // the "Audit on" date the whole candidate list on screen was being evaluated against
          // (`scheduledAuditDate`, the date this override decision was actually made for). That
          // could dispatch someone for a day their availability was never checked. Falling back
          // to it here matches the regular (non-override) assign flow a few hundred lines up,
          // which has always sent `scheduledAuditDate` — the override path was the one path that
          // forgot to.
          scheduledDate: scheduledDate || scheduledAuditDate || undefined,
          remarks: `Filter override — bypassed "${candidate.reason}". Reason: ${reason}`,
          // The server now enforces this itself (an ineligible assayer 400s without it) and
          // records it on its own audit event — this was previously folded only into free-text
          // `remarks`, which nothing server-side read or required, so a direct API call could
          // omit it entirely. Sent alongside `remarks`, not instead of it: `remarks` still carries
          // the human-readable "why", `overrideReason` is what the eligibility check itself reads.
          overrideReason: reason,
        }),
      });
      const effectiveDate = scheduledDate || scheduledAuditDate;
      setMessage({
        type: 'success',
        text: `${candidate.displayName} assigned to ${selectedPb.branch?.name || 'branch'}${effectiveDate ? ` for ${effectiveDate}` : ''} (override recorded).`,
      });
      refreshBranches();
      // The candidate list has to move too: the assayer just assigned now shows as pending on
      // this branch. The id mapping that used to be needed here (project-branch id vs branch id,
      // which 404'd and blanked the panel when confused) is gone — the query owns the correct id.
      refreshCandidates();
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Override assignment failed.' });
      // Rethrow so the panel can show the same refusal inline, beside the row that was clicked.
      // The banner above is a thousand pixels up the page from that button.
      throw err;
    } finally {
      setAssigningExcludedId(null);
    }
  };

  const renderCandidatesList = (horizontal: boolean) => {
    if (isLoadingCandidates) {
      return <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>Searching for assayers...</div>;
    }
    // A failed request previously rendered as "no candidates", which is indistinguishable from
    // a genuine empty result — the operator would go looking for assayers that were never queried.
    if (candidatesFailed) {
      return <LoadFailure style={{ margin: 12 }} loads={[{ label: 'the recommended assayers', query: candidatesQuery }]} />;
    }
    if (displayCandidates.length === 0) {
      // Say what actually emptied the list. Blaming the min-radius filter when the ENGINE
      // returned nobody sent ops chasing a filter that wasn't the problem — while the real
      // story ("your only nearby assayer is blocked by the rotation rule") sat hidden, even
      // though that assayer's marker was visible on the map.
      // Onboarding exclusions get their own sentence. "No assayer is eligible for this date"
      // is actively misleading for someone whose profile was created an hour ago and has no
      // eligible dates at all — ops re-picked the date over and over instead of finishing the
      // three-step onboarding that would have fixed it.
      const onboardingCount = excludedCandidates.filter(e => e.kind === 'ONBOARDING').length;

      /**
       * When a filter emptied the list, name the bound and the distance that did it.
       *
       * "Hidden by the radius filters below" is true but unactionable: it does not say which of
       * the two bounds fired, or by how much. The case that actually happens is a branch whose
       * only candidate lives 18 km away against a 50 km independence floor — and the operator,
       * seeing assayer pins on the map beside an empty list, reasonably concludes the engine is
       * broken rather than that one number needs changing.
       */
      // Same metric as the list filter: straight-line from home, road as fallback.
      const radialOf = (c: Candidate) => c.straightDistanceKm ?? c.distanceKm;
      const withDistance = candidates.filter(c => radialOf(c) != null);
      const tooClose = slaEnabled ? withDistance.filter(c => radialOf(c)! < slaRadius) : [];
      const tooFar = !showAllCandidates && maxRadiusEnabled
        ? withDistance.filter(c => radialOf(c)! > maxRadius)
        : [];
      const nearest = withDistance.length ? Math.min(...withDistance.map(c => radialOf(c)!)) : null;

      const filterMsg = (() => {
        if (candidates.length === 0) return null;
        if (tooClose.length === candidates.length && nearest != null) {
          return `${candidates.length === 1 ? 'The only candidate is' : `All ${candidates.length} candidates are`} ` +
            `closer than your ${slaRadius} km minimum — the nearest is ${nearest.toFixed(1)} km away. ` +
            `Lower the minimum, or turn it off, to consider them.`;
        }
        if (tooFar.length === candidates.length) {
          return `${candidates.length === 1 ? 'The only candidate is' : `All ${candidates.length} candidates are`} ` +
            `beyond your ${maxRadius} km limit. Raise it, or tick “Show all distances”.`;
        }
        return `All ${candidates.length} candidate${candidates.length > 1 ? 's are' : ' is'} hidden by the radius filters below.`;
      })();

      const msg = filterMsg
        ? filterMsg
        : onboardingCount > 0 && onboardingCount === excludedCandidates.length
          ? `${onboardingCount} assayer${onboardingCount > 1 ? 's are' : ' is'} near this branch but ${onboardingCount > 1 ? 'have' : 'has'} not finished onboarding — no date will make ${onboardingCount > 1 ? 'them' : 'them'} assignable until that is done (below).`
          : excludedCandidates.length > 0
            ? `No assayer is eligible for this date — ${excludedCandidates.length} nearby ${excludedCandidates.length > 1 ? 'were' : 'was'} excluded (reasons below).`
            : 'No assayers found in range for this date.';
      return (
        <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={20} style={{ color: 'var(--accent-secondary)' }} />
          <span>{msg}</span>
          {/* When the min-radius filter hides everyone, the assayers are still there (and still on
              the map) — they're just closer than the floor. Give a one-click way to reveal them,
              rather than making ops hunt for the filter toggle to understand why the list is empty. */}
          {slaEnabled && candidates.length > 0 && (
            <button
              onClick={() => { setSlaEnabled(false); setShowAllCandidates(true); }}
              className="btn btn-secondary"
              style={{ padding: '4px 8px', fontSize: 'var(--text-3xs)' }}
            >
              Show {candidates.length} assayer{candidates.length > 1 ? 's' : ''} within {slaRadius}km
            </button>
          )}
          {!slaEnabled && !showAllCandidates && candidates.length > 0 && (
            <button onClick={() => setShowAllCandidates(true)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: 'var(--text-3xs)' }}>
              Show all ({candidates.length}) candidates
            </button>
          )}
          {/* This is the moment ops actually learns a branch can't be staffed, so it's where
              the decision belongs. Without it the only option was to leave the branch in
              IMPORTED, where it looks identical to one nobody has opened yet — which is why
              64 of 72 branches currently sit there with no way to tell the two apart. */}
          {selectedPb && selectedPb.status !== 'UNABLE_TO_COVER' && (
            <button
              onClick={() => handleMarkUnableToCover(selectedPb.id, selectedPb.branch?.name || 'this branch')}
              className="btn btn-secondary"
              style={{ padding: '5px 10px', fontSize: 'var(--text-3xs)', fontWeight: 600, color: 'var(--danger)', borderColor: 'var(--danger)' }}>
              Mark unable to cover
            </button>
          )}
          {selectedPb?.status === 'UNABLE_TO_COVER' && (
            <button
              onClick={() => handleReopenCoverage(selectedPb.id, selectedPb.branch?.name || 'this branch')}
              className="btn btn-secondary"
              style={{ padding: '5px 10px', fontSize: 'var(--text-3xs)', fontWeight: 600 }}>
              Reopen for planning
            </button>
          )}
          {/* The excluded list is MOST important exactly when the eligible list is empty — it's
              the difference between "nobody exists near this branch" and "someone is 22 km away
              but blocked by a rule you can override". It used to render only under a non-empty
              candidate list, so the empty state hid the one thing that explained the map marker. */}
          <div style={{ alignSelf: 'stretch', textAlign: 'left' }}>
            <ExcludedCandidatesPanel excluded={excludedCandidates} onAssignAnyway={handleAssignExcluded} assigningId={assigningExcludedId} defaultOpen />
          </div>
        </div>
      );
    }
    const hiddenCount = candidates.length - displayCandidates.length;
    return (
      <>
        {/*
          How many of the listed candidates the map is not drawing.
          The engine keeps distant assayers on the list deliberately; the map keeps its pins
          inside `searchRadiusKm`. Stated once here so the gap between the two views is a fact
          the operator is told, rather than one they infer from a pin that is not there.
        */}
        {qualificationBlock && (
          <div style={{ marginBottom: '8px', padding: '7px 10px', fontSize: 'var(--text-2xs)', fontWeight: 600, color: 'var(--danger)', background: 'var(--status-cancelled-bg)', borderRadius: '6px', lineHeight: 1.5 }}>
            <div>
              {qualificationBlock.count} of {qualificationBlock.considered} assayers were excluded for
              qualifications — this branch's shortlist is limited by the roster, not by distance or date.
            </div>
            {qualificationBlock.detail && (
              <div style={{ marginTop: '3px', fontWeight: 500, opacity: 0.9 }}>
                {qualificationBlock.detail.replace(/^Assayer Qualification Conflict:\s*/, '')}
              </div>
            )}
            <div style={{ marginTop: '3px', fontWeight: 500, opacity: 0.9 }}>
              Record the missing skills and certifications on the HR roster to widen this list.
            </div>
          </div>
        )}
        {offMapCount > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px', padding: '5px 9px', fontSize: 'var(--text-3xs)', fontWeight: 600, color: 'var(--warning)', background: 'var(--status-pending-bg)', borderRadius: '6px' }}>
            <span>{offMapCount} of these {offMapCount === 1 ? 'is' : 'are'} beyond {searchRadiusKm} km — listed, but not shown on the map</span>
            <button
              onClick={() => setShowAllCandidates(false)}
              className="btn btn-secondary"
              style={{ padding: '2px 8px', fontSize: 'var(--text-3xs)' }}
              /*
                These off-map names appear only under "Any distance", which lifts the list bound
                while the map still draws its circle — so the list carries candidates past
                `searchRadiusKm`. Re-applying that same radius to the list hides exactly the ones
                that are off the map. Banner and button now name ONE number, because there is one.
              */
              title={`Re-applies the ${searchRadiusKm} km search radius to the list, hiding the candidates beyond it — the same ones not drawn on the map.`}
            >
              Hide over {searchRadiusKm} km
            </button>
          </div>
        )}
        {hiddenCount > 0 && (
          // Always tell the operator when candidates are being suppressed by the filters, so a
          // short list is never mistaken for "few assayers exist". One click reveals them.
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px', padding: '5px 9px', fontSize: 'var(--text-3xs)', fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-surface-2)', borderRadius: '6px' }}>
            <span>{displayCandidates.length} shown · {hiddenCount} hidden by filters</span>
            <button
              onClick={() => { setSlaEnabled(false); setShowAllCandidates(true); }}
              className="btn btn-secondary"
              style={{ padding: '2px 8px', fontSize: 'var(--text-3xs)' }}
            >
              Show all
            </button>
          </div>
        )}
        <div style={{ display: 'flex', gap: '12px', overflowX: horizontal ? 'auto' : 'hidden', flexDirection: horizontal ? 'row' : 'column', paddingBottom: '4px' }}>
        {displayCandidates.map((c, ci) => {
          // The real weighted score, or nothing. This used to invent 98/88/74 from distance when the
          // server returned no score, showing ops a confident match % the engine never produced.
          const conf = c.score != null ? Math.round(c.score) : null;
          // This colours the card by the DISTANCE independence floor, not by any deadline. It
          // was named `slaStatus`, which is exactly the mislabel the chip text below already
          // fixed: being near the branch is good for service level and bad only for independence,
          // so "compliant"/"breach" here is about whether the assayer is far enough away to audit
          // this branch — nothing to do with the SLA clock. Renamed so the variable says so too.
          const independenceStatus = slaEnabled && c.distanceKm !== null
            ? (c.distanceKm >= slaRadius ? 'independent' : 'too-close')
            : null;
          const cardBorderColor = independenceStatus === 'independent' ? 'var(--status-active-bg)' : independenceStatus === 'too-close' ? 'var(--status-cancelled-bg)' : 'var(--border-color)';
          const cardBg = independenceStatus === 'independent' ? 'var(--status-active-bg)' : independenceStatus === 'too-close' ? 'var(--status-cancelled-bg)' : 'var(--bg-surface-2)';
          // The top match carries a ref so "Next branch to staff" can scroll straight to the
          // person it is recommending, rather than leaving the coordinator to hunt for them.
          return (
            <div key={c.id} ref={ci === 0 ? topCandidateRef : undefined} style={{
              minWidth: horizontal ? '320px' : 'auto', maxWidth: horizontal ? '340px' : 'auto', flexShrink: horizontal ? 0 : undefined,
              background: cardBg, border: `1px solid ${cardBorderColor}`, borderRadius: 'var(--radius-md)', padding: '14px',
              display: 'flex', flexDirection: 'column', gap: '10px'
            }}>
              {/* Prior contact, so nobody is called twice about the same branch. Until now no
                  call left any trace at all, making this unanswerable from the screen. */}
              {lastContact[c.id] && (() => {
                const lc = lastContact[c.id];
                const hrs = Math.round((Date.now() - new Date(lc.timestamp).getTime()) / 3_600_000);
                const when = hrs < 1 ? 'just now' : hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
                const negative = ['NO_ANSWER', 'DECLINED', 'WRONG_NUMBER'].includes(lc.outcome);
                return (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '4px',
                    fontSize: 'var(--text-3xs)', fontWeight: 600, padding: '4px 8px', borderRadius: 'var(--radius-sm)',
                    background: negative ? 'var(--status-cancelled-bg)' : 'var(--status-pending-bg)',
                    color: negative ? 'var(--danger)' : 'var(--warning)',
                  }}>
                    <Phone size={10} /> {callOutcomeLabel(lc.outcome)} · {when}
                    {lc.negotiatedFee != null && ` · ₹${lc.negotiatedFee.toLocaleString()}`}
                  </div>
                );
              })()}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {c.displayName}
                    {c.pendingOnThisBranch && (
                      <span title="This assayer already has a pending offer on this branch awaiting their response" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: 'var(--text-3xs)', fontWeight: 700, padding: '2px 7px', borderRadius: '6px', background: 'var(--status-pending-bg)', color: 'var(--warning)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                        <Hourglass size={9} /> Pending Response
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px', flexWrap: 'wrap' }}>
                    <Compass size={11} style={{ flexShrink: 0 }} />
                    {/*
                      Distance and time, and — the part that was missing — WHICH KIND of distance.
                      The engine now routes by road (OSRM) and falls back to straight-line only
                      when routing is unavailable; a straight-line figure at an assumed 40 km/h is
                      not the same fact as a road figure and must not wear the same label. Measured
                      on this branch: 107.7 km crow-flies became 145.4 km by road (+35%).
                    */}
                    <span title={c.distanceSource === 'OSRM'
                      ? 'Measured along the road network (OSRM).'
                      : c.distanceSource === 'ESTIMATE'
                      ? 'Straight-line estimate at an assumed speed — road routing was unavailable when this was computed. The road is longer, typically by 11–56 %.'
                      : c.distanceKm !== null ? 'This server did not say how the distance was measured; treated as an estimate.' : undefined}>
                      {/* One formatter for every surface (shared/utils.ts): "213 km by road" /
                          "~164 km (straight line, estimate)"; an unlabelled figure is hedged,
                          never promoted to a road figure. */}
                      {formatRouteDistance(c.distanceKm, c.distanceSource ?? null)}
                      {c.durationMinutes != null && c.distanceKm !== null && (
                        /*
                          The provenance suffix belongs to the PAIR, not to each half. Both shared
                          formatters append it independently, so the two of them side by side read
                          "327 km by road · 4 h 25 min by road" — the same qualification twice in
                          one twelve-word line, which reads like a rendering fault rather than a
                          fact. The distance carries the label (it is the figure people quote);
                          the time, which shares its provenance by construction, drops the repeat.
                          The formatters are untouched — every other surface still gets both.
                        */
                        <> · {formatTravelTime(c.durationMinutes, c.distanceSource ?? null).replace(' by road', '')}</>
                      )}
                    </span>
                    {/*
                      This chip is about the *independence floor* — "far enough away not to be
                      auditing their own doorstep" — and nothing else. Labelled "✓ >50km Radius"
                      it read as general approval, so an assayer 1,749 km away wore a green tick
                      and no other distance signal at all. It now says which rule it is answering.
                    */}
                    {slaEnabled && c.distanceKm !== null && (
                      <span title={`Client independence rule: an assayer must be at least ${slaRadius} km from the branch they audit.`} style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: 'var(--text-3xs)', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: c.distanceKm >= slaRadius ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)', color: c.distanceKm >= slaRadius ? 'var(--success)' : 'var(--danger)' }}>
                        {c.distanceKm >= slaRadius ? <><Check size={9} /> independent (&gt;{slaRadius}km)</> : <><X size={9} /> too close (&lt;{slaRadius}km)</>}
                      </span>
                    )}
                    {/*
                      And the ceiling, which nothing on this card used to mention.
                      The engine deliberately does not exclude on the service radius — see
                      `DistancePolicyFilter`, which relaxes it because enforcing it cut a
                      26-candidate list to 2 — so distant assayers stay listed and merely rank
                      last. The map, meanwhile, hard-filters its pins to `searchRadiusKm`. Both
                      behaviours are defensible; the pair of them silently disagreeing is not,
                      and it is why someone can be recommended here and absent from the map.
                    */}
                    {(c.straightDistanceKm ?? c.distanceKm) !== null && (c.straightDistanceKm ?? c.distanceKm)! > searchRadiusKm && (
                      <span title={`Beyond the ${searchRadiusKm} km search radius, so this assayer is not drawn on the map. Still listed because no one closer may be available — ranked accordingly.`} style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: 'var(--text-3xs)', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: 'var(--status-pending-bg)', color: 'var(--warning)' }}>
                        <AlertTriangle size={9} /> outside {searchRadiusKm}km · not on map
                      </span>
                    )}
                  </div>
                </div>
                {/*
                  The percentage is the FIRST thing on the card a clerk reads and the last thing
                  the card explained: "66% Match" states a number without saying 66 % of what, or
                  whether 66 is a pass. "Why this match?" underneath opens the dimensions — but
                  only once you already believe the number means something. The tooltip now says
                  what is being scored and what the shading means, in the same breath, so the
                  figure is legible before anyone expands anything. 90 is the threshold the
                  colouring below already uses; it is now stated rather than merely coloured.
                */}
                <span title={`How well this assayer fits this branch, out of 100 — weighing distance, past acceptance, current workload, skills and cost. 90 and above is shown green as a strong fit; below that, read "Why this match?" underneath before offering. It is a ranking aid, not a rule — nothing here blocks an assignment.`} style={{ cursor: 'help', padding: '3px 8px', borderRadius: '8px', fontSize: 'var(--text-2xs)', fontWeight: 700, background: conf != null && conf >= 90 ? 'var(--status-active-bg)' : 'var(--status-pending-bg)', color: conf != null && conf >= 90 ? 'var(--status-active)' : 'var(--warning)', flexShrink: 0 }}>
                  {conf != null ? `${conf}% Match` : 'Match n/a'}
                </span>
              </div>

              {/* Only ever set when the date filter was relaxed. The candidate is on the list
                  because ops asked to see past the clash — so the clash is stated here, on the
                  row they will click, rather than left to be discovered after dispatch. */}
              {c.dateConflict && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: 'var(--text-3xs)', fontWeight: 600, padding: '4px 8px', borderRadius: 'var(--radius-sm)', background: 'var(--status-pending-bg)', color: 'var(--warning)' }}>
                  <AlertTriangle size={10} /> Not free on {scheduledAuditDate} — {c.dateConflict} Pick another date before offering.
                </div>
              )}

              {/*
                * Ranked, but beyond what this client normally pays to travel.
                *
                * The engine deliberately penalises distance rather than hiding it — the minimum is
                * the compliance rule, the maximum is a cost preference — while the write path
                * enforced the maximum anyway. So this card looked perfectly assignable and was
                * refused on the click, with nothing on screen having hinted at it. Assigning them
                * is allowed with a stated reason; saying so here is what turns a dead end into a
                * decision.
                */}
              {/*
                * On the list only because the panel rule was relaxed — so the row says so.
                *
                * Relaxing a rule must not quietly hide what was relaxed: the same contract as
                * `dateConflict` above. Without this the toggle would turn a compliance-strict
                * list into a longer one with no way to tell which names were on it legitimately.
                */}
              {c.clientStandingIssue && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: 'var(--text-3xs)', fontWeight: 600, padding: '4px 8px', borderRadius: 'var(--radius-sm)', background: 'var(--status-pending-bg)', color: 'var(--warning)' }}>
                  <AlertTriangle size={10} /> {c.clientStandingIssue} — assigning them needs a reason.
                </div>
              )}

              {c.exceedsClientRange != null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: 'var(--text-3xs)', fontWeight: 600, padding: '4px 8px', borderRadius: 'var(--radius-sm)', background: 'var(--status-pending-bg)', color: 'var(--warning)' }}>
                  <AlertTriangle size={10} /> Beyond this client&rsquo;s {c.exceedsClientRange} km limit — assigning them needs a reason.
                </div>
              )}

              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', gap: '8px', background: 'var(--bg-surface-2)', padding: '6px 8px', borderRadius: '4px' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}><Phone size={10} /> {c.phone}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}><MapPin size={10} /> {c.city}, {c.state}</span>
                {/* `usedFallbackBaseFee` — this assayer has no priced commercial profile, so the
                    figure is the platform-wide default rather than a rate anyone agreed to.
                    Said out loud rather than shown as an ordinary fee, the same way an estimated
                    distance is labelled rather than presented as a measured one. */}
                {/*
                  "Base: ₹1500" read as the fee. It is not: the figure recorded on assignment is
                  the audit fee PLUS travel, and travel scales with the distance in the same row.
                  Naming it "Audit fee" and saying "+ travel" costs nothing and stops the card
                  implying a total it does not have — the real total is quoted on the action,
                  where one request answers for one candidate instead of every candidate listed.
                */}
                <span title={c.usedFallbackBaseFee
                  ? `No priced rate on file for this assayer — this is the platform-wide default, not a contracted figure. ${NOTE_AUDIT_FEE}`
                  : NOTE_AUDIT_FEE}>
                  Audit fee: {c.baseFee != null ? `₹${c.baseFee}` : '—'}{c.usedFallbackBaseFee ? ' (platform default)' : ''}
                  {c.baseFee != null && <span style={{ opacity: 0.65 }}> + travel</span>}
                </span>
              </div>

              {/* What staff have said — the figure behind the `remarksScore` dimension. Click
                  opens the details modal, whose remarks section lists them and takes new ones. */}
              {c.remarkSummary && c.remarkSummary.count > 0 && (() => {
                const m = c.remarkSummary.weightedMean ?? 0;
                const tone = m > 0 ? { bg: 'var(--status-active-bg)', fg: 'var(--success)' } : m < 0 ? { bg: 'var(--status-cancelled-bg)', fg: 'var(--danger)' } : { bg: 'var(--bg-surface-2)', fg: 'var(--text-secondary)' };
                const latest = c.remarkSummary.latest;
                return (
                  <button type="button" onClick={() => loadAssayerDetail(c)}
                    /* The author's role was de-cased here, so a remark left by an operations
                       manager was attributed to "operations manager" while the user directory
                       and every other surface name the same person's role from the shared
                       ROLE_LABELS map — and DESK_OPERATOR de-cased to "desk operator". */
                    title={[
                      `What staff have written about this assayer, scored ${remarkVerdict(m).outOfFive} out of 5 — recent remarks count for more than old ones.`,
                      latest ? `Latest (${latest.category.toLowerCase()}, ${latest.authorRole ? roleLabel(latest.authorRole) : 'staff'}): "${latest.text.length > 140 ? `${latest.text.slice(0, 137)}…` : latest.text}"` : null,
                      'Click to read them all, or add one.',
                    ].filter(Boolean).join('\n')}
                    style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: 'var(--text-3xs)', fontWeight: 600, padding: '3px 8px', borderRadius: 'var(--radius-sm)', background: tone.bg, color: tone.fg, border: 'none', cursor: 'pointer' }}>
                    <MessageCircle size={10} /> {counted(c.remarkSummary.count, 'remark')} · {remarkVerdict(m).word} ({remarkVerdict(m).outOfFive} out of 5)
                  </button>
                );
              })()}

              <ScoreBreakdown
                breakdown={c.scoreBreakdown}
                // Points each dimension actually added to the score. Without it the card
                // explained the match by whichever dimension scored highest, including ones
                // weighted at zero.
                contribution={c.scoreContribution ?? null}
                route={{ distanceKm: c.distanceKm, durationMinutes: c.durationMinutes ?? null, distanceSource: c.distanceSource ?? null }}
              />

              {/* Row 1 Actions: View Map, Route TSP, Profile Details */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
                <button onClick={() => {
                  setSelectedCandidateForMap(selectedCandidateForMap?.id === c.id ? null : c);
                  revealMap();
                }}
                  className="btn btn-secondary" style={{ padding: '6px', fontSize: 'var(--text-2xs)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', background: selectedCandidateForMap?.id === c.id ? 'rgba(216,174,71,0.2)' : 'var(--bg-primary)', borderColor: selectedCandidateForMap?.id === c.id ? 'var(--accent-secondary)' : 'var(--border-color)', color: selectedCandidateForMap?.id === c.id ? 'var(--accent-secondary)' : 'var(--text-primary)' }}>
                  <Eye size={12} /> Map
                </button>
                <button onClick={async () => {
                  revealMap();
                  setSelectedCandidateForMap(c);
                  await handleOptimizeRoute(c);
                }} disabled={isOptimizing}
                  className="btn btn-secondary" style={{ padding: '6px', fontSize: 'var(--text-2xs)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                  <Compass size={11} /> {isOptimizing ? 'Routing...' : 'Route'}
                </button>
                <button onClick={() => loadAssayerDetail(c)}
                  className="btn btn-secondary" style={{ padding: '6px', fontSize: 'var(--text-2xs)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                  <Search size={11} /> Details
                </button>
              </div>

              {/* Row 2 Actions: Call & Assign vs Send to app */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                <button onClick={() => openAssignment(c, true)}
                  className="btn btn-primary" style={{ padding: '7px 10px', fontSize: 'var(--text-2xs)', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                  <Phone size={12} /> Call & Assign
                </button>

                {/* Logging a call that did NOT end in an assignment is the more valuable half:
                    an unanswered call leaves no other trace, so without this the next operator
                    (or the same one tomorrow) rediscovers it by dialling again. */}
                <Select
                  value=""
                  onChange={(v) => {
                    if (!v) return;
                    recordCall(c.id, v as any, undefined, 'Logged from candidate list');
                  }}
                  options={[
                    { value: 'NO_ANSWER', label: CALL_OUTCOME_LABELS.NO_ANSWER },
                    { value: 'CALLBACK_REQUESTED', label: CALL_OUTCOME_LABELS.CALLBACK_REQUESTED },
                    { value: 'DECLINED', label: CALL_OUTCOME_LABELS.DECLINED },
                    { value: 'WRONG_NUMBER', label: CALL_OUTCOME_LABELS.WRONG_NUMBER },
                  ]}
                  placeholder="Called but no assignment? Record what happened…"
                  aria-label="Record a call that did not result in an assignment"
                  compact
                  style={{ gridColumn: '1 / -1', color: 'var(--text-secondary)' }}
                />

                <button onClick={() => handleSendToApp(c)}
                  className="btn btn-secondary"
                  title="Assigns this assayer immediately and shows the job in their app. The fee is quoted and held on our side — the assayer sees it first on their monthly bill. Use “Call & Assign” when you have agreed a different number on the phone."
                  style={{ padding: '7px 10px', fontSize: 'var(--text-2xs)', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                  <Smartphone size={12} /> Send to app
                </button>
              </div>

              {optimizedSummary && routePoints && selectedCandidate?.id === c.id && (
                <div style={{ padding: '8px 10px', background: 'rgba(216,174,71,0.05)', border: '1px dashed rgba(216,174,71,0.3)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-2xs)', color: 'var(--accent-secondary)', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><MapIcon size={11} /> <b>Optimized Route Details:</b></div>
                  <div>• Distance: {optimizedSummary.totalDistanceKm} km</div>
                  <div>• Est. Travel Time: {optimizedSummary.totalDurationMinutes} minutes</div>
                  {/* Server-quoted, against this client's contracted rate. This line used to
                      compute `distance * 8` inline — charging from the first kilometre, unlike
                      every other fee path, which exempts the local-commute allowance. It could
                      therefore show a travel fee that no part of the system would ever charge. */}
                  <div>
                    • Est. Travel Fee: {feeQuote
                      ? feeQuote.travelSource === 'TRANSPORT_RATE_CARD' && feeQuote.transport?.recommended
                        ? (() => {
                            const rec = feeQuote.transport.recommended;
                            const mins = rec.oneWayMinutes;
                            const time = mins == null ? '' : mins >= 60
                              ? `, ~${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m each way`
                              : `, ~${Math.round(mins)} min each way`;
                            // A road-routed time is a measurement; a rail/bus/flight time is an
                            // average-speed estimate. Same words for both would be a small lie.
                            const est = rec.timeSource === 'RATE_CARD_ESTIMATE' && mins != null ? ' (est.)' : '';
                            const why = rec.reason ? ` — ${rec.reason}` : '';
                            return `₹${feeQuote.travelFee} by ${rec.modeLabel}${time}${est}, round trip${why}`;
                          })()
                        : `₹${feeQuote.travelFee} (₹${feeQuote.rates.travelFeePerKm}/km beyond ${feeQuote.rates.freeTravelAllowanceKm} km)`
                      : '—'}
                  </div>
                  {/* The solver's answer, written out. Previously the order existed only as the
                      shape of the line on the map, which the coordinator then had to reproduce
                      by hand in the queue. Numbering it here makes it readable, and the queue
                      above is already sorted to match. */}
                  {optimizedStops && optimizedStops.candidateId === c.id && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '2px' }}>
                      <div style={{ fontWeight: 700 }}>Visit in this order:</div>
                      {optimizedStops.stopNames.map((name, i) => (
                        <div key={`${name}-${i}`} style={{ color: 'var(--text-secondary)' }}>{i + 1}. {name}</div>
                      ))}
                      <div style={{ color: 'var(--text-secondary)' }}>↩ back to start</div>
                    </div>
                  )}
                  <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)' }}>Shortest round trip covering all these branches. The branch list on the left is now in this order.</div>
                </div>
              )}
            </div>
          );
        })}
        <ExcludedCandidatesPanel excluded={excludedCandidates} onAssignAnyway={handleAssignExcluded} assigningId={assigningExcludedId} />
        </div>
      </>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: `calc(100vh - ${64 + WORK_TAB_STRIP_HEIGHT}px)`, overflow: 'hidden', margin: '-20px', background: 'var(--bg-page)' }}>
      {/*
        The header's scope and this page's project picker name the same thing. When they disagree
        the request carries the header's value — it is the ceiling — and this says so, with both
        ways out. The alternative, and what used to happen, was to silently move the operator to a
        project they had not chosen the moment they narrowed their scope.
      */}
      {scopeMismatch && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '7px 16px', fontSize: 'var(--text-2xs)', fontWeight: 600, color: 'var(--status-warning-fg)', background: 'var(--status-warning-bg)', borderBottom: '1px solid var(--border-hair)' }}>
          <span>
            Showing the project set in your scope filter, not the one selected here — the two
            disagree, so the narrower scope wins.
          </span>
          <span style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
            <button
              onClick={() => setScope({ projectId: 'ALL' })}
              className="btn btn-secondary"
              style={{ padding: '2px 8px', fontSize: 'var(--text-3xs)' }}
            >
              Widen scope
            </button>
            <button
              onClick={() => setSelectedProjectId(scopeMismatch.scoped)}
              className="btn btn-secondary"
              style={{ padding: '2px 8px', fontSize: 'var(--text-3xs)' }}
            >
              Match the scope
            </button>
          </span>
        </div>
      )}
      {/* ── HIGH-DENSITY TOP COMMAND HEADER ── */}
      <div style={{
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border-hair)',
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        flexShrink: 0,
        zIndex: 30,
      }}>
        {/* Left: Workspace Title & Project Dropdown */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: 'var(--text-sm)', fontWeight: 800, color: 'var(--accent)', letterSpacing: '0.5px' }}>
              <MapPin size={13} /> MATCHING ASSAYERS TO BRANCHES
            </span>
          </div>
          <Select
            value={selectedProjectId}
            onChange={setSelectedProjectId}
            options={projects.map(p => ({ value: p.id, label: `${p.name} (${p.projectNumber})` }))}
            menuWidth={320}
            style={{
              border: '1px solid rgba(216,174,71,0.35)',
              borderRadius: '6px',
              fontSize: 'var(--text-xs)',
              fontWeight: 700,
              maxWidth: '220px',
              padding: '5px 10px',
            }}
          />
          {selectedProjectId && (
            <button
              onClick={() => setShowCoveragePlan(true)}
              className="btn btn-primary"
              style={{ marginLeft: '8px', fontSize: 'var(--text-2xs)', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}
              title="Generate, approve and deploy assignments for the whole project in one flow"
            >
              <Layers size={13} /> Coverage Plan
            </button>
          )}
        </div>

        {/*
          The "Stage 1 → Stage 2 → Stage 3" switcher that used to sit here has been removed.
          It existed only because planning, scheduling and field work were four separate sidebar
          destinations, so each screen had to grow its own way of reaching the others. They are now
          tabs of one "Audit Work" destination and the tab strip above IS this stepper — keeping
          both would mean two steppers on one screen, disagreeing about which one is authoritative.
          See packages/frontend/src/pages/work/workTabs.ts for the full reasoning.
        */}

        {/* Right: Key Metrics & Report Export */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-2xs)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Total: <b style={{ color: 'var(--text-primary)' }}>{totalCount}</b></span>
            <span style={{ padding: '2px 6px', borderRadius: '10px', background: 'var(--status-active-bg)', color: 'var(--success)', fontWeight: 700 }}>
              {coveragePct}% ({confirmedCount})
            </span>
            <span style={{ padding: '2px 6px', borderRadius: '10px', background: 'var(--status-pending-bg)', color: 'var(--warning)', fontWeight: 700 }}>
              Pending ({totalCount - confirmedCount})
            </span>
          </div>

          <button
            onClick={handleExportCoverageReport}
            style={{
              background: 'var(--status-active-bg)',
              border: '1px solid var(--status-active-bg)',
              borderRadius: '6px',
              color: 'var(--success)',
              cursor: 'pointer',
              padding: '4px 10px',
              fontSize: 'var(--text-2xs)',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <Download size={12} /> Excel Report
          </button>
        </div>
      </div>

      {/* ── SECONDARY INLINE FILTERS BAR ── */}
      <div style={{
        background: 'var(--bg-surface-2)',
        borderBottom: '1px solid var(--border-hair)',
        padding: '5px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexShrink: 0,
        zIndex: 25,
      }}>
        {/*
          The everyday task, as a button.
          Before this the screen's only starting instruction was a sentence of prose in the empty
          panel ("select a branch from the left queue…"), which is a hint, not an action. This
          picks the most urgent unstaffed branch, opens it, and scrolls its best match into view.
        */}
        <button
          type="button"
          onClick={handleNextUnassigned}
          disabled={!nextUnassignedBranch}
          className="btn btn-primary"
          style={{ padding: '4px 10px', fontSize: 'var(--text-2xs)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}
          title={nextUnassignedBranch
            ? `Open ${nextUnassignedBranch.branch?.name} — the most urgent branch with nobody on it yet`
            : 'Every branch in this list already has someone on it'}
        >
          <Zap size={12} /> {nextUnassignedBranch ? 'Next branch to staff' : 'All branches staffed'}
        </button>

        {/*
          Simple / Advanced. Simple is the default because the everyday job needs the queue, the
          matches and one assign action; everything else is still here, one click away, and the
          choice is remembered.
        */}
        <div role="tablist" aria-label="What are you planning" style={{ display: 'flex', gap: '2px', background: 'var(--bg-primary)', padding: '2px', borderRadius: '4px', border: '1px solid var(--border-hair)' }}>
          {PLANNING_JOBS.map(({ key, label, hint }) => (
            <button
              key={key}
              type="button"
              role="tab"
              onClick={() => {
                setJobPersisted(key);
                // The day view needs its plans; the old layout menu loaded them when picked.
                if (key === 'day' && selectedProjectId && !dayPlanData) void loadDayPlans();
              }}
              aria-selected={job === key}
              title={hint}
              style={{
                background: job === key ? 'var(--accent)' : 'transparent',
                color: job === key ? 'var(--on-accent)' : 'var(--text-muted)',
                border: 'none', borderRadius: '3px', cursor: 'pointer',
                padding: '3px 9px', fontSize: 'var(--text-3xs)', fontWeight: job === key ? 700 : 500,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* The filters. These were Advanced-only, so the default user — which was everyone who
            never found the mode switch — could not narrow the queue by state, status, priority
            or zone: the four questions a planner actually asks of it. */}
        {s(stateFilter, setStateFilter, [{ value: 'ALL', label: 'All States' }, ...statesList.map(s => ({ value: s, label: s }))])}
        {s(statusFilter, setStatusFilter, STATUS_OPTIONS)}
        {s(priorityFilter, setPriorityFilter, [{ value: 'ALL', label: 'All Priorities' }, { value: 'LOW', label: 'Low' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'HIGH', label: 'High' }, { value: 'CRITICAL', label: 'Critical' }])}
        {s(zoneFilter, setZoneFilter, [{ value: 'ALL', label: 'All Zones' }, ...zones.map(z => ({ value: z.id, label: z.name }))])}
        {(
          <input
            type="text"
            placeholder="Filter city..."
            value={cityFilter}
            onChange={e => setCityFilter(e.target.value)}
            style={{ width: '100px', padding: '4px 8px', background: 'var(--bg-input)', border: '1px solid var(--border-hair)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none', fontSize: 'var(--text-2xs)' }}
          />
        )}
        {(
          <input
            type="text"
            placeholder="Filter district..."
            value={districtFilter}
            onChange={e => setDistrictFilter(e.target.value)}
            style={{ width: '100px', padding: '4px 8px', background: 'var(--bg-input)', border: '1px solid var(--border-hair)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none', fontSize: 'var(--text-2xs)' }}
          />
        )}

        {(() => {
          const activeCount = [stateFilter !== 'ALL', statusFilter !== 'ALL', priorityFilter !== 'ALL', zoneFilter !== 'ALL', cityFilter !== '', districtFilter !== '', searchTerm !== ''].filter(Boolean).length;
          if (activeCount === 0) return null;
          return (
            <button
              type="button"
              onClick={() => { setStateFilter('ALL'); setStatusFilter('ALL'); setPriorityFilter('ALL'); setZoneFilter('ALL'); setCityFilter(''); setDistrictFilter(''); setSearchTerm(''); }}
              title="Clear all filters"
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px', fontSize: 'var(--text-2xs)', fontWeight: 600, color: 'var(--accent)', background: 'var(--status-pending-bg)', border: '1px solid var(--border-hair)', borderRadius: '4px', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              <X size={12} /> Clear {activeCount}
            </button>
          );
        })()}

        {/*
          The map, as a panel you open — not an arrangement you choose.

          Four of the six layout entries existed only to decide whether the map was on screen and
          where. That is why a default user never saw it: Simple pinned the one arrangement with
          no map in it, and the picker that could have shown them a map was drawn only in
          Advanced. Worse, the per-candidate "Map" button reached it by REWRITING the stored
          layout preference to `three-col` — a page-wide setting mutated as a local toggle, so
          glancing at one candidate's position silently changed how the page opened next time.
        */}
        {job === 'branch' && (
          <button
            type="button"
            onClick={() => setShowMapPersisted(!showMap)}
            aria-pressed={showMap}
            title={showMap ? MAP_PANEL.hideHint : MAP_PANEL.showHint}
            style={{
              marginLeft: 'auto',
              background: showMap ? 'var(--accent)' : 'transparent',
              border: '1px solid var(--border-hair)', borderRadius: '4px',
              color: showMap ? 'var(--on-accent)' : 'var(--text-secondary)',
              cursor: 'pointer', padding: '3px 9px', fontSize: 'var(--text-3xs)',
              fontWeight: 600, display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap',
            }}
          >
            <Layers size={11} /> {MAP_PANEL.label}
          </button>
        )}
      </div>

      {/* ── Message Banner ── */}
      {message && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 16px', fontSize: 'var(--text-2xs)', borderBottom: '1px solid', background: message.type === 'success' ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)', borderColor: message.type === 'success' ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)', color: message.type === 'success' ? 'var(--accent-secondary)' : 'var(--danger)', flexShrink: 0 }}>
          <span>{message.text}</span>
        </div>
      )}

      {/* ── Bulk action bar ──
          Rendered once here rather than per layout, so ticking branches behaves identically in
          all three. Planning was strictly single-branch (`selectedBranchId` is one string), and
          the only bulk path was the geographic Day Plan — which is the right tool for a routed
          multi-branch day, but not for "offer these fourteen scattered branches to one person". */}
      {bulkSelectedIds.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 16px', flexShrink: 0,
          background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--accent)', flexWrap: 'wrap',
        }}>
          {/* This count is what the buttons below will change — nothing more. */}
          <span style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--accent)' }}>
            {bulkTargetBranches.rows.length} branch{bulkTargetBranches.rows.length === 1 ? '' : 'es'} selected
          </span>
          {bulkHiddenNote && (
            <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)' }}>{bulkHiddenNote}</span>
          )}

          <label style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '5px' }}>
            Date
            <input
              type="date"
              value={bulkScheduledDate}
              onChange={(e) => setBulkScheduledDate(e.target.value)}
              style={{ padding: '4px 7px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 'var(--text-2xs)' }}
            />
          </label>

          {/* Shares the Call & Assign preference — one setting, so what the button does here
              never contradicts what it does in the modal. Shown rather than inherited silently:
              committing fourteen branches for someone must not be a hidden default. */}
          <label style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', userSelect: 'none' }}
            title={assignDirectly
              ? 'Confirmed on the assayer behalf — no acceptance needed. Untick to send these as offers.'
              : 'Sent as offers the assayer must accept in the app.'}>
            <input type="checkbox" checked={assignDirectly} onChange={(e) => setAssignDirectly(e.target.checked)}
              style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
            Assign directly
          </label>

          <button
            onClick={() => selectedCandidate && handleBulkAssign(selectedCandidate.id, selectedCandidate.displayName)}
            disabled={!selectedCandidate || bulkAssigning || bulkTargetBranches.rows.length === 0}
            className="btn btn-primary"
            style={{ padding: '5px 11px', fontSize: 'var(--text-2xs)', fontWeight: 700 }}
            title={selectedCandidate
              ? `${assignDirectly ? 'Confirm the selected branches for' : 'Offer the selected branches to'} ${selectedCandidate.displayName}`
              : 'Pick an assayer from the candidate list first'}>
            {bulkAssigning
              ? `${assignDirectly ? 'Assigning…' : 'Offering…'}${bulkProgress ? ` ${bulkProgress}` : ''}`
              : selectedCandidate
                ? `${assignDirectly ? 'Assign all to' : 'Offer all to'} ${selectedCandidate.displayName}`
                : 'Pick an assayer to offer to'}
          </button>

          <button
            onClick={() => {
              setUnableReason('');
              // Visible ticked branches only, and the label says the same number the modal will
              // act on. This is the call site that used to send the raw selection.
              setUnableModal({
                ids: bulkTargetBranches.ids,
                label: `${bulkTargetBranches.rows.length} branch${bulkTargetBranches.rows.length === 1 ? '' : 'es'}`,
              });
            }}
            disabled={bulkAssigning || bulkTargetBranches.rows.length === 0}
            className="btn btn-secondary"
            style={{ padding: '5px 11px', fontSize: 'var(--text-2xs)', fontWeight: 600, color: 'var(--danger)', borderColor: 'var(--danger)' }}>
            Mark unable to cover
          </button>

          <button onClick={() => { setBulkSelectedIds(new Set()); setBulkFailures([]); }}
            className="btn btn-secondary" style={{ padding: '5px 11px', fontSize: 'var(--text-2xs)' }}>
            Clear
          </button>

          {/* Suitability was scored against the focused branch only. Saying so matters: the
              server re-checks every constraint per branch, so some offers may still bounce. */}
          {selectedCandidate && (
            <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)' }}>
              Each branch is validated separately — distance, double-booking and holiday rules still apply.
            </span>
          )}

          {bulkFailures.length > 0 && (
            <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--danger)', width: '100%' }}>
              Still failing: {bulkFailures.map((f) => `${f.branchName} (${f.error})`).join('; ')}
            </span>
          )}
        </div>
      )}

      {/* ── Layout: 2-Column (Branch Queue + Assayer Recommendations Panel) ── */}
      {/*
        Staffing a branch: the queue on the left, the candidates for whichever branch you are on
        to the right, and the map between them when you ask for it.

        This replaces FIVE arrangements of these same three panels — `two-col-branch-recom`,
        `two-col-branch-map`, `default`, `three-col` and `map-only`. They differed only in which
        of the three were drawn and in what order, and the Simple default pinned the one with no
        map, so the choice was invisible to most people and irrelevant to the rest.
      */}
      {job === 'branch' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'row', minHeight: 0, gap: '10px', padding: '8px', overflow: 'hidden' }}>
          <BranchListPanel
            branches={filteredBranches}
            loading={isLoadingQueue}
            failure={queueFailure}
            selectedBranchId={selectedBranchId}
            onSelectBranch={setSelectedBranchId}
            searchTerm={searchTerm}
            onSearchTermChange={setSearchTerm}
            bulkSelectedIds={bulkSelectedIds}
            onToggleBulkSelect={toggleBulkSelect}
            onToggleBulkSelectAll={toggleBulkSelectAll}
            width={340}
          />

          {/* The map, when asked for. Same component and same props the old map layouts passed. */}
          {showMap && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
              <InteractivePlanningMap fillContainer
                branches={mapBranches}
                selectedBranchId={selectedBranchId}
                onSelectBranch={setSelectedBranchId}
                routePoints={routePoints}
                selectedAssayerFromParent={selectedCandidateForMap}
                slaEnabled={slaEnabled}
                slaRadius={slaRadius}
                rankedCandidates={displayCandidates}
                excludedCandidates={excludedCandidates}
                searchRadiusKm={searchRadiusKm}
                onSearchRadiusChange={setSearchRadiusKm}
                travelRates={travelRates}
              />
            </div>
          )}

          <RecommendationPanel
            onViewHistory={setHistoryBranchId}
            selectedPb={selectedPb}
            renderCandidatesList={renderCandidatesList}
            flex
            showAllCandidates={showAllCandidates}
            onToggleShowAll={setShowAllCandidates}
            slaEnabled={slaEnabled}
            onToggleSla={setSlaEnabled}
            slaRadius={slaRadius}
            onSlaRadiusChange={setSlaRadius}
            maxRadiusEnabled={maxRadiusEnabled}
            onToggleMaxRadius={setMaxRadiusEnabled}
            maxRadius={maxRadius}
            onMaxRadiusChange={setMaxRadius}
            planDate={scheduledAuditDate}
            onPlanDateChange={pinPlanDate}
            ignoreDateAvailability={ignoreDateAvailability}
            ignoreClientPolicy={ignoreClientPolicy}
            onToggleIgnoreClientPolicy={setIgnoreClientPolicy}
            ignoreDistancePolicy={ignoreDistancePolicy}
            onToggleIgnoreDistancePolicy={setIgnoreDistancePolicy}
            onToggleIgnoreDateAvailability={setIgnoreDateAvailability}
            onNextUnassigned={handleNextUnassigned}
            nextBranchName={nextUnassignedBranch?.branch?.name ?? null}
            onRefresh={refreshCandidates}
          />
        </div>
      )}
      {/* ── Confirm Assignment Modal (fee settled on the call, recorded here) ── */}
      {showAssignModal && selectedCandidate && selectedPb && (
        <Modal open onClose={() => setShowAssignModal(false)}
          /*
            One form for both buttons. The title names the job it does — record the fee — and
            the submit below names where the assignment then goes, which is the only thing the
            two entry points still disagree about.
          */
          title="Assign — record the agreed fee"
          width="580px" asForm
          onSubmit={handleConfirmAssignment}
          footer={
          <>
            <button type="button" onClick={() => setShowAssignModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {assignDirectly ? <><Check size={14} /> Assign now</> : <><Send size={14} /> Send to app</>}
            </button>
          </>
        }>            {/* Assayer Summary */}
            <div style={{ display: 'flex', gap: '14px', padding: '14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
              <div style={{ width: '44px', height: '44px', borderRadius: '50%', background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--on-accent)', fontSize: 'var(--text-lg)', fontWeight: 700, flexShrink: 0 }}>
                {selectedCandidate.displayName.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 'var(--text-md)', fontWeight: 700, color: 'var(--text-primary)' }}>{selectedCandidate.displayName}</div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: '1px' }}>{selectedCandidate.assayerCode}</div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '6px', fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}><MapPin size={10} /> {selectedCandidate.city}, {selectedCandidate.state}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}><Phone size={10} /> {selectedCandidate.phone}</span>
                  {selectedCandidate.email && <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}><Mail size={10} /> {selectedCandidate.email}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', flexShrink: 0 }}>
                <span style={{ padding: '2px 8px', borderRadius: '8px', fontSize: 'var(--text-2xs)', fontWeight: 600, background: (selectedCandidate.score ?? 0) >= 90 ? 'var(--status-active-bg)' : 'var(--status-pending-bg)', color: (selectedCandidate.score ?? 0) >= 90 ? 'var(--status-active)' : 'var(--warning)' }}>
                  {selectedCandidate.score != null ? `${Math.round(selectedCandidate.score)}% Match` : 'Match n/a'}
                </span>
                <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}><Compass size={10} /> {formatRouteDistance(selectedCandidate.distanceKm, selectedCandidate.distanceSource ?? null, { emptyAs: 'Distance n/a' })}</span>
              </div>
            </div>

            {/* Branch + Assignment details in 2-col grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div style={{ padding: '12px', background: 'rgba(216,174,71,0.05)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(216,174,71,0.15)' }}>
                <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Building2 size={11} /> BRANCH
                </div>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>{selectedPb.branch.name}</div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', marginTop: '2px' }}>{selectedPb.branch.city}, {selectedPb.branch.state}</div>
                <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', marginTop: '1px' }}>SOL ID: {selectedPb.branch.solId ?? '—'}</div>
              </div>
              <div style={{ padding: '12px', background: 'var(--status-active-bg)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--status-active-bg)' }}>
                <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <TrendingUp size={11} /> ASSIGNMENT
                </div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Status: </span>
                  {/* This panel shouted the raw branch enum ("ASSIGNMENT CONFIRMED") beside a
                      badge on the same screen that already said "Assigned", so one branch
                      appeared to be in two states at once. */}
                  <span style={{ color: 'var(--warning)', fontWeight: 600 }}>{branchStatusLabel(selectedPb.status)}</span>
                </div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Priority: </span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{selectedPb.priority || 'Normal'}</span>
                </div>
                {selectedCandidate.baseFee != null && (
                  <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Suggested Fee: </span>
                    <span style={{ color: 'var(--warning)', fontWeight: 600 }}>₹{selectedCandidate.baseFee.toLocaleString()}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Fee inputs — ONE fee. The base/travel split is kept internally on the
                assignment (see assignment-money.ts: the base holds at this assayer's own rate
                and travel takes the difference), because the desk agrees a single number on a
                call and should be asked for exactly that. */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {/*
                  The one number the desk agreed on the call. It is stored whole on the
                  assignment; billing carves it into base and travel from this assayer's own
                  audit fee, which is a fact about the person rather than anything to re-enter
                  here.
                */}
                <label style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <TrendingUp size={11} /> Agreed fee
                </label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>₹</span>
                  <input type="number" value={agreedFeeInput} onChange={e => setAgreedFeeInput(e.target.value)} required
                    style={{ width: '100%', padding: '10px 10px 10px 26px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: 'var(--text-base)', boxSizing: 'border-box' }} />
                </div>
                {/*
                  The rate card, as a reading — not as the answer.
                  Every fee here is settled by a person on a call and typed into the box above;
                  this line is what they compare against. It used to live in a confirm dialog on
                  a different button, which is how the two paths came to disagree at all.
                */}
                <div style={{ marginTop: '6px', fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {loadingCommercial ? 'Reading the rate card…' : feeReferenceLine(feeQuote)}
                </div>
              </div>
              {/*
                * The rule this assignment will break, and the box that lets it through.
                *
                * Shown only when there is actually something to waive. The operator used to
                * complete this whole form — fee, date, two checkboxes — press Confirm, and be
                * refused by a limit the modal had never mentioned; their only route through was to
                * abandon it, scroll to the excluded panel and start again. Asking here, in the
                * form they are already filling in, is the difference between a dead end and a
                * decision they are accountable for.
                */}
              {(selectedCandidate.exceedsClientRange != null || selectedCandidate.clientStandingIssue) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: 'var(--text-2xs)', color: 'var(--warning)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <AlertTriangle size={11} /> {selectedCandidate.clientStandingIssue
                      ? `${selectedCandidate.clientStandingIssue} — why assign them?`
                      : `Beyond this client's ${selectedCandidate.exceedsClientRange} km limit — why assign them?`}
                  </label>
                  <input
                    value={overrideReasonInput}
                    onChange={e => setOverrideReasonInput(e.target.value)}
                    required
                    placeholder="Recorded against this assignment"
                    style={{ width: '100%', padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--warning)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: 'var(--text-sm)', boxSizing: 'border-box' }}
                  />
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Calendar size={11} /> Audit Scheduled Date
                </label>
                <input type="date" value={scheduledAuditDate} onChange={e => pinPlanDate(e.target.value)} required
                  style={{ width: '100%', padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: 'var(--text-sm)', boxSizing: 'border-box' }} />
              </div>
            </div>

            {/* The transport grounding behind the recommended fee: what the journey actually
                costs by the recommended mode, with the alternatives, so the caller can argue
                in specifics ("bus both ways is ₹240") instead of feel. Server-quoted — this
                modal computes nothing. */}
            {feeQuote?.travelSource === 'TRANSPORT_RATE_CARD' && feeQuote.transport?.recommended && (
              <div style={{ marginTop: '12px', padding: '10px 12px', background: 'rgba(216,174,71,0.06)', border: '1px dashed rgba(216,174,71,0.35)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  <Bus size={12} /> Recommended fee includes ₹{feeQuote.travelFee.toLocaleString()} travel — {feeQuote.transport.recommended.modeLabel}, round trip
                  {feeQuote.transport.distanceKm ? ` (~${Math.round(feeQuote.transport.distanceKm)} km each way)` : ''}
                </div>
                {feeQuote.transport.options.length > 1 && (
                  <div style={{ color: 'var(--text-muted)' }}>
                    Alternatives: {feeQuote.transport.options
                      .filter((o) => o.mode !== feeQuote.transport!.recommended!.mode)
                      .map((o) => `${o.modeLabel} ₹${o.roundTripCost.toLocaleString()}`)
                      .join(' · ')}
                  </div>
                )}
              </div>
            )}

            {/* Assign-directly + auto-dispatch. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Ticked, the desk confirms on the assayer's behalf: the call already settled it,
                  so there is nothing left for them to accept. Unticked restores the offer flow. */}
              <div style={{ padding: '10px 12px', background: assignDirectly ? 'var(--status-active-bg)' : 'var(--bg-surface-2)', borderRadius: 'var(--radius-sm)', border: `1px solid ${assignDirectly ? 'var(--success)' : 'var(--border-color)'}`, display: 'flex', alignItems: 'center', gap: '10px' }}>
                <input type="checkbox" id="assignDirectlyToggle" checked={assignDirectly} onChange={e => setAssignDirectly(e.target.checked)} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                <label htmlFor="assignDirectlyToggle" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-primary)', cursor: 'pointer', userSelect: 'none' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 700, color: assignDirectly ? 'var(--success)' : 'var(--warning)' }}>
                    {assignDirectly ? <><CheckCircle size={12} /> Assign directly — agreed on this call: </> : <><Send size={12} /> Send as an offer: </>}
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {assignDirectly
                      ? 'Confirmed immediately, no acceptance needed. Recorded against you as accepted on their behalf.'
                      : 'Stays pending until the assayer accepts in the app. Auto-declines if the response SLA lapses.'}
                  </span>
                </label>
              </div>
              <div style={{ padding: '10px 12px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <input type="checkbox" id="autoDispatchToggle" checked={autoDispatch} onChange={e => setAutoDispatch(e.target.checked)} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                <label htmlFor="autoDispatchToggle" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-primary)', cursor: 'pointer', userSelect: 'none' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 700, color: autoDispatch ? 'var(--success)' : 'var(--warning)' }}>
                    {autoDispatch ? <><Zap size={12} /> Fast-Track Direct Lock: </> : <><ClipboardList size={12} /> Send to Unscheduled Queue: </>}
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {autoDispatch
                      ? `Auto-creates calendar dispatch packet on acceptance${assignDirectly ? ' — immediately, since this is confirmed now' : ''}`
                      : 'Acceptance moves offer to Unscheduled Queue for manual dispatching'}
                  </span>
                </label>
              </div>
            </div>
          </Modal>
        )}

      {/* ── Assayer Detail Modal ── */}
      <AssayerDetailModal
        open={showAssayerDetailModal}
        onClose={() => { setShowAssayerDetailModal(false); setDetailAssayer(null); setDetailCandidate(null); }}
        assayerId={detailCandidate?.id ?? detailAssayer?.id ?? null}
        profile={detailAssayer}
        loadingProfile={loadingDetail}
        profileError={detailError}
        onRetryProfile={() => { if (detailCandidate) void loadAssayerDetail(detailCandidate); }}
        candidate={detailCandidate}
        branchName={selectedPb?.branch?.name}
        clientId={selectedProjectClientId ?? undefined}
        onCallAndAssign={(cand) => { setShowAssayerDetailModal(false); void openAssignment(cand, true); }}
        onSendToApp={(cand) => { setShowAssayerDetailModal(false); void handleSendToApp(cand); }}
      />

      {/* ── Layout: Day Plans (Multi-Branch Cluster View) ── */}



      {job === 'day' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '0 32px 32px', overflowY: 'auto' }}>
          {/* Header & Refresh */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0 8px', flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Layers size={18} style={{ color: 'var(--accent-primary)' }} />
              <h2 style={{ fontSize: 'var(--text-md)', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Multi-Branch Day Plans</h2>
              <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>Clusters nearby branches → assigns single assayer per cluster for one-day coverage</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)' }}>
                <Calendar size={12} />
                <input type="date" value={dayPlanTargetDate} min={todayDateKey()}
                  onChange={(e) => setDayPlanTargetDate(e.target.value)}
                  style={{ padding: '4px 6px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: 'var(--text-2xs)', outline: 'none' }} />
              </label>
              {/* Coverage doesn't stop at an engagement boundary: two banks can have branches
                  on the same street, and an assayer sent to one may as well cover both. The
                  globally-selected project is always in scope; these only widen it. */}
              {projects.length > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)' }}>Plan with:</span>
                  {projects.filter((p) => p.id !== selectedProjectId).map((p) => {
                    const on = dayPlanProjectIds.includes(p.id);
                    return (
                      <button key={p.id} type="button"
                        onClick={() => {
                          const next = on ? dayPlanProjectIds.filter((x) => x !== p.id) : [...dayPlanProjectIds, p.id];
                          setDayPlanProjectIds(next);
                          void loadDayPlans(next);
                        }}
                        title={`${on ? 'Exclude' : 'Include'} ${p.name} when clustering branches for this day`}
                        style={{ padding: '3px 8px', fontSize: 'var(--text-3xs)', fontWeight: on ? 700 : 500, cursor: 'pointer',
                          background: on ? 'var(--accent-primary)' : 'var(--bg-primary)',
                          color: on ? '#fff' : 'var(--text-secondary)',
                          border: `1px solid ${on ? 'var(--accent-primary)' : 'var(--border-color)'}`, borderRadius: '999px' }}>
                        {p.projectNumber}
                      </button>
                    );
                  })}
                </div>
              )}
              {/* Same control that drives the single-branch candidate list and map — reused
                  here rather than a separate day-plans-only setting, so "Min Radius Filter"
                  means one thing everywhere on this page. */}
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: 'var(--text-2xs)', color: slaEnabled ? 'var(--warning)' : 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
                <input type="checkbox" checked={slaEnabled} onChange={(e) => setSlaEnabled(e.target.checked)} />
                Min Radius Filter
              </label>
              {slaEnabled && (
                <Select
                  value={String(slaRadius)}
                  onChange={(v) => setSlaRadius(Number(v))}
                  options={[25, 50, 100, 150, 200, 300, 500].map(v => ({ value: String(v), label: `${v}km` }))}
                  searchable={false}
                  menuWidth={90}
                  style={{ fontSize: 'var(--text-3xs)', padding: '2px 5px', background: 'var(--bg-primary)', borderRadius: '4px', color: 'var(--warning)' }}
                />
              )}
              <button onClick={() => void loadDayPlans()} disabled={isLoadingDayPlans}
                className="btn btn-primary" style={{ padding: '6px 14px', fontSize: 'var(--text-2xs)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <Route size={13} /> {isLoadingDayPlans ? 'Generating...' : 'Generate Day Plans'}
              </button>
            </div>
          </div>

          {dayPlanData?.effectiveMinDistanceKm != null && (
            <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', paddingBottom: '4px' }}>
              Enforcing a {dayPlanData.effectiveMinDistanceKm}km minimum distance
              {!slaEnabled || dayPlanData.effectiveMinDistanceKm > slaRadius
                ? " (this client's own configured floor — it always applies, regardless of the filter above)"
                : ''}.
            </div>
          )}

          {isLoadingDayPlans && (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
              <div className="loading-spinner" style={{ width: '30px', height: '30px', border: '3px solid var(--border-color)', borderTop: '3px solid var(--accent-primary)', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
              Analyzing branch clusters, calculating routes & scoring assayers...
              {dayPlanProgress && (
                <div data-testid="day-plan-progress" style={{ marginTop: '6px', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{dayPlanProgress}</div>
              )}
            </div>
          )}

          {!isLoadingDayPlans && !dayPlanData && (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: dayPlanError ? 'var(--danger)' : 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              <Layers size={40} style={{ color: 'var(--border-color)', margin: '0 auto 12px', display: 'block' }} />
              {dayPlanError ? (
                <>
                  Day plans could not be generated. {dayPlanError}
                  <div style={{ marginTop: '10px' }}>
                    <button onClick={() => void loadDayPlans()} className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 'var(--text-2xs)', width: 'auto' }}>
                      Try again
                    </button>
                  </div>
                </>
              ) : (
                'Click "Generate Day Plans" to cluster branches and find optimal assayer assignments.'
              )}
            </div>
          )}

          {dayPlanData && (
            <>
              {/* Summary KPI Bar */}
              <div style={{ display: 'flex', gap: '16px', padding: '10px 0 14px', flexWrap: 'wrap' }}>
                {[
                  // Throughput first: an assayer-day is bought whole, so packets-per-day and
                  // cost-per-packet are what decide whether the day is worth committing —
                  // more so than the branch count.
                  { label: 'Packets / Day', value: dayPlanData.summary.averagePacketsPerDay || '—', icon: <Layers size={13} />, color: 'var(--accent-primary)' },
                  { label: 'Cost / Packet', value: dayPlanData.summary.averageCostPerPacket != null ? `₹${dayPlanData.summary.averageCostPerPacket.toLocaleString()}` : '—', icon: <DollarSign size={13} />, color: 'var(--accent)' },
                  { label: 'Total Packets', value: dayPlanData.summary.totalPackets || '—', icon: <Briefcase size={13} />, color: 'var(--status-active)' },
                  { label: 'Assayer-Days', value: dayPlanData.summary.totalAssayersNeeded, icon: <Users size={13} />, color: 'var(--warning)' },
                  { label: 'Branches Covered', value: dayPlanData.summary.totalBranchesCovered, icon: <Building2 size={13} />, color: 'var(--status-active)' },
                  { label: 'Est. Total Cost', value: `₹${dayPlanData.summary.estimatedTotalCost.toLocaleString()}`, icon: <DollarSign size={13} />, color: 'var(--accent)' },
                  { label: 'Avg Utilization', value: `${dayPlanData.summary.averageUtilization.toFixed(0)}%`, icon: <TrendingUp size={13} />, color: dayPlanData.summary.averageUtilization >= 70 ? 'var(--status-active)' : 'var(--warning)' },
                ].map((kpi, idx) => (
                  <div key={idx} style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '10px 16px', minWidth: '130px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' as const }}>{kpi.icon} {kpi.label}</div>
                    <div style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: kpi.color }}>{kpi.value}</div>
                  </div>
                ))}
              </div>

              {/* Date moved because the requested day couldn't be worked. Previously the
                  planner would plan a holiday and only fail later, at assign time. */}
              {dayPlanData.dateAdjustment && (
                <div style={{ background: 'rgba(216,174,71,0.06)', border: '1px solid rgba(216,174,71,0.25)', borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Calendar size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--accent)' }}>
                    <b>{dayPlanData.dateAdjustment.requestedDate}</b> can't be worked — {dayPlanData.dateAdjustment.reason}
                    {' '}Planned for <b>{dayPlanData.targetDate}</b> instead.
                  </div>
                </div>
              )}

              {/* The core signal this whole mechanism exists to surface: a full paid day
                  being spent on a couple of hours of work. */}
              {dayPlanData.underutilizedBranches.length > 0 && (
                <div style={{ background: 'var(--status-cancelled-bg)', border: '1px solid var(--status-cancelled-bg)', borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: '12px' }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--danger)', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <AlertTriangle size={13} /> {dayPlanData.underutilizedBranches.length} branch(es) would use a full paid day for a few hours of work
                  </div>
                  <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', marginBottom: '8px' }}>
                    No neighbouring branch was close enough to bundle. Consider deferring these into a cycle where they can share a day.
                  </div>
                  {dayPlanData.underutilizedBranches.map((b, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', marginBottom: '3px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)', minWidth: '160px' }}>{b.branchName}</span>
                      <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{b.idleHours}h idle</span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        {b.packetCount != null ? `${b.packetCount} packets ≈ ${b.auditHours}h` : `~${b.auditHours}h (no packet count recorded)`}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Branches too big for one day. These previously surfaced as "cluster exceeds
                  daily capacity" in the unclustered list — accurate but unactionable, and on
                  this dataset that was 43 of 64 branches, i.e. most of the portfolio silently
                  unplannable. Stated as assayer-days, it becomes a coverage plan. */}
              {(dayPlanData.multiDayBranches?.length ?? 0) > 0 && (
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--accent-primary)', borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: '12px' }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--accent-primary)', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Layers size={13} /> {dayPlanData.multiDayBranches.length} branch(es) need more than one day on their own
                    <span style={{ marginLeft: 'auto', fontWeight: 800 }}>
                      {dayPlanData.multiDayBranches.reduce((sum, b) => sum + b.daysRequired, 0)} assayer-days
                    </span>
                  </div>
                  <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', marginBottom: '8px' }}>
                    Their own workload exceeds a working day, so they can't be bundled with anything. Split each across the days shown, or send more than one assayer.
                  </div>
                  {[...dayPlanData.multiDayBranches].sort((a, b) => b.daysRequired - a.daysRequired).map((b, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', marginBottom: '3px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)', minWidth: '160px' }}>{b.branchName}</span>
                      <span style={{ color: 'var(--accent-primary)', fontWeight: 700 }}>{b.daysRequired} day(s)</span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        {b.packetCount != null ? `${b.packetCount} packets ≈ ${b.auditHours}h` : `~${b.auditHours}h (no packet count recorded)`}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Unclustered branches warning */}
              {dayPlanData.unclusteredBranches.length > 0 && (
                <div style={{ background: 'var(--status-pending-bg)', border: '1px solid var(--status-pending-bg)', borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--warning)', marginBottom: '6px' }}><AlertTriangle size={12} /> {dayPlanData.unclusteredBranches.length} Branch(es) Could Not Be Clustered</div>
                  {dayPlanData.unclusteredBranches.map((b, i) => (
                    <div key={i} style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', marginBottom: '2px' }}>• {b.branchName}: {b.reason}</div>
                  ))}
                </div>
              )}

              {/* Clusters */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {dayPlanData.clusters.map(({ cluster, dayPlans, bestPlan, excludedAssayers }) => (
                  <div key={cluster.clusterId} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                    {/* Cluster Header */}
                    <div onClick={() => setExpandedCluster(expandedCluster === cluster.clusterId ? null : cluster.clusterId)}
                      style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        background: expandedCluster === cluster.clusterId ? 'rgba(216,174,71,0.06)' : 'transparent',
                        borderBottom: expandedCluster === cluster.clusterId ? '1px solid var(--border-color)' : 'none' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, color: 'var(--accent-primary)', background: 'rgba(216,174,71,0.1)', padding: '3px 8px', borderRadius: '4px' }}>{cluster.clusterId}</span>
                        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>{cluster.branches.length} Branches</span>
                        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                          {cluster.branches.map(b => b.branchName.replace(/^(Pune |Nashik |Mumbai |Bangalore )/, '')).join(' → ')}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        {cluster.totalPackets > 0 && (
                          <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--accent-primary)', fontWeight: 700 }}>{cluster.totalPackets} packets</span>
                        )}
                        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)' }}><Clock size={11} /> {cluster.totalEstimatedAuditHours}h audit</span>
                        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)' }}><MapPin size={11} /> {cluster.radiusKm.toFixed(0)}km radius</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: 'var(--text-2xs)', fontWeight: 600, color: cluster.feasibleForOneDay ? 'var(--status-active)' : 'var(--danger)' }}>
                          {cluster.feasibleForOneDay ? <><CheckCircle size={11} /> Fits 1 day</> : <><X size={11} /> Exceeds capacity</>}
                        </span>
                        {bestPlan && (
                          <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--warning)', fontWeight: 600 }}>
                            Best: {bestPlan.assayerName} (₹{bestPlan.estimatedTotalCost.toLocaleString()})
                          </span>
                        )}
                        <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', transition: 'transform 0.2s', transform: expandedCluster === cluster.clusterId ? 'rotate(180deg)' : 'none' }}>▾</span>
                      </div>
                    </div>

                    {/* Expanded Cluster: Day Plan Candidates */}
                    {expandedCluster === cluster.clusterId && (
                      <div style={{ padding: '14px 16px' }}>
                        {/* Branches in this cluster */}
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
                          {cluster.branches.map(b => (
                            <div key={b.branchId} style={{ background: 'rgba(216,174,71,0.06)', border: '1px solid rgba(216,174,71,0.15)', borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: 'var(--text-2xs)' }}>
                              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{b.branchName}</div>
                              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-3xs)' }}>
                                {b.solId ?? '—'} • {b.city} •{' '}
                                {b.packetCount != null
                                  ? <>{b.packetCount} packets → {b.estimatedDurationHours}h</>
                                  : (
                                    // Distinguished from a real packet-derived figure: this is a
                                    // stale per-branch default that may not reflect this cycle.
                                    <span title="No packet count recorded for this cycle — estimated from the branch default, which may be out of date.">
                                      ~{b.estimatedDurationHours}h <span style={{ color: 'var(--warning)' }}>(est.)</span>
                                    </span>
                                  )}
                              </div>
                            </div>
                          ))}
                        </div>

                        {dayPlans.length === 0 ? (
                          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                            <AlertTriangle size={18} style={{ color: 'var(--warning)', marginBottom: '6px' }} />
                            <div>No eligible assayers found for this cluster.</div>
                            {/* Previously the only signal here — this generic dead end hid
                                whether it was a genuine no-coverage gap or one misconfigured
                                business rule blocking every candidate. */}
                            {excludedAssayers.length > 0 && (
                              <div style={{ marginTop: '10px', textAlign: 'left' }}>
                                <ExcludedCandidatesPanel excluded={excludedAssayers} />
                              </div>
                            )}
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            {dayPlans.map((plan, pIdx) => (
                              <div key={plan.assayerId} style={{
                                background: pIdx === 0 ? 'var(--status-active-bg)' : 'var(--bg-surface-2)',
                                border: `1px solid ${pIdx === 0 ? 'var(--status-active-bg)' : 'var(--border-color)'}`,
                                borderRadius: 'var(--radius-md)', padding: '14px', position: 'relative' as const,
                              }}>
                                {pIdx === 0 && (
                                  <span style={{ position: 'absolute' as const, top: '-1px', right: '12px', background: 'var(--status-active)', color: 'var(--text-primary)', fontSize: 'var(--text-3xs)', fontWeight: 700, padding: '2px 8px', borderRadius: '0 0 4px 4px' }}>
                                    ⭐ RECOMMENDED
                                  </span>
                                )}

                                {/* Assayer Info Row */}
                                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '12px' }}>
                                  <div>
                                    <div style={{ fontSize: 'var(--text-md)', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                      {plan.assayerName}
                                      <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', fontWeight: 400 }}>({plan.assayerCode})</span>
                                    </div>
                                    <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', display: 'flex', gap: '10px', marginTop: '3px' }}>
                                      <span><Phone size={10} /> {plan.assayerPhone}</span>
                                      <span><MapPin size={10} /> {plan.assayerCity}</span>
                                    </div>
                                  </div>
                                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                    <span style={{
                                      padding: '4px 10px', borderRadius: '8px', fontSize: 'var(--text-xs)', fontWeight: 700,
                                      background: plan.overallScore >= 70 ? 'var(--status-active-bg)' : plan.overallScore >= 50 ? 'var(--status-pending-bg)' : 'var(--status-cancelled-bg)',
                                      color: plan.overallScore >= 70 ? 'var(--status-active)' : plan.overallScore >= 50 ? 'var(--warning)' : 'var(--danger)',
                                    }}>
                                      {plan.overallScore}% Score
                                    </span>
                                    {/* Previously this whole page was read-only: a correctly
                                        computed multi-branch route and cost ops could only look
                                        at, then had to manually re-create branch by branch
                                        through the single-branch flow. This commits all
                                        branches in the cluster to this assayer in one action. */}
                                    <button
                                      onClick={() => handleAssignDayPlan(cluster, plan)}
                                      disabled={dayPlanAssigning !== null}
                                      className="btn btn-primary"
                                      style={{ padding: '6px 12px', fontSize: 'var(--text-2xs)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}>
                                      {dayPlanAssigning === `${cluster.clusterId}:${plan.assayerId}`
                                        ? <>Assigning…</>
                                        : <><Check size={12} /> Assign All {plan.totalBranches}</>}
                                    </button>
                                  </div>
                                </div>

                                {/* A day plan is one physical route, so a half-assigned plan is a
                                    broken day, not a partial success. The failed legs stay on
                                    screen with their reasons and can be retried on their own —
                                    re-running the whole plan would just collide with the legs
                                    that already succeeded. */}
                                {(dayPlanFailures[`${cluster.clusterId}:${plan.assayerId}`]?.length ?? 0) > 0 && (
                                  <div style={{
                                    marginBottom: '12px', padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                                    background: 'var(--status-cancelled-bg)', border: '1px solid var(--danger)',
                                    display: 'flex', flexDirection: 'column', gap: '6px',
                                  }}>
                                    <div style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, color: 'var(--danger)' }}>
                                      {dayPlanFailures[`${cluster.clusterId}:${plan.assayerId}`].length} of {plan.totalBranches} branches could not be assigned
                                    </div>
                                    <ul style={{ margin: 0, paddingLeft: '16px', fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                      {dayPlanFailures[`${cluster.clusterId}:${plan.assayerId}`].map((f) => (
                                        <li key={f.branchId}><b>{f.branchName}</b> — {f.error}</li>
                                      ))}
                                    </ul>
                                    <button
                                      onClick={() => handleAssignDayPlan(
                                        cluster,
                                        plan,
                                        dayPlanFailures[`${cluster.clusterId}:${plan.assayerId}`].map((f) => f.branchId),
                                      )}
                                      disabled={dayPlanAssigning !== null}
                                      className="btn btn-secondary"
                                      style={{ padding: '5px 10px', fontSize: 'var(--text-3xs)', fontWeight: 700, alignSelf: 'flex-start' }}>
                                      {dayPlanAssigning === `${cluster.clusterId}:${plan.assayerId}` ? 'Retrying…' : 'Retry failed branches'}
                                    </button>
                                  </div>
                                )}

                                {/* Metrics Grid */}
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', marginBottom: '12px' }}>
                                  {[
                                    // Packets and idle time lead: they answer "is this day worth
                                    // buying", which branch/hour counts alone don't.
                                    ...(plan.totalPackets > 0 ? [{ label: 'Packets', val: String(plan.totalPackets), icon: <Package size={10} />, warn: false }] : []),
                                    ...(plan.costPerPacket != null ? [{ label: 'Cost / Packet', val: `₹${plan.costPerPacket.toLocaleString()}`, icon: <DollarSign size={10} />, warn: false }] : []),
                                    // Idle time is the cost of a badly-packed day, so it's called
                                    // out in amber once it passes roughly a quarter of the day.
                                    { label: 'Idle (paid)', val: `${plan.idleHours}h`, icon: plan.idleHours >= 3 ? <AlertTriangle size={10} /> : <CheckCircle size={10} />, warn: plan.idleHours >= 3 },
                                    { label: 'Branches', val: String(plan.totalBranches), icon: <Building2 size={10} />, warn: false },
                                    { label: 'Audit Time', val: `${plan.totalAuditHours}h`, icon: <Clock size={10} />, warn: false },
                                    { label: 'Travel', val: `${plan.totalTravelKm.toFixed(0)}km / ${plan.totalTravelMinutes.toFixed(0)}min`, icon: <Car size={10} />, warn: false },
                                    { label: 'Total Day', val: `${plan.totalDayHours.toFixed(1)}h`, icon: <Calendar size={10} />, warn: false },
                                    { label: 'Day Window', val: `${plan.dayStartTime} → ${plan.dayEndTime}`, icon: <Clock size={10} />, warn: false },
                                    { label: 'Utilization', val: `${plan.utilizationPercent}%`, icon: plan.utilizationPercent >= 70 ? <Flame size={10} /> : <BarChart3 size={10} />, warn: false },
                                  ].map((m, mi) => (
                                    <div key={mi} style={{ background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', padding: '6px 10px' }}>
                                      <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' as const, display: 'flex', alignItems: 'center', gap: '3px' }}>{m.icon} {m.label}</div>
                                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: m.warn ? 'var(--warning)' : 'var(--text-primary)', marginTop: '2px' }}>{m.val}</div>
                                    </div>
                                  ))}
                                </div>

                                {/* Cost Breakdown */}
                                <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', padding: '8px 12px', background: 'rgba(216,174,71,0.04)', border: '1px dashed rgba(216,174,71,0.2)', borderRadius: 'var(--radius-sm)' }}>
                                  <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)' }}>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontWeight: 600 }}><DollarSign size={11} /> Cost:</span>{' '}
                                    Base ₹{plan.estimatedBaseFee.toLocaleString()} + Travel ₹{plan.estimatedTravelFee.toLocaleString()} ={' '}
                                    <span style={{ fontWeight: 700, color: 'var(--warning)' }}>₹{plan.estimatedTotalCost.toLocaleString()}</span>
                                  </div>
                                </div>

                                {/* Client Preferences Match */}
                                <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
                                  {[
                                    { label: 'Skills', ok: plan.clientPreferencesMatch.skillsMatch },
                                    { label: 'Certifications', ok: plan.clientPreferencesMatch.certificationsMatch },
                                    { label: 'Distance', ok: plan.clientPreferencesMatch.distanceWithinRange },
                                    { label: 'Preferred', ok: plan.clientPreferencesMatch.isPreferredAssayer },
                                  ].map((pm, pi) => (
                                    <span key={pi} style={{
                                      fontSize: 'var(--text-3xs)', padding: '2px 6px', borderRadius: '4px',
                                      background: pm.ok ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)',
                                      color: pm.ok ? 'var(--status-active)' : 'var(--danger)',
                                      fontWeight: 600, display: 'flex', alignItems: 'center', gap: '3px',
                                    }}>
                                      {pm.ok ? <Check size={9} /> : <X size={9} />} {pm.label}
                                    </span>
                                  ))}
                                </div>

                                {/* Route Stops Timeline */}
                                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '10px' }}>
                                  <div style={{ fontSize: 'var(--text-2xs)', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                                    <Route size={12} /> Route Schedule (shortest path)
                                  </div>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                                    {plan.stops.map((stop, si) => (
                                      <div key={si} style={{ display: 'flex', alignItems: 'stretch', gap: '10px' }}>
                                        {/* Timeline connector */}
                                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '20px' }}>
                                          <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: si === 0 ? 'var(--accent-primary)' : 'var(--status-active)', flexShrink: 0, marginTop: '5px' }} />
                                          {si < plan.stops.length - 1 && <div style={{ width: '2px', flex: 1, background: 'var(--border-color)' }} />}
                                        </div>
                                        {/* Stop content */}
                                        <div style={{ flex: 1, paddingBottom: '10px' }}>
                                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)' }}>
                                              #{stop.order} {stop.branchName}
                                            </span>
                                            <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)' }}>({stop.solId ?? '—'})</span>
                                          </div>
                                          <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-secondary)', display: 'flex', gap: '12px', marginTop: '2px' }}>
                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}><Clock size={10} /> Arrive {stop.estimatedArrival} → Depart {stop.estimatedDeparture}</span>
                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}><Clock size={10} /> Audit: {stop.estimatedAuditHours}h</span>
                                            {stop.travelFromPreviousKm > 0 && (
                                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}><Car size={10} /> Travel: {stop.travelFromPreviousKm}km ({stop.travelFromPreviousMinutes}min)</span>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                    {/* Return leg */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '20px' }}>
                                        <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--warning)', flexShrink: 0 }} />
                                      </div>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: 'var(--text-2xs)', color: 'var(--warning)', fontWeight: 600 }}><Home size={11} /> Return Home by {plan.dayEndTime}</div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Also shown alongside a non-empty result — ops sees not just who's
                            recommended but who was considered and ruled out, and why. */}
                        {dayPlans.length > 0 && excludedAssayers.length > 0 && (
                          <ExcludedCandidatesPanel excluded={excludedAssayers} />
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {historyBranchId && (
        <BranchHistoryDrawer projectBranchId={historyBranchId} onClose={() => setHistoryBranchId(null)} />
      )}

      {showCoveragePlan && selectedProjectId && (
        <CoveragePlanModal
          projectId={selectedProjectId}
          projectName={projects.find(p => p.id === selectedProjectId)?.name || 'Project'}
          onClose={() => setShowCoveragePlan(false)}
          onDeployed={() => { refreshBranches(); }}
        />
      )}

      {unableModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '16px' }}
          onClick={() => !unableSubmitting && setUnableModal(null)}>
          <div onClick={(e) => e.stopPropagation()}
            role="dialog" aria-modal="true" aria-labelledby="unable-modal-title"
            style={{ width: 'min(460px, 100%)', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div id="unable-modal-title" style={{ fontSize: 'var(--text-md)', fontWeight: 800, color: 'var(--text-primary)' }}>Mark unable to cover</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
              Recorded against <b>{unableModal.label}</b> and reported to the client. Be specific
              (e.g. "No certified assayer within 150km for the SLA window").
            </div>
            {/*
              A fast-fill preset, not a constraint: choosing one writes its text into the same
              textarea below, and "Other…" clears it for free typing. Whatever ends up in the
              textarea — preset, edited preset, or fully free text — is exactly what gets posted;
              the select can never gate it.
            */}
            <Select
              aria-label="Reason preset"
              value={(UNABLE_TO_COVER_REASON_PRESETS as readonly string[]).includes(unableReason) ? unableReason : UNABLE_REASON_OTHER}
              onChange={(v) => setUnableReason(v === UNABLE_REASON_OTHER ? '' : v)}
              options={[
                ...UNABLE_TO_COVER_REASON_PRESETS.map((r) => ({ value: r, label: r })),
                { value: UNABLE_REASON_OTHER, label: 'Other…' },
              ]}
            />
            <textarea
              autoFocus
              value={unableReason}
              onChange={(e) => setUnableReason(e.target.value)}
              placeholder="Reason this cannot be staffed…"
              rows={4}
              style={{ resize: 'vertical', fontSize: 'var(--text-sm)', padding: '9px 11px', background: 'var(--bg-input)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', outline: 'none' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button onClick={() => setUnableModal(null)} disabled={unableSubmitting} className="btn btn-secondary" style={{ fontSize: 'var(--text-xs)', padding: '6px 14px' }}>Cancel</button>
              <button onClick={submitUnableToCover} disabled={!unableReason.trim() || unableSubmitting}
                className="btn btn-primary" style={{ fontSize: 'var(--text-xs)', padding: '6px 14px', color: 'var(--danger)', opacity: !unableReason.trim() || unableSubmitting ? 0.6 : 1 }}>
                {unableSubmitting ? `Recording…${bulkProgress ? ` ${bulkProgress}` : ''}` : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Shared confirm dialog host — rendered once for the whole workspace. */}
      {confirmDialog}
    </div>
  );
};
