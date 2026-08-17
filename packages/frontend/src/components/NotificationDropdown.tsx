import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Bell, CheckCheck, FileText, CheckCircle2, Calendar, Users, DollarSign, Info, MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, WebNotification, NotificationCategory } from '../services/api';
import { useToast } from './ui';
import { connectSocket } from '../services/socket';

const CATEGORY_META: Record<NotificationCategory, { icon: React.ElementType; tone: string }> = {
  [NotificationCategory.ASSIGNMENT]: { icon: Calendar, tone: 'var(--accent)' },
  [NotificationCategory.VALIDATION]: { icon: CheckCircle2, tone: 'var(--success)' },
  [NotificationCategory.DOCUMENT]: { icon: FileText, tone: 'var(--accent)' },
  [NotificationCategory.PLANNING]: { icon: Calendar, tone: 'var(--warning)' },
  [NotificationCategory.WORKFORCE]: { icon: Users, tone: 'var(--accent)' },
  [NotificationCategory.BILLING]: { icon: DollarSign, tone: 'var(--success)' },
  [NotificationCategory.SYSTEM]: { icon: Info, tone: 'var(--text-secondary)' },
  [NotificationCategory.FEEDBACK]: { icon: MessageSquare, tone: 'var(--accent)' },
};

function categoryIcon(category?: NotificationCategory) {
  const meta = category ? CATEGORY_META[category] : undefined;
  if (!meta) return { Icon: Bell, tone: 'var(--accent)' };
  return { Icon: meta.icon, tone: meta.tone };
}

/**
 * One AudioContext for the whole tab, created on the first chime and never replaced.
 *
 * A `new AudioContext()` per chime reads as harmless and is not. Chrome caps a page at roughly
 * six live contexts and nothing here ever closed one, so a handful of notifications into a
 * session the constructor throws and the bell goes silent permanently — the "chime works in the
 * morning, stops by the afternoon" report. Every context built before that point is a leaked
 * audio thread that keeps running.
 *
 * Module-level rather than per-component on purpose, and deliberately never closed:
 * `AudioContext.close()` is terminal, so closing on unmount would kill the chime for the rest of
 * the tab's life the first time this component remounts — which React StrictMode makes happen on
 * every dev mount, and a route-level remount could make happen in production. One idle context
 * costs a suspended audio thread; the tab reclaims it on unload.
 */
let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (sharedAudioCtx) return sharedAudioCtx;
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx) return null;
  sharedAudioCtx = new AudioCtx();
  return sharedAudioCtx;
}

/**
 * Two chimes closer together than this are one chime. The tone rings for half a second, so a
 * cluster of notifications arriving within a few hundred milliseconds of each other would layer
 * their oscillators onto the same destination — three at once is not three notifications, it is
 * one loud dissonant blare at triple gain.
 */
const MIN_CHIME_GAP_MS = 2_000;
let lastChimeAt = 0;

function playWebNotificationSound() {
  try {
    const now = Date.now();
    if (now - lastChimeAt < MIN_CHIME_GAP_MS) return;

    const ctx = getAudioContext();
    if (!ctx) return;
    lastChimeAt = now;

    /**
     * A context constructed before the user has clicked anything starts `suspended`, and
     * scheduling on a suspended context is silent with no error thrown — which is exactly how a
     * page-load-time context ends up looking broken. `resume()` is a no-op once running, so
     * calling it every time is cheap; the rejection is swallowed because a browser that still
     * refuses (no gesture yet) should cost a missed chime, not an unhandled rejection.
     */
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';

    osc1.frequency.setValueAtTime(784, ctx.currentTime);
    osc1.frequency.exponentialRampToValueAtTime(1046.5, ctx.currentTime + 0.15);

    osc2.frequency.setValueAtTime(392, ctx.currentTime);
    osc2.frequency.exponentialRampToValueAtTime(523.25, ctx.currentTime + 0.15);

    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(ctx.currentTime);
    osc2.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 0.5);
    osc2.stop(ctx.currentTime + 0.5);

    /**
     * Nodes are single-use, and a finished oscillator still holds its graph edges. Disconnecting
     * on `ended` is what lets the shared context stay shared: without it every chime of a
     * day-long desk session accumulates dead nodes hanging off `destination`.
     */
    osc1.onended = () => {
      osc1.disconnect();
      osc2.disconnect();
      gain.disconnect();
    };
  } catch (e) {
    console.log('Web audio chime error:', e);
  }
}

/**
 * Notification ids already announced, oldest first.
 *
 * The same `notification:new` can genuinely arrive twice: socket.io replays the packets missed
 * during a short drop when `connectionStateRecovery` kicks in, the gateway emits to both the
 * `user:` room and the assayer room (the same room for an assayer login), and StrictMode's
 * double-invoked effect briefly leaves two handlers bound. None of those are a second message to
 * the reader, so none of them should chime, toast or raise a second OS notification.
 *
 * Capped rather than unbounded because this lives for the lifetime of the tab: an id that has
 * fallen off the end is hundreds of notifications old and can no longer be a replay of anything.
 */
const ANNOUNCED_LIMIT = 200;
const announcedOrder: string[] = [];
const announcedIds = new Set<string>();

function isFirstSighting(id: unknown): boolean {
  // No id to key on — announce it. Swallowing a real notification is a worse failure than
  // occasionally chiming twice for a payload the backend forgot to stamp.
  if (typeof id !== 'string' || !id) return true;
  if (announcedIds.has(id)) return false;

  announcedIds.add(id);
  announcedOrder.push(id);
  if (announcedOrder.length > ANNOUNCED_LIMIT) {
    const evicted = announcedOrder.shift();
    if (evicted) announcedIds.delete(evicted);
  }
  return true;
}

export const NotificationDropdown: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<WebNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { toast } = useToast();

  /**
   * The panel's open state, readable from a handler that is bound once.
   *
   * The socket subscription below has to live for the lifetime of the component, but its handler
   * needs to know whether the panel is open *right now* to decide between refreshing the badge
   * and refetching the visible page. Reading `open` out of the closure would freeze it at its
   * mount-time `false` forever — the stale-closure bug that the old `[open]` dependency array was
   * papering over, at the cost of tearing down and re-binding four socket listeners and
   * restarting the 30s poll every time anyone clicked the bell.
   */
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);

  const refreshCount = async () => setUnreadCount(await api.getUnreadNotificationCount());

  const fetchPage = async () => {
    setLoading(true);
    try {
      const page = await api.getNotificationPage({ limit: 12 });
      setNotifications(page.items);
      setUnreadCount(page.unreadCount);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshCount();

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    const socket = connectSocket();

    /**
     * `notification:new` is the only event that interrupts the reader.
     *
     * The gateway routes it to `user:${recipient}` alone, so receiving one means a message was
     * addressed to this person — the one case that has earned a chime, a toast and an OS
     * notification. This handler used to be bound to `assignment:counter-offered`,
     * `assignment:status-changed` and `assignment:created` as well, and all three are org-wide
     * broadcasts: every desk in the company chimed, toasted, raised a native notification and
     * fired a `/notifications/unread-count` request for every assignment anybody touched
     * anywhere. A 500-row bulk import meant 500 chimes and 500 unread-count requests *per open
     * tab*, and the toasts buried the one notification that was actually addressed to the reader.
     *
     * Those three events are not debounced down to a quiet badge nudge here, they are dropped
     * entirely, because neither job they were doing belongs to this component:
     *   - cache freshness is already `useSocketInvalidation`'s, which is mounted in Layout and
     *     subscribes to all three (plus twenty more) with its own 300ms coalescing window;
     *   - the badge only moves when a notification row is created for *this* user, and every one
     *     of those publishes `notification:new` to this socket. An org-wide assignment broadcast
     *     carries no information about this desk's unread count, so re-counting on it was work
     *     with no possible new answer.
     * A row created while the publish failed is what the poll below exists for.
     */
    const handleNotification = (data: any) => {
      if (!isFirstSighting(data?.id)) return;

      refreshCount();
      if (openRef.current) fetchPage();

      playWebNotificationSound();

      const title = data?.title || data?.type?.replace(/_/g, ' ') || 'Notification Alert';
      const msg = data?.message || data?.body || (data?.branchName ? `Branch update: ${data.branchName}` : 'New real-time update received');

      toast({
        type: 'info',
        message: `${title}: ${msg}`,
      });

      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification(title, {
            body: msg,
            icon: '/favicon.ico',
          });
        } catch (e) {}
      }
    };

    if (socket) {
      socket.on('notification:new', handleNotification);
    }

    /**
     * A safety net, not the delivery mechanism.
     *
     * Real-time freshness comes from the subscription above, so this only has to recover a
     * dropped or missed event and 30s is plenty — at 10s it was ~3x the unread-count query load
     * across every signed-in user for no real benefit.
     *
     * It skips entirely while the tab is hidden. A backgrounded desk tab left open overnight was
     * otherwise still asking the server for a count nobody was looking at, 2,880 times, and there
     * are a lot of those tabs. Coming back to a stale badge would be the obvious way to get that
     * wrong, so returning to the tab refreshes immediately rather than waiting out the interval.
     */
    const interval = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      refreshCount();
    }, 30_000);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refreshCount();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (socket) {
        socket.off('notification:new', handleNotification);
      }
    };
    // Bound once, deliberately. `open` is read through `openRef` (see above); `refreshCount`,
    // `fetchPage` and `toast` are safe to capture from the first render — the first two close
    // over nothing but the module-level `api` and React's stable state setters, and `toast` is a
    // `useCallback([])` on a memoised context value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (open) fetchPage();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        ref.current &&
        panelRef.current &&
        !ref.current.contains(target) &&
        !panelRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const rect = ref.current?.getBoundingClientRect();

  const getCategoryFallback = (category?: NotificationCategory): string => {
    switch (category) {
      case 'ASSIGNMENT':
        return '/assignments';
      case 'VALIDATION':
        return '/data-entry';
      case 'DOCUMENT':
        return '/documents';
      case 'PLANNING':
        return '/planning';
      case 'FEEDBACK':
        // Without this a feedback notification landed on /notifications instead of the thread
        // it is about — the one place the reader can actually answer it.
        return '/feedback';
      case 'WORKFORCE':
        return '/hr';
      case 'BILLING':
        return '/billing';
      default:
        return '/notifications';
    }
  };

  const handleOpen = async (n: WebNotification) => {
    if (!n.isRead) {
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
      setUnreadCount((c) => Math.max(0, c - 1));
      api.markNotificationRead(n.id).catch(() => {});
    }
    setOpen(false);

    let targetPath = n.link;
    if (targetPath === '/validation') targetPath = '/data-entry';
    if (targetPath === '/workforce') targetPath = '/hr';

    if (targetPath && targetPath !== '/dashboard') {
      navigate(targetPath);
    } else {
      navigate(getCategoryFallback(n.category));
    }
  };

  const handleMarkAllRead = async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
    await api.markAllNotificationsRead().catch(() => {});
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        style={{
          background: open ? 'var(--bg-tertiary)' : 'var(--bg-primary)',
          border: '1px solid var(--border-color)',
          color: unreadCount > 0 ? 'var(--accent-primary)' : 'var(--text-secondary)',
          cursor: 'pointer',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '36px',
          height: '36px',
          borderRadius: 'var(--radius-full)',
          transition: 'all var(--transition-fast)',
          boxShadow: unreadCount > 0 ? '0 0 12px rgba(216, 174, 71, 0.2)' : 'none',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = open ? 'var(--bg-tertiary)' : 'var(--bg-primary)')}
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <span
            style={{
              position: 'absolute',
              top: '-2px',
              right: '-2px',
              minWidth: '18px',
              height: '18px',
              backgroundColor: '#ef4444',
              borderRadius: '9px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 4px',
              fontSize: '10px',
              fontWeight: 800,
              color: '#FFFFFF',
              border: '2px solid var(--bg-secondary)',
              boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
            }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && rect &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: 'fixed',
              top: Math.min(rect.bottom + 10, window.innerHeight - 540),
              left: Math.max(16, rect.right - 400),
              width: '400px',
              maxHeight: '540px',
              backgroundColor: 'var(--bg-surface-2)',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-lg), 0 24px 50px rgba(0,0,0,0.4)',
              overflow: 'hidden',
              zIndex: 999999,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                padding: '14px 18px',
                borderBottom: '1px solid var(--border-color)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: 'var(--bg-surface-2)',
              }}
            >
              <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)' }}>
                Notifications
              </span>
              {unreadCount > 0 && (
                <button
                  onClick={handleMarkAllRead}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent-primary)',
                    cursor: 'pointer',
                    fontSize: '11.5px',
                    fontWeight: 600,
                    padding: '2px 4px',
                  }}
                >
                  <CheckCheck size={13} /> Mark all read
                </button>
              )}
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {loading && notifications.length === 0 ? (
                <div
                  style={{
                    padding: '30px 16px',
                    textAlign: 'center',
                    color: 'var(--text-muted)',
                    fontSize: '12px',
                  }}
                >
                  Loading notifications…
                </div>
              ) : notifications.length === 0 ? (
                <div
                  style={{
                    padding: '40px 20px',
                    textAlign: 'center',
                    color: 'var(--text-muted)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  <Bell size={28} style={{ opacity: 0.4 }} />
                  <span style={{ fontSize: '13px', fontWeight: 600 }}>All caught up!</span>
                  <span style={{ fontSize: '11px' }}>No unread notifications to show.</span>
                </div>
              ) : (
                notifications.map((n) => {
                  const { Icon, tone } = categoryIcon(n.category);
                  return (
                    <div
                      key={n.id}
                      onClick={() => handleOpen(n)}
                      style={{
                        padding: '12px 16px',
                        borderBottom: '1px solid var(--border-hair)',
                        cursor: 'pointer',
                        display: 'flex',
                        gap: '12px',
                        backgroundColor: n.isRead ? 'transparent' : 'rgba(216,174,71,0.08)',
                        transition: 'background var(--transition-fast)',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)')}
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.backgroundColor = n.isRead ? 'transparent' : 'rgba(216,174,71,0.08)')
                      }
                    >
                      <div
                        style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '8px',
                          backgroundColor: 'var(--bg-surface-2)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <Icon size={16} color={tone} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: '12.5px',
                            fontWeight: n.isRead ? 600 : 700,
                            color: 'var(--text-primary)',
                            marginBottom: '2px',
                          }}
                        >
                          {n.title}
                        </div>
                        <div
                          style={{
                            fontSize: '11.5px',
                            color: 'var(--text-secondary)',
                            lineHeight: '1.4',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {n.message}
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                          {new Date(n.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/**
              * The way into the personal notification centre.
              *
              * It had none: the sidebar's notification entry goes to the org-wide rules page,
              * which most roles cannot open and which cannot change anyone's own preferences
              * anyway. Somebody trying to stop a category of email had nowhere to click.
              */}
            <div style={{ borderTop: '1px solid var(--border-color)', padding: '9px 14px', display: 'flex', gap: '14px', alignItems: 'center' }}>
              <button
                onClick={() => { setOpen(false); navigate('/notifications'); }}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '11.5px', fontWeight: 700, color: 'var(--accent)' }}
              >
                View all
              </button>
              <button
                onClick={() => { setOpen(false); navigate('/notifications?tab=preferences'); }}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '11.5px', color: 'var(--text-muted)', marginLeft: 'auto' }}
              >
                Choose what reaches me
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
