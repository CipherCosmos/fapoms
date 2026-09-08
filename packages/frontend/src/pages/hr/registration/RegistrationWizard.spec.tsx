import React from 'react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import { RegistrationWizard } from './RegistrationWizard';
import { ToastProvider } from '../../../components/ui';
import { api } from '../../../services/api';
import { AppError } from '../../../services/errors';

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
const mount = async (
  props: Partial<React.ComponentProps<typeof RegistrationWizard>> = {},
  /** A sibling to render inside the same router/toast tree — a probe reading `useSearchParams()`. */
  extra?: React.ReactNode,
) => {
  await act(async () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <RegistrationWizard onClose={jest.fn()} onCreated={jest.fn()} {...props} />
          {extra}
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
  it('refuses to save without the two the API itself requires, and names them', async () => {
    await mount();
    await click(/Save and continue/);

    expect(await screen.findByText(
      /needs their full name — exactly as printed on their Aadhaar or PAN and the state they work in/i,
    )).toBeInTheDocument();
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

  /**
   * The audit's finding: "Phone needed — blocks calling…" rendered in `--danger` red the instant
   * the page opened, one line under a header that says every box here is optional — a mistake the
   * clerk had not made yet, dressed up as one. It still SAYS so (the box genuinely is a gap until
   * something is typed); it just does not shout until the clerk has actually left it empty, or
   * tried to move past the page with it still blank.
   */
  it('keeps the Phone gap notice muted until the clerk has touched it or tried to move on', async () => {
    await mount();
    const phoneInput = screen.getByLabelText(/^Phone/);
    const phoneLabel = document.querySelector(`label[for="${phoneInput.id}"]`) as HTMLElement;
    expect(within(phoneLabel).getByText(/needed — blocks/i)).toHaveStyle({ color: 'var(--text-muted)' });

    await click(/Save and continue/); // blocked on name/state, but also marks "an advance was tried"
    expect(within(phoneLabel).getByText(/needed — blocks/i)).toHaveStyle({ color: 'var(--danger)' });
  });
});

describe('a person with no phone, no email and no device', () => {
  it('is created from page one and driven to the finish without ever being asked for one', async () => {
    const onCreated = jest.fn();
    await mount({ onCreated });

    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);

    const created = callsTo('POST', (u) => u === '/assayers');
    expect(created).toHaveLength(1);
    const body = bodyOf(created[0]);
    // The India-first naming fix: one authored `fullName`, verbatim — never a rebuilt
    // first/last pair, which the server now derives itself and which this payload must not
    // pre-empt it on.
    expect(body).toMatchObject({ fullName: 'Ramesh Iyer', state: 'Kerala' });
    expect(body).not.toHaveProperty('firstName');
    expect(body).not.toHaveProperty('lastName');
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
  const openClients = async (overrides: Record<string, unknown> = {}) => {
    if (Object.keys(overrides).length > 0) wireApi(overrides);
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
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
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    await click(/Check and finish/);
    await click(/Finish/);
    expect(onCreated).toHaveBeenCalled();
  });

  it('marks every client without a standing accepted in one pass', async () => {
    await openClients();
    await click(/Apply to all 2 remaining/);
    await click(/Mark all 2/);

    await waitFor(() => {
      expect(callsTo('PUT', (u) => u === '/assayers/asr-1/empanelment/cli-1')).toHaveLength(1);
      expect(callsTo('PUT', (u) => u === '/assayers/asr-1/empanelment/cli-2')).toHaveLength(1);
    });
    expect(bodyOf(callsTo('PUT', (u) => u === '/assayers/asr-1/empanelment/cli-1')[0]))
      .toEqual({ status: 'ACTIVE' });
  });

  it('leaves clients that already carry a standing — including a refusal — exactly as they are', async () => {
    await openClients({
      'GET /assayers/asr-1/dossier': {
        onboarding: REQUIREMENTS,
        references: [],
        empanelments: [{
          id: 'emp-1', clientId: 'cli-1', status: 'NOT_RECOMMENDED', statusReason: null,
          client: { id: 'cli-1', name: 'ICICI Bank' },
        }],
      },
    });
    await click(/Apply to all 1 remaining/);
    await click(/Mark all 1/);

    await waitFor(() => {
      expect(callsTo('PUT', (u) => u === '/assayers/asr-1/empanelment/cli-2')).toHaveLength(1);
    });
    expect(callsTo('PUT', (u) => u === '/assayers/asr-1/empanelment/cli-1')).toHaveLength(0);
  });
});

/**
 * The relationship box, ported from the vetting tab rather than reinvented.
 *
 * Both screens write `assayer_reference.relationship` — this one on first add, the vetting tab on
 * a later correction — and free text on it is exactly how one relationship became "Ex-manager",
 * "ex manager" and "Former Manager" with nothing usable to show for the 1,983 references already
 * on file. `reference-vocabulary.spec.ts` covers the shared list and its escape hatch directly;
 * this proves the wizard is actually wired to it, not a second list of its own.
 */
describe('references', () => {
  it('offers the same fixed relationship list the vetting tab uses, and posts the picked value', async () => {
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    await click(/Contacts and pay/);

    type(/Name of the person who can vouch for them/, 'Auntie Rosa');
    await choose(/How the reference knows this person/i, 'Friend');
    await click(/Add this person/);

    const posts = callsTo('POST', (u) => u === '/assayers/asr-1/reference');
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0])).toMatchObject({ fullName: 'Auntie Rosa', relationship: 'Friend' });
  });
});

describe('saving as you go', () => {
  const startAtIdentity = async () => {
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
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
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    expect(await screen.findByRole('button', { name: /Pin the exact location/i })).toBeInTheDocument();
  });
});

describe('the pay rates, which used to be a second unwatched request', () => {
  it('keeps the record, says the rates failed, and does not move on', async () => {
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
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
    type(/^Full name/, 'Ramesh Iyer');
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
    type(/^Full name/, 'Ramesh Iyer');
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

  /**
   * Client-side, against the same accept-list and size cap the server enforces
   * (`SCAN_UPLOAD_MIME_TYPES`/`DEFAULT_MAX_UPLOAD_MB` from `@fapoms/shared`) — so a clerk on a
   * slow office link learns a file is the wrong kind before waiting out an upload that was
   * always going to fail. The server stays the authority; nothing here claims otherwise.
   */
  describe('refusing an obviously bad file before it is ever sent', () => {
    it('refuses a file over the 50 MB limit without calling the upload endpoint', async () => {
      await openDocuments();
      const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
      const huge = new File(['x'], 'huge.jpg', { type: 'image/jpeg' });
      Object.defineProperty(huge, 'size', { value: 60 * 1024 * 1024 });

      await act(async () => { fireEvent.change(picker, { target: { files: [huge] } }); });

      expect(await screen.findByText(/over the 50 MB limit/i)).toBeInTheDocument();
      expect(callsTo('POST', (u) => u.includes('/document/AADHAAR_FRONT/file'))).toHaveLength(0);
    });

    it('refuses a file of the wrong kind, in the same words the server refuses it with', async () => {
      await openDocuments();
      const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
      const spreadsheet = new File(['data'], 'sheet.xlsx', { type: 'application/vnd.ms-excel' });

      await act(async () => { fireEvent.change(picker, { target: { files: [spreadsheet] } }); });

      expect(await screen.findByText(/PDF or an image \(JPEG\/PNG\/WebP\/HEIC\/TIFF\/BMP\/GIF\)/i)).toBeInTheDocument();
      expect(callsTo('POST', (u) => u.includes('/document/AADHAAR_FRONT/file'))).toHaveLength(0);
    });

    it('never refuses a blank declared type, which is what phones send for an ordinary HEIC photo', async () => {
      await openDocuments();
      const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
      const noType = new File(['a'], 'photo.heic'); // no `type` option — exactly what Android sends

      await act(async () => { fireEvent.change(picker, { target: { files: [noType] } }); });

      await waitFor(() => {
        expect(callsTo('POST', (u) => u === '/assayers/asr-1/document/AADHAAR_FRONT/file')).toHaveLength(1);
      });
    });

    it('offers the camera as well as the gallery on a phone (capture="environment")', async () => {
      await openDocuments();
      const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(picker.getAttribute('capture')).toBe('environment');
    });
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
    // Exact name: "Back to People" (the page header's own link) also matches a loose /Back/.
    await click(/^Back$/);
    // The address it already holds is shown, not an empty form: a resumed registration that makes
    // you re-type what is on file is a resumed registration nobody uses.
    expect(await screen.findByDisplayValue('12 MG Road')).toBeInTheDocument();
  });

  it('says so plainly when the record cannot be opened, instead of starting a second one', async () => {
    wireApi({ 'GET /assayers/asr-9': new Error('Network is down') });
    await mount({ resumeAssayerId: 'asr-9' });
    expect(await screen.findByText(/That registration could not be opened/i)).toBeInTheDocument();
  });

  /**
   * The India-first naming fix's own round trip: `fullName` is not a column, so a resume has to
   * seed the box from `displayName` — the server's authored, stored truth — rather than rebuild
   * it from the retired `firstName`/`lastName` pair, which a name like this one (three initials,
   * no surname) cannot pass through without losing a word.
   */
  it('seeds the full-name box from the record\'s displayName on a resume', async () => {
    wireApi({
      'GET /assayers/asr-9': { ...CREATED, id: 'asr-9', assayerCode: 'WIZ-0009', displayName: 'A K Venkatesan' },
    });
    await mount({ resumeAssayerId: 'asr-9' });
    // Phone (among others) is still blank on this record, so `firstIncompleteStep` lands the
    // wizard on "The person" directly — no navigation needed to see the seeded box.
    expect(await screen.findByDisplayValue('A K Venkatesan')).toBeInTheDocument();
  });
});

describe('the last page', () => {
  const openReview = async (overrides: Record<string, unknown> = {}) => {
    wireApi(overrides);
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    await click(/Check and finish/);
  };

  it('shows the full name once, labelled the way Aadhaar/PAN checks expect', async () => {
    // The India-first naming fix: the review page states, in so many words, that what was typed
    // is what the record now holds — not a rebuild from a retired first/last pair.
    await openReview();
    expect(await screen.findByText('Full name (as on Aadhaar/PAN)')).toBeInTheDocument();
    expect(screen.getAllByText(/Ramesh Iyer/).length).toBeGreaterThan(0);
  });

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
  it('names all seven steps, none of them disabled, before the record exists at all', async () => {
    await mount();
    for (const title of ['The person', 'Where they live', 'ID and bank', 'Papers and scans', 'Contacts and pay', 'Who they can work for', 'Check and finish']) {
      const step = screen.getByRole('button', { name: new RegExp(title) });
      expect(step).toBeInTheDocument();
      // The rail itself never locks — only a step's own Save does, and only once it is opened.
      expect(step).not.toBeDisabled();
    }
    expect(screen.getByRole('button', { name: /The person/ })).toHaveAttribute('aria-current', 'step');
  });

  /**
   * The gate this replaces (`disabledAfterFirst`) made every step past the first unreachable
   * until the record existed. Looking at one now costs nothing; what still waits on the record is
   * SAVING it — see the next test.
   */
  it('opens any step on a click, with nothing typed and no record yet', async () => {
    await mount();
    await click(/ID and bank/);
    expect(await screen.findByText(/Their identity numbers/i)).toBeInTheDocument();

    await click(/Who they can work for/);
    expect(await screen.findByText(/Available once their record is saved/i)).toBeInTheDocument();

    await click(/Papers and scans/);
    expect(await screen.findByText(/Their record has not been created yet/i)).toBeInTheDocument();
  });

  it('says why, and disables Continue, on a step that would try to save before the record exists', async () => {
    await mount();
    await click(/Contacts and pay/);

    expect(await screen.findByText(/The person creates their record — save it before this page can hold anything/i))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Continue/ })).toBeDisabled();
  });

  it('lets a step be jumped to directly once the record is saved, and keeps the step in ?step=', async () => {
    const StepProbe: React.FC = () => <span data-testid="step-param">{useSearchParams()[0].get('step')}</span>;
    await mount({}, <StepProbe />);
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);

    await click(/Contacts and pay/);
    expect(await screen.findByText(/If something happens while they are out/i)).toBeInTheDocument();
    // `?step=`, this flow's own key — not `?view=`, which every other HR page's chip strip owns.
    expect(screen.getByTestId('step-param')).toHaveTextContent('people');
  });
});

/**
 * A review that can only agree is not a review.
 *
 * Both screens hard-coded `verdict: 'VERIFIED'`, so a photograph too dark to read had no outcome
 * except being left alone forever — and the person who sent it was told nothing and waited.
 */
describe('the papers step — sending a scan back', () => {
  const AADHAAR_FRONT = {
    requirement: 'AADHAAR_FRONT', label: 'Aadhaar — front', identity: true,
    id: 'doc-1', softCopyReceived: true, hardCopyReceived: null,
    documentNumber: '234567890124', expiryDate: null, verificationStatus: null,
    filePaths: ['uploads/a.png'],
    prints: { name: true, dateOfBirth: true, gender: true, guardianName: false, address: false },
  };

  const reachPapers = async () => {
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    await click(/^Continue/);
    await click(/^Continue/);
  };

  it('asks only for the details this card actually prints', async () => {
    // An Aadhaar's address is on the BACK, so the front must not ask for one.
    wireApi({ 'GET /assayers/asr-1/dossier': { onboarding: [AADHAAR_FRONT], references: [] } });
    await reachPapers();

    expect(screen.getByLabelText(/Name exactly as printed/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Date of birth on the card/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Address as printed/i)).not.toBeInTheDocument();
  });

  it('sends what the reviewer read off the card with the verdict', async () => {
    wireApi({ 'GET /assayers/asr-1/dossier': { onboarding: [AADHAAR_FRONT], references: [] } });
    await reachPapers();

    type(/Name exactly as printed/i, 'Ramesh Iyer');
    await click(/I have checked this against the original/i);
    await click(/Yes, I checked it/i);

    await waitFor(() => {
      expect(callsTo('POST', (u) => u === '/assayers/document/doc-1/verify')).toHaveLength(1);
    });
    expect(bodyOf(callsTo('POST', (u) => u === '/assayers/document/doc-1/verify')[0]))
      .toMatchObject({ verdict: 'VERIFIED', holderName: 'Ramesh Iyer' });
  });

  /**
   * Both `window.prompt` call sites (the reason picker here, the name-mismatch override below)
   * are a proper `Modal` form now — see `RejectDocumentModal`/`NameMismatchModal` in
   * DocumentsStep.tsx. `window.prompt` is not mocked anywhere in this describe block any more:
   * a leftover mock would hide a regression back to it just as effectively as removing the assertion.
   */
  it('sends a scan back with a reason, which is what reaches their phone', async () => {
    wireApi({ 'GET /assayers/asr-1/dossier': { onboarding: [AADHAAR_FRONT], references: [] } });
    await reachPapers();

    await click(/Send it back/i);
    expect(await screen.findByText(/Why is Aadhaar — front being sent back/i)).toBeInTheDocument();
    await choose(/Why this document is being sent back/i, 'Too blurred or dark to read');
    await click(/Yes, send it back/i);

    await waitFor(() => {
      expect(callsTo('POST', (u) => u === '/assayers/document/doc-1/verify')).toHaveLength(1);
    });
    expect(bodyOf(callsTo('POST', (u) => u === '/assayers/document/doc-1/verify')[0]))
      .toEqual({ verdict: 'REJECTED', rejectionReason: 'ILLEGIBLE' });
  });

  it('also sends a free-text note, kept on the record and never shown to the appraiser', async () => {
    wireApi({ 'GET /assayers/asr-1/dossier': { onboarding: [AADHAAR_FRONT], references: [] } });
    await reachPapers();

    await click(/Send it back/i);
    await choose(/Why this document is being sent back/i, 'This is a different document');
    type(/Note \(optional/i, 'Brought a driving licence by mistake.');
    await click(/Yes, send it back/i);

    await waitFor(() => {
      expect(bodyOf(callsTo('POST', (u) => u === '/assayers/document/doc-1/verify')[0]))
        .toEqual({ verdict: 'REJECTED', rejectionReason: 'WRONG_DOCUMENT', remarks: 'Brought a driving licence by mistake.' });
    });
  });

  it('the confirm button stays disabled until a reason is actually chosen', async () => {
    wireApi({ 'GET /assayers/asr-1/dossier': { onboarding: [AADHAAR_FRONT], references: [] } });
    await reachPapers();

    await click(/Send it back/i);
    expect(screen.getByRole('button', { name: /Yes, send it back/i })).toBeDisabled();
  });

  it('sends nothing when the reviewer cancels out of the reason dialog', async () => {
    wireApi({ 'GET /assayers/asr-1/dossier': { onboarding: [AADHAAR_FRONT], references: [] } });
    await reachPapers();

    await click(/Send it back/i);
    await click(/^Cancel$/);

    expect(screen.queryByText(/Why is Aadhaar — front being sent back/i)).not.toBeInTheDocument();
    expect(callsTo('POST', (u) => u === '/assayers/document/doc-1/verify')).toHaveLength(0);
  });

  /**
   * The other `window.prompt` this step used to have: accepting a name that does not match the
   * record. `NameMismatchModal` keeps the prompt's own wording ("If it is the same person, say
   * why:") and its ten-character floor, now as a real dialog with the reason for the floor visible
   * instead of a silently-discarded short answer.
   */
  it('offers a modal, not a native prompt, when a checked name disagrees with the record', async () => {
    wireApi({
      'GET /assayers/asr-1/dossier': { onboarding: [AADHAAR_FRONT], references: [] },
      'POST /assayers/document/doc-1/verify': new Error('The name “Ramesh Iyer” does not match the name on the record, “Suresh Iyer”.'),
    });
    await reachPapers();

    type(/Name exactly as printed/i, 'Ramesh Iyer');
    await click(/I have checked this against the original/i);
    await click(/Yes, I checked it/i);

    expect(await screen.findByText(/does not match the name on the record/i)).toBeInTheDocument();
    expect(screen.getByText(/If it is the same person, say why:/i)).toBeInTheDocument();
    // The floor is stated, not silently enforced — a short answer is refused with a reason.
    expect(screen.getByRole('button', { name: /Verify anyway/i })).toBeDisabled();
  });

  it('retries with the reviewer\'s note once it clears the ten-character floor', async () => {
    let attempt = 0;
    mockRequest.mockImplementation((url: string, opts?: RequestInit) => {
      const method = (opts?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url === '/assayers/document/doc-1/verify') {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new Error('The name does not match the name on the record.'))
          : Promise.resolve({ success: true });
      }
      if (url.includes('workforce-attribute/vocabulary')) return Promise.resolve({ skills: [], certifications: [], languages: [] });
      if (url.startsWith('/clients')) return Promise.resolve({ items: CLIENTS });
      if (url.includes('/dossier')) return Promise.resolve({ onboarding: [AADHAAR_FRONT], references: [] });
      if (method === 'POST' && url === '/assayers') return Promise.resolve({ ...CREATED });
      if (method === 'PUT' && url.startsWith('/assayers/')) return Promise.resolve({ ...CREATED });
      if (method === 'GET' && /^\/assayers\/[^/]+$/.test(url)) return Promise.resolve({ ...CREATED });
      return Promise.resolve({ success: true, data: [] });
    });
    await reachPapers();

    type(/Name exactly as printed/i, 'Ramesh Iyer');
    await click(/I have checked this against the original/i);
    await click(/Yes, I checked it/i);
    await screen.findByText(/If it is the same person, say why:/i);

    type(/If it is the same person, say why/i, 'Maiden name on the card.');
    await click(/Verify anyway/i);

    await waitFor(() => {
      const retried = callsTo('POST', (u) => u === '/assayers/document/doc-1/verify');
      expect(retried).toHaveLength(2);
      expect(bodyOf(retried[1])).toMatchObject({ nameMismatchNote: 'Maiden name on the card.' });
    });
  });
});

/**
 * Tidying up what was pasted, on the way out of the box — never on the way in, so a clerk mid
 * keystroke never has letters silently disappear from under the caret the way a hard `maxLength`
 * used to make them.
 */
describe('normalising what was pasted, on blur', () => {
  it('strips the spaces and dashes out of a pasted PAN, and says what it did', async () => {
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    await click(/ID and bank/);

    const panBox = await screen.findByLabelText(/^PAN Number/);
    fireEvent.change(panBox, { target: { value: 'ABCDE 1234-F' } });
    fireEvent.blur(panBox);

    expect(await screen.findByDisplayValue('ABCDE1234F')).toBeInTheDocument();
    expect(screen.getByText('Cleaned up: ABCDE 1234-F → ABCDE1234F')).toBeInTheDocument();
  });

  it('runs a pasted phone number through the shared normalisePhone on blur', async () => {
    await mount();
    const phoneBox = screen.getByLabelText(/^Phone/);
    fireEvent.change(phoneBox, { target: { value: '+91 98765-43210' } });
    fireEvent.blur(phoneBox);

    expect(await screen.findByDisplayValue('9876543210')).toBeInTheDocument();
    expect(screen.getByText('Cleaned up: +91 98765-43210 → 9876543210')).toBeInTheDocument();
  });

  it('leaves an already-clean value alone — no caption for nothing to clean up', async () => {
    await mount();
    const phoneBox = screen.getByLabelText(/^Phone/);
    fireEvent.change(phoneBox, { target: { value: '9876543210' } });
    fireEvent.blur(phoneBox);

    expect(screen.queryByText(/^Cleaned up:/)).not.toBeInTheDocument();
  });
});

/**
 * The audit's #1 error-proneness finding: a format failure rendered exactly like a routine hint,
 * so a clerk had no visual reason to believe anything was wrong until the server said so.
 */
describe('a format failure looks like an error once the box has been left, not before', () => {
  const gotoIdentity = async () => {
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    await click(/ID and bank/);
    return (await screen.findByLabelText(/^PAN Number/)) as HTMLInputElement;
  };

  it('stays a muted, routine-looking hint while the box is still being typed into', async () => {
    const panBox = await gotoIdentity();
    fireEvent.change(panBox, { target: { value: 'NOTAPAN' } });

    const hint = screen.getByText(/A PAN looks like ABCDE1234F/i);
    expect(hint.parentElement).toHaveStyle({ color: 'var(--text-muted)' });
    expect(panBox).not.toHaveStyle({ borderColor: 'var(--danger)' });
  });

  it('turns red, with an icon, and tints the box border once the invalid value is left', async () => {
    const panBox = await gotoIdentity();
    fireEvent.change(panBox, { target: { value: 'NOTAPAN' } });
    fireEvent.blur(panBox);

    const hint = await screen.findByText(/A PAN looks like ABCDE1234F/i);
    expect(hint.parentElement).toHaveStyle({ color: 'var(--danger)' });
    expect(hint.parentElement?.querySelector('svg')).toBeInTheDocument();
    // A raw-attribute check rather than `toHaveStyle`: jsdom's CSSOM does not recompute the
    // `border` shorthand when `border-color` is layered on afterward in the same style object,
    // so it never reports the merged colour — a real browser applies exactly this override.
    expect(panBox.getAttribute('style')).toMatch(/border-color:\s*var\(--danger\)/);
  });

  it('goes back to looking routine once the value is fixed', async () => {
    const panBox = await gotoIdentity();
    fireEvent.change(panBox, { target: { value: 'NOTAPAN' } });
    fireEvent.blur(panBox);
    await screen.findByText(/A PAN looks like ABCDE1234F/i);

    fireEvent.change(panBox, { target: { value: 'ABCDE1234F' } });
    expect(screen.queryByText(/A PAN looks like ABCDE1234F/i)).not.toBeInTheDocument();
  });
});

/**
 * Helping a clerk notice somebody is already on the roster — never blocking the save either way.
 * Track 1's endpoint contract, coded to verbatim: `GET /assayers/identifier-check?phone=&panNumber=
 * &aadhaarNumber=&excludeId=` -> `{ success, data: { matches: [...] } }` on the wire — but `api.request` unwraps the envelope, so the hook (and this mock) see `{ matches: [...] }`. The envelope-typed version of this mock shipped the same silent-empty bug the Approvals queue had.
 */
describe('the duplicate check', () => {
  const MATCH = {
    id: 'existing-1', assayerCode: 'AS0042', displayName: 'Prakash Menon',
    lifecycleStatus: 'ACTIVE', matchedOn: 'phone',
  };

  it('shows a card naming the roster match, in plain English, once the phone is format-valid', async () => {
    wireApi({
      'GET /assayers/identifier-check': { matches: [MATCH] },
    });
    await mount();
    const phoneBox = screen.getByLabelText(/^Phone/);
    fireEvent.change(phoneBox, { target: { value: '9876543210' } });
    fireEvent.blur(phoneBox);

    expect(await screen.findByText(/Already on the roster:/i)).toBeInTheDocument();
    expect(screen.getByText(/Prakash Menon/)).toBeInTheDocument();
    expect(screen.getByText(/AS0042/)).toBeInTheDocument();
    // The lifecycle value reads as words, never the bare enum.
    expect(screen.queryByText('ACTIVE')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open their record' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'This is a different person' })).toBeInTheDocument();
  });

  it('never blocks saving — the step still commits with the match on screen', async () => {
    wireApi({
      'GET /assayers/identifier-check': { matches: [MATCH] },
    });
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    const phoneBox = screen.getByLabelText(/^Phone/);
    fireEvent.change(phoneBox, { target: { value: '9876543210' } });
    fireEvent.blur(phoneBox);
    await screen.findByText(/Already on the roster:/i);

    await click(/Save and continue/);
    expect(callsTo('POST', (u) => u === '/assayers')).toHaveLength(1);
  });

  it('"This is a different person" dismisses the card for that value', async () => {
    wireApi({
      'GET /assayers/identifier-check': { matches: [MATCH] },
    });
    await mount();
    const phoneBox = screen.getByLabelText(/^Phone/);
    fireEvent.change(phoneBox, { target: { value: '9876543210' } });
    fireEvent.blur(phoneBox);
    await screen.findByText(/Already on the roster:/i);

    await click('This is a different person');
    expect(screen.queryByText(/Already on the roster:/i)).not.toBeInTheDocument();
  });

  it('never checks a value that does not look like a real phone number yet', async () => {
    wireApi({
      'GET /assayers/identifier-check': { matches: [MATCH] },
    });
    await mount();
    const phoneBox = screen.getByLabelText(/^Phone/);
    fireEvent.change(phoneBox, { target: { value: '123' } });
    fireEvent.blur(phoneBox);

    await new Promise((r) => setTimeout(r, 450));
    expect(callsTo('GET', (u) => u.startsWith('/assayers/identifier-check'))).toHaveLength(0);
  });

  it('degrades silently once the endpoint answers 404 — not built yet', async () => {
    wireApi({ 'GET /assayers/identifier-check': new AppError('Not found', 'Not found', 404) });
    await mount();
    const phoneBox = screen.getByLabelText(/^Phone/);
    fireEvent.change(phoneBox, { target: { value: '9876543210' } });
    fireEvent.blur(phoneBox);

    await new Promise((r) => setTimeout(r, 450));
    expect(screen.queryByText(/Already on the roster:/i)).not.toBeInTheDocument();
  });
});

/**
 * `bankName` used to stay a plain, overwritable box even after `resolveIfsc` had just filled it —
 * the comment on `renderFormField`'s old `ifscInfo` parameter said so explicitly. It locks now,
 * with a deliberate way out.
 */
describe('bankName locks once the IFSC code resolves it', () => {
  const gotoIdentity = async () => {
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Save and continue/);
    await click(/ID and bank/);
  };

  it('turns read-only, showing the resolved name, once the code resolves', async () => {
    wireApi({
      'GET /geo/ifsc/HDFC0001234': { bankName: 'HDFC Bank', branchName: 'MG Road', city: 'Kochi', state: 'Kerala', address: null },
    });
    await gotoIdentity();

    const ifscBox = screen.getByLabelText(/^IFSC Code/);
    fireEvent.change(ifscBox, { target: { value: 'HDFC0001234' } });
    fireEvent.blur(ifscBox);

    const bankNameBox = await screen.findByDisplayValue('HDFC Bank') as HTMLInputElement;
    expect(bankNameBox).toHaveAttribute('readonly');
    expect(screen.getByText(/Filled in from the IFSC code/i)).toBeInTheDocument();
  });

  it('"Edit anyway" turns it back into an ordinary, overwritable box', async () => {
    wireApi({
      'GET /geo/ifsc/HDFC0001234': { bankName: 'HDFC Bank', branchName: 'MG Road', city: 'Kochi', state: 'Kerala', address: null },
    });
    await gotoIdentity();
    fireEvent.change(screen.getByLabelText(/^IFSC Code/), { target: { value: 'HDFC0001234' } });
    fireEvent.blur(screen.getByLabelText(/^IFSC Code/));
    await screen.findByDisplayValue('HDFC Bank');

    await click(/Edit anyway/i);

    const bankNameBox = screen.getByDisplayValue('HDFC Bank') as HTMLInputElement;
    expect(bankNameBox).not.toHaveAttribute('readonly');
    fireEvent.change(bankNameBox, { target: { value: 'HDFC Bank — Fort Kochi branch' } });
    expect(screen.getByDisplayValue('HDFC Bank — Fort Kochi branch')).toBeInTheDocument();
  });
});
