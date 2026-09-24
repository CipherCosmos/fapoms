import { api } from './api';
import { waitForQueuedJob, type EnqueuedJob } from './queued-job';

/**
 * How a screen follows a planning job it started.
 *
 * `onProgress` receives the server's stage label ("Creating offers (37/166)"); `signal` lets a screen
 * that closed stop polling. The job itself carries on either way — it runs on the server.
 */
export interface PlanningJobWatch {
  onProgress?: (progress: { percent: number; stage: string }) => void;
  signal?: { cancelled: boolean };
  /** Told when the request joined a run of the same thing already going (a second press). */
  onJoined?: () => void;
  pollMs?: number;
}

/** Read jobs (coverage preview, day plans) and write jobs (deploy, bulk) are numbered separately. */
const READ_JOB_STATUS = (jobId: string) => `/planning/jobs/${encodeURIComponent(jobId)}`;
const WRITE_JOB_STATUS = (jobId: string) => `/planning/write-jobs/${encodeURIComponent(jobId)}`;

/**
 * POST a job route, then wait on the job.
 *
 * The planning routes this replaces did their work inside the request. The largest — deploying a
 * whole plan, a bulk offer over hundreds of branches — ran past the client's 30 s budget, so the
 * screen said "failed" while the server kept going, and the operator pressed again. The job routes
 * answer at once with an id, and the result arrives through the poll.
 */
async function runPlanningJob<TResult>(
  path: string,
  statusPath: (jobId: string) => string,
  body: unknown,
  watch: PlanningJobWatch = {},
): Promise<TResult> {
  const { jobId, deduplicated } = await api.request<EnqueuedJob>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (deduplicated) watch.onJoined?.();
  return waitForQueuedJob<TResult>(statusPath(jobId), {
    onProgress: watch.onProgress,
    signal: watch.signal,
    pollMs: watch.pollMs,
  });
}

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
// `limit=200` is the server's ceiling (ParseLimitPipe); without it `/projects` answers 50, and a
// tenant with more projects than that simply could not pick the rest from the planning screen.
export const getProjects = (signal?: AbortSignal) =>
  api.request<ProjectOption[]>('/projects?limit=200', { method: 'GET', signal });

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

/**
 * Multi-branch day plan. Caller supplies its own ProjectDayPlan type.
 *
 * Through the queued twin (`POST /planning/day-plans/jobs`), not `GET /planning/day-plans`: the plan
 * runs clustering plus the recommendation engine per branch per cluster, which inside a request
 * holds the browser, the proxy and database connections for its whole length. Same parameters, same
 * answer.
 */
export const getDayPlans = <T = unknown>(query: DayPlanQuery, watch?: PlanningJobWatch) => {
  const params = new URLSearchParams({
    targetDate: query.targetDate,
    projectIds: query.projectIds.join(','),
  });
  if (query.minDistanceKm != null) params.set('minDistanceKm', String(query.minDistanceKm));
  return runPlanningJob<T>(`/planning/day-plans/jobs?${params}`, READ_JOB_STATUS, undefined, watch);
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
  /**
   * Rank people the client has not empanelled, rather than excluding them.
   *
   * They come back carrying `clientStandingIssue`, so the standing is stated on the row rather
   * than hidden, and assigning one still needs a recorded reason on the write path. This changes
   * what an operator can SEE, not what they may do unrecorded.
   */
  ignoreClientPolicy?: boolean,
  /**
   * Search the whole workforce instead of a disc around the branch.
   *
   * Turns off the distance PRE-FILTER — the one distance rule that drops somebody without
   * producing a reason. The client's conflict-of-interest minimum is untouched.
   */
  ignoreDistancePolicy?: boolean,
) =>
  api.request<{ data: TCandidate[]; meta?: { excluded?: TExcluded[] } }>(
    `/planning/recommendations?branchId=${encodeURIComponent(branchId)}${date ? `&date=${encodeURIComponent(date)}` : ''}${includeUnavailable ? '&includeUnavailable=true' : ''}${radiusKm ? `&radiusKm=${Math.round(radiusKm)}` : ''}${ignoreClientPolicy ? '&ignoreClientPolicy=true' : ''}${ignoreDistancePolicy ? '&ignoreDistancePolicy=true' : ''}`,
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

/**
 * The optimize body with every coordinate a real number.
 *
 * Branch and assayer coordinates are Postgres `decimal` columns, which arrive in JSON as strings
 * ("12.9716"). The route endpoint validates numbers, so a string refused the whole request.
 * Coerced here, once, for every caller; a destination whose coordinates are not numbers at all is
 * dropped rather than sent.
 */
export function buildRouteOptimizePayload(payload: {
  origin: { latitude: number | string; longitude: number | string };
  destinations: Array<{ id: string; latitude: number | string; longitude: number | string }>;
  roundTrip?: boolean;
  mode?: string;
}): RouteOptimizePayload {
  return {
    ...payload,
    origin: { latitude: Number(payload.origin.latitude), longitude: Number(payload.origin.longitude) },
    destinations: payload.destinations
      .map((d) => ({ id: d.id, latitude: Number(d.latitude), longitude: Number(d.longitude) }))
      .filter((d) => Number.isFinite(d.latitude) && Number.isFinite(d.longitude)),
  };
}

export const optimizeRoute = (payload: Parameters<typeof buildRouteOptimizePayload>[0]) =>
  api.request<RouteOptimizeResult>('/geo/route/optimize', {
    method: 'POST',
    body: JSON.stringify(buildRouteOptimizePayload(payload)),
  });

// ── Coverage mutations ───────────────────────────────────────────────────────────
//
// `getPricingQuote`, `createAssignment`, `transitionAssignment` and `createCallLog` used to sit
// here and had no callers. The live paths build those requests themselves, and `getPricingQuote`
// had drifted further than unused: its `branchId` field is not on the backend's `QuoteRequestDto`,
// so `forbidNonWhitelisted` would have rejected the call had anyone made it.
export const markBranchUnableToCover = (projectBranchId: string, body: Record<string, unknown>) =>
  api.request(`/projects/branches/${projectBranchId}/unable-to-cover`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

/** One branch's outcome in a bulk run. Every branch the run was given is in exactly one list. */
export interface BulkBranchResult {
  succeeded: Array<{ projectBranchId: string; assignmentId?: string; status?: string }>;
  failed: Array<{ projectBranchId: string; error: string }>;
}

/**
 * "Offer all to …" over a selection — one request, run on the server, polled.
 *
 * This used to be one `POST /assignments` per ticked branch from the browser, five at a time: up to
 * 500 requests against a 300-a-minute per-user limit, each refused one reported as a name only.
 */
export const offerBranchesInBulk = (
  body: {
    projectBranchIds: string[];
    assayerId: string;
    assayerName?: string;
    scheduledDate?: string;
    acceptOnBehalf?: boolean;
    acceptanceReason?: string;
  },
  watch?: PlanningJobWatch,
) => runPlanningJob<BulkBranchResult>('/planning/bulk-offers/jobs', WRITE_JOB_STATUS, body, watch);

/**
 * "Mark unable to cover" over a selection — one request, run on the server, polled.
 *
 * Replaces an unbounded `Promise.all` of one POST per ticked branch, which past the rate limit was
 * refused in part, with each refusal reported as a bare branch name.
 */
export const markBranchesUnableToCover = (
  projectBranchIds: string[],
  reason: string,
  watch?: PlanningJobWatch,
) => runPlanningJob<BulkBranchResult>('/planning/unable-to-cover/jobs', WRITE_JOB_STATUS, { projectBranchIds, reason }, watch);

export const reopenBranchCoverage = (projectBranchId: string) =>
  api.request(`/projects/branches/${projectBranchId}/reopen-coverage`, { method: 'POST' });

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
  /** How many of `deployed` an earlier, interrupted run of this plan had already booked. */
  alreadyDeployedCount?: number;
}

/**
 * Computed cluster/capacity preview for a project (does not persist a version).
 *
 * Through the queued twin (`POST …/coverage-plan/jobs`): the preview runs the recommendation engine
 * once per branch, which the synchronous GET did inside the request.
 */
export const getCoveragePlanPreview = <T = unknown>(projectId: string, watch?: PlanningJobWatch) =>
  runPlanningJob<T>(`/planning/projects/${projectId}/coverage-plan/jobs`, READ_JOB_STATUS, undefined, watch);

/**
 * Create or regenerate a plan version (resolves with the persisted plan, its id and status).
 *
 * On the write queue: generating a version runs the same whole-project engine as the preview, then
 * writes the version.
 */
export const createCoveragePlan = (projectId: string, body: { justification?: string } = {}, watch?: PlanningJobWatch) =>
  runPlanningJob<CoveragePlan>(`/planning/projects/${projectId}/coverage-plan/versions/jobs`, WRITE_JOB_STATUS, body, watch);

/** Move a plan through its lifecycle, e.g. DRAFT/GENERATED → APPROVED. */
export const transitionCoveragePlan = (planId: string, status: string) =>
  api.request<CoveragePlan>(`/planning/coverage-plans/${planId}/transition`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });

/**
 * Deploy an approved plan — spawns assignments across the whole project.
 *
 * The route accepts (202 `{ jobId }`) and the deploy runs on the server; this resolves with the
 * deploy's result once the job is done. A second press while it runs joins the same deploy.
 */
export const executeCoveragePlan = (planId: string, scheduledDate?: string, watch?: PlanningJobWatch) =>
  runPlanningJob<CoveragePlanExecuteResult>(`/planning/coverage-plans/${planId}/execute`, WRITE_JOB_STATUS, { scheduledDate }, watch);

/** What-if simulation: run the optimizer with weight/radius overrides without persisting. */
export const simulateScenario = <T = unknown>(body: {
  projectId: string;
  weightOverrides?: Record<string, number>;
  defaultRadiusOverride?: number;
}) => api.request<T>('/planning/scenarios/simulate', { method: 'POST', body: JSON.stringify(body) });

/** Candidates for ALL unassigned branches of a project, in one call (queue-level triage). */
export const getProjectCandidates = <T = unknown>(projectId: string) =>
  api.request<T>(`/planning/projects/${projectId}/candidates`);
