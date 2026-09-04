import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CreateClientModal } from './CreateClientModal';
import { useCreateClient } from '../../hooks/useClients';
import { api } from '../../services/api';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../hooks/useClients', () => ({ useCreateClient: jest.fn() }));
jest.mock('../../components/ui', () => ({
  ...jest.requireActual('../../components/ui'),
  useToast: () => ({ toast: jest.fn() }),
}));

const mockRequest = api.request as jest.Mock;
const mockUseCreateClient = useCreateClient as jest.Mock;

/**
 * Clients had no address field at all before this: `CreateClientModal` posted `name`,
 * `displayName`, contact details and nothing else about where the client is. These tests pin
 * the two things that would silently regress: a picked place must actually cross-fill the rest
 * of the address, and a line typed with no autocomplete help must still be sent exactly as
 * typed — the backend only has one `address` text column, so composing must never invent or
 * drop text.
 */

const place = { label: 'Kothrud, Pune', type: 'city', state: 'MAHARASHTRA', district: 'Pune', pincode: '411038' };

describe('CreateClientModal', () => {
  let mutateAsync: jest.Mock;

  beforeEach(() => {
    mockRequest.mockReset();
    mutateAsync = jest.fn().mockResolvedValue({});
    mockUseCreateClient.mockReturnValue({ mutateAsync, isPending: false });
  });

  const fillRequired = () => {
    fireEvent.change(screen.getByPlaceholderText('e.g., State Bank of India'), { target: { value: 'ACME Bank' } });
    fireEvent.change(screen.getByPlaceholderText('e.g., SBI Corporate Office'), { target: { value: 'ACME HQ' } });
  };

  it('picking a pincode result fills city, district and state, and composes them into one address on save', async () => {
    mockRequest.mockResolvedValue([place]);
    render(<CreateClientModal onClose={jest.fn()} />);
    fillRequired();

    fireEvent.change(screen.getByPlaceholderText('Type a pincode — the rest fills in'), { target: { value: '411038' } });
    fireEvent.click(await screen.findByText('Kothrud, Pune', undefined, { timeout: 2000 }));

    expect((screen.getByPlaceholderText('Type to search city…') as HTMLInputElement).value).toBe('Kothrud');
    expect((screen.getByPlaceholderText('Type to search district…') as HTMLInputElement).value).toBe('Pune');

    fireEvent.click(screen.getByRole('button', { name: /create client/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0].address).toBe('Kothrud, Pune, Maharashtra - 411038');
  });

  it('sends a hand-typed address line untouched when no place is ever picked', async () => {
    render(<CreateClientModal onClose={jest.fn()} />);
    fillRequired();

    fireEvent.change(screen.getByPlaceholderText('Building, street, landmark'), {
      target: { value: 'Unit 4, unnamed lane behind the old mill' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create client/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0].address).toBe('Unit 4, unnamed lane behind the old mill');
  });

  it('keeps the submit button disabled until the required name fields are filled', () => {
    render(<CreateClientModal onClose={jest.fn()} />);
    expect(screen.getByRole('button', { name: /create client/i })).toBeDisabled();
  });
});
