import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { ONBOARDING_NEXT_STEP, EmpanelmentStatus } from '@fapoms/shared';

import {
  AssayerVettingTab, vettingLede, standingStance, STANDING_LABELS,
} from './AssayerVettingTab';
import { api } from '../../services/api';

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
  useConfirm: () => ({ confirm: () => Promise.resolve(true), confirmDialog: null }),
  Select: ({ value, onChange }: any) => <input value={value} onChange={(e) => onChange(e.target.value)} />,
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

    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);

    // Was "Attach" (email vocabulary) and "Original in" (filing-room shorthand for a toggle).
    await waitFor(() => expect(screen.getByText(/Upload scan/)).toBeInTheDocument());
    expect(screen.getByText('Signed paper is here')).toBeInTheDocument();
    expect(screen.queryByText(/^Attach$/)).not.toBeInTheDocument();
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

    await waitFor(() => expect(screen.getByText('Add a client standing')).toBeInTheDocument());
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
