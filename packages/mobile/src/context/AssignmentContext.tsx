import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { MobileApiService } from '../services/api.service';
import { flushQueue } from '../services/location-queue';
import { enqueueAndRun, processActionQueue } from '../services/action-queue';
import { actionDispatchers } from '../services/action-dispatchers';
import { connectMobileSocket } from '../services/socket';
import { scheduleLocalNotification } from '../services/notification.service';
import { useAuth } from './AuthContext';
import { readCache, writeCache } from '../services/token-store';
import { t } from '../i18n/i18n';

interface AssignmentContextType {
  assignments: AssayerAssignment[];
  loading: boolean;
  activeAssignment: AssayerAssignment | null;
  setActiveAssignment: (assignment: AssayerAssignment | null) => void;
  loadAssignments: () => Promise<void>;
  /** The list on screen came from cache because the last refresh failed. */
  stale: boolean;
  lastSyncedAt: string | null;
  updateAssignmentStatus: (
    assignmentId: string,
    status: AssayerAssignment['status'],
    notes?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  rejectAssignment: (assignmentId: string, reason: string) => Promise<{ success: boolean; error?: string }>;
  submitExpense: (
    assignmentId: string,
    expense: { category: 'TRAVEL_KM' | 'TOLL' | 'FOOD' | 'OTHER'; amount: number; description?: string }
  ) => Promise<{ success: boolean; error?: string }>;
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
    try {
      const items = onlyActive(await MobileApiService.getAssayerAssignments(user?.id));
      setAssignments(items);
      setStale(false);
      setLastSyncedAt(new Date().toISOString());
      void writeCache(CACHE_KEY, { items, at: new Date().toISOString() });
    } catch (e) {
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
    if (!isAuthenticated) return;
    let cancelled = false;
    readCache<{ items: AssayerAssignment[]; at: string }>(CACHE_KEY).then((cached) => {
      if (cancelled || !cached?.items?.length) return;
      setAssignments((current) => (current.length > 0 ? current : onlyActive(cached.items)));
      setLastSyncedAt(cached.at);
    });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

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
     * genuinely needs attention.
     *
     * Deliberately NOT here any more: `assignment:counter-offered` (fee negotiation was removed
     * from the app — the event no longer exists), `assignment:fee-updated` (the gateway stopped
     * emitting it to assayer sockets when the app went money-blind; a fee edit at the desk is
     * ops-internal now), and `billing:created` (never emitted by the gateway at all — the real
     * billing events, `billing:payout-changed` and `billing:assayer-invoice-changed`, move the
     * statement and the invoice invitation, which App.tsx owns and reloads, not this list).
     */
    const QUIET_EVENTS = [
      'query:raised',
      'query:responded',
      'query:resolved',
      'document:dispatched',
      'document:received',
      'document:uploaded',
      'document:status-changed',
    ];

    socket.on('assignment:status-changed', handleStatusChange);
    socket.on('assignment:created', handleNewAssignment);
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
  const updateAssignmentStatus = async (
    assignmentId: string,
    status: AssayerAssignment['status'],
    notes?: string,
  ) => {
    const payload = { op: 'transition' as const, assignmentId, status, notes };
    const result = await enqueueAndRun('ASSIGNMENT_STATUS', payload, actionDispatchers.ASSIGNMENT_STATUS);
    if (result.success) await loadAssignments();
    if (result.queued) return { success: false, error: t('common.willRetry') };
    return { success: result.success, error: result.error };
  };

  const rejectAssignment = async (assignmentId: string, reason: string) => {
    const result = await enqueueAndRun(
      'ASSIGNMENT_STATUS',
      { op: 'reject' as const, assignmentId, reason },
      actionDispatchers.ASSIGNMENT_STATUS,
    );
    if (result.success) await loadAssignments();
    if (result.queued) return { success: false, error: t('common.willRetry') };
    return { success: result.success, error: result.error || 'Failed to reject assignment' };
  };

  const submitExpense = async (
    assignmentId: string,
    expense: { category: 'TRAVEL_KM' | 'TOLL' | 'FOOD' | 'OTHER'; amount: number; description?: string }
  ) => {
    const result = await enqueueAndRun('EXPENSE_CLAIM', { assignmentId, expense }, actionDispatchers.EXPENSE_CLAIM);
    if (result.success) await loadAssignments();
    if (result.queued) return { success: false, error: t('common.willRetry') };
    return { success: result.success, error: result.error || 'Failed to submit expense' };
  };

  /**
   * Drain queued actions on mount, on the app coming back to the foreground, and whenever the
   * connection is re-established — the moments a phone that lost signal mid-branch is most
   * likely to have it back. Mirrors `flushLocationQueueOnReconnect` immediately below it, and
   * covers every action kind (check-in/out included, even though those are queued from `App.tsx`
   * rather than here) because the queue itself is one shared, module-level store.
   */
  const drainActionQueue = useCallback(() => {
    void processActionQueue(actionDispatchers).then(() => loadAssignments().catch(() => {}));
  }, [loadAssignments]);

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
