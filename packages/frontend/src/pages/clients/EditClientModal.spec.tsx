import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { EditClientModal } from './EditClientModal';
import { useUpdateClient } from '../../hooks/useClients';
import { api } from '../../services/api';
import { ClientType, ClientLifecycleStatus } from '@fapoms/shared';
import type { Client } from '@fapoms/shared';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../hooks/useClients', () => ({ useUpdateClient: jest.fn() }));
jest.mock('../../components/ui', () => ({
  ...jest.requireActual('../../components/ui'),
  useToast: () => ({ toast: jest.fn() }),
}));

const mockRequest = api.request as jest.Mock;
const mockUseUpdateClient = useUpdateClient as jest.Mock;

/**
 * `EditClientModal`'s Address used to be one free-text textarea and Tax ID a plain box with no
 * format check. These pin the two properties the task cares about: an existing address the new
 * autocomplete does not recognise must round-trip byte-for-byte (nobody's saved address should
 * change shape just because they opened Edit and clicked Save), and an odd-looking Tax ID must
 * warn, never block.
 */

const baseClient: Client = {
  id: 'cli-1',
  clientCode: 'CL-001',
  name: 'ACME Bank',
  displayName: 'ACME HQ',
  clientType: ClientType.BANK,
  lifecycleStatus: ClientLifecycleStatus.ACTIVE,
  priority: 'MEDIUM',
  address: 'C/o Sharma & Sons, near the old bus stand',
  taxId: '',
  createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedBy: 'u1', updatedAt: '2026-01-01T00:00:00Z', version: 1, isActive: true,
};

describe('EditClientModal', () => {
  let mutateAsync: jest.Mock;

  beforeEach(() => {
    mockRequest.mockReset();
    mutateAsync = jest.fn().mockResolvedValue({});
    mockUseUpdateClient.mockReturnValue({ mutateAsync, isPending: false });
  });

  it('shows the existing free-text address verbatim and round-trips it untouched on save', async () => {
    render(<EditClientModal client={baseClient} onClose={jest.fn()} />);

    expect(screen.getByDisplayValue(baseClient.address!)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0].payload.address).toBe(baseClient.address);
  });

  it('picking a pincode result fills city and district for a client that never had them', async () => {
    const place = { label: 'Kothrud, Pune', type: 'city', state: 'MAHARASHTRA', district: 'Pune', pincode: '411038' };
    mockRequest.mockResolvedValue([place]);
    render(<EditClientModal client={baseClient} onClose={jest.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Type a pincode — the rest fills in'), { target: { value: '411038' } });
    fireEvent.click(await screen.findByText('Kothrud, Pune', undefined, { timeout: 2000 }));

    expect((screen.getByPlaceholderText('Type to search city…') as HTMLInputElement).value).toBe('Kothrud');
    expect((screen.getByPlaceholderText('Type to search district…') as HTMLInputElement).value).toBe('Pune');
  });

  it('warns on a Tax ID matching neither a GSTIN nor a PAN, but still saves it', async () => {
    render(<EditClientModal client={baseClient} onClose={jest.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('e.g., GSTIN / PAN'), { target: { value: 'not-a-real-number' } });
    expect(screen.getByText(/doesn't look like a gstin/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0].payload.taxId).toBe('not-a-real-number');
  });

  it('shows no hint for a real GSTIN', () => {
    render(<EditClientModal client={{ ...baseClient, taxId: '27AAPFU0939F1ZV' }} onClose={jest.fn()} />);
    expect(screen.queryByText(/doesn't look like a gstin/i)).not.toBeInTheDocument();
  });
});
