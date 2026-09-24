import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HrRechecksPage } from './HrRechecksPage';
import { api } from '../../services/api';

/** HR's list of who needs a re-check (2026-09-23) — the worst first, and each opening the record. */
jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

const person = (id: string, name: string, standings: unknown[], hold: unknown = null) => ({
  assayerId: id, displayName: name, assayerCode: null, standings, hold,
});

describe('the re-checks list', () => {
  beforeEach(() => {
    mockRequest.mockResolvedValue([
      person('a-1', 'Asha Rao', [{ type: 'CREDIT', status: 'DUE_SOON', dueOn: '2026-10-10', blockFrom: '2026-11-09', lastCheckedOn: '2025-10-10', because: null }]),
      person('a-2', 'Ravi Kumar', [{ type: 'POLICE', status: 'BLOCKED', dueOn: '2026-06-15', blockFrom: '2026-07-15', lastCheckedOn: '2025-06-15', because: null }]),
      person('a-3', 'Meena Iyer', [], { checkId: 'c', checkType: 'BGV', verdict: 'CIVIL_CASE', since: '2026-09-20', recordedBy: 'hr' }),
    ]);
  });
  const draw = () => render(
    <QueryClientProvider client={new QueryClient()}><MemoryRouter><HrRechecksPage /></MemoryRouter></QueryClientProvider>,
  );

  it('puts the ones awaiting a decision and held from work first, each linking to their Background tab', async () => {
    draw();
    const links = await screen.findAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Meena Iyer', 'Ravi Kumar', 'Asha Rao']);
    expect(links[1]).toHaveAttribute('href', '/hr/roster/a-2?section=background');
    expect(screen.getByText('Adverse — awaiting a decision')).toBeInTheDocument();
    expect(screen.getByText('Overdue — held from new work')).toBeInTheDocument();
  });

  it('narrows to one group', async () => {
    draw();
    await screen.findAllByRole('link');
    fireEvent.click(screen.getByRole('button', { name: /Held from new work \(1\)/ }));
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['Ravi Kumar']);
  });
});
