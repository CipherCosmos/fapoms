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
 * The desk filling in a candidate's application, walked end to end.
 *
 * The requirement these tests exist for is a sentence from the owner: *every assayer doesn't have
 * a smartphone, so HR should be able to register them end to end from their side.* So the central
 * case below drives a person with no mobile number, no email address and no account from an empty
 * form to the finish, and asserts that nothing along the way asked for a device.
 *
 * **What changed under them.** This form used to write a live `assayers` row, created by step one,
 * which is how a half-finished registration became a half-finished employee and how anybody could
 * walk past the interview → application → review pipeline entirely. It writes the candidate's
 * APPLICATION now — the same row they fill in through their own link — so the assertions that used
 * to count `POST /assayers` calls count `PATCH /hr/applications/:id` bodies instead, and the ones
 * about a record that does not exist yet are gone with the condition: the application exists
 * before this form opens.
 */

const CLIENTS = [
  { id: 'cli-1', name: 'ICICI Bank' },
  { id: 'cli-2', name: 'AU Small Finance' },
];

const APP_ID = 'app-1';

/** The application row, as `PATCH` answers with it. */
const APPLICATION = {
  id: APP_ID,
  status: 'DRAFT',
  // Blank, the way a freshly invited application is: an interview PASS fills in whatever the
  // candidate's name was given as and nothing else, and the desk types the rest.
  fullName: null,
  mobile: '9822014455',
  email: null,
  dateOfBirth: null,
  gender: null,
  address: '',
  state: null,
  city: '',
  pincode: null,
  experienceYears: null,
  currentEmployer: null,
  expertise: null,
  availability: null,
  employmentCategory: null,
  consentAcceptedAt: null,
  tokenConsumedAt: null,
  extendedProfile: null,
};

/** What `GET /hr/applications/:id` returns — the row, its scans, its gaps and what is asked for. */
const VIEW = {
  application: APPLICATION,
  documents: [],
  gaps: [],
  documentsRequested: ['PHOTOGRAPH', 'PAN_CARD'],
  invitedMobile: null,
};

/** A tiny router over the endpoints the wizard actually touches. */
const wireApi = (overrides: Record<string, unknown> = {}) => {
  /*
    The application's profile as the server would hold it, mutated by each PATCH. A mock that
    answered with only what the last request sent would wipe a standing the read had supplied,
    which the real `updateStaffDraft` does not do — it merges into the row and saves it.
  */
  const seeded = (overrides[`GET /hr/applications/${APP_ID}`] as { application?: Record<string, unknown> })?.application;
  let profile: Record<string, unknown> = {
    ...((seeded?.extendedProfile as Record<string, unknown>) ?? {}),
  };
  /*
    And the columns, for the same reason: the wizard's dirty diff is "differs from the last saved
    value", so a mock that answered every PATCH with the same blank row would leave every box
    permanently dirty and re-send the whole form on every step — which is the exact overwrite the
    diff exists to prevent, performed by the test double.
  */
  let columns: Record<string, unknown> = { ...(seeded ?? APPLICATION) };
  mockRequest.mockImplementation((url: string, opts?: RequestInit) => {
    const method = (opts?.method ?? 'GET').toUpperCase();
    for (const [key, value] of Object.entries(overrides)) {
      if (`${method} ${url}`.startsWith(key)) {
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      }
    }
    if (url.includes('workforce-attribute/vocabulary')) return Promise.resolve({ skills: [], certifications: [], languages: [] });
    if (url.startsWith('/clients')) return Promise.resolve({ items: CLIENTS });
    if (method === 'GET' && url.startsWith(`/hr/applications/${APP_ID}`)) {
      return Promise.resolve({ ...VIEW, application: { ...columns, extendedProfile: profile } });
    }
    if (method === 'PATCH' && url === `/hr/applications/${APP_ID}`) {
      /*
        Echoes the lists back, because the real route does: `updateStaffDraft` saves and returns
        the row, `extendedProfile` included. A mock that answered with a bare application would
        have the wizard's own `useEffect` reset the standings it had just sent — which is a thing
        the screen would genuinely do if the server ever stopped echoing, so it is worth the
        fixture being accurate rather than convenient.
      */
      const sent = JSON.parse(String(opts?.body ?? '{}'));
      const { record, empanelments, references, commercial, sourceReferral, ...rest } = sent;
      profile = {
        ...profile,
        ...(sourceReferral !== undefined ? { sourceReferral } : {}),
        ...(empanelments ? { empanelments } : {}),
        ...(references ? { references } : {}),
        ...(commercial ? { commercial } : {}),
        ...(record ? { fields: { ...(profile.fields as object ?? {}), ...record } } : {}),
      };
      columns = { ...columns, ...rest };
      return Promise.resolve({ ...columns, extendedProfile: profile });
    }
    if (method === 'POST' && url.startsWith(`/hr/applications/${APP_ID}/documents`)) return Promise.resolve({ id: 'doc-1' });
    if (url.startsWith('/assayers?') || url.startsWith('/assayers/identifier-check')) {
      return Promise.resolve({ matches: [] });
    }
    return Promise.resolve({ success: true, data: [] });
  });
};

/**
 * Rendered inside `act` because the wizard fires two fetches on mount — the roster's skill
 * vocabulary and the application itself. Without it every test prints a wall of "not wrapped in
 * act" warnings for state that settled correctly.
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
          <RegistrationWizard applicationId={APP_ID} onClose={jest.fn()} onCreated={jest.fn()} {...props} />
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

/** The body of the last desk save, which is where the standings and references now travel. */
const lastPatch = (): Record<string, unknown> => {
  const patches = callsTo('PATCH', (u) => u === `/hr/applications/${APP_ID}`);
  return patches.length === 0 ? {} : bodyOf(patches[patches.length - 1]);
};

const callsTo = (method: string, matcher: (url: string) => boolean) =>
  mockRequest.mock.calls.filter(
    (c) => ((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === method && matcher(String(c[0])),
  );

beforeEach(() => { mockRequest.mockReset(); wireApi(); });

describe('page one', () => {
  it('refuses to save without the two the API itself requires, and names them', async () => {
    await mount();
    await click(/Continue/);

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
    // With no number at all. The phone box now opens holding the mobile the candidate was invited
    // on, so an ordinary application has no phone gap to warn about — this rule is for the one that
    // genuinely does.
    wireApi({
      [`GET /hr/applications/${APP_ID}`]: { ...VIEW, application: { ...APPLICATION, mobile: '' } },
    });
    await mount();
    const phoneInput = screen.getByLabelText(/^Phone/);
    const phoneLabel = document.querySelector(`label[for="${phoneInput.id}"]`) as HTMLElement;
    expect(within(phoneLabel).getByText(/needed — blocks/i)).toHaveStyle({ color: 'var(--text-muted)' });

    await click(/Continue/); // blocked on name/state, but also marks "an advance was tried"
    expect(within(phoneLabel).getByText(/needed — blocks/i)).toHaveStyle({ color: 'var(--danger)' });
  });
});

describe('a person with no phone, no email and no device', () => {
  it('is filled in from page one and driven to the finish without ever being asked for one', async () => {
    const onCreated = jest.fn();
    await mount({ onCreated });

    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Continue/);

    // Nothing is created. The application already exists — an interview PASS made it — and this
    // is the desk typing into it.
    expect(callsTo('POST', (u) => u === '/assayers')).toHaveLength(0);
    // The India-first naming fix: one authored `fullName`, verbatim — never a rebuilt first/last
    // pair, which the server derives itself and which this payload must not pre-empt it on.
    expect(lastPatch()).toMatchObject({ fullName: 'Ramesh Iyer', state: 'Kerala' });
    expect(lastPatch()).not.toHaveProperty('firstName');
    expect(lastPatch()).not.toHaveProperty('lastName');
    // `phone` is on the registration allow-list and rides under `record`; the application's own
    // `mobile` column belongs to the candidate, who confirms it with their code.
    expect(lastPatch()).not.toHaveProperty('mobile');

    // Address → ID → papers → contacts and pay → who they can work for → review, with nothing
    // typed on any of them.
    expect(await screen.findByText('The exact spot on the map')).toBeInTheDocument();
    await click(/^Continue/);
    await click(/^Continue/);
    await click(/^Continue/);
    await click(/^Continue/);
    await click(/^Continue/);

    expect(await screen.findByText(/application is filled in/i)).toBeInTheDocument();
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
    await click(/Continue/);
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

  /**
   * Held, not written.
   *
   * This used to `PUT /assayers/:id/empanelment/:clientId` the moment a standing was chosen, which
   * it could, because step one had already put a live person on the roster. There is no assayer
   * and no empanelment row until somebody approves the application, so a standing is one more
   * thing the application carries and `applyExtendedProfile` files at promotion.
   */
  it('records a standing against the client, and sends it with the step', async () => {
    await openClients();
    await choose(/Standing with ICICI Bank/, 'Accepted — they are on this client’s panel');
    expect(callsTo('PUT', (u) => u.includes('empanelment'))).toHaveLength(0);

    await click(/Continue/);
    await waitFor(() => {
      expect(lastPatch().empanelments).toEqual([{ clientId: 'cli-1', status: 'ACTIVE' }]);
    });
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
      [`GET /hr/applications/${APP_ID}`]: {
        ...VIEW,
        application: {
          ...APPLICATION,
          extendedProfile: { empanelments: [{ clientId: 'cli-1', status: 'NOT_RECOMMENDED' }] },
        },
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
    await click(/Continue/);
    await click(/Check and finish/);
    await click(/Finish/);
    expect(onCreated).toHaveBeenCalled();
  });

  it('marks every client without a standing accepted in one pass', async () => {
    await openClients();
    await click(/Apply to all 2 remaining/);
    await click(/Mark all 2/);
    await click(/Continue/);

    // One body, not a loop of writes any of which could fail on its own.
    await waitFor(() => {
      expect(lastPatch().empanelments).toEqual([
        { clientId: 'cli-1', status: 'ACTIVE' },
        { clientId: 'cli-2', status: 'ACTIVE' },
      ]);
    });
  });

  it('leaves clients that already carry a standing — including a refusal — exactly as they are', async () => {
    await openClients({
      [`GET /hr/applications/${APP_ID}`]: {
        ...VIEW,
        application: {
          ...APPLICATION,
          extendedProfile: { empanelments: [{ clientId: 'cli-1', status: 'NOT_RECOMMENDED' }] },
        },
      },
    });
    await click(/Apply to all 1 remaining/);
    await click(/Mark all 1/);
    await click(/Continue/);

    await waitFor(() => {
      const sent = lastPatch().empanelments as Array<{ clientId: string; status: string }>;
      expect(sent).toContainEqual({ clientId: 'cli-1', status: 'NOT_RECOMMENDED' });
      expect(sent).toContainEqual({ clientId: 'cli-2', status: 'ACTIVE' });
    });
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
describe('who referred them', () => {
  it('shows the referral the interview recorded, and sends an edit with the step\'s save', async () => {
    wireApi({
      [`GET /hr/applications/${APP_ID}`]: {
        ...VIEW,
        application: {
          ...APPLICATION,
          extendedProfile: { sourceReferral: { type: 'ASSAYER', name: 'Suresh Nair', mobile: '9876543210', email: '', recordedBy: 'HR' } },
        },
      },
    });
    await mount();
    await click(/Contacts and pay/);

    expect(screen.getByLabelText(/Referrer.s name/)).toHaveValue('Suresh Nair');
    fireEvent.change(screen.getByLabelText(/Referrer.s name/), { target: { value: 'Suresh K Nair' } });
    await click(/^Continue/);
    await waitFor(() => {
      expect(lastPatch().sourceReferral).toEqual(expect.objectContaining({ name: 'Suresh K Nair', mobile: '9876543210' }));
    });
  });
});

describe('references', () => {
  it('offers the same fixed relationship list the vetting tab uses, and posts the picked value', async () => {
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Continue/);
    await click(/Contacts and pay/);

    type(/Name of the person who can vouch for them/, 'Auntie Rosa');
    await choose(/How the reference knows this person/i, 'Friend');
    await click(/Add this person/);

    /*
      Held with the application, not written as a row of its own — there is no person to be a
      reference FOR until somebody approves it. `applyExtendedProfile` replays them through
      `rosterRecords.saveReference` at promotion, which is the same call this used to make here.
    */
    expect(callsTo('POST', (u) => u.includes('/reference'))).toHaveLength(0);
    await click(/^Continue/);
    await waitFor(() => {
      expect(lastPatch().references)
        .toEqual([expect.objectContaining({ fullName: 'Auntie Rosa', relationship: 'Friend' })]);
    });
  });

  it('stops at three references — a fourth has nowhere to go', async () => {
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Continue/);
    await click(/Contacts and pay/);

    for (const name of ['Ref One', 'Ref Two', 'Ref Three']) {
      type(/Name of the person who can vouch for them/, name);
      await click(/Add this person/);
    }

    // No box to type a fourth into, and a sentence saying why — rather than a box that refuses.
    await waitFor(() => {
      expect(screen.getByText(/Three references is the most an application takes/)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/Name of the person who can vouch for them/)).not.toBeInTheDocument();
  });

  /**
   * With a ceiling of three and no Remove, one mistyped name left the clerk unable to add the
   * reference they meant — the candidate's own form always had Remove; the desk's did not.
   */
  it('removes a reference, which gives the add box back at the ceiling', async () => {
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Continue/);
    await click(/Contacts and pay/);

    for (const name of ['Ref One', 'Ref Two', 'Ref Three']) {
      type(/Name of the person who can vouch for them/, name);
      await click(/Add this person/);
    }
    fireEvent.click(await screen.findByRole('button', { name: 'Remove reference Ref Two' }));

    expect(screen.queryByText('Ref Two')).not.toBeInTheDocument();
    expect(screen.getByText('Ref One')).toBeInTheDocument();
    expect(screen.getByLabelText(/Name of the person who can vouch for them/)).toBeInTheDocument();
  });
});

describe('saving as you go', () => {
  const startAtIdentity = async () => {
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Continue/);
    await click(/^Continue/); // address → ID and bank
  };

  it('sends only the box that moved, not the whole form', async () => {
    await startAtIdentity();
    type(/^PAN Number/, 'ABCDE1234F');
    await click(/^Continue/);

    const patches = callsTo('PATCH', (u) => u === `/hr/applications/${APP_ID}`);
    // Everything else already stored must NOT be rewritten. It matters more here than it did
    // against a record: the candidate may be filling the same application in from their phone
    // while the desk types, and `extended_profile` is one jsonb column written whole.
    expect(bodyOf(patches[patches.length - 1])).toEqual({ record: { panNumber: 'ABCDE1234F' } });
  });

  it('sends nothing at all for a step the clerk only looked at', async () => {
    await startAtIdentity();
    const before = callsTo('PATCH', (u) => u === `/hr/applications/${APP_ID}`).length;
    await click(/^Continue/);
    expect(callsTo('PATCH', (u) => u === `/hr/applications/${APP_ID}`)).toHaveLength(before);
  });

  it('offers the map pin immediately, because there is nothing to wait for', async () => {
    // It used to say "as soon as the record exists, which is why the record is made first" — that
    // WAS the reason step one created a roster row, and the pin was hidden until it had. There is
    // nothing to wait for now: the coordinate is collected onto the application, with nothing typed
    // on page one, and applied when it is approved.
    await mount();
    await click(/Where they live/);
    expect(await screen.findByRole('button', { name: /Pin the exact location/i })).toBeInTheDocument();
  });
});

/**
 * The pay rates used to be a second, separate request fired after the record save had succeeded —
 * `POST /assayers/:id/commercial` — so a failure there left a real person on the roster with no
 * rates behind a message that named neither what had been created nor what had not.
 *
 * They ride in the same body now, because an application holds them: `approve()` applies
 * `extendedProfile.commercial` through the same guarded service, and until the desk could send
 * one, nothing in the product ever had. There is no second request left to fail on its own.
 */
describe('the pay rates, which used to be a second unwatched request', () => {
  const openPay = async () => {
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Continue/);
    await click(/Contacts and pay/);
  };

  it('rides in the same body as the rest of the step', async () => {
    await openPay();
    type(/^Fee per audit/, '1500');
    await click(/^Continue/);

    await waitFor(() => {
      expect(lastPatch().commercial).toMatchObject({ baseFee: 1500, currency: 'INR' });
    });
    expect(callsTo('POST', (u) => u.includes('/commercial'))).toHaveLength(0);
  });

  it('files nothing when no rate was agreed, rather than a profile of zeroes', async () => {
    await openPay();
    await click(/^Continue/);
    expect(lastPatch().commercial).toBeUndefined();
  });

  it('keeps the typed rates on screen and does not move on when the save fails', async () => {
    await openPay();
    wireApi({ [`PATCH /hr/applications/${APP_ID}`]: new Error('Rate card rejected') });
    type(/^Fee per audit/, '1500');
    await click(/^Continue/);

    expect(await screen.findByText(/Rate card rejected/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('1500')).toBeInTheDocument();
  });
});

describe('the papers step', () => {
  const openDocuments = async () => {
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Continue/);
    await click(/^Continue/);
    await click(/^Continue/);
    await screen.findByText('Photograph');
  };

  it('asks for exactly what the server says this candidate needs', async () => {
    // The list is `documentsRequested`, which depends on whether they are a freelancer or a
    // proprietor — the spec's two document sets. Not rebuilt here, so the desk is asked for the
    // same things the candidate's own form asks for.
    await openDocuments();
    expect(screen.getByText('Photograph')).toBeInTheDocument();
    expect(screen.getByText('PAN card')).toBeInTheDocument();
    expect(screen.getAllByText(/Not yet attached/)).toHaveLength(2);
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

    // Sequential on purpose: the route appends to `filePaths` with a read-modify-write, so two in
    // flight at once means the second replaces the first and one side of the card disappears.
    await waitFor(() => {
      expect(callsTo('POST', (u) => u === `/hr/applications/${APP_ID}/documents/PHOTOGRAPH`)).toHaveLength(2);
    });
  });

  /**
   * Said plainly rather than enforced. Only the photograph is refused at approval — it is what the
   * ID card prints, and a field identity card with no face on it is not one — and everything else
   * travels with the person as a gap to chase. A step that refused to advance would stop a
   * candidate being registered because their electricity bill is at home.
   */
  it('says what is still outstanding without blocking on it', async () => {
    await openDocuments();
    expect(screen.getByText(/2 of 2 still to come/i)).toBeInTheDocument();
    expect(screen.getByText(/except the photograph, which approval refuses without/i)).toBeInTheDocument();
  });

  it('says where checking a document against the original happens', async () => {
    // It happens on the record, after approval, because that is the only place with somewhere to
    // put a verdict — an application document is a requirement and its file paths, nothing else.
    await openDocuments();
    expect(screen.getByText(/Checking a document against the original happens on their record/i))
      .toBeInTheDocument();
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
      expect(callsTo('POST', (u) => u.includes('/documents/PHOTOGRAPH'))).toHaveLength(0);
    });

    it('refuses a file of the wrong kind, in the same words the server refuses it with', async () => {
      await openDocuments();
      const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
      const spreadsheet = new File(['data'], 'sheet.xlsx', { type: 'application/vnd.ms-excel' });

      await act(async () => { fireEvent.change(picker, { target: { files: [spreadsheet] } }); });

      expect(await screen.findByText(/PDF or an image \(JPEG\/PNG\/WebP\/HEIC\/TIFF\/BMP\/GIF\)/i)).toBeInTheDocument();
      expect(callsTo('POST', (u) => u.includes('/documents/PHOTOGRAPH'))).toHaveLength(0);
    });

    it('never refuses a blank declared type, which is what phones send for an ordinary HEIC photo', async () => {
      await openDocuments();
      const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
      const noType = new File(['a'], 'photo.heic'); // no `type` option — exactly what Android sends

      await act(async () => { fireEvent.change(picker, { target: { files: [noType] } }); });

      await waitFor(() => {
        expect(callsTo('POST', (u) => u === `/hr/applications/${APP_ID}/documents/PHOTOGRAPH`)).toHaveLength(1);
      });
    });

    /**
     * This used to assert `capture="environment"` on the picker — the phone's own camera app,
     * which hands back a photograph of a card lying on a desk: skewed, with the desk in it, at
     * whatever exposure the room had. The camera is now a real scanner (`ScanOrAttach` →
     * `DocumentScanner`), which finds the document in the frame, squares it up and cleans it, so
     * the hint is gone and a button stands in its place. The picker itself is untouched and still
     * takes a flatbed PDF or a photo already on the device.
     *
     * The camera has to be stubbed for it to appear, and the exact name matters: the first version
     * of this test asked for any button matching /scan/i and passed against the step tab "4. Papers
     * and scans" while no scan button existed at all.
     */
    const withCamera = (present: boolean) => {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: present ? { getUserMedia: jest.fn() } : undefined,
        configurable: true,
      });
    };

    it('offers a scanner beside the file picker where a camera exists', async () => {
      withCamera(true);
      await openDocuments();

      expect(screen.getAllByRole('button', { name: 'Scan' }).length).toBeGreaterThan(0);
      expect(screen.getAllByText('Choose file').length).toBeGreaterThan(0);
      expect(document.querySelector('input[type="file"]')).toBeTruthy();
    });

    /** A button that explains it cannot work only after being pressed is worse than no button. */
    it('offers only the file picker on a machine with no camera', async () => {
      withCamera(false);
      await openDocuments();

      expect(screen.queryByRole('button', { name: 'Scan' })).not.toBeInTheDocument();
      expect(document.querySelector('input[type="file"]')).toBeTruthy();
    });
  });
});

/**
 * Reopening an application somebody started.
 *
 * It used to be a separate mode — `/hr/register` for a new person and `/hr/register/:assayerId` to
 * resume one already begun — and the resume half existed because step one had created a roster
 * row. There is only resume now: the application exists before this form opens, so every visit is
 * a continuation of something.
 */
describe('reopening an application', () => {
  it('fills the boxes from what is on file, and lands on the first thing missing', async () => {
    wireApi({
      [`GET /hr/applications/${APP_ID}`]: {
        ...VIEW,
        application: {
          ...APPLICATION,
          fullName: 'Ramesh Iyer', state: 'Kerala', address: '12 MG Road',
          extendedProfile: { fields: { phone: '9876543210' } },
        },
        // The server's own gap list, which is what decides where this opens — the same list HR
        // sees on the review screen, rather than a second opinion computed here.
        gaps: [{ key: 'panNumber', label: 'PAN', blocks: 'tax deduction' }],
      },
    });
    await mount();

    // Straight to ID and bank — the PAN is what the server says is missing first.
    expect(await screen.findByText(/Where their money goes/i)).toBeInTheDocument();
    // Exact name: "Back to People" (the page header's own link) also matches a loose /Back/.
    await click(/^Back$/);
    // The address it already holds is shown, not an empty form: reopening something that makes you
    // re-type what is on file is a form nobody uses.
    expect(await screen.findByDisplayValue('12 MG Road')).toBeInTheDocument();
  });

  it('says so plainly when the application cannot be opened, instead of starting a second one', async () => {
    wireApi({ [`GET /hr/applications/${APP_ID}`]: new Error('Network is down') });
    await mount();
    expect(await screen.findByText(/That registration could not be opened/i)).toBeInTheDocument();
  });

  /**
   * The India-first naming fix's own round trip. `fullName` is the application's own column now —
   * it was `displayName` on the record, which is a different word for the same authored truth —
   * and either way it is read verbatim rather than rebuilt from the retired `firstName`/`lastName`
   * pair, which a name like this one (three initials, no surname) cannot pass through without
   * losing a word.
   */
  it('seeds the full-name box from what is stored, initials and all', async () => {
    wireApi({
      [`GET /hr/applications/${APP_ID}`]: {
        ...VIEW,
        application: { ...APPLICATION, fullName: 'A K Venkatesan' },
      },
    });
    await mount();
    expect(await screen.findByDisplayValue('A K Venkatesan')).toBeInTheDocument();
  });
});

describe('the last page', () => {
  const openReview = async (overrides: Record<string, unknown> = {}) => {
    wireApi(overrides);
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Continue/);
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
      [`GET /hr/applications/${APP_ID}`]: {
        ...VIEW,
        application: {
          ...APPLICATION,
          extendedProfile: { empanelments: [{ clientId: 'cli-1', status: 'ACTIVE' }] },
        },
      },
    });
    // Counted rather than named: the standings are on the application, and the client names come
    // from a separate list this page does not load. What matters is that it stops claiming nobody
    // can give them work.
    expect(await screen.findByText(/1 client standing recorded/i)).toBeInTheDocument();
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
  /**
   * Every step works from the first click now, and the three cases that used to prove otherwise
   * are gone with the reason for them.
   *
   * The rail has always been unlocked, so a clerk could reach "ID and bank" or "Who they can work
   * for" before step one had created the record they wrote to — and those steps had to say so,
   * and Continue had to be disabled, and the client and papers steps had to render "available once
   * their record is saved". None of that survives: the application exists before this form opens,
   * so there is nowhere left in the flow with nothing to write to.
   */
  it('opens any step on a click, with nothing typed, and every one of them works', async () => {
    await mount();
    await click(/ID and bank/);
    expect(await screen.findByText(/Their identity numbers/i)).toBeInTheDocument();

    await click(/Who they can work for/);
    expect(await screen.findByText('ICICI Bank')).toBeInTheDocument();

    await click(/Papers and scans/);
    expect(await screen.findByText('Photograph')).toBeInTheDocument();

    // Nothing typed, nothing saved, and the footer still offers to move on.
    expect(screen.getByRole('button', { name: /^Continue/ })).not.toBeDisabled();
  });

  it('lets a step be jumped to directly, and keeps the step in ?step=', async () => {
    const StepProbe: React.FC = () => <span data-testid="step-param">{useSearchParams()[0].get('step')}</span>;
    await mount({}, <StepProbe />);
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await click(/Continue/);

    await click(/Contacts and pay/);
    expect(await screen.findByText(/If something happens while they are out/i)).toBeInTheDocument();
    // `?step=`, this flow's own key — not `?view=`, which every other HR page's chip strip owns.
    expect(screen.getByTestId('step-param')).toHaveTextContent('people');
  });
});

/*
  The verdict half of the papers step is gone with the component that drew it.

  `DocumentsStep` was the wizard's own copy of the vetting tab's document machinery — document
  numbers, holder-name matching, verify and send-back — and none of it applies to an application,
  whose document row is `{applicationId, requirement, filePaths}` and nothing else by design. All
  of it still exists, and is still tested, on the record's vetting tab, which is where a verdict
  has somewhere to live. What the desk does before somebody is approved is attach a scan.

  Deleted here rather than skipped: these cases asserted against a component this path no longer
  renders, and a suite that keeps them green against a screen nobody opens is worse than one that
  says plainly where the behaviour went.
*/



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
    await click(/Continue/);
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
    await click(/Continue/);
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

    await click(/Continue/);
    // The duplicate card is a warning, not a gate: two people genuinely share a number often
    // enough — a shared family handset, a shop line — that refusing would block real registrations.
    expect(callsTo('PATCH', (u) => u === `/hr/applications/${APP_ID}`)).toHaveLength(1);
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
    await click(/Continue/);
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

/**
 * A STEP DECLARES WHAT IT COLLECTS; THE SCREEN HAS TO ACTUALLY ASK FOR IT.
 *
 * `STEP_FIELDS.person` said the first step collects gender and "Freelancer or proprietor". The
 * screen asked for neither — its Blocks listed four other keys that were not in the field map, and
 * `Block` drops an unknown key without a word. So the desk could never set whether somebody is a
 * freelancer or a proprietor, which decides the documents they are asked for and which the
 * application refuses to submit without.
 *
 * This checks every declared key on every step that has boxes, by the label the person would read.
 * It kills the class, not the instance: the next key somebody declares and forgets to draw fails
 * here too.
 */
describe('every box a step declares is on the screen', () => {
  const { STEP_FIELDS, REGISTRATION_FIELDS } = jest.requireActual('./steps');
  const labelOf = (key: string): string =>
    (REGISTRATION_FIELDS as Array<{ key: string; label: string }>).find((f) => f.key === key)?.label ?? key;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const expectDrawn = (step: string) => {
    for (const key of STEP_FIELDS[step] as string[]) {
      const found = screen.queryAllByLabelText(new RegExp(`^${escape(labelOf(key))}`));
      expect({ step, key, drawn: found.length > 0 }).toEqual({ step, key, drawn: true });
    }
  };

  beforeEach(() => wireApi());

  it('draws the whole of the first step, including freelancer or proprietor', async () => {
    await mount();
    expectDrawn('person');
  });

  it('draws the address, identity and people steps in full', async () => {
    await mount();
    type(/^Full name/, 'Ramesh Iyer');
    await choose(/^State they work in/, 'Kerala');
    await choose(/^Freelancer or proprietor/, 'Freelancer');

    await click(/Continue/);
    expectDrawn('address');

    await click(/^Continue/);
    expectDrawn('identity');

    await click(/^Continue/);            // documents — no boxes of its own
    await click(/^Continue/);
    expectDrawn('people');
  });
});

/**
 * A NEW account number is typed twice before the desk can save it — account numbers carry no check
 * digit, so a wrong digit still "looks right". An account already on file (shown masked) is left
 * alone: it was confirmed when it was saved.
 */
describe('the bank account on the desk form', () => {
  const openAtIdentity = async () => {
    wireApi({
      [`GET /hr/applications/${APP_ID}`]: {
        ...VIEW,
        application: { ...APPLICATION, fullName: 'Ramesh Iyer', state: 'Kerala', address: '12 MG Road', extendedProfile: { fields: {} } },
        gaps: [{ key: 'panNumber', label: 'PAN', blocks: 'tax deduction' }],
      },
    });
    await mount();
    await screen.findByText(/Where their money goes/i);
  };
  const accountPatches = () => mockRequest.mock.calls
    .filter(([url, o]) => url === `/hr/applications/${APP_ID}` && (o as RequestInit)?.method === 'PATCH')
    .map((c) => bodyOf(c))
    .filter((b) => b.record?.bankAccountNumber !== undefined || b.bankAccountNumber !== undefined);

  it('asks for a new number a second time, and will not save it until the two agree', async () => {
    await openAtIdentity();
    expect(screen.queryByLabelText('Re-enter account number')).not.toBeInTheDocument();

    type(/^Bank Account/, '123456789012');
    const confirm = await screen.findByLabelText('Re-enter account number');
    fireEvent.change(confirm, { target: { value: '123456789099' } });
    expect(screen.getByText(/do not match/)).toBeInTheDocument();

    await click(/Continue/);
    expect(await screen.findByText(/typed a second time to match the first/)).toBeInTheDocument();
    expect(accountPatches()).toEqual([]);

    fireEvent.change(confirm, { target: { value: '123456789012' } });
    await click(/Continue/);
    await waitFor(() => expect(accountPatches()).toHaveLength(1));
  });

  /** The rail saves on a forward click; it must not carry an unconfirmed number with it. */
  it('does not let the step rail save an unconfirmed number', async () => {
    await openAtIdentity();
    type(/^Bank Account/, '123456789012');
    await screen.findByLabelText('Re-enter account number');

    await click(/Contacts and pay/);

    expect(await screen.findByText(/typed a second time to match the first/)).toBeInTheDocument();
    expect(accountPatches()).toEqual([]);
  });
});

