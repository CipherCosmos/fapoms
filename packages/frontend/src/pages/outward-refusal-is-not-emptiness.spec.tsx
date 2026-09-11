import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AppError } from '../services/errors';

/**
 * A refused read is not an empty one, on the screens that describe how the platform is set up.
 *
 * These are the quiet ones. Nobody watches the holiday calendar or the zone list the way they
 * watch money, which is exactly why a lie told here survives: each of these screens defaults its
 * rows to `[]` and then writes a confident sentence over the gap.
 *
 *   - Zones:            "No zones defined yet. Create one to group branches for coverage planning."
 *   - Holidays:         "No holidays registered for 2026."
 *   - Transport rates:  "No active transport rates yet."
 *   - Journey estimate: "No active transport rate covers this place — offers there fall back to
 *                        the client contract's per-km formula."
 *   - Eligibility rules:"No rules yet. Without any, every assayer is eligible for every job…"
 *   - Rule bypass:      "All rules are being enforced."
 *
 * Every one of those is a statement about configuration that somebody then acts on: they rebuild a
 * zone that already exists, they schedule an audit onto a public holiday, they re-key a rate card
 * whose duplicate then competes for the scope an offer quotes from, or — the worst of them — they
 * take the green all-clear and go on producing records while the controls are off.
 *
 * Each screen is driven twice: once against a settled 403, and once against the paused retry that
 * a bare `isError` check misses (`loadFailed` in queryClient.ts explains the mechanism). Both
 * halves are asserted every time — the refusal IS on screen, and the screen's own empty sentence
 * is NOT. Asserting only the first would pass on a screen that printed both at once, which is the
 * same lie with a banner over it.
 */

// `services/api` reads Vite's `import.meta.env`, which ts-jest cannot parse. It also has to hand
// back a promise rather than `undefined`: several of these screens chain `.then()` straight off a
// reference-data call (Zones' `/geo/states`, Rules' vocabulary) during their first render.
jest.mock('../services/api', () => ({ api: { request: jest.fn(() => Promise.resolve(undefined)) } }));

/**
 * The query itself is what gets replaced here, not the service under it.
 *
 * The paused state cannot be produced by making a request fail — React Query reaches it by
 * declining to schedule a retry — so these tests hand the component the exact result object the
 * library would leave it holding. `useQuery` is the only export swapped; `QueryClientProvider`,
 * `useMutation` and `useQueryClient` stay real, so the components mount the way they do in the app.
 *
 * Declared inside the factory: `jest.mock` is hoisted above the imports, so anything referenced
 * from out here would be in its temporal dead zone by the time the first screen is required.
 */
jest.mock('@tanstack/react-query', () => {
  const actual = jest.requireActual('@tanstack/react-query');
  return { ...actual, useQuery: jest.fn() };
});

// The rule-bypass screen refuses to render for anyone who could not use it, and three of the
// others hide their write controls the same way. Signed in as an administrator throughout, so what
// these tests measure is the load, never the permission gate in front of it.
jest.mock('../hooks/useCurrentRoles', () => {
  const actual = jest.requireActual('../hooks/useCurrentRoles');
  return {
    ...actual,
    useCurrentRoles: () => ['ADMIN'],
    useCurrentPermissions: () => ['configuration:view:platform', 'configuration:edit:platform'],
  };
});
jest.mock('../config/route-permissions', () => {
  const actual = jest.requireActual('../config/route-permissions');
  return { ...actual, canAccessRoute: () => true };
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../services/api';
import { Zones } from './Zones';
import { Holidays } from './Holidays';
import { TransportCostsSection } from './TransportCosts';
import { RulesSection } from './Rules';
import { RuleBypassPanel } from './admin/RuleBypassPanel';

const reactQuery = jest.requireMock('@tanstack/react-query') as { useQuery: jest.Mock };
const mockRequest = api.request as jest.Mock;

const REFUSED = new AppError(
  'You do not have permission to perform this action. Ask an administrator if you require access.',
  'Forbidden',
  403,
  'permission-required',
);

/** The state React Query leaves behind when a fetch failed and settled. */
const failing = () => ({
  data: undefined,
  isError: true,
  isLoading: false,
  isPending: false,
  isFetching: false,
  fetchStatus: 'idle' as const,
  error: REFUSED,
  refetch: jest.fn(),
});

/**
 * The state a bare `isError` check misses: the retry was paused, so `isError` is false, `data` is
 * undefined and `isLoading` is false as well. This is the exact shape that produced the
 * "/scheduling shows 0 active schedules" finding, so every screen here gets its own pass through it.
 */
const paused = () => ({
  data: undefined,
  isError: false,
  isLoading: false,
  isPending: true,
  isFetching: false,
  fetchStatus: 'paused' as const,
  error: null,
  failureReason: REFUSED,
  refetch: jest.fn(),
});

const ok = <T,>(data: T) => ({
  data,
  isError: false,
  isLoading: false,
  isPending: false,
  isFetching: false,
  fetchStatus: 'idle' as const,
  error: null,
  refetch: jest.fn(),
});

type QueryKey = readonly unknown[];

/** Matches a query by the leading segments of its key, which is how these screens name them. */
const keyIs = (...parts: unknown[]) => (key: QueryKey) => parts.every((p, i) => key[i] === p);

/**
 * Answers every `useQuery` the screen makes: the one named by `match` is refused, and every other
 * one comes back healthy with no data — which is what each of these pages turns into its empty
 * state. So the only thing that can put a failure on screen is the failure under test.
 */
function serve(match?: (key: QueryKey) => boolean, state?: () => unknown) {
  reactQuery.useQuery.mockImplementation((options: { queryKey?: QueryKey }) => {
    const key = options?.queryKey ?? [];
    if (match && state && match(key)) return state();
    return ok(undefined);
  });
}

function draw(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Both halves of the rule, in one assertion pair. */
function expectRefusalNotEmptiness(emptySentence: RegExp) {
  expect(screen.getByText(/Could not load/)).toBeInTheDocument();
  expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
  expect(screen.queryByText(emptySentence)).not.toBeInTheDocument();
}

/** The two states every screen below is driven through. */
const BOTH: Array<[string, () => unknown]> = [
  ['a settled 403', failing],
  ['a paused retry', paused],
];

/**
 * The reference-data lookups these screens fire on mount — Zones' `/geo/states`, the rules
 * section's competency vocabulary — feed pickers inside dialogs none of these tests open. Left
 * pending rather than resolved: settling them after a synchronous test has finished only produces
 * act() warnings about state nothing here asserts on. Each test resolves the one call it is about.
 */
const pending = () => new Promise<never>(() => undefined);

beforeEach(() => {
  reactQuery.useQuery.mockReset();
  mockRequest.mockReset();
  mockRequest.mockImplementation(pending);
  serve();
});

describe('Zones — a refused territory map is not an undefined one', () => {
  it.each(BOTH)('says it was refused rather than "No zones defined yet" (%s)', (_label, state) => {
    serve(keyIs('zones'), state);
    draw(<Zones />);
    expectRefusalNotEmptiness(/No zones defined yet/);
  });

  it('offers no Retry for a refusal — the button could only fail identically', () => {
    serve(keyIs('zones'), failing);
    draw(<Zones />);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('still shows the genuine empty state when the load actually succeeded', () => {
    draw(<Zones />);
    expect(screen.getByText(/No zones defined yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
  });
});

describe('Holidays — a refused calendar is not a working year', () => {
  it.each(BOTH)('draws no month grid over a failed read (%s)', (_label, state) => {
    serve(keyIs('holidays'), state);
    draw(<Holidays />);
    expect(screen.getByText(/Could not load the holiday calendar/)).toBeInTheDocument();
    // Not one empty cell: an unmarked calendar says "nothing is observed on any of these days".
    expect(screen.queryByText('Mon')).not.toBeInTheDocument();
  });

  it.each(BOTH)('says it was refused rather than "No holidays registered for…" (%s)', (_label, state) => {
    serve(keyIs('holidays'), state);
    draw(<Holidays />);
    fireEvent.click(screen.getByTitle('List view'));
    expectRefusalNotEmptiness(/No holidays registered for/);
  });

  it('still shows the genuine empty state when the load actually succeeded', () => {
    draw(<Holidays />);
    fireEvent.click(screen.getByTitle('List view'));
    expect(screen.getByText(/No holidays registered for/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
  });
});

describe('Transport costs — a refused rate card is not an unpriced one', () => {
  // The rate card only; the estimator beside it keys on ['transport-rates', 'estimate', …].
  const rateCard = (key: QueryKey) => key[0] === 'transport-rates' && key[1] !== 'estimate';

  it.each(BOTH)('says it was refused rather than "No active transport rates yet" (%s)', (_label, state) => {
    serve(rateCard, state);
    draw(<TransportCostsSection />);
    expectRefusalNotEmptiness(/No active transport rates yet/);
  });

  it.each(BOTH)(
    'does not report a failed estimate as a place no rate covers (%s)',
    (_label, state) => {
      serve(keyIs('transport-rates', 'estimate'), state);
      draw(<TransportCostsSection />);
      expect(screen.getByText(/Could not load the journey estimate/)).toBeInTheDocument();
      expect(screen.queryByText(/No active transport rate covers this place/)).not.toBeInTheDocument();
    },
  );

  it('still shows both genuine empty states when the loads actually succeeded', () => {
    draw(<TransportCostsSection />);
    expect(screen.getByText(/No active transport rates yet/)).toBeInTheDocument();
    expect(screen.getByText(/No active transport rate covers this place/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
  });
});

describe('Rule bypass — a refused state is not an all-clear', () => {
  it.each(BOTH)(
    'never says "All rules are being enforced" off a read that failed (%s)',
    (_label, state) => {
      serve(keyIs('rule-bypass', 'state'), state);
      draw(<RuleBypassPanel />);
      expectRefusalNotEmptiness(/All rules are being enforced/);
    },
  );

  it.each(BOTH)('names a refused catalogue rather than leaving an empty checklist (%s)', (_label, state) => {
    serve(keyIs('rule-bypass', 'catalogue'), state);
    draw(<RuleBypassPanel />);
    expect(screen.getByText(/Could not load the rule catalogue/)).toBeInTheDocument();
    expect(screen.queryByText(/Loading the rule catalogue/)).not.toBeInTheDocument();
  });

  it('still gives the all-clear when the state actually loaded and no window is open', () => {
    draw(<RuleBypassPanel />);
    expect(screen.getByText(/All rules are being enforced/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
  });
});

/**
 * The rules section fetches with `useState` + `useEffect` rather than through React Query, so it
 * has no paused state to miss — a promise either resolved or it threw. Its half of the defect is
 * the other one `caughtLoad` exists for: the failure was held as a red line ABOVE a list that
 * still printed the empty state underneath it.
 */
describe('Eligibility rules — a refused list is not "every assayer is eligible"', () => {
  it('says the rules were refused rather than "No rules yet"', async () => {
    mockRequest.mockImplementation((url: string) =>
      (url.startsWith('/planning/rules') ? Promise.reject(REFUSED) : pending()));
    draw(<RulesSection />);
    await waitFor(() => expect(screen.getByText(/Could not load the eligibility rules/)).toBeInTheDocument());
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
    expect(screen.queryByText(/No rules yet/)).not.toBeInTheDocument();
    // And not "0 rules" beside the filter, counted from a list that never arrived.
    expect(screen.queryByText(/^\d+ rules$/)).not.toBeInTheDocument();
  });

  it('still shows the genuine empty state when the load actually succeeded', async () => {
    mockRequest.mockImplementation((url: string) =>
      (url.startsWith('/planning/rules') ? Promise.resolve([]) : pending()));
    draw(<RulesSection />);
    await waitFor(() => expect(screen.getByText(/No rules yet/)).toBeInTheDocument());
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
  });
});
