import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { EditClientModal } from './EditClientModal';
import { useUpdateClient } from '../../hooks/useClients';
import { api } from '../../services/api';
import { ClientType, ClientLifecycleStatus, GSTIN_OR_PAN_REFUSAL } from '@fapoms/shared';
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
 * change shape just because they opened Edit and clicked Save), and a Tax ID matching neither a
 * GSTIN nor a PAN must be refused HERE, where it can be corrected, rather than accepted by the
 * form and thrown back by the API.
 *
 * That second one used to read "warn, never block", and the test below asserted it: the operator
 * was shown a grey "double-check before saving" and the save went through to a server carrying
 * `IsGstinOrPanFormat`, which refused it. The rule was never the form's to make — it belongs to
 * the API — so the form now reads the same `isGstinOrPan` from `@fapoms/shared` and says the same
 * sentence the server would have.
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
    /**
     * The envelope, because that is what the endpoint sends.
     *
     * `GET /geo/autocomplete` answers `{ success, data, meta.configured }`, and `Autocomplete`
     * asks for it with `withMeta: true` so it can tell "no such place" apart from "this
     * deployment has no place lookup". A bare array here modelled a shape the API never
     * returns, so the mock passed while the real call would have found `data` undefined.
     */
    mockRequest.mockImplementation((url: string) =>
      String(url).startsWith('/geo/autocomplete')
        ? Promise.resolve({ success: true, data: [place], meta: { configured: true } })
        : Promise.resolve([]));
    render(<EditClientModal client={baseClient} onClose={jest.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Type a pincode — the rest fills in'), { target: { value: '411038' } });
    fireEvent.click(await screen.findByText('Kothrud, Pune', undefined, { timeout: 2000 }));

    expect((screen.getByPlaceholderText('Type to search city…') as HTMLInputElement).value).toBe('Kothrud');
    expect((screen.getByPlaceholderText('Type to search district…') as HTMLInputElement).value).toBe('Pune');
  });

  it('refuses a Tax ID matching neither a GSTIN nor a PAN, instead of letting the API do it', async () => {
    render(<EditClientModal client={baseClient} onClose={jest.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('e.g., GSTIN / PAN'), { target: { value: 'not-a-real-number' } });
    expect(screen.getByText(/doesn't look like a gstin or a pan/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mutateAsync).not.toHaveBeenCalled());
  });

  it('says the same thing the API would, rather than a softer version of it', () => {
    render(<EditClientModal client={baseClient} onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('e.g., GSTIN / PAN'), { target: { value: 'zzz' } });
    expect(screen.getByText(GSTIN_OR_PAN_REFUSAL)).toBeInTheDocument();
  });

  it('clears without complaint — the field is optional and must stay clearable', () => {
    render(<EditClientModal client={{ ...baseClient, taxId: '27AAPFU0939F1ZV' }} onClose={jest.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('e.g., GSTIN / PAN'), { target: { value: '' } });
    expect(screen.queryByText(/doesn't look like a gstin/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled();
  });

  it('shows no hint for a real GSTIN', () => {
    render(<EditClientModal client={{ ...baseClient, taxId: '27AAPFU0939F1ZV' }} onClose={jest.fn()} />);
    expect(screen.queryByText(/doesn't look like a gstin/i)).not.toBeInTheDocument();
  });
});
