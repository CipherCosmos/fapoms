import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OnboardingApprovalEventKind as K, OnboardingApprovalStatus as S } from '@fapoms/shared';
import { api } from '../../../services/api';
import { HrApprovalsPage } from './HrApprovalsPage';

jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));

let mockRoles: string[] = ['ADMIN'];
jest.mock('../../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../../hooks/useCurrentRoles'),
  useCurrentRoles: () => mockRoles,
  useCurrentPermissions: () => [],
  useCurrentUserId: () => 'boss-1',
}));

const mockRequest = api.request as jest.Mock;

/**
 * THE APPROVER'S LIST, AS THE APPROVER READS IT.
 *
 * Three parts, by what the reader can do: decide it, wait for HR, or leave it to another approver.
 * Every person opens their record, where the approval panel is — deciding is not duplicated here.
 */
describe('Awaiting my approval', () => {
  const event = (kind: K, byId: string, byName: string, at: string, text: string | null = null) => ({ kind, byId, byName, at, text });
  const rows = [
    {
      id: 'r-1', round: 1, status: S.PENDING, decidedAt: null, preparers: ['hr-1'],
      assayerId: 'a-1', displayName: 'Shivam Kumar', assayerCode: 'AS0420', region: 'WEST',
      events: [
        event(K.SUBMITTED, 'hr-1', 'Asha (HR)', '2026-09-20T09:00:00Z', 'All checks clear.'),
        event(K.INFO_REQUESTED, 'boss-2', 'Rao', '2026-09-21T09:00:00Z', 'Where is the police certificate?'),
        event(K.ANSWERED, 'hr-1', 'Asha (HR)', '2026-09-22T09:00:00Z', 'Uploaded to Documents.'),
      ],
    },
    {
      id: 'r-2', round: 1, status: S.INFO_REQUESTED, decidedAt: null, preparers: ['hr-1'],
      assayerId: 'a-2', displayName: 'Priya Nair', assayerCode: null, region: null,
      events: [
        event(K.SUBMITTED, 'hr-1', 'Asha (HR)', '2026-09-20T09:00:00Z'),
        event(K.INFO_REQUESTED, 'boss-1', 'Me', '2026-09-23T09:00:00Z', 'Need the bank passbook.'),
      ],
    },
    {
      id: 'r-3', round: 1, status: S.PENDING, decidedAt: null, preparers: ['boss-1'],
      assayerId: 'a-3', displayName: 'Ravi Patil', assayerCode: 'AS0421', region: 'WEST',
      events: [event(K.SUBMITTED, 'boss-1', 'Me', '2026-09-23T09:00:00Z')],
    },
  ];

  const draw = () => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><HrApprovalsPage /></MemoryRouter>
    </QueryClientProvider>,
  );

  beforeEach(() => {
    mockRoles = ['ADMIN'];
    mockRequest.mockReset();
  });

  it('lists what is waiting for the reader\'s decision, with HR\'s latest answer, and opens the record', async () => {
    mockRequest.mockResolvedValue(rows);
    draw();

    const heading = await screen.findByRole('heading', { name: /Waiting for your decision/ });
    expect(heading).toHaveTextContent('(1)');
    const link = screen.getByRole('link', { name: /Shivam Kumar/ });
    // The record's Summary tab carries the approval panel — the same place the notification goes.
    expect(link).toHaveAttribute('href', '/hr/roster/a-1');
    expect(link).toHaveTextContent('AS0420');
    expect(screen.getByText('Uploaded to Documents.')).toBeInTheDocument();
    expect(screen.getByText(/HR answered:/)).toBeInTheDocument();
    expect(mockRequest).toHaveBeenCalledWith('/assayers/approvals/queue');
  });

  it('keeps a round waiting on HR out of the reader\'s decisions, and says what was asked', async () => {
    mockRequest.mockResolvedValue(rows);
    draw();

    const heading = await screen.findByRole('heading', { name: /Waiting on HR/ });
    expect(heading).toHaveTextContent('(1)');
    expect(screen.getByText('Need the bank passbook.')).toBeInTheDocument();
  });

  it('lists the one the reader sent up under "somebody else decides", and says why', async () => {
    mockRequest.mockResolvedValue(rows);
    draw();

    expect(await screen.findByRole('heading', { name: /Somebody else decides/ })).toHaveTextContent('(1)');
    expect(screen.getByText('You sent them up')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ravi Patil/ })).toBeInTheDocument();
  });

  it('says so plainly when nobody is waiting', async () => {
    mockRequest.mockResolvedValue([]);
    draw();
    expect(await screen.findByText('Nobody is waiting for approval.')).toBeInTheDocument();
  });

  /** A list that failed to load must never read as an empty one — that is how a waiting joiner gets missed. */
  it('says the list failed, rather than showing it as empty', async () => {
    mockRequest.mockRejectedValue(new Error('boom'));
    draw();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not be loaded, so this is not a list of nobody/);
    expect(screen.queryByText('Nobody is waiting for approval.')).not.toBeInTheDocument();
  });

  it('asks nothing of the server for somebody who cannot approve', () => {
    mockRoles = ['OPERATIONS'];
    draw();
    expect(screen.getByText(/for the people who approve joiners/)).toBeInTheDocument();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('puts each person under exactly one heading', async () => {
    mockRequest.mockResolvedValue(rows);
    draw();
    await screen.findByRole('heading', { name: /Waiting for your decision/ });
    for (const name of ['Shivam Kumar', 'Priya Nair', 'Ravi Patil']) {
      expect(screen.getAllByRole('link', { name: new RegExp(name) })).toHaveLength(1);
    }
    expect(within(document.body).getAllByRole('table')).toHaveLength(3);
  });
});
