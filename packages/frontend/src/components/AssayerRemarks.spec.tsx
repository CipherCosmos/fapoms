import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Staff remarks, as the HR drawer and the planning modal both show them.
 *
 *   - a saved remark names its category the way the compose dropdown does ("Quality of work"),
 *     not by its code (`QUALITY`);
 *   - the rating buttons say what they mean on their face, not only in a hover title;
 *   - the summary explains itself in a sentence, not the engine's formula.
 *
 * `api.request` returns the UNWRAPPED `{ remarks, summary }` — the real client strips the
 * `{ success, data }` envelope, and a mock that returned it would render an empty list.
 */

jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../services/socket', () => ({ connectSocket: () => null, disconnectSocket: () => null }));

import { api } from '../services/api';
import { AssayerRemarks } from './AssayerRemarks';

const request = api.request as jest.Mock;

const REMARK = {
  id: 'r-1',
  assayerId: 'as-1',
  authorId: 'u-2',
  authorName: 'Priya',
  authorRole: 'OPERATIONS',
  content: 'Reached the branch before opening time.',
  category: 'QUALITY',
  rating: 2,
  assignmentId: null,
  createdAt: '2026-09-01T10:00:00.000Z',
};

const draw = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <AssayerRemarks assayerId="as-1" />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({
    remarks: [REMARK],
    summary: { count: 1, weightedMean: 2, latest: null },
  });
  localStorage.setItem('fapoms_user_cache', JSON.stringify({ id: 'u-1', roles: ['ADMIN'] }));
});

afterEach(() => { localStorage.removeItem('fapoms_user_cache'); });

describe('AssayerRemarks — a saved remark', () => {
  /** The saved remark's own row — the compose dropdown above also says "Quality of work". */
  const savedRow = async () => {
    const text = await screen.findByText('Reached the branch before opening time.');
    return text.parentElement!.parentElement as HTMLElement;
  };

  it('names its category in words, not by its code', async () => {
    draw();
    const row = await savedRow();

    expect(within(row).getByText('Quality of work')).toBeInTheDocument();
    expect(screen.queryByText('QUALITY')).not.toBeInTheDocument();
  });

  it('shows its rating as a word as well as a number', async () => {
    draw();
    const row = await savedRow();
    expect(within(row).getByText(/Excellent/)).toBeInTheDocument();
    expect(within(row).getByText('+2')).toBeInTheDocument();
  });
});

describe('AssayerRemarks — rating buttons', () => {
  it('say what each rating means on the button itself', async () => {
    draw();
    await screen.findByText('Reached the branch before opening time.');

    for (const [word, number] of [
      ['Excellent', '+2'], ['Good', '+1'], ['Neutral', '0'], ['Concern', '−1'], ['Serious', '−2'],
    ]) {
      const button = screen.getByRole('button', { name: `${word} (${number})` });
      expect(button).toHaveTextContent(word);
      expect(button).toHaveTextContent(number);
    }
  });

  it('spells out the chosen rating on screen once it is picked', async () => {
    draw();
    await screen.findByText('Reached the branch before opening time.');

    const serious = screen.getByRole('button', { name: 'Serious (−2)' });
    expect(serious).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('Serious — the desk should think twice')).not.toBeInTheDocument();

    fireEvent.click(serious);

    expect(serious).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Serious — the desk should think twice')).toBeInTheDocument();
  });

  it('still sends the number the backend expects', async () => {
    draw();
    await screen.findByText('Reached the branch before opening time.');
    request.mockResolvedValue({});

    fireEvent.click(screen.getByRole('button', { name: 'Concern (−1)' }));
    fireEvent.change(screen.getByPlaceholderText(/What did you see/), { target: { value: 'Late twice this week' } });
    fireEvent.keyDown(screen.getByPlaceholderText(/What did you see/), { key: 'Enter' });

    const isPost = ([url, o]: any[]) => url === '/assayer-remarks' && o?.method === 'POST';
    await waitFor(() => expect(request.mock.calls.some(isPost)).toBe(true));
    const post = request.mock.calls.find(isPost);
    expect(JSON.parse(post![1].body)).toEqual({
      assayerId: 'as-1', rating: -1, category: 'QUALITY', text: 'Late twice this week',
    });
  });
});

describe('AssayerRemarks — the summary', () => {
  it('explains how remarks count in a sentence, with no formula or percentage', async () => {
    const { container } = draw();
    await screen.findByText(/Remarks count for a small part of how well someone matches a job/);

    expect(container.textContent).not.toMatch(/50 \+ 25|×|6%|\/100/);
    expect(container.querySelector('[title*="score ="]')).toBeNull();
  });

  it('says what no remarks means without quoting a score', async () => {
    request.mockResolvedValue({ remarks: [], summary: { count: 0, weightedMean: null, latest: null } });
    draw();
    expect(await screen.findByText(/neither help nor hurt when work is offered/)).toBeInTheDocument();
    expect(screen.queryByText(/50\/100/)).not.toBeInTheDocument();
  });
});
