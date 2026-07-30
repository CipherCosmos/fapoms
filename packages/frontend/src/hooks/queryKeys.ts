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
    detail: (id: string) => ['assignments', 'detail', id] as const,
    timeline: (id: string) => ['assignments', 'timeline', id] as const,
  },
  schedules: {
    all: ['schedules'] as const,
    list: ['schedules', 'list'] as const,
  },
  projects: {
    all: ['projects'] as const,
    list: ['projects', 'list'] as const,
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
};
