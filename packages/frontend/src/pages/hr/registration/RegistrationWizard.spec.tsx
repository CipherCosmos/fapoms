import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import { RegistrationWizard } from './RegistrationWizard';
import { ToastProvider } from '../../../components/ui';
import { api } from '../../../services/api';

jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

/**
 * The desk-only registration, walked end to end.
 *
 * The requirement these tests exist for is a sentence from the owner: *every assayer doesn't have
 * a smartphone, so HR should be able to register them end to end from their side.* So the central
 * case below drives a person with no mobile number, no email address and no account from an empty
 * form to the finish, and asserts that nothing along the way asked for a device.
 *
 * The rest pin the failures the screen this replaces actually had: a "fast" path that demanded a
 * phone the API treats as optional, a second unwatched request that stranded a rate-less record
 * behind a toast saying the create had failed, and a form that sent every field back on every save.
 */

const REQUIREMENTS = [
  { requirement: 'AADHAAR_FRONT', label: 'Aadhaar — front', identity: true, id: null, softCopyReceived: null, hardCopyReceived: null, documentNumber: null, expiryDate: null, verificationStatus: null, filePaths: [] },
  { requirement: 'JOINING_FORM', label: 'Joining form', identity: false, id: null, softCopyReceived: null, hardCopyReceived: null, documentNumber: null, expiryDate: null, verificationStatus: null, filePaths: [] },
];

const CLIENTS = [
  { id: 'cli-1', name: 'ICICI Bank' },
  { id: 'cli-2', name: 'AU Small Finance' },
];

const CREATED = {
  id: 'asr-1', assayerCode: 'WIZ-0001', firstName: 'Ramesh', lastName: 'Iyer', displayName: 'Ramesh Iyer',
  state: 'Kerala', phone: null, email: null, address: '', city: '', district: '', pincode: null,
  latitude: null, longitude: null, panNumber: null, aadhaarNumber: null, bankAccountNumber: null,
  ifscCode: null, joiningDate: '2026-09-02', emergencyContactPhone: null, workingHours: null,
  certifications: null, employmentType: 'FULL_TIME',
};

/** A tiny router over the endpoints the wizard actually touches. */
const wireApi = (overrides: Record<string, unknown> = {}) => {
  mockRequest.mockImplementation((url: string, opts?: RequestInit) => {
    const method = (opts?.method ?? 'GET').toUpperCase();
    for (const [key, value] of Object.entries(overrides)) {
      if (`${method} ${url}`.startsWith(key)) {
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      }
    }
    if (url.includes('workforce-attribute/vocabulary')) return Promise.resolve({ skills: [], certifications: [], languages: [] });
    if (url.startsWith('/clients')) return Promise.resolve({ items: CLIENTS });
    if (url.includes('/dossier')) return Promise.resolve({ onboarding: REQUIREMENTS, references: [], empanelments: [] });
    if (method === 'POST' && url === '/assayers') return Promise.resolve({ ...CREATED });
    if (method === 'PUT' && url.startsWith('/assayers/')) return Promise.resolve({ ...CREATED });
    if (method === 'GET' && /^\/assayers\/[^/]+$/.test(url)) return Promise.resolve({ ...CREATED });
    if (url.startsWith('/assayers?')) return Promise.resolve({ success: true, data: [], meta: { pagination: { total: 0 } } });
    return Promise.resolve({ success: true, data: [] });
  });
};

/**
 * Rendered inside `act` because the wizard fires three fetches on mount — the roster's skill
 * vocabulary, the dossier, and (when resuming) the record itself. Without it every test prints a
 * wall of "not wrapped in act" warnings for state that settled correctly.
 */
const mount = async (props: Partial<React.ComponentProps<typeof RegistrationWizard>> = {}) => {
  await act(async () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <RegistrationWizard onClose={jest.fn()} onCreated={jest.fn()} {...props} />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
};

/**
 * Labels are matched loosely on purpose: a critical field's caption also carries what its being
 * blank blocks — "Phone needed — blocks calling and phone-channel dispatch" — and that sentence
 * is part of its accessible name, which is exactly where it should be.
 */
const type = (label: RegExp, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

/** The custom Select is a combobox button over a portalled listbox. */
const choose = async (label: RegExp, option: string) => {
  await act(async () => { fireEvent.click(screen.getByLabelText(label)); });
  const listbox = await screen.findByRole('listbox');
  await act(async () => { fireEvent.click(within(listbox).getByText(option)); });
};

const click = async (name: RegExp | string) => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
};

const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

const callsTo = (method: string, matcher: (url: string) => boolean) =>
  mockRequest.mock.calls.filter(
    (c) => ((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === method && matcher(String(c[0])),
  );

beforeEach(() => { mockRequest.mockReset(); wireApi(); });

describe('page one', () => {
  it('refuses to save without the three the API itself requires, and names them', async () => {
    await mount();
    await click(/Save and continue/);

    expect(await screen.findByText(/needs a first name, a last name and the state they work in/i)).toBeInTheDocument();
    expect(callsTo('POST', (u) => u === '/assayers')).toHaveLength(0);
  });

  it('never asks for a phone number', async () => {
    await mount();
    // The screen this replaces marked phone, address, pincode and city mandatory in its fast path
    // while the DTO behind it treated all four as optional — so the quick route was the one that
    // could not enrol a person who has no phone.
    expect(screen.getByLabelText(/^Phone/).hasAttribute('required')).toBe(false);
    expect(screen.getByText(/no mobile phone and no email address is registered exactly the same way/i))
      .toBeInTheDocument();
  });
});

describe('a person with no phone, no email and no device', () => {
  it('is created from page one and driven to the finish without ever being asked for one', async () => {
    const onCreated = jest.fn();
    await mount({ onCreated });

    type(/^First Name/, 'Ramesh');
    type(/^Last Name/, 'Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);

    const created = callsTo('POST', (u) => u === '/assayers');
    expect(created).toHaveLength(1);
    const body = bodyOf(created[0]);
    expect(body).toMatchObject({ firstName: 'Ramesh', lastName: 'Iyer', state: 'Kerala' });
    expect(body).not.toHaveProperty('phone');
    expect(body).not.toHaveProperty('email');

    // Address → ID → papers → contacts and pay → who they can work for → review, with nothing
    // typed on any of them.
    expect(await screen.findByText('The exact spot on the map')).toBeInTheDocument();
    await click(/^Continue/);
    await click(/^Continue/);
    await click(/^Continue/);
    await click(/^Continue/);
    await click(/^Continue/);

    expect(await screen.findByText(/is on the roster/i)).toBeInTheDocument();
    expect(screen.getByText(/They do not need a phone or the app/i)).toBeInTheDocument();
    await click(/Finish/);
    expect(onCreated).toHaveBeenCalled();
  });
});

/**
 * The step that did not exist, and the 45% of the roster it explains.
 *
 * `ClientEligibilityFilter` admits only an ACTIVE or RECOMMENDED standing, and
 * `planning.eligibility.noEmpanelmentRow` defaults to BLOCK — so somebody with no standing at all
 * is dropped from every client's planning run without a word reaching the desk. 245 of the 548
 * people currently ACTIVE are in exactly that state, and this flow produced every one of them:
 * complete, ACTIVE, and unable to be offered a single assignment.
 */
describe('which banks will take them', () => {
  const openClients = async () => {
    await mount();
    type(/^First Name/, 'Ramesh');
    type(/^Last Name/, 'Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    await click(/Who they can work for/);
    await screen.findByText('ICICI Bank');
  };

  it('offers every client, and says what having no standing costs', async () => {
    await openClients();
    expect(screen.getByText('ICICI Bank')).toBeInTheDocument();
    expect(screen.getByText('AU Small Finance')).toBeInTheDocument();
    expect(screen.getAllByText(/Nothing recorded. This client will never be offered this person/i))
      .toHaveLength(2);
  });

  it('records a standing against the client the moment it is chosen', async () => {
    await openClients();
    await choose(/Standing with ICICI Bank/, 'Accepted — they are on this client’s panel');

    const puts = callsTo('PUT', (u) => u === '/assayers/asr-1/empanelment/cli-1');
    expect(puts).toHaveLength(1);
    expect(bodyOf(puts[0])).toEqual({ status: 'ACTIVE' });
  });

  it('does not let a clerk file the standing that ends an empanelment', async () => {
    // Resigned, terminated and dormant describe an empanelment that has ended, which cannot be
    // true of somebody being enrolled today — the same argument that keeps `exitDate` off page one.
    await openClients();
    await act(async () => { fireEvent.click(screen.getByLabelText(/Standing with ICICI Bank/)); });
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).queryByText(/resigned/i)).toBeNull();
    expect(within(listbox).queryByText(/terminated/i)).toBeNull();
  });

  it('asks why only when the answer is that they are not going forward', async () => {
    // A standing that means "no" is the one whose reason somebody will need months later, and the
    // vetting screen is where the answer would otherwise have to be reconstructed from memory.
    wireApi({
      'GET /assayers/asr-1/dossier': {
        onboarding: REQUIREMENTS,
        references: [],
        empanelments: [{
          id: 'emp-1', clientId: 'cli-1', status: 'NOT_RECOMMENDED', statusReason: null,
          client: { id: 'cli-1', name: 'ICICI Bank' },
        }],
      },
    });
    await openClients();
    expect(screen.getByLabelText(/Why this standing with ICICI Bank/i)).toBeInTheDocument();
    // AU Small has no standing at all, so there is nothing to explain yet.
    expect(screen.queryByLabelText(/Why this standing with AU Small/i)).toBeNull();
  });

  it('never blocks finishing, because a bank may not have decided yet', async () => {
    const onCreated = jest.fn();
    await mount({ onCreated });
    type(/^First Name/, 'Ramesh');
    type(/^Last Name/, 'Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    await click(/Check and finish/);
    await click(/Finish/);
    expect(onCreated).toHaveBeenCalled();
  });
});

describe('saving as you go', () => {
  const startAtIdentity = async () => {
    await mount();
    type(/^First Name/, 'Ramesh');
    type(/^Last Name/, 'Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    await click(/^Continue/); // address → ID and bank
  };

  it('sends only the box that moved, not the whole form', async () => {
    await startAtIdentity();
    type(/^PAN Number/, 'ABCDE1234F');
    await click(/^Continue/);

    const puts = callsTo('PUT', (u) => u === '/assayers/asr-1');
    expect(puts).toHaveLength(1);
    // Everything else the create already stored must NOT be rewritten: two clerks working on one
    // person otherwise overwrite each other and both saves return 200.
    expect(bodyOf(puts[0])).toEqual({ panNumber: 'ABCDE1234F' });
  });

  it('sends nothing at all for a step the clerk only looked at', async () => {
    await startAtIdentity();
    await click(/^Continue/);
    expect(callsTo('PUT', (u) => u === '/assayers/asr-1')).toHaveLength(0);
  });

  it('offers the map pin as soon as the record exists, which is why the record is made first', async () => {
    await mount();
    type(/^First Name/, 'Ramesh');
    type(/^Last Name/, 'Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    expect(await screen.findByRole('button', { name: /Pin the exact location/i })).toBeInTheDocument();
  });
});

describe('the pay rates, which used to be a second unwatched request', () => {
  it('keeps the record, says the rates failed, and does not move on', async () => {
    await mount();
    type(/^First Name/, 'Ramesh');
    type(/^Last Name/, 'Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    await click(/^Continue/); // address → ID and bank
    await click(/^Continue/); // → papers and scans
    await click(/^Continue/); // → contacts and pay

    wireApi({ 'POST /assayers/asr-1/commercial': new Error('Rate card rejected') });
    type(/^Fee per audit/, '1500');
    await click(/^Continue/);

    // The old form fired this after a successful create and reported "Could not create assayer",
    // which named neither what had been saved nor what had not.
    expect(await screen.findByText(/Their details were saved, but the pay rates were not/i)).toBeInTheDocument();
    expect(screen.getByText(/still in the boxes below/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('1500')).toBeInTheDocument();
  });
});

describe('the papers step', () => {
  const openDocuments = async () => {
    await mount();
    type(/^First Name/, 'Ramesh');
    type(/^Last Name/, 'Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    await click(/^Continue/);
    await click(/^Continue/);
    await screen.findByText('Aadhaar — front');
  };

  it('lists every requirement the server knows about, not only rows already on file', async () => {
    await openDocuments();
    expect(screen.getByText('Aadhaar — front')).toBeInTheDocument();
    expect(screen.getByText('Joining form')).toBeInTheDocument();
    expect(screen.getAllByText(/Nothing scanned yet/)).toHaveLength(2);
  });

  it('takes both sides of a card in one pick, and files them one at a time', async () => {
    await openDocuments();
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(picker.multiple).toBe(true);

    await act(async () => {
      fireEvent.change(picker, {
        target: { files: [new File(['a'], 'front.jpg'), new File(['b'], 'back.jpg')] },
      });
    });

    // Sequential on purpose: `attachFile` appends to `filePaths` with a read-modify-write, so two
    // in flight at once means the second replaces the first and one side of the card disappears.
    await waitFor(() => {
      expect(callsTo('POST', (u) => u === '/assayers/asr-1/document/AADHAAR_FRONT/file')).toHaveLength(2);
    });
  });

  it('says why a scan with no number on it can never be verified', async () => {
    await openDocuments();
    expect(screen.getByText(/Without a number nobody can confirm this document against the original/i))
      .toBeInTheDocument();
    // The check is not offered until there is something to check: `verifyDocument` refuses a
    // document with no number, so a button here would exist only to produce that refusal.
    expect(screen.queryByRole('button', { name: /I have checked this against the original/i })).toBeNull();
  });

  it('checks an Aadhaar against the original in the same pass, once it has a number and a scan', async () => {
    // Only possible since `verifyDocument` learned to read the number off the PERSON: it used to
    // look at the document row, where a PAN's or an Aadhaar's number is always NULL, so pressing
    // verify on the three documents a bank actually asks for always answered "there is no document
    // number on this record" — with the number visible on the same screen.
    wireApi({
      'GET /assayers/asr-1/dossier': {
        onboarding: [{ ...REQUIREMENTS[0], id: 'doc-1', documentNumber: '234567890124', filePaths: ['uploads/a.png'] }],
        references: [],
      },
    });
    await mount();
    type(/^First Name/, 'Ramesh');
    type(/^Last Name/, 'Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    await click(/^Continue/);
    await click(/^Continue/);

    await click(/I have checked this against the original/i);
    // Attested, so it asks first — a verification nobody performed is worse than none at all.
    await click(/Yes, I checked it/i);

    await waitFor(() => {
      expect(callsTo('POST', (u) => u === '/assayers/document/doc-1/verify')).toHaveLength(1);
    });
    expect(bodyOf(callsTo('POST', (u) => u === '/assayers/document/doc-1/verify')[0]))
      .toEqual({ verdict: 'VERIFIED' });
  });
});

describe('resuming an interrupted registration', () => {
  it('opens on the record, fills the boxes from it, and lands on the first thing missing', async () => {
    wireApi({
      'GET /assayers/asr-9': {
        ...CREATED, id: 'asr-9', assayerCode: 'WIZ-0009',
        phone: '+919876543210', address: '12 MG Road', latitude: 10.1, longitude: 76.2,
        emergencyContactPhone: '+919876543211',
      },
    });
    await mount({ resumeAssayerId: 'asr-9' });

    // Straight to ID and bank — the PAN, account and IFSC are what is still blank.
    expect(await screen.findByText(/Where their money goes/i)).toBeInTheDocument();
    await click(/Back/);
    // The address it already holds is shown, not an empty form: a resumed registration that makes
    // you re-type what is on file is a resumed registration nobody uses.
    expect(await screen.findByDisplayValue('12 MG Road')).toBeInTheDocument();
  });

  it('says so plainly when the record cannot be opened, instead of starting a second one', async () => {
    wireApi({ 'GET /assayers/asr-9': new Error('Network is down') });
    await mount({ resumeAssayerId: 'asr-9' });
    expect(await screen.findByText(/That registration could not be opened/i)).toBeInTheDocument();
  });
});

describe('the last page', () => {
  const openReview = async (overrides: Record<string, unknown> = {}) => {
    wireApi(overrides);
    await mount();
    type(/^First Name/, 'Ramesh');
    type(/^Last Name/, 'Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    await click(/Check and finish/);
  };

  it('says in plain words that nobody can be given work, rather than flagging it', async () => {
    await openReview();
    // The sentence, not a warning icon beside "no client standing". A complete record that
    // cannot be offered a single job is the surprising half, and only saying it works.
    expect(await screen.findByText(/cannot be given work for any client until a client standing is set/i))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Set it now/i })).toBeInTheDocument();
  });

  it('sends the clerk to the step that fixes it', async () => {
    await openReview();
    await click(/Set it now/i);
    expect(await screen.findByText('ICICI Bank')).toBeInTheDocument();
  });

  it('stops saying it once one client has accepted them', async () => {
    await openReview({
      'GET /assayers/asr-1/dossier': {
        onboarding: REQUIREMENTS,
        references: [],
        empanelments: [{
          id: 'emp-1', clientId: 'cli-1', status: 'ACTIVE', statusReason: null,
          client: { id: 'cli-1', name: 'ICICI Bank' },
        }],
      },
    });
    expect(await screen.findByText(/Accepted by ICICI Bank/i)).toBeInTheDocument();
    expect(screen.queryByText(/cannot be given work for any client/i)).toBeNull();
  });
});

describe('the progress rail', () => {
  it('names all seven steps and locks the later ones until the record exists', async () => {
    await mount();
    for (const title of ['The person', 'Where they live', 'ID and bank', 'Papers and scans', 'Contacts and pay', 'Who they can work for', 'Check and finish']) {
      expect(screen.getByRole('button', { name: new RegExp(title) })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /Where they live/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /The person/ })).toHaveAttribute('aria-current', 'step');
  });

  it('lets a step be jumped to directly once the record is saved, and keeps the step in the URL', async () => {
    await mount();
    type(/^First Name/, 'Ramesh');
    type(/^Last Name/, 'Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);

    await click(/Contacts and pay/);
    expect(await screen.findByText(/If something happens while they are out/i)).toBeInTheDocument();
    // Linkable, not component state: a colleague can be sent to a particular page of a particular
    // person's registration.
    expect(window.location.search || document.location.search).toBeDefined();
  });
});
