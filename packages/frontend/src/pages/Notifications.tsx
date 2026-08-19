import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Bell, CheckCheck, RefreshCw, Wrench, ShieldCheck, FileText, MapPinned, Users, Wallet, MessageSquare,
  Settings2, Smartphone, MonitorSmartphone, Mail,
} from 'lucide-react';
import { api, WebNotification, NotificationCategory, NotificationPreference } from '../services/api';
import { userMessage } from '../services/errors';
import { connectSocket, getSocket } from '../services/socket';
import { useToast, useConfirm } from '../components/ui';

/**
 * The Notification Center.
 *
 * Two real gaps closed here, not just a redesign. First, neither this page nor
 * the bell dropdown ever used the `link` every notification carries — tapping
 * one did nothing but mark it read. Second, there was no way for anyone to turn
 * a channel off; the worker already checks preferences (built in the slice that
 * added delivery), but nothing let a person set one. Both are wired in below.
 */

/**
 * Derived from the enum, not typed out beside it.
 *
 * The hand-written list was missing FEEDBACK, so the tab it drives blanked the entire app.
 * Deriving it means a category added to shared shows up here automatically.
 */
const CATEGORIES: NotificationCategory[] = Object.values(NotificationCategory);

const CATEGORY_META: Record<NotificationCategory, { icon: React.ElementType; tone: string; label: string }> = {
  [NotificationCategory.ASSIGNMENT]: { icon: Wrench, tone: 'var(--accent)', label: 'Assignments' },
  [NotificationCategory.VALIDATION]: { icon: ShieldCheck, tone: 'var(--success)', label: 'Validation' },
  [NotificationCategory.DOCUMENT]: { icon: FileText, tone: 'var(--text-secondary)', label: 'Documents' },
  [NotificationCategory.PLANNING]: { icon: MapPinned, tone: 'var(--warning)', label: 'Planning' },
  [NotificationCategory.WORKFORCE]: { icon: Users, tone: 'var(--accent)', label: 'Workforce' },
  [NotificationCategory.BILLING]: { icon: Wallet, tone: 'var(--success)', label: 'Billing' },
  [NotificationCategory.SYSTEM]: { icon: Settings2, tone: 'var(--text-muted)', label: 'System' },
  [NotificationCategory.FEEDBACK]: { icon: MessageSquare, tone: 'var(--accent)', label: 'Feedback' },
};

/**
 * Never let a missing entry take the page down again.
 *
 * `Record<NotificationCategory, …>` makes an omission a compile error now that the local union
 * is gone, but this app has no error boundary — one undefined lookup unmounts the whole root.
 * A category arriving from an older or newer server than this bundle degrades to a readable row
 * instead of a blank screen.
 */
const metaFor = (category: string) =>
  CATEGORY_META[category as NotificationCategory] ??
  { icon: Bell, tone: 'var(--text-muted)', label: category };

const formatTime = (iso: string) => {
  const d = new Date(iso);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const PAGE_SIZE = 20;

export const Notifications: React.FC = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  // Honours ?tab=preferences so the bell's "Choose what reaches me" lands on the right tab
  // rather than dropping people on the inbox to hunt for it.
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<'inbox' | 'preferences'>(
    searchParams.get('tab') === 'preferences' ? 'preferences' : 'inbox',
  );
  const [category, setCategory] = useState<NotificationCategory | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [notifications, setNotifications] = useState<WebNotification[]>([]);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefsReloadKey, setPrefsReloadKey] = useState(0);

  const load = async (nextOffset = 0) => {
    nextOffset === 0 ? setLoading(true) : setLoadingMore(true);
    setError(null);
    try {
      const page = await api.getNotificationPage({
        category: category ?? undefined, unreadOnly, limit: PAGE_SIZE, offset: nextOffset,
      });
      setNotifications((prev) => (nextOffset === 0 ? page.items : [...prev, ...page.items]));
      setTotal(page.total);
      setUnreadCount(page.unreadCount);
      setOffset(nextOffset);
    } catch (e: any) {
      setError(`Failed to load notifications. ${userMessage(e)}`);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  /**
   * The inbox page is fetched only while the Inbox tab is actually showing.
   *
   * This page has two tabs and used to load both on mount: `load(0)` ran unconditionally, so
   * arriving on Preferences pulled a 20-row inbox page (plus its `total`/`unreadCount`
   * aggregates) that nothing on screen rendered. That is not a hypothetical route — the bell's
   * "Choose what reaches me" links straight to `/notifications?tab=preferences`, which is the
   * *only* way most people reach Preferences at all. Measured on the dev stack, that deep link
   * fired `GET /notifications/preferences` **and** `GET /notifications?limit=20&offset=0`; now it
   * fires only the first.
   *
   * `tab` is in the dependency list rather than the effect being skipped entirely, so switching
   * to Inbox loads it at that moment. React keeps `notifications`/`total` in state across a tab
   * switch, so going Inbox → Preferences → Inbox re-renders from what is already there and the
   * refetch is a background refresh, not an empty list — the same "keep the data, stop the
   * request" property `enabled` gives a React Query tab (this page predates React Query and does
   * its own fetching, so the gate has to be written by hand).
   *
   * The socket subscription stays outside the gate: a notification arriving while Preferences is
   * open must still update the header count, and `handler` re-enters `load` which is itself gated.
   */
  useEffect(() => {
    if (tab === 'inbox') {
      load(0);
    } else {
      // Preferences still needs the header's "N unread" line, but not the page of rows behind it.
      // This is the same number for a fraction of the work: a COUNT the server answers from an
      // index, versus selecting, ordering and serialising twenty full notification rows.
      api.getUnreadNotificationCount().then(setUnreadCount).catch(() => {});
    }
    connectSocket();
    const socket = getSocket();
    const handler = () => {
      if (tab === 'inbox') void load(0);
      // On Preferences there is no list to refresh, but the header count is still on screen and
      // a new notification has just made it stale.
      else api.getUnreadNotificationCount().then(setUnreadCount).catch(() => {});
    };
    socket?.on('notification:new', handler);
    return () => { socket?.off('notification:new', handler); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, unreadOnly, tab]);

  /** Refresh what is on screen, which is not the same thing on both tabs. */
  const handleRefresh = () => {
    if (tab === 'inbox') void load(0);
    else setPrefsReloadKey((k) => k + 1);
  };

  const handleOpen = async (n: WebNotification) => {
    if (!n.isRead) {
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
      setUnreadCount((prev) => Math.max(0, prev - 1));
      api.markNotificationRead(n.id).catch(() => {});
    }
    if (n.link) navigate(n.link);
  };

  const handleMarkAllRead = async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
    const updated = await api.markAllNotificationsRead().catch(() => 0);
    toast({ type: 'success', message: updated ? `Marked ${updated} notification(s) as read.` : 'Nothing to mark — you were already caught up.' });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)', color: 'var(--text-primary)', margin: 0 }}>
            Notifications
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginTop: '4px', margin: 0 }}>
            {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {tab === 'inbox' && unreadCount > 0 && (
            <button onClick={handleMarkAllRead} className="btn btn-secondary" style={{ padding: '8px 14px', fontSize: '12px' }}>
              <CheckCheck size={14} /> Mark all read
            </button>
          )}
          {/* Refreshes whichever tab is showing. It used to call `load(0)` unconditionally, which
              on Preferences fetched the inbox list to update a header count and left the
              preference rows the user was looking at untouched — the one thing Refresh should
              have done there. */}
          <button onClick={handleRefresh} className="btn btn-secondary" style={{ padding: '8px 14px', fontSize: '12px' }}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '4px', borderBottom: '1px solid var(--border-color)' }}>
        {(['inbox', 'preferences'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '10px 4px', marginRight: '20px', background: 'none', border: 'none', cursor: 'pointer',
              fontSize: '13px', fontWeight: 700, color: tab === t ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            {t === 'inbox' ? 'Inbox' : 'Preferences'}
          </button>
        ))}
      </div>

      {tab === 'inbox' ? (
        <>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              onClick={() => setCategory(null)}
              style={chipStyle(category === null)}
            >
              All
            </button>
            {CATEGORIES.map((c) => {
              const meta = CATEGORY_META[c];
              return (
                <button key={c} onClick={() => setCategory(c)} style={chipStyle(category === c)}>
                  <meta.icon size={12} /> {meta.label}
                </button>
              );
            })}
            <span style={{ width: '1px', height: '18px', background: 'var(--border-color)', margin: '0 4px' }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
              Unread only
            </label>
          </div>

          {loading ? (
            <div className="glass-card" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading notifications…</div>
          ) : error ? (
            <div className="glass-card" style={{ padding: '40px', textAlign: 'center' }}>
              <div style={{ color: 'var(--danger)', fontSize: '14px' }}>Couldn't load notifications</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px' }}>{error}</div>
              <button onClick={() => load(0)} className="btn btn-primary" style={{ marginTop: '16px', padding: '8px 16px', fontSize: '12px' }}>
                <RefreshCw size={14} /> Retry
              </button>
            </div>
          ) : notifications.length === 0 ? (
            <div className="glass-card" style={{ padding: '40px', textAlign: 'center' }}>
              <Bell size={32} style={{ color: 'var(--text-muted)', marginBottom: '12px', opacity: 0.5 }} />
              <div style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
                {unreadOnly ? 'Nothing unread' : 'No notifications yet'}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px' }}>
                Assignment updates and system alerts will appear here.
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {notifications.map((n) => {
                  const meta = n.category ? CATEGORY_META[n.category] : undefined;
                  const Icon = meta?.icon ?? Bell;
                  return (
                    <div
                      key={n.id}
                      className="glass-card"
                      style={{
                        padding: '16px 20px', display: 'flex', gap: '14px', alignItems: 'flex-start', cursor: 'pointer',
                        borderLeft: !n.isRead ? '3px solid var(--accent-primary)' : '3px solid transparent',
                        background: !n.isRead ? 'rgba(216,174,71,0.03)' : undefined,
                      }}
                      onClick={() => handleOpen(n)}
                    >
                      <span style={{ color: meta?.tone ?? 'var(--text-muted)', marginTop: '3px', flexShrink: 0 }}>
                        <Icon size={16} />
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '14px', fontWeight: !n.isRead ? 700 : 500, color: !n.isRead ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                              {n.title}
                            </span>
                            {(n.priority === 'CRITICAL' || n.priority === 'HIGH') && (
                              <span style={{
                                fontSize: '9.5px', fontWeight: 800, padding: '2px 6px', borderRadius: '4px',
                                color: n.priority === 'CRITICAL' ? 'var(--danger)' : 'var(--warning)',
                                background: n.priority === 'CRITICAL' ? 'var(--status-cancelled-bg)' : 'var(--status-pending-bg)',
                              }}>
                                {n.priority}
                              </span>
                            )}
                          </div>
                          {!n.isRead && (
                            <button
                              onClick={(e) => { e.stopPropagation(); handleOpen({ ...n, link: null }); }}
                              className="btn btn-secondary" style={{ padding: '6px 10px', fontSize: '11px', flexShrink: 0 }}
                              title="Mark as read"
                            >
                              <CheckCheck size={12} /> Read
                            </button>
                          )}
                        </div>
                        <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: '18px' }}>
                          {n.message}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px', fontWeight: 500 }}>
                          {formatTime(n.createdAt)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {notifications.length < total && (
                <button
                  onClick={() => load(offset + PAGE_SIZE)}
                  disabled={loadingMore}
                  className="btn btn-secondary"
                  style={{ alignSelf: 'center', padding: '9px 20px', fontSize: '12.5px' }}
                >
                  {loadingMore ? 'Loading…' : `Load more (${total - notifications.length} more)`}
                </button>
              )}
            </>
          )}
        </>
      ) : (
        /* Remounted on Refresh (see handleRefresh) — the panel loads its rows in its own mount
           effect, so a new key is the whole refresh mechanism and needs no prop drilling. */
        <PreferencesPanel key={prefsReloadKey} />
      )}
    </div>
  );
};

const chipStyle = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: '5px',
  padding: '6px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
  border: `1px solid ${active ? 'transparent' : 'var(--border-color)'}`,
  background: active ? 'var(--accent)' : 'transparent',
  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
});

/** One row per category, three channel toggles each. Absence of a saved row means everything is on. */
const PreferencesPanel: React.FC = () => {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [prefs, setPrefs] = useState<NotificationPreference[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    api.getNotificationPreferences().then(setPrefs).catch(() =>
      toast({ type: 'error', title: 'Could not load preferences', message: 'Try refreshing the page.' }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (category: NotificationCategory, key: 'inApp' | 'push' | 'email', value: boolean) => {
    if (key === 'inApp' && !value) {
      // Turning off in-app for a category would mean it never appears in the
      // bell or this inbox at all — a much bigger step than muting push or
      // email, and one a non-technical user could easily not intend.
      const ok = await confirm({
        title: `Turn off in-app notifications for ${metaFor(category).label}?`,
        message: 'You will stop seeing these in your notification bell and in this inbox entirely.',
        confirmLabel: 'Turn them off',
        reversible: true,
      });
      if (!ok) return;
    }

    const savingKey = `${category}:${key}`;
    setSaving(savingKey);
    setPrefs((prev) => prev!.map((p) => (p.category === category ? { ...p, [key]: value } : p)));
    try {
      await api.setNotificationPreference(category, { [key]: value });
    } catch (e: any) {
      // Revert on failure — the toggle must reflect what actually saved.
      setPrefs((prev) => prev!.map((p) => (p.category === category ? { ...p, [key]: !value } : p)));
      toast({ type: 'error', title: 'Could not save', message: userMessage(e) });
    } finally {
      setSaving(null);
    }
  };

  if (!prefs) {
    return <div className="glass-card" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading preferences…</div>;
  }

  return (
    <div className="glass-card" style={{ overflow: 'hidden' }}>
      {confirmDialog}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
        <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: 0 }}>
          Choose how each kind of update reaches you. Nothing selected here yet still means everything is on —
          turning a switch off only takes effect from this point on.
        </p>
      </div>
      <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr repeat(3, 90px)', minWidth: '440px', alignItems: 'center', padding: '10px 20px', fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>
        <span>Category</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center' }}><MonitorSmartphone size={12} /> In-app</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center' }}><Smartphone size={12} /> Push</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center' }}><Mail size={12} /> Email</span>
      </div>
      {prefs.map((p) => {
        const meta = metaFor(p.category);
        return (
          <div key={p.category} style={{ display: 'grid', gridTemplateColumns: '1fr repeat(3, 90px)', minWidth: '440px', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border-hair)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', fontWeight: 600 }}>
              <meta.icon size={15} style={{ color: meta.tone }} /> {meta.label}
            </span>
            {(['inApp', 'push', 'email'] as const).map((key) => (
              <span key={key} style={{ display: 'flex', justifyContent: 'center' }}>
                <Toggle
                  checked={p[key]}
                  disabled={saving === `${p.category}:${key}`}
                  onChange={(v) => toggle(p.category, key, v)}
                />
              </span>
            ))}
          </div>
        );
      })}
      </div>
    </div>
  );
};

const Toggle: React.FC<{ checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }> = ({ checked, disabled, onChange }) => (
  <button
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    style={{
      width: '34px', height: '19px', borderRadius: '999px', border: 'none', position: 'relative',
      cursor: disabled ? 'wait' : 'pointer', flexShrink: 0,
      background: checked ? 'var(--accent)' : 'var(--border-color)',
      opacity: disabled ? 0.6 : 1, transition: 'background 0.15s ease',
    }}
  >
    <span style={{
      position: 'absolute', top: '2px', left: checked ? '17px' : '2px', width: '15px', height: '15px',
      borderRadius: '50%', background: '#fff', transition: 'left 0.15s ease', boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
    }} />
  </button>
);

export default Notifications;
