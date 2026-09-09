import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { AssayerLifecycleStatus } from '@fapoms/shared';

import { AssayerRecord } from './AssayerRecord';
import { api } from '../../services/api';
import { resolveIfsc } from './AssayerForms';

/**
 * The map pin, on the screen that nags about it.
 *
 * "Map location" is a critical record field (latitude) — the completeness banner at the top of
 * this page says so, and the planner's distance filter excludes anyone without one. 98 people
 * have no coordinate and 76 of those are ACTIVE. Until now the field was rendered read-only and
 * there was no control anywhere in the web app that could set it: the page told you something
 * was missing and gave you no way to supply it.
 *
 * `PinCoordinateControl` has supported `target: 'assayer'` since the precision work — it posts
 * to `/geo/precision/assayer/:id/pin` and has the server check the pair falls inside the state
 * on the record. It was simply only ever mounted on Branches. These tests hold it to being
 * mounted here, to being shown when it is actionable, and to re-reading the record afterwards so
 * the page stops contradicting itself the moment the pin lands.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(), jest.fn()],
}));
jest.mock('./AssayerVettingTab', () => ({
  AssayerVettingTab: () => null,
  STANDING_LABELS: {},
  // The real rule, not a stub of it: `standingStance` is what decides whether a standing chip on
  // the record reads as refused, not-ready or fine, and it now answers that from the same
  // `standingAllowsPlanning` the planner's gate uses. A stub that always says "fine" would let
  // the exact drift this replaced come back unnoticed.
  standingStance: jest.requireActual('./AssayerVettingTab').standingStance,
  STANDING_STANCE_TONE: jest.requireActual('./AssayerVettingTab').STANDING_STANCE_TONE,
  // Real, not stubbed, for the same reason: the record's move-confirm for an adverse background
  // verdict names the finding using these two exports, and a fake map or a fake "nothing is ever
  // adverse" predicate would prove nothing about the real wording or the real gate.
  VERDICT_LABELS: jest.requireActual('./AssayerVettingTab').VERDICT_LABELS,
  ADVERSE_BACKGROUND_VERDICTS: jest.requireActual('./AssayerVettingTab').ADVERSE_BACKGROUND_VERDICTS,
  humanizeEnum: jest.requireActual('./AssayerVettingTab').humanizeEnum,
}));
jest.mock('./AssayerQualificationTab', () => ({ AssayerQualificationTab: () => null }));
jest.mock('./AssayerSkillsPanel', () => ({ AssayerSkillsPanel: () => null }));
jest.mock('../../components/AssayerRemarks', () => ({ AssayerRemarks: () => null }));
jest.mock('./CommercialProfileModal', () => ({ CommercialProfileModal: () => null }));
jest.mock('./AssayerForms', () => ({
  EDIT_FIELDS: [
    { key: 'phone', label: 'Phone' },
    { key: 'address', label: 'Address' },
    { key: 'city', label: 'City' },
    { key: 'district', label: 'District' },
    { key: 'state', label: 'State', options: [{ value: 'Karnataka', label: 'Karnataka' }] },
    { key: 'pincode', label: 'Pincode' },
    { key: 'bankName', label: 'Bank Name' },
    { key: 'ifscCode', label: 'IFSC Code' },
  ],
  useManagerOptions: () => ({ people: [] }),
  useHrOwnerOptions: () => ({ people: [] }),
  // The real cross-fill rule and the real field list, not stubs — a test asserting the inline
  // editor cross-fills the same way the registration wizard does is worthless against a fake
  // that always agrees with itself. Only `resolveIfsc` is mocked: it is a network call, and its
  // shape/never-throws contract is covered on its own in AssayerForms.spec.tsx.
  applyPlace: jest.requireActual('./AssayerForms').applyPlace,
  GEO_AUTO_FIELDS: jest.requireActual('./AssayerForms').GEO_AUTO_FIELDS,
  resolveIfsc: jest.fn(),
}));

/**
 * A one-button stand-in for the live, debounced typeahead.
 *
 * The real `Autocomplete` only calls `onSelect` after a 350ms-debounced network round trip and a
 * click on a suggestion in its own dropdown — none of which is what these tests are about. What
 * they need to prove is that InlineControl, given a picked place, cross-fills the same way the
 * registration wizard does; the button below skips straight to that moment. `placeholder` is
 * kept so a test can tell the pincode box's Autocomplete from the city/district ones.
 */
jest.mock('../../components/ui/Autocomplete', () => ({
  Autocomplete: ({ placeholder, onSelect }: any) => (
    <button type="button" onClick={() => onSelect?.({
      label: 'Whitefield, Bengaluru Urban, Karnataka', state: 'Karnataka', district: 'Bengaluru Urban', pincode: '560066',
    })}>
      {placeholder}
    </button>
  ),
}));

const mockRequest = api.request as jest.Mock;
const mockResolveIfsc = resolveIfsc as jest.Mock;

const record = (over: Record<string, unknown> = {}) => ({
  id: 'a-1',
  assayerCode: 'AS0001',
  displayName: 'Person One',
  firstName: 'Person',
  lastName: 'One',
  phone: '+919000000000',
  email: 'p1@example.com',
  address: '1 Road',
  city: 'Kochi',
  district: 'Ernakulam',
  state: 'Kerala',
  pincode: '682001',
  region: 'SOUTH',
  latitude: 9.931233,
  longitude: 76.267303,
  geoSource: 'manual',
  geoMatchedName: null,
  lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
  employmentType: 'INTERNAL',
  experienceYears: 4,
  maxDailyWorkload: 3,
  maxWeeklyWorkload: 15,
  panNumber: 'ABCDE1234F',
  bankAccountNumber: '000111222333',
  ifscCode: 'HDFC0000001',
  joiningDate: '2024-01-01',
  emergencyContactPhone: '+919000000001',
  ...over,
});

/** Serves the record itself and refuses everything else the page asks for in passing. */
const serve = (row: ReturnType<typeof record>) => {
  mockRequest.mockImplementation((url: string) => {
    if (url === '/assayers/a-1') return Promise.resolve(row);
    if (url.endsWith('/pin')) return Promise.resolve({});
    return Promise.reject(new Error('not served in this test'));
  });
};

/**
 * A dossier row, in the shape `RosterRecordsService.dossier` actually returns for one of the 21
 * onboarding requirements — `identity`/`label`/`verificationStatus` are the fields the record's
 * `dossierGlance` reads for the move-confirm substance checks.
 */
const doc = (over: Record<string, unknown> = {}) => ({
  requirement: 'JOINING_FORM', label: 'Joining form', identity: false, verificationStatus: null, ...over,
});

/** Like `serve`, but also answers the dossier read the move-confirms get their substance from. */
const serveWithDossier = (row: ReturnType<typeof record>, dossier: Record<string, unknown>) => {
  mockRequest.mockImplementation((url: string) => {
    if (url === '/assayers/a-1') return Promise.resolve(row);
    if (url.endsWith('/dossier')) {
      return Promise.resolve({ empanelments: [], currentCheck: null, onboarding: [], ...dossier });
    }
    if (url.endsWith('/lifecycle')) return Promise.resolve({ success: true });
    if (url.endsWith('/pin')) return Promise.resolve({});
    return Promise.reject(new Error('not served in this test'));
  });
};

/** The dossier strip ("Banks & standing") only appears once `dossierGlance` has actually loaded — waiting for it is how a test avoids clicking a move button before the substance it should show is in. */
const waitForDossier = () => waitFor(() => expect(screen.getByText(/Banks & standing/)).toBeInTheDocument());

const renderRecord = () => render(
  <AssayerRecord assayerId="a-1" canManage onClose={jest.fn()} onChanged={jest.fn()} />,
);

beforeEach(() => { mockRequest.mockReset(); mockResolveIfsc.mockReset(); });

describe('AssayerRecord — the map pin', () => {
  it('offers the pin control when there is no coordinate at all — the 98-person case', async () => {
    serve(record({ latitude: null, longitude: null, geoSource: null }));

    renderRecord();

    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Pin the exact location/ })).toBeInTheDocument();
    expect(screen.getByText(/No home location has been recorded/)).toBeInTheDocument();
  });

  it('offers it on a placeholder coordinate too, and says the pin is a stand-in', async () => {
    // `none` is the state centroid — a location that is not the person's, up to 100 km out.
    serve(record({ geoSource: 'none' }));

    renderRecord();

    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Pin the exact location/ })).toBeInTheDocument();
    expect(screen.getByText(/This pin is a stand-in, not their home/)).toBeInTheDocument();
  });

  it('leaves a hand-placed pin alone until somebody opens the record for editing', async () => {
    serve(record({ geoSource: 'manual' }));

    renderRecord();

    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());
    // Nothing to fix, so no control — the same rule Branches uses.
    expect(screen.queryByRole('button', { name: /Pin the exact location/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    expect(screen.getByRole('button', { name: /Pin the exact location/ })).toBeInTheDocument();
  });

  it('says how much the stored coordinate can be trusted, instead of six decimal places of nothing', async () => {
    serve(record({ geoSource: 'pincode' }));

    renderRecord();

    await waitFor(() => expect(screen.getByText('9.9312, 76.2673')).toBeInTheDocument());
    expect(screen.getByText(/Approximate \(area only\)/)).toBeInTheDocument();
  });

  it('posts the pasted coordinate to the assayer pin endpoint and re-reads the record', async () => {
    serve(record({ latitude: null, longitude: null, geoSource: null }));

    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Pin the exact location/ }));
    fireEvent.change(screen.getByLabelText(/Exact coordinate/), {
      target: { value: '9.931233, 76.267303' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pin here' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/geo/precision/assayer/a-1/pin',
      expect.objectContaining({ method: 'POST' }),
    ));
    const [, options] = mockRequest.mock.calls.find(([url]) => url.endsWith('/pin'))!;
    expect(JSON.parse(options.body)).toMatchObject({ latitude: 9.931233, longitude: 76.267303 });

    // The banner and the badge are both computed from the record, so a pin that is not re-read
    // leaves the page still saying the location is missing.
    await waitFor(() => expect(
      mockRequest.mock.calls.filter(([url]) => url === '/assayers/a-1').length,
    ).toBeGreaterThan(1));
  });
});

/**
 * NEXT STEPS, NOT A DROPDOWN OF FILING STATES.
 *
 * Walking somebody from invited to active was four visits to a `<select>` of eleven lifecycle
 * names, and each visit asked the clerk a question the software already knew the answer to: which
 * of these comes next? The planning screen had been printing that answer at them the whole time.
 *
 * What must not change with it: nothing advances on its own, and no button takes more than one
 * step. Each stage is a judgement about a real person — their papers were checked, their
 * background came back — and one press that made four of them would have made three of them up.
 */
describe('AssayerRecord — the lifecycle as next steps', () => {
  it('offers the forward step as a button naming the stage, not a dropdown', async () => {
    serve(record({ lifecycleStatus: AssayerLifecycleStatus.TRAINING }));
    renderRecord();

    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Move to Active' })).toBeInTheDocument();
    expect(screen.queryByText('Choose…')).not.toBeInTheDocument();
  });

  it('says what the stage does to the person, beside the button rather than after choosing', async () => {
    serve(record({ lifecycleStatus: AssayerLifecycleStatus.TRAINING }));
    renderRecord();

    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());
    // STAGE_CONSEQUENCE, unchanged. The dropdown showed this only once a stage was picked, so
    // "Inactive" told somebody parking a person for a fortnight nothing about having removed
    // them from every planning list.
    expect(screen.getByText(/can be planned, offered work and paid from now on/)).toBeInTheDocument();
    expect(screen.getByText(/stop appearing for planning and receive no new work/)).toBeInTheDocument();
  });

  it('reads the planner\'s own sentence back on the screen the planner sends people to', async () => {
    serve(record({ lifecycleStatus: AssayerLifecycleStatus.TRAINING }));
    renderRecord();

    // Twice on purpose: once in the header (every tab, every viewer — see the "Next:" line) and
    // once leading the Summary tab's "What happens next" section (canManage only, above the
    // buttons). Both have to say the planner's exact words, so both are asserted rather than
    // picking one and leaving the other undefended.
    await waitFor(() => expect(
      screen.getAllByText(/in training — mark training complete on the HR roster to activate/),
    ).toHaveLength(2));
  });

  it('moves exactly one stage per press, and no further', async () => {
    serve(record({ lifecycleStatus: AssayerLifecycleStatus.INVITED }));
    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    // The only forward move offered from INVITED is the next one. There is no "Move to Active".
    expect(screen.getByRole('button', { name: 'Move to Document Verification' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move to Active' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Move to Document Verification' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/assayers/a-1/lifecycle',
      expect.objectContaining({ method: 'POST' }),
    ));
    const [, options] = mockRequest.mock.calls.find(([url]) => url.endsWith('/lifecycle'))!;
    expect(JSON.parse(options.body)).toMatchObject({ targetStatus: AssayerLifecycleStatus.DOCUMENT_VERIFICATION });
  });

  it('asks why before a move that goes on an employment record, and not before an ordinary one', async () => {
    serve(record({ lifecycleStatus: AssayerLifecycleStatus.TRAINING }));
    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    // Deactivating needs a reason (the server refuses it without one), so the button opens the
    // box instead of firing — and nothing else on the panel changes.
    fireEvent.click(screen.getByRole('button', { name: 'Move to Inactive' }));
    expect(screen.getByLabelText(/Why\? This is kept on their employment record/)).toBeInTheDocument();
    expect(mockRequest).not.toHaveBeenCalledWith('/assayers/a-1/lifecycle', expect.anything());

    // Picking a real cluster from the dropdown — rather than typing it — is what stops "Joined
    // another company" from turning into a fourth spelling the notes column can't be grouped by.
    fireEvent.click(screen.getByLabelText(/Why\? This is kept on their employment record/));
    fireEvent.click(await screen.findByText('Joined another company'));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Inactive' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayers/a-1/lifecycle', expect.anything()));
    const [, options] = mockRequest.mock.calls.find(([url]) => url.endsWith('/lifecycle'))!;
    expect(JSON.parse(options.body)).toMatchObject({
      targetStatus: AssayerLifecycleStatus.INACTIVE,
      reason: 'Joined another company',
    });
  });

  it('still lets "Other" carry a reason no cluster covers, end to end', async () => {
    // The dropdown is a shortcut to what people already type, not a constraint on top of it — the
    // server only ever checked `reason` was non-blank, and "Other" has to keep sending whatever
    // is typed, unconstrained, the same as the plain box it replaced.
    serve(record({ lifecycleStatus: AssayerLifecycleStatus.TRAINING }));
    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Move to Inactive' }));
    fireEvent.click(screen.getByLabelText(/Why\? This is kept on their employment record/));
    fireEvent.click(await screen.findByText('Other (type it in)'));

    const freeText = await screen.findByLabelText(/Reason, in your own words/i);
    fireEvent.change(freeText, { target: { value: 'Moved to Dubai for a factory job' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move to Inactive' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayers/a-1/lifecycle', expect.anything()));
    const [, options] = mockRequest.mock.calls.find(([url]) => url.endsWith('/lifecycle'))!;
    expect(JSON.parse(options.body)).toMatchObject({
      targetStatus: AssayerLifecycleStatus.INACTIVE,
      reason: 'Moved to Dubai for a factory job',
    });
  });

  it('offers the side roads plainly for somebody already active, with no forward step invented', async () => {
    serve(record({ lifecycleStatus: AssayerLifecycleStatus.ACTIVE }));
    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    // An active assayer is where they should be — there is no "next" for them, only choices.
    expect(screen.queryByText('Or, instead')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move to On Leave' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move to Suspended' })).toBeInTheDocument();
  });
});

/**
 * A KYC identifier is covered on this page, and uncovering one is a recorded act.
 *
 * The record returns the PAN, the Aadhaar and the bank account last-4 masked. This page masks
 * again on the way to the screen — its own promise that it does not print a whole Aadhaar,
 * whatever a stale payload or a fixture hands it — and the whole number is one deliberate click
 * behind an endpoint that writes an audit row.
 */
describe('AssayerRecord — the covered identifiers', () => {
  it('prints the mask and never the number, even when handed an unmasked record', async () => {
    serve(record({ aadhaarNumber: '123456789012', panNumber: 'ABCDE1234F' }));
    renderRecord();

    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());
    expect(screen.queryByText('123456789012')).not.toBeInTheDocument();
    expect(screen.queryByText('ABCDE1234F')).not.toBeInTheDocument();
    expect(screen.getByText('••••••••9012')).toBeInTheDocument();
    expect(screen.getByText('••••••234F')).toBeInTheDocument();
  });

  it('says the number is held whole, so nobody stops asking for the card', async () => {
    // The owner's decision: an Aadhaar is stored complete and encrypted and masked on every
    // screen. A clerk who reads "••••9012" with nothing beside it reasonably concludes the
    // company kept four digits, and stops collecting the rest.
    serve(record({ aadhaarNumber: '123456789012' }));
    renderRecord();

    await waitFor(() => expect(
      screen.getByText(/Aadhaar and PAN are kept in full and encrypted/),
    ).toBeInTheDocument());
  });

  it('warns that revealing is recorded before the button is pressed', async () => {
    serve(record({ aadhaarNumber: '123456789012' }));
    renderRecord();

    await waitFor(() => expect(
      screen.getAllByText(/recorded in the audit log, with your name and the time/).length,
    ).toBeGreaterThan(0));
  });
});

describe('AssayerRecord — plain words', () => {
  it('expands the two abbreviations nothing on the page ever defined', async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url === '/assayers/a-1') return Promise.resolve(record({ vstsCode: 'V-77' }));
      if (url.endsWith('/dossier')) {
        return Promise.resolve({
          empanelments: [],
          currentCheck: { cibilBand: 'GOOD', cibilScore: 742, checkedOn: '2025-06-01' },
        });
      }
      return Promise.reject(new Error('not served in this test'));
    });

    renderRecord();

    // "VSTS: none" and "Credit: GOOD (742)" named nothing a reader could look up. VSTS appeared
    // twice — the banks strip and the "Who they are" caption — and both were the abbreviation.
    await waitFor(() => expect(screen.getAllByText(/Vault system code/)).toHaveLength(2));
    expect(screen.getByText(/CIBIL credit score/)).toBeInTheDocument();
    expect(screen.queryByText(/VSTS/)).not.toBeInTheDocument();
  });
});

/**
 * THE CREDENTIAL HANDOVER — what the person can actually do with it.
 *
 * The card asks the server two questions and has to read both answers. `canSignInNow` is whether
 * the password works at all; `accessScope` is how far it goes. They used to be one field meaning
 * "fully usable", because the four onboarding stages could not sign in. They can now, into a
 * session confined to finishing their own registration, so the flag went true for them and this
 * card — whose only warning was gated on the flag being false — went silent for precisely the
 * population it was written for. The clerk handed over a password that signs in and then refuses
 * every screen, and was told nothing.
 *
 * These hold the card to saying something true in each of the three cases, and to not calling a
 * working credential broken: being able to upload your own papers before you start is the point
 * of issuing it early, not a fault to be shown in amber.
 */
describe('AssayerRecord — handing over app access', () => {
  const handOver = async (
    lifecycleStatus: AssayerLifecycleStatus,
    access: { canSignInNow: boolean; accessScope: 'FULL' | 'REGISTRATION_ONLY' },
  ) => {
    mockRequest.mockImplementation((url: string) => {
      if (url === '/assayers/a-1') return Promise.resolve(record({ lifecycleStatus }));
      if (url === '/assayers/a-1/app-access') {
        return Promise.resolve({
          username: 'AS0001',
          temporaryPassword: 'Temp-9x4k',
          expiresAt: '2026-09-10T00:00:00.000Z',
          ...access,
        });
      }
      return Promise.reject(new Error('not served in this test'));
    });

    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Give them app access/ }));
    await waitFor(() => expect(screen.getByText('Temp-9x4k')).toBeInTheDocument());
  };

  it('says what a mid-onboarding sign-in can do, rather than saying nothing at all', async () => {
    await handOver(AssayerLifecycleStatus.DOCUMENT_VERIFICATION, {
      canSignInNow: true, accessScope: 'REGISTRATION_ONLY',
    });

    expect(screen.getByText(/only to finish their own registration/)).toBeInTheDocument();
    expect(screen.getByText(/joining checks are signed off/)).toBeInTheDocument();
    // Not dressed up as a failure. The password works; it is the reach that is limited.
    expect(screen.queryByText(/will not work/)).not.toBeInTheDocument();
  });

  it('says it at every onboarding stage, and never in the old words', async () => {
    await handOver(AssayerLifecycleStatus.TRAINING, {
      canSignInNow: true, accessScope: 'REGISTRATION_ONLY',
    });

    expect(screen.getByText(/only to finish their own registration/)).toBeInTheDocument();
    // The sentence this card used to print at every onboarding stage. It is false twice over now:
    // they can sign in, and Active is not the thing they are waiting for.
    expect(screen.queryByText(/It will not work yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/moved to\s+Active/)).not.toBeInTheDocument();
  });

  it('warns about a suspended person in the words that fit being suspended', async () => {
    await handOver(AssayerLifecycleStatus.SUSPENDED, { canSignInNow: false, accessScope: 'FULL' });

    expect(screen.getByText(/It will not work while they are suspended/)).toBeInTheDocument();
    expect(screen.queryByText(/finish their own registration/)).not.toBeInTheDocument();
  });

  it('does not tell a clerk to activate somebody who has resigned', async () => {
    await handOver(AssayerLifecycleStatus.RESIGNED, { canSignInNow: false, accessScope: 'FULL' });

    expect(screen.getByText(/they have left, and sign-in is closed/)).toBeInTheDocument();
    // "Move them to Active" is advice about a person who is not coming back.
    expect(screen.queryByText(/goes back to Active/)).not.toBeInTheDocument();
  });

  it('adds nothing when the credential opens the whole app', async () => {
    await handOver(AssayerLifecycleStatus.ACTIVE, { canSignInNow: true, accessScope: 'FULL' });

    expect(screen.getByText(/read it to the assayer now/)).toBeInTheDocument();
    expect(screen.queryByText(/will not work/)).not.toBeInTheDocument();
    expect(screen.queryByText(/finish their own registration/)).not.toBeInTheDocument();
  });
});

/**
 * THE INLINE EDITOR, BROUGHT UP TO THE WIZARD'S OWN LEVEL.
 *
 * Registering somebody fills city/district/state/pincode from one picked place — the wizard's
 * `Autocomplete` + `applyPlace`. Correcting the same person's address afterwards, on this page,
 * used to fall back to four boxes that agreed with nothing but themselves. These hold the inline
 * editor to producing the exact same cross-fill, by calling the exact same exported function
 * rather than a second copy of it — a fake that always agreed with itself would prove nothing.
 */
describe('AssayerRecord — inline editor geo cross-fill', () => {
  const findSave = () => screen.getByRole('button', { name: 'Save changes' });
  const putBody = () => {
    const call = mockRequest.mock.calls.find(([url, opts]) => url === '/assayers/a-1' && opts?.method === 'PUT');
    if (!call) throw new Error('no PUT /assayers/a-1 call was made');
    return JSON.parse(call[1].body);
  };

  it('fills district, state and pincode from one picked place, same as the registration wizard', async () => {
    serve(record({ city: '', district: '', state: '', pincode: '' }));
    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    // The pincode box's Autocomplete stand-in — see the module mock above.
    fireEvent.click(screen.getByText('Search pincode…'));
    fireEvent.click(findSave());

    await waitFor(() => expect(putBody()).toMatchObject({
      pincode: '560066',
      district: 'Bengaluru Urban',
      state: 'Karnataka',
      // Primary token of the place label, since city was blank before the pick.
      city: 'Whitefield',
    }));
  });

  it('does not overwrite a city the operator already typed', async () => {
    serve(record({ city: 'Kochi', district: '', state: '', pincode: '' }));
    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    fireEvent.click(screen.getByText('Search pincode…'));
    fireEvent.click(findSave());

    await waitFor(() => expect(putBody()).toMatchObject({ district: 'Bengaluru Urban' }));
    expect(putBody().city).toBeUndefined(); // unchanged from the record, so not sent at all
  });
});

/**
 * IFSC AUTOFILL — fill `bankName`, never lock it, never block a save on a lookup that fails.
 */
describe('AssayerRecord — inline editor IFSC autofill', () => {
  const editIfscBox = async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    const ifscRow = screen.getByText('IFSC').closest('div') as HTMLElement;
    return within(ifscRow).getByRole('textbox') as HTMLInputElement;
  };
  const putBody = () => {
    const call = mockRequest.mock.calls.find(([url, opts]) => url === '/assayers/a-1' && opts?.method === 'PUT');
    if (!call) throw new Error('no PUT /assayers/a-1 call was made');
    return JSON.parse(call[1].body);
  };

  it('fills bank name from a resolved code, and shows the branch/city/state beside it', async () => {
    serve(record());
    mockResolveIfsc.mockResolvedValueOnce({
      bankName: 'HDFC BANK', branchName: 'Whitefield', city: 'Bengaluru', state: 'Karnataka', address: null,
    });
    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    const input = await editIfscBox();
    fireEvent.change(input, { target: { value: 'HDFC0000001' } });
    fireEvent.blur(input);

    await waitFor(() => expect(mockResolveIfsc).toHaveBeenCalledWith('HDFC0000001'));
    await waitFor(() => expect(screen.getByText(/HDFC BANK — Whitefield, Bengaluru, Karnataka/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putBody()).toMatchObject({ bankName: 'HDFC BANK' }));
  });

  it('never asks the lookup about a code that is not IFSC-shaped', async () => {
    serve(record());
    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    const input = await editIfscBox();
    fireEvent.change(input, { target: { value: 'NOT-A-CODE' } });
    fireEvent.blur(input);

    // Nothing to await for a call that must not happen; a microtask flush is enough.
    await Promise.resolve();
    expect(mockResolveIfsc).not.toHaveBeenCalled();
  });

  it('saves normally when the lookup resolves nothing — a miss is not a save blocker', async () => {
    serve(record());
    mockResolveIfsc.mockResolvedValueOnce(null);
    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    const input = await editIfscBox();
    fireEvent.change(input, { target: { value: 'HDFC0009999' } });
    fireEvent.blur(input);
    await waitFor(() => expect(mockResolveIfsc).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayers/a-1', expect.objectContaining({ method: 'PUT' })));
    expect(putBody().bankName).toBeUndefined(); // no resolve, so bankName was never touched
  });
});

/**
 * REHIRE — the one move that runs the lifecycle backwards.
 *
 * The shared map (`ASSAYER_LIFECYCLE_TRANSITIONS`) now legally offers RESIGNED/TERMINATED →
 * INVITED, on purpose: people do come back, and rehiring is meant to restart the whole onboarding
 * chain rather than snap straight to Active. A bare "Move to Invited" button would say none of
 * that — it is also the exact words a brand-new joiner's record would use for a stage they have
 * never seen. These hold the record to reading the move as what it actually is.
 */
describe('AssayerRecord — rehire', () => {
  it('reads as a rehire rather than a bare "Move to Invited", for someone who resigned', async () => {
    serve(record({ lifecycleStatus: AssayerLifecycleStatus.RESIGNED }));
    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Rehire — start onboarding again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move to Invited' })).not.toBeInTheDocument();
    expect(screen.getByText(
      'They rejoin at the start: documents, background check and training are done again before they can work.',
    )).toBeInTheDocument();
  });

  it('reads as a rehire for someone who was terminated too', async () => {
    serve(record({ lifecycleStatus: AssayerLifecycleStatus.TERMINATED }));
    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Rehire — start onboarding again' })).toBeInTheDocument();
  });

  it('opens the reason box pre-filled with "Rehired…", and posts it without the clerk touching the picker', async () => {
    // `serveWithDossier` rather than the plain `serve`, specifically so `/lifecycle` resolves
    // instead of rejecting — this test checks the record is actually RE-READ afterwards, which
    // `move()` only reaches once the post itself has succeeded.
    serveWithDossier(record({ lifecycleStatus: AssayerLifecycleStatus.RESIGNED }), {});
    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Rehire — start onboarding again' }));
    // The reason box is open (same mechanism every reason-needing move uses) and pre-filled —
    // not blank, and not one of the ordinary departure reasons.
    expect(screen.getByLabelText(/Why\? This is kept on their employment record/)).toBeInTheDocument();
    expect(screen.getByText('Rehired — returning to the workforce')).toBeInTheDocument();

    // The second press — same button, now acting as the confirmation — sends it straight
    // through with no further typing.
    fireEvent.click(screen.getByRole('button', { name: 'Rehire — start onboarding again' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayers/a-1/lifecycle', expect.anything()));
    const [, options] = mockRequest.mock.calls.find(([url]) => url.endsWith('/lifecycle'))!;
    expect(JSON.parse(options.body)).toMatchObject({
      targetStatus: AssayerLifecycleStatus.INVITED,
      reason: 'Rehired — returning to the workforce',
    });
    // The record is re-read after the move, same as every other stage change — the page never
    // just trusts its own optimistic state for what Track 1's date reconciliation actually did.
    await waitFor(() => expect(
      mockRequest.mock.calls.filter(([url]) => url === '/assayers/a-1').length,
    ).toBeGreaterThan(1));
  });

  it('offers only the rehire reason and "Other" — none of the departure reasons fit coming back', async () => {
    serve(record({ lifecycleStatus: AssayerLifecycleStatus.TERMINATED }));
    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Rehire — start onboarding again' }));
    fireEvent.click(screen.getByLabelText(/Why\? This is kept on their employment record/));

    expect(await screen.findByRole('option', { name: 'Rehired — returning to the workforce' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Other (type it in)' })).toBeInTheDocument();
    // A reason for having LEFT is not a reason for being rehired.
    expect(screen.queryByRole('option', { name: 'Behaviour issue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Background/criminal-record issue' })).not.toBeInTheDocument();
  });

  it('still lets "Other" override the default for a rehire that needs a different word', async () => {
    serve(record({ lifecycleStatus: AssayerLifecycleStatus.RESIGNED }));
    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Rehire — start onboarding again' }));
    fireEvent.click(screen.getByLabelText(/Why\? This is kept on their employment record/));
    fireEvent.click(await screen.findByText('Other (type it in)'));

    const freeText = await screen.findByLabelText(/Reason, in your own words/i);
    fireEvent.change(freeText, { target: { value: 'Asked to come back for the festive-season surge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rehire — start onboarding again' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayers/a-1/lifecycle', expect.anything()));
    const [, options] = mockRequest.mock.calls.find(([url]) => url.endsWith('/lifecycle'))!;
    expect(JSON.parse(options.body)).toMatchObject({
      targetStatus: AssayerLifecycleStatus.INVITED,
      reason: 'Asked to come back for the festive-season surge',
    });
  });
});

/**
 * SUBSTANCE BEFORE THE THREE FORWARD ONBOARDING MOVES.
 *
 * These three used to fire the instant the button was pressed — none is in `HARD_TO_REVERSE_
 * STAGES`, so none got so much as a confirm dialog. Each now stops and says something the record
 * already knows, built from the one dossier read the record already makes (`dossierGlance`) —
 * and none of the three refuses the move; proceeding is always still one more click away.
 */
describe('AssayerRecord — substance before a forward onboarding move', () => {
  it('warns when not one document has been checked, before moving to background verification', async () => {
    serveWithDossier(
      record({ lifecycleStatus: AssayerLifecycleStatus.DOCUMENT_VERIFICATION }),
      { onboarding: Array.from({ length: 21 }, (_, i) => doc({ requirement: `REQ_${i}`, label: `Document ${i}` })) },
    );
    renderRecord();
    await waitForDossier();

    fireEvent.click(screen.getByRole('button', { name: 'Move to Background Verification' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(
      'No documents have been checked yet — 0 of 21 on their dossier are verified. Move them on anyway?',
    )).toBeInTheDocument();

    // Proceeding is still allowed — this is an informed confirm, not a gate.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Background Verification' }));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayers/a-1/lifecycle', expect.anything()));
    const [, options] = mockRequest.mock.calls.find(([url]) => url.endsWith('/lifecycle'))!;
    expect(JSON.parse(options.body)).toMatchObject({ targetStatus: AssayerLifecycleStatus.BACKGROUND_VERIFICATION });
  });

  it('does not interrupt the move once at least one document has actually been checked', async () => {
    serveWithDossier(
      record({ lifecycleStatus: AssayerLifecycleStatus.DOCUMENT_VERIFICATION }),
      {
        onboarding: [
          doc({ requirement: 'AADHAAR_FRONT', label: 'Aadhaar — front', identity: true, verificationStatus: 'VERIFIED' }),
          doc({ requirement: 'PAN_CARD', label: 'PAN card', identity: true }),
        ],
      },
    );
    renderRecord();
    await waitForDossier();

    fireEvent.click(screen.getByRole('button', { name: 'Move to Background Verification' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayers/a-1/lifecycle', expect.anything()));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names the finding, in amber, before carrying an adverse background verdict forward', async () => {
    serveWithDossier(
      record({ lifecycleStatus: AssayerLifecycleStatus.BACKGROUND_VERIFICATION }),
      { currentCheck: { verdict: 'CRIMINAL_CASE', findings: 'Bribery case pending in Nashik sessions court' } },
    );
    renderRecord();
    await waitForDossier();

    fireEvent.click(screen.getByRole('button', { name: 'Move to Training' }));

    const dialog = await screen.findByRole('dialog');
    // The message is built from mixed plain text and a highlighted <strong> fragment, so the
    // assertion reads the dialog's whole text rather than one node RTL might or might not
    // consider "the" matching element.
    expect(dialog.textContent).toContain(
      'Their background check recorded: Criminal case — Bribery case pending in Nashik sessions court. '
      + 'Moving them forward does not clear it. Continue?',
    );
    // "in amber" — the finding itself, not the whole sentence, carries the warning colour.
    const finding = within(dialog).getByText('Criminal case — Bribery case pending in Nashik sessions court');
    expect(finding.tagName).toBe('STRONG');
    expect(finding).toHaveStyle({ color: 'var(--warning)' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Training' }));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayers/a-1/lifecycle', expect.anything()));
    const [, options] = mockRequest.mock.calls.find(([url]) => url.endsWith('/lifecycle'))!;
    expect(JSON.parse(options.body)).toMatchObject({ targetStatus: AssayerLifecycleStatus.TRAINING });
  });

  it('does not interrupt a clear background check', async () => {
    serveWithDossier(
      record({ lifecycleStatus: AssayerLifecycleStatus.BACKGROUND_VERIFICATION }),
      { currentCheck: { verdict: 'CLEAR', checkedOn: '2026-01-01' } },
    );
    renderRecord();
    await waitForDossier();

    fireEvent.click(screen.getByRole('button', { name: 'Move to Training' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayers/a-1/lifecycle', expect.anything()));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lists the record\'s remaining critical gaps before activating, with the identity-gate note', async () => {
    serveWithDossier(
      record({ lifecycleStatus: AssayerLifecycleStatus.TRAINING, panNumber: null, bankAccountNumber: null }),
      {},
    );
    renderRecord();
    await waitForDossier();

    fireEvent.click(screen.getByRole('button', { name: 'Move to Active' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(
      'Still missing: PAN, Bank account. The identity gate is set to warn, so activation will '
      + 'proceed — these gaps stay on their record.',
    )).toBeInTheDocument();
  });

  it('folds in an unverified identity document even when the record\'s own fields are all filled in', async () => {
    serveWithDossier(
      record({ lifecycleStatus: AssayerLifecycleStatus.TRAINING }), // nothing critical missing
      {
        onboarding: [
          doc({ requirement: 'AADHAAR_FRONT', label: 'Aadhaar — front', identity: true }), // not verified
          doc({ requirement: 'PAN_CARD', label: 'PAN card', identity: true, verificationStatus: 'VERIFIED' }),
        ],
      },
    );
    renderRecord();
    await waitForDossier();

    fireEvent.click(screen.getByRole('button', { name: 'Move to Active' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(
      'Still missing: Aadhaar — front. The identity gate is set to warn, so activation will '
      + 'proceed — these gaps stay on their record.',
    )).toBeInTheDocument();
  });

  it('says everything needed is on file when nothing — record or identity — is missing', async () => {
    serveWithDossier(
      record({ lifecycleStatus: AssayerLifecycleStatus.TRAINING }),
      {
        onboarding: [
          doc({ requirement: 'AADHAAR_FRONT', label: 'Aadhaar — front', identity: true, verificationStatus: 'VERIFIED' }),
          doc({ requirement: 'PAN_CARD', label: 'PAN card', identity: true, verificationStatus: 'VERIFIED' }),
        ],
      },
    );
    renderRecord();
    await waitForDossier();

    fireEvent.click(screen.getByRole('button', { name: 'Move to Active' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Everything needed is on file.')).toBeInTheDocument();

    // Still just an informed confirm — proceeding is one click away either way.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Active' }));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayers/a-1/lifecycle', expect.anything()));
    const [, options] = mockRequest.mock.calls.find(([url]) => url.endsWith('/lifecycle'))!;
    expect(JSON.parse(options.body)).toMatchObject({ targetStatus: AssayerLifecycleStatus.ACTIVE });
  });

  it('always confirms the move to Active, even with nothing to report — the biggest step gets a check-in', async () => {
    serveWithDossier(record({ lifecycleStatus: AssayerLifecycleStatus.TRAINING }), {});
    renderRecord();
    await waitForDossier();

    fireEvent.click(screen.getByRole('button', { name: 'Move to Active' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // Unlike the other two, no missing-substance condition gates whether this one asks at all.
    expect(mockRequest).not.toHaveBeenCalledWith('/assayers/a-1/lifecycle', expect.anything());
  });
});

/**
 * THE ONBOARDING NEXT STEP, ON EVERY TAB.
 *
 * `ONBOARDING_NEXT_STEP` (@fapoms/shared) is the same sentence the planner prints when it refuses
 * an unfinished joiner work. The Summary tab's own "What happens next" section already led with
 * it, but only while that tab was open and only for `canManage` — so a record reached on Vetting
 * or Documents, or by a viewer who cannot manage it, showed nothing. The header renders for every
 * tab and does not check `canManage`, because reading the next step is not the same act as taking
 * it.
 */
describe('AssayerRecord — onboarding guidance in the header', () => {
  it('names the next step in the header for someone mid-onboarding', async () => {
    serve(record({ lifecycleStatus: AssayerLifecycleStatus.BACKGROUND_VERIFICATION }));
    renderRecord();

    await waitFor(() => expect(
      screen.getByText(/Next: they are in background verification — complete it on the HR roster/),
    ).toBeInTheDocument());
  });

  it('says nothing extra once somebody is past onboarding', async () => {
    serve(record({ lifecycleStatus: AssayerLifecycleStatus.ACTIVE }));
    renderRecord();

    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());
    expect(screen.queryByText(/^Next:/)).not.toBeInTheDocument();
  });
});

/**
 * "(BACKEND-AUTHORITATIVE)", NOW THAT IT IS TRUE.
 *
 * `DeploymentReadinessCard` carried that label from the beginning and branched on
 * `dossier.deployable` and `dossier.deploymentBlockers`. The dossier endpoint returned neither —
 * six keys, `references / empanelments / backgroundChecks / currentCheck / onboarding /
 * openIssues` — so both read `undefined`, and the verdict silently fell through to a rulebook the
 * card kept for itself: lifecycle, an explicit `unavailableReason`, and a missing lat/lng. Every
 * other thing it displayed — unverified identity documents, no bank account, no IFSC, no PAN, zero
 * plannable empanelments — was demoted to a *warning*, and warnings never touched the badge.
 *
 * Reproduced in the browser before this was written: an ACTIVE appraiser with a coordinate, no
 * bank account, no verified identity document and ZERO client empanelments drew a green
 * **Deployable** badge, while the planning engine refused the same person outright — "planning
 * requires an Active or Recommended empanelment standing". The record screen and the dispatch
 * screen contradicted each other about one person, and the record screen was the confident one.
 *
 * The server now computes the verdict (`RosterRecordsService.deploymentVerdict`) from the gates
 * that actually refuse things, so the tests below feed the card what that endpoint really returns
 * and hold it to rendering it — including the case it has no answer for, which used to be drawn
 * green because "no blockers found" and "nobody asked" were the same value.
 */
describe('AssayerRecord — deployment readiness is the server\'s verdict', () => {
  /** The record from the browser reproduction: ACTIVE, pinned, and short of everything else. */
  const unreadyPerson = () => record({
    lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
    bankAccountNumber: null,
  });

  /** Aadhaar and PAN on file as rows, neither checked against the original. */
  const unverifiedIdentity = () => [
    doc({ requirement: 'AADHAAR_FRONT', label: 'Aadhaar — front', identity: true, verificationStatus: null }),
    doc({ requirement: 'PAN_CARD', label: 'PAN card', identity: true, verificationStatus: null }),
  ];

  /**
   * The three sentences `deploymentVerdict` returns for exactly that record — copied from the
   * server rather than paraphrased, because the point of the fix is that this component invents
   * no wording of its own and a paraphrase here would quietly reintroduce a second voice.
   */
  const SERVER_BLOCKERS = [
    'no client empanelment on file — record an Active or Recommended standing on the vetting screen; '
      + 'with no standing anywhere the planner has no client it may offer them to',
    'identity not established — Aadhaar — front and PAN card have not been checked against the original; '
      + 'open their Documents tab, check the scan against what is recorded and mark it verified',
    'payout details incomplete (Bank account) — the audit can be dispatched, but every payable it earns '
      + 'is held until HR records them on the record',
  ];

  /**
   * THE ACCEPTANCE CASE. ACTIVE + no bank + no verified identity + zero plannable empanelments.
   *
   * Every reason has to appear as a blocking reason. None of them may be demoted to "Compliance
   * Attention", which is where the old card put the two that would actually stop a dispatch, and
   * the reassuring "meets all baseline operational and compliance gates" line must be nowhere on
   * the screen.
   */
  it('renders BLOCKED, with all three of the server\'s reasons, for the record the planner refuses', async () => {
    serveWithDossier(unreadyPerson(), {
      empanelments: [],
      onboarding: unverifiedIdentity(),
      deployable: false,
      deploymentBlockers: SERVER_BLOCKERS,
    });
    renderRecord();
    await waitForDossier();

    expect(screen.getByTestId('readiness-verdict-badge')).toHaveTextContent('Blocked from Deployment');

    const list = screen.getByTestId('deployment-blockers-list');
    for (const blocker of SERVER_BLOCKERS) {
      expect(within(list).getByText(blocker)).toBeInTheDocument();
    }

    // Nothing that stops work is filed as an "attention", and nothing on the card says they are fine.
    expect(screen.queryByTestId('deployment-warnings-list')).not.toBeInTheDocument();
    expect(screen.queryByText(/meets all baseline operational and compliance gates/)).not.toBeInTheDocument();
  });

  /**
   * The exact payload the live endpoint served before the fix. The card cannot answer from it and
   * must say so — drawing "Deployable" off a dossier that was never asked the question is the
   * whole defect, not a detail of it.
   */
  it('refuses to guess from the old six-key dossier, instead of calling the person deployable', async () => {
    serveWithDossier(unreadyPerson(), {
      empanelments: [],
      onboarding: unverifiedIdentity(),
    });
    renderRecord();
    await waitForDossier();

    const badge = screen.getByTestId('readiness-verdict-badge');
    expect(badge).toHaveTextContent('Readiness Unavailable');
    expect(badge).not.toHaveTextContent('Deployable');
  });

  /**
   * The dossier is ADMIN/OPERATIONS only and this page swallows the 403, so `dossier` stays null
   * for everyone else. Under the old fallback that gave the viewer with the least information the
   * most confident answer on the screen.
   */
  it('says it does not know when the dossier read is refused', async () => {
    serve(unreadyPerson());
    renderRecord();
    await waitFor(() => expect(screen.getByText('Person One')).toBeInTheDocument());

    expect(screen.getByTestId('readiness-verdict-badge')).toHaveTextContent('Readiness Unavailable');
    expect(screen.getByTestId('readiness-unavailable-note')).toBeInTheDocument();
  });

  /**
   * ONE BLOCKER PER PROBLEM. The card used to add its own lifecycle sentence on top of whatever
   * the server sent, so the moment the server started answering, a suspended appraiser would have
   * been given two entries saying the same thing in two different voices.
   */
  it('states a suspension once, in the server\'s words, not twice in two vocabularies', async () => {
    serveWithDossier(record({ lifecycleStatus: AssayerLifecycleStatus.SUSPENDED }), {
      deployable: false,
      deploymentBlockers: [
        'suspended — no assignment is offered, accepted or checked in while the suspension stands; '
        + 'lift it on the HR roster',
      ],
    });
    renderRecord();
    await waitForDossier();

    const items = within(screen.getByTestId('deployment-blockers-list')).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent(/suspended — no assignment is offered/);
  });

  /** And the green badge, only when the server actually said yes. */
  it('draws Deployable only on the server\'s own yes', async () => {
    serveWithDossier(record(), { deployable: true, deploymentBlockers: [] });
    renderRecord();
    await waitForDossier();

    expect(screen.getByTestId('readiness-verdict-badge')).toHaveTextContent('Deployable');
    expect(screen.queryByTestId('deployment-blockers-list')).not.toBeInTheDocument();
  });
});
