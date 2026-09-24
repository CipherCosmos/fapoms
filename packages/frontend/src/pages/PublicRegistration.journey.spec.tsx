import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
import { PublicRegistration } from './PublicRegistration';
import * as registrationApi from '../services/public-registration';
import { CURRENT_CONSENT_NOTICE, ApplicationStatus } from '@fapoms/shared';

jest.mock('../services/public-registration');

const api = registrationApi as jest.Mocked<typeof registrationApi>;

/**
 * WHAT A CANDIDATE SEES AFTER THEY PRESS SUBMIT.
 *
 * Owner, 2026-09-24: the page after the form was "very basic eventhough they need to pass through
 * several other steps, also they may be asked to update their details or provide extra details".
 * It now shows the steps still ahead, which one they are on, one sentence about what happens next,
 * and — first — anything HR has asked of them. Still short: a heading, a list, a line.
 */
const TOKEN = 'tok-journey';
const application = {
  id: 'abcdef12-0000', fullName: 'Ramesh Kulkarni', mobile: '•••• 4455', email: 'r@example.com',
  employmentCategory: 'FREELANCER' as never, consentAcceptedAt: '2026-09-20T00:00:00Z',
  status: ApplicationStatus.PENDING_VALIDATION, reviewNotes: null, extendedProfile: null,
};
const notice = { ...CURRENT_CONSENT_NOTICE, grievanceContact: 'Asha Menon' };

const open = async (app: Record<string, unknown>, journey?: unknown) => {
  api.hydrateRegistration.mockResolvedValue({
    application: { ...application, ...app }, documents: [], documentsRequested: [],
    otpVerified: true, consentNotice: notice, infoRequests: [],
    ...(journey === undefined ? {} : { journey }),
  } as never);
  render(<MemoryRouter><PublicRegistration token={TOKEN} /></MemoryRouter>);
  await screen.findByRole('heading', { level: 1 });
};

/** Each step as the page shows it: its name, and whether it is the one they are on. */
const steps = () => within(screen.getByRole('list', { name: 'Your steps to joining' }))
  .getAllByRole('listitem')
  .map((li) => `${li.textContent}${li.getAttribute('aria-current') === 'step' ? ' ←' : ''}`);

beforeEach(() => jest.clearAllMocks());

describe('a submitted application', () => {
  it('shows the road ahead with HR\'s form check highlighted', async () => {
    await open({});
    expect(screen.getByRole('heading', { name: 'Submitted. HR will call you.' })).toBeInTheDocument();
    expect(steps()).toEqual([
      'Form sent', 'HR checks your form ←', 'Documents checked', 'Background check',
      'Final approval', 'Training, if needed', 'Ready to start work',
    ]);
    // Being asked to change something is part of the road, so the page says it can happen.
    expect(screen.getByText(/If anything needs changing, this link will open your form again/)).toBeInTheDocument();
    expect(screen.getByText('#APP-ABCDEF12')).toBeInTheDocument();
  });
});

describe('an approved application', () => {
  it('follows the record to the step it is on', async () => {
    await open({ status: ApplicationStatus.APPROVED }, { stage: 'BACKGROUND', paused: false, asks: [] });
    expect(screen.getByRole('heading', { name: 'Approved — welcome, Ramesh Kulkarni.' })).toBeInTheDocument();
    expect(steps()).toContain('Background check ←');
    expect(screen.getByText(/A background check is being done/)).toBeInTheDocument();
  });

  /** The approver may send them straight to work, so the page offers both and promises neither. */
  it('does not promise training while the final approval is pending', async () => {
    await open({ status: ApplicationStatus.APPROVED }, { stage: 'APPROVAL', paused: false, asks: [] });
    expect(steps()).toContain('Final approval ←');
    expect(steps()).toContain('Training, if needed');
    expect(screen.getByText(/training if it is needed, or start work straight away/)).toBeInTheDocument();
  });

  it('puts what HR asked for first, in HR\'s words, with where to answer it', async () => {
    await open({ status: ApplicationStatus.APPROVED }, {
      stage: 'DOCUMENTS', paused: false,
      asks: [
        { requirement: 'PAN_CARD', label: 'PAN Card', note: 'The number is cut off, please retake.' },
        { requirement: 'PHOTOGRAPH', label: 'Photograph', note: null },
      ],
    });
    const asks = screen.getByRole('region', { name: 'HR has asked you to send these again:' });
    expect(within(asks).getByText(/The number is cut off, please retake\./)).toBeInTheDocument();
    expect(within(asks).getByText(/Please send a clear copy again\./)).toBeInTheDocument();
    // The link cannot take the file after approval; the page says where the answer goes.
    expect(within(asks).getByText(/Open the appraiser app, sign in, and send them from Your papers/)).toBeInTheDocument();
    // First: above the heading and the steps.
    const heading = screen.getByRole('heading', { level: 1 });
    expect(asks.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * Whatever paused them — a background check, a refused approval, anything — the page says the
   * same neutral thing and shows no steps, so it does not say where they stopped.
   */
  it('says a paused joiner is paused, and nothing more', async () => {
    await open({ status: ApplicationStatus.APPROVED }, { stage: null, paused: true, asks: [] });
    expect(screen.getByRole('heading', { name: 'Your joining is paused.' })).toBeInTheDocument();
    expect(screen.getByText('HR will contact you.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Your steps to joining' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Approved/)).not.toBeInTheDocument();
  });

  /** An older server sends no journey: approved, past the form check, and nothing more claimed. */
  it('claims nothing past the form check when the server does not say', async () => {
    await open({ status: ApplicationStatus.APPROVED });
    expect(steps()).toEqual([
      'Form sent', 'HR checks your form', 'Documents checked', 'Background check',
      'Final approval', 'Training, if needed', 'Ready to start work',
    ]);
    expect(screen.getByText('HR will call you about the next steps.')).toBeInTheDocument();
  });
});

describe('an application with no road left', () => {
  it('shows a rejected application its note and no steps', async () => {
    await open({ status: ApplicationStatus.REJECTED, reviewNotes: 'Experience below two years.' });
    expect(screen.getByRole('heading', { name: 'Not approved this time.' })).toBeInTheDocument();
    expect(screen.getByText('Note from HR: Experience below two years.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Your steps to joining' })).not.toBeInTheDocument();
  });
});

describe('a form HR sent back', () => {
  it('heads HR\'s list in HR\'s voice, above the reopened form', async () => {
    api.hydrateRegistration.mockResolvedValue({
      application: {
        ...application, status: ApplicationStatus.AWAITING_INFO, dateOfBirth: '1985-03-14', gender: 'Male',
        address: '14 Shivaji Nagar, Pune', state: 'Maharashtra', city: 'Pune', pincode: '411005', experienceYears: 5,
        currentEmployer: null, expertise: null, availability: null, consentVersion: 'v1',
        extendedProfile: { fields: {} },
      },
      documents: [], documentsRequested: ['PHOTOGRAPH'], otpVerified: true, consentNotice: notice,
      infoRequests: [{ kind: 'document', key: 'PHOTOGRAPH', label: 'Photograph', message: 'Plain background please.' }],
    } as never);
    render(<MemoryRouter><PublicRegistration token={TOKEN} /></MemoryRouter>);
    expect(await screen.findByText('HR has asked you to fix these:')).toBeInTheDocument();
    expect(screen.getByText(/Plain background please\./)).toBeInTheDocument();
  });
});

/**
 * AN EXPIRED LINK STILL SAYS HOW THEY ARE GETTING ON (owner, 2026-09-24: "status-only after expiry").
 *
 * The server sends only the status, the steps and what HR asked for (`statusOnly`). The page shows
 * that, says the link only shows progress now, and never opens the form behind it.
 */
describe('a link that has expired', () => {
  const openExpired = async (status: ApplicationStatus, extra: Record<string, unknown> = {}) => {
    api.hydrateRegistration.mockResolvedValue({
      application: { id: 'abcdef12-0000', status }, documents: [], documentsRequested: [],
      otpVerified: false, consentNotice: null, infoRequests: [], journey: null, statusOnly: true, ...extra,
    } as never);
    render(<MemoryRouter><PublicRegistration token={TOKEN} /></MemoryRouter>);
    await screen.findByRole('heading', { level: 1 });
  };

  it('still shows an approved candidate their steps, and says the link only shows progress now', async () => {
    await openExpired(ApplicationStatus.APPROVED, { journey: { stage: 'APPROVAL', paused: false, asks: [] } });
    // No name: the expired link carries none, and the heading does not pretend otherwise.
    expect(screen.getByRole('heading', { name: 'Approved.' })).toBeInTheDocument();
    expect(steps()).toContain('Final approval ←');
    expect(screen.getByTestId('status-only-note')).toHaveTextContent('only shows your progress');
    expect(screen.queryByText('Link not working — ask HR for a new one.')).not.toBeInTheDocument();
  });

  it('shows what HR asked for on a form it sent back, and how to get a working link', async () => {
    await openExpired(ApplicationStatus.AWAITING_INFO, {
      infoRequests: [{ kind: 'document', key: 'PAN_CARD', label: 'PAN card', message: 'The photo is blurred — retake it.' }],
    });
    expect(screen.getByRole('heading', { name: 'HR has asked you to fix a few things.' })).toBeInTheDocument();
    expect(screen.getByTestId('expired-info-requests')).toHaveTextContent('PAN card — The photo is blurred — retake it.');
    expect(screen.getByText(/Ask HR to send you a new link/)).toBeInTheDocument();
    // The form never opens behind an expired link.
    expect(screen.queryByRole('button', { name: /Continue|Next|Submit/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Full name/i)).not.toBeInTheDocument();
  });

  it('shows a submitted form as submitted', async () => {
    await openExpired(ApplicationStatus.PENDING_VALIDATION);
    expect(screen.getByRole('heading', { name: 'Submitted. HR will call you.' })).toBeInTheDocument();
    expect(screen.getByTestId('status-only-note')).toBeInTheDocument();
  });

  it('leaves a live link exactly as it was — no "only shows progress" line', async () => {
    await open({});
    expect(screen.queryByTestId('status-only-note')).not.toBeInTheDocument();
  });
});
