import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PublicRegistration } from './PublicRegistration';
import * as registrationApi from '../services/public-registration';
import { CURRENT_CONSENT_NOTICE, ApplicationStatus } from '@fapoms/shared';

jest.mock('../services/public-registration');

const api = registrationApi as jest.Mocked<typeof registrationApi>;

/**
 * The account a candidate is paid into — typed twice, and evidenced by a passbook.
 *
 * Indian account numbers carry no check digit, so a wrong digit still "looks right". Typing it a
 * second time is the one check that catches it without asking a bank, and the passbook is what a
 * reviewer later checks the number against — which is why the form will not submit without one.
 */
describe('the bank account on the candidate form', () => {
  const TOKEN = 'tok-bank';
  const application = (fields: Record<string, unknown> = {}) => ({
    id: 'app-1', fullName: 'Ramesh Kulkarni', mobile: '9822014455', email: 'r@example.com',
    dateOfBirth: '1985-03-14', gender: 'Male', address: '14 Shivaji Nagar, Pune', state: 'Maharashtra',
    city: 'Pune', pincode: '411005', experienceYears: 5, currentEmployer: null, expertise: null, availability: null,
    employmentCategory: 'FREELANCER' as never, consentAcceptedAt: '2026-09-20T00:00:00Z', consentVersion: CURRENT_CONSENT_NOTICE.version,
    status: ApplicationStatus.DRAFT, reviewNotes: null,
    extendedProfile: { fields, references: [{ fullName: 'Meera Rao', phone: '9822014455' }] },
  });
  const notice = { ...CURRENT_CONSENT_NOTICE, grievanceContact: 'Asha Menon' };

  /**
   * This application is complete up to the documents, so the form reopens on step 4 — the shared
   * resume rule the phone app uses. Step 3 is one press back, on the step list.
   */
  const start = async (step: 3 | 4, opts: { fields?: Record<string, unknown>; documents?: unknown[] } = {}) => {
    api.hydrateRegistration.mockResolvedValue({
      application: application(opts.fields), documents: opts.documents ?? [],
      documentsRequested: ['PHOTOGRAPH', 'BANK_PASSBOOK'], otpVerified: true, consentNotice: notice, infoRequests: [],
    } as never);
    api.updateRegistrationDraft.mockImplementation(async () => application(opts.fields) as never);
    render(<MemoryRouter><PublicRegistration token={TOKEN} /></MemoryRouter>);
    await screen.findByText('Lay flat, good light, all 4 corners.');
    if (step === 3) fireEvent.click(await screen.findByRole('button', { name: 'ID & bank' }));
  };

  beforeAll(() => {
    // jsdom has no layout, so no `scrollIntoView`. The form scrolls to the first refused box on a
    // later animation frame; whether that frame lands inside a test is timing, which made the
    // "will not move on" test pass one day and fail the next. A browser has it; so does this file.
    Element.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  const accountCalls = () => api.updateRegistrationDraft.mock.calls
    .map(([, patch]) => (patch as { record?: Record<string, unknown> }).record?.bankAccountNumber)
    .filter((v) => v !== undefined);

  it('saves a new account number only once it has been typed twice the same way', async () => {
    await start(3);
    const account = await screen.findByLabelText('Bank account number');
    const confirm = screen.getByLabelText('Re-enter account number');

    fireEvent.change(account, { target: { value: '123456789012' } });
    fireEvent.blur(account);
    expect(accountCalls()).toEqual([]);

    fireEvent.change(confirm, { target: { value: '123456789099' } });
    fireEvent.blur(confirm);
    expect(await screen.findByText(/do not match/)).toBeInTheDocument();
    expect(accountCalls()).toEqual([]);

    fireEvent.change(confirm, { target: { value: '123456789012' } });
    fireEvent.blur(confirm);
    await waitFor(() => expect(accountCalls()).toEqual(['123456789012']));
  });

  /** A pasted copy repeats the slip it is meant to catch. */
  it('refuses a paste into the second box, and says why', async () => {
    await start(3);
    const confirm = await screen.findByLabelText('Re-enter account number');

    fireEvent.paste(confirm, { clipboardData: { getData: () => '123456789012' } });

    expect(await screen.findByText(/rather than pasting/)).toBeInTheDocument();
    expect(confirm).toHaveValue('');
  });

  /** What was already saved counts as confirmed — resuming must not demand it again. */
  it('treats the number already on file as confirmed', async () => {
    await start(3, { fields: { bankAccountNumber: '123456789012' } });

    expect(await screen.findByLabelText('Re-enter account number')).toHaveValue('123456789012');
  });

  it('will not submit without the passbook, and takes them to it', async () => {
    await start(4, { documents: [{ id: 'd1', applicationId: 'app-1', requirement: 'PHOTOGRAPH', filePaths: ['f.jpg'] }] });

    // Listed as still needed — the one thing between them and Submit.
    expect(await screen.findByText('Still needed:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /passbook/i })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Submit' }));

    expect(await screen.findByText(/Upload your bank passbook before submitting/i)).toBeInTheDocument();
    expect(api.submitRegistration).not.toHaveBeenCalled();
  });

  /**
   * Continue saves the whole form. The second typing is on the form but must never be in that save:
   * the API refuses properties it does not know, so it leaking would fail every step change.
   */
  it('never sends the second typing when Continue saves the whole form', async () => {
    await start(3, { fields: { bankAccountNumber: '123456789012' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));

    await waitFor(() => expect(api.updateRegistrationDraft).toHaveBeenCalled());
    for (const [, patch] of api.updateRegistrationDraft.mock.calls) {
      expect(patch).not.toHaveProperty('bankAccountNumberConfirm');
      expect((patch as { record?: object }).record ?? {}).not.toHaveProperty('bankAccountNumberConfirm');
    }
  });

  /** A number typed now, not yet confirmed, stops Continue with the shared rule's own words. */
  it('will not move on while the account number is unconfirmed', async () => {
    await start(3);
    fireEvent.change(await screen.findByLabelText('Bank account number'), { target: { value: '123456789012' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText(/second time to confirm it/)).toBeInTheDocument();
    // Still on step 3: the documents step, and its Submit, never appeared.
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
  });
});

