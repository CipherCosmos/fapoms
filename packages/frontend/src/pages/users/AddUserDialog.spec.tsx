import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddUserDialog, InviteResult, suggestUsername } from './AddUserDialog';
import { api } from '../../services/api';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
const request = api.request as jest.Mock;

const ROLES = [
  { id: 'r-admin', name: 'ADMIN' },
  { id: 'r-desk', name: 'DESK_OPERATOR' },
  { id: 'r-client', name: 'CLIENT_USER' },
];

/**
 * ADDING A COLLEAGUE USED TO REQUIRE KNOWING THE PERMISSION MODEL.
 *
 * The old form asked for a username, then offered a bare column of checkboxes — ADMIN,
 * DESK_OPERATOR, AUDITOR — with nothing on screen saying what any of them let a person do, and
 * ended by handing the administrator a password to pass on by chat message.
 */
describe('adding somebody to the team', () => {
  const onAdded = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    request.mockImplementation(async (path: string) => {
      if (path === '/users') return { id: 'new-1' };
      if (path.endsWith('/send-setup-link')) return { emailed: true, link: 'https://app/account-setup/tok' };
      return {};
    });
  });

  const open = () => render(
    <AddUserDialog roles={ROLES} clients={[{ id: 'c1', name: 'State Bank' }]} onClose={jest.fn()} onAdded={onAdded} />,
  );

  it('says what each role actually lets somebody do', () => {
    open();
    // The sentences that were in the shared vocabulary all along.
    expect(screen.getByText(/Runs the business: people and access/i)).toBeInTheDocument();
    expect(screen.getByText(/takes a packet, types it up, hands it back/i)).toBeInTheDocument();
  });

  it('derives the username from the name instead of asking for one', async () => {
    open();
    await userEvent.type(screen.getByLabelText('First name'), 'Priya');
    await userEvent.type(screen.getByLabelText('Last name'), 'Sharma');

    expect(screen.getByText('priya.sharma')).toBeInTheDocument();
    // Still changeable, for the account that needs a particular one.
    expect(screen.getByRole('button', { name: /change/i })).toBeInTheDocument();
  });

  it('creates the account and immediately emails an invite — no password anywhere', async () => {
    open();
    await userEvent.type(screen.getByLabelText('First name'), 'Priya');
    await userEvent.type(screen.getByLabelText('Last name'), 'Sharma');
    await userEvent.type(screen.getByLabelText('Work email'), 'priya@example.in');
    await userEvent.click(screen.getByRole('checkbox', { name: /Desk Operator/i }));
    await userEvent.click(screen.getByRole('button', { name: /Create and email an invite/i }));

    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    const [createPath, createInit] = request.mock.calls[0];
    expect(createPath).toBe('/users');
    const sent = JSON.parse(createInit.body);
    expect(sent).toMatchObject({ username: 'priya.sharma', email: 'priya@example.in', roleIds: ['r-desk'] });
    // The old form's defining feature: a password the administrator then had to pass on.
    expect(sent).not.toHaveProperty('password');
    expect(request.mock.calls[1][0]).toBe('/users/new-1/send-setup-link');
  });

  it('will not submit until it knows who they are and what they do', async () => {
    open();
    const submit = screen.getByRole('button', { name: /Create and email an invite/i });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText('First name'), 'Priya');
    await userEvent.type(screen.getByLabelText('Last name'), 'Sharma');
    await userEvent.type(screen.getByLabelText('Work email'), 'priya@example.in');
    // Still nothing chosen: an account with no role can sign in and see nothing.
    expect(submit).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: /Desk Operator/i }));
    expect(submit).toBeEnabled();
  });

  /** A client account that belongs to no client can see either nothing or everything. */
  it('asks which client, but only when the role is a client one', async () => {
    open();
    expect(screen.queryByText(/Which client/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: /Client User/i }));
    expect(screen.getByText(/Which client/i)).toBeInTheDocument();
  });

  it('keeps region scoping out of the way until it is wanted', async () => {
    open();
    expect(screen.getByText(/All of India — the usual answer/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'North' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Limit them to certain regions/i }));
    // "North" exactly — "North East" is a different region and would match a loose pattern.
    expect(screen.getByRole('checkbox', { name: 'North' })).toBeInTheDocument();
  });
});

/**
 * "Invite sent" when nothing was sent is how a colleague ends up waiting for a message nobody
 * posted — the same failure the candidate invite already had to learn about.
 */
describe('what the administrator is told afterwards', () => {
  it('confirms the address when the email actually went', () => {
    render(<InviteResult result={{ displayName: 'Priya', email: 'priya@example.in', emailed: true, link: 'x' }} onClose={jest.fn()} />);
    expect(screen.getByText(/on its way to/i)).toBeInTheDocument();
    expect(screen.getByText('priya@example.in')).toBeInTheDocument();
  });

  it('hands over the link to pass on when it did not', () => {
    render(<InviteResult result={{ displayName: 'Priya', email: 'priya@example.in', emailed: false, link: 'https://app/account-setup/tok' }} onClose={jest.fn()} />);
    expect(screen.getByText(/could not be sent/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://app/account-setup/tok')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy/i })).toBeInTheDocument();
  });
});

describe('the username it suggests', () => {
  it('follows the convention the existing accounts use', () => {
    expect(suggestUsername('Priya', 'Sharma')).toBe('priya.sharma');
    expect(suggestUsername('  RAHUL ', 'De Souza')).toBe('rahul.desouza');
  });

  it('copes with half a name', () => {
    expect(suggestUsername('Priya', '')).toBe('priya');
    expect(suggestUsername('', '')).toBe('');
  });
});
