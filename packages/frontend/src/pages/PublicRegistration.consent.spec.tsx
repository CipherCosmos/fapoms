import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PublicRegistration } from './PublicRegistration';
import * as registrationApi from '../services/public-registration';
import { CURRENT_CONSENT_NOTICE, ApplicationStatus } from '@fapoms/shared';

jest.mock('../services/public-registration');

const api = registrationApi as jest.Mocked<typeof registrationApi>;

/**
 * THE NOTICE COMES BEFORE THE FORM, NOT AFTER IT.
 *
 * The tick-box used to live on the last step, beside Submit: by then the name, PAN, Aadhaar, bank
 * account and every scan had been typed, uploaded and saved. What is being pinned here is the
 * ORDER — that the first screen is what we are asking for and why, and that no box exists to type
 * into until the person has agreed to it.
 */
describe('the first thing a candidate sees', () => {
  const application = {
    id: 'app-1', fullName: 'Ramesh Kulkarni', mobile: '9822014455', email: null,
    dateOfBirth: null, gender: null, address: null, state: null, city: null, pincode: null,
    experienceYears: null, currentEmployer: null, expertise: null, availability: null,
    employmentCategory: 'FREELANCER' as never, consentAcceptedAt: null, consentVersion: null,
    status: ApplicationStatus.DRAFT, reviewNotes: null, extendedProfile: null,
  };
  const notice = { ...CURRENT_CONSENT_NOTICE, grievanceContact: 'Asha Menon · privacy@example.in' };

  // The page takes its token as a prop — App.tsx matches the /register/<token> path itself.
  const renderForm = () => render(
    <MemoryRouter><PublicRegistration token="tok-123" /></MemoryRouter>,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    api.hydrateRegistration.mockResolvedValue({
      application, documents: [], documentsRequested: [], otpVerified: false, consentNotice: notice,
    } as never);
    api.acceptRegistrationConsent.mockResolvedValue({
      ...application, consentAcceptedAt: new Date().toISOString(), consentVersion: notice.version,
    } as never);
  });

  it('shows what is collected and why, before any box to type into', async () => {
    renderForm();

    expect(await screen.findByText(notice.title)).toBeInTheDocument();
    for (const purpose of notice.purposes) {
      expect(screen.getByText(purpose.what)).toBeInTheDocument();
    }
    expect(screen.getByText(notice.retention)).toBeInTheDocument();
    expect(screen.getByText('Asha Menon · privacy@example.in')).toBeInTheDocument();
    // No form yet: not one field of it.
    expect(screen.queryByLabelText(/full name/i)).not.toBeInTheDocument();
  });

  it('will not let them past until they have ticked it', async () => {
    renderForm();
    await screen.findByText(notice.title);

    const agree = screen.getByRole('button', { name: /I agree/i });
    expect(agree).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox'));
    expect(agree).toBeEnabled();
  });

  /** What the row records and what the person read have to be the same wording. */
  it('records the version the server served, not one written into the page', async () => {
    renderForm();
    await screen.findByText(notice.title);
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /I agree/i }));

    await waitFor(() => expect(api.acceptRegistrationConsent).toHaveBeenCalledWith('tok-123', notice.version));
    expect(api.acceptRegistrationConsent).not.toHaveBeenCalledWith('tok-123', 'v1');
  });

  it('opens the form once they have agreed', async () => {
    api.hydrateRegistration.mockResolvedValue({
      application: { ...application, consentAcceptedAt: new Date().toISOString(), consentVersion: notice.version },
      documents: [], documentsRequested: [], otpVerified: false, consentNotice: notice,
    } as never);

    renderForm();

    await waitFor(() => expect(screen.queryByText(notice.title)).not.toBeInTheDocument());
    // The wizard is open: its first step, and a box to type into.
    expect(await screen.findAllByText(/Personal & Contact/i)).not.toHaveLength(0);
  });
});
