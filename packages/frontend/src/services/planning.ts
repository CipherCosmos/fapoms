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
}

export interface TravelRates {
  travelFeePerKm: number;
  freeTravelAllowanceKm: number;
}

export const getProjects = () => api.request<ProjectOption[]>('/projects', { method: 'GET' });

export const getZones = () => api.request<ZoneOption[]>('/zones?limit=100');

/** Branches for a project. Caller supplies its own ProjectBranch type. */
export const getProjectBranches = <T = unknown>(projectId: string) =>
  api.request<T[]>(`/projects/${projectId}/branches`);

export const getPricingRates = (projectId: string) =>
  api.request<TravelRates>(`/pricing/rates?projectId=${encodeURIComponent(projectId)}`);

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
export const suggestAuditDate = (branchId: string) =>
  api.request<{ date: string; skipped: Array<{ date: string; reason: string }> }>(
    `/planning/suggest-date?branchId=${encodeURIComponent(branchId)}`,
    { method: 'GET' },
  );

/**
 * Candidate recommendations for a branch. Response carries `data` + `meta.excluded`.
 * `date` (YYYY-MM-DD) is the audit date availability/fees are evaluated against —
 * omitted, the backend assumes today, which is rarely the day being planned.
 */
export const getRecommendations = <TCandidate = unknown, TExcluded = unknown>(branchId: string, date?: string) =>
  api.request<{ data: TCandidate[]; meta?: { excluded?: TExcluded[] } }>(
    `/planning/recommendations?branchId=${encodeURIComponent(branchId)}${date ? `&date=${encodeURIComponent(date)}` : ''}`,
    // withMeta so the caller receives `meta.excluded` (filtered-out candidates + reasons),
    // not just the unwrapped data array.
    { method: 'GET', withMeta: true },
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
  deployed: Array<{ branchId: string; assignmentId: string }>;
  skipped: Array<{ clusterId: string; branchId: string | null; reason: string }>;
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
