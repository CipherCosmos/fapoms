import { api } from './api';
import type {
  Client,
  ClientContact,
  ClientContract,
  ClientBilling,
  ClientLifecycleStatus,
} from '@fapoms/shared';

export interface PaginatedMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface ClientListParams {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  clientType?: string;
  priority?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface ClientListResult {
  items: Client[];
  meta: PaginatedMeta;
}

export interface ClientDetail extends Omit<Client, 'billing'> {
  contacts?: ClientContact[];
  contracts?: ClientContract[];
  billing?: ClientBilling | null;
}

export interface ClientConfigurationPayload {
  importMapping?: Record<string, string>;
  workingDays?: number[];
  defaultRadius?: number;
  slaRules?: Record<string, unknown>;
  serviceLevel?: string;
  maxResponseTimeHours?: number;
  penaltyRate?: number;
  serviceHours?: Record<string, unknown>;
  // Client rate card — what the client is billed, distinct from the assayer's own profile.
  defaultBaseFee?: number;
  travelFeePerKm?: number;
  freeTravelAllowanceKm?: number;
}

export interface CreateClientPayload {
  clientCode: string;
  name: string;
  displayName: string;
  website?: string;
  industry?: string;
  clientType?: string;
  registrationNumber?: string;
  taxId?: string;
  contactPerson?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  priority?: string;
  budget?: number;
  preferredAssayers?: string[];
  restrictedAssayers?: string[];
  planningPreferences?: Record<string, unknown>;
  configuration?: ClientConfigurationPayload;
}

export interface CreateContactPayload {
  name: string;
  email: string;
  phone: string;
  designation: string;
  department?: string;
  isPrimary?: boolean;
  notes?: string;
}

export interface CreateContractPayload {
  contractNumber: string;
  title: string;
  description?: string;
  signedDate?: string;
  effectiveFrom: string;
  effectiveTo?: string;
  value?: number;
  currency?: string;
  terms?: Record<string, unknown>;
  documentUrl?: string;
}

export interface UpdateBillingPayload {
  paymentTerms?: string;
  currency?: string;
  taxIdentifier?: string;
  invoiceCycle?: string;
  billingAddress?: string;
  bankAccount?: string;
  bankName?: string;
  ifscCode?: string;
  notes?: string;
  gstRate?: number;
  tdsRate?: number;
}

async function listClients(params: ClientListParams = {}): Promise<ClientListResult> {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.limit) q.set('limit', String(params.limit));
  if (params.search) q.set('search', params.search);
  if (params.status) q.set('status', params.status);
  if (params.clientType) q.set('clientType', params.clientType);
  if (params.priority) q.set('priority', params.priority);
  if (params.sortBy) q.set('sortBy', params.sortBy);
  if (params.sortOrder) q.set('sortOrder', params.sortOrder.toUpperCase());

  const res = await api.request<{ data: Client[]; meta: { pagination: PaginatedMeta } }>(
    `/clients?${q.toString()}`,
    { withMeta: true },
  );
  return {
    items: res.data || [],
    meta: res.meta?.pagination || { page: params.page ?? 1, limit: params.limit ?? 20, total: 0, totalPages: 0, hasNext: false, hasPrevious: false },
  };
}

async function getClient(id: string): Promise<ClientDetail> {
  return api.request<ClientDetail>(`/clients/${id}`);
}

async function createClient(payload: CreateClientPayload): Promise<Client> {
  return api.request<Client>('/clients', { method: 'POST', body: JSON.stringify(payload) });
}

async function updateClient(id: string, payload: Partial<CreateClientPayload>): Promise<Client> {
  return api.request<Client>(`/clients/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
}

async function transitionLifecycle(id: string, status: ClientLifecycleStatus, reason?: string): Promise<Client> {
  return api.request<Client>(`/clients/${id}/lifecycle`, {
    method: 'PATCH',
    body: JSON.stringify({ status, reason }),
  });
}

async function getContacts(clientId: string): Promise<ClientContact[]> {
  return api.request<ClientContact[]>(`/clients/${clientId}/contacts`);
}

async function addContact(clientId: string, payload: CreateContactPayload): Promise<ClientContact> {
  return api.request<ClientContact>(`/clients/${clientId}/contacts`, { method: 'POST', body: JSON.stringify(payload) });
}

async function deleteContact(clientId: string, contactId: string): Promise<void> {
  await api.request(`/clients/${clientId}/contacts/${contactId}`, { method: 'DELETE' });
}

async function getContracts(clientId: string): Promise<ClientContract[]> {
  return api.request<ClientContract[]>(`/clients/${clientId}/contracts`);
}

async function addContract(clientId: string, payload: CreateContractPayload): Promise<ClientContract> {
  return api.request<ClientContract>(`/clients/${clientId}/contracts`, { method: 'POST', body: JSON.stringify(payload) });
}

async function deleteContract(clientId: string, contractId: string): Promise<void> {
  await api.request(`/clients/${clientId}/contracts/${contractId}`, { method: 'DELETE' });
}

async function getBilling(clientId: string): Promise<ClientBilling | null> {
  return api.request<ClientBilling | null>(`/clients/${clientId}/billing`);
}

async function updateBilling(clientId: string, payload: UpdateBillingPayload): Promise<ClientBilling> {
  return api.request<ClientBilling>(`/clients/${clientId}/billing`, { method: 'PUT', body: JSON.stringify(payload) });
}

export const clientApi = {
  list: listClients,
  get: getClient,
  create: createClient,
  update: updateClient,
  transitionLifecycle,
  getContacts,
  addContact,
  deleteContact,
  getContracts,
  addContract,
  deleteContract,
  getBilling,
  updateBilling,
};
