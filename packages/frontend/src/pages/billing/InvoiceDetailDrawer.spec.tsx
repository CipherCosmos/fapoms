import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InvoiceDetailDrawer } from './InvoiceDetailDrawer';
import { ToastProvider } from '../../components/ui';
import { billingApi } from '../../services/billing';
import { InvoiceStatus, PaymentMethod } from '@fapoms/shared';

/**
 * Cancellation and reversal reasons: preset+Other, same shape as PayoutsTab's HoldModal.
 *
 * Neither has real historical data in this dev database (billing history is near-empty), so the
 * presets are seeded from context. What matters here is that the exact chosen or typed text is
 * what reaches `cancelInvoice` / `reversePayment` — never a placeholder, never silently swapped.
 */

// `services/billing.ts` imports `./api`, which pulls in a Vite-only `import.meta.env` (via
// `session.ts` -> `socket.ts`) that ts-jest cannot parse. Stubbing `services/api` here cuts that
// chain before `requireActual` below ever reaches it — nothing in this suite calls the real API.
jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/billing', () => {
  const actual = jest.requireActual('../../services/billing');
  return {
    ...actual,
    billingApi: {
      ...actual.billingApi,
      getInvoice: jest.fn(),
      cancelInvoice: jest.fn(),
      reversePayment: jest.fn(),
    },
  };
});

jest.mock('./invoicePrint', () => ({ openInvoicePrintWindow: jest.fn() }));

const mockGetInvoice = billingApi.getInvoice as jest.Mock;
const mockCancelInvoice = billingApi.cancelInvoice as jest.Mock;
const mockReversePayment = billingApi.reversePayment as jest.Mock;

const draftInvoice = {
  id: 'inv-1',
  invoiceNumber: 'INV-001',
  clientId: 'c-1',
  status: InvoiceStatus.DRAFT,
  issueDate: '2026-01-01',
  dueDate: '2026-01-15',
  currency: 'INR',
  subtotal: 1000,
  taxAmount: 180,
  tdsAmount: 0,
  total: 1180,
  paidAmount: 0,
  outstandingAmount: 1180,
  notes: null,
  entries: [],
  payments: [],
  clientName: 'Acme Corp',
};

const issuedInvoiceWithPayment = {
  ...draftInvoice,
  status: InvoiceStatus.ISSUED,
  paidAmount: 500,
  outstandingAmount: 680,
  payments: [
    {
      id: 'p-1',
      direction: 'INBOUND',
      paymentReference: 'REF-500',
      method: PaymentMethod.NEFT,
      amount: 500,
      currency: 'INR',
      receivedDate: '2026-01-05',
      notes: null,
    },
  ],
};

const renderDrawer = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <InvoiceDetailDrawer invoiceId="inv-1" onClose={jest.fn()} canAct />
      </ToastProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  mockGetInvoice.mockReset();
  mockCancelInvoice.mockReset().mockResolvedValue(draftInvoice);
  mockReversePayment.mockReset().mockResolvedValue({});
});

describe('InvoiceDetailDrawer — cancellation reason', () => {
  it('sends the exact preset text', async () => {
    mockGetInvoice.mockResolvedValue(draftInvoice);
    renderDrawer();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Cancel invoice/ }));
    const keepBtn = await screen.findByRole('button', { name: 'Keep' });
    const panel = keepBtn.parentElement!.parentElement!;

    // The trigger's role, not its label text — the label, its button and the outer wrapper all
    // carry the same text node, so a text query would match more than one element.
    fireEvent.click(within(panel).getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Duplicate invoice' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel invoice' }));

    await waitFor(() => expect(mockCancelInvoice).toHaveBeenCalledWith('inv-1', 'Duplicate invoice'));
  });

  it('sends the exact free text typed under Other, not the preset placeholder', async () => {
    mockGetInvoice.mockResolvedValue(draftInvoice);
    renderDrawer();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Cancel invoice/ }));
    const keepBtn = await screen.findByRole('button', { name: 'Keep' });
    const panel = keepBtn.parentElement!.parentElement!;

    fireEvent.click(within(panel).getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Other…' }));
    const textarea = within(panel).getByPlaceholderText('Reason *');
    fireEvent.change(textarea, { target: { value: 'Client asked us to void it over email.' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel invoice' }));

    await waitFor(() =>
      expect(mockCancelInvoice).toHaveBeenCalledWith('inv-1', 'Client asked us to void it over email.'));
  });
});

describe('InvoiceDetailDrawer — payment reversal reason', () => {
  it('sends the exact preset text', async () => {
    mockGetInvoice.mockResolvedValue(issuedInvoiceWithPayment);
    renderDrawer();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Reverse this payment'));
    fireEvent.click(await screen.findByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Wrong amount entered' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment' }));

    await waitFor(() => expect(mockReversePayment).toHaveBeenCalledWith('p-1', 'Wrong amount entered'));
  });

  it('sends the exact free text typed under Other, not the preset placeholder', async () => {
    mockGetInvoice.mockResolvedValue(issuedInvoiceWithPayment);
    renderDrawer();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Reverse this payment'));
    fireEvent.click(await screen.findByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Other…' }));
    const textarea = screen.getByPlaceholderText('Reason *');
    fireEvent.change(textarea, { target: { value: 'The bank rejected the underlying NEFT transfer.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reverse payment' }));

    await waitFor(() =>
      expect(mockReversePayment).toHaveBeenCalledWith('p-1', 'The bank rejected the underlying NEFT transfer.'));
  });
});
