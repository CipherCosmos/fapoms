import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { useManagerOptions, useHrOwnerOptions, applyPlace, resolveIfsc } from './AssayerForms';
import { api } from '../../services/api';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

/**
 * The reporting-manager picker, pinned to the roster it claims to be a picker for.
 *
 * This hook asked `/assayers?limit=1000` and offered whatever came back. Against the customer's
 * 1,155 appraisers it therefore offered 1,000, and the 155 oldest records could not be named as
 * anybody's manager — the dropdown looked exactly the same as if those people did not work here.
 * A picker cannot be fixed with a warning, so the test that matters is that the missing person is
 * actually in the list.
 */

const page = (firstIndex: number, count: number, total: number, nextCursor: string | null = null) => ({
  success: true,
  data: Array.from({ length: count }, (_, i) => ({
    id: `a-${firstIndex + i}`,
    displayName: `Person ${firstIndex + i}`,
    assayerCode: `AS-${firstIndex + i}`,
  })),
  meta: { pagination: { total, nextCursor } },
});

const Harness: React.FC<{ enabled?: boolean; excludeId?: string }> = ({ enabled = true, excludeId }) => {
  const { people, failed, incomplete } = useManagerOptions(enabled, excludeId);
  return (
    <div>
      <span data-testid="count">{people === null ? 'loading' : String(people.length)}</span>
      <span data-testid="shortfall">{incomplete ? `${incomplete.shown} of ${incomplete.total}` : 'none'}</span>
      <span data-testid="failed">{failed ?? 'none'}</span>
      <span data-testid="labels">{(people ?? []).map((p) => p.label).join('|')}</span>
    </div>
  );
};

beforeEach(() => mockRequest.mockReset());

describe('useManagerOptions', () => {
  it('offers every one of the 1,155 people, including those past the first thousand rows', async () => {
    mockRequest
      .mockResolvedValueOnce(page(1, 1000, 1155, 'cursor-1'))
      .mockResolvedValueOnce(page(1001, 155, 1155, null));

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1155'));
    // Person 1,100 is the one this bug was reported about: they exist, and could not be chosen.
    expect(screen.getByTestId('labels').textContent).toContain('Person 1100 · AS-1100');
    expect(screen.getByTestId('shortfall')).toHaveTextContent('none');
  });

  it('leaves the person being edited out of their own manager list', async () => {
    mockRequest.mockResolvedValueOnce(page(1, 3, 3));

    render(<Harness excludeId="a-2" />);

    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    expect(screen.getByTestId('labels').textContent).not.toContain('Person 2 ');
  });

  /** When the list really is short of the roster, that is reported rather than left to be found. */
  it('reports a list that is short of the roster instead of presenting it as everyone', async () => {
    mockRequest
      .mockResolvedValueOnce(page(1, 4, 1155, null));

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('4'));
    expect(screen.getByTestId('shortfall')).toHaveTextContent('4 of 1155');
  });

  it('says nothing about a shortfall when the whole roster arrived', async () => {
    mockRequest.mockResolvedValueOnce(page(1, 12, 12));

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('12'));
    expect(screen.getByTestId('shortfall')).toHaveTextContent('none');
  });

  it('names a failure rather than showing an empty picker', async () => {
    mockRequest.mockRejectedValueOnce(new Error('boom'));

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    expect(screen.getByTestId('failed')).not.toHaveTextContent('none');
  });

  it('fetches nothing until the field is actually shown', () => {
    render(<Harness enabled={false} />);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

/**
 * The HR-owner picker, backed by `GET /users/directory` rather than the assayer roster.
 *
 * `hrOwnerName` names an internal staff member, not an appraiser, so the candidate list has to
 * come from somewhere other than `useManagerOptions`'s roster — and it has to come from a route
 * a desk clerk can actually call, which `GET /users` is not (`@Roles(ADMIN)` plus
 * `user:view:organization`). These tests pin the hook to that endpoint and to a single request
 * rather than the manager picker's page walk, since the directory is server-capped, not paged.
 */
const HrOwnerHarness: React.FC<{ enabled?: boolean }> = ({ enabled = true }) => {
  const { people, failed } = useHrOwnerOptions(enabled);
  return (
    <div>
      <span data-testid="count">{people === null ? 'loading' : String(people.length)}</span>
      <span data-testid="failed">{failed ?? 'none'}</span>
      <span data-testid="labels">{(people ?? []).map((p) => p.label).join('|')}</span>
    </div>
  );
};

describe('useHrOwnerOptions', () => {
  it('calls the staff directory, not the assayer roster', async () => {
    mockRequest.mockResolvedValueOnce({
      success: true,
      data: [{ id: 'u-1', displayName: 'Asha Rao' }],
      meta: { pagination: { total: 1 } },
    });

    render(<HrOwnerHarness />);

    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    expect(mockRequest).toHaveBeenCalledWith('/users/directory', expect.objectContaining({ withMeta: true }));
    expect(screen.getByTestId('labels')).toHaveTextContent('Asha Rao');
  });

  it('names a failure rather than showing an empty picker', async () => {
    mockRequest.mockRejectedValueOnce(new Error('boom'));

    render(<HrOwnerHarness />);

    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    expect(screen.getByTestId('failed')).not.toHaveTextContent('none');
  });

  it('fetches nothing until the field is actually shown', () => {
    render(<HrOwnerHarness enabled={false} />);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

/**
 * The cross-fill rule both the registration wizard and the record's inline editor call — see
 * `GEO_AUTO_FIELDS` in AssayerForms.tsx and the reuse in AssayerRecord.tsx's `InlineControl`.
 * Exported now specifically so a second screen can call the real thing instead of growing its
 * own copy of it; these tests are what makes that reuse provable rather than assumed.
 */
describe('applyPlace', () => {
  const place = { label: 'Whitefield, Bengaluru Urban, Karnataka', state: 'Karnataka', district: 'Bengaluru Urban', pincode: '560066' };

  it('fills district, state and pincode from a picked pincode, and city when it was blank', () => {
    const setForm = jest.fn();
    applyPlace('pincode', place, { city: '', district: '', state: '', pincode: '' }, setForm);
    expect(setForm).toHaveBeenCalledWith({
      city: 'Whitefield', district: 'Bengaluru Urban', state: 'Karnataka', pincode: '560066',
    });
  });

  it('does not overwrite a city the operator already typed', () => {
    const setForm = jest.fn();
    applyPlace('pincode', place, { city: 'Kochi', district: '', state: '', pincode: '' }, setForm);
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ city: 'Kochi' }));
  });

  it('fills district and state from a picked city, and sets the city to the label\'s first token', () => {
    const setForm = jest.fn();
    applyPlace('city', place, { city: '', district: '', state: '', pincode: '' }, setForm);
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({
      city: 'Whitefield', district: 'Bengaluru Urban', state: 'Karnataka',
    }));
  });

  it('fills state (and city, when blank) from a picked district', () => {
    const setForm = jest.fn();
    applyPlace('district', place, { city: '', district: '', state: '', pincode: '' }, setForm);
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({
      district: 'Bengaluru Urban', state: 'Karnataka', city: 'Whitefield',
    }));
  });
});

/**
 * IFSC → bank/branch lookup. `resolveIfsc` is the one thing standing between an operator's
 * keystroke and a real network call, so the shape check has to actually gate it — a lookup on
 * every partial code would spend a request per keystroke on the way to a real one.
 */
describe('resolveIfsc', () => {
  it('never calls the endpoint for a shape-invalid code', async () => {
    const result = await resolveIfsc('NOT-A-CODE');
    expect(result).toBeNull();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('asks the backend endpoint for a shape-valid code, uppercased', async () => {
    mockRequest.mockResolvedValueOnce({
      bankName: 'HDFC BANK', branchName: 'Whitefield', city: 'Bengaluru', state: 'Karnataka', address: null,
    });
    const result = await resolveIfsc(' hdfc0001234 ');
    expect(mockRequest).toHaveBeenCalledWith('/geo/ifsc/HDFC0001234');
    expect(result).toEqual(expect.objectContaining({ bankName: 'HDFC BANK' }));
  });

  it('resolves to null, never throws, when the lookup fails', async () => {
    mockRequest.mockRejectedValueOnce(new Error('network down'));
    await expect(resolveIfsc('HDFC0001234')).resolves.toBeNull();
  });

  it('resolves to null when the backend genuinely has no match — a 200 with null data', async () => {
    mockRequest.mockResolvedValueOnce(null);
    await expect(resolveIfsc('HDFC0001234')).resolves.toBeNull();
  });
});
