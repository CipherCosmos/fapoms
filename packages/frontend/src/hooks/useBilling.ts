import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';
import { billingApi } from '../services/billing';
import type {
  CreateEntryPayload,
  CreateInvoicePayload,
  RecordPaymentPayload,
  CreatePayablePayload,
  RaiseConflictPayload,
  PageParams,
} from '../services/billing';
import type { BillingLevel, BillingState, InvoiceStatus, AssayerPayableStatus, BillingConflictStatus, BillingConflictAction, BillingEntityType } from '@fapoms/shared';

// ---- Queries --------------------------------------------------------------

/**
 * Mount control for the list queries.
 *
 * The billing workspace shows one tab at a time but used to mount every list hook regardless, so
 * an operator reading the invoices table still held live queries over entries, payables,
 * conflicts and history. Because every billing socket event invalidates `queryKeys.billing.all`,
 * one `billing:entry-created` refetched the entire book — five unpaginated whole-table GETs — for
 * a screen showing none of it. `enabled` is what stops that and not merely on first mount: React
 * Query only counts a query as *active* while some observer has `enabled !== false`, and
 * invalidation refetches active queries only. A gated-off tab therefore costs nothing per event.
 *
 * Defaults to true so every drawer, modal and picker calling these hooks with no options behaves
 * exactly as before.
 */
export interface BillingQueryOptions {
  enabled?: boolean;
}

// `page`/`limit` are accepted below but deliberately never defaulted. `PayableDetailDrawer` and
// `ConflictDetailDrawer` resolve the record they were opened for with `data.find(r => r.id === id)`
// over the whole list; quietly capping every caller at one page would make them report "Not found"
// for any record past row 50, which reads as data loss over a payment. A window is therefore
// something a screen opts into for a table it can actually page, and every other caller keeps
// asking for the whole set exactly as it does today.

export function useBillingEntries(params: {
  clientId?: string; projectId?: string; assignmentId?: string; assayerId?: string;
  level?: BillingLevel; state?: BillingState;
} & PageParams = {}, options: BillingQueryOptions = {}) {
  return useQuery({
    // `params` is already part of the key, so page N and page N+1 are separate cache entries with
    // no help needed here — and `entries({})`-style invalidation still matches all of them,
    // because React Query's partial key match only requires the filter's own fields to line up.
    queryKey: queryKeys.billing.entries(params),
    queryFn: () => billingApi.listEntries(params),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}

export function useBillingEntry(id: string | null) {
  return useQuery({
    queryKey: queryKeys.billing.entry(id ?? ''),
    queryFn: () => billingApi.getEntry(id!),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useBillingInvoices(params: { clientId?: string; projectId?: string; status?: InvoiceStatus } & PageParams = {}, options: BillingQueryOptions = {}) {
  return useQuery({
    queryKey: queryKeys.billing.invoices(params),
    queryFn: () => billingApi.listInvoices(params),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}

export function useBillingInvoice(id: string | null) {
  return useQuery({
    queryKey: queryKeys.billing.invoice(id ?? ''),
    queryFn: () => billingApi.getInvoice(id!),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useBillingPayables(params: { assayerId?: string; clientId?: string; status?: AssayerPayableStatus } & PageParams = {}, options: BillingQueryOptions = {}) {
  return useQuery({
    queryKey: queryKeys.billing.payables(params),
    queryFn: () => billingApi.listPayables(params),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}

/**
 * `limit` here caps the response; it cannot page it.
 *
 * `queryKeys.billing.conflicts` keys on the status filter alone, so page 2 would be cached over
 * page 1 under one key and a pager would show the same rows forever. Giving conflicts a real
 * window means widening that key to take the params object, the way entries/invoices/payables/
 * history already do — a change to the shared key module, out of scope here. Until then a caller
 * that passes `limit` must tell the operator what is being held back; `data.total` says how many
 * there really are.
 */
export function useBillingConflicts(status?: BillingConflictStatus, options: BillingQueryOptions & Pick<PageParams, 'limit'> = {}) {
  const params = options.limit ? { limit: options.limit } : {};
  return useQuery({
    queryKey: queryKeys.billing.conflicts(status),
    queryFn: () => billingApi.listConflicts(status, params),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}

export function useBillingHistory(params: { clientId?: string; projectId?: string; assignmentId?: string; assayerId?: string; entityType?: BillingEntityType } & PageParams = {}, options: BillingQueryOptions = {}) {
  return useQuery({
    queryKey: queryKeys.billing.history(params),
    queryFn: () => billingApi.getHistory(params),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}

export function useBillingDashboard(clientId?: string, options: BillingQueryOptions = {}) {
  return useQuery({
    queryKey: queryKeys.billing.dashboard(clientId),
    queryFn: () => billingApi.getDashboard(clientId),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}

/** The finance team's consolidated position across receivables and payables. */
export function useFinanceDashboard() {
  return useQuery({
    queryKey: queryKeys.billing.financeDashboard(),
    queryFn: () => billingApi.getFinanceDashboard(),
    staleTime: 30_000,
  });
}

/** Full financial record for any client, project, branch, assayer or assignment. */
export function useEntityLedger(
  entityType: import('../services/billing').EntityLedger['entityType'] | null,
  entityId: string | null,
) {
  return useQuery({
    queryKey: queryKeys.billing.entityLedger(entityType ?? '', entityId ?? ''),
    queryFn: () => billingApi.getEntityLedger(entityType!, entityId!),
    enabled: !!entityType && !!entityId,
    staleTime: 30_000,
  });
}

export function useAssayerStatement(assayerId: string | null) {
  return useQuery({
    queryKey: queryKeys.billing.assayerStatement(assayerId ?? ''),
    queryFn: () => billingApi.getAssayerStatement(assayerId!),
    enabled: !!assayerId,
    staleTime: 30_000,
  });
}

/** Clients that have billing activity — drives the workspace's client scope. */
export function useBillingClients() {
  return useQuery({
    queryKey: queryKeys.billing.clients(),
    queryFn: () => billingApi.listBillingClients(),
    staleTime: 60_000,
  });
}

export function useClientBillingReport(clientId: string | null) {
  return useQuery({
    queryKey: queryKeys.billing.clientReport(clientId ?? ''),
    queryFn: () => billingApi.getClientReport(clientId!),
    enabled: !!clientId,
    staleTime: 30_000,
  });
}

// ---- Mutations ------------------------------------------------------------

const invalidate = (qc: ReturnType<typeof useQueryClient>, keys: Readonly<readonly unknown[]>[]) => {
  for (const k of keys) qc.invalidateQueries({ queryKey: [...k] });
};

export function useCreateBillingEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateEntryPayload) => billingApi.createEntry(payload),
    onSuccess: (_d, v) => {
      invalidate(qc, [queryKeys.billing.entries({}), queryKeys.billing.all, queryKeys.billing.entries({ clientId: v.clientId })]);
    },
  });
}

export function useTransitionBillingEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: BillingState; reason?: string }) =>
      billingApi.transitionEntry(id, status, reason),
    onSuccess: () => invalidate(qc, [queryKeys.billing.all, queryKeys.billing.dashboard(undefined)]),
  });
}

export function useAdjustBillingEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, delta, reason }: { id: string; delta: number; reason: string }) =>
      billingApi.adjustEntry(id, delta, reason),
    onSuccess: () => invalidate(qc, [queryKeys.billing.all, queryKeys.billing.dashboard(undefined)]),
  });
}

export function useSplitBillingEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amounts, notes }: { id: string; amounts: number[]; notes?: string }) =>
      billingApi.splitEntry(id, amounts, notes),
    onSuccess: () => invalidate(qc, [queryKeys.billing.all, queryKeys.billing.dashboard(undefined)]),
  });
}

export function useMergeBillingEntries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ entryIds, note }: { entryIds: string[]; note?: string }) => billingApi.mergeEntries(entryIds, note),
    onSuccess: () => invalidate(qc, [queryKeys.billing.all, queryKeys.billing.dashboard(undefined)]),
  });
}

export function useCreateBillingInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateInvoicePayload) => billingApi.createInvoice(payload),
    onSuccess: (_d, v) => invalidate(qc, [
      queryKeys.billing.invoices({}),
      queryKeys.billing.entries({}),
      queryKeys.billing.dashboard(v.clientId),
      queryKeys.billing.clientReport(v.clientId),
      queryKeys.billing.all,
    ]),
  });
}

export function useTransitionBillingInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: InvoiceStatus; reason?: string }) =>
      billingApi.transitionInvoice(id, status, reason),
    onSuccess: () => invalidate(qc, [queryKeys.billing.invoices({}), queryKeys.billing.all, queryKeys.billing.dashboard(undefined)]),
  });
}

export function useRecordBillingPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: RecordPaymentPayload) => billingApi.recordPayment(payload),
    onSuccess: (_d, v) => invalidate(qc, [
      queryKeys.billing.invoices({}),
      queryKeys.billing.invoice(v.invoiceId),
      queryKeys.billing.entries({}),
      queryKeys.billing.dashboard(undefined),
      queryKeys.billing.all,
    ]),
  });
}

export function useCreatePayable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePayablePayload) => billingApi.createPayable(payload),
    onSuccess: () => invalidate(qc, [queryKeys.billing.payables({}), queryKeys.billing.dashboard(undefined), queryKeys.billing.all]),
  });
}

export function useTransitionPayable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: AssayerPayableStatus; reason?: string }) =>
      billingApi.transitionPayable(id, status, reason),
    onSuccess: () => invalidate(qc, [queryKeys.billing.payables({}), queryKeys.billing.dashboard(undefined), queryKeys.billing.all]),
  });
}

/** Pays money out against an approved payable. */
export function useDisbursePayable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ payableId, ...payload }: { payableId: string } & import('../services/billing').DisbursePayload) =>
      billingApi.disbursePayable(payableId, payload),
    onSuccess: () => invalidate(qc, [
      queryKeys.billing.payables({}),
      queryKeys.billing.financeDashboard(),
      queryKeys.billing.dashboard(undefined),
      queryKeys.billing.all,
    ]),
  });
}

export function useRaiseConflict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: RaiseConflictPayload) => billingApi.raiseConflict(payload),
    onSuccess: () => invalidate(qc, [queryKeys.billing.conflicts(undefined), queryKeys.billing.all]),
  });
}

export function useResolveConflict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, action, note }: { id: string; status: BillingConflictStatus; action: BillingConflictAction; note: string }) =>
      billingApi.resolveConflict(id, status, action, note),
    onSuccess: () => invalidate(qc, [queryKeys.billing.conflicts(undefined), queryKeys.billing.all]),
  });
}

export function useSyncFromAssignments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => billingApi.syncFromAssignments(),
    onSuccess: () => invalidate(qc, [
      queryKeys.billing.all,
      queryKeys.billing.entries({}),
      queryKeys.billing.dashboard(undefined),
      queryKeys.billing.history({}),
    ]),
  });
}
