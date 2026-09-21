import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Autocomplete } from './Autocomplete';
import { api } from '../../services/api';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

/**
 * An empty dropdown has to say which kind of empty it is.
 *
 * This control renders nothing when a lookup comes back with no rows, and for as long as the
 * source was Google that was survivable: Google matched prefixes, so anything a person typed
 * that was going somewhere produced rows on the way. The source is now the self-hosted
 * Nominatim, which matches WHOLE WORDS — verified against the live instance: `Pun` and even
 * `Nashi` return nothing at all, and only `Pune` returns the city. Silence therefore appears
 * mid-word for every successful search, and an operator reading it is told their place does not
 * exist when they simply have not finished typing.
 *
 * Three different facts collapse into "no rows", and the person needs a different thing from
 * each: finish the word; this deployment has no place lookup; the lookup could not be reached.
 * `GET /geo/autocomplete` already reports the second in `meta.configured` — the component just
 * never asked for it, because the plain `api.request` unwraps to `data` and drops `meta`.
 */
const place = { label: 'Pune, Maharashtra', type: 'city', state: 'Maharashtra', district: 'Pune', pincode: '411001' };

const enveloped = (data: unknown[], configured = true) =>
  Promise.resolve({ success: true, data, meta: { configured } });

const type = (value: string) => {
  render(<Autocomplete value={value} onChange={jest.fn()} placeholder="Type to search city…" />);
};

describe('Autocomplete — says which kind of empty it is', () => {
  beforeEach(() => mockRequest.mockReset());

  it('lists the matches when the lookup finds some', async () => {
    mockRequest.mockImplementation(() => enveloped([place]));
    type('Pune');
    expect(await screen.findByText('Pune, Maharashtra', undefined, { timeout: 2000 })).toBeInTheDocument();
  });

  it('asks for the envelope, so meta.configured is actually readable', async () => {
    mockRequest.mockImplementation(() => enveloped([place]));
    type('Pune');
    await screen.findByText('Pune, Maharashtra', undefined, { timeout: 2000 });
    expect(mockRequest).toHaveBeenCalledWith(
      expect.stringContaining('/geo/autocomplete?q=Pune'),
      expect.objectContaining({ withMeta: true }),
    );
  });

  it('tells a mid-word searcher to finish the word, instead of showing nothing', async () => {
    mockRequest.mockImplementation(() => enveloped([]));
    type('Pun');
    // Names what was searched for, and why it found nothing — this is the Nominatim whole-word case.
    expect(await screen.findByText(/No match for/, undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText(/full name/)).toBeInTheDocument();
  });

  it('tells a half-typed pincode to keep going, not to check its spelling', async () => {
    mockRequest.mockImplementation(() => enveloped([]));
    type('41100');
    // These forms lead with "Type a pincode — the rest fills in", so this is the commonest
    // way to reach an empty dropdown. Advice about full NAMES would be nonsense here.
    expect(await screen.findByText(/six digits/, undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.queryByText(/full name/)).not.toBeInTheDocument();
  });

  it('does not blame the place when the deployment has no lookup at all', async () => {
    mockRequest.mockImplementation(() => enveloped([], false));
    type('Pune');
    expect(await screen.findByText(/not switched on/, undefined, { timeout: 2000 })).toBeInTheDocument();
    // The wrong answer here is "no such place" — that is the bug this whole state exists to stop.
    expect(screen.queryByText(/No match for/)).not.toBeInTheDocument();
  });

  it('says the lookup was unreachable, and that the typed value is kept', async () => {
    mockRequest.mockImplementation(() => Promise.reject(new Error('network')));
    type('Pune');
    expect(await screen.findByText(/Could not reach/, undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText(/still saved/)).toBeInTheDocument();
  });

  it('stays quiet below the minimum length rather than searching one letter', async () => {
    mockRequest.mockImplementation(() => enveloped([]));
    type('P');
    await new Promise((r) => setTimeout(r, 600));
    expect(mockRequest).not.toHaveBeenCalled();
    expect(screen.queryByText(/No match for/)).not.toBeInTheDocument();
  });
});
