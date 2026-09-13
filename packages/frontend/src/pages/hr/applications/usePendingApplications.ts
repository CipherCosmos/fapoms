import { useQuery } from '@tanstack/react-query';
import { ApplicationStatus } from '@fapoms/shared';

import { api } from '../../../services/api';
import { queryKeys } from '../../../hooks/queryKeys';

/**
 * How many candidates are waiting on a decision, for the section's tab badge.
 *
 * The same query key the Applications page uses for the same status, so the badge and the list
 * share one response rather than disagreeing about the number — the rule `HrLayout` already
 * follows for the review queue.
 *
 * `null` while the answer is unknown (loading, or refused to a role that cannot read the queue),
 * never `0`: a tab must not show "0" for a question it has not asked.
 */
export function usePendingApplicationCount(): number | null {
  const query = useQuery({
    queryKey: queryKeys.hr.applications(ApplicationStatus.PENDING_VALIDATION),
    queryFn: () => api.request<unknown[]>(
      `/hr/applications?status=${ApplicationStatus.PENDING_VALIDATION}`,
    ),
    staleTime: 30_000,
  });

  if (query.isPending || query.isError || !Array.isArray(query.data)) return null;
  return query.data.length;
}
