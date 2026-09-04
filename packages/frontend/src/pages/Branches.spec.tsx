import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { BranchFormModal, emptyForm } from './Branches';
import { api } from '../services/api';

/**
 * A one-button stand-in for the live, debounced typeahead.
 *
 * These tests are about what the branch form does with a picked place or a blurred pincode —
 * cross-filling the address block and running the second-layer postal check — not about the
 * real `Autocomplete`'s own 350ms-debounced network round trip. `onBlur` is exposed the same
 * way the real component exposes it: a deliberate prop, called with the field's current value.
 */
jest.mock('../components/ui/Autocomplete', () => ({
  Autocomplete: ({ placeholder, value, onSelect, onBlur }: any) => (
    <div>
      <button type="button" onClick={() => onSelect?.({
        label: 'Whitefield, Bengaluru Urban, Karnataka', state: 'Karnataka', district: 'Bengaluru Urban', pincode: '560066',
      })}>
        {placeholder}
      </button>
      {onBlur && <button type="button" onClick={() => onBlur(value)}>{`blur ${placeholder}`}</button>}
    </div>
  ),
}));

/**
 * `resolvePincode` is mocked (it is a real network call to a third party, out of scope for this
 * form's own tests — see AssayerForms.spec.tsx for that contract). `addressConflict` is the REAL
 * function: it is pure, cheap, and the point of these tests is that Branches.tsx wires the actual
 * mismatch rule correctly, not that it calls something that always agrees with itself.
 */
jest.mock('./hr/AssayerForms', () => ({
  resolvePincode: jest.fn(),
  addressConflict: jest.requireActual('./hr/AssayerForms').addressConflict,
}));

jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../services/socket', () => ({ connectSocket: () => null }));

import { resolvePincode } from './hr/AssayerForms';
const mockRequest = api.request as jest.Mock;
const mockResolvePincode = resolvePincode as jest.Mock;

beforeEach(() => {
  mockRequest.mockReset();
  // Everything this modal asks for in passing (zones, workforce vocabulary) fails harmlessly —
  // both callers already fall back to an empty list on a rejection.
  mockRequest.mockRejectedValue(new Error('not served in this test'));
  mockResolvePincode.mockReset();
});

const openAdvanced = () => fireEvent.click(screen.getByRole('button', { name: /Advanced details/ }));

const renderModal = (initial = emptyForm) => render(
  <BranchFormModal title="New Branch" initial={initial} clientOptions={[]} onClose={jest.fn()} onSaved={jest.fn()} />,
);

/**
 * TASK 2 — the second-layer pincode check, missing from this form until now.
 *
 * `applyPlaceToBranch` only ever ran when a suggestion was clicked from the live dropdown; a
 * pincode typed by hand and never picked went completely unchecked. This is the same
 * `resolvePincode`/`addressConflict` pair the registration wizard already runs on blur.
 */
describe('Branches — the second-layer pincode check', () => {
  it('fills district and state from the postal directory when they are blank, on blur', async () => {
    mockResolvePincode.mockResolvedValueOnce({ state: 'Karnataka', district: 'Bengaluru Urban' });
    renderModal({ ...emptyForm, clientId: 'c1', name: 'Test Branch', solId: '12345', pincode: '560066' });

    fireEvent.click(screen.getByText('blur Type a pincode — the rest fills in'));
    await waitFor(() => expect(mockResolvePincode).toHaveBeenCalledWith('560066'));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/branches', expect.objectContaining({ method: 'POST' })));
    const [, options] = mockRequest.mock.calls.find(([url]) => url === '/branches')!;
    expect(JSON.parse(options.body)).toMatchObject({ state: 'Karnataka', district: 'Bengaluru Urban' });
  });

  it('warns on a real state/pincode mismatch, in the postal directory\'s own words', async () => {
    mockResolvePincode.mockResolvedValueOnce({ state: 'Karnataka', district: 'Bengaluru Urban' });
    renderModal({ ...emptyForm, clientId: 'c1', name: 'Test Branch', solId: '12345', state: 'Maharashtra', pincode: '560066' });

    fireEvent.click(screen.getByText('blur Type a pincode — the rest fills in'));

    await waitFor(() => expect(
      screen.getByText(/Pincode 560066 is in Karnataka, but the state is set to Maharashtra/),
    ).toBeInTheDocument());
  });

  it('never blocks save over the mismatch it just warned about', async () => {
    mockResolvePincode.mockResolvedValueOnce({ state: 'Karnataka', district: 'Bengaluru Urban' });
    renderModal({ ...emptyForm, clientId: 'c1', name: 'Test Branch', solId: '12345', state: 'Maharashtra', pincode: '560066' });

    fireEvent.click(screen.getByText('blur Type a pincode — the rest fills in'));
    await waitFor(() => expect(screen.getByText(/but the state is set to Maharashtra/)).toBeInTheDocument());

    // The warning is on screen and the state was NOT overwritten (state mismatches are
    // reported, never silently corrected) — and the save still goes through regardless.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/branches', expect.objectContaining({ method: 'POST' })));
    const [, options] = mockRequest.mock.calls.find(([url]) => url === '/branches')!;
    expect(JSON.parse(options.body)).toMatchObject({ state: 'Maharashtra' });
  });

  it('says nothing when the pincode is not yet six digits', async () => {
    renderModal({ ...emptyForm, pincode: '56006' });
    fireEvent.click(screen.getByText('blur Type a pincode — the rest fills in'));
    await Promise.resolve();
    expect(mockResolvePincode).not.toHaveBeenCalled();
  });
});

/**
 * TASK 4 — Territory shown in relation to District, instead of a box with no connection to the
 * field right above it. Backend already derives `${district} Area` for a branch with a
 * coordinate and no territory (`geo-precision.service.ts`); the same string is offered here as a
 * placeholder only — never written unless the operator actually types it.
 */
describe('Branches — Territory placeholder', () => {
  it('suggests "<district> Area" once a district is set, without writing it', () => {
    renderModal({ ...emptyForm, district: 'Ernakulam' });
    openAdvanced();

    const territoryLabel = screen.getByText('Territory');
    const territoryInput = territoryLabel.parentElement!.querySelector('input') as HTMLInputElement;
    expect(territoryInput.placeholder).toBe('Ernakulam Area');
    expect(territoryInput.value).toBe(''); // a placeholder, not an auto-filled value
  });

  it('offers no placeholder when there is no district yet', () => {
    renderModal(emptyForm);
    openAdvanced();

    const territoryLabel = screen.getByText('Territory');
    const territoryInput = territoryLabel.parentElement!.querySelector('input') as HTMLInputElement;
    expect(territoryInput.placeholder).toBe('');
  });
});
