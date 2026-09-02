import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { RulesSection } from './Rules';
import { api } from '../services/api';

jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../hooks/useClients', () => ({ useClientOptions: () => ({ data: [] }) }));
jest.mock('../hooks/useWorkforceVocabulary', () => ({
  useWorkforceVocabulary: () => ({ skills: [], certifications: [], languages: [] }),
  asOptions: (v: string[]) => v,
}));
const mockRequest = api.request as jest.Mock;

/**
 * The rules section, and the branch list behind two of the things on it.
 *
 * It fetched `/branches?limit=1000` once. `GET /branches` clamps that to 200, so on the scale
 * database's 20,097 branches this section knew about 200 of them: the "One branch" picker did not
 * contain the 201st, so no rule could be scoped to it, and a rule already scoped to one showed the
 * raw UUID on its card where the branch name belongs. Neither had anything on screen to say so.
 */

const branch = (n: number) => ({ id: `b-${n}`, name: `Branch ${n}`, solId: `SOL${n}` });

/** One page of the branch list's envelope, exactly as the controller shapes it. */
const branchPage = (firstIndex: number, count: number, total: number) => ({
  success: true,
  data: Array.from({ length: count }, (_, i) => branch(firstIndex + i)),
  meta: { pagination: { total } },
});

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'r-1',
  name: 'Gold work only',
  scope: 'GLOBAL',
  targetId: null,
  ruleType: 'SKILL',
  conditions: { requiredSkill: 'Gold Assaying' },
  actions: { type: 'BLOCK' },
  isActive: true,
  ...over,
});

/**
 * Routes the section's two calls. `/branches` is served page by page from a list of `total`,
 * honouring `limit` up to the controller's own 200 clamp — so a loader that asks for more still
 * gets 200, exactly as the real endpoint behaves.
 */
const serve = (opts: { total: number; rules?: ReturnType<typeof rule>[] }) => {
  mockRequest.mockImplementation(async (url: string) => {
    if (url.startsWith('/planning/rules')) return opts.rules ?? [];
    const q = new URLSearchParams(url.split('?')[1]);
    const size = Math.min(Number(q.get('limit')), 200);
    const start = (Number(q.get('page')) - 1) * size + 1;
    return branchPage(start, Math.max(0, Math.min(size, opts.total - start + 1)), opts.total);
  });
};

const renderSection = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><RulesSection /></QueryClientProvider>);
};

/** Opens the branch picker and narrows it, as an admin scoping a rule would. */
const lookForBranch = async (name: string) => {
  fireEvent.click(screen.getByText('Add a rule'));
  fireEvent.click(screen.getByText('Global — applies to everyone'));
  fireEvent.click(await screen.findByText('One branch'));
  fireEvent.click(screen.getByText('Select a branch…'));
  fireEvent.change(await screen.findByPlaceholderText('Search…'), { target: { value: name } });
};

beforeEach(() => {
  mockRequest.mockReset();
  // canManageRules gates the "Add a rule" button, and the picker is inside the dialog behind it.
  localStorage.setItem('fapoms_user_cache', JSON.stringify({ roles: ['ADMIN'] }));
});
afterEach(() => localStorage.clear());

describe('RulesSection — the branch a rule can be pointed at', () => {
  it('offers a branch past the first 200, which one request could never have reached', async () => {
    serve({ total: 3412 });
    renderSection();
    await waitFor(() => expect(screen.getByText('No rules yet.', { exact: false })).toBeInTheDocument());

    await lookForBranch('Branch 3400');

    expect(await screen.findByText('Branch 3400 (SOL3400)')).toBeInTheDocument();
    expect(screen.queryByText(/could be loaded/)).not.toBeInTheDocument();
  });

  /**
   * The other half of the same list. `targetName` looks a saved rule's `targetId` up in it and
   * falls back to printing the id, so a truncated list turned a branch-scoped rule's card into
   * "BRANCH: 7c9e6679-7425-40de-944b-e07fc1f90ae7" for anyone reading the rules.
   */
  it('names the branch a saved rule points at, rather than printing its id', async () => {
    serve({ total: 3412, rules: [rule({ scope: 'BRANCH', targetId: 'b-3400' })] });

    renderSection();

    expect(await screen.findByText('BRANCH: Branch 3400')).toBeInTheDocument();
    expect(screen.queryByText('BRANCH: b-3400')).not.toBeInTheDocument();
  });

  it('shows no warning at all when the whole branch list loaded', async () => {
    serve({ total: 72 });

    renderSection();

    await waitFor(() => expect(screen.getByText('No rules yet.', { exact: false })).toBeInTheDocument());
    expect(screen.queryByText(/could be loaded/)).not.toBeInTheDocument();
  });

  /**
   * Past the loader's ceiling the list really is short, and the two symptoms above come back. The
   * one thing that must not happen is the old behaviour: a shorter list presented as the whole one.
   */
  it('says plainly how many branches are missing, and why that is visible on this page', async () => {
    serve({ total: 20_097 });

    renderSection();

    expect(await screen.findByText(/Only 10,000 of the 20,097 branches could be loaded/))
      .toBeInTheDocument();
    expect(screen.getByText(/other 10,097 shows a long ID/)).toBeInTheDocument();
  });
});
