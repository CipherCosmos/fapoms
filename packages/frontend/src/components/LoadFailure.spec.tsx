import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { fromResponse, fromNetwork } from '../services/errors';

jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));

import { LoadFailure, caughtLoad } from './LoadFailure';

/**
 * The one component every screen now routes its load failures through, so its three decisions are
 * pinned here rather than re-derived per page:
 *
 *   1. what counts as failed (including the paused state a bare `isError` misses),
 *   2. what it says (the error's own sentence, not "check your connection"),
 *   3. whether Retry is worth offering.
 *
 * (3) is the one that was quietly wrong. It asked `classifyError(err).isRetryable`, which for an
 * `AppError` answers `category === 'retryable'` — and `fromResponse` never assigns that category:
 * a 500 arrives as `'system-failure'`. So the banner offered no Retry on a server outage, the one
 * failure where pressing a button genuinely helps, while its own doc comment said it did. It now
 * asks `translateError().retryable`, which reads the status band.
 */

const settled = (error: unknown) => ({
  data: undefined, isError: true, fetchStatus: 'idle' as const, error, refetch: jest.fn(),
});

const paused = (error: unknown) => ({
  data: undefined, isError: false, fetchStatus: 'paused' as const, error: null,
  failureReason: error, refetch: jest.fn(),
});

describe('LoadFailure — what counts as failed', () => {
  it('renders nothing when the load succeeded', () => {
    const { container } = render(
      <LoadFailure loads={[{ label: 'payouts', query: { data: [], isError: false, fetchStatus: 'idle', error: null, refetch: jest.fn() } }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('fires for a query that failed and paused, which `isError` reports as false', () => {
    render(<LoadFailure loads={[{ label: 'payouts', query: paused(fromResponse(403, { message: 'Forbidden' })) }]} />);
    expect(screen.getByText(/Could not load payouts/)).toBeInTheDocument();
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
  });

  it('does NOT fire for a paused refetch sitting on top of rows that loaded fine', () => {
    const { container } = render(
      <LoadFailure loads={[{ label: 'payouts', query: { data: [{ id: 1 }], isError: false, fetchStatus: 'paused', error: null, refetch: jest.fn() } }]} />,
    );
    // Slightly stale rows are still real rows; blanking them would be its own lie.
    expect(container).toBeEmptyDOMElement();
  });
});

describe('LoadFailure — whether Retry is worth offering', () => {
  it('offers Retry for a 500, which is the case a retry exists for', () => {
    const q = settled(fromResponse(500, { message: 'boom' }));
    render(<LoadFailure loads={[{ label: 'the queue', query: q }]} />);
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    expect(q.refetch).toHaveBeenCalledTimes(1);
  });

  it('offers Retry for a dropped connection', () => {
    render(<LoadFailure loads={[{ label: 'the queue', query: settled(fromNetwork(new TypeError('Failed to fetch'))) }]} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('offers no Retry for a 403 — the only outcome would be the same refusal', () => {
    render(<LoadFailure loads={[{ label: 'the queue', query: settled(fromResponse(403, { message: 'Forbidden' })) }]} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByText(/showing nothing rather than a partial or misleading view/)).toBeInTheDocument();
  });

  it('offers no Retry for a 404 — the record will not exist on a second try', () => {
    render(<LoadFailure loads={[{ label: 'this invoice', query: settled(fromResponse(404, { message: 'Not Found' })) }]} />);
    expect(screen.getByText(/could not be found/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('names the network rather than guessing when a query paused before its first attempt', () => {
    render(<LoadFailure loads={[{ label: 'the queue', query: { data: undefined, isError: false, fetchStatus: 'paused', error: null, refetch: jest.fn() } }]} />);
    expect(screen.getByText(/no network connection/)).toBeInTheDocument();
    // There is nothing to retry against; it will resume by itself.
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});

describe('LoadFailure — several loads at once', () => {
  it('names every failed load and stays silent about the ones that worked', () => {
    render(
      <LoadFailure
        loads={[
          { label: 'the roster', query: settled(fromResponse(403, { message: 'Forbidden' })) },
          { label: 'what people are paid', query: { data: [], isError: false, fetchStatus: 'idle', error: null, refetch: jest.fn() } },
        ]}
      />,
    );
    expect(screen.getByText(/the roster/)).toBeInTheDocument();
    expect(screen.queryByText(/what people are paid/)).not.toBeInTheDocument();
  });

  it('retries every failed load together', () => {
    const a = settled(fromResponse(500, { message: 'boom' }));
    const b = settled(fromResponse(500, { message: 'boom' }));
    render(<LoadFailure loads={[{ label: 'the roster', query: a }, { label: 'pay', query: b }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(a.refetch).toHaveBeenCalledTimes(1);
    expect(b.refetch).toHaveBeenCalledTimes(1);
  });
});

describe('caughtLoad — the adapter for screens that fetch without React Query', () => {
  it('reports a caught error as a failure and quotes it', () => {
    render(<LoadFailure loads={[{ label: 'the claims', query: caughtLoad(fromResponse(403, { message: 'Forbidden' }), jest.fn()) }]} />);
    expect(screen.getByText(/Could not load the claims/)).toBeInTheDocument();
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
  });

  it('reports null as not failing, so a recovered load clears the banner', () => {
    const { container } = render(<LoadFailure loads={[{ label: 'the claims', query: caughtLoad(null, jest.fn()) }]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('wires its refetch to the Retry button', () => {
    const reload = jest.fn();
    render(<LoadFailure loads={[{ label: 'the claims', query: caughtLoad(fromResponse(500, { message: 'boom' }), reload) }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
