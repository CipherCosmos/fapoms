import { api } from './api';

/**
 * Typed API layer for the Planning workspace.
 *
 * `PlanningWorkspace.tsx` (2,457 LOC) calls ~14 endpoints inline through `api.request(...)`,
 * each embedded in component logic, with response shapes re-declared at the call site. This
 * module gives those endpoints one typed home — mirroring `services/billing.ts` and
 * `services/clients.ts` — so the component can be migrated onto it call-by-call under review.
 *
 * The functions are exact relocations of the existing requests: same URLs, methods and bodies.
 * Response types the component owns (ProjectBranch, day-plan, candidate shapes) are left generic
 * so this service does not depend on `pages/`; the caller supplies the type it already has.
 */

// ── Reference / read ────────────────────────────────────────────────────────────
export interface ProjectOption {
  id: string;
  name: string;
  projectNumber: string;
}

export interface ZoneOption {
  id: string;
  name: string;
  /** Null for a zone available to every client. Zone names repeat across clients — "West Zone"
   *  exists once per bank — so anything offering zones in a flat list needs this to tell them
   *  apart. */
  clientId?: string | null;
}

export interface TravelRates {
  travelFeePerKm: number;
  freeTravelAllowanceKm: number;
}

/**
 * Every read below takes an optional `signal`.
 *
 * These are the calls the planning desk repeats as the operator works — a different branch, a
 * different date, a wider radius — and each one supersedes the last. React Query hands its own
 * `signal` to the query function, so passing it through is what makes "click branch A, then
 * immediately branch B" actually abort A's recommendation request instead of letting it arrive
 * second and repaint the panel with the wrong candidates. Optional so the handful of imperative
 * callers that are not queries keep working unchanged.
 */
export const getProjects = (signal?: AbortSignal) =>
  api.request<ProjectOption[]>('/projects', { method: 'GET', signal });

/**
 * Zones, optionally narrowed to one client's.
 *
 * Zones are per-client (`zones.client_id`) and the branch import creates a set for each client, so
 * an unfiltered list shows "East Zone, East Zone, North Zone, South Zone, South Zone…" — the same
 * names repeated with different ids and nothing on screen to tell them apart. In a view already
 * scoped to one project, only that project's client's zones can match anything; picking one of the
 * others silently returns nothing.
 */
export const getZones = (clientId?: string, signal?: AbortSignal) =>
  api.request<ZoneOption[]>(`/zones?limit=100${clientId ? `&clientId=${encodeURIComponent(clientId)}` : ''}`, { signal });

/**
 * Branches for a project. Caller supplies its own ProjectBranch type.
 *
 * `scopeQuery` comes from `useScope().scopeParams` via `withScope` — the coverage queue is
 * narrowed by the header's region/zone/state the same way every other operations list is.
 */
export const getProjectBranches = <T = unknown>(projectId: string, scopeQuery = '', signal?: AbortSignal) =>
  api.request<T[]>(`/projects/${projectId}/branches${scopeQuery ? `?${scopeQuery}` : ''}`, { signal });

export const getPricingRates = (projectId: string, signal?: AbortSignal) =>
  api.request<TravelRates>(`/pricing/rates?projectId=${encodeURIComponent(projectId)}`, { signal });

// ── Day plans ───────────────────────────────────────────────────────────────────
export interface DayPlanQuery {
  targetDate: string;
  projectIds: string[];
  minDistanceKm?: number;
}

/** Multi-branch day plan. Caller supplies its own ProjectDayPlan type. */
export const getDayPlans = <T = unknown>(query: DayPlanQuery) => {
  const params = new URLSearchParams({
    targetDate: query.targetDate,
    projectIds: query.projectIds.join(','),
  });
  if (query.minDistanceKm != null) params.set('minDistanceKm', String(query.minDistanceKm));
  return api.request<T>(`/planning/day-plans?${params}`);
};

// ── Recommendations ──────────────────────────────────────────────────────────────
/**
 * Smart default audit date for a branch: first workable day from tomorrow, skipping
 * Sundays, state holidays and non-working Saturdays (same rule assignment creation
 * enforces). `skipped` explains any days that were passed over.
 */
export const suggestAuditDate = (branchId: string, signal?: AbortSignal) =>
  api.request<{ date: string; skipped: Array<{ date: string; reason: string }> }>(
    `/planning/suggest-date?branchId=${encodeURIComponent(branchId)}`,
    { method: 'GET', signal },
  );

/**
 * Turns the raw `skipped[]` reasons into one sentence an office operator can read.
 *
 * The server's reasons are written for the rule engine — "Holiday Conflict: Target date is a
 * holiday in KA.", "Sunday", "Double Booking: …". Those strings were never meant for a screen;
 * showing them verbatim is how a desk ends up asking what a "conflict" is. They are matched
 * loosely on purpose: the wording of a rule message changes over time, and a suggestion that
 * silently stops explaining itself is worse than one that says "not a working day".
 *
 * Returns null when nothing was skipped — the suggestion is simply tomorrow and needs no excuse.
 */
export const describeSuggestedDate = (
  suggested: string,
  skipped: Array<{ date: string; reason: string }> = [],
): string | null => {
  const day = (key: string) => {
    // The keys are plain YYYY-MM-DD calendar dates. Parsed as-is, a browser west of UTC reads
    // them as midnight UTC and prints the day before — the one thing this note must never do.
    const [y, m, d] = key.split('-').map(Number);
    if (!y || !m || !d) return key;
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };
  const plain = (reason: string) => {
    const r = (reason || '').toLowerCase();
    if (r.includes('sunday')) return 'is a Sunday';
    if (r.includes('holiday')) return 'is a holiday';
    if (r.includes('leave')) return 'the assayer is on leave';
    if (r.includes('book')) return 'the assayer is already booked';
    if (r.includes('timeline') || r.includes('project')) return 'is outside the project dates';
    return 'is not a working day';
  };
  const suggestedDay = day(suggested);
  if (skipped.length === 0) return `${suggestedDay} is the earliest date this audit can be worked.`;
  // Only the first few, and only from the front: a long holiday run would otherwise produce a
  // paragraph nobody reads, and the days nearest today are the ones the operator is wondering about.
  const shown = skipped.slice(0, 3).map((s) => `${day(s.date)} ${plain(s.reason)}`);
  const more = skipped.length > shown.length ? `, and ${skipped.length - shown.length} more` : '';
  return `Earliest free date — ${shown.join(', ')}${more}.`;
};

/**
 * Candidate recommendations for a branch. Response carries `data` + `meta.excluded`.
 * `date` (YYYY-MM-DD) is the audit date availability/fees are evaluated against —
 * omitted, the backend assumes today, which is rarely the day being planned.
 */
export const getRecommendations = <TCandidate = unknown, TExcluded = unknown>(
  branchId: string,
  date?: string,
  /**
   * Rank the whole nearby workforce, treating a booking or a leave on `date` as advisory
   * instead of disqualifying. Such candidates come back with `dateConflict` set, so the clash
   * is shown on the row rather than hidden.
   */
  includeUnavailable?: boolean,
  /**
   * How far from the branch to search, in km — the operator's radius control.
   *
   * Omitted, the engine uses its own default search area. That default is invisible in the UI,
   * so an operator who widened the map's radius saw assayers the engine had already discarded:
   * pins on the map, nothing in the list, and no way to reach them.
   */
  radiusKm?: number,
  signal?: AbortSignal,
) =>
  api.request<{ data: TCandidate[]; meta?: { excluded?: TExcluded[] } }>(
    `/planning/recommendations?branchId=${encodeURIComponent(branchId)}${date ? `&date=${encodeURIComponent(date)}` : ''}${includeUnavailable ? '&includeUnavailable=true' : ''}${radiusKm ? `&radiusKm=${Math.round(radiusKm)}` : ''}`,
    // withMeta so the caller receives `meta.excluded` (filtered-out candidates + reasons),
    // not just the unwrapped data array.
    { method: 'GET', withMeta: true, signal },
  );

// ── Route optimisation (read-only compute) ───────────────────────────────────────
export interface RouteOptimizePayload {
  origin: { latitude: number; longitude: number };
  destinations: Array<{ id: string; latitude: number; longitude: number }>;
  roundTrip?: boolean;
  mode?: string;
}

export interface RouteOptimizeResult {
  optimizedSequence: string[];
  totalDistanceKm: number;
  totalDurationMinutes: number;
}

export const optimizeRoute = (payload: RouteOptimizePayload) =>
  api.request<RouteOptimizeResult>('/geo/route/optimize', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

// ── Pricing quote ────────────────────────────────────────────────────────────────
export interface PricingQuotePayload {
  assayerId: string;
  clientId?: string | null;
  distanceKm?: number;
  branchCount?: number;
  branchId?: string;
}

/** Fee breakdown. Caller supplies its own FeeQuote type. */
export const getPricingQuote = <T = unknown>(payload: PricingQuotePayload) =>
  api.request<T>('/pricing/quote', { method: 'POST', body: JSON.stringify(payload) });

// ── Mutations (assignments, coverage, call logs) ─────────────────────────────────
// Kept flexible: the component sends several body shapes to /assignments across its flows.
export const createAssignment = (body: Record<string, unknown>) =>
  api.request('/assignments', { method: 'POST', body: JSON.stringify(body) });

export const transitionAssignment = (assignmentId: string, body: Record<string, unknown>) =>
  api.request(`/assignments/${assignmentId}/transition`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const markBranchUnableToCover = (projectBranchId: string, body: Record<string, unknown>) =>
  api.request(`/projects/branches/${projectBranchId}/unable-to-cover`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const reopenBranchCoverage = (projectBranchId: string) =>
  api.request(`/projects/branches/${projectBranchId}/reopen-coverage`, { method: 'POST' });

export const createCallLog = (body: Record<string, unknown>) =>
  api.request('/call-logs', { method: 'POST', body: JSON.stringify(body) });

// ── Coverage-plan lifecycle (generate → approve → deploy the whole project) ──────────────────
// These backend capabilities existed but had no UI; the workspace could only assign one branch or
// one cluster at a time. See PlanningWorkspace's Coverage Plan panel.

/** A coverage-plan version record (the persisted plan, not the computed cluster preview). */
export interface CoveragePlan {
  id: string;
  projectId: string;
  status: 'GENERATED' | 'DRAFT' | 'APPROVED' | 'LOCKED' | 'DEPLOYED' | string;
  currentVersion: number;
}

export interface CoveragePlanExecuteResult {
  message: string;
  deployedCount: number;
  skippedCount: number;
  /** Each branch carries the workable date it was actually booked for — no longer one shared date. */
  deployed: Array<{ branchId: string; assignmentId: string; scheduledDate?: string }>;
  skipped: Array<{ clusterId: string; branchId: string | null; reason: string }>;
  /** Skip reasons collapsed to reason → count, so 155 identical failures read as one line. */
  skippedReasons?: Array<{ reason: string; count: number }>;
  /** True when the deploy produced nothing: an explained outcome now, not a thrown error. */
  fullySkipped?: boolean;
  /** First and last date booked, when anything deployed. */
  dateRange?: { start: string; end: string } | null;
}

/** Computed cluster/capacity preview for a project (does not persist a version). */
export const getCoveragePlanPreview = <T = unknown>(projectId: string) =>
  api.request<T>(`/planning/projects/${projectId}/coverage-plan`);

/** Create or regenerate a plan version (returns the persisted plan with its id + status). */
export const createCoveragePlan = (projectId: string, body: { justification?: string } = {}) =>
  api.request<CoveragePlan>(`/planning/projects/${projectId}/coverage-plan`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

/** Move a plan through its lifecycle, e.g. DRAFT/GENERATED → APPROVED. */
export const transitionCoveragePlan = (planId: string, status: string) =>
  api.request<CoveragePlan>(`/planning/coverage-plans/${planId}/transition`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });

/** Deploy an approved plan — spawns assignments across the whole project. */
export const executeCoveragePlan = (planId: string, scheduledDate?: string) =>
  api.request<CoveragePlanExecuteResult>(`/planning/coverage-plans/${planId}/execute`, {
    method: 'POST',
    body: JSON.stringify({ scheduledDate }),
  });

/** What-if simulation: run the optimizer with weight/radius overrides without persisting. */
export const simulateScenario = <T = unknown>(body: {
  projectId: string;
  weightOverrides?: Record<string, number>;
  defaultRadiusOverride?: number;
}) => api.request<T>('/planning/scenarios/simulate', { method: 'POST', body: JSON.stringify(body) });

/** Candidates for ALL unassigned branches of a project, in one call (queue-level triage). */
export const getProjectCandidates = <T = unknown>(projectId: string) =>
  api.request<T>(`/planning/projects/${projectId}/candidates`);
