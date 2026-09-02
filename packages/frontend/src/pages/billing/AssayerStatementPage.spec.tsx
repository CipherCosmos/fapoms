import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AssayerStatementPage } from './AssayerStatementPage';
import { api } from '../../services/api';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../hooks/useBilling', () => ({
  useAssayerStatement: () => ({ data: undefined, isLoading: false, error: null }),
}));
const mockRequest = api.request as jest.Mock;

/**
 * The statement selector — the only way into this page.
 *
 * It asked for a thousand rows and swallowed every failure, so on a roster of 1,155 the statement
 * of anyone in the oldest 155 records could not be opened at all, and a failed load left a picker
 * that read as "no assayer has a statement". Both look identical to a finance manager: a dropdown
 * that does not contain the name they are after.
 */

const rosterPage = (firstIndex: number, count: number, total: number) => ({
  success: true,
  data: Array.from({ length: count }, (_, i) => ({
    id: `a-${firstIndex + i}`,
    assayerCode: `AS-${firstIndex + i}`,
    displayName: `Person ${firstIndex + i}`,
    district: 'Ernakulam',
  })),
  meta: { pagination: { total } },
});

const renderPage = () => render(<MemoryRouter><AssayerStatementPage /></MemoryRouter>);

/** Narrow with the page's own search box, then open the dropdown — as a clerk would. */
const lookFor = async (name: string) => {
  fireEvent.change(screen.getByPlaceholderText('Find an assayer…'), { target: { value: name } });
  fireEvent.click(screen.getByRole('combobox'));
  await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
};

beforeEach(() => mockRequest.mockReset());

describe('AssayerStatementPage', () => {
  it('can select somebody past the first thousand rows of the roster', async () => {
    mockRequest
      .mockResolvedValueOnce(rosterPage(1, 1000, 1155))
      .mockResolvedValueOnce(rosterPage(1001, 155, 1155));

    renderPage();
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));

    await lookFor('Person 1100');
    expect(screen.getByText('Person 1100 · AS-1100')).toBeInTheDocument();
  });

  it('offers no warning when the whole roster is in the list', async () => {
    mockRequest.mockResolvedValueOnce(rosterPage(1, 5, 5));

    renderPage();
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());

    expect(screen.queryByText(/not in this list/)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
  });

  it('says how many names are missing when the roster could not all be loaded', async () => {
    mockRequest
      .mockResolvedValueOnce(rosterPage(1, 4, 1155))
      .mockResolvedValueOnce({ success: true, data: [], meta: { pagination: { total: 1155 } } });

    renderPage();

    await waitFor(() => expect(screen.getByText(/Only 4 of the 1155 people/)).toBeInTheDocument());
    expect(screen.getByText(/1151 are not in this list/)).toBeInTheDocument();
  });

  /** Previously `.catch(() => {})`: an empty picker and not one word about why. */
  it('names a failed load instead of showing an empty picker', async () => {
    mockRequest.mockRejectedValueOnce(new Error('gateway timeout'));

    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/The list of assayers could not be loaded/)).toBeInTheDocument());
  });
});
