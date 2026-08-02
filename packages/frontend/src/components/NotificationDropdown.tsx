import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, ExternalLink, Wrench, ShieldCheck, FileText, MapPinned, Users, Wallet, Settings2 } from 'lucide-react';
import { api, WebNotification, NotificationCategory } from '../services/api';
import { connectSocket } from '../services/socket';

/**
 * The bell.
 *
 * Two things were actually broken here, not just unpolished: clicking a
 * notification did nothing but mark it read — the `link` every notification
 * carries was never used, so "tap the alert, land on the record" simply did
 * not exist. And the badge count required pulling the last 50 notifications on
 * a 30s timer just to count the unread ones. Both are fixed by treating count
 * and content as separate concerns: `unread-count` is cheap enough to poll on
 * its own, and opening the panel is what actually fetches the list.
 */

const CATEGORY_META: Record<NotificationCategory, { icon: React.ElementType; tone: string }> = {
  ASSIGNMENT: { icon: Wrench, tone: 'var(--accent)' },
  VALIDATION: { icon: ShieldCheck, tone: 'var(--success)' },
  DOCUMENT: { icon: FileText, tone: 'var(--text-secondary)' },
  PLANNING: { icon: MapPinned, tone: 'var(--warning)' },
  WORKFORCE: { icon: Users, tone: 'var(--accent)' },
  BILLING: { icon: Wallet, tone: 'var(--success)' },
  SYSTEM: { icon: Settings2, tone: 'var(--text-muted)' },
};

const formatTime = (iso: string) => {
  const d = new Date(iso);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};

export const NotificationDropdown: React.FC = () => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<WebNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const refreshCount = async () => setUnreadCount(await api.getUnreadNotificationCount());

  const loadList = async () => {
    setLoading(true);
    try {
      const page = await api.getNotificationPage({ limit: 8 });
      setNotifications(page.items);
      setUnreadCount(page.unreadCount);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshCount();
    const interval = setInterval(refreshCount, 30000);
    const socket = connectSocket();
    const handler = () => {
      // A push of full payload shape isn't guaranteed across every emitter,
      // so re-deriving from the server keeps the badge and list honest rather
      // than trusting whatever partial event arrived.
      refreshCount();
      if (open) loadList();
    };
    if (socket?.connected) {
      socket.on('notification:new', handler);
    } else {
      const checkConnect = setInterval(() => {
        const s = connectSocket();
        if (s?.connected) {
          s.on('notification:new', handler);
          clearInterval(checkConnect);
        }
      }, 500);
      setTimeout(() => clearInterval(checkConnect), 10000);
    }
    return () => {
      clearInterval(interval);
      const s = connectSocket();
      s?.off('notification:new', handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (open) loadList();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const handleOpen = async (n: WebNotification) => {
    if (!n.isRead) {
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
      setUnreadCount((prev) => Math.max(0, prev - 1));
      api.markNotificationRead(n.id).catch(() => {});
    }
    setOpen(false);
    // The one thing this control never actually did: take you to the record
    // the alert is about.
    if (n.link) navigate(n.link);
  };

  const handleMarkAllRead = async (e: React.MouseEvent) => {
    e.stopPropagation();
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
          background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer',
          position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '6px', borderRadius: 'var(--radius-sm)', transition: 'background var(--transition-fast)',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span
            style={{
              position: 'absolute', top: '2px', right: '2px', minWidth: '16px', height: '16px',
              backgroundColor: 'var(--danger)', borderRadius: '8px', display: 'flex', alignItems: 'center',
              justifyContent: 'center', padding: '0 4px', fontSize: '9px', fontWeight: 800,
              color: 'var(--text-primary)', border: '2px solid var(--bg-secondary)',
            }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: '380px', maxHeight: '520px',
            backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
            zIndex: 1000, display: 'flex', flexDirection: 'column',
          }}
        >
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)' }}>Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                style={{
                  display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none',
                  color: 'var(--accent-primary)', cursor: 'pointer', fontSize: '11.5px', fontWeight: 600, padding: '2px 4px',
                }}
              >
                <CheckCheck size={13} /> Mark all read
              </button>
            )}
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loading && notifications.length === 0 ? (
              <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
            ) : notifications.length === 0 ? (
              <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                <Bell size={22} style={{ opacity: 0.35, marginBottom: '8px' }} />
                <div>No notifications yet</div>
              </div>
            ) : (
              notifications.map((n) => {
                const meta = n.category ? CATEGORY_META[n.category] : undefined;
                const Icon = meta?.icon ?? Bell;
                return (
                  <div
                    key={n.id}
                    onClick={() => handleOpen(n)}
                    style={{
                      padding: '12px 18px', borderBottom: '1px solid var(--border-color)', cursor: 'pointer',
                      display: 'flex', gap: '10px', alignItems: 'flex-start',
                      backgroundColor: !n.isRead ? 'var(--status-pending-bg)' : 'transparent',
                      transition: 'background var(--transition-fast)',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-glass-hover)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = !n.isRead ? 'var(--status-pending-bg)' : 'transparent')}
                  >
                    <span style={{ color: meta?.tone ?? 'var(--text-muted)', marginTop: '2px', flexShrink: 0 }}>
                      <Icon size={15} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '13px', fontWeight: !n.isRead ? 700 : 500, color: !n.isRead ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                          {n.title}
                        </span>
                        {(n.priority === 'CRITICAL' || n.priority === 'HIGH') && (
                          <span style={{
                            fontSize: '9px', fontWeight: 800, padding: '1px 5px', borderRadius: '4px',
                            color: n.priority === 'CRITICAL' ? 'var(--danger)' : 'var(--warning)',
                            background: n.priority === 'CRITICAL' ? 'var(--status-cancelled-bg)' : 'var(--status-pending-bg)',
                            flexShrink: 0,
                          }}>
                            {n.priority}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '16px', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {n.message}
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px', fontWeight: 500 }}>
                        {formatTime(n.createdAt)}
                      </div>
                    </div>
                    {!n.isRead && (
                      <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: 'var(--accent)', marginTop: '6px', flexShrink: 0 }} />
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div style={{ padding: '10px 18px', borderTop: '1px solid var(--border-color)', textAlign: 'center' }}>
            <button
              onClick={() => { setOpen(false); navigate('/notifications'); }}
              style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: '12px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              View all <ExternalLink size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
