import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';
import { billingApi } from '../services/billing';
import type {
  CreateEntryPayload,
  CreateInvoicePayload,
  RecordPaymentPayload,
  CreatePayablePayload,
  RaiseConflictPayload,
} from '../services/billing';
import type { BillingLevel, BillingState, InvoiceStatus, AssayerPayableStatus, BillingConflictStatus, BillingConflictAction, BillingEntityType } from '@fapoms/shared';

// ---- Queries --------------------------------------------------------------

export function useBillingEntries(params: {
  clientId?: string; projectId?: string; assignmentId?: string; assayerId?: string;
  level?: BillingLevel; state?: BillingState;
} = {}) {
  return useQuery({
    queryKey: queryKeys.billing.entries(params),
    queryFn: () => billingApi.listEntries(params),
    staleTime: 30_000,
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

export function useBillingInvoices(params: { clientId?: string; projectId?: string; status?: InvoiceStatus } = {}) {
  return useQuery({
    queryKey: queryKeys.billing.invoices(params),
    queryFn: () => billingApi.listInvoices(params),
    staleTime: 30_000,
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

export function useBillingPayables(params: { assayerId?: string; clientId?: string; status?: AssayerPayableStatus } = {}) {
  return useQuery({
    queryKey: queryKeys.billing.payables(params),
    queryFn: () => billingApi.listPayables(params),
    staleTime: 30_000,
  });
}

export function useBillingConflicts(status?: BillingConflictStatus) {
  return useQuery({
    queryKey: queryKeys.billing.conflicts(status),
    queryFn: () => billingApi.listConflicts(status),
    staleTime: 30_000,
  });
}

export function useBillingHistory(params: { clientId?: string; projectId?: string; assignmentId?: string; assayerId?: string; entityType?: BillingEntityType } = {}) {
  return useQuery({
    queryKey: queryKeys.billing.history(params),
    queryFn: () => billingApi.getHistory(params),
    staleTime: 30_000,
  });
}

export function useBillingDashboard(clientId?: string) {
  return useQuery({
    queryKey: queryKeys.billing.dashboard(clientId),
    queryFn: () => billingApi.getDashboard(clientId),
    staleTime: 30_000,
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
