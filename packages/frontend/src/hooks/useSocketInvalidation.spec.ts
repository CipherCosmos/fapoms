import { renderHook } from '@testing-library/react';
import { useSocketInvalidation } from './useSocketInvalidation';

/**
 * The workforce roster/overview entries this hook gained when `AssayerRoster.tsx` stopped opening
 * its own `connectSocket()` subscription and started depending on this registry instead — see the
 * comment above the `ASSAYER_*` block in `useSocketInvalidation.ts`.
 *
 * The one thing worth pinning here, given `EVENT_KEYS`'s coalescing timing already has its own
 * dedicated spec (`invalidationCoalescer.spec.ts`): that ALL TWELVE assayer event names —
 * not only the three field-edit ones (`assayer:updated`/`created`/`deleted`) — reach both
 * `queryKeys.hr.rosterAll` and `queryKeys.hr.workforce`. A lifecycle transition
 * (`AssayerActivatedEvent` and its siblings) is published under its own event name and never
 * also fires `assayer:updated`, so registering only the field-edit trio would silently leave
 * every stage move needing a manual reload — exactly the shape of gap this hook exists to close.
 */

type Handler = (...args: unknown[]) => void;
let listeners: Record<string, Handler[]>;

const fakeSocket = {
  on: (event: string, handler: Handler) => {
    (listeners[event] ??= []).push(handler);
  },
  off: (event: string, handler: Handler) => {
    listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler);
  },
};

const emit = (event: string, ...args: unknown[]) => {
  for (const h of listeners[event] ?? []) h(...args);
};

jest.mock('../services/socket', () => ({ connectSocket: () => fakeSocket }));

const invalidateQueries = jest.fn();
jest.mock('../queryClient', () => ({
  queryClient: { invalidateQueries: (...args: unknown[]) => invalidateQueries(...args) },
}));

/** `hr.rosterAll`/`hr.workforce` are both under the `SLOW_ROOTS` tier — see the note added beside
 *  `SLOW_ROOTS` in useSocketInvalidation.ts — so a full roster walk cannot be re-triggered a dozen
 *  times over by one burst of lifecycle events. The wait is the slow tier's 3s, not the fast 500ms. */
const PAST_SLOW_WAIT_MS = 3_100;

describe('useSocketInvalidation — the assayer roster/workforce entries', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    listeners = {};
    invalidateQueries.mockClear();
  });

  afterEach(() => jest.useRealTimers());

  const mount = () => renderHook(() => useSocketInvalidation());

  const invalidatedKeys = (): unknown[] => invalidateQueries.mock.calls.map((c: any[]) => c[0].queryKey);

  it.each([
    'assayer:updated', 'assayer:created', 'assayer:deleted',
  ])('invalidates the roster and the workforce overview on %s', (event) => {
    mount();

    emit(event);
    jest.advanceTimersByTime(PAST_SLOW_WAIT_MS);

    const keys = invalidatedKeys();
    expect(keys).toContainEqual(['hr', 'roster']);
    expect(keys).toContainEqual(['hr', 'workforce']);
  });

  it.each([
    'AssayerActivatedEvent', 'AssayerSuspendedEvent', 'AssayerDeactivatedEvent', 'AssayerOnLeaveEvent',
    'AssayerResignedEvent', 'AssayerTerminatedEvent', 'AssayerArchivedEvent',
    'AssayerDocumentVerificationStartedEvent', 'AssayerBackgroundCheckInitiatedEvent', 'AssayerTrainingStartedEvent',
  ])('also invalidates the roster and the workforce overview on the lifecycle event %s', (event) => {
    // The regression this pins: these carry their own class name rather than `assayer:updated`,
    // so a registry entry for the three field-edit events alone would never fire for a stage move.
    mount();

    emit(event);
    jest.advanceTimersByTime(PAST_SLOW_WAIT_MS);

    const keys = invalidatedKeys();
    expect(keys).toContainEqual(['hr', 'roster']);
    expect(keys).toContainEqual(['hr', 'workforce']);
  });

  it('coalesces a burst of lifecycle events into one invalidation per key, not one per event', () => {
    mount();

    for (let i = 0; i < 12; i++) emit('AssayerActivatedEvent');
    jest.advanceTimersByTime(PAST_SLOW_WAIT_MS);

    const rosterCalls = invalidatedKeys().filter((k) => JSON.stringify(k) === JSON.stringify(['hr', 'roster']));
    expect(rosterCalls).toHaveLength(1);
  });

  it('invalidates nothing before the slow tier\'s quiet period has actually elapsed', () => {
    mount();

    emit('assayer:updated');
    jest.advanceTimersByTime(PAST_SLOW_WAIT_MS - 500);

    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
