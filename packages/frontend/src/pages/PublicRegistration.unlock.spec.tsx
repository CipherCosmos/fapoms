import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PublicRegistration } from './PublicRegistration';
import * as registrationApi from '../services/public-registration';
import { CURRENT_CONSENT_NOTICE, ApplicationStatus } from '@fapoms/shared';

jest.mock('../services/public-registration', () => ({
  ...jest.requireActual('../services/public-registration'),
  hydrateRegistration: jest.fn(),
  requestRegistrationOtp: jest.fn(),
  verifyRegistrationOtp: jest.fn(),
}));

const api = registrationApi as jest.Mocked<typeof registrationApi>;

/**
 * THE LINK OPENS THE FORM; THE CODE OPENS WHAT IS ALREADY IN IT.
 *
 * With answers or scans on file and no code proven in this tab, the server withholds them and says
 * so (`sensitiveLocked`). The page must then ask for a code — sent to the number already on the
 * application — BEFORE it shows the form, and reopen the form once the code is right.
 */
describe('a link with saved answers, opened without a code', () => {
  const application = {
    id: 'app-1', fullName: 'Ramesh Kulkarni', mobile: '9822014455', email: null,
    dateOfBirth: null, gender: null, address: null, state: null, city: null, pincode: null,
    experienceYears: null, currentEmployer: null, expertise: null, availability: null,
    employmentCategory: 'FREELANCER' as never, consentAcceptedAt: new Date().toISOString(), consentVersion: 'v',
    status: ApplicationStatus.DRAFT, reviewNotes: null, extendedProfile: { fields: {} },
  };
  const notice = { ...CURRENT_CONSENT_NOTICE, grievanceContact: 'x' };
  const locked = {
    application, documents: [], documentsRequested: [], otpVerified: false, consentNotice: notice,
    sensitiveLocked: true, sensitiveOnFile: { fields: ['panNumber'], scans: 1 },
  };
  const open = {
    ...locked, sensitiveLocked: false, sessionVerified: true,
    application: { ...application, extendedProfile: { fields: { panNumber: 'ABCDE1234F' } } },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    api.hydrateRegistration.mockResolvedValueOnce(locked as never).mockResolvedValue(open as never);
    api.requestRegistrationOtp.mockResolvedValue({ sent: true, channel: 'SMS', sentTo: '••••• 4455', cooldownSeconds: 0 } as never);
    api.verifyRegistrationOtp.mockResolvedValue({ verified: true, channel: 'SMS', sessionKey: 'k' } as never);
  });

  const renderForm = () => render(<MemoryRouter><PublicRegistration token="tok-123" /></MemoryRouter>);

  it('asks for a code before showing any of the form', async () => {
    renderForm();
    expect(await screen.findByTestId('unlock-saved-answers')).toBeInTheDocument();
    expect(screen.getByText(/ending 4455/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/full name/i)).not.toBeInTheDocument();
  });

  it('sends the code to the number on file, and opens the form once it is right', async () => {
    renderForm();
    await screen.findByTestId('unlock-saved-answers');
    await userEvent.click(screen.getByRole('button', { name: /send code/i }));
    await waitFor(() => expect(api.requestRegistrationOtp).toHaveBeenCalledWith('tok-123', '9822014455'));

    await userEvent.type(await screen.findByLabelText(/6-digit code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(api.verifyRegistrationOtp).toHaveBeenCalledWith('tok-123', '9822014455', '123456'));
    await waitFor(() => expect(screen.queryByTestId('unlock-saved-answers')).not.toBeInTheDocument());
    expect(api.hydrateRegistration).toHaveBeenCalledTimes(2);
  });
});
