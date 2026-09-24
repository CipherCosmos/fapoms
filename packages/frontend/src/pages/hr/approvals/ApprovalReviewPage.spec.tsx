import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AssayerLifecycleStatus, BackgroundCheckVerdict } from '@fapoms/shared';
import { api } from '../../../services/api';
import { ApprovalReviewPage } from './ApprovalReviewPage';

jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../../hooks/useCurrentRoles'),
  useCurrentRoles: () => ['ADMIN'],
  useCurrentPermissions: () => [],
  useCurrentUserId: () => 'boss-1',
}));

const mockRequest = api.request as jest.Mock;

/**
 * THE APPROVER'S REVIEW (owner, 2026-09-24): the approver is the final person, "who can see all the
 * details". One screen: the whole file, each part marked done or missing, and the decision beside it.
 */
describe('reviewing one person before approving them', () => {
  const doc = (requirement: string, label: string, status: string | null, files = ['scan.jpg']) => ({
    requirement, label, identity: true, id: `d-${requirement}`, filePaths: files, verificationStatus: status,
    softCopyReceived: true, hardCopyReceived: false, hardCopyLocation: null, courierReference: null, receivedAt: null,
    documentNumber: null, expiryDate: null, verifiedAt: null, holderName: null, holderDateOfBirth: null,
  });
  const person = (over: Record<string, unknown> = {}) => ({
    id: 'a-1', assayerCode: 'AS0420', displayName: 'Shivam Kumar', region: 'WEST', lifecycleStatus: AssayerLifecycleStatus.FINAL_APPROVAL,
    phone: '9822014455', email: 'shivam@example.com', address: '12 MG Road', city: 'Pune', district: 'Pune', state: 'Maharashtra', pincode: '411001',
    dateOfBirth: '1990-04-01', experienceYears: 6, qualification: 'B.Com', panNumber: 'ABCDE1234F',
    bankAccountNumber: '123456789012', ifscCode: 'HDFC0001234', latitude: 18.52, longitude: 73.85, geoSource: 'PIN',
    ...over,
  });
  const dossier = (over: Record<string, unknown> = {}) => ({
    references: [{ id: 'r-1', fullName: 'Old Manager', checkedAt: '2026-09-22' }, { id: 'r-2', fullName: 'Neighbour', checkedAt: null }],
    empanelments: [], backgroundChecks: [], openIssues: [],
    currentCheck: {
      id: 'c-1', assayerId: 'a-1', verdict: BackgroundCheckVerdict.CLEAR, checkedByName: 'AuthBridge', checkedOn: '2026-09-23', createdAt: '2026-09-23',
      reportFiles: [{ documentId: 'd-bgv', versionId: 'v-1', path: 'bgv.pdf', uploadedAt: null }],
    },
    onboarding: [doc('PAN_CARD', 'PAN card', 'VERIFIED'), doc('AADHAAR_FRONT', 'Aadhaar (front)', 'VERIFIED')],
    ...over,
  });
  const serve = (p = person(), d = dossier(), interview: unknown = { outcome: 'PASS', interviewedAt: '2026-09-24T06:23:00Z', interviewedByName: 'System Admin' }) => {
    mockRequest.mockImplementation(async (url: string) => {
      if (url.endsWith('/dossier')) return d;
      if (url.endsWith('/approval/interview')) return interview;
      if (url.endsWith('/approval')) {
        return [{ id: 'r-1', round: 1, status: 'PENDING', decidedAt: null, preparers: ['hr-1'],
          events: [{ kind: 'SUBMITTED', byId: 'hr-1', byName: 'Asha', at: '2026-09-24T07:37:00Z', text: 'All checks clear.' }] }];
      }
      if (url === '/assayers/a-1') return p;
      return {};
    });
  };
  const draw = () => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/hr/approvals/a-1']}>
        <Routes><Route path="/hr/approvals/:assayerId" element={<ApprovalReviewPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const item = (label: string) => screen.getByTestId(`review-item-${label}`);

  beforeEach(() => mockRequest.mockReset());

  it('shows the whole file, each part marked done or missing', async () => {
    serve();
    draw();

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Shivam Kumar');
    expect(screen.getByText('shivam@example.com')).toBeInTheDocument();
    expect(item('Passed')).toHaveAttribute('data-ok', 'yes'); // the interview
    expect(item('PAN card')).toHaveAttribute('data-ok', 'yes');
    expect(item('Bank account')).toHaveAttribute('data-ok', 'yes');
    expect(item('Home location')).toHaveAttribute('data-ok', 'yes');
    // Two references, one called — not everything is done, and the screen says so.
    expect(item('2 references')).toHaveAttribute('data-ok', 'no');
    expect(within(item('2 references')).getByText(/1 of 2 called/)).toBeInTheDocument();
  });

  /** The account number is money; the approver needs to know it is there, not to read it. */
  it('shows only the last four digits of the bank account', async () => {
    serve();
    draw();
    await screen.findByTestId('review-item-Bank account');
    expect(item('Bank account')).toHaveTextContent('•••• 9012');
    expect(document.body.textContent).not.toContain('123456789012');
  });

  it('marks what is missing, and will not offer Make Active until it is there', async () => {
    serve(person({ bankAccountNumber: null, latitude: null, longitude: null }), dossier({
      onboarding: [doc('PAN_CARD', 'PAN card', 'VERIFIED'), doc('AADHAAR_FRONT', 'Aadhaar (front)', null)],
    }));
    draw();

    await screen.findByTestId('review-item-Bank account');
    expect(item('Bank account')).toHaveAttribute('data-ok', 'no');
    expect(item('Home location')).toHaveAttribute('data-ok', 'no');
    expect(item('Aadhaar (front)')).toHaveAttribute('data-ok', 'no');
    expect(await screen.findByRole('button', { name: 'Approve — make Active' })).toBeDisabled();
    expect(screen.getByTestId('make-active-blockers')).toHaveTextContent(/Bank account number/);
    // Training does not wait for the bank details.
    expect(screen.getByRole('button', { name: 'Approve — send to training' })).toBeEnabled();
  });

  it('offers Make Active for a complete file', async () => {
    serve();
    draw();
    expect(await screen.findByRole('button', { name: 'Approve — make Active' })).toBeEnabled();
  });

  it('says plainly when there was no interview on this system', async () => {
    serve(person(), dossier(), null);
    draw();
    expect(await screen.findByText(/No interview on this system/)).toBeInTheDocument();
  });

  it('says the file failed to load, rather than showing an empty one', async () => {
    mockRequest.mockRejectedValue(new Error('boom'));
    draw();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/);
  });
});
