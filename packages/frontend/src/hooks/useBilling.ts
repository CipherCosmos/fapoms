import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';
import { billingApi } from '../services/billing';
import type {
  PageParams, PayPayoutsPayload, CreateInvoicePayload, InvoicePaymentPayload, ClientLinePatch,
} from '../services/billing';
import type { InvoiceStatus, AssayerPayableStatus } from '@fapoms/shared';

/**
 * Mount control for the list queries. The billing workspace shows one tab at a time; every
 * billing socket event invalidates `queryKeys.billing.all`, and React Query refetches only
 * *active* queries, so a gated-off tab costs nothing per event.
 */
export interface BillingQueryOptions {
  enabled?: boolean;
}

// ---- Queries --------------------------------------------------------------

export function useBillingOverview(options: BillingQueryOptions = {}) {
  return useQuery({
    queryKey: queryKeys.billing.overview(),
    queryFn: () => billingApi.getOverview(),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}

export function usePayouts(
  params: { assayerId?: string; clientId?: string; status?: AssayerPayableStatus; onHold?: boolean } & PageParams = {},
  options: BillingQueryOptions = {},
) {
  return useQuery({
    queryKey: queryKeys.billing.payouts(params),
    queryFn: () => billingApi.listPayouts(params),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}

export function useInvoiceable(clientId?: string, options: BillingQueryOptions = {}) {
  return useQuery({
    queryKey: queryKeys.billing.invoiceable(clientId),
    queryFn: () => billingApi.listInvoiceable(clientId),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}

export function useBillingInvoices(
  params: { clientId?: string; projectId?: string; status?: InvoiceStatus } & PageParams = {},
  options: BillingQueryOptions = {},
) {
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

export function useAssignmentMoney(assignmentId: string | null, options: BillingQueryOptions = {}) {
  return useQuery({
    queryKey: queryKeys.billing.assignmentMoney(assignmentId ?? ''),
    queryFn: () => billingApi.getAssignmentMoney(assignmentId!),
    enabled: !!assignmentId && (options.enabled ?? true),
    staleTime: 30_000,
  });
}

export function useReconcilePreview(since: string | undefined, options: BillingQueryOptions = {}) {
  return useQuery({
    queryKey: queryKeys.billing.reconcilePreview(since),
    queryFn: () => billingApi.reconcilePreview(since),
    enabled: options.enabled ?? true,
    staleTime: 10_000,
  });
}

// ---- Mutations ------------------------------------------------------------

/** Every write changes the book; the overview, the lists and the line all re-read. */
function useBillingMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.billing.all }),
  });
}

export function useApprovePayouts() {
  return useBillingMutation((payableIds: string[]) => billingApi.approvePayouts(payableIds));
}

export function usePayPayouts() {
  return useBillingMutation((payload: PayPayoutsPayload) => billingApi.payPayouts(payload));
}

export function useHoldPayout() {
  return useBillingMutation(({ id, onHold, reason }: { id: string; onHold: boolean; reason?: string }) =>
    billingApi.holdPayout(id, onHold, reason));
}

export function useCreateBillingInvoice() {
  return useBillingMutation((payload: CreateInvoicePayload) => billingApi.createInvoice(payload));
}

export function useSendInvoice() {
  return useBillingMutation((id: string) => billingApi.sendInvoice(id));
}

export function useRecordBillingPayment() {
  return useBillingMutation((payload: InvoicePaymentPayload) => billingApi.recordInvoicePayment(payload));
}

export function useCancelInvoice() {
  return useBillingMutation(({ id, reason }: { id: string; reason: string }) => billingApi.cancelInvoice(id, reason));
}

export function useReversePayment() {
  return useBillingMutation(({ paymentId, reason }: { paymentId: string; reason: string }) => billingApi.reversePayment(paymentId, reason));
}

export function useEditClientLine() {
  return useBillingMutation(({ assignmentId, patch }: { assignmentId: string; patch: ClientLinePatch }) =>
    billingApi.editClientLine(assignmentId, patch));
}

export function useReconcile() {
  return useBillingMutation((since?: string) => billingApi.reconcile(since));
}
