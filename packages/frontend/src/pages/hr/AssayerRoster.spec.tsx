import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { AssayerLifecycleStatus } from '@fapoms/shared';

import { AssayerRoster } from './AssayerRoster';
import { stillWorkable, type Assayer } from './assayer-shared';
import { api } from '../../services/api';

/**
 * The roster's joining queues.
 *
 * DOCUMENT_VERIFICATION and BACKGROUND_VERIFICATION are enforced lifecycle stages that had no
 * worklist: the "Onboarding" chip lumped all four joining stages together, so nobody could ask
 * "whose papers am I meant to check today". These tests hold the three queues to what they claim
 * — the right people, the right counts, and a sentence saying what to do with them.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/socket', () => ({ connectSocket: () => null }));
jest.mock('../../hooks/useCurrentRoles', () => ({
  useCurrentRoles: () => ['ADMIN'],
  canManageAssayers: () => true,
}));
jest.mock('../../hooks/useExcelExport', () => ({ useExcelExport: () => ({ download: jest.fn(), busy: false }) }));
// The panel reads the review queue through react-query; the roster's own tests are not about it.
jest.mock('./ImportIssuesPanel', () => ({ ImportIssuesPanel: () => null }));
// The registration flow is its own screen with its own tests; stubbed so this file stays about
// the queues. Mocking the wizard rather than `AssayerForms` keeps `EDIT_FIELDS` real for the
// registration module that derives its steps from it.
jest.mock('./registration/RegistrationWizard', () => ({ RegistrationWizard: () => null }));
jest.mock('../../components/import/useImportJob', () => ({
  useImportJob: () => ({ state: { phase: 'idle' }, start: jest.fn(), reset: jest.fn() }),
}));
jest.mock('../../components/import/ImportProgressPanel', () => ({ ImportProgressPanel: () => null }));
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: jest.fn() }) }));

const mockRequest = api.request as jest.Mock;

/** A complete record; every test knocks out exactly the one thing it is about. */
const person = (over: Record<string, unknown>) => ({
  id: 'a-1',
  assayerCode: 'AS0001',
  displayName: 'Person One',
  phone: '+919000000000',
  email: 'p1@example.com',
  city: 'Kochi',
  district: 'Ernakulam',
  state: 'Kerala',
  latitude: 9.9,
  longitude: 76.2,
  panNumber: 'ABCDE1234F',
  bankAccountNumber: '000111222333',
  ifscCode: 'HDFC0000001',
  joiningDate: '2024-01-01',
  emergencyContactPhone: '+919000000001',
  lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
  employmentType: 'INTERNAL',
  experienceYears: 4,
  skills: ['Gold'],
  exitDate: null,
  terminationDate: null,
  ...over,
});

const serve = (rows: ReturnType<typeof person>[]) => {
  mockRequest.mockImplementation(() =>
    Promise.resolve({ data: rows, meta: { pagination: { total: rows.length } } }));
};

const renderRoster = () => render(<MemoryRouter><AssayerRoster /></MemoryRouter>);

/** The chip whose label starts with `name`, counted by the number printed inside it. */
const chip = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });

beforeEach(() => mockRequest.mockReset());

describe('AssayerRoster — the joining queues', () => {
  const roster = [
    person({ id: 'a-1', assayerCode: 'AS0001', displayName: 'Docs Pending', lifecycleStatus: AssayerLifecycleStatus.DOCUMENT_VERIFICATION }),
    person({ id: 'a-2', assayerCode: 'AS0002', displayName: 'Bgv Pending', lifecycleStatus: AssayerLifecycleStatus.BACKGROUND_VERIFICATION }),
    person({ id: 'a-3', assayerCode: 'AS0003', displayName: 'Ready Person', lifecycleStatus: AssayerLifecycleStatus.TRAINING }),
    person({ id: 'a-4', assayerCode: 'AS0004', displayName: 'Blocked Trainee', lifecycleStatus: AssayerLifecycleStatus.TRAINING, bankAccountNumber: null }),
    person({ id: 'a-5', assayerCode: 'AS0005', displayName: 'Working Already' }),
  ];

  it('offers the three queues alongside the old Onboarding chip, each with its own count', async () => {
    serve(roster);

    renderRoster();

    await waitFor(() => expect(screen.getByText('Working Already')).toBeInTheDocument());
    // Onboarding still counts all four joining stages — worklists elsewhere link to it.
    expect(chip('Onboarding')).toHaveTextContent('4');
    expect(chip('Documents to check')).toHaveTextContent('1');
    expect(chip('Background check due')).toHaveTextContent('1');
    // Only the trainee with a complete record; the one missing a bank account is not "ready".
    expect(chip('Ready to activate')).toHaveTextContent('1');
  });

  it('"Documents to check" lists only the people at that stage', async () => {
    serve(roster);
    renderRoster();
    await waitFor(() => expect(screen.getByText('Working Already')).toBeInTheDocument());

    fireEvent.click(chip('Documents to check'));

    expect(screen.getByText('Docs Pending')).toBeInTheDocument();
    expect(screen.queryByText('Bgv Pending')).not.toBeInTheDocument();
    expect(screen.queryByText('Working Already')).not.toBeInTheDocument();
  });

  it('"Ready to activate" excludes a trainee whose record is still missing a required field', async () => {
    serve(roster);
    renderRoster();
    await waitFor(() => expect(screen.getByText('Working Already')).toBeInTheDocument());

    fireEvent.click(chip('Ready to activate'));

    expect(screen.getByText('Ready Person')).toBeInTheDocument();
    expect(screen.queryByText('Blocked Trainee')).not.toBeInTheDocument();
  });

  it('says what the selected queue is for, in the words of the action it wants', async () => {
    serve(roster);
    renderRoster();
    await waitFor(() => expect(screen.getByText('Working Already')).toBeInTheDocument());

    // A chip reading "Documents to check 34" is a number and a noun; the queue has to say what
    // the work is and where it is done.
    fireEvent.click(chip('Documents to check'));
    expect(screen.getByText(/enter each document number and confirm it against the original/)).toBeInTheDocument();

    fireEvent.click(chip('Background check due'));
    expect(screen.getByText(/go to Vetting, and record a check/)).toBeInTheDocument();

    // Chips that are not worklists get no sentence — "Everyone" needs no instructions.
    fireEvent.click(chip('Everyone'));
    expect(screen.queryByText(/go to Vetting, and record a check/)).not.toBeInTheDocument();
  });

  it('carries the planner\'s own next-step sentence onto the row', async () => {
    serve(roster);
    renderRoster();
    await waitFor(() => expect(screen.getByText('Ready Person')).toBeInTheDocument());

    const row = screen.getByText('Ready Person').closest('tr') as HTMLElement;
    expect(within(row).getByTitle(/in training — mark training complete on the HR roster to activate/))
      .toBeInTheDocument();
  });

  it('names the row actions rather than leaving two unlabelled icons per person', async () => {
    serve([roster[4]]);
    renderRoster();

    await waitFor(() => expect(screen.getByText('Working Already')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Edit Working Already' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Working Already' })).toBeInTheDocument();
  });
});

/**
 * Who the worklists are allowed to send somebody after.
 *
 * "Incomplete record" and "Cannot be paid" are queues: every row is a person a clerk is meant to
 * ring up and chase. They therefore have to be the population the server calls ON_ROSTER, and
 * they were one person wider than it — 718 against 717. The extra one is AS0055, recorded as
 * deceased, and a death is not a lifecycle value in this system: the roster importer files it as
 * INACTIVE plus `unavailableReason = DECEASED`. A rule written by listing lifecycle stages misses
 * it, and the second half of the rule — a leaving date — could not save it, because there was no
 * date to import. So the roster asked a clerk to go and chase a dead colleague's bank details.
 *
 * The server had already been fixed for exactly this (`HAS_LEFT` in hr-workforce.service.ts and
 * `hasLeft` in data-integrity.service.ts both carry the deceased arm). These hold this side to it.
 */
describe('AssayerRoster — who the worklists may chase', () => {
  const deceased = person({
    id: 'a-9',
    assayerCode: 'AS0055',
    displayName: 'Raghunandan Belekar',
    lifecycleStatus: AssayerLifecycleStatus.INACTIVE,
    unavailableReason: 'DECEASED',
    // The state that made this invisible: no leaving date of any kind, because the roster import
    // never had one and the corrupt-date repair blanked the rest.
    exitDate: null,
    terminationDate: null,
    bankAccountNumber: null,
  });
  const working = person({
    id: 'a-8', assayerCode: 'AS0008', displayName: 'Still Working', bankAccountNumber: null,
  });

  it('leaves a person recorded as deceased out of the record and payout queues', async () => {
    serve([deceased, working]);
    renderRoster();
    await waitFor(() => expect(screen.getByText('Still Working')).toBeInTheDocument());

    expect(chip('Incomplete record')).toHaveTextContent('1');
    expect(chip('Cannot be paid')).toHaveTextContent('1');

    fireEvent.click(chip('Cannot be paid'));
    expect(screen.getByText('Still Working')).toBeInTheDocument();
    expect(screen.queryByText('Raghunandan Belekar')).not.toBeInTheDocument();
  });

  it('counts them as exited even though nothing about them carries a date', async () => {
    serve([deceased, working]);
    renderRoster();
    await waitFor(() => expect(screen.getByText('Still Working')).toBeInTheDocument());

    expect(chip('Exited')).toHaveTextContent('1');

    fireEvent.click(chip('Exited'));
    expect(screen.getByText('Raghunandan Belekar')).toBeInTheDocument();
    expect(screen.queryByText('Still Working')).not.toBeInTheDocument();
  });

  it('says what happened in words that fit, rather than saying they left', async () => {
    serve([deceased]);
    renderRoster();
    await waitFor(() => expect(screen.getByText('Raghunandan Belekar')).toBeInTheDocument());

    // The gaps are still shown — a past payment may yet need settling — but as a statement, and
    // "left" is not what happened here.
    expect(screen.getByText(/gap · no longer with us/)).toBeInTheDocument();
  });
});

describe('still on the roster', () => {
  const at = (lifecycleStatus: string, over: Partial<Assayer> = {}) =>
    stillWorkable({ lifecycleStatus, ...over });

  it('excludes the four ways this system records a departure', () => {
    expect(at(AssayerLifecycleStatus.RESIGNED)).toBe(false);
    expect(at(AssayerLifecycleStatus.TERMINATED)).toBe(false);
    expect(at(AssayerLifecycleStatus.ARCHIVED)).toBe(false);
    expect(at(AssayerLifecycleStatus.INACTIVE, { unavailableReason: 'DECEASED' })).toBe(false);
  });

  it('excludes a departure entered as a date while the stage was left alone', () => {
    expect(at(AssayerLifecycleStatus.ACTIVE, { exitDate: '2024-06-01' })).toBe(false);
    expect(at(AssayerLifecycleStatus.ACTIVE, { terminationDate: '2024-06-01' })).toBe(false);
  });

  it('keeps everyone who is merely paused, and every other reason for being inactive', () => {
    // INACTIVE is not a departure. It is where somebody is parked, and the roster has people
    // sitting there because there is no branch near them or because they moved to a company.
    expect(at(AssayerLifecycleStatus.INACTIVE)).toBe(true);
    expect(at(AssayerLifecycleStatus.INACTIVE, { unavailableReason: 'NO_WORK_IN_AREA' })).toBe(true);
    expect(at(AssayerLifecycleStatus.ON_LEAVE)).toBe(true);
    expect(at(AssayerLifecycleStatus.SUSPENDED)).toBe(true);
    expect(at(AssayerLifecycleStatus.ACTIVE)).toBe(true);
  });
});
