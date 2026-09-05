import { useEffect } from 'react';
import { queryClient } from '../queryClient';
import { connectSocket } from '../services/socket';
import { createCoalescer } from './invalidationCoalescer';
import { queryKeys } from './queryKeys';

/**
 * The desk views every assignment event has to refresh.
 *
 * Kept as one list because the failure was per-screen: `queryKeys.assignments.all` covered the
 * assignment list and missed the Operations Inbox, which is where the desk actually works its
 * queues. Naming them together makes "did we refresh the queue too?" a single decision instead of
 * one that has to be remembered at each of the six event rows below.
 */
const DESK_QUEUES = [
  queryKeys.desk.inbox,
  queryKeys.desk.fallingBehind,
  queryKeys.desk.inboxRecommendations,
  queryKeys.desk.assignmentDetail,
  queryKeys.desk.assignmentFieldIssues,
  queryKeys.desk.branchHistory,
];

/**
 * The planning desk's coverage queue and candidate list.
 *
 * These are here because `PlanningWorkspace` used to subscribe to the same events itself — twice,
 * through two different socket APIs — and call its loaders directly. That is what turned one
 * server event into roughly six requests per open desk: an unpaginated `/projects/:id/branches`,
 * then the recommendation engine, the last-contact log and the date suggestion, all re-triggered
 * because two effects depended on the `branches` array reference rather than on an id.
 *
 * Routing them through this map instead means a burst of events costs one refetch of each, and
 * React Query's `signal` cancels the superseded request rather than letting it land late.
 */
const PLANNING_DESK = [queryKeys.planning.queue, queryKeys.planning.recommendationsAll];

const EVENT_KEYS: [string, ...any[]][] = [
  ['assignment:status-changed', queryKeys.assignments.all, ...DESK_QUEUES, ...PLANNING_DESK, queryKeys.dashboard.all, queryKeys.schedules.all, queryKeys.commandCenter.all],
  ['assignment:created', queryKeys.assignments.all, ...DESK_QUEUES, ...PLANNING_DESK, queryKeys.dashboard.all, queryKeys.commandCenter.all],
  // `assignment:counter-offered` used to sit here; the gateway stopped emitting it when in-app
  // fee negotiation was removed (2026-09). `fee-updated` stays: the desk still edits fees, and
  // ops screens (plus the billing subscriber server-side) refresh off it.
  ['assignment:fee-updated', queryKeys.assignments.all, ...DESK_QUEUES, ...PLANNING_DESK],
  // An assayer flagged a problem from the field — refresh the Field Issues queue and the
  // assignment views so the flag shows without a manual reload.
  ['assignment:issue-reported', queryKeys.assignments.fieldIssues, queryKeys.assignments.all, ...DESK_QUEUES, queryKeys.dashboard.all],
  ['assignment:escalated', queryKeys.assignments.all, ...DESK_QUEUES, queryKeys.planning.queue, queryKeys.dashboard.all],
  ['schedule:created', queryKeys.schedules.all, queryKeys.dashboard.all, queryKeys.assignments.all, queryKeys.planning.queue],
  ['schedule:updated', queryKeys.schedules.all, queryKeys.dashboard.all, queryKeys.assignments.all, queryKeys.planning.queue],
  ['ProjectCompleted', queryKeys.projects.all, queryKeys.planning.queue, queryKeys.dashboard.all, queryKeys.commandCenter.all],
  ['ProjectCancelled', queryKeys.projects.all, queryKeys.planning.queue, queryKeys.dashboard.all, queryKeys.commandCenter.all],
  ['ProjectPlanningStarted', queryKeys.projects.all, queryKeys.planning.queue, queryKeys.dashboard.all, queryKeys.commandCenter.all],
  ['document:uploaded', queryKeys.documents.all, queryKeys.documents.stats, queryKeys.schedules.all, queryKeys.assignments.all],
  ['document:status-changed', queryKeys.documents.all, queryKeys.documents.stats, queryKeys.documents.dataEntry, queryKeys.schedules.all, queryKeys.assignments.all],
  ['document:received', queryKeys.documents.all, queryKeys.documents.dataEntry, queryKeys.documents.stats, queryKeys.schedules.all, queryKeys.assignments.all],
  ['client:created', queryKeys.clients.all, queryKeys.clients.list({})],
  ['client:updated', queryKeys.clients.all, queryKeys.clients.list({})],
  ['client:status-changed', queryKeys.clients.all, queryKeys.clients.list({})],
  /**
   * The gateway has routed `branch:created`/`branch:updated` since before this hook existed
   * (`events.gateway.ts`'s `branch:created`/`branch:updated` cases), but nothing here ever
   * listened for them — the sibling `client:*` events three lines up were wired, these were not,
   * with no comment explaining a deliberate omission. Reproduced live: with `Branches.tsx` open
   * on one screen, editing the same branch from a second session updated the record on the
   * server but the first screen kept showing the pre-edit name/address indefinitely, with no
   * signal that its data had gone stale. `queryKeys.branches.all` covers `.list()` and
   * `.directory` (both prefixed under it); `planning.queue` and `desk.branchHistory` because a
   * branch's own details (name, address, region) surface in both the coverage queue and its
   * history drawer, the same reasoning already applied to schedule/document events above.
   * `commandCenter.all` for the same reason: a new or re-geocoded branch changes the Command
   * Center's coverage-gap and territory rollups, which read the same `branches` table.
   */
  ['branch:created', queryKeys.branches.all, queryKeys.planning.queue, queryKeys.desk.branchHistory, queryKeys.commandCenter.all],
  ['branch:updated', queryKeys.branches.all, queryKeys.planning.queue, queryKeys.desk.branchHistory, queryKeys.commandCenter.all],
  // Money: every billing event is "the book changed" — the events name what changed so a
  // future screen can be selective, but today every billing query re-reads from the server.
  ['billing:booked', queryKeys.billing.all],
  ['billing:payout-changed', queryKeys.billing.all],
  ['billing:invoice-changed', queryKeys.billing.all],
  ['billing:assayer-invoice-changed', queryKeys.billing.all],
  /**
   * The workforce roster and the overview it sits under (`AssayerRoster.tsx`/`HrLayout.tsx`),
   * kept live through this registry instead of `AssayerRoster.tsx`'s own `connectSocket()` call —
   * which is what it did until this entry existed, and exactly the duplicated-live-update shape
   * this hook exists to replace: a page with working live updates because it happened to open its
   * own socket, next to every other screen depending on this map alone.
   *
   * ALL TWELVE NAMES, not only the three field-edit events. A lifecycle move — activate, suspend,
   * resign, terminate, each joining stage — publishes its OWN event under `event.constructor.name`
   * (`AssayerStateMachine`, dispatched from `AssayerService.dispatchLifecycleTransition`) and never
   * also fires `assayer:updated`; the two streams do not overlap. Registering only the
   * `assayer:updated`/`assayer:created`/`assayer:deleted` trio — the events an ordinary field edit
   * or a create/delete raises — would have left every stage move needing a manual reload, which is
   * the live-update gap this hook exists to close everywhere else on the desk.
   */
  ...[
    'AssayerActivatedEvent', 'AssayerSuspendedEvent', 'AssayerDeactivatedEvent', 'AssayerOnLeaveEvent',
    'AssayerResignedEvent', 'AssayerTerminatedEvent', 'AssayerArchivedEvent',
    'AssayerDocumentVerificationStartedEvent', 'AssayerBackgroundCheckInitiatedEvent', 'AssayerTrainingStartedEvent',
    'assayer:updated', 'assayer:created', 'assayer:deleted',
  ].map((event): [string, ...any[]] => [event, queryKeys.hr.rosterAll, queryKeys.hr.workforce]),
];

/**
 * Query roots whose refetch is expensive enough that it must not track events one-for-one.
 *
 * `['dashboard']` is the operations command centre: a single server-side aggregate across the
 * whole assignment book, several joins wide. On the 300 ms window this hook used to run, an open
 * dashboard refetched that aggregate every 300 ms for as long as events kept arriving — a bulk
 * import of 500 assignments meant hundreds of full aggregate scans, from every dashboard anyone
 * had open, for a screen whose numbers nobody reads to three decimal places of freshness.
 *
 * Matched on the first key segment so it covers every scoped variant (`['dashboard', 'operations',
 * scopeKey]`) without having to enumerate them.
 *
 * `'command-center'` is the same shape of cost for the same reason: `CommandCenterService.overview`
 * loads every active branch and assayer and aggregates in memory, and is itself behind a 20s
 * cluster-wide cache server-side — refetching it on the live tier would mostly just miss that cache.
 *
 * `'hr'` covers both `queryKeys.hr.workforce` (the same shape of whole-roster aggregate as the two
 * above) and `queryKeys.hr.roster` — the roster now walks every page a filter's server-side result
 * has (`fetchWholeAssayerRoster`, since the roster's own thousand-row cap was killed), so refetching
 * it on the fast tier would mean a burst of a dozen lifecycle events re-walking the whole roster a
 * dozen times over. Matched the same way as `dashboard`, on the first key segment, so it also
 * covers `hr.importIssues` — that one is not in `EVENT_KEYS` today, so this has no effect on it yet,
 * but it would need no separate decision if it ever is.
 */
const SLOW_ROOTS = new Set<string>(['dashboard', 'command-center', 'hr']);

/**
 * Coalescing windows.
 *
 * `WAIT` is the quiet period after the last event; `MAX_WAIT` is the longest a refresh may be
 * postponed no matter how the events keep coming. The max-wait is the important half: a plain
 * trailing debounce starves under a continuous stream — a bulk import emitting an event every
 * 200 ms would reset a 500 ms timer forever and the screen would never update at all, which is a
 * worse failure than the storm it was meant to fix.
 */
const LIVE_WAIT_MS = 500;
const LIVE_MAX_WAIT_MS = 2_000;
const SLOW_WAIT_MS = 3_000;
const SLOW_MAX_WAIT_MS = 15_000;

export function useSocketInvalidation() {
  useEffect(() => {
    const socket = connectSocket();
    if (!socket) return;

    /**
     * One coalescer per tier.
     *
     * Accumulating unique keys over a window collapses a burst — a bulk transition of 50
     * assignments fires 50 `assignment:status-changed`, which would otherwise invalidate the same
     * keys 50 times and refetch the active list 50 times over. Splitting live queues from the slow
     * aggregates means the desk's inbox queues still update within two seconds of an event while
     * the dashboard's whole-book aggregate is capped at one refetch per fifteen seconds under
     * sustained load.
     */
    const invalidate = (keys: unknown[][]) => {
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
    };
    const live = createCoalescer<unknown[]>(LIVE_WAIT_MS, LIVE_MAX_WAIT_MS, invalidate);
    const slow = createCoalescer<unknown[]>(SLOW_WAIT_MS, SLOW_MAX_WAIT_MS, invalidate);
    /**
     * The reconnect handler below used to call `invalidateQueries` directly, once per `connect`
     * event. That is fine for an isolated reconnect — but a flapping connection (a dev backend
     * restarting under it, a phone crossing a Wi-Fi/cellular handoff) fires `disconnect`/`connect`
     * in rapid succession, and each one restarted every active query from scratch. A query that
     * genuinely fails every time (a 403 from a permission the caller doesn't hold, say) never got
     * a quiet window to actually settle into its error state — each new invalidation cancelled the
     * previous attempt first — so the screen it feeds stayed blank indefinitely instead of showing
     * the "you don't have access" message written for exactly that case. Routed through the same
     * `live` coalescer the event handlers above already use, so a reconnect storm collapses into
     * the one flush a real reconnect deserves, the same way a burst of `assignment:status-changed`
     * does.
     */
    const RECONNECT_KEY: unknown[] = ['__reconnect__'];
    const reconnectInvalidate = () => queryClient.invalidateQueries({ refetchType: 'active' });
    const reconnect = createCoalescer<unknown[]>(LIVE_WAIT_MS, LIVE_MAX_WAIT_MS, reconnectInvalidate);

    const handlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];

    for (const [event, ...keys] of EVENT_KEYS) {
      const handler = () => {
        for (const key of keys) {
          (SLOW_ROOTS.has(String(key[0])) ? slow : live).schedule(key);
        }
      };
      socket.on(event, handler);
      handlers.push({ event, handler });
    }

    /**
     * Catch up on everything that happened while the socket was down.
     *
     * The gateway replays missed events only for a reconnect inside its two-minute
     * `connectionStateRecovery` window. Past that — a closed laptop lid, a longer network drop —
     * the socket comes back healthy and the desk's "live" indicator turns green again, but every
     * event from the outage was lost, so the screen keeps showing pre-outage state indefinitely.
     * For the desk that means an operator confidently reading a superseded fee or queue.
     *
     * Refetching the active queries on reconnect closes that hole. `refetchType: 'active'` keeps
     * it to what is actually on screen rather than the whole cache. Bound to `connect` rather
     * than `reconnect` deliberately: in socket.io-client v4 reconnection events live on the
     * manager (`socket.io.on('reconnect')`), so a `socket.on('reconnect')` handler never fires
     * at all — the same trap the mobile client already documents. It is gated on having actually
     * been disconnected, so the first `connect` after mount does not refetch queries that the
     * page has only just loaded.
     */
    let wasDisconnected = false;
    const handleDisconnect = () => { wasDisconnected = true; };
    const handleReconnect = () => {
      if (!wasDisconnected) return;
      wasDisconnected = false;
      reconnect.schedule(RECONNECT_KEY);
    };
    socket.on('disconnect', handleDisconnect);
    socket.on('connect', handleReconnect);

    return () => {
      live.cancel();
      slow.cancel();
      reconnect.cancel();
      for (const { event, handler } of handlers) {
        socket.off(event, handler);
      }
      socket.off('disconnect', handleDisconnect);
      socket.off('connect', handleReconnect);
    };
  }, []);
}
