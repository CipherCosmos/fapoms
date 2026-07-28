import React, { useState, useEffect } from 'react';
import { Bell, CheckCheck, RefreshCw } from 'lucide-react';
import { api, WebNotification } from '../services/api';

export const Notifications: React.FC = () => {
  const [notifications, setNotifications] = useState<WebNotification[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const items = await api.getNotifications();
    setNotifications(items);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const handleMarkRead = async (id: string) => {
    await api.markNotificationRead(id);
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
    );
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)', color: '#fff', margin: 0 }}>
            Notifications
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginTop: '4px', margin: 0 }}>
            {unreadCount > 0 ? `${unreadCount} unread notifications` : 'All caught up'}
          </p>
        </div>
        <button onClick={load} className="btn btn-secondary" style={{ padding: '8px 14px', fontSize: '12px' }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="glass-card" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading notifications...
        </div>
      ) : notifications.length === 0 ? (
        <div className="glass-card" style={{ padding: '40px', textAlign: 'center' }}>
          <Bell size={32} style={{ color: 'var(--text-muted)', marginBottom: '12px', opacity: 0.5 }} />
          <div style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>No notifications yet</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px' }}>
            Assignment updates and system alerts will appear here
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {notifications.map((n) => (
            <div
              key={n.id}
              className="glass-card"
              style={{
                padding: '18px 22px',
                display: 'flex',
                gap: '14px',
                alignItems: 'flex-start',
                cursor: 'pointer',
                borderLeft: !n.isRead ? '3px solid var(--accent-primary)' : '3px solid transparent',
                background: !n.isRead ? 'rgba(99, 102, 241, 0.03)' : undefined,
              }}
              onClick={() => {
                if (!n.isRead) handleMarkRead(n.id);
              }}
            >
              <div
                style={{
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  backgroundColor: !n.isRead ? '#6366f1' : 'transparent',
                  marginTop: '4px',
                  flexShrink: 0,
                  boxShadow: !n.isRead ? '0 0 8px rgba(99, 102, 241, 0.5)' : 'none',
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                  <div>
                    <span
                      style={{
                        fontSize: '14px',
                        fontWeight: !n.isRead ? 700 : 500,
                        color: !n.isRead ? '#fff' : 'var(--text-secondary)',
                      }}
                    >
                      {n.title}
                    </span>
                    <div
                      style={{
                        fontSize: '13px',
                        color: 'var(--text-muted)',
                        marginTop: '4px',
                        lineHeight: '18px',
                      }}
                    >
                      {n.message}
                    </div>
                  </div>
                  {!n.isRead && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMarkRead(n.id);
                      }}
                      className="btn btn-secondary"
                      style={{ padding: '6px 10px', fontSize: '11px', flexShrink: 0 }}
                      title="Mark as read"
                    >
                      <CheckCheck size={12} /> Read
                    </button>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px', fontWeight: 500 }}>
                  {formatTime(n.createdAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
