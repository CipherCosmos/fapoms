import { useCallback, useEffect, useRef, useState } from 'react';
import { MobileApiService } from '../services/api.service';
import {
  registerForPushNotificationsAsync,
  setupNotificationListeners,
  getLastNotificationResponseAsync,
  triggerAlertNotification,
} from '../services/notification.service';
import type { AppNotification } from '../types/mobile-app';

/**
 * How long after delivery a notification tap may still be treated as the thing that launched
 * the app. See the cold-start guard below for why any window is needed at all.
 */
const DEEP_LINK_MAX_AGE_MS = 10 * 60 * 1000;

/** The `data` payload FCM carries, identical in all three delivery states. */
export interface NotificationTapData {
  notificationId?: string;
  entityId?: string;
  link?: string;
  category?: string;
}

export interface AssayerNotifications {
  notifications: AppNotification[];
  unreadCount: number;
  /** Re-read the list from the server. Safe to call as often as something changes. */
  load: () => Promise<void>;
  /** Mark one read, optimistically. */
  markRead: (id: string) => void;
}

/**
 * Everything between "the server has something to tell this assayer" and "it is on their screen".
 *
 * Delivery is the part with the sharp edges, and all of it lived loose in App.tsx: two refs, two
 * pieces of state, a fetch, a tray-alert rule, a push-listener effect, a cold-start replay guard,
 * and — inside the notifications modal's JSX — a twenty-line optimistic read-marking routine with
 * its own rollback. None of it was reachable from anywhere else and none of it read as one thing.
 *
 * Routing is deliberately not here. Where a tapped notification should take the assayer depends on
 * the tab shell and on which assignments have loaded, both of which belong to the screen; the
 * caller passes `onTap` and decides that for itself.
 */
export function useAssayerNotifications(options: {
  isAuthenticated: boolean;
  onTap: (data: NotificationTapData) => void;
}): AssayerNotifications {
  const { isAuthenticated, onTap } = options;

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const seenIdsRef = useRef<Set<string>>(new Set());
  /** False until the opening poll has recorded the existing backlog. */
  const hasPolledRef = useRef(false);

  /**
   * `onTap` is held in a ref so the listener effect below does not tear down and re-subscribe
   * every time the caller re-renders with a fresh closure. Re-subscribing is not merely wasteful
   * here: between the unsubscribe and the next subscribe there is a window with no listener at
   * all, and a notification tapped in that window is simply lost.
   */
  const onTapRef = useRef(onTap);
  useEffect(() => {
    onTapRef.current = onTap;
  }, [onTap]);

  const load = useCallback(async () => {
    try {
      const items = await MobileApiService.getNotifications();
      setNotifications(items);
      setUnreadCount(items.filter((n) => !n.isRead).length);

      /**
       * The first poll of a session only records what is already there.
       *
       * `seenIdsRef` starts empty on every launch, so without this the opening poll treats the
       * entire unread backlog as "just arrived" and fires an alert for each — open the app with
       * twenty unread and twenty notifications land at once, for things already visible on
       * screen. Only genuinely new arrivals, seen while the app is running, are worth
       * interrupting for.
       */
      const isFirstLoad = !hasPolledRef.current;
      hasPolledRef.current = true;

      items.forEach((n) => {
        if (n.isRead || seenIdsRef.current.has(n.id)) return;
        seenIdsRef.current.add(n.id);
        if (isFirstLoad) return;
        triggerAlertNotification(
          n.title,
          n.message || 'New audit alert received',
          { notificationId: n.id, assignmentId: n.assignmentId, link: n.link },
          // Picks the Android channel, so a polled notification is presented exactly as loudly
          // as the same notification would have been had it arrived as a push.
          (n as any).priority,
          // Chime only: polling runs only while the app is foregrounded, and the server has
          // already put this same notification in the tray via push.
          false,
        );
      });
    } catch (e) {
      console.error('Error loading notifications:', e);
    }
  }, []);

  /**
   * Marked read locally first so the list responds immediately, then reverted if the server
   * disagrees. The result used to be discarded entirely — behind a `.then` that did nothing — so
   * a failed call left the row looking read until the next reload quietly brought it back.
   */
  const markRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));

    const revert = () => {
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: false } : n)));
      setUnreadCount((c) => c + 1);
    };

    MobileApiService.markNotificationRead(id)
      .then((ok) => {
        if (!ok) revert();
      })
      .catch(revert);
  }, []);

  /**
   * Push reliability across app state: registration, plus listeners for what happens afterwards.
   *
   * Registration alone was never enough — a token was registered and then nothing listened for
   * what became of a notification, not a tap, not even one arriving while the screen was open.
   * `setupNotificationListeners` covers foreground and background; `getLastNotificationResponse`
   * covers the case listeners cannot, launching fresh from a fully terminated state via a tap.
   */
  useEffect(() => {
    if (!isAuthenticated) return;

    registerForPushNotificationsAsync();
    void load();

    getLastNotificationResponseAsync().then((response) => {
      const data = response?.notification?.request?.content?.data;
      if (!data) return;

      /**
       * This call returns the last tapped notification *forever*, not only when that tap is what
       * launched the app. Every cold start replayed the same old tap, so the app always opened on
       * the schedule of whichever assignment was last notified about — the chosen landing tab was
       * silently overridden on launch, every launch.
       *
       * A tap that genuinely launched this session belongs to a recently-delivered notification,
       * so anything older than the window is treated as already handled. Erring toward ignoring is
       * the safe side: the notification list is still one tap away, whereas a wrong redirect
       * hijacks the whole app on every launch.
       */
      const deliveredAt = response?.notification?.date;
      const ageMs = typeof deliveredAt === 'number' ? Date.now() - deliveredAt : Infinity;
      if (ageMs > DEEP_LINK_MAX_AGE_MS) return;

      onTapRef.current(data);
    });

    return setupNotificationListeners(
      () => {
        // Received while the app is open — the OS banner is already configured to show (see
        // notification.service.ts's handler), so this only needs to keep the in-app unread count
        // and list from lagging behind it.
        void load();
      },
      (response: any) => onTapRef.current(response?.notification?.request?.content?.data),
    );
  }, [isAuthenticated, load]);

  return { notifications, unreadCount, load, markRead };
}
