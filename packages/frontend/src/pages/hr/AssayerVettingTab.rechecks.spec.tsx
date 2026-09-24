import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { CheckType } from '@fapoms/shared';

import { AssayerVettingTab } from './AssayerVettingTab';
import { api } from '../../services/api';

/**
 * RE-CHECKS OVER TIME, on the Background tab (owner, 2026-09-23): where each check stands, a
 * dialog that records any of the four with its own report, and the senior's decision when one
 * comes back adverse on somebody working.
 */
jest.mock('../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../hooks/useCurrentRoles'),
  useCurrentRoles: () => ['ADMIN'],
  useCurrentPermissions: () => [],
  useCurrentUserId: () => mockUserId,
}));
let mockUserId = 'boss-1';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../components/ui', () => ({
  useToast: () => ({ toast: jest.fn() }),
  useConfirm: () => ({
    confirm: () => Promise.resolve(true),
    confirmWithReason: () => Promise.resolve({
      confirmed: true,
      reason: 'Maiden name on the card, married name already on the record',
    }),
    confirmDialog: null,
  }),
  // A real (native) select rather than a plain input, so a test can see the actual option list —
  // in particular the "as recorded"/"Other" escape-hatch entries the relationship and standing-
  // reason dropdowns add for a value that predates their fixed lists (see reference-vocabulary.ts
  // and empanelment-reason-vocabulary.ts). Nothing else on this tab drives a Select through
  // `fireEvent.change`, so widening the stub from an <input> costs none of the existing tests.
  Select: ({ value, onChange, options, 'aria-label': ariaLabel }: any) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o: any) => (
        <option key={o.value} value={o.value}>{typeof o.label === 'string' ? o.label : o.value}</option>
      ))}
    </select>
  ),
  AlertBanner: ({ message, children }: any) => (message || children ? <div role="alert">{message ?? children}</div> : null),
  SkeletonList: () => <div data-testid="skeleton" />,
  // The real one. This tab's five tables ARE DataTable now, so stubbing it would leave these
  // tests asserting against an empty document — and a stub of a table is a second table, which is
  // the thing the convergence removed.
  DataTable: jest.requireActual('../../components/ui/DataTable').DataTable,
  // The real one, for the same reason. All four of this tab's editors are ONE `Editor` over one
  // `Modal` now, and the footer holding Cancel and Save is the Modal's — a stub that drops
  // `footer` (as this one did) hides every Save button on the tab, and a stub that reimplements
  // it is the second dialog the convergence removed.
  Modal: jest.requireActual('../../components/ui/Modal').Modal,
  // The real one. The verdict and verification chips render through this now, and it is a plain
  // presentational span — nothing here is worth a stub, and a stub would leave the "Verified" /
  // "Rejected" / verdict-label assertions below with no text to find.
  StatusBadge: jest.requireActual('../../components/ui/StatusBadge').StatusBadge,
}));

const mockRequest = api.request as jest.Mock;

const dossier = (over: Record<string, unknown> = {}) => ({
  references: [
    { id: 'r-1', fullName: 'Old Manager', relationship: 'Former manager', phone: '+919000000000', checkedAt: null },
  ],
  empanelments: [],
  backgroundChecks: [],
  currentCheck: null,
  onboarding: [],
  openIssues: [],
  ...over,
});

const serve = (payload: ReturnType<typeof dossier>, clients: { id: string; name: string }[] = []) => {
  mockRequest.mockImplementation((url: string) => {
    if (url.endsWith('/dossier')) return Promise.resolve(payload);
    if (url.startsWith('/clients')) return Promise.resolve(clients);
    return Promise.resolve({});
  });
};

beforeEach(() => { mockRequest.mockReset(); mockUserId = 'boss-1'; });

const standing = (type: string, status: string, over: Record<string, unknown> = {}) => ({
  type, status, dueOn: '2026-06-15', blockFrom: '2026-07-15', lastCheckedOn: '2025-06-15', lastVerdict: 'CLEAR', because: null, ...over,
});
const compliance = (over: Record<string, unknown> = {}) => ({
  rechecked: true,
  standings: [
    standing(CheckType.BGV, 'OK', { dueOn: '2027-06-15' }),
    standing(CheckType.POLICE, 'BLOCKED'),
    standing(CheckType.CREDIT, 'DUE_SOON', { dueOn: '2026-10-10' }),
    standing(CheckType.IDENTITY, 'OK', { lastCheckedOn: null, lastVerdict: null, dueOn: '2026-12-31', because: 'Never checked since this began' }),
  ],
  hold: null,
  blockers: ['Police verification overdue since 2026-06-15'],
  ...over,
});
const posts = (path: string) => mockRequest.mock.calls.filter(([u, o]: any[]) => u.includes(path) && o?.method === 'POST');

describe('re-checks over time on the Background tab', () => {
  it('says where each check stands, and records the one asked for with its own report', async () => {
    serve(dossier({
      compliance: compliance(),
      onboarding: [{ id: 'd-pol', requirement: 'POLICE_CERTIFICATE', label: 'Police verification certificate', filePaths: ['p.pdf'], issuedBy: 'Shivajinagar PS' }],
      reportPending: { POLICE_CERTIFICATE: [{ documentId: 'd-pol', versionId: 'v-1', path: 'p.pdf', uploadedAt: null, index: 0 }] },
    }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);

    expect(await screen.findByText('Re-checks over time')).toBeInTheDocument();
    expect(screen.getByText('Overdue — held from new work')).toBeInTheDocument();
    expect(screen.getByText('Due soon')).toBeInTheDocument();
    expect(screen.getByText(/Never checked since this began/)).toBeInTheDocument();

    // "Record" on the police row opens the dialog on that check, with its issuer and its report.
    fireEvent.click(screen.getAllByRole('button', { name: 'Record' })[1]);
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Record a police verification')).toBeInTheDocument();
    // The row decided which check this is; the dialog offers no way to record a different one.
    expect(dialog.queryByRole('group', { name: 'Which check' })).not.toBeInTheDocument();
    expect(dialog.getByLabelText('Issuing police station')).toHaveValue('Shivajinagar PS');
    expect(dialog.getByText('Uploaded (1 file) — from Shivajinagar PS')).toBeInTheDocument();
    // Risk yes, credit fields no — they belong to the credit check.
    expect(dialog.queryByText('Credit band')).not.toBeInTheDocument();

    fireEvent.click(dialog.getByRole('button', { name: 'Record check' }));
    await waitFor(() => expect(posts('/background-check')).toHaveLength(1));
    expect(JSON.parse(posts('/background-check')[0][1].body)).toMatchObject({ checkType: 'POLICE', checkedByName: 'Shivajinagar PS', verdict: 'CLEAR' });
  });

  it('asks the identity re-check what was re-checked, and takes no report for it', async () => {
    serve(dossier({ compliance: compliance() }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Record' }))[3]);
    const dialog = within(await screen.findByRole('dialog'));

    expect(dialog.queryByText('Report for this check')).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Record check' }));
    await waitFor(() => expect(dialog.getByRole('alert')).toHaveTextContent(/Say which identity documents were re-checked/));
    expect(posts('/background-check')).toHaveLength(0);
  });

  it('lets a senior decide an adverse re-check — keep them working, with the reason', async () => {
    serve(dossier({
      compliance: compliance({ hold: { checkId: 'chk-9', checkType: CheckType.CREDIT, verdict: 'ADVERSE_FINDING', since: '2026-09-20', recordedBy: 'hr-1' } }),
      backgroundChecks: [{ id: 'chk-9', checkType: 'CREDIT', verdict: 'ADVERSE_FINDING', checkedOn: '2026-09-20', findings: 'Two defaults', createdBy: 'hr-1', reviewStatus: 'PENDING', reportFiles: [] }],
    }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);

    expect(await screen.findByText(/Held from new work since 2026-09-20 until a senior decides/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep them working' }));
    expect(await screen.findByText(/Say why/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Why — kept on their record'), { target: { value: 'Defaults settled in full; letters seen.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Keep them working' }));
    await waitFor(() => expect(posts('/checks/chk-9/review')).toHaveLength(1));
    expect(JSON.parse(posts('/checks/chk-9/review')[0][1].body)).toEqual({ decision: 'KEEP', reason: 'Defaults settled in full; letters seen.' });
  });

  it('does not offer the decision to whoever recorded the check', async () => {
    mockUserId = 'hr-1';
    serve(dossier({
      compliance: compliance({ hold: { checkId: 'chk-9', checkType: CheckType.CREDIT, verdict: 'ADVERSE_FINDING', since: '2026-09-20', recordedBy: 'hr-1' } }),
      backgroundChecks: [{ id: 'chk-9', checkType: 'CREDIT', verdict: 'ADVERSE_FINDING', checkedOn: '2026-09-20', createdBy: 'hr-1', reviewStatus: 'PENDING', reportFiles: [] }],
    }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);
    expect(await screen.findByText(/You recorded this check, so somebody else has to decide it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep them working' })).not.toBeInTheDocument();
  });

  it('lists every check over time with its kind and, when there was one, the decision', async () => {
    serve(dossier({
      backgroundChecks: [
        { id: 'c-3', checkType: 'POLICE', verdict: 'CRIMINAL_CASE', checkedOn: '2026-09-01', reviewStatus: 'KEPT', reviewReason: 'Acquitted in 2019', reportFiles: [] },
        { id: 'c-1', checkType: 'BGV', verdict: 'CLEAR', checkedOn: '2025-01-01', reportFiles: [] },
      ],
      currentCheck: { id: 'c-1', checkType: 'BGV', verdict: 'CLEAR', checkedOn: '2025-01-01', reportFiles: [] },
    }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);
    expect(await screen.findByText('Police verification')).toBeInTheDocument();
    expect(screen.getByText('Kept working — Acquitted in 2019')).toBeInTheDocument();
  });
});
