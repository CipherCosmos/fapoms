import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Compass, Check, X, AlertTriangle, CheckCircle, Search, Star, Briefcase, MapPin, Phone, Mail, Award, Clock, DollarSign, Calendar, TrendingUp, Building2, Route, Users, Layers } from 'lucide-react';
import { ProjectBranchStatus, formatDateOnly } from '@fapoms/shared';
import { branchStatusLabel, BRANCH_COVERED_STATUSES, localDateKey, todayDateKey } from '../utils/statusLabels';
import { api } from '../services/api';
import { userMessage } from '../services/errors';
import { queryKeys } from '../hooks/queryKeys';
import { useScope, withScope } from '../context/ScopeContext';
import { InteractivePlanningMap } from '../components/InteractivePlanningMap';
import { BranchHistoryDrawer } from './planning/BranchHistoryDrawer';
import { useToast, Modal } from '../components/ui';
import { ScoreBreakdown } from './planning/ScoreBreakdown';
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
} from '../services/planning';

import { money } from '../utils/money';
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
    options: Array<{
      mode: string; modeLabel: string; baseFare: number; perKmRate: number;
      oneWayCost: number; roundTripCost: number; preferred: boolean;
    }>;
    recommended: {
      mode: string; modeLabel: string; baseFare: number; perKmRate: number;
      oneWayCost: number; roundTripCost: number; preferred: boolean;
    } | null;
  } | null;
}

interface ProjectOption {
  id: string;
  name: string;
  projectNumber: string;
  /** Whose zones and branches this project draws on — see `loadZones`. */
  clientId?: string;
}



interface Candidate {
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
  latitude: number | null;
  longitude: number | null;
  score?: number;
  baseFee?: number;
  pendingOnThisBranch?: boolean;
  /** Backend already computes these; the UI previously discarded them. */
  readableReasons?: { label: string; detail?: string; sentiment?: string }[];
  scoreBreakdown?: Record<string, number>;
  /**
   * Set only when "Ignore date availability" is on and this candidate has a clash on the
   * planned date ("Already booked that day on ASG-0042.", "On leave 2026-08-10 to 2026-08-14.").
   * Null means genuinely free. Relaxing the filter reveals the person; it must not conceal the
   * clash, or the operator dispatches into a double-booking believing the list was clean.
   */
  dateConflict?: string | null;
}

/** A candidate the engine filtered out, and why. */
interface ExcludedCandidate {
  assayerId: string;
  displayName: string;
  reason: string;
  detail?: string;
  kind?: 'DATE' | 'ROTATION' | 'DISTANCE' | 'POLICY' | 'SKILLS' | 'ONBOARDING';
  distanceKm?: number | null;
  nextAvailableDate?: string | null;
}

interface AssayerDetail {
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
  totalEarnings: number;
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

interface Remark {
  id: string;
  content: string;
  category: string;
  visibility: string;
  authorName: string;
  rating: number | null;
  createdAt: string;
}

interface DayPlanStop {
  order: number;
  branchId: string;
  branchName: string;
  branchCode: string;
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
    id: string; branchId: string; branchName: string; branchCode: string;
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

const CATEGORY_COLORS: Record<string, string> = {
  PERFORMANCE: '#d8ae47',
  QUALITY: '#d8ae47',
  BEHAVIORAL: '#b8791f',
  TRAINING: '#3f7d53',
  GENERAL: '#7c6e59',
};

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










export const PlanningWorkspace: React.FC = () => {
  // The header's global scope narrows the coverage queue. This page keeps its own project
  // selector — planning is inherently one project at a time — so only the geographic
  // dimensions are taken from the header here.
  const { scopeParams, scopeKey } = useScope();
  const scopeQuery = withScope(scopeParams);
  const queryClient = useQueryClient();

  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [selectedProjectId, setSelectedProjectId] = useState<string>(searchParams.get('projectId') || '');
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [historyBranchId, setHistoryBranchId] = useState<string | null>(null);
  const [routePoints, setRoutePoints] = useState<{ latitude: number; longitude: number }[] | undefined>(undefined);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizedSummary, setOptimizedSummary] = useState<{ totalDistanceKm: number; totalDurationMinutes: number } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [stateFilter, setStateFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [cityFilter, setCityFilter] = useState('');
  const [districtFilter, setDistrictFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('ALL');
  const [zoneFilter, setZoneFilter] = useState('ALL');

  const [showNegotiationModal, setShowNegotiationModal] = useState(false);
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
  const [dayPlanFailures, setDayPlanFailures] = useState<Record<string, Array<{ branchId: string; branchName: string; error: string }>>>({});
  const [negotiatingFee, setNegotiatingFee] = useState('');
  // When set, the negotiation modal is in "counter back" mode: submitting posts a counter-offer on
  // THIS existing assignment (proposeCounterFee) instead of creating a brand-new one. null = the
  // normal Call & Assign flow.
  const [counterOfferAssignmentId, setCounterOfferAssignmentId] = useState<string | null>(null);
  const [counterRemarks, setCounterRemarks] = useState('');
  const [commercialBaseFee, setCommercialBaseFee] = useState<number | null>(null);
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
  const [detailRemarks, setDetailRemarks] = useState<Remark[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
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
  // Max-radius ("show assayers WITHIN X km") — the intuitive service-radius filter, independent of
  // the min-radius independence floor. Replaces the old fixed 700km cap + "Show Distant" toggle.
  const [maxRadiusEnabled, setMaxRadiusEnabled] = useState(false);
  const [maxRadius, setMaxRadius] = useState(200);
  // The excluded candidate whose "assign anyway" override is currently being persisted.
  const [assigningExcludedId, setAssigningExcludedId] = useState<string | null>(null);
  // Whole-project coverage-plan (generate → approve → deploy) modal.
  const [showCoveragePlan, setShowCoveragePlan] = useState(false);
  // Structured "unable to cover" reason capture (replaces window.prompt). Holds the target branch
  // ids and a label; one flow serves both the single-branch and bulk cases.
  const [unableModal, setUnableModal] = useState<{ ids: string[]; label: string } | null>(null);
  const [unableReason, setUnableReason] = useState('');
  const [unableSubmitting, setUnableSubmitting] = useState(false);

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
  useEffect(() => {
    if (projects.length === 0) return;
    if (!selectedProjectId || !projects.some(p => p.id === selectedProjectId)) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

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
   * Keep whatever branch is already selected if the refresh still contains it.
   *
   * The queue reloads after nearly every action on this page — assign, negotiate, bulk-assign, a
   * coverage-plan deploy, or a realtime event for a branch that is not even the one open — and it
   * used to snap back to `data[0]` every single time. Negotiating a fee on branch #12 would
   * refresh the queue and silently swap the open panel to branch #1, so finishing one negotiation
   * meant re-finding whichever branch you had actually been working on. Only fall back to the
   * first branch (or none) when the previous selection is genuinely gone — completed, reassigned
   * elsewhere, or this is the first load.
   *
   * This runs on `branches` identity, which React Query only changes when the data actually
   * changed (structural sharing); an unchanged refetch is a no-op here.
   */
  useEffect(() => {
    setSelectedBranchId((current) =>
      current && branches.some(b => b.id === current) ? current : (branches.length > 0 ? branches[0].id : null),
    );
  }, [branches]);

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
    ),
    queryFn: ({ signal }) => getRecommendations<Candidate, ExcludedCandidate>(
      selectedBranchKey!, scheduledAuditDate, ignoreDateAvailability, engineRadiusKm, signal,
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
   * had broken. `userMessage` gives the same plain-language sentence the rest of the app uses.
   */
  const candidatesError = candidatesQuery.isError ? userMessage(candidatesQuery.error) : null;

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
    // Both can apply at once: min <= distanceKm <= max. Unknown distance is always shown.
    // `showAllCandidates` lifts the max bound entirely for a full sweep.
    return candidates.filter(c => {
      if (c.distanceKm == null) return true;
      if (slaEnabled && c.distanceKm < slaRadius) return false;
      if (!showAllCandidates && maxRadiusEnabled && c.distanceKm > maxRadius) return false;
      return true;
    });
  }, [candidates, slaEnabled, slaRadius, maxRadiusEnabled, maxRadius, showAllCandidates]);
  const drawerRef = useRef<HTMLDivElement>(null);
  const [dayPlanData, setDayPlanData] = useState<ProjectDayPlan | null>(null);
  /**
   * Projects to plan together. Empty means "just the one currently selected", which keeps the
   * screen behaving as before until an operator deliberately widens the scope.
   */
  const [dayPlanProjectIds, setDayPlanProjectIds] = useState<string[]>([]);
  const [isLoadingDayPlans, setIsLoadingDayPlans] = useState(false);
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
    try {
      const data = await optimizeRoute({ origin: { latitude: originLat, longitude: originLng }, destinations, roundTrip: true, mode: 'driving' });
      const { optimizedSequence, totalDistanceKm, totalDurationMinutes } = data;
      const points = [{ latitude: originLat, longitude: originLng }];
      for (const destId of optimizedSequence) {
        const matchedBranch = assignedBranches.find(b => b.branch.id === destId);
        if (matchedBranch?.branch.latitude && matchedBranch.branch.longitude) points.push({ latitude: matchedBranch.branch.latitude, longitude: matchedBranch.branch.longitude });
      }
      points.push({ latitude: originLat, longitude: originLng });
      setRoutePoints(points);
      setOptimizedSummary({ totalDistanceKm, totalDurationMinutes });
    } catch { toast({ type: 'error', title: 'Route could not be calculated', message: 'Could not reach the routing service. Check your connection and try again.' }); }
    finally { setIsOptimizing(false); }
  };

  /**
   * `projectIdsOverride` lets the project chips reload immediately on click rather than
   * waiting for the next render to observe the new state.
   */
  const loadDayPlans = async (projectIdsOverride?: string[]) => {
    if (!selectedProjectId) return;
    setIsLoadingDayPlans(true);
    setDayPlanData(null);
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
      });
      setDayPlanData(data);
      if (data.clusters?.length > 0) setExpandedCluster(data.clusters[0].cluster.clusterId);
    } catch (err) { console.error('Failed to load day plans', err); }
    finally { setIsLoadingDayPlans(false); }
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
    loadDayPlans();
  };

  const toggleBulkSelect = (id: string) => {
    setBulkSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleBulkSelectAll = () => {
    const selectable = filteredBranches.filter((b) => !b.assignment && b.status !== 'UNABLE_TO_COVER');
    setBulkSelectedIds((prev) =>
      selectable.length > 0 && selectable.every((b) => prev.has(b.id))
        ? new Set()
        : new Set(selectable.map((b) => b.id)),
    );
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
    const targets = filteredBranches.filter((b) => bulkSelectedIds.has(b.id));
    if (targets.length === 0) return;

    setBulkAssigning(true);
    setBulkFailures([]);
    const failures: Array<{ branchId: string; branchName: string; error: string }> = [];
    let succeeded = 0;
    // Counted separately from `succeeded`: with "assign directly" on, a branch can be created
    // successfully and still come back as a PENDING offer if the confirmation could not be
    // applied. Reporting all of them as confirmed would hide exactly that.
    let confirmed = 0;

    // Bounded-concurrency instead of one serial POST per branch: a 40-branch bulk offer was 40
    // sequential round-trips. Five at a time keeps it fast without flooding the API, and each
    // branch is an independent record so there is no cross-item ordering dependency.
    const CONCURRENCY = 5;
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const chunk = targets.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (pb) => {
          try {
            const created = await api.request<{ status?: string }>('/assignments', {
              method: 'POST',
              body: JSON.stringify({
                projectBranchId: pb.id,
                assayerId,
                scheduledDate: bulkScheduledDate || undefined,
                remarks: `Bulk-assigned to ${assayerName} from the planning queue`,
                acceptOnBehalf: assignDirectly,
                acceptanceReason: assignDirectly
                  ? `Agreed by phone — bulk-assigned to ${assayerName} from the planning queue.`
                  : undefined,
              }),
            });
            return { ok: true as const, branchId: pb.id, branchName: pb.branch?.name || pb.id, confirmed: created?.status === 'ACCEPTED' };
          } catch (err: any) {
            return { ok: false as const, branchId: pb.id, branchName: pb.branch?.name || pb.id, error: err?.message || 'Failed' };
          }
        }),
      );
      for (const r of chunkResults) {
        if (r.ok) {
          succeeded += 1;
          if (r.confirmed) confirmed += 1;
        } else {
          failures.push({ branchId: r.branchId, branchName: r.branchName, error: r.error || 'Failed' });
        }
      }
    }

    setBulkAssigning(false);
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

  /** Persist the "unable to cover" reason for one or many branches (from the modal). */
  const submitUnableToCover = async () => {
    if (!unableModal) return;
    const reason = unableReason.trim();
    if (!reason) return;
    setUnableSubmitting(true);
    const nameById = new Map(branches.map((b) => [b.id, b.branch?.name || b.id]));
    const outcomes = await Promise.all(
      unableModal.ids.map(async (id) => {
        try {
          await api.request(`/projects/branches/${id}/unable-to-cover`, {
            method: 'POST',
            body: JSON.stringify({ reason }),
          });
          return { ok: true as const };
        } catch {
          return { ok: false as const, name: nameById.get(id) || id };
        }
      }),
    );
    const failed = outcomes.filter((o) => !o.ok).map((o) => (o as { name: string }).name);
    const ok = outcomes.length - failed.length;
    setUnableSubmitting(false);
    if (unableModal.ids.length > 1) setBulkSelectedIds(new Set());
    setUnableModal(null);
    setUnableReason('');
    setMessage(
      failed.length === 0
        ? { type: 'success', text: `${ok} branch(es) recorded as unable to cover.` }
        : { type: 'error', text: `${ok}/${outcomes.length} recorded. Failed: ${failed.join(', ')}` },
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

  const loadAssayerDetail = async (assayerId: string) => {
    setLoadingDetail(true);
    setShowAssayerDetailModal(true);
    try {
      const [profile, remarks] = await Promise.all([
        api.request<AssayerDetail>(`/assayers/${assayerId}/profile`, { method: 'GET' }),
        api.request<Remark[]>(`/assayers/${assayerId}/remark`, { method: 'GET' }),
      ]);
      setDetailAssayer(profile);
      setDetailRemarks(Array.isArray(remarks) ? remarks : []);
    } catch { console.error('Failed to load assayer details'); }
    finally { setLoadingDetail(false); }
  };

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
          proposedFee: Number(negotiatingFee),
          scheduledDate: scheduledAuditDate,
          autoSchedule: autoDispatch,
          acceptOnBehalf: assignDirectly,
          acceptanceReason: assignDirectly
            ? `Agreed at ${money(negotiatingFee)} during Call & Assign.`
            : undefined,
        })
      });
      // The call that produced this agreement is the record of who committed to what fee, and
      // when. `call_logs` has existed since the first migration with nowhere writing to it, so
      // a negotiated fee had no supporting record if the assayer later disputed it. Logged
      // after the assignment so a logging failure can never cost the assignment itself.
      recordCall(selectedCandidate.id, 'AGREED', Number(negotiatingFee), 'Agreed during Call & Assign');

      // Reports what the server actually did, not what was asked for. Direct assignment can fall
      // back to a PENDING offer if the confirmation could not be applied, and telling ops the job
      // is locked when it is still waiting on someone is the failure this whole change is about.
      // Only now is it safe to dismiss: the assignment exists.
      setShowNegotiationModal(false);
      const confirmed = created?.status === 'ACCEPTED';
      setMessage({
        type: 'success',
        text: confirmed
          ? `${selectedCandidate.displayName} is confirmed for this branch — no acceptance needed. They have been notified on the mobile app.`
          : `Offered this branch to ${selectedCandidate.displayName}. It stays pending until they accept on the mobile app${assignDirectly ? ', or you accept it from the Operations Inbox' : ''}.`,
      });
      refreshBranches();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Scheduling failed due to validation rules.' });
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
    outcome: 'AGREED' | 'NEGOTIATING' | 'DECLINED' | 'NO_ANSWER' | 'CALLBACK_REQUESTED' | 'WRONG_NUMBER',
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
        negotiatedFee: (outcome === 'AGREED' || outcome === 'NEGOTIATING') ? negotiatedFee : undefined,
        notes,
      }),
    })
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.planning.lastContact(selectedBranchId) }))
      .catch(() => { /* supporting record only */ });
  };

  const handleExportCoverageReport = async () => {
    if (!selectedProjectId || branches.length === 0) return;

    const data = branches.map((b) => ({
      'Branch Code': b.branch?.branchCode || '',
      'SOL ID': b.branch?.solId || '',
      'Branch Name': b.branch?.name || '',
      'City': b.branch?.city || '',
      'District': b.branch?.district || '',
      'State': b.branch?.state || '',
      'Priority': b.priority || '',
      'Zone ID': b.zoneId || '',
      'Status': b.status,
      'Audit Coverage Possible': BRANCH_COVERED_STATUSES.includes(b.status as ProjectBranchStatus) ? 'YES' : 'NO (Uncovered)',
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
  const filteredBranches = useMemo(() => branches.filter(b => {
    const q = searchTerm.toLowerCase();
    return (b.branch?.name.toLowerCase().includes(q) || b.branch?.branchCode.toLowerCase().includes(q)) &&
      (stateFilter === 'ALL' || b.branch?.state === stateFilter) &&
      (statusFilter === 'ALL' || b.status === statusFilter) &&
      (cityFilter === '' || (b.branch?.city || '').toLowerCase().includes(cityFilter.toLowerCase())) &&
      (districtFilter === '' || (b.branch?.district || '').toLowerCase().includes(districtFilter.toLowerCase())) &&
      (priorityFilter === 'ALL' || b.priority === priorityFilter) &&
      (zoneFilter === 'ALL' || b.zoneId === zoneFilter);
  }), [branches, searchTerm, stateFilter, statusFilter, cityFilter, districtFilter, priorityFilter, zoneFilter]);

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
    })),
    [filteredBranches],
  );

  const totalCount = branches.length;
  const confirmedCount = branches.filter(b => BRANCH_COVERED_STATUSES.includes(b.status as ProjectBranchStatus)).length;
  const coveragePct = totalCount > 0 ? Number(((confirmedCount / totalCount) * 100).toFixed(1)) : 0;

  const layoutMode = localStorage.getItem('planning_layout') || 'default';
  const [layout, setLayout] = useState(layoutMode);
  const setLayoutMode = (m: string) => { setLayout(m); localStorage.setItem('planning_layout', m); };

  // ── Counter-offer negotiation handlers ──────────────────────────────────────────
  // Previously this exact logic (and the banner that triggers it) was hand-duplicated in the
  // "default" and "three-col" layouts, with the two copies already drifted apart in wording —
  // and missing entirely from "two-col-branch-recom", so a counter-offer arriving while that
  // layout was active was invisible until switching layouts. One definition now, used by all
  // three via the shared NegotiationBanner component below.
  const handleAcceptCounterOffer = async (assignmentId: string, proposedFee: number) => {
    try {
      await api.request(`/assignments/${assignmentId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus: 'ACCEPTED' }),
      });
      setMessage({ type: 'success', text: `Counter fee ₹${proposedFee.toLocaleString()} approved! Branch confirmed.` });
      refreshBranches();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to approve counter offer' });
    }
  };

  const handleOpenCounterProposal = (assignment: NonNullable<ProjectBranch['assignment']>) => {
    if (assignment.assayer) {
      setSelectedCandidate({ id: assignment.assayer.id, displayName: assignment.assayer.displayName } as any);
      // The fee already proposed on this assignment — no invented fallback. A blank field
      // reads as "nothing proposed yet", where a hardcoded ₹1500 read as a real offer.
      setNegotiatingFee(assignment.proposedFee != null ? String(assignment.proposedFee) : '');
      setCounterRemarks('');
      // This path opens the modal without fetching a fresh quote, so whatever quote the last
      // Call & Assign left behind belongs to a DIFFERENT assayer and branch. Clearing it keeps
      // the transport-grounding panel from lending this negotiation someone else's numbers.
      setFeeQuote(null);
      setCommercialBaseFee(null);
      // Counter-back mode: submit will counter THIS assignment, not create a new one.
      setCounterOfferAssignmentId(assignment.id);
      setShowNegotiationModal(true);
    }
  };

  /**
   * Ops counters the assayer's fee back. This posts a real counter-offer on the existing
   * assignment (proposeCounterFee via the NEGOTIATION transition) — it used to reuse the
   * Confirm-Assignment path, which POSTed a brand-new duplicate assignment and left the original
   * negotiation dangling, so the counter never reached the assayer.
   */
  const handleSubmitCounterOffer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!counterOfferAssignmentId) return;
    const fee = Number(negotiatingFee);
    if (!fee || Number.isNaN(fee)) {
      setMessage({ type: 'error', text: 'Enter a valid counter fee.' });
      return;
    }
    setMessage(null);
    setShowNegotiationModal(false);
    try {
      await api.request(`/assignments/${counterOfferAssignmentId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus: 'NEGOTIATION', counterFee: fee, remarks: counterRemarks || undefined }),
      });
      setMessage({ type: 'success', text: `Countered at ₹${fee.toLocaleString()}. The assayer will see your counter on their app.` });
      refreshBranches();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to send the counter offer.' });
    } finally {
      setCounterOfferAssignmentId(null);
    }
  };

  const handleDeclineCounterOffer = async (assignmentId: string) => {
    try {
      await api.request(`/assignments/${assignmentId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus: 'REJECTED', reason: 'Counter fee rejected by Operations Manager' }),
      });
      setMessage({ type: 'success', text: 'Counter offer rejected. Branch returned to candidate search.' });
      refreshBranches();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to reject counter offer' });
    }
  };

  const s = (sel: string, set: (v: string) => void, opts: { value: string; label: string }[]) => (
    <select value={sel} onChange={e => set(e.target.value)}
      style={{ padding: '7px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px', cursor: 'pointer' }}>
      {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
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
          // assayer is free — the whole point of surfacing them instead of hiding them.
          scheduledDate: scheduledDate || undefined,
          remarks: `Filter override — bypassed "${candidate.reason}". Reason: ${reason}`,
        }),
      });
      setMessage({
        type: 'success',
        text: `${candidate.displayName} assigned to ${selectedPb.branch?.name || 'branch'}${scheduledDate ? ` for ${scheduledDate}` : ''} (override recorded).`,
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
      return <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>Searching for assayers...</div>;
    }
    // A failed request previously rendered as "no candidates", which is indistinguishable from
    // a genuine empty result — the operator would go looking for assayers that were never queried.
    if (candidatesError) {
      return (
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', color: 'var(--danger)', fontSize: '12.5px', textAlign: 'center' }}>
          <AlertTriangle size={18} />
          <div>{candidatesError}</div>
          <button className="btn btn-secondary" style={{ fontSize: '11px', padding: '4px 10px' }}
            onClick={() => { void candidatesQuery.refetch(); }}>
            Retry
          </button>
        </div>
      );
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
      const withDistance = candidates.filter(c => c.distanceKm != null) as (Candidate & { distanceKm: number })[];
      const tooClose = slaEnabled ? withDistance.filter(c => c.distanceKm < slaRadius) : [];
      const tooFar = !showAllCandidates && maxRadiusEnabled ? withDistance.filter(c => c.distanceKm > maxRadius) : [];
      const nearest = withDistance.length ? Math.min(...withDistance.map(c => c.distanceKm)) : null;

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
        <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={20} style={{ color: 'var(--accent-secondary)' }} />
          <span>{msg}</span>
          {/* When the min-radius filter hides everyone, the assayers are still there (and still on
              the map) — they're just closer than the floor. Give a one-click way to reveal them,
              rather than making ops hunt for the filter toggle to understand why the list is empty. */}
          {slaEnabled && candidates.length > 0 && (
            <button
              onClick={() => { setSlaEnabled(false); setShowAllCandidates(true); }}
              className="btn btn-secondary"
              style={{ padding: '4px 8px', fontSize: '10px' }}
            >
              Show {candidates.length} assayer{candidates.length > 1 ? 's' : ''} within {slaRadius}km
            </button>
          )}
          {!slaEnabled && !showAllCandidates && candidates.length > 0 && (
            <button onClick={() => setShowAllCandidates(true)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '10px' }}>
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
              style={{ padding: '5px 10px', fontSize: '10.5px', fontWeight: 600, color: 'var(--danger)', borderColor: 'var(--danger)' }}>
              Mark unable to cover
            </button>
          )}
          {selectedPb?.status === 'UNABLE_TO_COVER' && (
            <button
              onClick={() => handleReopenCoverage(selectedPb.id, selectedPb.branch?.name || 'this branch')}
              className="btn btn-secondary"
              style={{ padding: '5px 10px', fontSize: '10.5px', fontWeight: 600 }}>
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
        {hiddenCount > 0 && (
          // Always tell the operator when candidates are being suppressed by the filters, so a
          // short list is never mistaken for "few assayers exist". One click reveals them.
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px', padding: '5px 9px', fontSize: '10.5px', fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-surface-2)', borderRadius: '6px' }}>
            <span>{displayCandidates.length} shown · {hiddenCount} hidden by filters</span>
            <button
              onClick={() => { setSlaEnabled(false); setShowAllCandidates(true); }}
              className="btn btn-secondary"
              style={{ padding: '2px 8px', fontSize: '10px' }}
            >
              Show all
            </button>
          </div>
        )}
        <div style={{ display: 'flex', gap: '12px', overflowX: horizontal ? 'auto' : 'hidden', flexDirection: horizontal ? 'row' : 'column', paddingBottom: '4px' }}>
        {displayCandidates.map(c => {
          // The real weighted score, or nothing. This used to invent 98/88/74 from distance when the
          // server returned no score, showing ops a confident match % the engine never produced.
          const conf = c.score != null ? Math.round(c.score) : null;
          // "Independent"/"too close", not "SLA compliant"/"SLA breach" — being near the branch
          // is good for service level and bad only for independence. Calling proximity an SLA
          // breach told planners the opposite of what the recommendation engine scores.
          const slaStatus = slaEnabled && c.distanceKm !== null
            ? (c.distanceKm >= slaRadius ? 'compliant' : 'breach')
            : null;
          const cardBorderColor = slaStatus === 'compliant' ? 'var(--status-active-bg)' : slaStatus === 'breach' ? 'var(--status-cancelled-bg)' : 'var(--border-color)';
          const cardBg = slaStatus === 'compliant' ? 'var(--status-active-bg)' : slaStatus === 'breach' ? 'var(--status-cancelled-bg)' : 'var(--bg-surface-2)';
          return (
            <div key={c.id} style={{
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
                    fontSize: '10.5px', fontWeight: 600, padding: '4px 8px', borderRadius: 'var(--radius-sm)',
                    background: negative ? 'var(--status-cancelled-bg)' : 'var(--status-pending-bg)',
                    color: negative ? 'var(--danger)' : 'var(--warning)',
                  }}>
                    ☎ {lc.outcome.replace(/_/g, ' ').toLowerCase()} · {when}
                    {lc.negotiatedFee != null && ` · ₹${lc.negotiatedFee.toLocaleString()}`}
                  </div>
                );
              })()}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {c.displayName}
                    {c.pendingOnThisBranch && (
                      <span title="This assayer already has a pending offer on this branch awaiting their response" style={{ fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '6px', background: 'var(--status-pending-bg)', color: 'var(--warning)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                        ⏳ Pending Response
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px', flexWrap: 'wrap' }}>
                    <Compass size={11} style={{ flexShrink: 0 }} />
                    <span>{c.distanceKm !== null ? `${c.distanceKm} km away` : 'Distance unavailable'}</span>
                    {slaEnabled && c.distanceKm !== null && (
                      <span style={{ fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: c.distanceKm >= slaRadius ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)', color: c.distanceKm >= slaRadius ? 'var(--success)' : 'var(--danger)' }}>
                        {c.distanceKm >= slaRadius ? `✓ >${slaRadius}km Radius` : `✗ Inside Radius`}
                      </span>
                    )}
                  </div>
                </div>
                <span title="Weighted across 15 dimensions including SLA compliance, acceptance history, proximity, workload, paperwork quality and cost." style={{ cursor: 'help', padding: '3px 8px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, background: conf != null && conf >= 90 ? 'var(--status-active-bg)' : 'var(--status-pending-bg)', color: conf != null && conf >= 90 ? 'var(--status-active)' : 'var(--warning)', flexShrink: 0 }}>
                  {conf != null ? `${conf}% Match` : 'Match n/a'}
                </span>
              </div>

              {/* Only ever set when the date filter was relaxed. The candidate is on the list
                  because ops asked to see past the clash — so the clash is stated here, on the
                  row they will click, rather than left to be discovered after dispatch. */}
              {c.dateConflict && (
                <div style={{ fontSize: '10.5px', fontWeight: 600, padding: '4px 8px', borderRadius: 'var(--radius-sm)', background: 'var(--status-pending-bg)', color: 'var(--warning)' }}>
                  ⚠ Not free on {scheduledAuditDate} — {c.dateConflict} Pick another date before offering.
                </div>
              )}

              <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', gap: '8px', background: 'var(--bg-surface-2)', padding: '6px 8px', borderRadius: '4px' }}>
                <span>📞 {c.phone}</span>
                <span>📍 {c.city}, {c.state}</span>
                <span>Base: {c.baseFee != null ? `₹${c.baseFee}` : '—'}</span>
              </div>

              <ScoreBreakdown breakdown={c.scoreBreakdown} />

              {/* Row 1 Actions: View Map, Route TSP, Profile Details */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
                <button onClick={() => {
                  setSelectedCandidateForMap(selectedCandidateForMap?.id === c.id ? null : c);
                  if (layout.startsWith('two-col')) {
                    setLayoutMode('three-col');
                  }
                }}
                  className="btn btn-secondary" style={{ padding: '6px', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', background: selectedCandidateForMap?.id === c.id ? 'rgba(216,174,71,0.2)' : 'var(--bg-primary)', borderColor: selectedCandidateForMap?.id === c.id ? 'var(--accent-secondary)' : 'var(--border-color)', color: selectedCandidateForMap?.id === c.id ? 'var(--accent-secondary)' : 'var(--text-primary)' }}>
                  👁️ Map
                </button>
                <button onClick={async () => {
                  if (layout.startsWith('two-col')) {
                    setLayoutMode('three-col');
                  }
                  setSelectedCandidateForMap(c);
                  await handleOptimizeRoute(c);
                }} disabled={isOptimizing}
                  className="btn btn-secondary" style={{ padding: '6px', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                  <Compass size={11} /> {isOptimizing ? 'Routing...' : 'Route'}
                </button>
                <button onClick={() => loadAssayerDetail(c.id)}
                  className="btn btn-secondary" style={{ padding: '6px', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                  <Search size={11} /> Details
                </button>
              </div>

              {/* Row 2 Actions: Call & Negotiate vs Direct App Invite */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                <button onClick={async () => {
                  setSelectedCandidate(c);
                  setCommercialBaseFee(null);
                  setLoadingCommercial(true);
                  try {
                    // Quoted by the server against the client's contracted rate card. This
                    // used to recompute the fee here from a hardcoded ₹8/km and a ₹1200
                    // fallback, which meant the recommended fee shown to ops could differ
                    // from what the server actually stored on assign.
                    const quote = await api.request<FeeQuote>('/pricing/quote', {
                      method: 'POST',
                      body: JSON.stringify({
                        assayerId: c.id,
                        projectId: selectedProjectId || undefined,
                        distanceKm: c.distanceKm || 0,
                        // The branch being covered — lets the transport rate card price the
                        // actual journey for its state instead of the generic per-km formula.
                        branchId: branches.find((b) => b.id === selectedBranchId)?.branchId || undefined,
                      }),
                    });
                    setFeeQuote(quote);
                    setCommercialBaseFee(Number(quote.baseFee));
                    setNegotiatingFee(String(Math.round(Number(quote.total))));
                  } catch {
                    // No silent second formula: if the quote fails, show what we know rather
                    // than inventing a number that the server would then reject or override.
                    setFeeQuote(null);
                    setCommercialBaseFee(null);
                    setNegotiatingFee('');
                    setMessage({ type: 'error', text: 'Could not retrieve the contracted fee for this assayer. Enter the agreed fee manually.' });
                  } finally {
                    setLoadingCommercial(false);
                    // Normal assign flow — not a counter-back.
                    setCounterOfferAssignmentId(null);
                    setShowNegotiationModal(true);
                  }
                }}
                  className="btn btn-primary" style={{ padding: '7px 10px', fontSize: '11px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                  <Phone size={12} /> Call & Assign
                </button>

                {/* Logging a call that did NOT end in an assignment is the more valuable half:
                    an unanswered call leaves no other trace, so without this the next operator
                    (or the same one tomorrow) rediscovers it by dialling again. */}
                <select
                  value=""
                  onChange={(e) => {
                    if (!e.target.value) return;
                    recordCall(c.id, e.target.value as any, undefined, 'Logged from candidate list');
                    e.target.value = '';
                  }}
                  title="Record a call that did not result in an assignment"
                  style={{ gridColumn: '1 / -1', padding: '5px 8px', fontSize: '10.5px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  <option value="">Log call outcome…</option>
                  <option value="NO_ANSWER">No answer</option>
                  <option value="CALLBACK_REQUESTED">Asked to call back</option>
                  <option value="DECLINED">Declined the work</option>
                  <option value="WRONG_NUMBER">Wrong number</option>
                </select>

                <button onClick={async () => {
                  const selectedPb = branches.find(b => b.id === selectedBranchId);
                  if (!selectedPb) return;
                  try {
                    await api.request('/assignments', {
                      method: 'POST',
                      body: JSON.stringify({
                        projectBranchId: selectedPb.id,
                        assayerId: c.id,
                        remarks: 'Dispatched directly via App Invitation',
                      }),
                    });
                    setMessage({ type: 'success', text: `App invitation dispatched directly to ${c.displayName}!` });
                    refreshBranches();
                  } catch (err: any) {
                    setMessage({ type: 'error', text: err.message || 'Direct dispatch failed' });
                  }
                }}
                  className="btn btn-secondary" style={{ padding: '7px 10px', fontSize: '11px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', background: 'var(--status-active-bg)', color: 'var(--status-active)', borderColor: 'var(--status-active-bg)' }}>
                  📲 Direct App Invite
                </button>
              </div>

              {optimizedSummary && routePoints && selectedCandidate?.id === c.id && (
                <div style={{ padding: '8px 10px', background: 'rgba(216,174,71,0.05)', border: '1px dashed rgba(216,174,71,0.3)', borderRadius: 'var(--radius-sm)', fontSize: '11px', color: 'var(--accent-secondary)', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  <div><b>🗺️ Optimized Route Details:</b></div>
                  <div>• Distance: {optimizedSummary.totalDistanceKm} km</div>
                  <div>• Est. Travel Time: {optimizedSummary.totalDurationMinutes} minutes</div>
                  {/* Server-quoted, against this client's contracted rate. This line used to
                      compute `distance * 8` inline — charging from the first kilometre, unlike
                      every other fee path, which exempts the local-commute allowance. It could
                      therefore show a travel fee that no part of the system would ever charge. */}
                  <div>
                    • Est. Travel Fee: {feeQuote
                      ? feeQuote.travelSource === 'TRANSPORT_RATE_CARD' && feeQuote.transport?.recommended
                        ? `₹${feeQuote.travelFee} by ${feeQuote.transport.recommended.modeLabel}, round trip (transport rate card)`
                        : `₹${feeQuote.travelFee} (₹${feeQuote.rates.travelFeePerKm}/km beyond ${feeQuote.rates.freeTravelAllowanceKm} km)`
                      : '—'}
                  </div>
                  <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Path covers multiple branch locations with TSP roundtrip routing optimization.</div>
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
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px)', overflow: 'hidden', margin: '-20px', background: 'var(--bg-page)' }}>
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
            <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--accent)', letterSpacing: '0.5px' }}>
              📍 STAGE 1: ASSAYER MATCHING
            </span>
          </div>
          <select
            value={selectedProjectId}
            onChange={e => setSelectedProjectId(e.target.value)}
            style={{
              padding: '5px 10px',
              background: 'var(--bg-input)',
              border: '1px solid rgba(216,174,71,0.35)',
              borderRadius: '6px',
              color: 'var(--text-primary)',
              fontSize: '12px',
              fontWeight: 700,
              outline: 'none',
              cursor: 'pointer',
              maxWidth: '220px',
            }}
          >
            {projects.map(p => <option key={p.id} value={p.id}>{p.name} ({p.projectNumber})</option>)}
          </select>
          {selectedProjectId && (
            <button
              onClick={() => setShowCoveragePlan(true)}
              className="btn btn-primary"
              style={{ marginLeft: '8px', fontSize: '11px', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}
              title="Generate, approve and deploy assignments for the whole project in one flow"
            >
              <Layers size={13} /> Coverage Plan
            </button>
          )}
        </div>

        {/* Center: Stage Pipeline Switcher */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--bg-surface-2)', padding: '3px 6px', borderRadius: '16px', border: '1px solid var(--border-hair)' }}>
          <div onClick={() => navigate('/planning')} style={{ padding: '3px 10px', background: 'var(--accent)', borderRadius: '12px', color: 'var(--on-accent)', fontSize: '11px', fontWeight: 800, cursor: 'pointer' }}>
            Stage 1: Match Assayers
          </div>
          <span style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>➔</span>
          <div onClick={() => navigate('/scheduling')} style={{ padding: '3px 10px', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>
            Stage 2: Dispatch
          </div>
          <span style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>➔</span>
          <div onClick={() => navigate('/assignments')} style={{ padding: '3px 10px', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>
            Stage 3: Execution
          </div>
        </div>

        {/* Right: Key Metrics & Report Export */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
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
              fontSize: '11px',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            📥 Excel Report
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
        {s(stateFilter, setStateFilter, [{ value: 'ALL', label: 'All States' }, ...statesList.map(s => ({ value: s, label: s }))])}
        {s(statusFilter, setStatusFilter, STATUS_OPTIONS)}
        {s(priorityFilter, setPriorityFilter, [{ value: 'ALL', label: 'All Priorities' }, { value: 'LOW', label: 'Low' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'HIGH', label: 'High' }, { value: 'CRITICAL', label: 'Critical' }])}
        {s(zoneFilter, setZoneFilter, [{ value: 'ALL', label: 'All Zones' }, ...zones.map(z => ({ value: z.id, label: z.name }))])}
        <input
          type="text"
          placeholder="Filter city..."
          value={cityFilter}
          onChange={e => setCityFilter(e.target.value)}
          style={{ width: '100px', padding: '4px 8px', background: 'var(--bg-input)', border: '1px solid var(--border-hair)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none', fontSize: '11px' }}
        />
        <input
          type="text"
          placeholder="Filter district..."
          value={districtFilter}
          onChange={e => setDistrictFilter(e.target.value)}
          style={{ width: '100px', padding: '4px 8px', background: 'var(--bg-input)', border: '1px solid var(--border-hair)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none', fontSize: '11px' }}
        />

        {(() => {
          const activeCount = [stateFilter !== 'ALL', statusFilter !== 'ALL', priorityFilter !== 'ALL', zoneFilter !== 'ALL', cityFilter !== '', districtFilter !== '', searchTerm !== ''].filter(Boolean).length;
          if (activeCount === 0) return null;
          return (
            <button
              type="button"
              onClick={() => { setStateFilter('ALL'); setStatusFilter('ALL'); setPriorityFilter('ALL'); setZoneFilter('ALL'); setCityFilter(''); setDistrictFilter(''); setSearchTerm(''); }}
              title="Clear all filters"
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px', fontSize: '11px', fontWeight: 600, color: 'var(--accent)', background: 'var(--status-pending-bg)', border: '1px solid var(--border-hair)', borderRadius: '4px', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              <X size={12} /> Clear {activeCount}
            </button>
          );
        })()}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: '3px', alignItems: 'center' }}>
          {[
            ['default', 'Map + Drawer'],
            ['two-col-branch-recom', 'Branch + Match'],
            ['two-col-branch-map', 'Branch + Map'],
            ['three-col', '3 Column'],
            ['map-only', 'Map Only'],
            ['day-plans', '📋 Day Plans']
          ].map(([k, lbl]) => (
            <button
              key={k}
              onClick={() => { setLayoutMode(k); if (k === 'day-plans' && selectedProjectId && !dayPlanData) loadDayPlans(); }}
              style={{
                background: layout === k ? 'rgba(216,174,71,0.2)' : 'transparent',
                border: `1px solid ${layout === k ? 'var(--accent)' : 'var(--border-hair)'}`,
                borderRadius: '4px',
                color: layout === k ? 'var(--text-primary)' : 'var(--text-muted)',
                cursor: 'pointer',
                padding: '3px 7px',
                fontSize: '10px',
                fontWeight: layout === k ? 700 : 400,
              }}
            >
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {/* ── Message Banner ── */}
      {message && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 16px', fontSize: '11px', borderBottom: '1px solid', background: message.type === 'success' ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)', borderColor: message.type === 'success' ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)', color: message.type === 'success' ? 'var(--accent-secondary)' : 'var(--danger)', flexShrink: 0 }}>
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
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--accent)' }}>
            {bulkSelectedIds.size} branch{bulkSelectedIds.size === 1 ? '' : 'es'} selected
          </span>

          <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '5px' }}>
            Date
            <input
              type="date"
              value={bulkScheduledDate}
              onChange={(e) => setBulkScheduledDate(e.target.value)}
              style={{ padding: '4px 7px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: '11px' }}
            />
          </label>

          {/* Shares the Call & Assign preference — one setting, so what the button does here
              never contradicts what it does in the modal. Shown rather than inherited silently:
              committing fourteen branches for someone must not be a hidden default. */}
          <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', userSelect: 'none' }}
            title={assignDirectly
              ? 'Confirmed on the assayer behalf — no acceptance needed. Untick to send these as offers.'
              : 'Sent as offers the assayer must accept in the app.'}>
            <input type="checkbox" checked={assignDirectly} onChange={(e) => setAssignDirectly(e.target.checked)}
              style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
            Assign directly
          </label>

          <button
            onClick={() => selectedCandidate && handleBulkAssign(selectedCandidate.id, selectedCandidate.displayName)}
            disabled={!selectedCandidate || bulkAssigning}
            className="btn btn-primary"
            style={{ padding: '5px 11px', fontSize: '11px', fontWeight: 700 }}
            title={selectedCandidate
              ? `${assignDirectly ? 'Confirm the selected branches for' : 'Offer the selected branches to'} ${selectedCandidate.displayName}`
              : 'Pick an assayer from the candidate list first'}>
            {bulkAssigning
              ? (assignDirectly ? 'Assigning…' : 'Offering…')
              : selectedCandidate
                ? `${assignDirectly ? 'Assign all to' : 'Offer all to'} ${selectedCandidate.displayName}`
                : 'Pick an assayer to offer to'}
          </button>

          <button
            onClick={() => {
              setUnableReason('');
              setUnableModal({ ids: [...bulkSelectedIds], label: `${bulkSelectedIds.size} branches` });
            }}
            disabled={bulkAssigning}
            className="btn btn-secondary"
            style={{ padding: '5px 11px', fontSize: '11px', fontWeight: 600, color: 'var(--danger)', borderColor: 'var(--danger)' }}>
            Mark unable to cover
          </button>

          <button onClick={() => { setBulkSelectedIds(new Set()); setBulkFailures([]); }}
            className="btn btn-secondary" style={{ padding: '5px 11px', fontSize: '11px' }}>
            Clear
          </button>

          {/* Suitability was scored against the focused branch only. Saying so matters: the
              server re-checks every constraint per branch, so some offers may still bounce. */}
          {selectedCandidate && (
            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
              Each branch is validated separately — distance, double-booking and holiday rules still apply.
            </span>
          )}

          {bulkFailures.length > 0 && (
            <span style={{ fontSize: '10.5px', color: 'var(--danger)', width: '100%' }}>
              Still failing: {bulkFailures.map((f) => `${f.branchName} (${f.error})`).join('; ')}
            </span>
          )}
        </div>
      )}

      {/* ── Layout: 2-Column (Branch Queue + Assayer Recommendations Panel) ── */}
      {layout === 'two-col-branch-recom' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'row', minHeight: 0, gap: '10px', padding: '8px', overflow: 'hidden' }}>
          {/* Column 1: Branch Queue */}
          <BranchListPanel
            branches={filteredBranches}
            loading={isLoadingQueue}
            selectedBranchId={selectedBranchId}
            onSelectBranch={setSelectedBranchId}
            searchTerm={searchTerm}
            onSearchTermChange={setSearchTerm}
            bulkSelectedIds={bulkSelectedIds}
            onToggleBulkSelect={toggleBulkSelect}
            onToggleBulkSelectAll={toggleBulkSelectAll}
            width={340}
          />

          {/* Column 2: Assayer Recommendations & Match Details */}
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
              onToggleIgnoreDateAvailability={setIgnoreDateAvailability}
              onRefresh={refreshCandidates}
            onAccept={handleAcceptCounterOffer}
            onCounter={handleOpenCounterProposal}
            onDecline={handleDeclineCounterOffer}
          />
        </div>
      )}

      {/* ── Layout: 2-Column (Branch Queue + Interactive Map) ── */}
      {(layout === 'two-col-branch-map' || (layout as any) === 'two-col') && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'row', minHeight: 0, gap: '10px', padding: '8px', overflow: 'hidden' }}>
          {/* Column 1: Branch Queue */}
          <BranchListPanel
            branches={filteredBranches}
            loading={isLoadingQueue}
            selectedBranchId={selectedBranchId}
            onSelectBranch={setSelectedBranchId}
            searchTerm={searchTerm}
            onSearchTermChange={setSearchTerm}
            bulkSelectedIds={bulkSelectedIds}
            onToggleBulkSelect={toggleBulkSelect}
            onToggleBulkSelectAll={toggleBulkSelectAll}
            width={340}
          />

          {/* Column 2: Interactive Planning Map */}
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
        </div>
      )}

      {/* ── Layout: Default (Branch queue + Map + Assayer Match Drawer) ── */}
      {layout === 'default' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'row', minHeight: 0, gap: '8px', padding: '8px', overflow: 'hidden' }}>
          <BranchListPanel
            branches={filteredBranches}
            loading={isLoadingQueue}
            selectedBranchId={selectedBranchId}
            onSelectBranch={setSelectedBranchId}
            searchTerm={searchTerm}
            onSearchTermChange={setSearchTerm}
            bulkSelectedIds={bulkSelectedIds}
            onToggleBulkSelect={toggleBulkSelect}
            onToggleBulkSelectAll={toggleBulkSelectAll}
            width={280}
          />

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
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
            <div ref={drawerRef} style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              maxHeight: selectedBranchId ? '280px' : '0px', overflow: 'hidden',
              transition: 'max-height 0.3s ease, opacity 0.2s ease', opacity: selectedBranchId ? 1 : 0, zIndex: 20,
              background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
            }}>
              {selectedPb && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <RecommendationPanel
                    onViewHistory={setHistoryBranchId}
                    selectedPb={selectedPb}
                    renderCandidatesList={renderCandidatesList}
                    flex
                    horizontal
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
              onToggleIgnoreDateAvailability={setIgnoreDateAvailability}
                    onRefresh={refreshCandidates}
                    onAccept={handleAcceptCounterOffer}
                    onCounter={handleOpenCounterProposal}
                    onDecline={handleDeclineCounterOffer}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Layout: 3-Column (Branch list + Map + Match Detail panel) ── */}
      {layout === 'three-col' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'row', minHeight: 0, gap: '10px', padding: '8px', overflow: 'hidden' }}>
          {/* Column 1: Branch Queue Panel */}
          <BranchListPanel
            branches={filteredBranches}
            loading={isLoadingQueue}
            selectedBranchId={selectedBranchId}
            onSelectBranch={setSelectedBranchId}
            searchTerm={searchTerm}
            onSearchTermChange={setSearchTerm}
            bulkSelectedIds={bulkSelectedIds}
            onToggleBulkSelect={toggleBulkSelect}
            onToggleBulkSelectAll={toggleBulkSelectAll}
            width={320}
          />

          {/* Column 2: Center Interactive GIS Map */}
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

          {/* Column 3: Right Match & Counter-Offer Inspector Panel */}
          <RecommendationPanel
            onViewHistory={setHistoryBranchId}
            selectedPb={selectedPb}
            renderCandidatesList={renderCandidatesList}
            width={380}
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
              onToggleIgnoreDateAvailability={setIgnoreDateAvailability}
            onRefresh={refreshCandidates}
            onAccept={handleAcceptCounterOffer}
            onCounter={handleOpenCounterProposal}
            onDecline={handleDeclineCounterOffer}
          />
        </div>
      )}

      {/* ── Layout: Map Only ── */}
      {layout === 'map-only' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '0 0 32px' }}>
          <InteractivePlanningMap fillContainer
            branches={mapBranches}
            selectedBranchId={selectedBranchId}
            onSelectBranch={setSelectedBranchId}
            routePoints={routePoints}
            selectedAssayerFromParent={selectedCandidateForMap}
            slaEnabled={slaEnabled}
            slaRadius={slaRadius}
            travelRates={travelRates}
          />
        </div>
      )}

      {/* ── Negotiation Modal ── */}
      {showNegotiationModal && selectedCandidate && selectedPb && (
        <Modal open onClose={() => setShowNegotiationModal(false)}
          title={counterOfferAssignmentId ? "Counter the assayer's fee" : 'Confirm Assignment'}
          width="580px" asForm
          onSubmit={counterOfferAssignmentId ? handleSubmitCounterOffer : handleConfirmAssignment}
          bodyStyle={{ padding: '24px' }} footer={
          <>
            <button type="button" onClick={() => setShowNegotiationModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Check size={14} /> {counterOfferAssignmentId ? 'Send counter' : 'Confirm Commitment'}
            </button>
          </>
        }>            {/* Assayer Summary */}
            <div style={{ display: 'flex', gap: '14px', padding: '14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
              <div style={{ width: '44px', height: '44px', borderRadius: '50%', background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--on-accent)', fontSize: '17px', fontWeight: 700, flexShrink: 0 }}>
                {selectedCandidate.displayName.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>{selectedCandidate.displayName}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>{selectedCandidate.assayerCode}</div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '6px', fontSize: '11px', color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}><MapPin size={10} /> {selectedCandidate.city}, {selectedCandidate.state}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}><Phone size={10} /> {selectedCandidate.phone}</span>
                  {selectedCandidate.email && <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}><Mail size={10} /> {selectedCandidate.email}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', flexShrink: 0 }}>
                <span style={{ padding: '2px 8px', borderRadius: '8px', fontSize: '11px', fontWeight: 600, background: (selectedCandidate.score ?? 0) >= 90 ? 'var(--status-active-bg)' : 'var(--status-pending-bg)', color: (selectedCandidate.score ?? 0) >= 90 ? 'var(--status-active)' : 'var(--warning)' }}>
                  {selectedCandidate.score != null ? `${Math.round(selectedCandidate.score)}% Match` : 'Match n/a'}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}><Compass size={10} /> {selectedCandidate.distanceKm ?? 'N/A'} km</span>
              </div>
            </div>

            {/* Branch + Assignment details in 2-col grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div style={{ padding: '12px', background: 'rgba(216,174,71,0.05)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(216,174,71,0.15)' }}>
                <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Building2 size={11} /> BRANCH
                </div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{selectedPb.branch.name}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>{selectedPb.branch.city}, {selectedPb.branch.state}</div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px' }}>Code: {selectedPb.branch.branchCode}</div>
              </div>
              <div style={{ padding: '12px', background: 'var(--status-active-bg)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--status-active-bg)' }}>
                <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <TrendingUp size={11} /> ASSIGNMENT
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Status: </span>
                  <span style={{ color: 'var(--warning)', fontWeight: 600 }}>{selectedPb.status.replace(/_/g, ' ')}</span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Priority: </span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{selectedPb.priority || 'Normal'}</span>
                </div>
                {selectedCandidate.baseFee != null && (
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Suggested Fee: </span>
                    <span style={{ color: 'var(--warning)', fontWeight: 600 }}>₹{selectedCandidate.baseFee.toLocaleString()}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Fee inputs */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <DollarSign size={11} /> Base Fee
                </label>
                <div style={{ padding: '10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: loadingCommercial ? 'var(--text-muted)' : 'var(--warning)', fontSize: '14px', fontWeight: 600 }}>
                  {loadingCommercial ? 'Loading...' : commercialBaseFee != null ? `₹${commercialBaseFee.toLocaleString()}` : selectedCandidate.baseFee != null ? `₹${selectedCandidate.baseFee.toLocaleString()}` : 'Not set'}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <TrendingUp size={11} /> Negotiation Fee
                </label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '13px' }}>₹</span>
                  <input type="number" value={negotiatingFee} onChange={e => setNegotiatingFee(e.target.value)} required
                    style={{ width: '100%', padding: '10px 10px 10px 26px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '14px', boxSizing: 'border-box' }} />
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Calendar size={11} /> Audit Scheduled Date
                </label>
                <input type="date" value={scheduledAuditDate} onChange={e => pinPlanDate(e.target.value)} required={!counterOfferAssignmentId}
                  style={{ width: '100%', padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px', boxSizing: 'border-box' }} />
              </div>
            </div>

            {/* The transport grounding behind the recommended fee: what the journey actually
                costs by the recommended mode, with the alternatives, so the caller can argue
                in specifics ("bus both ways is ₹240") instead of feel. Server-quoted — this
                modal computes nothing. */}
            {feeQuote?.travelSource === 'TRANSPORT_RATE_CARD' && feeQuote.transport?.recommended && (
              <div style={{ marginTop: '12px', padding: '10px 12px', background: 'rgba(216,174,71,0.06)', border: '1px dashed rgba(216,174,71,0.35)', borderRadius: 'var(--radius-sm)', fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                  🚌 Recommended fee includes ₹{feeQuote.travelFee.toLocaleString()} travel — {feeQuote.transport.recommended.modeLabel}, round trip
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

            {counterOfferAssignmentId && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '12px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Note to the assayer (optional)</label>
                <textarea value={counterRemarks} onChange={e => setCounterRemarks(e.target.value)} rows={2}
                  placeholder="e.g. This is our best rate for this route."
                  style={{ width: '100%', padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px', boxSizing: 'border-box', resize: 'vertical' }} />
              </div>
            )}

            {/* Assign-directly + auto-dispatch — only for a fresh assignment, not a fee counter. */}
            {!counterOfferAssignmentId && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Ticked, the desk confirms on the assayer's behalf: the call already settled it,
                  so there is nothing left for them to accept. Unticked restores the offer flow. */}
              <div style={{ padding: '10px 12px', background: assignDirectly ? 'var(--status-active-bg)' : 'var(--bg-surface-2)', borderRadius: 'var(--radius-sm)', border: `1px solid ${assignDirectly ? 'var(--success)' : 'var(--border-color)'}`, display: 'flex', alignItems: 'center', gap: '10px' }}>
                <input type="checkbox" id="assignDirectlyToggle" checked={assignDirectly} onChange={e => setAssignDirectly(e.target.checked)} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                <label htmlFor="assignDirectlyToggle" style={{ fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer', userSelect: 'none' }}>
                  <span style={{ fontWeight: 700, color: assignDirectly ? 'var(--success)' : 'var(--warning)' }}>
                    {assignDirectly ? '✅ Assign directly — agreed on this call: ' : '📨 Send as an offer: '}
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
                <label htmlFor="autoDispatchToggle" style={{ fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer', userSelect: 'none' }}>
                  <span style={{ fontWeight: 700, color: autoDispatch ? 'var(--success)' : 'var(--warning)' }}>
                    {autoDispatch ? '⚡ Fast-Track Direct Lock: ' : '📋 Send to Unscheduled Queue: '}
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {autoDispatch
                      ? `Auto-creates calendar dispatch packet on acceptance${assignDirectly ? ' — immediately, since this is confirmed now' : ''}`
                      : 'Acceptance moves offer to Unscheduled Queue for manual dispatching'}
                  </span>
                </label>
              </div>
            </div>
            )}
          </Modal>
        )}

      {/* ── Assayer Detail Modal ── */}
      {showAssayerDetailModal && (
        <Modal open onClose={() => { setShowAssayerDetailModal(false); setDetailAssayer(null); setDetailRemarks([]); }} title="Assayer Details" width="800px" maxHeight="90vh" bodyStyle={{ padding: '0 4px 0 0' }}>
            <div style={{ overflowY: 'auto', paddingRight: '4px' }}>
              {loadingDetail ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading assayer details...</div>
              ) : !detailAssayer ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Assayer not found.</div>
              ) : (
                <>
                  {(() => {
                    const effectiveTotal = Math.max(detailAssayer.totalAssignments, detailAssayer.auditHistory?.length || 0);
                    const effectiveCompleted = Math.max(detailAssayer.completedAssignments, detailAssayer.auditHistory?.filter(a => ['COMPLETED', 'AUDIT_COMPLETED', 'CLOSED', 'VALIDATION_COMPLETED'].includes(a.status)).length || 0);
                    const completionRate = effectiveTotal > 0
                      ? Math.round((effectiveCompleted / effectiveTotal) * 100) : 0;
                    const onTimeRate = effectiveCompleted > 0
                      ? Math.round((Math.max(detailAssayer.onTimeCompletions, effectiveCompleted) / effectiveCompleted) * 100) : 0;
                    return (
                      <>
                        {/* Header Card */}
                        <div className="glass-card" style={{ padding: '20px', borderRadius: 'var(--radius-md)', marginBottom: '16px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                              <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--on-accent)', fontSize: '18px', fontWeight: 700 }}>
                                {detailAssayer.displayName.charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <h3 style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>{detailAssayer.displayName}</h3>
                                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '2px', flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{detailAssayer.assayerCode}</span>
                                  <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                                  <span style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '8px', background: detailAssayer.lifecycleStatus === 'ACTIVE' ? 'var(--status-active-bg)' : 'var(--status-pending-bg)', color: detailAssayer.lifecycleStatus === 'ACTIVE' ? 'var(--status-active)' : 'var(--warning)', fontWeight: 500 }}>{detailAssayer.lifecycleStatus}</span>
                                  <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '3px' }}><Briefcase size={10} /> {detailAssayer.employmentType}</span>
                                  <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '3px' }}><Star size={10} /> {detailAssayer.experienceYears} yrs exp</span>
                                </div>
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                              <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '24px', fontWeight: 700, color: detailAssayer.averageRating >= 4 ? 'var(--status-active)' : detailAssayer.averageRating >= 3 ? 'var(--warning)' : 'var(--danger)' }}>
                                  {Number(detailAssayer.averageRating) > 0 ? Number(detailAssayer.averageRating).toFixed(1) : '—'}
                                </div>
                                <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '1px' }}>Avg Rating</div>
                              </div>
                              <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--accent-primary)' }}>
                                  {Number(detailAssayer.performanceRating).toFixed(1)}
                                </div>
                                <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '1px' }}>Perf. Rating</div>
                              </div>
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border-color)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><MapPin size={11} /> {detailAssayer.city}, {detailAssayer.state}</div>
                            {detailAssayer.phone && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><Phone size={11} /> {detailAssayer.phone}</div>}
                            {detailAssayer.email && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><Mail size={11} /> {detailAssayer.email}</div>}
                            {detailAssayer.department && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><Briefcase size={11} /> {detailAssayer.department}</div>}
                            {detailAssayer.region && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><MapPin size={11} /> Region: {detailAssayer.region}</div>}
                          </div>
                        </div>

                        {/* KPI Cards */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '10px', marginBottom: '16px' }}>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><Briefcase size={10} /> Total Audits</div>
                            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--accent-primary)' }}>{effectiveTotal}</div>
                          </div>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><CheckCircle size={10} /> Completed</div>
                            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--status-active)' }}>{effectiveCompleted}</div>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '1px' }}>{completionRate}%</div>
                          </div>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><TrendingUp size={10} /> Acceptance</div>
                            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--accent)' }}>{detailAssayer.acceptanceRate ?? 100}%</div>
                          </div>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><X size={10} /> Rejection Rate</div>
                            <div style={{ fontSize: '20px', fontWeight: 700, color: (detailAssayer.rejectionRate || 0) > 15 ? 'var(--danger)' : 'var(--success)' }}>{detailAssayer.rejectionRate ?? 0}%</div>
                          </div>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><AlertTriangle size={10} /> Queries Raised</div>
                            <div style={{ fontSize: '20px', fontWeight: 700, color: (detailAssayer.queryCount || 0) > 0 ? 'var(--warning)' : 'var(--success)' }}>{detailAssayer.queryCount ?? 0}</div>
                          </div>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><DollarSign size={10} /> Total Paid</div>
                            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--warning)' }}>₹{Number(detailAssayer.totalEarnings).toLocaleString()}</div>
                          </div>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                          {/* Left: Skills & Certifications */}
                          <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
                            <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><Award size={13} /> Skills & Certifications</h4>
                            <div style={{ marginBottom: '10px' }}>
                              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>SKILLS</div>
                              {detailAssayer.skills && detailAssayer.skills.length > 0 ? (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                                  {detailAssayer.skills.map(s => (
                                    <span key={s} style={{ padding: '2px 6px', background: 'rgba(216,174,71,0.1)', color: 'var(--accent-primary)', borderRadius: '8px', fontSize: '10px' }}>{s}</span>
                                  ))}
                                </div>
                              ) : (
                                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No skills recorded</div>
                              )}
                            </div>
                            <div>
                              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>CERTIFICATIONS</div>
                              {detailAssayer.certifications && detailAssayer.certifications.length > 0 ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                  {detailAssayer.certifications.map(c => (
                                    <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 6px', background: 'var(--status-active-bg)', borderRadius: 'var(--radius-sm)' }}>
                                      <span style={{ fontSize: '11px', color: 'var(--text-primary)' }}>{c.name}</span>
                                      <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Exp: {new Date(c.expiryDate).toLocaleDateString()}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No certifications recorded</div>
                              )}
                            </div>
                          </div>

                          {/* Right: Performance Insights */}
                          <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
                            <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><TrendingUp size={13} /> Performance Insights</h4>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              <div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>COMPLETION RATE</div>
                                <div style={{ height: '6px', background: 'var(--bg-primary)', borderRadius: '3px', overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${completionRate}%`, background: completionRate >= 80 ? 'var(--status-active)' : completionRate >= 50 ? 'var(--warning)' : 'var(--danger)', borderRadius: '3px', transition: 'width 0.3s' }} />
                                </div>
                                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '1px' }}>{completionRate}%</div>
                              </div>
                              <div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>ON-TIME DELIVERY</div>
                                <div style={{ height: '6px', background: 'var(--bg-primary)', borderRadius: '3px', overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${onTimeRate}%`, background: onTimeRate >= 80 ? 'var(--status-active)' : onTimeRate >= 50 ? 'var(--warning)' : 'var(--danger)', borderRadius: '3px', transition: 'width 0.3s' }} />
                                </div>
                                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '1px' }}>{onTimeRate}%</div>
                              </div>
                              {detailAssayer.activeCommercialProfile && (
                                <div style={{ padding: '8px', background: 'rgba(216,174,71,0.1)', borderRadius: '6px', border: '1px solid rgba(216,174,71,0.2)' }}>
                                  <div style={{ fontSize: '10px', color: 'var(--accent)', fontWeight: 700, marginBottom: '2px' }}>ACTIVE COMMERCIAL RATE</div>
                                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>₹{detailAssayer.activeCommercialProfile.baseFee?.toLocaleString()} / audit</div>
                                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>
                                    Travel: ₹{detailAssayer.activeCommercialProfile.travelReimbursement || 0} | Daily: ₹{detailAssayer.activeCommercialProfile.dailyRate || 0}
                                  </div>
                                </div>
                              )}
                              {detailAssayer.totalEarnings > 0 && (
                                <div>
                                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>AVERAGE EARNINGS PER JOB</div>
                                  <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--warning)' }}>
                                    ₹{Math.round(Number(detailAssayer.totalEarnings) / Math.max(detailAssayer.completedAssignments, 1)).toLocaleString()}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Audit History Timeline */}
                        <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)', marginTop: '14px' }}>
                          <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><Calendar size={13} /> Audit History & Fee Logs</h4>
                          {detailAssayer.auditHistory && detailAssayer.auditHistory.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '200px', overflowY: 'auto' }}>
                              {detailAssayer.auditHistory.map(ah => (
                                <div key={ah.id} style={{ padding: '8px 10px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', borderLeft: '3px solid var(--accent)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <div>
                                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{ah.branch_name || 'Branch Audit'}</div>
                                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{ah.branch_city}, {ah.branch_state} | {ah.project_name || 'GSS Project'}</div>
                                  </div>
                                  <div style={{ textAlign: 'right' }}>
                                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--warning)' }}>₹{(ah.agreed_fee || ah.proposed_fee || 0).toLocaleString()}</div>
                                    <span style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '3px', background: 'rgba(216,174,71,0.2)', color: 'var(--accent)', fontWeight: 600 }}>{ah.status}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div style={{ textAlign: 'center', padding: '12px', color: 'var(--text-muted)', fontSize: '11px' }}>No audit history recorded.</div>
                          )}
                        </div>

                        {/* Remarks */}
                        <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)', marginTop: '14px' }}>
                          <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><Star size={13} /> Reviews & Remarks</h4>
                          {detailRemarks.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '12px', color: 'var(--text-muted)', fontSize: '11px' }}>No remarks yet.</div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '300px', overflowY: 'auto' }}>
                              {detailRemarks.map(r => (
                                <div key={r.id} style={{ padding: '8px 10px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', borderLeft: `3px solid ${CATEGORY_COLORS[r.category] || 'var(--text-muted)'}` }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '3px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                                      <span style={{ fontSize: '9px', padding: '1px 4px', borderRadius: '3px', background: `${CATEGORY_COLORS[r.category] || 'var(--text-muted)'}20`, color: CATEGORY_COLORS[r.category] || 'var(--text-muted)', fontWeight: 600 }}>{r.category}</span>
                                      <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>by {r.authorName}</span>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '1px' }}>
                                      {r.rating != null && [1, 2, 3, 4, 5].map(s => (
                                        <Star key={s} size={9} fill={s <= r.rating! ? 'var(--warning)' : 'none'} color={s <= r.rating! ? 'var(--warning)' : 'var(--text-muted)'} />
                                      ))}
                                    </div>
                                  </div>
                                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{r.content}</div>
                                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>{new Date(r.createdAt).toLocaleString()}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </>
                    );
                  })()}
                </>
              )}
            </div>
          </Modal>
        )}

      {/* ── Layout: Day Plans (Multi-Branch Cluster View) ── */}
      {layout === 'day-plans' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '0 32px 32px', overflowY: 'auto' }}>
          {/* Header & Refresh */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0 8px', flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Layers size={18} style={{ color: 'var(--accent-primary)' }} />
              <h2 style={{ fontSize: '16px', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Multi-Branch Day Plans</h2>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Clusters nearby branches → assigns single assayer per cluster for one-day coverage</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                <Calendar size={12} />
                <input type="date" value={dayPlanTargetDate} min={todayDateKey()}
                  onChange={(e) => setDayPlanTargetDate(e.target.value)}
                  style={{ padding: '4px 6px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '11px', outline: 'none' }} />
              </label>
              {/* Coverage doesn't stop at an engagement boundary: two banks can have branches
                  on the same street, and an assayer sent to one may as well cover both. The
                  globally-selected project is always in scope; these only widen it. */}
              {projects.length > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Plan with:</span>
                  {projects.filter((p) => p.id !== selectedProjectId).map((p) => {
                    const on = dayPlanProjectIds.includes(p.id);
                    return (
                      <button key={p.id} type="button"
                        onClick={() => {
                          const next = on ? dayPlanProjectIds.filter((x) => x !== p.id) : [...dayPlanProjectIds, p.id];
                          setDayPlanProjectIds(next);
                          loadDayPlans(next);
                        }}
                        title={`${on ? 'Exclude' : 'Include'} ${p.name} when clustering branches for this day`}
                        style={{ padding: '3px 8px', fontSize: '10.5px', fontWeight: on ? 700 : 500, cursor: 'pointer',
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
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: slaEnabled ? 'var(--warning)' : 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
                <input type="checkbox" checked={slaEnabled} onChange={(e) => setSlaEnabled(e.target.checked)} />
                Min Radius Filter
              </label>
              {slaEnabled && (
                <select value={slaRadius} onChange={(e) => setSlaRadius(Number(e.target.value))}
                  style={{ fontSize: '10px', padding: '2px 5px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--warning)', outline: 'none', cursor: 'pointer' }}>
                  {[25, 50, 100, 150, 200, 300, 500].map(v => <option key={v} value={v}>{v}km</option>)}
                </select>
              )}
              <button onClick={() => loadDayPlans()} disabled={isLoadingDayPlans}
                className="btn btn-primary" style={{ padding: '6px 14px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <Route size={13} /> {isLoadingDayPlans ? 'Generating...' : 'Generate Day Plans'}
              </button>
            </div>
          </div>

          {dayPlanData?.effectiveMinDistanceKm != null && (
            <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', paddingBottom: '4px' }}>
              Enforcing a {dayPlanData.effectiveMinDistanceKm}km minimum distance
              {!slaEnabled || dayPlanData.effectiveMinDistanceKm > slaRadius
                ? " (this client's own configured floor — it always applies, regardless of the filter above)"
                : ''}.
            </div>
          )}

          {isLoadingDayPlans && (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)', fontSize: '13px' }}>
              <div className="loading-spinner" style={{ width: '30px', height: '30px', border: '3px solid var(--border-color)', borderTop: '3px solid var(--accent-primary)', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
              Analyzing branch clusters, calculating routes & scoring assayers...
            </div>
          )}

          {!isLoadingDayPlans && !dayPlanData && (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)', fontSize: '13px' }}>
              <Layers size={40} style={{ color: 'var(--border-color)', margin: '0 auto 12px', display: 'block' }} />
              Click "Generate Day Plans" to cluster branches and find optimal assayer assignments.
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' as const }}>{kpi.icon} {kpi.label}</div>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: kpi.color }}>{kpi.value}</div>
                  </div>
                ))}
              </div>

              {/* Date moved because the requested day couldn't be worked. Previously the
                  planner would plan a holiday and only fail later, at assign time. */}
              {dayPlanData.dateAdjustment && (
                <div style={{ background: 'rgba(216,174,71,0.06)', border: '1px solid rgba(216,174,71,0.25)', borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Calendar size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  <div style={{ fontSize: '11.5px', color: 'var(--accent)' }}>
                    <b>{dayPlanData.dateAdjustment.requestedDate}</b> can't be worked — {dayPlanData.dateAdjustment.reason}
                    {' '}Planned for <b>{dayPlanData.targetDate}</b> instead.
                  </div>
                </div>
              )}

              {/* The core signal this whole mechanism exists to surface: a full paid day
                  being spent on a couple of hours of work. */}
              {dayPlanData.underutilizedBranches.length > 0 && (
                <div style={{ background: 'var(--status-cancelled-bg)', border: '1px solid var(--status-cancelled-bg)', borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: '12px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--danger)', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <AlertTriangle size={13} /> {dayPlanData.underutilizedBranches.length} branch(es) would use a full paid day for a few hours of work
                  </div>
                  <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                    No neighbouring branch was close enough to bundle. Consider deferring these into a cycle where they can share a day.
                  </div>
                  {dayPlanData.underutilizedBranches.map((b, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '3px' }}>
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
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--accent-primary)', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Layers size={13} /> {dayPlanData.multiDayBranches.length} branch(es) need more than one day on their own
                    <span style={{ marginLeft: 'auto', fontWeight: 800 }}>
                      {dayPlanData.multiDayBranches.reduce((sum, b) => sum + b.daysRequired, 0)} assayer-days
                    </span>
                  </div>
                  <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                    Their own workload exceeds a working day, so they can't be bundled with anything. Split each across the days shown, or send more than one assayer.
                  </div>
                  {[...dayPlanData.multiDayBranches].sort((a, b) => b.daysRequired - a.daysRequired).map((b, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '3px' }}>
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
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--warning)', marginBottom: '6px' }}>⚠️ {dayPlanData.unclusteredBranches.length} Branch(es) Could Not Be Clustered</div>
                  {dayPlanData.unclusteredBranches.map((b, i) => (
                    <div key={i} style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '2px' }}>• {b.branchName}: {b.reason}</div>
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
                        <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--accent-primary)', background: 'rgba(216,174,71,0.1)', padding: '3px 8px', borderRadius: '4px' }}>{cluster.clusterId}</span>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{cluster.branches.length} Branches</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {cluster.branches.map(b => b.branchName.replace(/^(Pune |Nashik |Mumbai |Bangalore )/, '')).join(' → ')}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        {cluster.totalPackets > 0 && (
                          <span style={{ fontSize: '11px', color: 'var(--accent-primary)', fontWeight: 700 }}>{cluster.totalPackets} packets</span>
                        )}
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}><Clock size={11} /> {cluster.totalEstimatedAuditHours}h audit</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}><MapPin size={11} /> {cluster.radiusKm.toFixed(0)}km radius</span>
                        <span style={{ fontSize: '11px', fontWeight: 600, color: cluster.feasibleForOneDay ? 'var(--status-active)' : 'var(--danger)' }}>
                          {cluster.feasibleForOneDay ? '✅ Fits 1 day' : '❌ Exceeds capacity'}
                        </span>
                        {bestPlan && (
                          <span style={{ fontSize: '11px', color: 'var(--warning)', fontWeight: 600 }}>
                            Best: {bestPlan.assayerName} (₹{bestPlan.estimatedTotalCost.toLocaleString()})
                          </span>
                        )}
                        <span style={{ fontSize: '14px', color: 'var(--text-muted)', transition: 'transform 0.2s', transform: expandedCluster === cluster.clusterId ? 'rotate(180deg)' : 'none' }}>▾</span>
                      </div>
                    </div>

                    {/* Expanded Cluster: Day Plan Candidates */}
                    {expandedCluster === cluster.clusterId && (
                      <div style={{ padding: '14px 16px' }}>
                        {/* Branches in this cluster */}
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
                          {cluster.branches.map(b => (
                            <div key={b.branchId} style={{ background: 'rgba(216,174,71,0.06)', border: '1px solid rgba(216,174,71,0.15)', borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: '11px' }}>
                              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{b.branchName}</div>
                              <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                                {b.branchCode} • {b.city} •{' '}
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
                          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '12px' }}>
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
                                  <span style={{ position: 'absolute' as const, top: '-1px', right: '12px', background: 'var(--status-active)', color: 'var(--text-primary)', fontSize: '9px', fontWeight: 700, padding: '2px 8px', borderRadius: '0 0 4px 4px' }}>
                                    ⭐ RECOMMENDED
                                  </span>
                                )}

                                {/* Assayer Info Row */}
                                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '12px' }}>
                                  <div>
                                    <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                      {plan.assayerName}
                                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 400 }}>({plan.assayerCode})</span>
                                    </div>
                                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', gap: '10px', marginTop: '3px' }}>
                                      <span><Phone size={10} /> {plan.assayerPhone}</span>
                                      <span><MapPin size={10} /> {plan.assayerCity}</span>
                                    </div>
                                  </div>
                                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                    <span style={{
                                      padding: '4px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
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
                                      style={{ padding: '6px 12px', fontSize: '11px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}>
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
                                    <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--danger)' }}>
                                      {dayPlanFailures[`${cluster.clusterId}:${plan.assayerId}`].length} of {plan.totalBranches} branches could not be assigned
                                    </div>
                                    <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '10.5px', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
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
                                      style={{ padding: '5px 10px', fontSize: '10.5px', fontWeight: 700, alignSelf: 'flex-start' }}>
                                      {dayPlanAssigning === `${cluster.clusterId}:${plan.assayerId}` ? 'Retrying…' : 'Retry failed branches'}
                                    </button>
                                  </div>
                                )}

                                {/* Metrics Grid */}
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', marginBottom: '12px' }}>
                                  {[
                                    // Packets and idle time lead: they answer "is this day worth
                                    // buying", which branch/hour counts alone don't.
                                    ...(plan.totalPackets > 0 ? [{ label: 'Packets', val: String(plan.totalPackets), icon: '📦', warn: false }] : []),
                                    ...(plan.costPerPacket != null ? [{ label: 'Cost / Packet', val: `₹${plan.costPerPacket.toLocaleString()}`, icon: '💰', warn: false }] : []),
                                    // Idle time is the cost of a badly-packed day, so it's called
                                    // out in amber once it passes roughly a quarter of the day.
                                    { label: 'Idle (paid)', val: `${plan.idleHours}h`, icon: plan.idleHours >= 3 ? '⚠️' : '✅', warn: plan.idleHours >= 3 },
                                    { label: 'Branches', val: String(plan.totalBranches), icon: '🏢', warn: false },
                                    { label: 'Audit Time', val: `${plan.totalAuditHours}h`, icon: '⏱️', warn: false },
                                    { label: 'Travel', val: `${plan.totalTravelKm.toFixed(0)}km / ${plan.totalTravelMinutes.toFixed(0)}min`, icon: '🚗', warn: false },
                                    { label: 'Total Day', val: `${plan.totalDayHours.toFixed(1)}h`, icon: '📅', warn: false },
                                    { label: 'Day Window', val: `${plan.dayStartTime} → ${plan.dayEndTime}`, icon: '🕐', warn: false },
                                    { label: 'Utilization', val: `${plan.utilizationPercent}%`, icon: plan.utilizationPercent >= 70 ? '🔥' : '📊', warn: false },
                                  ].map((m, mi) => (
                                    <div key={mi} style={{ background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', padding: '6px 10px' }}>
                                      <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' as const }}>{m.icon} {m.label}</div>
                                      <div style={{ fontSize: '13px', fontWeight: 600, color: m.warn ? 'var(--warning)' : 'var(--text-primary)', marginTop: '2px' }}>{m.val}</div>
                                    </div>
                                  ))}
                                </div>

                                {/* Cost Breakdown */}
                                <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', padding: '8px 12px', background: 'rgba(216,174,71,0.04)', border: '1px dashed rgba(216,174,71,0.2)', borderRadius: 'var(--radius-sm)' }}>
                                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                                    <span style={{ fontWeight: 600 }}>💰 Cost:</span>{' '}
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
                                      fontSize: '10px', padding: '2px 6px', borderRadius: '4px',
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
                                  <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                                    <Route size={12} /> Route Schedule (Optimized TSP)
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
                                            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                                              #{stop.order} {stop.branchName}
                                            </span>
                                            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>({stop.branchCode})</span>
                                          </div>
                                          <div style={{ fontSize: '10px', color: 'var(--text-secondary)', display: 'flex', gap: '12px', marginTop: '2px' }}>
                                            <span>🕐 Arrive {stop.estimatedArrival} → Depart {stop.estimatedDeparture}</span>
                                            <span>⏱️ Audit: {stop.estimatedAuditHours}h</span>
                                            {stop.travelFromPreviousKm > 0 && (
                                              <span>🚗 Travel: {stop.travelFromPreviousKm}km ({stop.travelFromPreviousMinutes}min)</span>
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
                                      <div style={{ fontSize: '11px', color: 'var(--warning)', fontWeight: 600 }}>🏠 Return Home by {plan.dayEndTime}</div>
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
            style={{ width: 'min(460px, 100%)', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>Mark unable to cover</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Recorded against <b>{unableModal.label}</b> and reported to the client. Be specific
              (e.g. "No certified assayer within 150km for the SLA window").
            </div>
            <textarea
              autoFocus
              value={unableReason}
              onChange={(e) => setUnableReason(e.target.value)}
              placeholder="Reason this cannot be staffed…"
              rows={4}
              style={{ resize: 'vertical', fontSize: '13px', padding: '9px 11px', background: 'var(--bg-input)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', outline: 'none' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button onClick={() => setUnableModal(null)} disabled={unableSubmitting} className="btn btn-secondary" style={{ fontSize: '12px', padding: '6px 14px' }}>Cancel</button>
              <button onClick={submitUnableToCover} disabled={!unableReason.trim() || unableSubmitting}
                className="btn btn-primary" style={{ fontSize: '12px', padding: '6px 14px', color: 'var(--danger)', opacity: !unableReason.trim() || unableSubmitting ? 0.6 : 1 }}>
                {unableSubmitting ? 'Recording…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
