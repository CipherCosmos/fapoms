import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { ToastProvider, useToast } from './Toast';

/**
 * The two promises this component makes, and the two ways it used to break them.
 *
 * The docblock at the top of Toast.tsx states the design plainly: a failure notice must not
 * disappear before it has been read, because someone will otherwise believe their work saved when
 * it had not. Both bugs below defeated that guarantee without touching the rule that states it.
 */

/** Drives the provider from inside, which is the only place `useToast` is available. */
const Harness: React.FC<{ onReady: (api: ReturnType<typeof useToast>) => void }> = ({ onReady }) => {
  const api = useToast();
  React.useEffect(() => { onReady(api); }, [api, onReady]);
  return null;
};

const mount = () => {
  let api!: ReturnType<typeof useToast>;
  render(
    <ToastProvider>
      <Harness onReady={(a) => { api = a; }} />
    </ToastProvider>,
  );
  return {
    toast: (...args: Parameters<typeof api.toast>) => {
      let id = -1;
      act(() => { id = api.toast(...args); });
      return id;
    },
    dismiss: (id: number) => act(() => { api.dismiss(id); }),
  };
};

describe('a full toast stack', () => {
  it('drops a message that was leaving anyway rather than an unread failure', () => {
    const { toast } = mount();

    toast('error', 'Payout run failed — bank file rejected');
    // Four more, which is MAX_VISIBLE. The old code kept the last four and carried the error off
    // the top; a person who saved four things after a failure never saw that it had failed.
    toast('success', 'Saved 1');
    toast('success', 'Saved 2');
    toast('success', 'Saved 3');
    toast('success', 'Saved 4');

    expect(screen.getByText('Payout run failed — bank file rejected')).toBeInTheDocument();
    // The oldest self-dismissing message went instead, which costs nothing: it had a countdown
    // running and was going to leave on its own within seconds.
    expect(screen.queryByText('Saved 1')).not.toBeInTheDocument();
    expect(screen.getByText('Saved 4')).toBeInTheDocument();
  });

  it('gives up the oldest pinned one only when everything is pinned', () => {
    const { toast } = mount();

    toast('error', 'First failure');
    toast('error', 'Second failure');
    toast('error', 'Third failure');
    toast('error', 'Fourth failure');
    toast('error', 'Fifth failure');

    // Something has to go once five pinned messages compete for four slots, and by then the newest
    // is the most likely to describe what the person just did.
    expect(screen.queryByText('First failure')).not.toBeInTheDocument();
    expect(screen.getByText('Fifth failure')).toBeInTheDocument();
  });
});

describe('a message identical to one already on screen', () => {
  it('is collapsed rather than stacked', () => {
    const { toast } = mount();

    toast('error', 'Could not reach the server');
    toast('error', 'Could not reach the server');

    expect(screen.getAllByText('Could not reach the server')).toHaveLength(1);
  });

  it('hands back the surviving toast’s id, not one for a toast that was never created', () => {
    const { toast, dismiss } = mount();

    const first = toast('error', 'Could not reach the server');
    const second = toast('error', 'Could not reach the server');

    // The whole contract of this return value is that `dismiss(id)` reaches the toast. Minting a
    // fresh id on the collapse path returned a number matching nothing, so dismiss was a no-op and
    // a pinned toast — a 'loading' spinner especially — could never be cleared by its owner.
    expect(second).toBe(first);

    dismiss(second);
    expect(screen.queryByText('Could not reach the server')).not.toBeInTheDocument();
  });
});

describe('what dismisses itself', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps an error up indefinitely, and lets a success go', () => {
    const { toast } = mount();

    toast('error', 'Bank file rejected');
    toast('success', 'Assayer saved');

    act(() => { jest.advanceTimersByTime(10_000); });

    expect(screen.getByText('Bank file rejected')).toBeInTheDocument();
    expect(screen.queryByText('Assayer saved')).not.toBeInTheDocument();
  });
});
