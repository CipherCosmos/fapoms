import React from 'react';
import { View, Modal, ScrollView } from 'react-native';
import { AppNotification } from '../types/mobile-app';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Card, EmptyState, Icon, IconButton, Divider, Tappable } from './ui/primitives';
import { SwipeableRow } from './ui/SwipeableRow';

interface NotificationsModalProps {
  visible: boolean;
  notifications: AppNotification[];
  unreadCount: number;
  onClose: () => void;
  onMarkRead: (id: string) => void;
  /** Swipe-left action. Optional so existing callers keep compiling. */
  onMarkUnread?: (id: string) => void;
  onTapNotification: (notification: AppNotification) => void;
  /** Clear the whole unread list. Optional so existing callers keep compiling. */
  onMarkAllRead?: () => void;
}

const relative = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};

/**
 * Icon for a notification, chosen from its catalog event key.
 *
 * This used to search the *title* for English words. Titles are operator-editable templates in
 * the notification catalog, so rewording one silently downgraded its icon to the generic bell —
 * and nothing failed, so nobody would know. The type is the event's stable identity.
 *
 * The title search is kept only as a fallback, for rows written before the type was carried
 * through to the handset.
 */
const iconForType = (type?: string): string | null => {
  if (!type) return null;
  if (type.startsWith('ASSIGNMENT_') || type.startsWith('BRANCH_')) return 'clipboard-outline';
  if (type.startsWith('QUERY_') || type.startsWith('DESK_') || type.startsWith('FEEDBACK_')) {
    return 'chatbubble-ellipses-outline';
  }
  if (type.startsWith('BILLING_') || type.startsWith('PAYMENT_') || type.startsWith('PAYABLE_')) {
    return 'wallet-outline';
  }
  if (type.startsWith('DOCUMENT_') || type.startsWith('VALIDATION_')) return 'document-text-outline';
  if (type.startsWith('FIELD_') || type.startsWith('ACCOUNT_')) return 'alert-circle-outline';
  return null;
};

const iconForTitle = (title: string): string => {
  const s = title.toLowerCase();
  if (s.includes('assign') || s.includes('audit')) return 'clipboard-outline';
  if (s.includes('quer') || s.includes('clarif')) return 'chatbubble-ellipses-outline';
  if (s.includes('paid') || s.includes('payment') || s.includes('fee')) return 'wallet-outline';
  if (s.includes('document') || s.includes('pdf')) return 'document-text-outline';
  return 'notifications-outline';
};

const iconFor = (n: AppNotification): string => iconForType(n.type) ?? iconForTitle(n.title);

/**
 * The notification list shown when the bell is tapped.
 *
 * Each item shows the notification's own title + message (not an assignment),
 * with a solid accent rail for unread items. Tapping an item marks it read and
 * hands the tap up so the shell can deep-link to the relevant assignment/query.
 */
export const NotificationsModal: React.FC<NotificationsModalProps> = ({
  visible,
  notifications,
  unreadCount,
  onClose,
  onMarkRead,
  onMarkUnread,
  onTapNotification,
  onMarkAllRead,
}) => {
  const t = useTheme();

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.colors.scrim, justifyContent: 'center', padding: t.space.lg }}>
        <Card level={2} style={{ gap: t.space.sm, padding: t.space.lg, maxHeight: '82%' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <AppText variant="h3">
              Notifications{unreadCount > 0 ? ` (${unreadCount})` : ''}
            </AppText>
            <IconButton icon="close" onPress={onClose} />
          </View>

          {/* Clearing the badge was previously one tap per item. An assayer back from a week in
              the field opens this to a badge in the dozens, so in practice it was never cleared
              and the number stopped meaning anything. Shown only when there is something to
              clear, so it does not sit there as a dead control. */}
          {unreadCount > 0 && onMarkAllRead ? (
            <Tappable accessibilityLabel="Mark all notifications as read" onPress={onMarkAllRead}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, paddingVertical: t.space.xs }}>
                <Icon name="checkmark-done-outline" size={15} color={t.colors.accent} />
                <AppText variant="small" style={{ color: t.colors.accent, fontWeight: '600' }}>
                  Mark all read
                </AppText>
              </View>
            </Tappable>
          ) : null}

          <Divider spacing={t.space.sm} />

          {notifications.length === 0 ? (
            <View style={{ paddingVertical: t.space.xl }}>
              <EmptyState
                icon="notifications-off-outline"
                title="Nothing new"
                body="Assignment offers, clarification requests and payment updates land here."
              />
            </View>
          ) : (
            <ScrollView style={{ flexGrow: 0 }}>
              <View style={{ gap: t.space.sm }}>
                {notifications.map((n) => {
                  /**
                   * One row, one swipe action, always the opposite of its current state — swipe
                   * an unread item to mark it read without opening it (triaging a long list one
                   * flick at a time), swipe a read one back to unread (a bank-branch interrupt
                   * you saw but need to return to later). `onMarkUnread` is optional so a caller
                   * that hasn't wired the reverse action yet still renders a working list — the
                   * swipe distance just resolves to whichever half exists.
                   */
                  const row = (
                    <Card level={1} padded={false}>
                      <View style={{ flexDirection: 'row' }}>
                        <View style={{ width: 4, backgroundColor: n.isRead ? 'transparent' : t.colors.accent }} />
                        <View style={{ flex: 1, flexDirection: 'row', gap: t.space.md, padding: t.space.md, alignItems: 'flex-start' }}>
                          <View style={{
                            width: 36, height: 36, borderRadius: t.radius.md,
                            backgroundColor: n.isRead ? t.colors.surfaceAlt : t.colors.accentSoft,
                            alignItems: 'center', justifyContent: 'center',
                          }}>
                            <Icon name={iconFor(n)} size={16} color={n.isRead ? t.colors.textFaint : t.colors.accent} />
                          </View>
                          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                            <AppText variant={n.isRead ? 'body' : 'bodyStrong'} numberOfLines={2}>{n.title}</AppText>
                            {n.message ? <AppText variant="small" tone="muted" numberOfLines={3}>{n.message}</AppText> : null}
                            <AppText variant="caption" tone="faint">{relative(n.createdAt)}</AppText>
                          </View>
                        </View>
                      </View>
                    </Card>
                  );

                  return (
                    <SwipeableRow
                      key={n.id}
                      leftAction={
                        n.isRead && onMarkUnread
                          ? { icon: 'mail-unread-outline', label: 'Unread', color: t.colors.accent, onTrigger: () => onMarkUnread(n.id) }
                          : undefined
                      }
                      rightAction={
                        !n.isRead
                          ? { icon: 'checkmark-done-outline', label: 'Read', color: t.colors.success ?? t.colors.primary, onTrigger: () => onMarkRead(n.id) }
                          : undefined
                      }
                    >
                      <Tappable
                        accessibilityLabel={n.title}
                        onPress={() => {
                          if (!n.isRead) onMarkRead(n.id);
                          onTapNotification(n);
                        }}
                      >
                        {row}
                      </Tappable>
                    </SwipeableRow>
                  );
                })}
              </View>
            </ScrollView>
          )}
        </Card>
      </View>
    </Modal>
  );
};
