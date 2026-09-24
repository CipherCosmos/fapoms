import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BranchImportDecisions, BranchReviewReport, BranchReviewRow } from '@fapoms/shared';
import { BranchReconciliationModal, REVIEW_PAGE_SIZE } from './BranchReconciliationModal';

/**
 * A 5,000-row review draws one page of rows, not 35,000 inputs — and nothing the person typed on
 * one page is lost by moving to another: every edit and removal goes with Commit.
 */

jest.mock('../../services/api', () => ({ api: { get: jest.fn(), request: jest.fn() } }));
jest.mock('../geo/CoordinatePinModal', () => ({ CoordinatePinModal: () => null }));

const row = (n: number, over: Partial<BranchReviewRow> = {}): BranchReviewRow => ({
  rowNumber: n + 2, solId: `S-${n}`, name: `Branch ${n}`, state: 'Kerala', district: 'PALAKKAD', address: `${n} Main Rd`,
  pincode: '678001', latitude: 10.7, longitude: 76.6, geoSource: 'pincode', geoAccuracyMeters: 5000,
  existsInMaster: false, status: 'coarse', missingFields: [], ...over,
});

function report(count: number): BranchReviewReport {
  const rows = Array.from({ length: count }, (_, i) => row(i));
  return {
    version: 1,
    summary: { totalRows: count, existingInMaster: 0, newBranches: count, readyCount: 0, coarseCount: count, needsDetailsCount: 0, clientMismatchCount: 0 },
    rows,
    skipped: [],
    notes: [],
  };
}

function mount(r: BranchReviewReport) {
  const onCommit = jest.fn<Promise<boolean>, [BranchImportDecisions]>().mockResolvedValue(true);
  render(<BranchReconciliationModal open onClose={() => undefined} report={r} onCommit={onCommit} />);
  return { onCommit };
}

/** The table's body rows (the header row is in <thead>). */
const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]).getAllByRole('row');
const inputFor = (value: string) => screen.getByDisplayValue(value) as HTMLInputElement;

describe('BranchReconciliationModal with a 5,000-row list', () => {
  it('draws one page of rows, not the whole list', () => {
    mount(report(5000));
    expect(bodyRows()).toHaveLength(REVIEW_PAGE_SIZE);
    // Six editable fields per row: one page's worth of inputs, where the whole list was 30,000.
    expect(screen.getAllByRole('textbox')).toHaveLength(REVIEW_PAGE_SIZE * 6);
    expect(screen.getByTestId('review-page-range')).toHaveTextContent('Rows 1–100 of 5,000 · page 1 of 50');
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    // The totals still count every row, not just the page.
    expect(screen.getByRole('button', { name: /All Branches \(5000\)/ })).toBeInTheDocument();
  });

  it('keeps edits and removals made on other pages, and commits all of them', async () => {
    const { onCommit } = mount(report(5000));

    fireEvent.change(inputFor('Branch 5'), { target: { value: 'Branch Five (renamed)' } });

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByTestId('review-page-range')).toHaveTextContent('Rows 101–200');
    expect(screen.queryByDisplayValue('Branch Five (renamed)')).toBeNull();
    fireEvent.change(inputFor('150 Main Rd'), { target: { value: '150 Temple Rd' } });

    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    expect(screen.getByTestId('review-page-range')).toHaveTextContent('Rows 4,901–5,000 of 5,000 · page 50 of 50');
    const last = bodyRows().find((tr) => within(tr).queryByDisplayValue('S-4999'))!;
    fireEvent.click(within(last).getByTitle('Remove branch from import list'));

    // Back on page 1, the first edit is still there.
    fireEvent.click(screen.getByRole('button', { name: 'First page' }));
    expect(inputFor('Branch Five (renamed)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Commit & Link All Valid/ }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit.mock.calls[0][0]).toEqual({
      mode: 'all_valid',
      excluded: [4999 + 2],
      edits: {
        [String(5 + 2)]: { name: 'Branch Five (renamed)' },
        [String(150 + 2)]: { address: '150 Temple Rd' },
      },
    });
  });

  it('a filter starts on its first page, and a page emptied by removals falls back to the last one left', () => {
    const r = report(250);
    // Rows 200..249 need details: one filtered page of 50.
    for (let i = 200; i < 250; i++) r.rows[i] = row(i, { state: undefined, status: 'needs_details', missingFields: ['state'] });
    mount(r);
    // Opens on "Needs Attention", which fits on one page: no pager.
    expect(bodyRows()).toHaveLength(50);
    expect(screen.queryByRole('navigation', { name: 'Review pages' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /All Branches/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    expect(screen.getByTestId('review-page-range')).toHaveTextContent('Rows 201–250 of 250 · page 3 of 3');

    fireEvent.click(screen.getByRole('button', { name: /Needs Attention/ }));
    fireEvent.click(screen.getByRole('button', { name: /All Branches/ }));
    expect(screen.getByTestId('review-page-range')).toHaveTextContent('page 1 of 3');

    // Remove every row on the last page: the table shows page 2, not an empty page 3.
    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    for (let k = 0; k < 50; k++) fireEvent.click(within(bodyRows()[0]).getByTitle('Remove branch from import list'));
    expect(screen.getByTestId('review-page-range')).toHaveTextContent('Rows 101–200 of 200 · page 2 of 2');
    expect(bodyRows()).toHaveLength(REVIEW_PAGE_SIZE);
  });

  it('shows a new branch whose place was not verified, and typing a different state clears it', () => {
    const r = report(3);
    r.rows[1] = row(1, {
      state: 'Keralaa', status: 'needs_details',
      geographyProblem: { state: 'Keralaa', district: 'PALAKKAD', reason: "Could not verify 'Keralaa' as a real state." },
    });
    mount(r);
    expect(screen.getByTestId('place-problem-3')).toHaveAttribute('title', "Could not verify 'Keralaa' as a real state.");
    expect(screen.getByRole('button', { name: /Needs Attention \(1\)/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('State, row 3'), { target: { value: 'Kerala' } });
    expect(screen.queryByTestId('place-problem-3')).toBeNull();
    expect(screen.getByRole('button', { name: /Needs Attention \(0\)/ })).toBeInTheDocument();
  });
});
