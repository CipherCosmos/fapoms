import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../services/api';
import { queryKeys } from '../../hooks/queryKeys';

/**
 * The review queue, read once for everything that shows it.
 *
 * Two screens need this list and they need it to agree: the panel that lists the findings, and
 * the "Review queue" tab badge that says how many are outstanding. Fetching it twice would mean
 * a badge reading 431 above a panel listing 283 with nothing on screen to explain the gap —
 * which is the same defect the panel's own "showing X of Y" header exists to prevent.
 *
 * `openCount` is the server's full count; `rows` is the capped page it sent (500 today). They
 * are deliberately kept as two separate numbers rather than reconciled here, because they mean
 * different things and every consumer has to be able to tell them apart.
 */

export interface ImportIssue {
  id: string;
  sourceSheet: string;
  sourceRow: number;
  sourceColumn: string;
  rawValue: string;
  reason: string;
  sourceAssayerCode: string | null;
  assayer?: { id?: string; assayerCode?: string; firstName?: string; lastName?: string } | null;
}

export interface ImportIssuesPayload {
  rows: ImportIssue[];
  openCount: number;
}

const EMPTY: ImportIssuesPayload = { rows: [], openCount: 0 };

export function useImportIssues() {
  const query = useQuery({
    queryKey: queryKeys.hr.importIssues,
    queryFn: () => api.request<ImportIssuesPayload>('/assayers/roster/import-issues'),
    /*
       A viewer without the roles this route requires gets a 403, and that is not an error worth
       putting on screen: the panel simply does not render for them. Retrying it three times
       would be three 403s per page load.
    */
    retry: false,
    staleTime: 60_000,
  });

  return {
    rows: query.data?.rows ?? EMPTY.rows,
    openCount: query.data?.openCount ?? 0,
    /** True until the first response lands, so a caller can tell "none" from "not yet known". */
    loading: query.isLoading,
    failed: query.isError,
    refetch: query.refetch,
  };
}

/** Re-read the queue after something has been closed in it. */
export function useRefreshImportIssues(): () => void {
  const queryClient = useQueryClient();
  return () => { void queryClient.invalidateQueries({ queryKey: queryKeys.hr.importIssues }); };
}
