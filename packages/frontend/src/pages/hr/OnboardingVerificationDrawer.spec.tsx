import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AssayerLifecycleStatus } from '@fapoms/shared';

import { OnboardingVerificationDrawer } from './OnboardingVerificationDrawer';
import { api } from '../../services/api';

/**
 * The onboarding drawer has to let a clerk do every step's work, not just look at it.
 *
 * It used to show bank details and the home pin read-only and had nowhere to record a background
 * check — the three things the server demands before Training and Active — so a person reached
 * step 3 or 4 and nothing in the drawer could move them on. These tests walk each step: what it
 * says is missing, that the button waits for exactly that, and that the fix is in the drawer.
 */

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));

jest.mock('../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../hooks/useCurrentRoles'),
  useCurrentRoles: () => ['ADMIN'],
}));

const mockToast = jest.fn();
jest.mock('../../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

const mockConfirm = jest.fn().mockResolvedValue(true);
const mockConfirmWithReason = jest.fn().mockResolvedValue({ confirmed: true, reason: 'Background check found a criminal case' });
jest.mock('../../components/ui', () => ({
  ...jest.requireActual('../../components/ui'),
  useConfirm: () => ({ confirm: mockConfirm, confirmWithReason: mockConfirmWithReason, confirmDialog: null }),
}));

// The documents and background halves are the record page's own component, tested on its own.
// The stub proves which half is shown and lets a test fire the "something was saved" signal.
jest.mock('./AssayerVettingTab', () => ({
  ...jest.requireActual('./AssayerVettingTab'),
  AssayerVettingTab: ({ section, onChanged }: any) => (
    <div data-testid={`vetting-${section}`}>
      <button type="button" onClick={onChanged}>stub: saved in {section}</button>
    </div>
  ),
}));

// Leaflet needs a real browser; a click on this stands for dropping a pin on the map.
jest.mock('../../components/LocationPicker', () => ({
  LocationPicker: ({ onChange }: any) => (
    <button type="button" onClick={() => onChange(12.97, 77.59)}>stub: drop pin</button>
  ),
}));

const request = api.request as jest.Mock;

const person = (over: Record<string, unknown> = {}) => ({
  id: 'cand-1',
  displayName: 'Sunita Rao',
  assayerCode: 'AS0102',
  phone: '+919822001133',
  emergencyContactPhone: '+919822001144',
  joiningDate: '2026-09-01',
  lifecycleStatus: AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
  state: 'Karnataka',
  district: 'Bengaluru Urban',
  panNumber: '••••••234F',
  bankAccountNumber: '••••••••9012',
  ifscCode: 'HDFC0001234',
  bankName: 'HDFC Bank',
  latitude: 12.9716,
  longitude: 77.5946,
  ...over,
});

const identityDoc = (requirement: string, label: string, verificationStatus: string | null, withScan = true) => ({
  id: `doc-${requirement}`, requirement, label, identity: true, verificationStatus,
  filePaths: withScan ? [`assayers/cand-1/${requirement}.jpg`] : [],
});

const dossier = (over: Record<string, unknown> = {}) => ({
  references: [], empanelments: [], backgroundChecks: [], currentCheck: null, openIssues: [],
  onboarding: [
    identityDoc('AADHAAR_FRONT', 'Aadhaar — front', 'VERIFIED'),
    identityDoc('PAN_CARD', 'PAN card', 'PENDING'),
  ],
  ...over,
});

/** Serves the record and dossier from mutable holders, so a test can change what the next read returns. */
let current: { record: any; dossier: any };
const serve = () => {
  request.mockImplementation((url: string, opts?: any) => {
    if (url === '/assayers/cand-1' && (!opts || !opts.method)) return Promise.resolve(current.record);
    if (url === '/assayers/cand-1/dossier') return Promise.resolve(current.dossier);
    if (url.startsWith('/geo/ifsc/')) return Promise.resolve(null);
    return Promise.resolve({ success: true });
  });
};

const renderDrawer = (props: { onClose?: () => void; onSuccess?: () => void } = {}) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>
      <OnboardingVerificationDrawer
        candidateId="cand-1"
        onClose={props.onClose ?? jest.fn()}
        onSuccess={props.onSuccess ?? jest.fn()}
      />
    </MemoryRouter>
  </QueryClientProvider>,
);

const lifecycleCalls = () => request.mock.calls.filter(([url]) => url === '/assayers/cand-1/lifecycle');

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirm.mockResolvedValue(true);
  current = { record: person(), dossier: dossier() };
  serve();
});

describe('Documents step', () => {
  it('lists the identity checks the server requires, and holds the button until they are done', async () => {
    renderDrawer();

    const checklist = await screen.findByTestId('step-checklist');
    await waitFor(() => expect(within(checklist).getByText('PAN card: checked against the original')).toBeInTheDocument());
    expect(within(checklist).getByText('Aadhaar — front: checked against the original')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Move to background check/ })).toBeDisabled();
    expect(screen.getByText('1 thing left above')).toBeInTheDocument();
    // The work is right there, in the same component the record page uses.
    expect(screen.getByTestId('vetting-documents')).toBeInTheDocument();
  });

  it('refreshes the checklist when a document is checked inside the drawer, then moves them on', async () => {
    const onSuccess = jest.fn();
    renderDrawer({ onSuccess });
    await screen.findByTestId('vetting-documents');

    current.dossier = dossier({
      onboarding: [identityDoc('AADHAAR_FRONT', 'Aadhaar — front', 'VERIFIED'), identityDoc('PAN_CARD', 'PAN card', 'VERIFIED')],
    });
    fireEvent.click(screen.getByRole('button', { name: /stub: saved in documents/ }));

    const move = await screen.findByRole('button', { name: /Move to background check/ });
    await waitFor(() => expect(move).toBeEnabled());
    fireEvent.click(move);

    await waitFor(() => expect(lifecycleCalls()).toHaveLength(1));
    expect(JSON.parse(lifecycleCalls()[0][1].body)).toMatchObject({ targetStatus: AssayerLifecycleStatus.BACKGROUND_VERIFICATION });
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it('counts a sent-back Aadhaar back as unfinished even though the server list is only front and PAN', async () => {
    current.dossier = dossier({
      onboarding: [
        identityDoc('AADHAAR_FRONT', 'Aadhaar — front', 'VERIFIED'),
        identityDoc('PAN_CARD', 'PAN card', 'VERIFIED'),
        identityDoc('AADHAAR_BACK', 'Aadhaar — back', 'REJECTED'),
      ],
    });
    renderDrawer();

    expect(await screen.findByText('Aadhaar — back: sent back — a new scan is needed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Move to background check/ })).toBeDisabled();
  });
});

describe('Background check step', () => {
  beforeEach(() => {
    current.record = person({ lifecycleStatus: AssayerLifecycleStatus.BACKGROUND_VERIFICATION });
  });

  it('opens on the background check and waits for a clear result to be recorded there', async () => {
    renderDrawer();

    expect(await screen.findByTestId('vetting-checks')).toBeInTheDocument();
    expect(await screen.findByText('Background check recorded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Move to training/ })).toBeDisabled();

    current.dossier = dossier({ currentCheck: { verdict: 'CLEAR' } });
    fireEvent.click(screen.getByRole('button', { name: /stub: saved in checks/ }));

    const move = screen.getByRole('button', { name: /Move to training/ });
    await waitFor(() => expect(move).toBeEnabled());
    fireEvent.click(move);
    await waitFor(() => expect(lifecycleCalls()).toHaveLength(1));
    expect(JSON.parse(lifecycleCalls()[0][1].body)).toMatchObject({ targetStatus: AssayerLifecycleStatus.TRAINING });
  });

  it('says an adverse result stops them, and offers to stop their joining with a reason', async () => {
    current.dossier = dossier({ currentCheck: { verdict: 'CRIMINAL_CASE' } });
    renderDrawer();

    expect(await screen.findByText('Background check result: Criminal case — they cannot move on')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Move to training/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop their joining' }));
    await waitFor(() => expect(lifecycleCalls()).toHaveLength(1));
    expect(JSON.parse(lifecycleCalls()[0][1].body)).toEqual({
      targetStatus: AssayerLifecycleStatus.INACTIVE,
      reason: 'Background check found a criminal case',
    });
  });
});

describe('Training step — everything Active needs is fillable in the drawer', () => {
  /** Somebody who reached training the proper way: both identity documents checked. */
  const checkedIdentity = () => dossier({
    onboarding: [
      identityDoc('AADHAAR_FRONT', 'Aadhaar — front', 'VERIFIED'),
      identityDoc('PAN_CARD', 'PAN card', 'VERIFIED'),
    ],
  });

  it('holds activation until bank account, IFSC and a pin are in, and saves them from here', async () => {
    current.dossier = checkedIdentity();
    current.record = person({
      lifecycleStatus: AssayerLifecycleStatus.TRAINING,
      bankAccountNumber: null, ifscCode: null, bankName: null, latitude: null, longitude: null,
    });
    renderDrawer();

    const activate = await screen.findByRole('button', { name: /Make them Active/ });
    expect(activate).toBeDisabled();
    expect(await screen.findByText('3 things left above')).toBeInTheDocument();

    // Bank details, through the same edit rules as the record page.
    fireEvent.change(screen.getByPlaceholderText('e.g. 50100123456789'), { target: { value: '50100123456789' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. HDFC0001234'), { target: { value: 'HDFC0001234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/assayers/cand-1', expect.objectContaining({ method: 'PUT' })));
    const [, putOpts] = request.mock.calls.find(([url, o]) => url === '/assayers/cand-1' && o?.method === 'PUT')!;
    expect(JSON.parse(putOpts.body)).toMatchObject({ bankAccountNumber: '50100123456789', ifscCode: 'HDFC0001234' });

    // The pin, dropped on the map and saved.
    fireEvent.click(screen.getByRole('button', { name: 'stub: drop pin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save this pin' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/geo/precision/assayer/cand-1/pin', expect.objectContaining({ method: 'POST' })));

    // Once the record reads back complete, the button opens.
    current.record = person({ lifecycleStatus: AssayerLifecycleStatus.TRAINING });
    fireEvent.click(screen.getByRole('button', { name: 'stub: drop pin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save this pin' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Make them Active/ })).toBeEnabled());
  });

  it('shows the record gaps activation does not wait for, without letting them block it', async () => {
    current.dossier = checkedIdentity();
    current.record = person({ lifecycleStatus: AssayerLifecycleStatus.TRAINING, joiningDate: null });
    renderDrawer();

    expect(await screen.findByText(/Joining date \(can be done later\)/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Make them Active/ })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Save details' })).toBeInTheDocument();
  });

  /**
   * THE REPORTED CASE. Bank account, IFSC and pin all in, the list read "ready", the desk pressed
   * "Make them Active" — and the server refused, because it checks the identity documents at
   * Active too, and this list never did. Somebody can reach training with an unchecked PAN card:
   * the check was set to warn when they moved on, or they came in through an import.
   */
  it('does not call somebody ready while their PAN card is still unchecked', async () => {
    current.dossier = dossier();   // Aadhaar checked, PAN card pending
    current.record = person({ lifecycleStatus: AssayerLifecycleStatus.TRAINING });
    renderDrawer();

    const checklist = await screen.findByTestId('step-checklist');
    await waitFor(() => expect(within(checklist).getByText('PAN card: checked against the original')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Make them Active/ })).toBeDisabled();
    expect(screen.getByText('1 thing left above')).toBeInTheDocument();
  });

  it('opens once both identity documents are checked', async () => {
    current.dossier = checkedIdentity();
    current.record = person({ lifecycleStatus: AssayerLifecycleStatus.TRAINING });
    renderDrawer();

    await waitFor(() => expect(screen.getByRole('button', { name: /Make them Active/ })).toBeEnabled());
  });

  /**
   * ONE PAN. It used to be a bare "PAN" item here and a fourth box in the bank form, while the
   * Documents tab had its own PAN on the card's row — one number, two forms, two steps.
   */
  it('asks for the PAN once, with the card, and not in the bank form', async () => {
    current.dossier = dossier();
    current.record = person({ lifecycleStatus: AssayerLifecycleStatus.TRAINING, panNumber: null });
    renderDrawer();

    const checklist = await screen.findByTestId('step-checklist');
    await waitFor(() => expect(within(checklist).getByText('PAN card: its number is not recorded yet')).toBeInTheDocument());
    expect(within(checklist).queryByText(/^PAN$/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Bank/ }));
    expect(await screen.findByText('Bank details')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('e.g. ABCDE1234F')).not.toBeInTheDocument();
    expect(screen.getByText(/recorded with the PAN card/)).toBeInTheDocument();
  });

  it('never shows the full account or PAN in a box that could be saved back over the real number', async () => {
    current.record = person({ lifecycleStatus: AssayerLifecycleStatus.TRAINING });
    renderDrawer();

    const accountBox = await screen.findByPlaceholderText('e.g. 50100123456789');
    expect(accountBox).toHaveValue('');
    expect(screen.getByText('On file: ••••••••9012')).toBeInTheDocument();
  });
});

it('closes from the footer', async () => {
  const onClose = jest.fn();
  renderDrawer({ onClose });
  await screen.findByTestId('step-checklist');
  const closes = screen.getAllByRole('button', { name: 'Close' });
  fireEvent.click(closes[closes.length - 1]);
  expect(onClose).toHaveBeenCalled();
});

/**
 * WIDE ENOUGH FOR WHAT IT HOLDS.
 *
 * This drawer embeds the documents and checks tables, and it was a fixed 760px — about 690px of
 * room once padded, against an identity table that needs about 900. The whole drawer scrolled
 * sideways. jsdom cannot measure the table, so what is pinned is the width the drawer asks for.
 */
describe('the room the drawer gives its tables', () => {
  it('asks for more than a fixed 760px, and still fits a phone', async () => {
    renderDrawer();
    const drawer = await screen.findByRole('dialog');
    const style = drawer.getAttribute('style') ?? '';
    expect(style).toContain('920px');
    expect(style).toContain('94vw');
    expect(style).not.toContain('760px');
  });
});
