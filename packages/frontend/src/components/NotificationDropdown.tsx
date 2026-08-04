import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Bell, CheckCheck, FileText, CheckCircle2, Calendar, Users, DollarSign, Info } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, WebNotification, NotificationCategory } from '../services/api';
import { useToast } from './ui';
import { connectSocket } from '../services/socket';

const CATEGORY_META: Record<NotificationCategory, { icon: React.ElementType; tone: string }> = {
  ASSIGNMENT: { icon: Calendar, tone: 'var(--accent)' },
  VALIDATION: { icon: CheckCircle2, tone: 'var(--success)' },
  DOCUMENT: { icon: FileText, tone: 'var(--accent)' },
  PLANNING: { icon: Calendar, tone: 'var(--warning)' },
  WORKFORCE: { icon: Users, tone: 'var(--accent)' },
  BILLING: { icon: DollarSign, tone: 'var(--success)' },
  SYSTEM: { icon: Info, tone: 'var(--text-secondary)' },
};

function categoryIcon(category?: NotificationCategory) {
  const meta = category ? CATEGORY_META[category] : undefined;
  if (!meta) return { Icon: Bell, tone: 'var(--accent)' };
  return { Icon: meta.icon, tone: meta.tone };
}

function playWebNotificationSound() {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
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
    }
  } catch (e) {
    console.log('Web audio chime error:', e);
  }
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

    const handleNewEvent = (data: any) => {
      refreshCount();
      if (open) fetchPage();

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
      socket.on('notification:new', handleNewEvent);
      socket.on('assignment:counter-offered', handleNewEvent);
      socket.on('assignment:status-changed', handleNewEvent);
      socket.on('assignment:created', handleNewEvent);
    }

    const interval = setInterval(refreshCount, 10_000);
    return () => {
      clearInterval(interval);
      if (socket) {
        socket.off('notification:new', handleNewEvent);
        socket.off('assignment:counter-offered', handleNewEvent);
        socket.off('assignment:status-changed', handleNewEvent);
        socket.off('assignment:created', handleNewEvent);
      }
    };
  }, [open]);

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
          </div>,
          document.body
        )}
    </div>
  );
};
