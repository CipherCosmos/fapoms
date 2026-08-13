export const queryKeys = {
  dashboard: {
    all: ['dashboard'] as const,
    metrics: ['dashboard', 'metrics'] as const,
    slaSummary: ['dashboard', 'slaSummary'] as const,
  },
  assignments: {
    all: ['assignments'] as const,
    list: (page: number, filter?: string) => ['assignments', 'list', page, filter ?? 'ALL'] as const,
    count: (filter: string) => ['assignments', 'count', filter] as const,
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
    contracts: (id: string) => ['clients', 'contracts', id] as const,
    billing: (id: string) => ['clients', 'billing', id] as const,
    billingHistory: (id: string) => ['clients', 'billingHistory', id] as const,
  },
  billing: {
    all: ['billing'] as const,
    entries: (params: object) => ['billing', 'entries', params] as const,
    entry: (id: string) => ['billing', 'entry', id] as const,
    invoices: (params: object) => ['billing', 'invoices', params] as const,
    invoice: (id: string) => ['billing', 'invoice', id] as const,
    payables: (params: object) => ['billing', 'payables', params] as const,
    conflicts: (status?: string) => ['billing', 'conflicts', status ?? 'ALL'] as const,
    history: (params: object) => ['billing', 'history', params] as const,
    dashboard: (clientId?: string) => ['billing', 'dashboard', clientId ?? 'ALL'] as const,
    clientReport: (clientId: string) => ['billing', 'clientReport', clientId] as const,
    clients: () => ['billing', 'clients'] as const,
    financeDashboard: () => ['billing', 'financeDashboard'] as const,
    assayerStatement: (assayerId: string) => ['billing', 'assayerStatement', assayerId] as const,
    entityLedger: (t: string, id: string) => ['billing', 'entityLedger', t, id] as const,
  },
};
