import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReviewsQueue } from './ReviewsQueue';
import { api } from '../../services/api';
import { SystemRole } from '@fapoms/shared';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

/**
 * The bulk "send back for rework" note now suggests common correction reasons through a
 * `<datalist>` — the same mechanism CaseWorkspace's field-anchor input already uses. This pins
 * that the suggestion list is present AND that it never stops a reviewer typing their own note.
 */
describe('ReviewsQueue — bulk rework note suggestions', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    localStorage.setItem('fapoms_user_cache', JSON.stringify({ roles: [SystemRole.DESK] }));
    mockRequest.mockImplementation(async (url: string) => {
      if (url.startsWith('/validation?')) {
        return { data: [{ id: 'c-1', status: 'HUMAN_REVIEW', projectBranchId: 'pb-1' }], meta: { pagination: { total: 1 } } };
      }
      if (url === '/validation/team') return [];
      return {};
    });
  });
  afterEach(() => localStorage.clear());

  it('offers a datalist of correction reasons and still accepts free text', async () => {
    render(<MemoryRouter><ReviewsQueue /></MemoryRouter>);

    // Wait for the one mocked row to actually land before touching its checkbox.
    await screen.findByText('1 case');
    const box = await screen.findByPlaceholderText('Note for the decision (required to send back)') as unknown as HTMLInputElement;
    expect(box.getAttribute('list')).toBe('rework-note-suggestions');
    const values = Array.from(document.querySelectorAll('#rework-note-suggestions option')).map((o) => o.getAttribute('value'));
    expect(values).toContain('Scan is illegible');
    expect(values).toContain('Value does not match the document');

    // Free text not on the list must still work — this is what actually gates "Send back"
    // (which also needs at least one row ticked).
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[checkboxes.length - 1]);
    fireEvent.change(box, { target: { value: 'Handwriting on page 3 is unreadable' } });
    expect(box.value).toBe('Handwriting on page 3 is unreadable');
    await waitFor(() => expect(screen.getByText('Send back for rework')).not.toBeDisabled());
  });
});
