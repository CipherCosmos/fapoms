import React from 'react';
import { MemoryRouter, Routes, Route, useLocation, useParams } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AssayerRoster } from './AssayerRoster';
import { AssayerRecord } from './AssayerRecord';
import { api } from '../../services/api';

/**
 * Deep links into a part of one person's record, end to end.
 *
 * `?section=financial` on HR Pay's payout-gap link was dead for months: the roster's `?assayer=`
 * redirect rebuilt the URL from scratch and dropped every other parameter, and nothing on the
 * record read `section` anyway — the edit modal that once consumed it had been removed. The link
 * looked precise and landed vaguely. These tests walk the real route: the roster forwarding
 * exactly RECORD_LINK_PARAMS (and none of its own list vocabulary), and the record honouring
 * `section`/`edit` once on arrival, then stripping them so a refresh does not replay the jump.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/socket', () => ({ connectSocket: () => null }));
jest.mock('../../hooks/useCurrentRoles', () => ({
  useCurrentRoles: () => ['ADMIN'],
  canManageAssayers: () => true,
  canCreateAssayers: () => true,
}));
jest.mock('../../hooks/useQueuedExcelExport', () => ({ useQueuedExcelExport: () => ({ download: jest.fn(), busy: false }) }));
jest.mock('../../hooks/useClients', () => ({ useClientOptions: () => ({ data: [] }) }));
jest.mock('./ImportIssuesPanel', () => ({ ImportIssuesPanel: () => null }));
jest.mock('./registration/RegistrationWizard', () => ({ RegistrationWizard: () => null }));
jest.mock('../../components/import/useImportJob', () => ({
  useImportJob: () => ({ state: { phase: 'idle' }, start: jest.fn(), reset: jest.fn() }),
}));
jest.mock('../../components/import/ImportProgressPanel', () => ({ ImportProgressPanel: () => null }));

const mockRequest = api.request as jest.Mock;

/** jsdom has no scrollIntoView; the polyfill lets the arrival scroll be asserted, not just survived. */
const scrolled = jest.fn();
beforeAll(() => { (window.HTMLElement.prototype as any).scrollIntoView = scrolled; });

const record = {
  id: 'a-1',
  assayerCode: 'AS0001',
  displayName: 'Person One',
  phone: '+919000000000',
  email: 'p1@example.com',
  city: 'Kochi',
  district: 'Ernakulam',
  state: 'Kerala',
  lifecycleStatus: 'ACTIVE',
  panNumber: 'ABCDE1234F',
  // No bank details on purpose: the Pay & terms tab's banner and HR Pay's link are both
  // about exactly this gap.
  bankAccountNumber: null,
  ifscCode: null,
  managerId: null,
};

/** Answers the record page's own fetches; everything else fails like a network would. */
const serveRecord = () => {
  mockRequest.mockImplementation((url: string) => {
    if (url === '/assayers/a-1') return Promise.resolve(record);
    if (url.includes('/dossier')) return Promise.resolve({ empanelments: [], currentCheck: null });
    if (url.includes('/photo')) return Promise.reject(new Error('no photograph'));
    if (url.includes('/commercial') || url.includes('/activity') || url.includes('/workforce-attribute')) {
      return Promise.resolve([]);
    }
    if (url.startsWith('/assayers?')) return Promise.resolve({ data: [], meta: { pagination: { total: 0 } } });
    return Promise.reject(new Error(`unexpected request: ${url}`));
  });
};

const Landing: React.FC = () => {
  const { assayerId } = useParams();
  const { search } = useLocation();
  return <div data-testid="landing">{assayerId}|{search}</div>;
};

const Search: React.FC = () => <div data-testid="search">{useLocation().search}</div>;

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

const renderRecordAt = (url: string) => render(
  <QueryClientProvider client={client()}>
    <MemoryRouter initialEntries={[url]}>
      <AssayerRecord assayerId="a-1" canManage onClose={() => {}} onChanged={() => {}} />
      <Search />
    </MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => { mockRequest.mockReset(); scrolled.mockClear(); });

describe('the roster’s ?assayer= redirect', () => {
  it('forwards the record’s parameters and none of the list’s own', async () => {
    mockRequest.mockImplementation(() => Promise.resolve({ data: [], meta: { pagination: { total: 0 } } }));

    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter initialEntries={['/hr/roster?assayer=a-9&edit=1&section=financial&q=kochi&segment=onboarding']}>
          <Routes>
            <Route path="/hr/roster" element={<AssayerRoster />} />
            <Route path="/hr/roster/:assayerId" element={<Landing />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('landing')).toBeInTheDocument());
    // `section` and `edit` survive the hop; the roster keeps its search and segment to itself.
    expect(screen.getByTestId('landing')).toHaveTextContent('a-9|?section=financial&edit=1');
  });
});

describe('arriving on the record with ?section=', () => {
  it('financial: opens the Summary scrolled to the ringed "How they are paid", then strips the URL', async () => {
    serveRecord();
    renderRecordAt('/hr/roster/a-1?section=financial');

    await waitFor(() => expect(screen.getByText('How they are paid')).toBeInTheDocument());
    const group = document.getElementById('record-group-financial');
    expect(group).not.toBeNull();
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    // The ring: the pointed-at panel, and only it, wears the accent for a moment.
    expect(group!.style.boxShadow).toContain('var(--accent)');
    expect(document.getElementById('record-group-contact')!.style.boxShadow).not.toContain('var(--accent)');
    // Consumed once, then stripped — a refresh must not replay the jump.
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent(/^$/));
  });

  it('a tab name opens that tab — commercial lands on Pay & terms', async () => {
    serveRecord();
    renderRecordAt('/hr/roster/a-1?section=commercial');

    // The banner at the top of the Pay & terms tab, for a record with no bank details.
    await waitFor(() => expect(screen.getByText('No bank details — cannot be paid')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent(/^$/));
  });

  it('with edit=1 — HR Pay’s payout-gap link — lands editing, ringed at the bank boxes', async () => {
    serveRecord();
    renderRecordAt('/hr/roster/a-1?edit=1&section=financial');

    await waitFor(() => expect(screen.getByRole('button', { name: /Save changes/ })).toBeInTheDocument());
    expect(document.getElementById('record-group-financial')!.style.boxShadow).toContain('var(--accent)');
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent(/^$/));
  });

  it('an unknown name degrades to the ordinary record, not a blank pane', async () => {
    serveRecord();
    renderRecordAt('/hr/roster/a-1?section=no-such-part');

    await waitFor(() => expect(screen.getByText('How to reach them')).toBeInTheDocument());
    expect(scrolled).not.toHaveBeenCalled();
    // Unrecognised or not, an arrival parameter never outlives its arrival.
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent(/^$/));
  });
});
