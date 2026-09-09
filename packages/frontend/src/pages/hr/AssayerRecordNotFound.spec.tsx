import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { AssayerLifecycleStatus } from '@fapoms/shared';

import { AssayerRecordPage } from './AssayerRecordPage';
import { api } from '../../services/api';
import { fromResponse, fromNetwork } from '../../services/errors';

/**
 * `/hr/roster/<id>` when there is no such `<id>`.
 *
 * The record screen had one null check standing in for two different answers. `a === null` meant
 * "the profile has not arrived yet" AND "the profile will never arrive because there is no such
 * person", and the component rendered loading skeletons for both. So a mistyped or stale link
 * showed a skeleton for ever: `GET /assayers/<unknown>` answered `404 Assayer … not found.` in
 * milliseconds, the console logged it, and the page went on pretending to wait. The application's
 * own not-found page — "That page doesn't exist", with the URL kept and a way home — existed the
 * whole time and this route simply never reached it.
 *
 * The dangerous half of the fix is the other direction, so it is tested at least as hard: an
 * error state that swallowed slow or failing responses would be a WORSE bug than the spinner.
 * Telling somebody a colleague's personnel record does not exist, when in truth the server
 * returned 500 or the request is still in flight, invites them to re-create a person who is
 * already on the roster. Hence six cases, one per way this can be got wrong:
 *
 *  1. a real id                                  → the record
 *  2. an id nothing is filed under (404)         → not found
 *  3. an ARCHIVED person's id (200)              → the record — archived is a lifecycle state,
 *                                                   not an absence, and reads resolve one
 *  4. a malformed id (400 from ParseUUIDPipe)    → not found
 *  5. a slow response                            → still loading, NOT not-found
 *  6. a 500                                      → a failure with a retry, NOT not-found
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../hooks/useCurrentRoles', () => ({
  useCurrentRoles: () => ['ADMIN'],
  useCurrentPermissions: () => [],
  canManageAssayers: () => true,
  canDeleteAssayers: () => true,
}));

const mockRequest = api.request as jest.Mock;

const REAL_ID = '11111111-1111-4111-8111-111111111111';
const MISSING_ID = '00000000-0000-4000-8000-000000000999';
const ARCHIVED_ID = '22222222-2222-4222-8222-222222222222';
const MALFORMED_ID = 'not-a-uuid';

const person = (over: Record<string, unknown> = {}) => ({
  id: REAL_ID,
  assayerCode: 'AS0001',
  displayName: 'Person One',
  phone: '+919000000000',
  email: 'p1@example.com',
  city: 'Kochi',
  state: 'Kerala',
  lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
  ...over,
});

/**
 * The four side reads the record fires alongside the profile, answered blandly.
 *
 * None of them decides whether the page has a subject — the record swallows all four failures on
 * purpose (a viewer who cannot see the dossier still gets the summary). Answering them keeps the
 * test about the profile read, which is the one that does decide.
 */
const sideReads = (url: string): Promise<unknown> | null => {
  if (url.endsWith('/dossier')) return Promise.resolve({ onboarding: [], empanelments: [] });
  if (url.endsWith('/payables')) return Promise.resolve([]);
  if (url.includes('/assignments/assayer/')) return Promise.resolve({ items: [] });
  if (url.endsWith('/activity')) return Promise.resolve([]);
  return null;
};

/** The exact errors `api.ts` builds from a real response, not hand-rolled stand-ins. */
const notFound = (id: string) => fromResponse(404, { message: `Assayer ${id} not found.` });
const malformed = () => fromResponse(400, { message: 'Validation failed (uuid is expected)' });
const serverError = () => fromResponse(500, { message: 'Internal server error' });

/** A sibling of the routed screen, so it survives whatever that screen renders. */
const OpenAnotherRecord: React.FC<{ id: string }> = ({ id }) => {
  const navigate = useNavigate();
  return <button type="button" onClick={() => void navigate(`/hr/roster/${id}`)}>open another</button>;
};

const renderAt = (id: string) => render(
  <MemoryRouter initialEntries={[`/hr/roster/${id}`]}>
    <Routes>
      <Route path="/hr/roster/:assayerId" element={<AssayerRecordPage />} />
      <Route path="/hr/roster" element={<div>Roster table</div>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => { mockRequest.mockReset(); });

describe('the assayer record at its own URL, when the record is not there', () => {
  it('1. renders the person for an id that exists', async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url === `/assayers/${REAL_ID}`) return Promise.resolve(person());
      return sideReads(url) ?? Promise.reject(new Error('unexpected url'));
    });

    renderAt(REAL_ID);

    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());
    expect(screen.queryByText(/That page doesn’t exist/)).not.toBeInTheDocument();
  });

  it('2. says the page does not exist for an id nothing is filed under, instead of loading for ever', async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url === `/assayers/${MISSING_ID}`) return Promise.reject(notFound(MISSING_ID));
      if (url.endsWith('/dossier')) return Promise.reject(fromResponse(404, { message: 'No such assayer.' }));
      return sideReads(url) ?? Promise.reject(new Error('unexpected url'));
    });

    renderAt(MISSING_ID);

    await waitFor(() => expect(screen.getByText(/That page doesn’t exist/)).toBeInTheDocument());
    // The application's own not-found page, reached by this route rather than reinvented here:
    // the URL is kept verbatim so it can be pasted into a bug report, and there is a way out.
    expect(screen.getByText(`/hr/roster/${MISSING_ID}`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to your home page/ })).toBeInTheDocument();
    // And the thing this replaces is gone, not merely covered up.
    expect(screen.queryByTestId('assayer-record-loading')).not.toBeInTheDocument();
  });

  it('3. renders an ARCHIVED person — archived is a lifecycle state, not an absence', async () => {
    // `GET /assayers/:id` answers 200 for an archived record: reads use a different lookup from
    // the one mutations use. Keying "missing" off anything but the HTTP answer — a lifecycle
    // enum, an `isActive` flag — would 404 seven real people on this roster.
    mockRequest.mockImplementation((url: string) => {
      if (url === `/assayers/${ARCHIVED_ID}`) {
        return Promise.resolve(person({
          id: ARCHIVED_ID,
          displayName: 'Archived Person',
          lifecycleStatus: AssayerLifecycleStatus.ARCHIVED,
          isActive: false,
        }));
      }
      return sideReads(url) ?? Promise.reject(new Error('unexpected url'));
    });

    renderAt(ARCHIVED_ID);

    await waitFor(() => expect(screen.getByText('Archived Person')).toBeInTheDocument());
    expect(screen.queryByText(/That page doesn’t exist/)).not.toBeInTheDocument();
  });

  it('4. says the page does not exist for a malformed id, which never reaches a handler at all', async () => {
    // ParseUUIDPipe refuses it with 400 before the service is called. There is no form and no
    // field to correct, so rendering that as a validation error would be nonsense — the id in
    // the URL is simply not one the store could hold.
    mockRequest.mockImplementation((url: string) => {
      if (url.startsWith(`/assayers/${MALFORMED_ID}`)) return Promise.reject(malformed());
      return sideReads(url) ?? Promise.reject(new Error('unexpected url'));
    });

    renderAt(MALFORMED_ID);

    await waitFor(() => expect(screen.getByText(/That page doesn’t exist/)).toBeInTheDocument());
    expect(screen.getByText(`/hr/roster/${MALFORMED_ID}`)).toBeInTheDocument();
  });

  it('5. keeps waiting while the profile is merely slow, and never calls that a 404', async () => {
    let release: (value: unknown) => void = () => undefined;
    const slow = new Promise((resolve) => { release = resolve; });
    mockRequest.mockImplementation((url: string) => {
      if (url === `/assayers/${REAL_ID}`) return slow;
      return sideReads(url) ?? Promise.reject(new Error('unexpected url'));
    });

    renderAt(REAL_ID);

    // The whole point of the four-state load: a pending request is not an answer.
    await waitFor(() => expect(screen.getByTestId('assayer-record-loading')).toBeInTheDocument());
    expect(screen.queryByText(/That page doesn’t exist/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('assayer-record-failed')).not.toBeInTheDocument();

    release(person());
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());
  });

  it('6. reports a server failure as a failure with a retry, never as "no such person"', async () => {
    let attempts = 0;
    mockRequest.mockImplementation((url: string) => {
      if (url === `/assayers/${REAL_ID}`) {
        attempts += 1;
        return attempts === 1 ? Promise.reject(serverError()) : Promise.resolve(person());
      }
      return sideReads(url) ?? Promise.reject(new Error('unexpected url'));
    });

    renderAt(REAL_ID);

    await waitFor(() => expect(screen.getByTestId('assayer-record-failed')).toBeInTheDocument());
    // A 500 says nothing about whether the record exists. Claiming it does invites somebody to
    // re-create a person who is already on the roster.
    expect(screen.queryByText(/That page doesn’t exist/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());
  });

  it('treats a request that never reached the server as a failure, not an absence', async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url === `/assayers/${REAL_ID}`) return Promise.reject(fromNetwork(new Error('Failed to fetch')));
      return sideReads(url) ?? Promise.reject(new Error('unexpected url'));
    });

    renderAt(REAL_ID);

    await waitFor(() => expect(screen.getByTestId('assayer-record-failed')).toBeInTheDocument());
    expect(screen.queryByText(/That page doesn’t exist/)).not.toBeInTheDocument();
  });

  it('stops claiming a person is missing once the URL names a different one', async () => {
    // React Router keeps this element mounted when only the param changes, so a "missing" flag
    // that is never reset would 404 the next, perfectly real, person the operator opens.
    mockRequest.mockImplementation((url: string) => {
      if (url === `/assayers/${MISSING_ID}`) return Promise.reject(notFound(MISSING_ID));
      if (url === `/assayers/${REAL_ID}`) return Promise.resolve(person());
      return sideReads(url) ?? Promise.reject(new Error('unexpected url'));
    });

    render(
      <MemoryRouter initialEntries={[`/hr/roster/${MISSING_ID}`]}>
        <OpenAnotherRecord id={REAL_ID} />
        <Routes>
          <Route path="/hr/roster/:assayerId" element={<AssayerRecordPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/That page doesn’t exist/)).toBeInTheDocument());

    // A real in-app navigation, not a remount: only the route param changes, which is precisely
    // the case a boolean "missing" flag would have got wrong.
    fireEvent.click(screen.getByRole('button', { name: 'open another' }));

    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());
    expect(screen.queryByText(/That page doesn’t exist/)).not.toBeInTheDocument();
  });
});
