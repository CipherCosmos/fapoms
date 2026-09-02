import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ProjectStatus, Priority } from '@fapoms/shared';
import { Projects } from './Projects';
import { api } from '../services/api';

jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../services/socket', () => ({ connectSocket: () => null }));
jest.mock('../hooks/useWorkforceVocabulary', () => ({
  useWorkforceVocabulary: () => ({ skills: [], certifications: [], languages: [] }),
  asOptions: (v: string[]) => v,
}));
// The real `withScope` — it is what puts the header's filter and `clientId` on the branch request,
// and a stub would let a bug in that query string through unnoticed.
jest.mock('../context/ScopeContext', () => ({
  ...jest.requireActual('../context/ScopeContext'),
  useScope: () => ({ scopeParams: {}, scopeKey: '' }),
}));
const mockRequest = api.request as jest.Mock;

/**
 * The picker that adds a branch to a project.
 *
 * It fetched `/branches?…&limit=1000` and searched what came back in the browser. `GET /branches`
 * clamps the page size to 200 (`branch.controller.ts`, `ParseLimitPipe({ default: 20, max: 200 })`),
 * so on a client with 3,412 branches this held 200 of them. Typing the name of the 201st answered
 * "No matching unassociated branches found." — word for word what it says about a branch that is
 * already on the project — so a branch that exists, belongs to this client and is not yet
 * associated could not be added, and nothing on screen said why.
 */

const branch = (n: number) => ({ id: `b-${n}`, name: `Branch ${n}`, solId: `SOL${n}`, city: 'Kochi' });

/** One page of the branch list's envelope, exactly as the controller shapes it. */
const branchPage = (firstIndex: number, count: number, total: number) => ({
  success: true,
  data: Array.from({ length: count }, (_, i) => branch(firstIndex + i)),
  meta: { pagination: { total } },
});

const PROJECT = {
  id: 'p-1',
  projectNumber: 'PRJ-001',
  name: 'Kerala gold audit',
  clientId: 'c-1',
  status: ProjectStatus.PLANNING,
  priority: Priority.MEDIUM,
  startDate: null, endDate: null, budget: null, scope: null,
  requiredSkills: null, requiredCertifications: null, description: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  client: { id: 'c-1', name: 'Sumeru Bank', clientCode: 'SB' },
  sla: null, risks: null,
};

/**
 * Routes every call the page makes. `/branches` is served page by page from a list of `total`,
 * honouring `limit` up to the controller's own 200 clamp — so a loader that asks for more still
 * gets 200, exactly as the real endpoint behaves.
 */
const serve = (opts: { total: number }) => {
  mockRequest.mockImplementation(async (url: string) => {
    if (url.startsWith('/projects?')) {
      return { success: true, data: [PROJECT], meta: { pagination: { total: 1 } } };
    }
    if (url === '/projects/p-1') return PROJECT;
    if (url === '/projects/p-1/branches') return [];
    if (url === '/clients') return [{ id: 'c-1', name: 'Sumeru Bank', clientCode: 'SB' }];
    const q = new URLSearchParams(url.split('?')[1]);
    const size = Math.min(Number(q.get('limit')), 200);
    const start = (Number(q.get('page')) - 1) * size + 1;
    return branchPage(start, Math.max(0, Math.min(size, opts.total - start + 1)), opts.total);
  });
};

/** Opens the project the `?id=` parameter names and goes to its branches tab, as a clerk would. */
const openBranchesTab = async () => {
  render(<MemoryRouter initialEntries={['/projects?id=p-1']}><Projects /></MemoryRouter>);
  fireEvent.click(await screen.findByText(/🏢 Branches/));
  return screen.findByPlaceholderText('Type branch name or code to search...');
};

const searchFor = (box: HTMLElement, text: string) =>
  fireEvent.change(box, { target: { value: text } });

beforeEach(() => {
  mockRequest.mockReset();
  localStorage.setItem('fapoms_user_cache', JSON.stringify({ roles: ['ADMIN'] }));
});
afterEach(() => localStorage.clear());

describe('Projects — adding a branch to a project', () => {
  it('finds a branch past the first 200, which one request could never have reached', async () => {
    serve({ total: 3412 });

    const box = await openBranchesTab();
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      expect.stringContaining('/branches?'), expect.objectContaining({ withMeta: true }),
    ));
    searchFor(box, 'Branch 3400');

    expect(await screen.findByText('Branch 3400')).toBeInTheDocument();
    expect(screen.queryByText(/No matching unassociated branches found/)).not.toBeInTheDocument();
    expect(screen.queryByText(/could be loaded/)).not.toBeInTheDocument();
  });

  /** The request the whole bug turns on: a page size the server will actually honour. */
  it('asks for pages the server will honour, and for the total that makes a shortfall visible', async () => {
    serve({ total: 3412 });

    await openBranchesTab();

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/branches?clientId=c-1&page=1&limit=200', expect.objectContaining({ withMeta: true }),
    ));
    // ceil(3412 / 200) pages, every one of them still scoped to this client.
    const branchCalls = mockRequest.mock.calls.filter(([u]: [string]) => u.startsWith('/branches?'));
    expect(branchCalls).toHaveLength(18);
    for (const [url] of branchCalls) expect(url).toContain('clientId=c-1');
  });

  it('shows no warning at all when every one of the client branches loaded', async () => {
    serve({ total: 72 });

    const box = await openBranchesTab();
    searchFor(box, 'Branch 7');

    expect(await screen.findByText('Branch 7')).toBeInTheDocument();
    expect(screen.queryByText(/could be loaded/)).not.toBeInTheDocument();
  });

  /**
   * Past the loader's ceiling the list really is short. The one thing that must not happen is the
   * old behaviour: "no matching branches" for a branch that is simply not loaded, with nothing to
   * tell the two apart.
   */
  it('says plainly how many branches the search below cannot find', async () => {
    serve({ total: 20_097 });

    await openBranchesTab();

    expect(await screen.findByText(/Only 10,000 of this client's 20,097 branches could be loaded/))
      .toBeInTheDocument();
    expect(screen.getByText(/cannot find the other 10,097/)).toBeInTheDocument();
  });
});
