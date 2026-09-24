import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { MobileApiService } from '../services/api.service';
import { flushQueue } from '../services/location-queue';
import { dismissAction, enqueueAndRun, getRefusedActions, processActionQueue, subscribeActionQueue, toSubmitOutcome, type SubmitOutcome, type QueuedAction } from '../services/action-queue';
import { QUIET_RELOAD_EVENTS, notificationMovesJobs } from '../services/assignment-live-events';
import { refusalNotice } from '../i18n/refusal-notice';
import type { AssignmentStatusPayload, RejectPayload } from '../services/action-dispatchers';
import { actionDispatchers } from '../services/action-dispatchers';
import { connectMobileSocket } from '../services/socket';
import { scheduleLocalNotification } from '../services/notification.service';
import { useAuth } from './AuthContext';
import { readCache, writeCache } from '../services/token-store';
import { isStampCurrent, stampSession } from '../services/session-epoch';

interface AssignmentContextType {
  assignments: AssayerAssignment[];
  loading: boolean;
  activeAssignment: AssayerAssignment | null;
  setActiveAssignment: (assignment: AssayerAssignment | null) => void;
  loadAssignments: () => Promise<void>;
  /** The list on screen came from cache because the last refresh failed. */
  stale: boolean;
  lastSyncedAt: string | null;
  /**
   * `success: true, queued: true` means "saved on the phone, will send when online" — the screen
   * treats it as done (closes the form) and says so, rather than inviting a second press.
   */
  updateAssignmentStatus: (
    assignmentId: string,
    status: AssayerAssignment['status'],
    notes?: string,
  ) => Promise<SubmitOutcome>;
  /** `requestKey`: one key per decline form, so a second press on it cannot file a second decline. */
  rejectAssignment: (assignmentId: string, reason: string, requestKey?: string) => Promise<SubmitOutcome>;
  /** `requestKey`: one key per claim form, sent as the server's `clientRequestId`. */
  submitExpense: (
    assignmentId: string,
    expense: { category: 'TRAVEL_KM' | 'TOLL' | 'FOOD' | 'OTHER'; amount: number; description?: string },
    requestKey?: string,
  ) => Promise<SubmitOutcome>;
  /**
   * Actions saved on the phone that the server later refused (a check-in on the wrong day, a
   * claim over the limit). Shown with the server's reason until the assayer dismisses them.
   */
  refusedActions: QueuedAction[];
  dismissRefusedAction: (id: string) => Promise<void>;
}

const CACHE_KEY = 'assignments';

/**
 * Drop assignments the desk has soft-deleted (`isActive === false`) before anything is
 * rendered or cached. Soft-deleted rows carry an `isActive: false` while their status can
 * still be an open one (PENDING / ACCEPTED / CHECKED_IN / IN_PROGRESS), so a status-only
 * filter would keep showing them as current work. Legacy cached rows without the flag are
 * treated as active.
 */
const onlyActive = (items: AssayerAssignment[]) =>
  (items ?? []).filter((a) => a.isActive !== false);

const AssignmentContext = createContext<AssignmentContextType | undefined>(undefined);

/** Stable identity so the listener can be removed again on cleanup. */
const flushLocationQueueOnReconnect = () => {
  void flushQueue((batch) => MobileApiService.uploadLocationPings(batch)).catch(() => undefined);
};

export const AssignmentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, user } = useAuth();
  const [assignments, setAssignments] = useState<AssayerAssignment[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  /** True when the last refresh failed and the list on screen is from cache. */
  const [stale, setStale] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [activeAssignment, setActiveAssignment] = useState<AssayerAssignment | null>(null);

  const loadAssignments = useCallback(async () => {
    if (!isAuthenticated) {
      setAssignments([]);
      return;
    }
    setLoading(true);
    /**
     * Taken before the request, checked after it. A refresh still in flight when the assayer signs
     * out used to land anyway — back into the cache sign-out had just wiped, and onto the screen of
     * whoever signed in next. The answer now lands only in the session that asked for it, and the
     * cache write re-checks at the moment it runs (see `writeCache`'s `stillValid`).
     */
    const stamp = stampSession();
    try {
      const items = onlyActive(await MobileApiService.getAssayerAssignments(user?.id));
      if (!isStampCurrent(stamp)) return;
      setAssignments(items);
      setStale(false);
      setLastSyncedAt(new Date().toISOString());
      void writeCache(
        CACHE_KEY,
        { items, at: new Date().toISOString(), ownerId: stamp.owner },
        () => isStampCurrent(stamp),
      );
    } catch (e) {
      if (!isStampCurrent(stamp)) return;
      /**
       * A failed refresh keeps whatever is already on screen and says so.
       *
       * This used to log and leave the list as-is with no indication, so an assayer standing
       * in a vault could not tell the difference between "no work today" and "the app could
       * not reach the server". Marking it stale is what lets the UI say which.
       */
      console.warn('Could not refresh assignments; showing last synced data:', e);
      setStale(true);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, user?.id]);

  /**
   * Paints the last synced schedule before the network is even attempted.
   *
   * Cold start previously blocked the first useful frame on a round trip, which on rural data
   * is seconds of empty screen; and with no signal it never arrived at all.
   */
  useEffect(() => {
    // Signed out, or a different person signed in: nothing of the last person's schedule stays on
    // screen. (This list used to survive sign-out in memory and be shown to the next person until
    // their own refresh replaced it — or indefinitely, if that refresh failed.)
    setAssignments([]);
    setActiveAssignment(null);
    setLastSyncedAt(null);
    setStale(false);
    if (!isAuthenticated) return;
    let cancelled = false;
    const ownerId = user?.id;
    readCache<{ items: AssayerAssignment[]; at: string; ownerId?: string | null }>(CACHE_KEY).then((cached) => {
      if (cancelled || !cached?.items?.length) return;
      // Painted only if it was saved for this person. A copy with no owner (written by an older
      // build) is not shown: the network refresh replaces it within seconds anyway, and showing
      // somebody else's schedule even briefly is the thing this guards against.
      if (!ownerId || cached.ownerId !== ownerId) return;
      setAssignments((current) => (current.length > 0 ? current : onlyActive(cached.items)));
      setLastSyncedAt(cached.at);
    });
    return () => { cancelled = true; };
  }, [isAuthenticated, user?.id]);

  /**
   * Every server-side change that alters this list, delivered live.
   *
   * Only `assignment:status-changed` was originally subscribed, out of the set the backend
   * already emits to this assayer's own room. So a newly offered job, a packet dispatched to
   * the branch and a query raised by the desk all landed on the server and sat there until the
   * assayer happened to pull to refresh — which, for a new assignment, means the offer is
   * invisible until they think to look for it.
   *
   * The reload is debounced rather than fired per event: the backend commonly emits several
   * around one desk action (status, notification), and at branch-rollout scale a burst
   * would otherwise become a burst of identical GETs from every handset at once.
   */
  useEffect(() => {
    if (!isAuthenticated) return;

    loadAssignments();
    const socket = connectMobileSocket();
    if (!socket) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const reloadSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        loadAssignments();
      }, 400);
    };

    const handleStatusChange = (data: any) => {
      reloadSoon();
      scheduleLocalNotification(
        'Assignment Update',
        `An assignment status has been updated to ${data?.status || 'NEW'}`,
        data,
      );
    };

    const handleNewAssignment = (data: any) => {
      reloadSoon();
      scheduleLocalNotification(
        'New assignment offered',
        data?.branchName ? `${data.branchName} — open the app to accept or decline.` : 'Open the app to accept or decline.',
        data,
      );
    };

    /**
     * Quiet reloads. These change what the screen should show but do not warrant interrupting
     * someone mid-audit with a banner — the desk's own notification covers anything that
     * genuinely needs attention. The list, and why each name is (or is not) on it, lives in
     * `assignment-live-events.ts`, where the node tests can hold it to what the server emits.
     */
    const QUIET_EVENTS = QUIET_RELOAD_EVENTS;

    /** A job taken away (or cancelled, reopened) arrives as a notification: reload for it too. */
    const handleNotification = (payload: unknown) => {
      if (notificationMovesJobs(payload)) reloadSoon();
    };

    socket.on('assignment:status-changed', handleStatusChange);
    socket.on('assignment:created', handleNewAssignment);
    socket.on('notification:new', handleNotification);
    QUIET_EVENTS.forEach((e) => socket.on(e, reloadSoon));

    /**
     * A dropped connection is the case that silently breaks live updates: the socket comes
     * back, but everything that happened while it was down was never delivered, so the screen
     * stays wrong until something else triggers a fetch.
     *
     * Hooked to `connect` rather than `reconnect` deliberately — in socket.io-client v4
     * reconnection events live on the manager (`socket.io.on('reconnect')`), so a
     * `socket.on('reconnect')` handler is never called at all. `connect` fires on every
     * successful (re)connection, which is exactly the moment a refetch is needed.
     */
    socket.on('connect', reloadSoon);
    // The same moment is when queued position fixes can finally be delivered. The trail is
    // what a travel claim is checked against, and the fixes worth most are the ones taken
    // where there was no signal to send them.
    socket.on('connect', flushLocationQueueOnReconnect);

    return () => {
      if (timer) clearTimeout(timer);
      socket.off('assignment:status-changed', handleStatusChange);
      socket.off('assignment:created', handleNewAssignment);
      socket.off('notification:new', handleNotification);
      QUIET_EVENTS.forEach((e) => socket.off(e, reloadSoon));
      socket.off('connect', reloadSoon);
      socket.off('connect', flushLocationQueueOnReconnect);
    };
  }, [isAuthenticated, loadAssignments]);

  /**
   * These three all go through the action queue (`services/action-queue.ts`): the request is
   * written to disk before it is attempted, so an app killed mid-request — a dropped handover in
   * a strongroom, the OS reclaiming memory — does not silently lose an accept, a decline or
   * an expense claim the assayer believes they already filed. `enqueueAndRun` attempts it once
   * immediately so the screen still gets an answer straight away; a transport/timeout failure is
   * left queued for `processActionQueue` to retry on the next foreground return or reconnect
   * (wired below), while a validation 4xx is surfaced once and dropped — retrying a refused
   * request would only fail the same way again.
   */
  /**
   * A queued result (no signal; the action is on disk and will send itself) is reported as a
   * success with `queued: true`. It used to come back as `success: false` with a "will retry"
   * message, so the form stayed open looking failed, and pressing again filed a second copy.
   *
   * Duplicates are also refused at the queue: an accept or decline for an offer that already has
   * one waiting reuses that entry (`sameAs`), and a claim carries the key its form was opened
   * with, which the server also honours as `clientRequestId`.
   */
  const updateAssignmentStatus = async (
    assignmentId: string,
    status: AssayerAssignment['status'],
    notes?: string,
  ): Promise<SubmitOutcome> => {
    const payload: AssignmentStatusPayload = { op: 'transition', assignmentId, status, notes };
    const result = await enqueueAndRun('ASSIGNMENT_STATUS', payload as AssignmentStatusPayload | RejectPayload, actionDispatchers.ASSIGNMENT_STATUS, {
      sameAs: (a: QueuedAction<AssignmentStatusPayload | RejectPayload>) =>
        a.payload.op === 'transition' && a.payload.assignmentId === assignmentId && a.payload.status === status,
    });
    if (result.success) await loadAssignments();
    return toSubmitOutcome(result);
  };

  const rejectAssignment = async (assignmentId: string, reason: string, requestKey?: string): Promise<SubmitOutcome> => {
    const payload: RejectPayload = { op: 'reject', assignmentId, reason };
    const result = await enqueueAndRun('ASSIGNMENT_STATUS', payload as AssignmentStatusPayload | RejectPayload, actionDispatchers.ASSIGNMENT_STATUS, {
      clientRequestId: requestKey,
      sameAs: (a: QueuedAction<AssignmentStatusPayload | RejectPayload>) =>
        a.payload.op === 'reject' && a.payload.assignmentId === assignmentId,
    });
    if (result.success) await loadAssignments();
    return toSubmitOutcome(result, 'Failed to reject assignment');
  };

  const submitExpense = async (
    assignmentId: string,
    expense: { category: 'TRAVEL_KM' | 'TOLL' | 'FOOD' | 'OTHER'; amount: number; description?: string },
    requestKey?: string,
  ): Promise<SubmitOutcome> => {
    const result = await enqueueAndRun('EXPENSE_CLAIM', { assignmentId, expense }, actionDispatchers.EXPENSE_CLAIM, {
      clientRequestId: requestKey,
    });
    if (result.success) await loadAssignments();
    return toSubmitOutcome(result, 'Failed to submit expense');
  };

  /**
   * Drain queued actions on mount, on the app coming back to the foreground, and whenever the
   * connection is re-established — the moments a phone that lost signal mid-branch is most
   * likely to have it back. Mirrors `flushLocationQueueOnReconnect` immediately below it, and
   * covers every action kind (check-in/out included, even though those are queued from `App.tsx`
   * rather than here) because the queue itself is one shared, module-level store.
   */
  const drainActionQueue = useCallback(() => {
    void processActionQueue(actionDispatchers)
      .then((report) => {
        // Each refusal is said once, out loud: the assayer was told this was saved and would
        // send by itself, so a silent refusal would leave them believing it went through. The
        // entry itself stays on the queue (the banner reads it) until they dismiss it.
        for (const entry of report.refused) {
          const notice = refusalNotice(entry);
          void scheduleLocalNotification(notice.title, notice.reason, { type: 'ACTION_REFUSED', kind: entry.kind }, 'HIGH')
            .catch(() => undefined);
        }
      })
      .catch(() => undefined)
      // Reloaded after every drain — and so after any refusal — so the screen shows what the
      // server now holds (a refused check-in's job still waiting, a job that moved away).
      .then(() => loadAssignments().catch(() => {}));
  }, [loadAssignments]);

  /** The refused actions, kept current as the queue changes (a drain, a dismissal, sign-out). */
  const [refusedActions, setRefusedActions] = useState<QueuedAction[]>([]);
  useEffect(() => {
    if (!isAuthenticated) {
      setRefusedActions([]);
      return;
    }
    let live = true;
    const read = () => {
      void getRefusedActions().then((list) => { if (live) setRefusedActions(list); }).catch(() => undefined);
    };
    read();
    const unsubscribe = subscribeActionQueue(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [isAuthenticated, user?.id]);

  const dismissRefusedAction = useCallback(async (id: string) => {
    await dismissAction(id);
  }, []);

  /**
   * Drain on mount (an app start finds whatever survived the last kill), on the app returning to
   * the foreground, and on the socket's own `connect` — the moment queued position fixes are also
   * flushed, for the same reason: a dropped connection is exactly when these actions were left
   * behind, and the assayer should not have to remember to retry them by hand.
   */
  useEffect(() => {
    if (!isAuthenticated) return;
    drainActionQueue();
    const socket = connectMobileSocket();
    socket?.on('connect', drainActionQueue);
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') drainActionQueue();
    });
    return () => {
      socket?.off('connect', drainActionQueue);
      sub.remove();
    };
  }, [isAuthenticated, drainActionQueue]);

  return (
    <AssignmentContext.Provider
      value={{
        assignments,
        loading,
        activeAssignment,
        setActiveAssignment,
        loadAssignments,
        stale,
        lastSyncedAt,
        updateAssignmentStatus,
        rejectAssignment,
        submitExpense,
        refusedActions,
        dismissRefusedAction,
      }}
    >
      {children}
    </AssignmentContext.Provider>
  );
};

export const useAssignments = (): AssignmentContextType => {
  const context = useContext(AssignmentContext);
  if (!context) {
    throw new Error('useAssignments must be used within an AssignmentProvider');
  }
  return context;
};
