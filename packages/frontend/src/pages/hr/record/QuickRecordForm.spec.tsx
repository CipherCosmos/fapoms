import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QuickRecordForm, CONTACT_BOXES, PAYOUT_BOXES } from './QuickRecordForm';
import { api } from '../../../services/api';

jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../AssayerForms', () => ({
  ...jest.requireActual('../AssayerForms'),
  resolveIfsc: jest.fn().mockResolvedValue(null),
}));

/**
 * THE ONBOARDING DRAWER ASKED FOR THINGS THE RECORD ALREADY HAD.
 *
 * Every box in this form started empty, with "On file: 98220 01133" printed underneath — so the
 * desk, finishing somebody's onboarding, was asked for a phone number, an emergency contact and a
 * joining date that were sitting right there. The non-secret boxes now open holding what is on
 * file.
 *
 * The PAN and the account number deliberately do NOT. The record holds masked copies, a box
 * pre-filled with a mask gets saved over a real number, and re-typing them from the document is
 * the check itself. That rule gets its own test, because it is the one somebody will be tempted to
 * "fix" next.
 */
const assayer = {
  id: 'as-1',
  displayName: 'Ramesh Iyer',
  phone: '+919822001133',
  emergencyContactPhone: '9822001144',
  joiningDate: '2026-09-01T00:00:00.000Z',
  panNumber: 'ABCDE1234F',
  bankAccountNumber: '50100123456789',
  ifscCode: 'HDFC0001234',
  bankName: 'HDFC Bank',
} as never;

const renderForm = (boxes = CONTACT_BOXES) => render(
  <QueryClientProvider client={new QueryClient()}>
    <QuickRecordForm assayer={assayer} boxes={boxes} saveLabel="Save" onSaved={jest.fn()} />
  </QueryClientProvider>,
);

/** The box under a caption. The <label> also wraps the hint line, so its accessible name is longer. */
const box = (caption: string) =>
  screen.getByText(caption, { selector: 'span' }).parentElement!.querySelector('input') as HTMLInputElement;

beforeEach(() => {
  (api.request as jest.Mock).mockReset().mockResolvedValue({});
});

describe('the contact details on an onboarding record', () => {
  it('opens with what the record already holds', () => {
    renderForm();
    expect(box('Phone').value).toBe('9822001133');
    expect(box('Emergency contact phone').value).toBe('9822001144');
    expect(box('Joining date').value).toBe('2026-09-01');
    expect(screen.getAllByText(/From their record/)).toHaveLength(3);
  });

  it('has nothing to save until something is changed', () => {
    renderForm();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('sends only the box that was changed', async () => {
    renderForm();
    fireEvent.change(box('Emergency contact phone'), { target: { value: '9822009999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.request).toHaveBeenCalled());
    const body = JSON.parse((api.request as jest.Mock).mock.calls[0][1].body);
    expect(Object.keys(body)).not.toContain('phone');
    expect(Object.keys(body)).not.toContain('joiningDate');
    expect(JSON.stringify(body)).toContain('9822009999');
  });

  /** Pre-filling must not give this small form the power to erase a field on somebody's record. */
  it('does not erase a field when its box is emptied', () => {
    renderForm();
    fireEvent.change(box('Phone'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('the identifiers that are re-typed from the document', () => {
  it('keeps the PAN and the account number EMPTY even though the record holds both', () => {
    // The onboarding bank form no longer carries a PAN box (it lives with the PAN card), but this
    // form still takes one anywhere it is given one, and the rule for it must not move.
    renderForm([...PAYOUT_BOXES, { key: 'panNumber', label: 'PAN', placeholder: 'e.g. ABCDE1234F', mono: true }]);
    expect(box('PAN').value).toBe('');
    expect(box('Bank account number').value).toBe('');
    // …with the masked copy beside them, so the desk can see one is already on file.
    expect(screen.getAllByText(/On file: /).length).toBeGreaterThanOrEqual(2);
  });

  it('shows the bank and IFSC, which are not secret', () => {
    renderForm(PAYOUT_BOXES);
    expect(box('IFSC').value).toBe('HDFC0001234');
    expect(box('Bank').value).toBe('HDFC Bank');
  });
});
