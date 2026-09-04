import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThreadPanel } from './ThreadPanel';
import { api } from '../../services/api';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/socket', () => ({ connectSocket: () => null, getSocket: () => null }));
// `useSyncExternalStore` requires a stable snapshot reference; a fresh object per call reads as a
// change on every render and loops forever, so this is defined once outside the mock factory.
const mockIdleCallState = { status: 'idle' };
jest.mock('../../services/call.service', () => ({
  callManager: {
    subscribe: () => () => {},
    getState: () => mockIdleCallState,
    startCall: jest.fn(),
  },
}));

const mockRequest = api.request as jest.Mock;

// jsdom does not implement scrollIntoView; ThreadPanel calls it on every message-list update.
beforeAll(() => { (Element.prototype as any).scrollIntoView = jest.fn(); });

/**
 * The region-flag note (shown once a PDF region is marked) now offers a datalist of common defect
 * reasons instead of a bare box — but it must still be possible to type anything not on the list,
 * and the general "ask the assayer" composer (no region marked) must be untouched: it has no fixed
 * vocabulary to suggest and stays a free-form multi-line box.
 */
describe('ThreadPanel — region-flag suggestions', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockRequest.mockImplementation(async (url: string) => {
      if (url.includes('/messages')) return [];
      return {};
    });
  });

  const baseProps = {
    queryId: 'q-1',
    onClearPending: jest.fn(),
    onFocusRegion: jest.fn(),
  };

  it('offers the region-flag datalist and still accepts free text not on the list', async () => {
    render(
      <ThreadPanel
        {...baseProps}
        pending={{ pageNumber: 2, region: { x: 0, y: 0, width: 1, height: 1 } } as any}
      />,
    );
    const box = await screen.findByPlaceholderText('What is wrong with this area?');
    expect(box.tagName).toBe('INPUT');
    expect(box.getAttribute('list')).toBe('region-flag-suggestions');

    // A suggestion from the list is present in the datalist (options carry no text node, only a
    // `value` attribute, so read them directly rather than via getByText).
    const datalist = document.getElementById('region-flag-suggestions');
    const values = Array.from(datalist?.querySelectorAll('option') ?? []).map((o) => o.getAttribute('value'));
    expect(values).toEqual(['Illegible', 'Cut off', 'Wrong page', "Value doesn't match", 'Missing signature or stamp']);

    // ...but typing something the list never offered still works and is exactly what gets sent.
    fireEvent.change(box, { target: { value: 'Torn corner obscures the amount' } });
    // The send button is icon-only (no accessible name) — it's the last button in the composer row.
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/validation-queries/q-1/messages',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('Torn corner obscures the amount') }),
    ));
  });

  it('leaves the general "ask the assayer" composer as a plain multi-line textarea with no datalist', async () => {
    render(<ThreadPanel {...baseProps} pending={null} />);
    const box = await screen.findByPlaceholderText('Ask the assayer…');
    expect(box.tagName).toBe('TEXTAREA');
    expect(box.getAttribute('list')).toBeNull();
    expect(document.getElementById('region-flag-suggestions')).toBeNull();
  });
});
