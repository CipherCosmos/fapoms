import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { HrLayout } from './HrLayout';

jest.mock('../../hooks/useHrWorkforce', () => ({
  useHrWorkforce: () => ({
    data: {
      headcount: { total: 10, active: 8, onboarding: 2, exited: 0 },
      generatedAt: new Date().toISOString(),
    },
    isLoading: false,
    refetch: jest.fn(),
  }),
}));

let mockRoles: string[] = ['ADMIN'];
jest.mock('../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../hooks/useCurrentRoles'),
  useCurrentRoles: () => mockRoles,
  useCurrentPermissions: () => [],
  canManageAssayers: () => true,
}));

/** Decisions waiting on the reader — the Approvals tab's number. `null` for anyone who cannot approve. */
let mockApprovals: number | null = 2;
jest.mock('./approvals/approval-queue', () => ({
  useApprovalCount: () => mockApprovals,
}));

jest.mock('./useImportIssues', () => ({
  useImportIssues: () => ({ loading: false, failed: false, openCount: 0 }),
}));

jest.mock('./applications/usePendingApplications', () => ({
  usePendingApplicationCount: () => 3,
}));

describe('HrLayout navigation and contextual actions', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    mockRoles = ['ADMIN'];
    mockApprovals = 2;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it('orders tabs according to the operational lifecycle: Overview -> Hiring -> People -> Pay -> Where -> Issues', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/hr']}>
          <Routes>
            <Route path="/hr/*" element={<HrLayout />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const tabs = screen.getAllByRole('link').filter((link) =>
      link.className.includes('active') || link.getAttribute('href')?.startsWith('/hr')
    );
    const tabLabels = tabs.map((t) => t.textContent?.replace(/[0-9]/g, '').trim());

    // Expect recruitment flow to be grouped right after Overview and before People
    expect(tabLabels).toEqual(
      expect.arrayContaining([
        'Overview',
        'Hiring',
        'People',
        'Pay & terms',
        'Where people are',
        'Review queue',
      ])
    );

    // Interviews, Applications and Onboarding were three tabs over one funnel — see HrHiringPage.
    expect(tabLabels).not.toContain('Interviews');
    expect(tabLabels).not.toContain('Applications');
    expect(tabLabels).not.toContain('Onboarding');

    const hiringIdx = tabLabels.indexOf('Hiring');
    const peopleIdx = tabLabels.indexOf('People');

    expect(hiringIdx).toBeGreaterThan(tabLabels.indexOf('Overview'));
    expect(peopleIdx).toBeGreaterThan(hiringIdx);
  });

  /**
   * THE HEADING NAMES THE PAGE, NOT THE SECTION.
   *
   * Every screen here used to be titled "Workforce" — under a breadcrumb that already said
   * Workforce, above a tab strip that named the page — so the one word none of them said was
   * which page you had open. Three statements of the section, none of the page, and about 90px
   * of every screen spent saying it.
   */
  it.each([
    ['/hr', 'Overview'],
    ['/hr/roster', 'People'],
    ['/hr/roster/a-1', 'People'],
    ['/hr/hiring', 'Hiring'],
    ['/hr/issues', 'Review queue'],
  ])('titles %s with the open tab: %s', (path, expected) => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/hr/*" element={<HrLayout />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(expected);
    expect(screen.queryByRole('heading', { name: 'Workforce' })).not.toBeInTheDocument();
  });

  it('renders contextual header action for /hr/roster without redundant Manage roster button', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/hr/roster']}>
          <Routes>
            <Route path="/hr/*" element={<HrLayout />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Adding somebody starts in the hiring pipeline, which is where a candidate is created.
    expect(screen.getByRole('link', { name: /Add assayer/i })).toHaveAttribute('href', '/hr/hiring');
    expect(screen.queryByRole('link', { name: /Manage roster/i })).not.toBeInTheDocument();
  });

  /**
   * The header used to carry "View applications" on Interviews and "Record interview" on
   * Applications: cross-links stitching one funnel back together across two tabs. The funnel is a
   * single page now and adding somebody is a button on it, so the header adds nothing there.
   */
  it('adds no contextual action on the hiring pipeline, which carries its own', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/hr/hiring']}>
          <Routes>
            <Route path="/hr/*" element={<HrLayout />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.queryByRole('link', { name: /View applications/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Record interview/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Manage roster/i })).not.toBeInTheDocument();
  });


  /**
   * The approver's list, and its number. For somebody who may approve, a tab carrying the decisions
   * waiting on THEM; for HR (Operations), nothing — they prepare the file, somebody above decides it,
   * and a tab they are refused on opening would be a door painted on a wall.
   */
  describe('the Approvals tab', () => {
    const draw = () => render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/hr']}>
          <Routes>
            <Route path="/hr/*" element={<HrLayout />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    it('is there for an approver, with the number waiting on them', () => {
      draw();
      const tab = screen.getByRole('link', { name: /Approvals/ });
      expect(tab).toHaveAttribute('href', '/hr/approvals');
      expect(tab).toHaveTextContent('2');
      expect(tab).toHaveAttribute('title', '2 joiners are waiting for your approval');
    });

    it('is not there for HR, who prepare the file rather than decide it', () => {
      mockRoles = ['OPERATIONS'];
      mockApprovals = null;
      draw();
      expect(screen.queryByRole('link', { name: /Approvals/ })).not.toBeInTheDocument();
      // Everything else in the section is still theirs.
      expect(screen.getByRole('link', { name: /Hiring/ })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /People/ })).toBeInTheDocument();
    });
  });
});
