export const queryKeys = {
  dashboard: {
    all: ['dashboard'] as const,
    metrics: ['dashboard', 'metrics'] as const,
    slaSummary: ['dashboard', 'slaSummary'] as const,
  },
  assignments: {
    all: ['assignments'] as const,
    list: (page: number, filter?: string) => ['assignments', 'list', page, filter ?? 'ALL'] as const,
    /**
     * The whole KPI row of the assignments desk, from one server aggregate.
     *
     * It used to be seven separate `?page=1&limit=1` queries whose only purpose was to read
     * `meta.pagination.total` back off the paginated list endpoint — seven round trips, seven
     * full COUNT(*)s over the assignment book, all under the `['assignments']` prefix, so every
     * socket flush refetched all seven on top of the list itself.
     */
    summary: ['assignments', 'summary'] as const,
    needsAttention: ['assignments', 'needs-attention'] as const,
    fieldIssues: ['assignments', 'field-issues'] as const,
    detail: (id: string) => ['assignments', 'detail', id] as const,
    timeline: (id: string) => ['assignments', 'timeline', id] as const,
  },
  /**
   * Screens that answer "what needs a decision right now", keyed outside `assignments` because
   * they are their own endpoints.
   *
   * Registered here, and wired into `useSocketInvalidation`, because being absent from both is
   * what made them stale: the Operations Inbox is the negotiation queue — open counter-offers,
   * declines needing a replacement, offers gone quiet — and its literal `['operations-inbox']`
   * key matched no entry in the socket map. An assayer countering on their phone therefore took
   * up to the 60-second poll to appear on the desk, on every round of a negotiation, while the
   * event that would have shown it instantly was already arriving on the socket.
   *
   * Anything added here must also be added to the socket map, or it inherits the same problem.
   */
  desk: {
    /** The Operations Inbox queue (scoped per region/zone selection). */
    inbox: ['operations-inbox'] as const,
    /** The "Falling behind" board — overdue/breached assignments, ranked. Scoped per selection. */
    fallingBehind: ['falling-behind'] as const,
    /** Candidate suggestions rendered inside an inbox card. */
    inboxRecommendations: ['inbox-recommendations'] as const,
    /** Detail panel for an assignment not present in the loaded list page. */
    assignmentDetail: ['assignment-detail'] as const,
    /** Field-issue queue, keyed by scope. */
    assignmentFieldIssues: ['assignment-field-issues'] as const,
    /** Per-branch coverage history shown in the planning drawer. */
    branchHistory: ['branch-history'] as const,
  },
  schedules: {
    all: ['schedules'] as const,
    list: ['schedules', 'list'] as const,
  },
  projects: {
    all: ['projects'] as const,
    list: ['projects', 'list'] as const,
  },
  scope: {
    all: ['scope'] as const,
    options: ['scope', 'options'] as const,
  },
  branches: {
    all: ['branches'] as const,
    // `scopeKey` comes from `useScope()`. It must be part of the key: the branch list is
    // paginated server-side, so a scope change is a different query, not a re-slice.
    list: (scopeKey: string, page: number) => ['branches', 'list', scopeKey, page] as const,
  },
  plans: {
    all: ['plans'] as const,
  },
  /**
   * The planning desk's own server reads.
   *
   * These were plain `useState` + `fetch` inside `PlanningWorkspace`, refreshed by the page's own
   * `socket.on(...)` handlers. That arrangement was the single largest source of request
   * amplification in the app: two separate subscriptions (eight events between them) each called a
   * loader directly, undebounced and unabortable, and two `useEffect`s depended on the `branches`
   * ARRAY, so every reload re-triggered the recommendation engine and the date suggestion, whose
   * results were themselves deps of the first effect. One `assignment:status-changed` cost roughly
   * six requests per open desk; a 500-branch bulk import cost thousands, and nothing was cancelled,
   * so a late response could repaint the panel with candidates for a branch the operator had
   * already moved on from.
   *
   * Keyed here instead, they are refreshed by `useSocketInvalidation` like every other screen: one
   * coalesced invalidation per burst, React Query dedupes concurrent fetches, and its `signal`
   * cancels the stale one. The two prefix keys below are what the socket map targets — matching on
   * `['planning', 'branches']` refreshes the coverage queue for every project/scope pair in cache
   * without also discarding the reference data (zones, rates, projects) that no assignment event
   * can invalidate.
   */
  planning: {
    all: ['planning'] as const,
    /** Prefix: the coverage queue, for any project and any scope. */
    queue: ['planning', 'branches'] as const,
    /** The coverage queue for one project, narrowed by the header's region/zone scope. */
    branches: (projectId: string, scopeKey: string) =>
      ['planning', 'branches', projectId, scopeKey] as const,
    /** Prefix: candidate recommendations, for any branch and any set of engine parameters. */
    recommendationsAll: ['planning', 'recommendations'] as const,
    /**
     * Recommendations are evaluated FOR a date, a search radius and an availability rule — change
     * any of them and the engine returns a different answer, so all three belong in the key rather
     * than in a re-slice of whatever the last request happened to return.
     */
    recommendations: (branchId: string, date: string, includeUnavailable: boolean, radiusKm: number) =>
      ['planning', 'recommendations', branchId, date, includeUnavailable, Math.round(radiusKm)] as const,
    /** Prefix: "have we already phoned this person about this branch?", for any branch. */
    lastContactAll: ['planning', 'last-contact'] as const,
    lastContact: (projectBranchId: string) => ['planning', 'last-contact', projectBranchId] as const,
    /** First workable audit date for a branch — reference data, not affected by assignment events. */
    suggestedDate: (branchId: string) => ['planning', 'suggested-date', branchId] as const,
    projects: ['planning', 'projects'] as const,
    zones: (clientId?: string) => ['planning', 'zones', clientId ?? 'ALL'] as const,
    pricingRates: (projectId: string) => ['planning', 'pricing-rates', projectId] as const,
  },
  /**
   * The assayer roster the maps draw pins from.
   *
   * Owned by a key rather than by the map component's own `useEffect` because both maps mount and
   * unmount constantly — the planning workspace has five layouts, each with its own map element,
   * so switching layout used to re-download the entire roster. One key means one fetch shared by
   * every map on the screen and across layout switches.
   */
  assayers: {
    all: ['assayers'] as const,
    mapRoster: ['assayers', 'map-roster'] as const,
  },
  /**
   * The workforce roster. `useHrWorkforce.ts` and `AssayerRoster.tsx` used to each type the
   * literal `['hr', 'workforce']` by hand — they agreed only because two people typed the same
   * four characters, not because either referenced a shared constant.
   */
  hr: {
    all: ['hr'] as const,
    workforce: ['hr', 'workforce'] as const,
  },
  documents: {
    all: ['documents'] as const,
    byBranch: (branchId: string) => ['documents', 'branch', branchId] as const,
    byProject: (projectId: string) => ['documents', 'project', projectId] as const,
    stats: ['documents', 'stats'] as const,
    dataEntry: ['documents', 'data-entry'] as const,
  },
  clients: {
    all: ['clients'] as const,
    list: (params: object) => ['clients', 'list', params] as const,
    detail: (id: string) => ['clients', 'detail', id] as const,
    contacts: (id: string) => ['clients', 'contacts', id] as const,
    /** The unfiltered picker list — one key so five screens share one cache entry. */
    options: ['clients', 'options'] as const,
    contracts: (id: string) => ['clients', 'contracts', id] as const,
    billing: (id: string) => ['clients', 'billing', id] as const,
  },
  billing: {
    all: ['billing'] as const,
    overview: () => ['billing', 'overview'] as const,
    payouts: (params: object) => ['billing', 'payouts', params] as const,
    invoiceable: (clientId?: string) => ['billing', 'invoiceable', clientId ?? 'ALL'] as const,
    invoices: (params: object) => ['billing', 'invoices', params] as const,
    invoice: (id: string) => ['billing', 'invoice', id] as const,
    assayerStatement: (assayerId: string) => ['billing', 'assayerStatement', assayerId] as const,
    assignmentMoney: (assignmentId: string) => ['billing', 'assignmentMoney', assignmentId] as const,
    reconcilePreview: (since?: string) => ['billing', 'reconcilePreview', since ?? 'ALL'] as const,
  },
};
