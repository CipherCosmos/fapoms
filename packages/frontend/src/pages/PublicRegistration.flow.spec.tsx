import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PublicRegistration } from './PublicRegistration';
import * as registrationApi from '../services/public-registration';
import { CURRENT_CONSENT_NOTICE, ApplicationStatus } from '@fapoms/shared';

jest.mock('../services/public-registration');

const api = registrationApi as jest.Mocked<typeof registrationApi>;

/**
 * THE WEB FORM BEHAVES LIKE THE PHONE APP'S.
 *
 * Owner, 2026-09-24: web and mobile registration "should be the same". Each test here is a place
 * the two used to differ — where the form reopens, what a phone number saves as, which agreement
 * version it names, what a withdrawn application looks like — pinned to the phone app's behaviour.
 */
const TOKEN = 'tok-flow';
const complete = {
  id: 'abcdef12-0000', fullName: 'Ramesh Kulkarni', mobile: '9822014455', email: 'r@example.com',
  dateOfBirth: '1985-03-14', gender: 'Male', address: '14 Shivaji Nagar, Pune', state: 'Maharashtra',
  city: 'Pune', pincode: '411005', experienceYears: 5, currentEmployer: null, expertise: null, availability: null,
  employmentCategory: 'FREELANCER' as never, consentAcceptedAt: '2026-09-20T00:00:00Z', consentVersion: 'v-accepted',
  status: ApplicationStatus.DRAFT, reviewNotes: null,
  extendedProfile: { fields: {}, references: [{ fullName: 'Meera Rao', phone: '9822014455' }] },
};
// The notice as it reads TODAY — deliberately a different version from the one accepted.
const notice = { ...CURRENT_CONSENT_NOTICE, version: 'v-today', grievanceContact: 'Asha Menon' };

const start = async (
  app: Record<string, unknown> = {},
  opts: { otpVerified?: boolean; documents?: unknown[] } = {},
) => {
  const application = { ...complete, ...app };
  api.hydrateRegistration.mockResolvedValue({
    application, documents: opts.documents ?? [], documentsRequested: ['PHOTOGRAPH'],
    otpVerified: opts.otpVerified ?? true, consentNotice: notice, infoRequests: [],
  } as never);
  api.updateRegistrationDraft.mockResolvedValue(application as never);
  api.checkRegistrationPhoneConflict.mockResolvedValue({ conflict: false });
  render(<MemoryRouter><PublicRegistration token={TOKEN} /></MemoryRouter>);
};

beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });
beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  window.history.replaceState(null, '', window.location.pathname);
});

describe('where the form reopens', () => {
  /** What is saved decides, not a step this browser remembered — the same rule the app uses. */
  it('ignores a step left behind in this browser, and opens where the saved answers say', async () => {
    localStorage.setItem(`fapoms_reg_step_${TOKEN}`, '1');
    window.history.replaceState(null, '', '#step-1');
    await start();
    expect(await screen.findByText('Lay flat, good light, all 4 corners.')).toBeInTheDocument();
  });

  it('pulls back to the first step that still has a problem', async () => {
    await start({ dateOfBirth: null });
    expect(await screen.findByLabelText('Date of birth *')).toBeInTheDocument();
    expect(screen.queryByText('Lay flat, good light, all 4 corners.')).not.toBeInTheDocument();
  });

  it('names its steps the way the phone app does', async () => {
    await start();
    for (const name of ['Personal & contact', 'Experience & address', 'ID & bank', 'Documents & submit']) {
      expect(await screen.findByRole('button', { name })).toBeInTheDocument();
    }
  });
});

describe('the mobile number', () => {
  const phoneBox = () => screen.findByLabelText('Your mobile number *');

  it('saves the tidied ten digits when the number is a real mobile', async () => {
    await start({ dateOfBirth: null }, { otpVerified: false });
    const box = await phoneBox();
    fireEvent.change(box, { target: { value: '+91 98220-14455' } });
    fireEvent.blur(box);
    await waitFor(() => expect(api.updateRegistrationDraft).toHaveBeenCalledWith(TOKEN, { mobile: '9822014455' }));
  });

  /** It used to save whatever was typed — "12345" included — as the number on the record. */
  it('saves nothing when the number does not tidy into a real mobile', async () => {
    await start({ dateOfBirth: null }, { otpVerified: false });
    const box = await phoneBox();
    fireEvent.change(box, { target: { value: '12345' } });
    fireEvent.blur(box);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.updateRegistrationDraft).not.toHaveBeenCalledWith(TOKEN, expect.objectContaining({ mobile: expect.anything() }));
  });

  it('will not send fewer than six digits as a code', async () => {
    api.requestRegistrationOtp.mockResolvedValue({ sent: true, channel: 'SMS', sentTo: '••••• 4455' });
    api.otpSentWords.mockReturnValue('A 6-digit code has been texted to ••••• 4455.');
    await start({ dateOfBirth: null }, { otpVerified: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Send code' }));

    const codeBox = await screen.findByLabelText('The 6-digit verification code');
    fireEvent.change(codeBox, { target: { value: '123' } });
    expect(screen.getByRole('button', { name: 'Verify code' })).toBeDisabled();
    expect(api.verifyRegistrationOtp).not.toHaveBeenCalled();
  });

  it('shows a verified number as the number and a badge, nothing more', async () => {
    await start({ dateOfBirth: null });
    expect(await screen.findByText('+91 9822014455')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.queryByText(/is confirmed and verified/)).not.toBeInTheDocument();
  });

  // Where the shared step rules check it (and where the phone app asks for it): with the other
  // contact numbers, not on step 1 — so an error on it is shown on the step that raises it.
  it('does not ask for the alternate number on step 1', async () => {
    await start({ dateOfBirth: null });
    await screen.findByLabelText(/Date of birth/);
    expect(screen.queryByLabelText(/Your alternate number/)).not.toBeInTheDocument();
  });
});

describe('the agreement', () => {
  it('names the version they accepted, not the one the notice is on today', async () => {
    await start();
    await screen.findByText('Lay flat, good light, all 4 corners.');
    expect(screen.getByText(/Version v-accepted/)).toBeInTheDocument();
    expect(screen.queryByText(/v-today/)).not.toBeInTheDocument();
    expect(screen.getByText(/Questions about your details: Asha Menon/)).toBeInTheDocument();
  });

  /** A real dialog, not the browser's prompt box — and the reason is optional. */
  it('asks once, in the app\'s own dialog, before withdrawing', async () => {
    const prompt = jest.spyOn(window, 'prompt').mockImplementation(() => null);
    api.withdrawRegistrationConsent.mockResolvedValue({ ...complete, status: ApplicationStatus.WITHDRAWN } as never);
    await start();
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));

    expect(await screen.findByText('Withdraw your application?')).toBeInTheDocument();
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Withdraw' }).at(-1)!);

    await waitFor(() => expect(api.withdrawRegistrationConsent).toHaveBeenCalledWith(TOKEN, undefined));
    expect(await screen.findByRole('heading', { name: 'Application withdrawn' })).toBeInTheDocument();
    prompt.mockRestore();
  });

  it('keeps the application when they change their mind', async () => {
    await start();
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep my application' }));
    expect(api.withdrawRegistrationConsent).not.toHaveBeenCalled();
  });
});

describe('a finished application', () => {
  it('says a withdrawn application plainly — a neutral heading, no reference or contact panel', async () => {
    await start({ status: ApplicationStatus.WITHDRAWN });
    expect(await screen.findByRole('heading', { name: 'Application withdrawn' })).toBeInTheDocument();
    expect(screen.getByText(/You withdrew this application/)).toBeInTheDocument();
    expect(screen.queryByText(/9822014455/)).not.toBeInTheDocument();
    expect(screen.queryByText(/r@example.com/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Reference/)).not.toBeInTheDocument();
  });

  it('says a submitted one in a line, with the reference to quote', async () => {
    await start({ status: ApplicationStatus.PENDING_VALIDATION });
    expect(await screen.findByRole('heading', { name: 'Submitted. HR will call you.' })).toBeInTheDocument();
    expect(screen.getByText('#APP-ABCDEF12')).toBeInTheDocument();
  });

  it('says a link that does not work in one line', async () => {
    api.hydrateRegistration.mockRejectedValue(new Error('gone'));
    render(<MemoryRouter><PublicRegistration token={TOKEN} /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Link not working — ask HR for a new one.' })).toBeInTheDocument();
  });
});

describe('the words on the form', () => {
  it('marks date of birth as required, like the other required boxes', async () => {
    await start({ dateOfBirth: null });
    expect(await screen.findByLabelText('Date of birth *')).toBeInTheDocument();
  });

  it('moves on with a plain "Next", and back with "Back"', async () => {
    await start({ dateOfBirth: null });
    await screen.findByLabelText('Date of birth *');
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
    expect(screen.queryByText(/Continue to/)).not.toBeInTheDocument();
  });
});
