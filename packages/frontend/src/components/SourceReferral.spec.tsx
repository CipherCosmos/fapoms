import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CURRENT_CONSENT_NOTICE, ApplicationStatus, InterviewOutcome } from '@fapoms/shared';
import { AddCandidateDialog } from '../pages/hr/hiring/AddCandidateDialog';
import { SourceReferralEditor } from '../pages/hr/record/SourceReferralEditor';
import { PublicRegistration } from '../pages/PublicRegistration';
import * as registrationApi from '../services/public-registration';
import { api } from '../services/api';

/**
 * WHO REFERRED AN ASSAYER — the source reference (owner, 2026-09-23). HR records it at intake; the
 * candidate may give it on their form when HR has not; HR can change it on the record.
 */
jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../services/public-registration');
const mockRequest = api.request as jest.Mock;
const regApi = registrationApi as jest.Mocked<typeof registrationApi>;

const fillReferrer = (prefix: string, v: { type?: string; name?: string; mobile?: string; email?: string }) => {
  if (v.type !== undefined) fireEvent.change(document.getElementById(`${prefix}-type`)!, { target: { value: v.type } });
  if (v.name !== undefined) fireEvent.change(document.getElementById(`${prefix}-name`)!, { target: { value: v.name } });
  if (v.mobile !== undefined) fireEvent.change(document.getElementById(`${prefix}-mobile`)!, { target: { value: v.mobile } });
  if (v.email !== undefined) fireEvent.change(document.getElementById(`${prefix}-email`)!, { target: { value: v.email } });
};

beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });
beforeEach(() => { jest.clearAllMocks(); mockRequest.mockReset(); localStorage.clear(); window.history.replaceState(null, '', window.location.pathname); });

describe('Add candidate', () => {
  const draw = () => render(
    <QueryClientProvider client={new QueryClient()}><AddCandidateDialog open onClose={jest.fn()} onAdded={jest.fn()} /></QueryClientProvider>,
  );
  const basics = () => {
    fireEvent.change(screen.getByPlaceholderText('As printed on their Aadhaar or PAN'), { target: { value: 'Ramesh Kumar' } });
    fireEvent.change(screen.getByPlaceholderText('10 digits'), { target: { value: '9876543210' } });
  };

  it('sends who referred them with the interview', async () => {
    mockRequest.mockResolvedValue({ id: 'int-1', candidateName: 'Ramesh Kumar', outcome: InterviewOutcome.FAIL, email: null });
    draw(); basics();
    fillReferrer('add-referral', { type: 'ASSAYER', name: 'Ravi Kumar', mobile: '9876500000' });
    fireEvent.click(screen.getByRole('button', { name: 'Did not pass' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record interview' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayer-interviews', expect.anything()));
    expect(JSON.parse(mockRequest.mock.calls[0][1].body).sourceReferral)
      .toEqual({ type: 'ASSAYER', name: 'Ravi Kumar', mobile: '9876500000', email: '' });
  });

  it('says what is missing before sending a referrer nobody could reach', async () => {
    draw(); basics();
    fillReferrer('add-referral', { type: 'STAFF', name: 'Ravi Kumar' });
    fireEvent.click(screen.getByRole('button', { name: 'Did not pass' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record interview' }));

    expect(await screen.findByText(/Give a mobile or an email for Ravi Kumar/)).toBeInTheDocument();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('sends it on the no-interview route too', async () => {
    mockRequest.mockResolvedValue({ applicationId: 'app-1', emailDelivery: null, inviteLink: 'https://x/r/t' });
    draw();
    fireEvent.click(screen.getByRole('tab', { name: 'Add without an interview' }));
    basics();
    fireEvent.change(screen.getByPlaceholderText(/Walk-in at the Kochi branch/), { target: { value: 'Referred by the Kochi branch manager' } });
    fillReferrer('add-referral', { type: 'BANK_BRANCH', name: 'Kochi branch manager', email: 'kochi@bank.in' });
    fireEvent.click(screen.getByRole('button', { name: 'Add and send their form' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/hr/applications/invite', expect.anything()));
    expect(JSON.parse(mockRequest.mock.calls[0][1].body).sourceReferral).toMatchObject({ type: 'BANK_BRANCH', email: 'kochi@bank.in' });
  });
});

describe('the assayer record', () => {
  it('shows who referred them, and lets HR change it', async () => {
    mockRequest.mockResolvedValue({});
    const onSaved = jest.fn();
    render(<SourceReferralEditor assayerId="a-1" canManage onSaved={onSaved}
      value={{ type: 'ASSAYER' as never, name: 'Ravi Kumar', mobile: '9876500000', email: null, recordedBy: 'CANDIDATE' }} />);

    expect(screen.getByText(/Ravi Kumar \(an assayer of ours\) · 9876500000/)).toBeInTheDocument();
    expect(screen.getByText(/as they gave it on their form/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fillReferrer('record-referral', { type: 'STAFF' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayers/a-1/source-referral', expect.objectContaining({ method: 'PUT' })));
    expect(JSON.parse(mockRequest.mock.calls[0][1].body).sourceReferral).toMatchObject({ type: 'STAFF', name: 'Ravi Kumar' });
    expect(onSaved).toHaveBeenCalled();
  });

  it('offers nothing to change to somebody who may not', () => {
    render(<SourceReferralEditor assayerId="a-1" canManage={false} onSaved={jest.fn()} value={null} />);
    expect(screen.getByText('Nobody recorded')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('the candidate form', () => {
  const TOKEN = 'tok-ref';
  const start = async (sourceReferral?: Record<string, unknown>) => {
    const application = {
      id: 'app-1', fullName: 'Ramesh Kulkarni', mobile: '9822014455', email: 'r@example.com',
      dateOfBirth: '1985-03-14', gender: 'Male', address: '14 Shivaji Nagar, Pune', state: 'Maharashtra',
      city: 'Pune', pincode: '411005', experienceYears: 5, currentEmployer: null, expertise: null, availability: null,
      employmentCategory: 'FREELANCER', consentAcceptedAt: '2026-09-20T00:00:00Z', consentVersion: CURRENT_CONSENT_NOTICE.version,
      status: ApplicationStatus.DRAFT, reviewNotes: null,
      extendedProfile: { fields: {}, references: [], ...(sourceReferral ? { sourceReferral } : {}) },
    };
    regApi.hydrateRegistration.mockResolvedValue({
      application, documents: [], documentsRequested: ['PHOTOGRAPH'], otpVerified: true,
      consentNotice: { ...CURRENT_CONSENT_NOTICE, grievanceContact: 'Asha' }, infoRequests: [],
    } as never);
    regApi.updateRegistrationDraft.mockImplementation(async () => application as never);
    render(<MemoryRouter><PublicRegistration token={TOKEN} /></MemoryRouter>);
    // Complete up to the documents, so it reopens on step 4; step 2 is one press back.
    fireEvent.click(await screen.findByRole('button', { name: 'Experience & address' }));
  };

  it('shows HR\'s entry and does not ask', async () => {
    await start({ type: 'STAFF', name: 'Asha Menon', mobile: '9876500000', email: null, recordedBy: 'HR' });
    expect(await screen.findByText(/Asha Menon \(our staff\).*recorded by our HR team/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Someone referred me/ })).not.toBeInTheDocument();
    expect(document.getElementById('reg-referral-name')).toBeNull();
  });

  /** Optional, so folded away until they say somebody referred them. */
  it('keeps the boxes folded away behind one line until asked for', async () => {
    await start();
    const toggle = await screen.findByRole('button', { name: /Someone referred me/ });
    expect(document.getElementById('reg-referral-name')).toBeNull();
    fireEvent.click(toggle);
    expect(document.getElementById('reg-referral-name')).not.toBeNull();
  });

  it('opens already when they gave a referrer before', async () => {
    await start({ type: 'ASSAYER', name: 'Ravi Kumar', mobile: '9876500000', email: null, recordedBy: 'CANDIDATE' });
    await screen.findByText('Who referred you');
    expect(document.getElementById('reg-referral-name')).toHaveValue('Ravi Kumar');
  });

  it('saves the candidate\'s own entry once they leave the group, and not before', async () => {
    await start();
    fireEvent.click(await screen.findByRole('button', { name: /Someone referred me/ }));
    fillReferrer('reg-referral', { type: 'ASSAYER', name: 'Ravi Kumar' });
    // Moving between the boxes is not leaving the group — no "incomplete" complaint yet.
    fireEvent.blur(document.getElementById('reg-referral-name')!, { relatedTarget: document.getElementById('reg-referral-mobile') });
    expect(screen.queryByText(/Give a mobile or an email/)).not.toBeInTheDocument();

    fillReferrer('reg-referral', { mobile: '9876500000' });
    fireEvent.blur(document.getElementById('reg-referral-mobile')!, { relatedTarget: null });
    await waitFor(() => expect(regApi.updateRegistrationDraft).toHaveBeenCalledWith(TOKEN, {
      sourceReferral: { type: 'ASSAYER', name: 'Ravi Kumar', mobile: '9876500000', email: '' },
    }));
  });
});
