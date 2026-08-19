import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';
import { clientApi } from '../services/clients';
import { api } from '../services/api';
import type { ClientListParams } from '../services/clients';
import type { ClientLifecycleStatus } from '@fapoms/shared';

export function useClientsList(params: ClientListParams) {
  return useQuery({
    queryKey: queryKeys.clients.list(params),
    queryFn: () => clientApi.list(params),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}
export function useClientDetail(id: string | null) {
  return useQuery({
    queryKey: queryKeys.clients.detail(id ?? ''),
    queryFn: () => clientApi.get(id!),
    enabled: !!id,
    staleTime: 60_000,
  });
}

export function useClientContacts(clientId: string | null) {
  return useQuery({
    queryKey: queryKeys.clients.contacts(clientId ?? ''),
    queryFn: () => clientApi.getContacts(clientId!),
    enabled: !!clientId,
    staleTime: 60_000,
  });
}

export function useClientContracts(clientId: string | null) {
  return useQuery({
    queryKey: queryKeys.clients.contracts(clientId ?? ''),
    queryFn: () => clientApi.getContracts(clientId!),
    enabled: !!clientId,
    staleTime: 60_000,
  });
}

export function useClientBilling(clientId: string | null) {
  return useQuery({
    queryKey: queryKeys.clients.billing(clientId ?? ''),
    queryFn: () => clientApi.getBilling(clientId!),
    enabled: !!clientId,
    staleTime: 60_000,
  });
}

export function useCreateClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: clientApi.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.clients.all }),
  });
}

export function useUpdateClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Parameters<typeof clientApi.update>[1] }) =>
      clientApi.update(id, payload),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.clients.all });
      qc.invalidateQueries({ queryKey: queryKeys.clients.detail(vars.id) });
    },
  });
}

export function useTransitionLifecycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: ClientLifecycleStatus; reason?: string }) =>
      clientApi.transitionLifecycle(id, status, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.clients.all }),
  });
}

export function useAddContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, payload }: { clientId: string; payload: Parameters<typeof clientApi.addContact>[1] }) =>
      clientApi.addContact(clientId, payload),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.clients.contacts(vars.clientId) });
      qc.invalidateQueries({ queryKey: queryKeys.clients.detail(vars.clientId) });
    },
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, contactId }: { clientId: string; contactId: string }) =>
      clientApi.deleteContact(clientId, contactId),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.clients.contacts(vars.clientId) });
      qc.invalidateQueries({ queryKey: queryKeys.clients.detail(vars.clientId) });
    },
  });
}

export function useAddContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, payload }: { clientId: string; payload: Parameters<typeof clientApi.addContract>[1] }) =>
      clientApi.addContract(clientId, payload),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.clients.contracts(vars.clientId) });
      qc.invalidateQueries({ queryKey: queryKeys.clients.detail(vars.clientId) });
    },
  });
}

export function useDeleteContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, contractId }: { clientId: string; contractId: string }) =>
      clientApi.deleteContract(clientId, contractId),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.clients.contracts(vars.clientId) });
      qc.invalidateQueries({ queryKey: queryKeys.clients.detail(vars.clientId) });
    },
  });
}

export function useUpdateBilling() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, payload }: { clientId: string; payload: Parameters<typeof clientApi.updateBilling>[1] }) =>
      clientApi.updateBilling(clientId, payload),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.clients.billing(vars.clientId) });
      qc.invalidateQueries({ queryKey: queryKeys.clients.detail(vars.clientId) });
    },
  });
}

/**
 * Every client, for a picker.
 *
 * Five screens each fetched this independently — Projects, Rules, Zones, Holidays and Branches
 * — with three different local `ClientOption` types between them, two of which disagreed on
 * whether the short code is called `code` or `clientCode`. Same list, five requests, five
 * caches, and a shape that changed depending on which screen you were looking at.
 *
 * One hook, one query key, one type. React Query then serves all five from a single fetch.
 */
export interface ClientOption {
  id: string;
  name: string;
  /** The short code. Both spellings are carried because the API has used both. */
  code?: string;
  clientCode?: string;
}

export function useClientOptions() {
  return useQuery({
    queryKey: queryKeys.clients.options,
    queryFn: () => api.request<ClientOption[]>('/clients'),
    // A picker list changes when someone onboards a client — rare, and a stale entry costs an
    // extra scroll, not a wrong answer.
    staleTime: 5 * 60_000,
  });
}
