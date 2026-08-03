import React from 'react';
import { View, Modal, ScrollView, Pressable } from 'react-native';
import { AppNotification } from '../types/mobile-app';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Card, EmptyState, Icon, IconButton, Divider } from './ui/primitives';

interface NotificationsModalProps {
  visible: boolean;
  notifications: AppNotification[];
  unreadCount: number;
  onClose: () => void;
  onMarkRead: (id: string) => void;
  onTapNotification: (notification: AppNotification) => void;
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

const iconFor = (title: string): string => {
  const s = title.toLowerCase();
  if (s.includes('assign') || s.includes('audit')) return 'clipboard-outline';
  if (s.includes('quer') || s.includes('clarif')) return 'chatbubble-ellipses-outline';
  if (s.includes('paid') || s.includes('payment') || s.includes('fee')) return 'wallet-outline';
  if (s.includes('document') || s.includes('pdf')) return 'document-text-outline';
  return 'notifications-outline';
};

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
  onTapNotification,
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
                {notifications.map((n) => (
                  <Pressable
                    key={n.id}
                    onPress={() => {
                      if (!n.isRead) onMarkRead(n.id);
                      onTapNotification(n);
                    }}
                  >
                    <Card level={1} padded={false}>
                      <View style={{ flexDirection: 'row' }}>
                        <View style={{ width: 4, backgroundColor: n.isRead ? 'transparent' : t.colors.accent }} />
                        <View style={{ flex: 1, flexDirection: 'row', gap: t.space.md, padding: t.space.md, alignItems: 'flex-start' }}>
                          <View style={{
                            width: 36, height: 36, borderRadius: t.radius.md,
                            backgroundColor: n.isRead ? t.colors.surfaceAlt : t.colors.accentSoft,
                            alignItems: 'center', justifyContent: 'center',
                          }}>
                            <Icon name={iconFor(n.title)} size={16} color={n.isRead ? t.colors.textFaint : t.colors.accent} />
                          </View>
                          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                            <AppText variant={n.isRead ? 'body' : 'bodyStrong'} numberOfLines={2}>{n.title}</AppText>
                            {n.message ? <AppText variant="small" tone="muted" numberOfLines={3}>{n.message}</AppText> : null}
                            <AppText variant="caption" tone="faint">{relative(n.createdAt)}</AppText>
                          </View>
                        </View>
                      </View>
                    </Card>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          )}
        </Card>
      </View>
    </Modal>
  );
};
