import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../hooks/queryKeys';

/**
 * Surgical query invalidation helpers.
 *
 * Adheres strictly to the TanStack cache freshness model:
 * - Mutations invalidate only exact dependent queries rather than executing broad application-wide purges.
 * - Stale authoritative data is evicted immediately so background refetch retrieves server truth.
 * - Frozen historical records (e.g. approved payables with locked destinations) are NEVER invalidated or mutated.
 */

/**
 * Surgical invalidation following an assayer lifecycle transition.
 *
 * Invalidates:
 * - Roster data (`hr.rosterAll`, `hr.workforce`)
 * - Assayer dossier / profile (`assayer-record`, `assayers.all`)
 * - Deployment readiness indicators
 * - Active assignments for this assayer when lifecycle transition impacts dispatch eligibility
 */
export async function invalidateLifecycleMutation(
  queryClient: QueryClient,
  assayerId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.hr.rosterAll }),
    queryClient.invalidateQueries({ queryKey: queryKeys.hr.workforce }),
    queryClient.invalidateQueries({ queryKey: ['assayer-record', assayerId] }),
    queryClient.invalidateQueries({ queryKey: ['assayer-profile', assayerId] }),
    queryClient.invalidateQueries({ queryKey: ['assayer-assignments', assayerId] }),
    queryClient.invalidateQueries({ queryKey: ['hr', 'deployment'] }),
    queryClient.invalidateQueries({ queryKey: ['hr', 'readiness', assayerId] }),
  ]);
}

/**
 * Surgical invalidation following a KYC document verification or upload.
 *
 * Invalidates:
 * - Exact document and version queries
 * - Assayer dossier KYC summary
 * - Compliance review queue (`hr.importIssues`)
 * - Deployment readiness for the assayer
 */
export async function invalidateKycMutation(
  queryClient: QueryClient,
  assayerId: string,
  docId?: string,
): Promise<void> {
  const promises: Promise<unknown>[] = [
    queryClient.invalidateQueries({ queryKey: ['assayer-record', assayerId] }),
    queryClient.invalidateQueries({ queryKey: ['assayer-documents', assayerId] }),
    queryClient.invalidateQueries({ queryKey: queryKeys.hr.importIssues }),
    queryClient.invalidateQueries({ queryKey: ['hr', 'readiness', assayerId] }),
  ];

  if (docId) {
    promises.push(queryClient.invalidateQueries({ queryKey: ['assayer-document', docId] }));
  }

  await Promise.all(promises);
}

/**
 * Surgical invalidation following a bank profile update.
 *
 * Invalidates:
 * - Current bank profile
 * - Payout readiness indicators
 * - Commercial / pay-rate roster
 *
 * Invariant:
 * - Does NOT invalidate or mutate frozen historical payable destinations (`billing.all` or approved payouts).
 */
export async function invalidateBankMutation(
  queryClient: QueryClient,
  assayerId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['assayer-bank', assayerId] }),
    queryClient.invalidateQueries({ queryKey: ['assayer-record', assayerId] }),
    queryClient.invalidateQueries({ queryKey: ['hr', 'pay-readiness', assayerId] }),
    queryClient.invalidateQueries({ queryKey: queryKeys.hr.commercialRoster }),
  ]);
}

/**
 * Surgical invalidation following an assignment status change or dispatch.
 *
 * Invalidates:
 * - Assignment queue list
 * - Assayer current work card (`assayer-assignments`)
 * - Relevant inbox & attention counters (`assignments.summary`, `desk.inbox`)
 */
export async function invalidateAssignmentMutation(
  queryClient: QueryClient,
  assayerId?: string,
  assignmentId?: string,
): Promise<void> {
  const promises: Promise<unknown>[] = [
    queryClient.invalidateQueries({ queryKey: queryKeys.assignments.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.assignments.summary }),
    queryClient.invalidateQueries({ queryKey: queryKeys.desk.inbox }),
  ];

  if (assayerId) {
    promises.push(queryClient.invalidateQueries({ queryKey: ['assayer-assignments', assayerId] }));
  }

  if (assignmentId) {
    promises.push(queryClient.invalidateQueries({ queryKey: queryKeys.assignments.timeline(assignmentId) }));
    promises.push(queryClient.invalidateQueries({ queryKey: ['assignment-detail', assignmentId] }));
  }

  await Promise.all(promises);
}
