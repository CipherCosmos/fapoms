import React from 'react';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';

import { ONBOARDING_NEXT_STEP, EmpanelmentStatus } from '@fapoms/shared';

import {
  AssayerVettingTab, vettingLede, standingStance, STANDING_LABELS,
} from './AssayerVettingTab';
import { api } from '../../services/api';
import { fromResponse } from '../../services/errors';
import { OTHER_STATUS_REASON } from './empanelment-reason-vocabulary';

/**
 * Two things this tab was quietly getting wrong.
 *
 * **References were append-only on screen and not in the API.** `PUT /assayers/:id/reference/:id`
 * and `DELETE /assayers/reference/:id` have existed since the vetting work landed; the table
 * offered only "Record call". On 1,983 imported reference rows a misspelt name or somebody
 * else's phone number could be added and never corrected.
 *
 * **A claimed soft copy read exactly like a real one.** `soft_copy_received` is ticked on 10,977
 * document rows that carry zero files — the old import copied a column of spreadsheet ticks —
 * and the Scan column rendered a green "Yes" for them, identical to a row with a scan attached.
 * That is why a roster with not one uploaded file looked collected.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../components/ui', () => ({
  useToast: () => ({ toast: jest.fn() }),
  useConfirm: () => ({
    confirm: () => Promise.resolve(true),
    confirmWithReason: () => Promise.resolve({
      confirmed: true,
      reason: 'Maiden name on the card, married name already on the record',
    }),
    confirmDialog: null,
  }),
  // A real (native) select rather than a plain input, so a test can see the actual option list —
  // in particular the "as recorded"/"Other" escape-hatch entries the relationship and standing-
  // reason dropdowns add for a value that predates their fixed lists (see reference-vocabulary.ts
  // and empanelment-reason-vocabulary.ts). Nothing else on this tab drives a Select through
  // `fireEvent.change`, so widening the stub from an <input> costs none of the existing tests.
  Select: ({ value, onChange, options, 'aria-label': ariaLabel }: any) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o: any) => (
        <option key={o.value} value={o.value}>{typeof o.label === 'string' ? o.label : o.value}</option>
      ))}
    </select>
  ),
  AlertBanner: ({ message, children }: any) => (message || children ? <div role="alert">{message ?? children}</div> : null),
  SkeletonList: () => <div data-testid="skeleton" />,
  // The real one. This tab's five tables ARE DataTable now, so stubbing it would leave these
  // tests asserting against an empty document — and a stub of a table is a second table, which is
  // the thing the convergence removed.
  DataTable: jest.requireActual('../../components/ui/DataTable').DataTable,
  // The real one, for the same reason. All four of this tab's editors are ONE `Editor` over one
  // `Modal` now, and the footer holding Cancel and Save is the Modal's — a stub that drops
  // `footer` (as this one did) hides every Save button on the tab, and a stub that reimplements
  // it is the second dialog the convergence removed.
  Modal: jest.requireActual('../../components/ui/Modal').Modal,
  // The real one. The verdict and verification chips render through this now, and it is a plain
  // presentational span — nothing here is worth a stub, and a stub would leave the "Verified" /
  // "Rejected" / verdict-label assertions below with no text to find.
  StatusBadge: jest.requireActual('../../components/ui/StatusBadge').StatusBadge,
}));

const mockRequest = api.request as jest.Mock;

const dossier = (over: Record<string, unknown> = {}) => ({
  references: [
    { id: 'r-1', fullName: 'Old Manager', relationship: 'Former manager', phone: '+919000000000', checkedAt: null },
  ],
  empanelments: [],
  backgroundChecks: [],
  currentCheck: null,
  onboarding: [],
  openIssues: [],
  ...over,
});

const serve = (payload: ReturnType<typeof dossier>, clients: { id: string; name: string }[] = []) => {
  mockRequest.mockImplementation((url: string) => {
    if (url.endsWith('/dossier')) return Promise.resolve(payload);
    if (url.startsWith('/clients')) return Promise.resolve(clients);
    return Promise.resolve({});
  });
};

beforeEach(() => mockRequest.mockReset());

describe('AssayerVettingTab — references', () => {
  it('offers Change and Remove beside a reference, not only "Record call"', async () => {
    serve(dossier());

    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);

    await waitFor(() => expect(screen.getByText('Old Manager')).toBeInTheDocument());
    expect(screen.getByText('Record call')).toBeInTheDocument();
    expect(screen.getByText('Change')).toBeInTheDocument();
    expect(screen.getByText('Remove')).toBeInTheDocument();
  });

  it('sends a correction as a PUT on that reference, clearing an emptied phone rather than keeping the old one', async () => {
    serve(dossier());
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);
    await waitFor(() => expect(screen.getByText('Old Manager')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Change'));
    // The form opens pre-filled with what is on file, which is what makes it a correction.
    const name = screen.getByDisplayValue('Old Manager');
    fireEvent.change(name, { target: { value: 'Correct Manager' } });
    fireEvent.change(screen.getByDisplayValue('+919000000000'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/assayers/a-1/reference/r-1',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const [, options] = mockRequest.mock.calls.find(([url]) => url === '/assayers/a-1/reference/r-1')!;
    // `undefined` would be dropped from the JSON and the server would keep the old number
    // (`dto.phone ?? row.phone`) — the very correction the operator opened this form to make.
    expect(JSON.parse(options.body)).toEqual({
      fullName: 'Correct Manager', relationship: 'Former manager', phone: null,
    });
  });

  it('offers the fixed relationship list, and keeps an unrecognised on-file value visible instead of blanking it', async () => {
    // 'Ex-manager' stands in for a reference added before this dropdown existed — the very
    // "Ex-manager"/"ex manager"/"Former Manager" drift RELATIONSHIPS was built to stop.
    serve(dossier({
      references: [
        { id: 'r-2', fullName: 'Odd One', relationship: 'Ex-manager', phone: null, checkedAt: null },
      ],
    }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);
    await waitFor(() => expect(screen.getByText('Odd One')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Change'));
    const select = screen.getByRole('combobox') as HTMLSelectElement;

    // The list shared with the registration wizard, in full.
    for (const r of ['Former manager', 'Former colleague', 'Current colleague', 'Client contact', 'Friend', 'Neighbour', 'Relative']) {
      expect(within(select).getByText(r)).toBeInTheDocument();
    }
    // The value on file is neither dropped nor swapped for the first option in the list.
    expect(select.value).toBe('Ex-manager');
    expect(within(select).getByText('Ex-manager — as recorded')).toBeInTheDocument();

    // And saving untouched sends that same string back, not the option it was displayed beside.
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/assayers/a-1/reference/r-2',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const [, options] = mockRequest.mock.calls.find(([url]) => url === '/assayers/a-1/reference/r-2')!;
    expect(JSON.parse(options.body)).toMatchObject({ relationship: 'Ex-manager' });
  });

  it('deletes through the reference route when Remove is confirmed', async () => {
    serve(dossier());
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);
    await waitFor(() => expect(screen.getByText('Old Manager')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Remove'));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/assayers/reference/r-1',
      expect.objectContaining({ method: 'DELETE' }),
    ));
  });
});

describe('AssayerVettingTab — background checks', () => {
  it('says on screen that a check cannot be edited, instead of leaving people hunting for the control', async () => {
    serve(dossier({
      currentCheck: { id: 'c-1', verdict: 'CLEAR', checkedOn: '2025-06-01' },
      backgroundChecks: [{ id: 'c-1', verdict: 'CLEAR', checkedOn: '2025-06-01' }],
    }));

    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);

    await waitFor(() => expect(screen.getByText(/Checks cannot be edited or deleted/)).toBeInTheDocument());
    expect(screen.getByText(/record a new check/)).toBeInTheDocument();
  });
});

describe('AssayerVettingTab — documents', () => {
  const paperwork = (over: Record<string, unknown>) => ({
    id: 'd-1',
    requirement: 'NDA',
    label: 'NDA',
    identity: false,
    filePaths: [],
    softCopyReceived: false,
    hardCopyReceived: false,
    hardCopyLocation: null,
    ...over,
  });

  it('does not call a spreadsheet tick a scan', async () => {
    serve(dossier({ onboarding: [paperwork({ softCopyReceived: true })] }));

    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);

    await waitFor(() => expect(screen.getByText(/Claimed on the old sheet — no scan/)).toBeInTheDocument());
    // The header counts evidence and the claim separately, so a roster with no files does not
    // read as collected.
    expect(screen.getByText(/0 of 1 have a scan on file/)).toBeInTheDocument();
    expect(screen.getByText(/1 other was ticked as received on the old roster sheet/)).toBeInTheDocument();
    // Never a green "Yes" — that is what made 10,977 empty rows read as collected.
    expect(screen.queryByText('Yes')).not.toBeInTheDocument();
  });

  it('counts a row with a file as having a scan, and says nothing about claims', async () => {
    serve(dossier({ onboarding: [paperwork({ softCopyReceived: true, filePaths: ['nda/1.pdf'] })] }));

    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);

    await waitFor(() => expect(screen.getByText(/1 of 1 have a scan on file/)).toBeInTheDocument());
    expect(screen.queryByText(/ticked as received on the old roster sheet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Claimed on the old sheet/)).not.toBeInTheDocument();
  });

  it('asks for a scan in words a clerk holding a photocopy would look for', async () => {
    serve(dossier({ onboarding: [paperwork({})] }));
    // jsdom has no camera, and the scan button is deliberately not rendered without one.
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: jest.fn() }, configurable: true,
    });

    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);

    /*
      Was "Attach" (email vocabulary) and "Original in" (filing-room shorthand for a toggle). Now
      two named doors rather than one: "Scan" opens the camera with a document scanner behind it,
      "Choose file" is the picker for a flatbed PDF. A clerk holding a photocopy can see which of
      the two they want without pressing either.
    */
    await waitFor(() => expect(screen.getByRole('button', { name: 'Scan' })).toBeInTheDocument());
    expect(screen.getByText('Choose file')).toBeInTheDocument();
    expect(screen.getByText('Signed paper is here')).toBeInTheDocument();
    expect(screen.queryByText(/^Attach$/)).not.toBeInTheDocument();
  });
});

describe('AssayerVettingTab — verify and send back without the browser', () => {
  const identityDoc = (over: Record<string, unknown> = {}) => ({
    id: 'd-9',
    requirement: 'AADHAAR_FRONT',
    label: 'Aadhaar — front',
    identity: true,
    filePaths: [],
    softCopyReceived: false,
    hardCopyReceived: false,
    hardCopyLocation: null,
    documentNumber: '234567890124',
    verificationStatus: 'PENDING',
    ...over,
  });

  const verifyCall = () =>
    mockRequest.mock.calls.find(([url, opts]: any[]) =>
      url === '/assayers/document/d-9/verify' && opts?.method === 'POST');

  it('reads what the card says in the app dialog, then verifies with it', async () => {
    serve(dossier({ onboarding: [identityDoc()] }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);
    await waitFor(() => expect(screen.getByText('Verify')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Verify'));
    await waitFor(() => expect(screen.getByText(/What does the Aadhaar — front say\?/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Name exactly as printed/), { target: { value: 'Ramesh Iyer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use these details' }));

    await waitFor(() => expect(verifyCall()).toBeDefined());
    expect(JSON.parse(verifyCall()![1].body)).toMatchObject({ verdict: 'VERIFIED', holderName: 'Ramesh Iyer' });
  });

  it('sends a scan back through the fixed reason list, not a numbered browser prompt', async () => {
    serve(dossier({ onboarding: [identityDoc()] }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);
    await waitFor(() => expect(screen.getByText('Send back')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Send back'));
    await waitFor(() => expect(screen.getByText(/Why is Aadhaar — front being sent back\?/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Why this document is being sent back/), { target: { value: 'ILLEGIBLE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Yes, send it back' }));

    await waitFor(() => expect(verifyCall()).toBeDefined());
    expect(JSON.parse(verifyCall()![1].body)).toMatchObject({ verdict: 'REJECTED', rejectionReason: 'ILLEGIBLE' });
  });
});

/**
 * The tab now opens on a sentence rather than on a card headed with a noun.
 *
 * `vettingLede` is the only prose on this tab that is assembled from data rather than written
 * out, which is where wording goes wrong without anybody noticing — so it is pinned here on the
 * two properties that matter: it names ONE outstanding thing (the first, in the order the
 * question is actually asked), and where the person is still joining it defers to
 * `ONBOARDING_NEXT_STEP` instead of describing the same state in words of its own.
 */
describe('vettingLede', () => {
  const facts = {
    section: 'checks' as const,
    hasCheck: true,
    referencesTotal: 2,
    referencesUnrung: 0,
    documentsTotal: 4,
    documentsWithoutScan: 0,
    originalsNotInOffice: 0,
  };

  it('leads with the joining step in the planner’s own words, not a second copy of them', () => {
    const line = vettingLede({ ...facts, hasCheck: false, lifecycleStatus: 'BACKGROUND_VERIFICATION' });

    // Verbatim from ONBOARDING_NEXT_STEP in @fapoms/shared. The planner prints this same
    // sentence when it refuses somebody work; a clerk sent here must find the same words.
    expect(line).toContain(ONBOARDING_NEXT_STEP.BACKGROUND_VERIFICATION);
    // And it wins outright — the missing check is not also recited at them.
    expect(line).not.toMatch(/No background check has been recorded/);
  });

  it('names only the first outstanding thing, so the opening line stays one line', () => {
    const line = vettingLede({ ...facts, hasCheck: false, referencesTotal: 0 });

    expect(line).toMatch(/No background check has been recorded/);
    expect(line).not.toMatch(/vouched for them/);
  });

  it('says so plainly when there is nothing to chase', () => {
    expect(vettingLede(facts)).toMatch(/Nothing is outstanding here/);
    expect(vettingLede({ ...facts, section: 'documents' })).toMatch(/Everything is collected/);
  });

  it('counts unrung references in words, never "1 reference(s)"', () => {
    expect(vettingLede({ ...facts, referencesUnrung: 1 })).toContain('1 reference still to ring');
    expect(vettingLede({ ...facts, referencesUnrung: 3 })).toContain('3 references still to ring');
  });
});

describe('AssayerVettingTab — one way to do one thing', () => {
  /**
   * A button per client is not a list, it is a wall.
   *
   * "No standing recorded for:" was followed by one chip per client with no standing — three
   * buttons on a demo tenant, two hundred on a real one, every one of them opening the same
   * dialog with a single field pre-filled. Adding a standing and changing one are the same act,
   * so they are one control and the client is the first thing picked inside it.
   */
  it('offers one control to add a standing, not one per client', async () => {
    serve(dossier(), [
      { id: 'c-1', name: 'First Bank' }, { id: 'c-2', name: 'Second Bank' },
      { id: 'c-3', name: 'Third Bank' }, { id: 'c-4', name: 'Fourth Bank' },
    ]);

    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);

    await waitFor(() => expect(screen.getByText('Add a bank')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /First Bank/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Fourth Bank/ })).not.toBeInTheDocument();
  });

  /**
   * Four editors became one, so two of them can no longer be open together — which the four
   * separate `useState`s allowed, leaving two Save buttons on screen at once with no way to tell
   * which form either belonged to.
   */
  it('opens one editor at a time', async () => {
    serve(dossier());
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);
    await waitFor(() => expect(screen.getByText('Old Manager')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Record a check'));
    expect(screen.getByRole('dialog')).toHaveTextContent('Record a background check');

    fireEvent.click(screen.getByText('Add reference'));
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toHaveTextContent('Add a reference');
  });
});

/**
 * The screen agreeing with the gate that actually decides.
 *
 * `ClientEligibilityFilter` admits only ACTIVE and RECOMMENDED, so DOCUMENTS_PENDING and INACTIVE
 * are passed over on every planning run. This tab used a local set of the four obvious refusals,
 * so it printed those two in ordinary text and left them out of its "not to be planned for" line
 * — telling a vetting operator that somebody the planner would silently skip was fine.
 */
describe('AssayerVettingTab — standings the planner will not accept', () => {
  const standing = (over: Record<string, unknown>) => ({
    id: 'e-1', clientId: 'c-1', client: { name: 'First Bank' },
    status: 'ACTIVE', statusReason: null, decidedAt: '2025-01-01', ...over,
  });

  it('treats a documents-pending standing as unplannable, and says why it is not a refusal', async () => {
    serve(dossier({ empanelments: [standing({ status: 'DOCUMENTS_PENDING' })] }));

    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);

    await waitFor(() => expect(screen.getByText('Documents pending')).toBeInTheDocument());
    expect(screen.getByText(/Not plannable for First Bank yet/)).toBeInTheDocument();
    // And it is not filed as a decision somebody took, because nobody took one.
    expect(screen.queryByText(/that decision has been taken/)).not.toBeInTheDocument();
    expect(standingStance('DOCUMENTS_PENDING')).toBe('notReady');
  });

  it('keeps a refusal separate from paperwork, because the next move differs', async () => {
    serve(dossier({
      empanelments: [
        standing({ status: 'REJECTED' }),
        standing({ id: 'e-2', clientId: 'c-2', client: { name: 'Second Bank' }, status: 'INACTIVE' }),
      ],
    }));

    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);

    await waitFor(() => expect(screen.getByText(/Not to be planned for First Bank/)).toBeInTheDocument());
    expect(screen.getByText(/Not plannable for Second Bank yet/)).toBeInTheDocument();
    expect(standingStance('REJECTED')).toBe('refused');
    expect(standingStance('INACTIVE')).toBe('notReady');
  });

  it('leaves the two standings the planner does accept alone', () => {
    expect(standingStance('ACTIVE')).toBe('plannable');
    expect(standingStance('RECOMMENDED')).toBe('plannable');
  });

  /**
   * Seven labels for an eight-value enum, and every render site reads
   * `STANDING_LABELS[status] ?? status` — so the one with no entry printed `INACTIVE` at a
   * non-technical clerk.
   */
  it('never prints a raw enum name at a clerk', async () => {
    serve(dossier({ empanelments: [standing({ status: 'INACTIVE' })] }));

    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);

    await waitFor(() => expect(screen.getByText('Empanelled before, dormant now')).toBeInTheDocument());
    expect(screen.queryByText('INACTIVE')).not.toBeInTheDocument();
  });

  it('has a written label for every value of the enum, not only the ones in use today', () => {
    for (const status of Object.values(EmpanelmentStatus)) {
      expect(STANDING_LABELS[status]).toBeTruthy();
      expect(STANDING_LABELS[status]).not.toBe(status);
    }
  });
});

/**
 * The "Why" behind a standing, picked from what HR actually writes rather than typed from
 * scratch every time.
 *
 * `status_reason` is mostly the importer's own "Working per roster (Project Name: X)" — not
 * something a person typed, so it is deliberately left out of the dropdown. What a person does
 * type clusters into a short list; "Other" still takes anything, same as the plain textarea this
 * replaced, and it stays optional.
 */
describe('AssayerVettingTab — why a standing is what it is', () => {
  const standing = (over: Record<string, unknown> = {}) => ({
    id: 'e-1', clientId: 'c-1', client: { name: 'First Bank' },
    status: 'ACTIVE', statusReason: null, decidedAt: '2025-01-01', ...over,
  });

  it('lets "Other" carry a reason no cluster covers, end to end', async () => {
    // references: [] — the default fixture's own reference row renders a "Change" button too,
    // and this test is about the standing's, not that one.
    serve(dossier({ references: [], empanelments: [standing({ status: 'INACTIVE', statusReason: null })] }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);
    await waitFor(() => expect(screen.getByText('Change')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Change'));
    // Two dropdowns are open at once here — Standing, then Why — so the reason one is the second.
    const select = screen.getAllByRole('combobox')[1] as HTMLSelectElement;
    expect(select.value).toBe(''); // nothing recorded yet
    fireEvent.change(select, { target: { value: OTHER_STATUS_REASON } });

    const freeText = await screen.findByPlaceholderText(/What was the reason\?/i);
    fireEvent.change(freeText, { target: { value: 'Fee dispute over a rejected claim' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save standing' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/assayers/a-1/empanelment/c-1',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const [, options] = mockRequest.mock.calls.find(([url]) => url === '/assayers/a-1/empanelment/c-1')!;
    expect(JSON.parse(options.body)).toMatchObject({ statusReason: 'Fee dispute over a rejected claim' });
  });

  it('opens an off-list value — including the importer\'s own text — straight into the free-text box, not blanked', async () => {
    // Neither "Working per roster (Project Name: Alpha)" (importer-written) nor a pre-dropdown
    // free-typed reason is one of the fixed clusters, so both must survive re-opening this form.
    serve(dossier({
      references: [],
      empanelments: [standing({ statusReason: 'Working per roster (Project Name: Alpha)' })],
    }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);
    await waitFor(() => expect(screen.getByText('Change')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Change'));
    const freeText = await screen.findByDisplayValue('Working per roster (Project Name: Alpha)');
    expect(freeText.tagName).toBe('TEXTAREA');

    // Saving without touching it keeps the exact string, rather than resetting to blank because
    // it does not match a cluster.
    fireEvent.click(screen.getByRole('button', { name: 'Save standing' }));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/assayers/a-1/empanelment/c-1',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const [, options] = mockRequest.mock.calls.find(([url]) => url === '/assayers/a-1/empanelment/c-1')!;
    expect(JSON.parse(options.body)).toMatchObject({ statusReason: 'Working per roster (Project Name: Alpha)' });
  });
});

/**
 * The copy a non-technical HR clerk reads on this tab — pinned where it used to leak engineering.
 *
 * "Hard-blocked (REJECTED, TERMINATED, EXPIRED, SUSPENDED)", "Conflict: …. Stale review discarded.
 * Reloading fresh server truth.", two chips for one verdict, and "BGV Agency / Verifier" on one
 * screen but "Agency / Verifier" on the next. Each test below is the clerk-visible sentence, not
 * an error code.
 */
const standingRow = (over: Record<string, unknown> = {}) => ({
  id: 'e-1', clientId: 'c-1', client: { name: 'First Bank' },
  status: 'ACTIVE', statusReason: null, decidedAt: '2025-01-01', ...over,
});

const FINAL_WORDS = "This bank's decision is final and can't be changed here.";
const CONFLICT_WORDS = 'Someone else changed this document while you had it open, so your review was not saved.';

describe('AssayerVettingTab — a bank decision that is final', () => {
  it('says "Final" on the row in words, with no enum name and nothing left to a tooltip', async () => {
    serve(dossier({
      references: [],
      empanelments: [
        standingRow({ status: 'REJECTED' }),
        standingRow({ id: 'e-2', clientId: 'c-2', client: { name: 'Second Bank' }, status: 'ACTIVE' }),
      ],
    }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);

    const tag = await screen.findByTestId('hard-block-tag');
    expect(tag).toHaveTextContent("Final — this bank's decision can't be changed here");
    expect(tag).not.toHaveAttribute('title');
    expect(screen.queryByText(/hard-blocked/i)).not.toBeInTheDocument();
    // Only the bank whose decision is still open offers Change.
    expect(screen.getAllByText('Change')).toHaveLength(1);
  });

  it('refuses to save over a decision that became final while the form was open, in plain words', async () => {
    let status = 'ACTIVE';
    mockRequest.mockImplementation((url: string) => {
      if (url.endsWith('/dossier')) return Promise.resolve(dossier({ empanelments: [standingRow({ status })] }));
      if (url.startsWith('/clients')) return Promise.resolve([]);
      return Promise.resolve({});
    });
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);
    await waitFor(() => expect(screen.getByText('First Bank')).toBeInTheDocument());

    fireEvent.click(within(screen.getByText('First Bank').closest('tr')!).getByText('Change'));
    expect(screen.getByRole('dialog')).toHaveTextContent('Standing with First Bank');

    // Somebody else finalises it; this screen learns so on its next re-read (here, after a call is logged).
    status = 'REJECTED';
    fireEvent.click(screen.getByText('Record call'));
    await waitFor(() => expect(screen.getByTestId('hard-block-tag')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Save standing' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(FINAL_WORDS));
    expect(screen.getByRole('alert').textContent).not.toMatch(/REJECTED|TERMINATED|EXPIRED|SUSPENDED|hard-block/i);
    expect(mockRequest).not.toHaveBeenCalledWith('/assayers/a-1/empanelment/c-1', expect.objectContaining({ method: 'PUT' }));
  });
});

describe('AssayerVettingTab — one result per background check', () => {
  it('shows one chip that leads with Passed, Failed or Pending, and names the finding after it', async () => {
    serve(dossier({
      currentCheck: { id: 'c-2', verdict: 'CIVIL_CASE', checkedOn: '2025-07-01', checkedByName: 'AuthBridge' },
      backgroundChecks: [
        { id: 'c-2', verdict: 'CIVIL_CASE', checkedOn: '2025-07-01' },
        { id: 'c-1', verdict: 'CLEAR', checkedOn: '2025-06-01' },
      ],
    }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);

    await waitFor(() => expect(screen.getByText('Failed — civil case')).toBeInTheDocument());
    // Not a second chip saying the same thing another way.
    expect(screen.queryByText('Civil case')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
    // The earlier check, in the history table, in the same words.
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(screen.getAllByText('Result').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/verdict/i)).not.toBeInTheDocument();

    expect(screen.getByText('Background check')).toBeInTheDocument();
    expect(screen.getByText('Background check agency')).toBeInTheDocument();
    expect(screen.getByText('AuthBridge')).toBeInTheDocument();
    // The report is described once, as the block you can act on — not also as a pointer elsewhere.
    expect(screen.getByText('Background check report')).toBeInTheDocument();
    expect(screen.queryByText(/Documents →/)).not.toBeInTheDocument();
  });

  it('offers the same words when recording a check, under the same field name', async () => {
    serve(dossier({ references: [] }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);
    await waitFor(() => expect(screen.getByText('Record a check')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Record a check'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Result')).toBeInTheDocument();
    expect(within(dialog).getByText('Background check agency')).toBeInTheDocument();
    const options = Array.from(within(dialog).getAllByRole('combobox')[0].querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['Passed', 'Failed — criminal case', 'Pending — not checked yet']));
    expect(within(dialog).queryByText(/BGV|Verifier|Verdict/)).not.toBeInTheDocument();
  });
});

describe('AssayerVettingTab — each half says where the other is', () => {
  it('points from the Background half to Documents, and the link switches tabs', async () => {
    serve(dossier());
    const onGoToDocuments = jest.fn();
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" onGoToDocuments={onGoToDocuments} />);

    await waitFor(() => expect(screen.getByText(/PAN, Aadhaar and other document checks are on the/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Documents tab' }));
    expect(onGoToDocuments).toHaveBeenCalledTimes(1);
  });

  it('points from the Documents half to Background, and the link switches tabs', async () => {
    serve(dossier());
    const onGoToChecks = jest.fn();
    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" onGoToChecks={onGoToChecks} />);

    await waitFor(() => expect(screen.getByText(/The background check and bank approvals are on the/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Background tab' }));
    expect(onGoToChecks).toHaveBeenCalledTimes(1);
  });

  it('still says where, as plain text, when the caller cannot switch tabs', async () => {
    serve(dossier());
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);

    await waitFor(() => expect(
      screen.getByText('PAN, Aadhaar and other document checks are on the Documents tab.'),
    ).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Documents tab' })).not.toBeInTheDocument();
  });
});

describe('AssayerVettingTab — looking at a scan', () => {
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  beforeEach(() => {
    (URL as any).createObjectURL = jest.fn(() => 'blob:scan-1');
    (URL as any).revokeObjectURL = jest.fn();
  });
  afterEach(() => {
    (URL as any).createObjectURL = realCreate;
    (URL as any).revokeObjectURL = realRevoke;
  });

  it('opens the shared document viewer, typed so a PDF is shown rather than downloaded', async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.endsWith('/dossier')) {
        return Promise.resolve(dossier({
          onboarding: [{
            id: 'd-1', requirement: 'NDA', label: 'NDA', identity: false,
            filePaths: ['uploads/nda-signed.pdf'], softCopyReceived: true, hardCopyReceived: false, hardCopyLocation: null,
          }],
        }));
      }
      if (url.startsWith('/clients')) return Promise.resolve([]);
      // Served as octet-stream in real life, which is why the type is not taken from here.
      if (url === '/assayers/document/d-1/file/0') return Promise.resolve(new Blob(['%PDF-1.4']));
      return Promise.resolve({});
    });
    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);

    const view = await screen.findByRole('button', { name: 'View scan of NDA' });
    // Nothing is fetched until somebody asks to look.
    expect(mockRequest).not.toHaveBeenCalledWith('/assayers/document/d-1/file/0', expect.anything());

    fireEvent.click(view);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTitle('NDA').tagName).toBe('IFRAME');
    expect(mockRequest).toHaveBeenCalledWith('/assayers/document/d-1/file/0', { raw: true });
    expect(((URL.createObjectURL as jest.Mock).mock.calls[0][0] as Blob).type).toBe('application/pdf');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:scan-1');
  });
});

/**
 * The three things `record/DocumentVerificationModal.tsx` pinned, asked of the flow clerks actually
 * use — that modal is rendered by nothing. The fixture is the dossier's real shape: the hash lives
 * on each entry of `versions`, not on the document row, and the refusals arrive as the API client
 * builds them (`fromResponse`), whose readable message does not contain the code.
 */
describe('AssayerVettingTab — a review is bound to the scan on screen', () => {
  const panDoc = (over: Record<string, unknown> = {}) => ({
    id: 'd-pan',
    requirement: 'PAN',
    label: 'PAN card',
    identity: true,
    filePaths: ['kyc/pan-2.jpg'],
    softCopyReceived: true,
    hardCopyReceived: false,
    hardCopyLocation: null,
    documentNumber: '******234F',
    verificationStatus: 'PENDING',
    currentVersionId: 'ver-2',
    docVersion: 2,
    versions: [
      { id: 'ver-2', version: 2, contentSha256: 'hash-2', verificationStatus: 'PENDING', supersededByVersionId: null },
      { id: 'ver-1', version: 1, contentSha256: 'hash-1', verificationStatus: 'REJECTED', supersededByVersionId: 'ver-2' },
    ],
    ...over,
  });

  const refusal = (code: string, text: string) => fromResponse(409, { code, message: `${code}: ${text}` });

  let dossierReads = 0;
  const serveReview = (docs: () => any[], onReview: (body: any) => Promise<unknown>) => {
    dossierReads = 0;
    mockRequest.mockImplementation((url: string, opts?: any) => {
      if (url.endsWith('/dossier')) { dossierReads += 1; return Promise.resolve(dossier({ references: [], onboarding: docs() })); }
      if (url.startsWith('/clients')) return Promise.resolve([]);
      if (url.endsWith('/verify')) return onReview(JSON.parse(opts.body));
      return Promise.resolve({});
    });
  };

  const verifyOnScreen = async () => {
    await waitFor(() => expect(screen.getByText('Verify')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Verify'));
    fireEvent.change(await screen.findByLabelText(/Name exactly as printed/), { target: { value: 'Ramesh Iyer' } });
    // Inside act: saving goes through the confirm dialog's promise before it sets anything, and
    // that state change would otherwise land outside every act() scope.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use these details' })); });
  };

  it('sends the version, the document revision and that version’s content hash', async () => {
    const bodies: any[] = [];
    serveReview(() => [panDoc()], (b) => { bodies.push(b); return Promise.resolve({}); });
    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);

    await verifyOnScreen();

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      verdict: 'VERIFIED', targetVersionId: 'ver-2', expectedDocVersion: 2, expectedContentHash: 'hash-2',
    });
    // The identity table's review column is headed for what its cells say.
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Checked' })).not.toBeInTheDocument();
  });

  it('tells the clerk in plain words when someone else changed it first, keeps saying so after the refresh, and never shows it verified', async () => {
    serveReview(() => [panDoc()], () => Promise.reject(refusal(
      'DOCUMENT_VERSION_STALE', 'Expected document version 2 but found 3. The document was modified concurrently.',
    )));
    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);

    await verifyOnScreen();

    await waitFor(() => expect(dossierReads).toBe(2));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(CONFLICT_WORDS);
    expect(alert.textContent).not.toMatch(/\.\s*\./);
    expect(alert.textContent).not.toMatch(/server truth|stale|conflict|DOCUMENT_VERSION_STALE/i);
    expect(screen.queryByText('Verified')).not.toBeInTheDocument();
  });

  it('cannot verify a superseded scan: a screen still showing the old one is refused and refreshed, and the next try is the new one', async () => {
    let onScreen = 'ver-1';
    const bodies: any[] = [];
    serveReview(
      () => [onScreen === 'ver-1'
        ? panDoc({ currentVersionId: 'ver-1', versions: [{ id: 'ver-1', version: 1, contentSha256: 'hash-1', verificationStatus: 'PENDING' }] })
        : panDoc()],
      (b) => {
        bodies.push(b);
        if (b.targetVersionId !== 'ver-2') {
          onScreen = 'ver-2';
          return Promise.reject(refusal(
            'CANNOT_VERIFY_SUPERSEDED_VERSION',
            'Document version v1 has been superseded by a newer upload. Only the current version can be verified.',
          ));
        }
        return Promise.resolve({});
      },
    );
    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);

    await verifyOnScreen();
    await waitFor(() => expect(dossierReads).toBe(2));
    expect(screen.getByRole('alert')).toHaveTextContent(CONFLICT_WORDS);
    expect(bodies[0]).toMatchObject({ targetVersionId: 'ver-1', expectedContentHash: 'hash-1' });

    await verifyOnScreen();
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ targetVersionId: 'ver-2', expectedContentHash: 'hash-2' });
  });

  it('sends a scan back against the same version, and says the same plain thing if someone got there first', async () => {
    const bodies: any[] = [];
    serveReview(() => [panDoc()], (b) => {
      bodies.push(b);
      return Promise.reject(refusal('DOCUMENT_ALREADY_REVIEWED', 'This document version has already been marked VERIFIED by another reviewer.'));
    });
    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);
    await waitFor(() => expect(screen.getByText('Send back')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Send back'));
    fireEvent.change(await screen.findByLabelText(/Why this document is being sent back/), { target: { value: 'ILLEGIBLE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Yes, send it back' }));

    await waitFor(() => expect(dossierReads).toBe(2));
    expect(bodies[0]).toMatchObject({ verdict: 'REJECTED', targetVersionId: 'ver-2', expectedDocVersion: 2, expectedContentHash: 'hash-2' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(CONFLICT_WORDS);
    expect(alert.textContent).not.toMatch(/\.\s*\.|server truth|VERIFIED/);
  });
});

/**
 * VERIFYING A DOCUMENT YOU CANNOT SEE.
 *
 * Verification asked "what does this card say?" in a dialog that did not show the card. To answer
 * honestly a reviewer had to open the scan in one window, close it, reopen this form and type from
 * memory — so in practice the name got copied from the record, which is the one place it is
 * guaranteed to match and therefore the one place that proves nothing.
 *
 * And the form asked every identity document the same two questions — a number and an expiry date
 * — when six of the eight never expire and one has no number at all.
 */
describe('AssayerVettingTab — verifying with the document in front of you', () => {
  const identityDoc = (over: Record<string, unknown> = {}) => ({
    id: 'd-9',
    requirement: 'AADHAAR_FRONT',
    label: 'Aadhaar — front',
    identity: true,
    filePaths: ['assayers/a-1/aadhaar-front.jpg'],
    softCopyReceived: true,
    hardCopyReceived: false,
    hardCopyLocation: null,
    documentNumber: '234567890124',
    verificationStatus: 'PENDING',
    prints: { name: true, dateOfBirth: true, gender: true, guardianName: false, address: false },
    ...over,
  });

  // jsdom has no object URLs; the component makes one per scan so the browser can draw it.
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  beforeEach(() => {
    (URL as any).createObjectURL = jest.fn(() => 'blob:aadhaar-front');
    (URL as any).revokeObjectURL = jest.fn();
  });
  afterEach(() => {
    // Restored to a no-op rather than to `undefined`: jsdom never had these, and React's cleanup
    // runs after this hook — putting `undefined` back makes the unmount throw.
    (URL as any).createObjectURL = realCreate ?? (() => 'blob:x');
    (URL as any).revokeObjectURL = realRevoke ?? (() => undefined);
  });

  it('puts the scan in the dialog, beside the boxes being filled in', async () => {
    serve(dossier({ onboarding: [identityDoc()] }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);
    await waitFor(() => expect(screen.getByText('Verify')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Verify'));

    await waitFor(() => expect(screen.getByText(/The scan is here beside the boxes/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByAltText('Scan 1')).toBeInTheDocument());
    expect(mockRequest).toHaveBeenCalledWith('/assayers/document/d-9/file/0', { raw: true });
  });

  /** No scan is a different situation, and it says so rather than showing an empty frame. */
  it('says to read from the original when nothing has been attached', async () => {
    serve(dossier({ onboarding: [identityDoc({ filePaths: [], softCopyReceived: false })] }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);
    await waitFor(() => expect(screen.getByText('Verify')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Verify'));

    await waitFor(() => expect(screen.getByText(/read from the original document in front of you/i)).toBeInTheDocument());
    expect(screen.queryByAltText('Scan 1')).not.toBeInTheDocument();
  });
});

describe('AssayerVettingTab — asking only what the document carries', () => {
  const idRow = (requirement: string, label: string) => ({
    id: 'd-1',
    requirement,
    label,
    identity: true,
    filePaths: [],
    softCopyReceived: false,
    hardCopyReceived: false,
    hardCopyLocation: null,
    documentNumber: null,
    verificationStatus: null,
  });

  const openNumberEditor = async (requirement: string, label: string) => {
    serve(dossier({ onboarding: [idRow(requirement, label)] }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);
    await waitFor(() => expect(screen.getByText('Add number')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Add number'));
  };

  it('does not ask when a PAN card expires, because it never does', async () => {
    await openNumberEditor('PAN_CARD', 'PAN card');

    // Scoped to the dialog: "Expires" is also a column header on the table behind it.
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('PAN')).toBeInTheDocument();
    expect(dialog.queryByText('Expires')).not.toBeInTheDocument();
    // …and it calls the number what the card calls it.
    expect(dialog.getByText(/Ten characters, like ABCDE1234F/)).toBeInTheDocument();
  });

  it('asks when a driving licence expires, because it does', async () => {
    await openNumberEditor('DRIVING_LICENCE', 'Driving licence');

    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Licence number')).toBeInTheDocument();
    expect(dialog.getByText('Expires')).toBeInTheDocument();
  });

  it('asks for no number on an address proof, which has none', async () => {
    await openNumberEditor('ADDRESS_PROOF', 'Address proof');

    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('This document has no number')).toBeInTheDocument();
    expect(dialog.queryByText('Expires')).not.toBeInTheDocument();
  });
});

/**
 * A 400 NOBODY COULD READ.
 *
 * Saving an Aadhaar number that fails its check digit is refused by the server with a good, exact
 * sentence — "the check digit did not match, please re-read it from the document". That sentence
 * was written into a page-level banner, which renders BEHIND the open dialog. The person sees the
 * dialog sitting there unchanged, presses Save again, and eventually opens the browser's network
 * tab to find out what happened. That is how this bug was reported.
 */
describe('AssayerVettingTab — when a save is refused', () => {
  const idRow = (over: Record<string, unknown> = {}) => ({
    id: 'd-1',
    requirement: 'AADHAAR_FRONT',
    label: 'Aadhaar — front',
    identity: true,
    filePaths: [],
    softCopyReceived: false,
    hardCopyReceived: false,
    hardCopyLocation: null,
    documentNumber: null,
    verificationStatus: null,
    ...over,
  });

  it('says why, inside the dialog, and keeps it open to correct', async () => {
    serve(dossier({ onboarding: [idRow()] }));

    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);
    await waitFor(() => expect(screen.getByText('Add number')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Add number'));

    const dialog = within(await screen.findByRole('dialog'));
    // 12 digits, wrong check digit — the shape passes, the checksum does not.
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: '234567890123' } });

    // Caught before the round trip: the same rule the server applies, asked while it is typed.
    await waitFor(() => expect(dialog.getByRole('alert')).toHaveTextContent(/do not check out/i));
    expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  /** A number that does check out is allowed through, and the warning goes away as it is corrected. */
  it('lets a good number through', async () => {
    serve(dossier({ onboarding: [idRow()] }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);
    await waitFor(() => expect(screen.getByText('Add number')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Add number'));

    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: '234567890124' } });

    expect(dialog.queryByRole('alert')).not.toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });

  it('refuses a PAN of the wrong shape before it is sent anywhere', async () => {
    serve(dossier({ onboarding: [idRow({ requirement: 'PAN_CARD', label: 'PAN card' })] }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);
    await waitFor(() => expect(screen.getByText('Add number')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Add number'));

    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'ABCDE1234' } });

    await waitFor(() => expect(dialog.getByRole('alert')).toHaveTextContent(/not a valid PAN/i));
  });
});

/**
 * WHY `minWidth={false}` WAS NOT ENOUGH.
 *
 * Every table on this tab already passed `minWidth={false}`, which removes the 640px floor — and
 * the tables still ran past the edge of the onboarding drawer, because `DataTable` makes every cell
 * `white-space: nowrap` unless the column says `wrap`. A long document name, and a row of actions
 * that could not break, were a single unbreakable line each.
 */
describe('AssayerVettingTab — fitting inside the onboarding drawer', () => {
  const idRow = {
    id: 'd-1', requirement: 'AADHAAR_FRONT', label: 'Aadhaar — front', identity: true,
    filePaths: [], softCopyReceived: false, hardCopyReceived: false, hardCopyLocation: null,
    documentNumber: null, verificationStatus: null,
  };
  const paperRow = {
    id: 'd-2', requirement: 'ETHICAL_CONDUCT_LETTER', label: 'Letter for commitment on ethical conduct',
    identity: false, filePaths: [], softCopyReceived: false, hardCopyReceived: false,
    hardCopyLocation: null, documentNumber: null, verificationStatus: null,
  };

  it('lets a long document name break onto a second line', async () => {
    serve(dossier({ onboarding: [idRow, paperRow] }));
    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);

    const identityCell = (await screen.findByText('Aadhaar — front')).closest('td') as HTMLElement;
    const paperCell = screen.getByText('Letter for commitment on ethical conduct').closest('td') as HTMLElement;
    expect(identityCell.style.whiteSpace).toBe('normal');
    expect(paperCell.style.whiteSpace).toBe('normal');
  });
});
