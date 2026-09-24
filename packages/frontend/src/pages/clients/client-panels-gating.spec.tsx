import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ContactsPanel } from './ContactsPanel';
import { ContractsPanel } from './ContractsPanel';
import { BillingPanel } from './BillingPanel';
import { ConfigurationPanel } from './ConfigurationPanel';

/**
 * The client tabs' write controls, held to the audiences `client.controller.ts` actually serves:
 *
 *  - add a contact / contract, save configuration (`POST …/contacts`, `POST …/contracts`,
 *    `PUT /clients/:id`): ADMIN, OPERATIONS
 *  - remove a contact / contract (`DELETE …`): ADMIN
 *  - save billing, which calls `PUT /clients/:id` AND `PUT /clients/:id/billing` (ADMIN only):
 *    ADMIN — gated as one action so OPERATIONS cannot half-apply it
 *
 * None of these routes carries a permission fallback, so a custom role gets none of them.
 * DEVELOPER passes through the role hierarchy exactly as RolesGuard lets it.
 */

let mockRoles: string[] = [];
jest.mock('../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../hooks/useCurrentRoles'),
  useCurrentRoles: () => mockRoles,
}));

const updateClientAsync = jest.fn().mockResolvedValue({});
const updateBillingAsync = jest.fn().mockResolvedValue({});
/*
  Every hook answers the SAME object on every render. A factory that built a fresh `{ data: … }`
  each call handed the panels' "reset the form from the server" effects a new dependency on every
  render — an endless render loop that hung the suite rather than failing it.
*/
const mockHooks = {
  contacts: { data: [{ id: 'ct-1', name: 'Anita Rao', email: 'a@x.in', phone: '+919000000000', designation: 'RM' }], isLoading: false },
  contracts: { data: [{ id: 'k-1', title: 'Gold audit 2026', contractNumber: 'C-1', status: 'ACTIVE', effectiveFrom: '2026-01-01' }], isLoading: false },
  mutation: { mutateAsync: jest.fn(), isPending: false },
  billing: { data: null, isLoading: false, isSuccess: true, status: 'success' },
  detail: {
    data: { id: 'cli-1', configuration: { defaultBaseFee: 3000 }, planningPreferences: {} },
    isLoading: false, isPending: false, isSuccess: true, status: 'success',
  },
  updateClient: { mutateAsync: (...a: unknown[]) => updateClientAsync(...a), isPending: false },
  updateBilling: { mutateAsync: (...a: unknown[]) => updateBillingAsync(...a), isPending: false },
  vocabulary: { skills: [], certifications: [] },
};
jest.mock('../../hooks/useClients', () => ({
  useClientContacts: () => mockHooks.contacts,
  useClientContracts: () => mockHooks.contracts,
  useAddContact: () => mockHooks.mutation,
  useDeleteContact: () => mockHooks.mutation,
  useAddContract: () => mockHooks.mutation,
  useDeleteContract: () => mockHooks.mutation,
  useClientBilling: () => mockHooks.billing,
  useClientDetail: () => mockHooks.detail,
  useUpdateClient: () => mockHooks.updateClient,
  useUpdateBilling: () => mockHooks.updateBilling,
}));
jest.mock('../../hooks/useWorkforceVocabulary', () => ({
  useWorkforceVocabulary: () => mockHooks.vocabulary,
  asOptions: () => [],
}));
jest.mock('./AssayerMultiSelect', () => ({ AssayerMultiSelect: () => null }));
jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));

beforeEach(() => {
  updateClientAsync.mockClear();
  updateBillingAsync.mockClear();
});

describe('Contacts and Contracts', () => {
  it.each([['ADMIN'], ['DEVELOPER']])('%s can add and remove', (role) => {
    mockRoles = [role];
    const { unmount } = render(<ContactsPanel clientId="cli-1" />);
    expect(screen.getByRole('button', { name: /add/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove contact' })).toBeInTheDocument();
    unmount();
    render(<ContractsPanel clientId="cli-1" />);
    expect(screen.getByRole('button', { name: /add/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove contract' })).toBeInTheDocument();
  });

  it('OPERATIONS can add but not remove', () => {
    mockRoles = ['OPERATIONS'];
    const { unmount } = render(<ContactsPanel clientId="cli-1" />);
    expect(screen.getByRole('button', { name: /add/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove contact' })).not.toBeInTheDocument();
    unmount();
    render(<ContractsPanel clientId="cli-1" />);
    expect(screen.getByRole('button', { name: /add/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove contract' })).not.toBeInTheDocument();
  });

  it.each([['AUDITOR'], ['DESK'], ['Client Desk (custom)']])('%s reads only', (role) => {
    mockRoles = [role];
    const { unmount } = render(<ContactsPanel clientId="cli-1" />);
    expect(screen.getByText('Anita Rao')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove contact' })).not.toBeInTheDocument();
    unmount();
    render(<ContractsPanel clientId="cli-1" />);
    expect(screen.queryByRole('button', { name: /add/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove contract' })).not.toBeInTheDocument();
  });
});

describe('Billing — one Save across two routes', () => {
  it('ADMIN saves both halves', async () => {
    mockRoles = ['ADMIN'];
    render(<BillingPanel clientId="cli-1" />);
    fireEvent.click(screen.getByRole('button', { name: /save billing/i }));
    await waitFor(() => expect(updateBillingAsync).toHaveBeenCalled());
    expect(updateClientAsync).toHaveBeenCalled();
  });

  it('OPERATIONS gets a read-only panel and cannot write the rate card half', () => {
    mockRoles = ['OPERATIONS'];
    const { container } = render(<BillingPanel clientId="cli-1" />);
    expect(screen.queryByRole('button', { name: /save billing/i })).not.toBeInTheDocument();
    expect(screen.getByText(/only an administrator changes/i)).toBeInTheDocument();
    // Enter in a field must not submit either: the whole form is disabled, and the handler refuses.
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    expect(updateClientAsync).not.toHaveBeenCalled();
    expect(updateBillingAsync).not.toHaveBeenCalled();
    expect((container.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
  });
});

describe('Configuration', () => {
  it.each([['ADMIN'], ['OPERATIONS']])('%s can save', async (role) => {
    mockRoles = [role];
    render(<ConfigurationPanel clientId="cli-1" />);
    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));
    await waitFor(() => expect(updateClientAsync).toHaveBeenCalled());
  });

  it.each([['AUDITOR'], ['Client Desk (custom)']])('%s reads only', (role) => {
    mockRoles = [role];
    const { container } = render(<ConfigurationPanel clientId="cli-1" />);
    expect(screen.queryByRole('button', { name: /save configuration/i })).not.toBeInTheDocument();
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    expect(updateClientAsync).not.toHaveBeenCalled();
  });
});
