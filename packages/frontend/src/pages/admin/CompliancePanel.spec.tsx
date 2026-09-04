import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CompliancePanel } from './CompliancePanel';
import { api } from '../../services/api';
import { SystemRole } from '@fapoms/shared';

/**
 * ComplianceController gates every write route `@Roles(SystemRole.ADMIN)` only — reads are open to
 * ADMIN and AUDITOR alike (see compliance.controller.ts). Confirmed live (Track P) that the backend
 * genuinely refuses an AUDITOR's write attempts (403), but the panel itself rendered every write
 * control regardless of role: an AUDITOR saw "Raise incident" and all the per-incident milestone
 * buttons, and clicking one sent a real PATCH that the server then had to reject — the mutation was
 * silently swallowed with no error shown, so the click just looked like it did nothing. These tests
 * pin the fix: the panel must not offer a control the signed-in role cannot use.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../hooks/useCurrentRoles', () => {
  const actual = jest.requireActual('../../hooks/useCurrentRoles');
  return { ...actual, useCurrentRoles: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useCurrentRoles } = require('../../hooks/useCurrentRoles');
const mockUseCurrentRoles = useCurrentRoles as jest.Mock;
const mockRequest = api.request as jest.Mock;

const health = {
  auditUnsealed: 0,
  incidents: { total: 1, open: 1, certInOverdue: 0, boardOverdue: 0, principalsOverdue: 1 },
  rightsRequests: { open: 0, overdue: 0 },
};

// One open, personal-data incident with CERT-In already reported but neither DPDP milestone reached —
// every write button the panel can offer for an incident in this state should be a candidate to render.
const incident = {
  id: 'inc-1',
  title: 'QATRACK-P test fixture incident',
  category: 'DATA_BREACH',
  severity: 'CRITICAL',
  status: 'OPEN',
  description: null,
  detectedAt: '2026-09-04T00:00:00.000Z',
  personalDataInvolved: true,
  affectedDataPrincipals: 10,
  certInReportedAt: '2026-09-04T01:00:00.000Z',
  boardNotifiedAt: null,
  principalsNotifiedAt: null,
  remediation: null,
  resolvedAt: null,
  clocks: {
    certIn: { applicable: true, dueAt: '2026-09-04T06:00:00.000Z', hoursRemaining: null, satisfied: true, overdue: false },
    dpdpBoard: { applicable: true, dueAt: '2026-09-07T00:00:00.000Z', hoursRemaining: 71, satisfied: false, overdue: false },
    dpdpPrincipals: { applicable: true, dueAt: null, hoursRemaining: null, satisfied: false, overdue: false },
  },
};

const renderPanel = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><CompliancePanel /></QueryClientProvider>);
};

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockImplementation((url: string) => {
    if (url === '/admin/compliance/health') return Promise.resolve(health);
    if (url === '/admin/compliance/incidents') return Promise.resolve([incident]);
    if (url === '/admin/compliance/rights-requests') return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
});

describe('CompliancePanel — role-gated write controls', () => {
  it('ADMIN sees every write control: raise incident, and all three milestone buttons plus Resolve', async () => {
    mockUseCurrentRoles.mockReturnValue([SystemRole.ADMIN]);
    renderPanel();

    await waitFor(() => expect(screen.getByText(/QATRACK-P test fixture incident/)).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /Raise incident/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark Board notified' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark people notified' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    // Already satisfied — must not offer to mark it again.
    expect(screen.queryByRole('button', { name: 'Mark CERT-In reported' })).not.toBeInTheDocument();
  });

  it('AUDITOR (read-only per the backend) sees no write control anywhere on the page', async () => {
    mockUseCurrentRoles.mockReturnValue([SystemRole.AUDITOR]);
    renderPanel();

    await waitFor(() => expect(screen.getByText(/QATRACK-P test fixture incident/)).toBeInTheDocument());

    // The data itself is still visible — AUDITOR reads the register, just cannot write to it.
    expect(screen.getByText(/QATRACK-P test fixture incident/)).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /Raise incident/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark Board notified' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark people notified' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark CERT-In reported' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });

  it('renders the real 72h DPDP clock on the Board milestone, and no fabricated countdown on the Data-Principal one', async () => {
    // Regression pin for the swapped-milestone bug: DPDP Rule 7's 72-hour figure belongs to the
    // Board's breach report, not to Data-Principal notification (which the rule gives no fixed hour
    // count at all — "without delay"). See incident-clocks.ts.
    mockUseCurrentRoles.mockReturnValue([SystemRole.ADMIN]);
    renderPanel();
    await waitFor(() => expect(screen.getByText(/QATRACK-P test fixture incident/)).toBeInTheDocument());

    const findBadgeText = (needle: string) =>
      screen.getByText((_, el) =>
        el !== null && el.tagName.toLowerCase() === 'span' &&
        (el.textContent || '').replace(/\s+/g, ' ').trim().includes(needle));

    expect(findBadgeText('DPDP Board: 71h left')).toBeInTheDocument();
    expect(findBadgeText('Notify people: without delay')).toBeInTheDocument();
  });
});
