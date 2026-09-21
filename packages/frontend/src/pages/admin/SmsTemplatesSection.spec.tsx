import React from 'react';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { SmsDeliveryCard, SmsTemplatesSection, smsCostLine, smsSendBlock } from './SmsTemplatesSection';
import { ToastProvider } from '../../components/ui/Toast';
import { api } from '../../services/api';

/**
 * Text messages on the settings screen, for the person holding the company's DLT registration.
 *
 * What must not go wrong here is quiet and expensive: wording saved without `{{code}}` sends a code
 * message with no code; wording changed under an old DLT Template ID is blocked by every operator; a
 * rupee sign triples the cost without anyone noticing; a text with no Template ID at all is dropped
 * by every phone company while the screen still looks healthy. So these pin what the screen tells
 * them while they type, that it will not save what the server would have to refuse, and that a test
 * it cannot send is explained rather than attempted.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

const MFA_ROW = {
  key: 'mfa-code',
  name: 'Sign-in verification code',
  description: 'The one-time code for signing in.',
  defaultText: 'Your FAPOMS verification code is {{code}}. It expires in {{validMinutes}} minutes.',
  dltForm: 'Your FAPOMS verification code is {#var#}. It expires in {#var#} minutes.',
  requiredTokens: ['code', 'validMinutes'],
  sampleData: { code: '482910', validMinutes: '5' },
  overrideText: null,
  dltTemplateId: null,
  // What an administrator typed here, and whether the id in force came with the platform instead.
  savedDltTemplateId: null,
  dltTemplateIdIsBuiltIn: false,
  overrideRejected: false,
  preview: 'Your FAPOMS verification code is 482910. It expires in 5 minutes.',
  segments: 1,
  encoding: 'GSM-7',
};

const CREDENTIALS_ROW = {
  ...MFA_ROW,
  key: 'app-credentials',
  name: 'App access credentials',
  description: 'The username and temporary password for the field app.',
  defaultText: 'Your FAPOMS sign-in is {{username}}.',
  dltForm: 'Your FAPOMS sign-in is {#var#}.',
  requiredTokens: ['username'],
  sampleData: { username: 'AS0323' },
  dltTemplateId: '1107160000000099999',
  savedDltTemplateId: '1107160000000099999',
  preview: 'Your FAPOMS sign-in is AS0323.',
};

const SENDING = { enabled: true, provider: 'PINNACLE', senderId: 'SUMERU', dltEntityIdSet: true, hint: null };

const draw = (ui: React.ReactElement) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

const wording = () => screen.getByLabelText('Sign-in verification code wording');
const dltInput = () => screen.getByLabelText('Sign-in verification code DLT Template ID');
const saveButton = () => screen.getByRole('button', { name: /Save "Sign-in verification code"/ });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the SMS delivery card', () => {
  const withStatus = (status: unknown) => mockRequest.mockImplementation((url: string) => {
    if (url.endsWith('/sms/status')) return status instanceof Error ? Promise.reject(status) : Promise.resolve(status);
    return Promise.resolve({});
  });

  it('says it is working, from which sender, and passes on the server\'s warning', async () => {
    withStatus({ enabled: true, provider: 'PINNACLE', senderId: 'SUMERU', dltEntityIdSet: false, hint: 'No DLT Principal Entity ID is saved.' });
    draw(<SmsDeliveryCard canEdit />);

    expect(await screen.findByText('SMS is working — Pinnacle')).toBeInTheDocument();
    expect(screen.getByText(/Texts arrive from SUMERU/)).toBeInTheDocument();
    expect(screen.getByText('No DLT Principal Entity ID is saved.')).toBeInTheDocument();
  });

  it('says so when the status could not be read, rather than calling SMS off', async () => {
    withStatus(new Error('boom'));
    draw(<SmsDeliveryCard canEdit />);

    expect(await screen.findByText('Whether SMS is working could not be read')).toBeInTheDocument();
  });

  it('sends a test text to the typed number and shows the gateway\'s refusal in its own words', async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.endsWith('/sms/status')) return Promise.resolve(SENDING);
      if (url.endsWith('/sms/test')) return Promise.resolve({ success: false, error: 'Pinnacle refused it: Invalid DLT template id' });
      return Promise.resolve({});
    });
    draw(<SmsDeliveryCard canEdit />);
    await screen.findByText('SMS is working — Pinnacle');

    fireEvent.change(screen.getByLabelText('Mobile number for the test text'), { target: { value: '98765 43210' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Send test text/ })); });

    expect(mockRequest).toHaveBeenCalledWith('/notification-admin/sms/test', { method: 'POST', body: JSON.stringify({ to: '98765 43210' }) });
    expect(await screen.findByText('Pinnacle refused it: Invalid DLT template id')).toBeInTheDocument();
  });

  it('will not send to something that is not an Indian mobile, and says what it expects', async () => {
    withStatus(SENDING);
    draw(<SmsDeliveryCard canEdit />);
    await screen.findByText('SMS is working — Pinnacle');

    fireEvent.change(screen.getByLabelText('Mobile number for the test text'), { target: { value: '0712345678' } });

    expect(screen.getByRole('button', { name: /Send test text/ })).toBeDisabled();
    expect(screen.getByText(/does not look like an Indian mobile number/)).toBeInTheDocument();
  });
});

describe('the text message templates', () => {
  const withRows = (rows: unknown[], status: unknown = SENDING) => mockRequest.mockImplementation((url: string, init?: any) => {
    if (url === '/notification-admin/sms-templates') return Promise.resolve(rows);
    if (url.endsWith('/sms/status')) return Promise.resolve(status);
    if (init?.method === 'PUT') return Promise.resolve(rows[0]);
    return Promise.resolve({});
  });

  it('shows the standard wording, what the phone receives, and exactly what to register on DLT', async () => {
    withRows([MFA_ROW]);
    draw(<SmsTemplatesSection canEdit />);

    expect(await screen.findByDisplayValue(MFA_ROW.defaultText)).toBeInTheDocument();
    expect(screen.getByLabelText('Sign-in verification code preview')).toHaveTextContent(MFA_ROW.preview);
    expect(screen.getByLabelText('Sign-in verification code DLT form')).toHaveTextContent(MFA_ROW.dltForm);
    expect(screen.getByText('Register exactly this on your DLT portal')).toBeInTheDocument();
  });

  it('updates the preview, DLT form and cost as the wording is typed', async () => {
    withRows([MFA_ROW]);
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByDisplayValue(MFA_ROW.defaultText);

    fireEvent.change(wording(), { target: { value: 'Sumeru code {{code}}, valid {{validMinutes}} min. Fee ₹0.' } });

    expect(screen.getByLabelText('Sign-in verification code preview')).toHaveTextContent('Sumeru code 482910, valid 5 min. Fee ₹0.');
    expect(screen.getByLabelText('Sign-in verification code DLT form')).toHaveTextContent('Sumeru code {#var#}, valid {#var#} min. Fee ₹0.');
    expect(screen.getByLabelText('Sign-in verification code length')).toHaveTextContent(/1 SMS part · contains a special character/);
  });

  it('counts parts the way the gateway bills them', () => {
    expect(smsCostLine('a'.repeat(160))).toBe('160 characters · 1 SMS part · up to 160 characters per part');
    expect(smsCostLine('a'.repeat(161))).toBe('161 characters · 2 SMS parts · up to 153 characters per part');
    expect(smsCostLine('₹'.repeat(71))).toMatch(/^71 characters · 2 SMS parts · contains a special character.* only 67 characters fit per part$/);
  });

  it('refuses to save wording that lost a value, and names the value', async () => {
    withRows([MFA_ROW]);
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByDisplayValue(MFA_ROW.defaultText);

    fireEvent.change(wording(), { target: { value: 'Your code expires in {{validMinutes}} minutes.' } });

    expect(screen.getByRole('alert')).toHaveTextContent('must still contain {{code}}');
    expect(saveButton()).toBeDisabled();
  });

  it('refuses a DLT Template ID that is not digits', async () => {
    withRows([MFA_ROW]);
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByDisplayValue(MFA_ROW.defaultText);

    fireEvent.change(dltInput(), { target: { value: 'DLT-1107' } });

    expect(screen.getByRole('alert')).toHaveTextContent('digits only');
    expect(saveButton()).toBeDisabled();
  });

  /** New wording under an id registered for the old wording is blocked by every operator. */
  it('warns when the wording changes under a Template ID registered for the old wording', async () => {
    withRows([{ ...MFA_ROW, dltTemplateId: '1107160000000012345', savedDltTemplateId: '1107160000000012345' }]);
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByDisplayValue(MFA_ROW.defaultText);

    fireEvent.change(wording(), { target: { value: 'Code {{code}} for {{validMinutes}} min.' } });

    expect(screen.getByText(/registered for the old wording/)).toBeInTheDocument();
  });

  it('saves the wording and Template ID', async () => {
    withRows([MFA_ROW]);
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByDisplayValue(MFA_ROW.defaultText);

    fireEvent.change(wording(), { target: { value: 'Code {{code}} for {{validMinutes}} min.' } });
    fireEvent.change(dltInput(), { target: { value: '1107160000000012345' } });
    await act(async () => { fireEvent.click(saveButton()); });

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/notification-admin/sms-templates/mfa-code', {
      method: 'PUT',
      body: JSON.stringify({ text: 'Code {{code}} for {{validMinutes}} min.', dltTemplateId: '1107160000000012345' }),
    }));
  });

  it('shows the wording read-only to someone who cannot edit it', async () => {
    withRows([MFA_ROW]);
    draw(<SmsTemplatesSection canEdit={false} />);
    await screen.findByDisplayValue(MFA_ROW.defaultText);

    expect(wording()).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Save "/ })).not.toBeInTheDocument();
  });
});

/**
 * PICKING ONE TEXT TO WORK ON — the same shape as the email templates screen.
 *
 * Five texts on one page meant five editors open at once and no answer to "which one is broken".
 * Now one is open at a time, so the list has to carry the state: which one cannot go out is the
 * thing somebody needs to see without opening each in turn.
 */
describe('choosing which text to work on', () => {
  const withRows = (rows: unknown[], status: unknown = SENDING) => mockRequest.mockImplementation((url: string) => {
    if (url === '/notification-admin/sms-templates') return Promise.resolve(rows);
    if (url.endsWith('/sms/status')) return Promise.resolve(status);
    return Promise.resolve({});
  });

  it('lists every text and opens the first one', async () => {
    withRows([MFA_ROW, CREDENTIALS_ROW]);
    draw(<SmsTemplatesSection canEdit />);

    // Scoped to the list: the editor has buttons naming the same text.
    const list = within(await screen.findByRole('group', { name: 'Text messages to choose from' }));
    expect(list.getByRole('button', { name: /Sign-in verification code/ })).toHaveAttribute('aria-pressed', 'true');
    expect(list.getByRole('button', { name: /App access credentials/ })).toHaveAttribute('aria-pressed', 'false');
    // Only the open one is being edited.
    expect(screen.getByLabelText('Sign-in verification code wording')).toBeInTheDocument();
    expect(screen.queryByLabelText('App access credentials wording')).not.toBeInTheDocument();
  });

  it('opens the one that is clicked, with its own wording and DLT form', async () => {
    withRows([MFA_ROW, CREDENTIALS_ROW]);
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByDisplayValue(MFA_ROW.defaultText);

    fireEvent.click(screen.getByRole('button', { name: /App access credentials/ }));

    expect(await screen.findByDisplayValue(CREDENTIALS_ROW.defaultText)).toBeInTheDocument();
    expect(screen.getByLabelText('App access credentials DLT form')).toHaveTextContent(CREDENTIALS_ROW.dltForm);
    expect(screen.queryByLabelText('Sign-in verification code wording')).not.toBeInTheDocument();
  });

  /** The whole point of the list: the one that will be dropped is visible without opening it. */
  it('marks in the list the text that cannot go out for want of a DLT Template ID', async () => {
    withRows([MFA_ROW, CREDENTIALS_ROW]);
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByRole('group', { name: 'Text messages to choose from' });

    expect(screen.getByText('Cannot send yet — no DLT Template ID')).toBeInTheDocument();
    expect(screen.getByText('DLT Template ID set')).toBeInTheDocument();
  });

  /** Without a Principal Entity ID nothing is registered on DLT yet, so nothing is "blocked" yet. */
  it('does not accuse a text of missing an ID when no DLT registration is in force', async () => {
    withRows([MFA_ROW], { ...SENDING, dltEntityIdSet: false });
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByRole('group', { name: 'Text messages to choose from' });

    expect(screen.queryByText('Cannot send yet — no DLT Template ID')).not.toBeInTheDocument();
  });

  it('says which reason stops a text going out, or none', () => {
    expect(smsSendBlock(MFA_ROW as any, null)).toBeNull();
    expect(smsSendBlock(MFA_ROW as any, { ...SENDING, enabled: false })).toMatch(/SMS is not set up yet/);
    expect(smsSendBlock(MFA_ROW as any, SENDING)).toMatch(/has no DLT Template ID yet/);
    expect(smsSendBlock(MFA_ROW as any, { ...SENDING, dltEntityIdSet: false })).toBeNull();
    expect(smsSendBlock(CREDENTIALS_ROW as any, SENDING)).toBeNull();
  });
});

/**
 * SENDING ONE TEXT TO A PHONE — the twin of the email screen's per-template test send.
 *
 * The delivery card's test proves the gateway works. It cannot prove this text works, and this text
 * is what gets dropped: its own Template ID is the thing that is missing or stale. So the test has
 * to be per text, and it has to go through the wording that is actually saved.
 */
describe('sending one text to a phone', () => {
  const withRows = (rows: unknown[], status: unknown = SENDING, testResult: unknown = { success: true }) =>
    mockRequest.mockImplementation((url: string) => {
      if (url === '/notification-admin/sms-templates') return Promise.resolve(rows);
      if (url.endsWith('/sms/status')) return Promise.resolve(status);
      if (url.endsWith('/test')) return Promise.resolve(testResult);
      return Promise.resolve({});
    });

  const openTest = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Send this text to a phone/ }));
    return screen.findByLabelText('Mobile number for this test text');
  };

  it('sends the open text to the typed number, through that text\'s own route', async () => {
    withRows([CREDENTIALS_ROW]);
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByDisplayValue(CREDENTIALS_ROW.defaultText);

    const to = await openTest();
    fireEvent.change(to, { target: { value: '98765 43210' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Send this text$/ })); });

    expect(mockRequest).toHaveBeenCalledWith('/notification-admin/sms-templates/app-credentials/test', {
      method: 'POST',
      body: JSON.stringify({ to: '98765 43210' }),
    });
  });

  it('shows the gateway\'s refusal in its own words instead of claiming it went', async () => {
    withRows([CREDENTIALS_ROW], SENDING, { success: false, error: 'Pinnacle refused it: Invalid DLT template id' });
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByDisplayValue(CREDENTIALS_ROW.defaultText);

    const to = await openTest();
    fireEvent.change(to, { target: { value: '9876543210' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Send this text$/ })); });

    expect(await screen.findByText('Pinnacle refused it: Invalid DLT template id')).toBeInTheDocument();
  });

  /** The server refuses this one; saying so first is the difference between a fix and a mystery. */
  it('explains why a text with no DLT Template ID cannot be tested, rather than letting it fail', async () => {
    withRows([MFA_ROW]);
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByDisplayValue(MFA_ROW.defaultText);

    const to = await openTest();
    fireEvent.change(to, { target: { value: '9876543210' } });

    expect(screen.getByRole('alert')).toHaveTextContent('has no DLT Template ID yet');
    expect(screen.getByRole('button', { name: /Send this text$/ })).toBeDisabled();
  });

  it('will not send to something that is not an Indian mobile', async () => {
    withRows([CREDENTIALS_ROW]);
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByDisplayValue(CREDENTIALS_ROW.defaultText);

    const to = await openTest();
    fireEvent.change(to, { target: { value: '0712345678' } });

    expect(screen.getByRole('button', { name: /Send this text$/ })).toBeDisabled();
    expect(screen.getByText(/does not look like an Indian mobile number/)).toBeInTheDocument();
  });

  /** The wording travels no further than the settings store, so an unsaved edit is not what is sent. */
  it('says the test uses the saved wording, not whatever is in the box', async () => {
    withRows([CREDENTIALS_ROW]);
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByDisplayValue(CREDENTIALS_ROW.defaultText);

    await openTest();

    expect(screen.getByText(/so if you have just changed the wording, save it first/)).toBeInTheDocument();
  });

  it('offers no test send to someone who cannot edit', async () => {
    withRows([CREDENTIALS_ROW]);
    draw(<SmsTemplatesSection canEdit={false} />);
    await screen.findByDisplayValue(CREDENTIALS_ROW.defaultText);

    expect(screen.queryByRole('button', { name: /Send this text to a phone/ })).not.toBeInTheDocument();
  });
});

/**
 * PUTTING ONE TEXT BACK TO THE STANDARD WORDING.
 *
 * The Template ID has to go with the wording — it was registered against the edited words — and
 * that is the part nobody expects, so the question has to say it before it happens.
 */
describe('restoring the standard wording', () => {
  const EDITED = {
    ...MFA_ROW, overrideText: 'Code {{code}} valid {{validMinutes}} min.',
    dltTemplateId: '1107160000000012345', savedDltTemplateId: '1107160000000012345',
  };
  const withRows = (rows: unknown[]) => mockRequest.mockImplementation((url: string, init?: any) => {
    if (url === '/notification-admin/sms-templates') return Promise.resolve(rows);
    if (url.endsWith('/sms/status')) return Promise.resolve(SENDING);
    if (init?.method === 'PUT') return Promise.resolve(rows[0]);
    return Promise.resolve({});
  });

  it('asks first, and says that the DLT Template ID goes too', async () => {
    withRows([EDITED]);
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByDisplayValue(EDITED.overrideText);

    fireEvent.click(screen.getByRole('button', { name: /Restore the standard wording/ }));

    expect(await screen.findByText(/Put "Sign-in verification code" back to the standard wording\?/)).toBeInTheDocument();
    expect(screen.getByText(/DLT Template ID.*is cleared/s)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Keep my wording/ })).toBeInTheDocument();
  });

  it('clears both the wording and the Template ID when the answer is yes', async () => {
    withRows([EDITED]);
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByDisplayValue(EDITED.overrideText);

    fireEvent.click(screen.getByRole('button', { name: /Restore the standard wording/ }));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /Restore it and clear the ID/ })); });

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/notification-admin/sms-templates/mfa-code', {
      method: 'PUT',
      body: JSON.stringify({ text: null, dltTemplateId: null }),
    }));
  });

  it('changes nothing when the answer is no', async () => {
    withRows([EDITED]);
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByDisplayValue(EDITED.overrideText);

    fireEvent.click(screen.getByRole('button', { name: /Restore the standard wording/ }));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /Keep my wording/ })); });

    expect(mockRequest).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'PUT' }));
  });

  /** Nothing has been saved over it, so there is nothing to put back. */
  it('offers nothing to restore on a text that is already standard', async () => {
    withRows([MFA_ROW]);
    draw(<SmsTemplatesSection canEdit />);
    await screen.findByDisplayValue(MFA_ROW.defaultText);

    expect(screen.getByRole('button', { name: /Restore the standard wording/ })).toBeDisabled();
  });
});

/**
 * A TEMPLATE ID THAT CAME WITH THE PLATFORM, NOT FROM THIS SCREEN.
 *
 * The operations team registered the registration-code wording on DLT and gave us its id, so that
 * text works out of the box. The screen has to be honest about two things the administrator would
 * otherwise get wrong. The id must NOT appear in the box, because saving it there records it as
 * theirs — still attached after they have rewritten every word, so the text would go out under an
 * id it was never registered for, which is how a sender header gets suspended. And once they do
 * rewrite the wording, they have to be told the registered id no longer covers it.
 */
describe('a Template ID that ships with the standard wording', () => {
  const withRows = (rows: unknown[], status: unknown = SENDING) => mockRequest.mockImplementation((url: string, init?: any) => {
    if (url === '/notification-admin/sms-templates') return Promise.resolve(rows);
    if (url.endsWith('/sms/status')) return Promise.resolve(status);
    if (init?.method === 'PUT') return Promise.resolve(rows[0]);
    return Promise.resolve({});
  });

  const SHIPPED = {
    ...MFA_ROW,
    key: 'registration-otp',
    name: 'Registration mobile verification code',
    dltTemplateId: '1777178971152755392',
    savedDltTemplateId: null,
    dltTemplateIdIsBuiltIn: true,
  };

  it('is named as already registered, and is not put in the box as if it were typed here', async () => {
    withRows([SHIPPED]);
    draw(<SmsTemplatesSection canEdit />);

    const box = await screen.findByLabelText(`${SHIPPED.name} DLT Template ID`);
    expect(box).toHaveValue('');
    expect(screen.getByText(/already has a registered Template ID/i)).toBeInTheDocument();
    expect(screen.getByText('1777178971152755392')).toBeInTheDocument();
  });

  it('says plainly that the registered ID does not cover wording the administrator has rewritten', async () => {
    withRows([SHIPPED]);
    draw(<SmsTemplatesSection canEdit />);

    const wording = await screen.findByLabelText(`${SHIPPED.name} wording`);
    fireEvent.change(wording, { target: { value: 'Use {{code}} within {{validMinutes}} minutes.' } });

    expect(screen.getByText(/will not be used for what you have written/i)).toBeInTheDocument();
  });

  it('offers nothing to restore, because nothing was saved over the standard wording here', async () => {
    withRows([SHIPPED]);
    draw(<SmsTemplatesSection canEdit />);

    expect(await screen.findByRole('button', { name: /Restore the standard wording/i })).toBeDisabled();
  });
});
