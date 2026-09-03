import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AssayerLifecycleStatus } from '@fapoms/shared';

import { AssayerRecord } from './AssayerRecord';
import { api } from '../../services/api';

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
  AssayerVettingTab: () => null, STANDING_LABELS: {}, BLOCKING_STANDINGS: new Set(),
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
  ],
  useManagerOptions: () => ({ people: [] }),
}));

const mockRequest = api.request as jest.Mock;

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

const renderRecord = () => render(
  <AssayerRecord assayerId="a-1" canManage onClose={jest.fn()} onChanged={jest.fn()} />,
);

beforeEach(() => mockRequest.mockReset());

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

    await waitFor(() => expect(
      screen.getByText(/in training — mark training complete on the HR roster to activate/),
    ).toBeInTheDocument());
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

    fireEvent.change(screen.getByLabelText(/Why\? This is kept on their employment record/), {
      target: { value: 'moved out of the area' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move to Inactive' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayers/a-1/lifecycle', expect.anything()));
    const [, options] = mockRequest.mock.calls.find(([url]) => url.endsWith('/lifecycle'))!;
    expect(JSON.parse(options.body)).toMatchObject({
      targetStatus: AssayerLifecycleStatus.INACTIVE,
      reason: 'moved out of the area',
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
