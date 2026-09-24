import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { EmailTemplatesSection, compileVisualToHtml, VISUAL_DEFAULTS } from './EmailTemplatesSection';
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

/**
 * `draw()` puts a SCREEN up; it does not put a TEMPLATE up.
 *
 * The screen makes two requests — the list of templates, and the selected template itself — and
 * everything asserted below belongs to the second: which editor opened, what is in the box, whether
 * a test has been sent. Waiting for the template's NAME only proves the list arrived, because the
 * name is a row in it, so on a machine running the whole suite across every core the two responses
 * commit far enough apart for an assertion to land on a screen that is still loading. What fails
 * then is not the behaviour under test — the HTML box does not exist yet, and pressing "Visual
 * Form" with an empty editor has nothing to guard, so the dialog never opens and the wait for it
 * burns the full async budget before saying so.
 *
 * Each test therefore waits for the template to be IN the editor, which is a state only the second
 * response can produce. That is also why the wait below is a value and not merely an element: the
 * box appears and is filled in the same commit, so the email being in it is the honest signal that
 * this screen has finished loading.
 */
const handWrittenEmailHasLoaded = () =>
  waitFor(() => expect(screen.getByLabelText('Email HTML')).toHaveValue(HAND_WRITTEN));

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
    // There is nothing to guard until the hand-written email is actually in the editor.
    await handWrittenEmailHasLoaded();

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
    await handWrittenEmailHasLoaded();

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

    // The wait is the assertion: the box that holds raw HTML is on screen, holding this email —
    // so the screen settled on the HTML editor rather than the form.
    await handWrittenEmailHasLoaded();
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
    /*
      Waiting is not optional just because the assertion below is a negative one: on an editor that
      has not loaded yet nobody is asked anything either, so without a wait this test would pass on
      a screen that was merely still fetching. The greeting is the signal because it can only have
      come from the stored email — "Hello Priya," is what the stamp holds, where this screen's own
      built-in design for the template says "Dear Candidate," — and the fields and the email are
      restored together, in one commit, so the greeting being Priya's means the email is loaded too.
    */
    await screen.findByDisplayValue(FIELDS.greeting);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Visual Form/i }));
    });

    expect(screen.queryByText(/Rebuild this email from the simple form\?/i)).not.toBeInTheDocument();
    // And the form is what is on screen: no question asked, and no fall back to the HTML editor.
    expect(screen.queryByLabelText('Email HTML')).not.toBeInTheDocument();
  });

  /**
   * The form compiles the WHOLE email from its fields on every keystroke, so whether those fields
   * were restored is not a cosmetic question. If the form shows its built-in wording while the
   * stored email says something else, the first character typed replaces what the desk agreed on,
   * and the screen says nothing — which is the one thing it must never do.
   *
   * This is the assertion that catches it. The fields were seeded from `VISUAL_DEFAULTS` at mount,
   * which quietly disabled the restore (it only runs for a template with no fields yet), so the
   * greeting on screen read "Dear Candidate," over an email that said "Hello Priya,".
   */
  it('recompiles from the email that was stored, not from the built-in design', async () => {
    const compiled = compileVisualToHtml('otp-verification', FIELDS);
    mockRequest.mockImplementation((url: string) => {
      if (url.includes('/email-templates/otp-verification')) return Promise.resolve(detailFor(compiled));
      if (url.includes('/email-templates')) return Promise.resolve([listRow()]);
      return Promise.resolve({});
    });

    draw();
    const greeting = await screen.findByDisplayValue(FIELDS.greeting);

    // One field edited, the way an administrator would edit one.
    await act(async () => {
      fireEvent.change(greeting, { target: { value: 'Hello Priya ji,' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /AI & HTML Studio/i }));
    });
    const html = (screen.getByLabelText('Email HTML') as HTMLTextAreaElement).value;
    expect(html).toContain('Hello Priya ji,');
    expect(html).toContain(FIELDS.leadMessage);
    expect(html).toContain(FIELDS.footerNotice);
    expect(html).toContain(FIELDS.primaryColor);
    // The built-in wording for this template is nowhere in what would now be published.
    expect(html).not.toContain(VISUAL_DEFAULTS['otp-verification'].leadMessage);
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
    // The gate is drawn from this template's test record, so pressing Publish before the template
    // arrives asks it a question it cannot answer yet — and every "…is not on screen" assertion
    // below would then hold for the wrong reason.
    await handWrittenEmailHasLoaded();
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

/**
 * The referee email, built from the editor's own defaults, must carry every token its contract
 * requires — or an administrator's first "Publish" from the visual editor would be refused.
 */
describe('the referee email in the visual editor', () => {
  it('builds from its defaults with every required token and no button', () => {
    const html = compileVisualToHtml('reference-notice', VISUAL_DEFAULTS['reference-notice']);
    for (const token of ['{{refereeName}}', '{{candidateName}}', '{{contactLine}}', '{{logoUrl}}']) {
      expect(html).toContain(token);
    }
    expect(html).not.toContain('</a>');
  });
});

