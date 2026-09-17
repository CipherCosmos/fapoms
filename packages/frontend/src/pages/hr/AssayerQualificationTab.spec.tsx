import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * The Profile score tab, from the clerk's side of the screen.
 *
 *   - the per-part worksheet is folded away until asked for, and still works once opened;
 *   - changing a score by hand is two boxes checked as they are typed — the button stays off
 *     until the score is a whole number from 0 to 100 AND a reason is given — and it sends the
 *     same request the old one-line dialog did;
 *   - why a bank's score is held down is on the row, not in a hover title.
 *
 * `api.request` is mocked with the UNWRAPPED payload: the real client strips `{ success, data }`,
 * so a mock returning the envelope would hand the tab an object with no `overall` on it and test
 * nothing but the skeleton.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/socket', () => ({ connectSocket: () => null, disconnectSocket: () => null }));
jest.mock('./assayerProfilePrint', () => ({ openAssayerProfilePrintWindow: jest.fn() }));

import { api } from '../../services/api';
import { AssayerQualificationTab } from './AssayerQualificationTab';

const request = api.request as jest.Mock;

const QUALIFICATION = {
  assayerId: 'as-1',
  overall: { computed: 72, override: null, effective: 72 },
  dimensions: [
    { key: 'identityVerification', label: 'Identity verification', computed: 80, override: null, effective: 80, basis: ['PAN verified'] },
    { key: 'backgroundCheck', label: 'Background check', computed: 60, override: null, effective: 60, basis: ['Last check clear'] },
  ],
  weights: {},
  computedAt: '2026-09-16T00:00:00.000Z',
  printSummary: {},
};

const PARTNERS = [
  {
    client: { id: 'c-1', name: 'State Bank', clientCode: null },
    dimensions: [],
    computed: 72,
    effective: 69,
    override: null,
    standing: 'DOCUMENTS_PENDING',
    standingReason: 'Passbook copy still to come',
    standingCap: 69,
    barred: false,
    gaps: [],
  },
];

function serve() {
  request.mockImplementation((url: string, opts?: { method?: string }) => {
    if (opts?.method === 'PUT') return Promise.resolve({ id: 'ov-1' });
    if (url === '/assayers/as-1/qualification') return Promise.resolve(QUALIFICATION);
    if (url === '/assayers/as-1/qualification/partners') return Promise.resolve(PARTNERS);
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

const draw = () => render(
  <MemoryRouter>
    <AssayerQualificationTab assayerId="as-1" canManage />
  </MemoryRouter>,
);

beforeEach(() => { request.mockReset(); serve(); });

describe('Profile score tab — the parts of the score', () => {
  it('keeps the per-part worksheet folded away until asked for, and working once opened', async () => {
    draw();
    const toggle = await screen.findByRole('button', { name: /See what makes up this score/ });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Identity verification')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change the Identity verification score' })).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: /Hide details/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Identity verification')).toBeInTheDocument();
    expect(screen.getByText('PAN verified')).toBeInTheDocument();

    // The per-part change button still opens the dialog, named for that part.
    fireEvent.click(screen.getByRole('button', { name: 'Change the Identity verification score' }));
    expect(within(screen.getByRole('dialog')).getByText('Change the “Identity verification” score')).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /Hide details/ }));
    expect(screen.queryByText('Identity verification')).not.toBeInTheDocument();
  });

  it('never sends a clerk to an admin screen they cannot open', async () => {
    draw();
    await screen.findByText(/An administrator sets how much each part counts/);
    expect(screen.queryByText(/Platform Settings/)).not.toBeInTheDocument();
  });
});

describe('Profile score tab — changing a score by hand', () => {
  const openDialog = async () => {
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /Change score/ }));
    return screen.getByRole('dialog');
  };

  it('keeps Save off until the score is 0–100 AND a reason is given', async () => {
    const dialog = await openDialog();
    const save = within(dialog).getByRole('button', { name: 'Save score' });
    const score = within(dialog).getByLabelText('New score');
    const reason = within(dialog).getByLabelText('Reason for the change');

    expect(save).toBeDisabled();

    fireEvent.change(score, { target: { value: '85' } });
    expect(save).toBeDisabled(); // a score with no reason

    fireEvent.change(reason, { target: { value: '   ' } });
    expect(save).toBeDisabled(); // a blank reason is not a reason

    fireEvent.change(reason, { target: { value: 'Checked the renewed certificate in person' } });
    expect(save).toBeEnabled();

    fireEvent.change(score, { target: { value: '101' } });
    expect(save).toBeDisabled();
    expect(within(dialog).getByText('Enter a whole number from 0 to 100.')).toBeInTheDocument();

    fireEvent.change(score, { target: { value: '' } });
    expect(save).toBeDisabled();
    expect(within(dialog).queryByText('Enter a whole number from 0 to 100.')).not.toBeInTheDocument();

    fireEvent.change(score, { target: { value: '0' } });
    expect(save).toBeEnabled();

    fireEvent.change(score, { target: { value: '100' } });
    expect(save).toBeEnabled();

    // Nothing was sent while the boxes were being filled in.
    expect(request.mock.calls.filter(([, o]) => o?.method === 'PUT')).toHaveLength(0);
  });

  it('sends the same request body the one-line dialog did', async () => {
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('New score'), { target: { value: '85' } });
    fireEvent.change(within(dialog).getByLabelText('Reason for the change'), { target: { value: '  verified in person  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save score' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const puts = request.mock.calls.filter(([, o]) => o?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe('/assayers/as-1/qualification/override');
    expect(JSON.parse(puts[0][1].body)).toEqual({
      dimension: 'overall', clientId: null, value: 85, reason: 'verified in person',
    });
  });

  it('carries the client id for a bank’s score', async () => {
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'Change the score for State Bank' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('New score'), { target: { value: '40' } });
    fireEvent.change(within(dialog).getByLabelText('Reason for the change'), { target: { value: 'Bank asked us to hold' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save score' }));

    await waitFor(() => expect(request.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(true));
    const [, opts] = request.mock.calls.find(([, o]) => o?.method === 'PUT')!;
    expect(JSON.parse(opts.body)).toEqual({
      dimension: 'overall', clientId: 'c-1', value: 40, reason: 'Bank asked us to hold',
    });
  });

  it('keeps the dialog and the typing when the save is refused, and says why inside it', async () => {
    const dialog = await openDialog();
    request.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PUT') return Promise.reject(new Error('The server said no.'));
      if (url.endsWith('/partners')) return Promise.resolve(PARTNERS);
      return Promise.resolve(QUALIFICATION);
    });
    fireEvent.change(within(dialog).getByLabelText('New score'), { target: { value: '85' } });
    fireEvent.change(within(dialog).getByLabelText('Reason for the change'), { target: { value: 'verified' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save score' }));

    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('The server said no.')).toBeInTheDocument());
    expect(within(screen.getByRole('dialog')).getByLabelText('New score')).toHaveValue(85);
  });
});

describe('Profile score tab — a held-down bank score says why on the row', () => {
  it('shows the standing reason as text, not only as a hover title', async () => {
    draw();
    const line = await screen.findByText(/Held at 69 or below because of this bank’s standing/);
    expect(line).toHaveTextContent('Passbook copy still to come');
    expect(screen.queryByTitle('Passbook copy still to come')).not.toBeInTheDocument();
  });
});
