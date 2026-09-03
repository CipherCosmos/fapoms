import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { HrIssuesPage } from './HrIssuesPage';
import { api } from '../../services/api';

/**
 * The review queue as a destination.
 *
 * It had none. The panel rendered at the bottom of the roster, collapsed, and returned `null`
 * whenever the count was zero — so 431 open findings (283 from the importer, ~149 from the
 * data-integrity scan) had no URL, no nav badge and no way to be linked to. The only way to
 * discover them was to scroll past a thousand-row table on a screen opened for something else.
 *
 * These tests hold the page to the two things a destination has to do that the embedded panel
 * did not: be open when you arrive, and answer you when there is nothing there.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('./HrLayout', () => ({ useHr: () => ({ canManage: true }) }));

const mockRequest = api.request as jest.Mock;

const issue = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  sourceSheet: 'Data integrity',
  sourceRow: 0,
  sourceColumn: 'No date of birth · AS0001',
  rawValue: 'no date of birth',
  reason: 'AS0001 (Person One) has no date of birth on the record.',
  sourceAssayerCode: 'AS0001',
  assayer: { id: 'a-1', assayerCode: 'AS0001', firstName: 'Person', lastName: 'One' },
  ...over,
});

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><HrIssuesPage /></MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => mockRequest.mockReset());

describe('HrIssuesPage', () => {
  it('opens with the findings already expanded — nobody arrives here to press a chevron', async () => {
    mockRequest.mockResolvedValue({ rows: [issue('i-1'), issue('i-2', { sourceAssayerCode: 'AS0002' })], openCount: 2 });

    renderPage();

    expect(screen.getByText('Review queue')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/2 record problems to review/)).toBeInTheDocument());
    // Expanded: the grouped finding itself is on screen, not just the headline count.
    expect(screen.getByText(/has no date of birth on the record/)).toBeInTheDocument();
  });

  it('says how many are open and what closing one involves', async () => {
    mockRequest.mockResolvedValue({ rows: [issue('i-1')], openCount: 1 });

    renderPage();

    await waitFor(() => expect(screen.getByText(/1 problem is open/)).toBeInTheDocument());
    expect(screen.getByText(/Every close asks what was decided/)).toBeInTheDocument();
  });

  it('answers an empty queue instead of rendering a blank page', async () => {
    // The embedded panel returns null here, which is right under the roster and wrong on a page
    // somebody navigated to on purpose.
    mockRequest.mockResolvedValue({ rows: [], openCount: 0 });

    renderPage();

    await waitFor(() => expect(screen.getByText(/Nothing to review/)).toBeInTheDocument());
    expect(screen.getByText(/has been decided/)).toBeInTheDocument();
  });

  it('says plainly when the queue could not be read, rather than showing zero', async () => {
    mockRequest.mockRejectedValue(new Error('403'));

    renderPage();

    await waitFor(() => expect(screen.getByText(/could not be read/)).toBeInTheDocument());
    expect(screen.queryByText(/problems are open/)).not.toBeInTheDocument();
  });
});
