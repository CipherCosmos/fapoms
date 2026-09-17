import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { EmailTemplatesSection, compileVisualToHtml } from './EmailTemplatesSection';
import { readVisualStamp, authorshipOf } from './email-template-authorship';
import { api } from '../../services/api';

/**
 * THE ONE THING THIS SCREEN MUST NEVER DO: quietly replace an email somebody wrote.
 *
 * The simple editor compiles a whole email from a form. Its fields used to be seeded from hardcoded
 * defaults and never read back out of the stored template, so opening a customised email, switching
 * to the form and typing a single character rebuilt the body from defaults — and the next Publish
 * sent that to candidates. Nothing warned, because nothing could tell the two kinds of HTML apart.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

const HAND_WRITTEN = '<html><body><table><tr><td>'
  + 'An email somebody built by hand, with wording the desk agreed on.'
  + '</td></tr></table></body></html>';

/** One row of `GET /notification-admin/email-templates`, in the shape that endpoint returns. */
const listRow = () => ({
  key: 'otp-verification',
  name: 'Registration OTP Verification',
  description: 'Sent to verify a candidate email address.',
  category: 'Security',
  requiredTokens: ['otpCode', 'validMinutes', 'logoUrl', 'supportEmail'],
  optionalTokens: ['greeting', 'companyName'],
  rawTokens: [],
  defaultSubjectTemplate: 'Your Appraiser registration code',
  sampleData: { otpCode: '849201', validMinutes: '5' },
  activeState: { source: 'filesystem', version: 1, checksum: 'abc123', isFallback: false },
  settings: {
    sourcePreference: 'platform', activeVersion: undefined, hasDraft: false,
    versionCount: 0, hasFilesystemTemplate: true,
  },
});

const detailFor = (html: string) => ({
  definition: {
    key: 'otp-verification',
    name: 'Registration OTP Verification',
    category: 'Security',
    description: 'Sent to verify a candidate email address.',
    defaultSubjectTemplate: 'Your Appraiser registration code',
    requiredTokens: ['otpCode', 'validMinutes', 'logoUrl', 'supportEmail'],
    optionalTokens: ['greeting', 'companyName'],
    rawTokens: [],
    sampleData: { otpCode: '849201', validMinutes: '5' },
  },
  activeTemplate: { html, subjectTemplate: 'Your Appraiser registration code', source: 'filesystem', version: 1 },
  storedSettings: { versions: [], draft: null },
  versions: [],
});

const draw = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <EmailTemplatesSection canEdit />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockImplementation((url: string) => {
    if (url.includes('/email-templates/otp-verification')) return Promise.resolve(detailFor(HAND_WRITTEN));
    if (url.includes('/email-templates')) {
      return Promise.resolve([listRow()]);
    }
    return Promise.resolve({});
  });
});

describe('opening the simple editor on an email somebody wrote by hand', () => {
  it('asks first, and says plainly what would be replaced', async () => {
    draw();
    await waitFor(() => expect(screen.getAllByText(/Registration OTP Verification/).length).toBeGreaterThan(0));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Visual Form/i }));
    });

    // The question names the consequence rather than asking "are you sure?".
    expect(await screen.findByText(/Rebuild this email from the simple form\?/i)).toBeInTheDocument();
    expect(screen.getByText(/everything currently written in the HTML will be replaced/i)).toBeInTheDocument();
    // …and the way out is the easy answer, because the two mistakes do not cost the same.
    expect(screen.getByRole('button', { name: /Keep the HTML/i })).toBeInTheDocument();
  });

  it('leaves the email exactly as it was when the answer is no', async () => {
    draw();
    await waitFor(() => expect(screen.getAllByText(/Registration OTP Verification/).length).toBeGreaterThan(0));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Visual Form/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Keep the HTML/i }));
    });

    expect(screen.getByLabelText('Email HTML')).toHaveValue(HAND_WRITTEN);
  });

  /**
   * The guard above is on the SWITCH — and the screen used to open on the simple form for every
   * template, so for the seven hand-built emails that ship with the platform there was no switch to
   * guard: the form was already on screen, and the first keystroke rebuilt the body. Which editor
   * opens is now decided by who wrote the email.
   */
  it('opens in the HTML editor, because that is where it was written', async () => {
    draw();
    await waitFor(() => expect(screen.getAllByText(/Registration OTP Verification/).length).toBeGreaterThan(0));

    expect(screen.getByLabelText('Email HTML')).toHaveValue(HAND_WRITTEN);
    expect(screen.queryByText(/Rebuild this email from the simple form\?/i)).not.toBeInTheDocument();
  });
});

/**
 * The other half of the promise: an email the form DID write must reopen in the form with the same
 * fields, not with defaults — otherwise the safe path is also a lossy one.
 */
describe('reopening an email the form wrote', () => {
  const FIELDS = {
    subject: 'Your Appraiser registration code',
    headline: 'Verify your email address',
    greeting: 'Hello Priya,',
    leadMessage: 'Enter the six digits below to continue.',
    footerNotice: 'If you did not ask for this, ignore this email.',
    primaryColor: '#047857',
    headerStyle: 'accent-line' as const,
  };

  it('signs what it compiles, so the fields can be restored exactly', () => {
    const compiled = compileVisualToHtml('otp-verification', FIELDS);

    expect(authorshipOf(compiled)).toBe('simple-editor');
    expect(readVisualStamp(compiled)).toEqual(FIELDS);
    // The stamp is a comment; the email itself still renders the chosen colour and the wording.
    expect(compiled).toContain('Hello Priya,');
    expect(compiled).toContain('#047857');
  });

  it('opens in the form without asking anybody anything', async () => {
    const compiled = compileVisualToHtml('otp-verification', FIELDS);
    mockRequest.mockImplementation((url: string) => {
      if (url.includes('/email-templates/otp-verification')) return Promise.resolve(detailFor(compiled));
      if (url.includes('/email-templates')) return Promise.resolve([listRow()]);
      return Promise.resolve({});
    });

    draw();
    await waitFor(() => expect(screen.getAllByText(/Registration OTP Verification/).length).toBeGreaterThan(0));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Visual Form/i }));
    });

    expect(screen.queryByText(/Rebuild this email from the simple form\?/i)).not.toBeInTheDocument();
  });
});


/**
 * PUBLISHING AN EMAIL NOBODY HAS EVER RECEIVED.
 *
 * The gate used to be a checkbox saying "I have inspected the preview". A preview is a browser
 * drawing HTML; an inbox is a different engine, on a different screen, usually with images off —
 * and the recipients here are candidates being asked for their Aadhaar and bank details, who will
 * not write in to say the email looked broken. The server now refuses a draft that has not been
 * delivered somewhere, so this screen has to say so BEFORE the button is pressed rather than
 * turning a guardrail into an error message.
 */
describe('the publish gate', () => {
  const openPublish = async (testStatus: unknown) => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes('/email-templates/otp-verification')) {
        return Promise.resolve({ ...detailFor(HAND_WRITTEN), testStatus });
      }
      if (url.includes('/email-templates')) return Promise.resolve([listRow()]);
      return Promise.resolve({});
    });
    draw();
    await waitFor(() => expect(screen.getAllByText(/Registration OTP Verification/).length).toBeGreaterThan(0));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Publish/i })); });
  };

  it('asks for a test first, and offers the way to send one', async () => {
    await openPublish({ required: true, lastTestSend: null, matchesDraft: false });

    expect(await screen.findByText(/Send yourself a test first/i)).toBeInTheDocument();
    expect(screen.getByText(/Nobody has received this email yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send a test/i })).toBeInTheDocument();
  });

  /** The specific trap: a test was sent, then the email was edited again. */
  it('says so when the test was of an earlier version', async () => {
    await openPublish({
      required: true,
      lastTestSend: { to: 'priya@example.com', at: '2026-09-16T14:05:00.000Z' },
      matchesDraft: false,
    });

    expect(await screen.findByText(/The last test was of an earlier version/i)).toBeInTheDocument();
  });

  it('confirms the delivery, naming where it went', async () => {
    await openPublish({
      required: true,
      lastTestSend: { to: 'priya@example.com', at: '2026-09-16T14:05:00.000Z' },
      matchesDraft: true,
    });

    expect(await screen.findByText(/Test email received/i)).toBeInTheDocument();
    expect(screen.getByText(/priya@example.com/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send a test/i })).not.toBeInTheDocument();
  });

  /**
   * With no email transport configured there is no way to send a test, and demanding one would
   * leave the whole feature unusable rather than safe.
   */
  it('does not demand the impossible when email is not configured', async () => {
    await openPublish({ required: false, lastTestSend: null, matchesDraft: false });

    // It says what is true — not "test received", which nobody has earned here.
    expect(await screen.findByText(/No test was sent/i)).toBeInTheDocument();
    expect(screen.getByText(/Email delivery is not set up yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Send yourself a test first/i)).not.toBeInTheDocument();
  });
});
