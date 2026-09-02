import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { useManagerOptions } from './AssayerForms';
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

const page = (firstIndex: number, count: number, total: number) => ({
  success: true,
  data: Array.from({ length: count }, (_, i) => ({
    id: `a-${firstIndex + i}`,
    displayName: `Person ${firstIndex + i}`,
    assayerCode: `AS-${firstIndex + i}`,
  })),
  meta: { pagination: { total } },
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
      .mockResolvedValueOnce(page(1, 1000, 1155))
      .mockResolvedValueOnce(page(1001, 155, 1155));

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
      .mockResolvedValueOnce(page(1, 4, 1155))
      .mockResolvedValueOnce({ success: true, data: [], meta: { pagination: { total: 1155 } } });

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
