import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { BillingPanel } from './BillingPanel';
import { useClientBilling, useClientDetail, useUpdateBilling, useUpdateClient } from '../../hooks/useClients';
import { api } from '../../services/api';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../hooks/useClients', () => ({
  useClientBilling: jest.fn(),
  useClientDetail: jest.fn(),
  useUpdateBilling: jest.fn(),
  useUpdateClient: jest.fn(),
}));
jest.mock('../../components/ui', () => ({
  ...jest.requireActual('../../components/ui'),
  useToast: () => ({ toast: jest.fn() }),
}));

const mockRequest = api.request as jest.Mock;
const mockUseClientBilling = useClientBilling as jest.Mock;
const mockUseClientDetail = useClientDetail as jest.Mock;
const mockUseUpdateBilling = useUpdateBilling as jest.Mock;
const mockUseUpdateClient = useUpdateClient as jest.Mock;

/**
 * The billing panel had six free-text fields (payment terms, invoice cycle, currency, IFSC,
 * bank name, billing address) with no cross-check between any of them. These pin the four
 * things the task actually asks for: a stored value the fixed vocabulary does not list must
 * still display and round-trip, a shape-valid IFSC autofills the bank name, an odd GSTIN warns
 * without blocking, and the billing address breakdown composes the same way the client address
 * does.
 */

const billing = {
  id: 'b1', clientId: 'cli-1', paymentTerms: '45 days from invoice', currency: 'AED',
  invoiceCycle: 'MONTHLY', taxIdentifier: 'not-a-real-number',
  billingAddress: 'C/o Sharma & Sons, near the old bus stand',
  bankAccount: '', bankName: '', ifscCode: '', notes: '',
  createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedBy: 'u1', updatedAt: '2026-01-01T00:00:00Z', version: 1, isActive: true,
};

const detail = {
  id: 'cli-1', configuration: { defaultBaseFee: 3000 }, planningPreferences: {},
};

describe('BillingPanel', () => {
  let updateBillingAsync: jest.Mock;
  let updateClientAsync: jest.Mock;

  beforeEach(() => {
    mockRequest.mockReset();
    updateBillingAsync = jest.fn().mockResolvedValue({});
    updateClientAsync = jest.fn().mockResolvedValue({});
    mockUseClientBilling.mockReturnValue({ data: billing, isLoading: false });
    mockUseClientDetail.mockReturnValue({ data: detail, isLoading: false });
    mockUseUpdateBilling.mockReturnValue({ mutateAsync: updateBillingAsync, isPending: false });
    mockUseUpdateClient.mockReturnValue({ mutateAsync: updateClientAsync, isPending: false });
  });

  it('displays a payment term outside the fixed list as an editable "Other" value, and round-trips it', async () => {
    render(<BillingPanel clientId="cli-1" />);

    const otherInput = await screen.findByDisplayValue('45 days from invoice');
    fireEvent.click(screen.getByRole('button', { name: /save billing/i }));

    await waitFor(() => expect(updateBillingAsync).toHaveBeenCalled());
    expect(updateBillingAsync.mock.calls[0][0].payload.paymentTerms).toBe('45 days from invoice');
    expect(otherInput).toBeInTheDocument();
  });

  it('round-trips a billing address the autocomplete does not recognise, untouched', async () => {
    render(<BillingPanel clientId="cli-1" />);

    expect(screen.getByDisplayValue(billing.billingAddress)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save billing/i }));

    await waitFor(() => expect(updateBillingAsync).toHaveBeenCalled());
    expect(updateBillingAsync.mock.calls[0][0].payload.billingAddress).toBe(billing.billingAddress);
  });

  it('warns on a GSTIN/tax identifier matching neither shape, without blocking the save', async () => {
    render(<BillingPanel clientId="cli-1" />);

    expect(screen.getByText(/doesn't look like a gstin/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save billing/i }));
    await waitFor(() => expect(updateBillingAsync).toHaveBeenCalled());
    expect(updateBillingAsync.mock.calls[0][0].payload.taxIdentifier).toBe('not-a-real-number');
  });

  it('autofills the bank name once a shape-valid IFSC resolves, without locking the field', async () => {
    mockRequest.mockResolvedValue({ bankName: 'HDFC Bank', branchName: 'MG Road', city: 'Pune', state: 'Maharashtra', address: '1 MG Road' });
    render(<BillingPanel clientId="cli-1" />);

    const ifscInput = screen.getByLabelText('IFSC') as HTMLInputElement;
    fireEvent.change(ifscInput, { target: { value: 'HDFC0001234' } });

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/geo/ifsc/HDFC0001234'), { timeout: 2000 });

    const bankNameInput = await screen.findByDisplayValue('HDFC Bank', undefined, { timeout: 2000 }) as HTMLInputElement;
    expect(screen.getByText(/MG Road, Pune, Maharashtra/)).toBeInTheDocument();

    // Still a plain, overwritable input — autofill is a starting point, not a lock.
    fireEvent.change(bankNameInput, { target: { value: 'Corrected Bank Name' } });
    expect(bankNameInput.value).toBe('Corrected Bank Name');
  });

  it('does not fetch a lookup for a shape-invalid IFSC', async () => {
    render(<BillingPanel clientId="cli-1" />);
    const ifscInput = screen.getByLabelText('IFSC') as HTMLInputElement;
    fireEvent.change(ifscInput, { target: { value: 'not-an-ifsc' } });

    await new Promise((r) => setTimeout(r, 500));
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

/**
 * Most clients in the live book have never had a billing profile saved at all — `useClientBilling`
 * resolves to `null` for them, not an object with defaulted fields (`ClientService.findBilling`
 * returns exactly what the row is). The GST/TDS/terms inputs still have to show something rather
 * than a blank that reads as zero, so they fill with the platform defaults — but that was
 * indistinguishable from an actually-saved 18%/10%, on the one screen whose job is showing what
 * prints on a real GST tax invoice.
 */
describe('BillingPanel — no billing profile saved yet', () => {
  let updateBillingAsync: jest.Mock;
  let updateClientAsync: jest.Mock;

  beforeEach(() => {
    mockRequest.mockReset();
    updateBillingAsync = jest.fn().mockResolvedValue({});
    updateClientAsync = jest.fn().mockResolvedValue({});
    mockUseClientDetail.mockReturnValue({ data: detail, isLoading: false });
    mockUseUpdateBilling.mockReturnValue({ mutateAsync: updateBillingAsync, isPending: false });
    mockUseUpdateClient.mockReturnValue({ mutateAsync: updateClientAsync, isPending: false });
  });

  it('warns that GST/TDS/terms are unconfirmed platform defaults when no profile exists', () => {
    mockUseClientBilling.mockReturnValue({ data: null, isLoading: false });
    render(<BillingPanel clientId="cli-1" />);

    expect(screen.getByText(/no billing profile saved for this client yet/i)).toBeInTheDocument();
    // The defaults are still shown, pre-filled, so the form is usable and Save writes a real row —
    // the warning is about trusting them unreviewed, not about hiding them.
    expect(screen.getByDisplayValue('18')).toBeInTheDocument();
    expect(screen.getByDisplayValue('10')).toBeInTheDocument();
  });

  it('says nothing once a real billing profile is loaded', () => {
    mockUseClientBilling.mockReturnValue({ data: billing, isLoading: false });
    render(<BillingPanel clientId="cli-1" />);

    expect(screen.queryByText(/no billing profile saved for this client yet/i)).not.toBeInTheDocument();
  });

  it('says nothing while still loading — only once absence is confirmed', () => {
    mockUseClientBilling.mockReturnValue({ data: undefined, isLoading: true });
    render(<BillingPanel clientId="cli-1" />);

    expect(screen.queryByText(/no billing profile saved for this client yet/i)).not.toBeInTheDocument();
  });

  /**
   * The regression this guards against actually happened live: a client with a real, saved
   * billing profile hit a transient fetch failure, and — because a failed query and a
   * genuinely-empty one both resolve `data` to `undefined` — the panel rendered exactly as if no
   * profile had ever been saved: platform defaults shown in place of the client's real rates,
   * Save fully enabled, no hint that anything had failed. Saving in that state would have
   * overwritten the client's real GST/TDS/terms with a guess.
   */
  it('blocks the whole form on a failed fetch, rather than falling through to "no profile"', () => {
    mockUseClientBilling.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<BillingPanel clientId="cli-1" />);

    expect(screen.getByText(/could not load this client's billing profile/i)).toBeInTheDocument();
    expect(screen.queryByText(/no billing profile saved for this client yet/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save billing/i })).not.toBeInTheDocument();
  });
});
