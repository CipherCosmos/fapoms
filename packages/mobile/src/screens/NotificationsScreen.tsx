import React from 'react';
import { View, ScrollView, RefreshControl } from 'react-native';
import { AppNotification } from '../types/mobile-app';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Card, EmptyState, FadeIn, Icon, Skeleton } from '../components/ui/primitives';

interface NotificationsScreenProps {
  notifications: AppNotification[];
  loading: boolean;
  unreadCount: number;
  onRefresh: () => void;
  onMarkRead: (id: string) => void;
  onTapNotification: (notification: AppNotification) => void;
}

const relative = (iso: string) => {
  const d = new Date(iso);
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
 * Notifications.
 *
 * Unread items are marked with a solid accent rail rather than a slightly
 * different border colour, so the distinction survives a glance in sunlight.
 * Loading now shows skeletons instead of a centred spinner and the word
 * "Loading…".
 */
export const NotificationsScreen: React.FC<NotificationsScreenProps> = ({
  notifications,
  loading,
  unreadCount,
  onRefresh,
  onMarkRead,
  onTapNotification,
}) => {
  const t = useTheme();

  if (loading && notifications.length === 0) {
    return (
      <View style={{ gap: t.space.md }}>
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} level={1} style={{ flexDirection: 'row', gap: t.space.md, alignItems: 'center' }}>
            <Skeleton height={38} width={38} radius={t.radius.md} />
            <View style={{ flex: 1, gap: t.space.sm }}>
              <Skeleton height={13} width="70%" />
              <Skeleton height={11} width="45%" />
            </View>
          </Card>
        ))}
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={{ gap: t.space.md, paddingBottom: t.space.xl }}
      refreshControl={
        <RefreshControl
          refreshing={loading}
          onRefresh={onRefresh}
          tintColor={t.colors.primary}
          colors={[t.colors.primary]}
          progressBackgroundColor={t.colors.surface}
        />
      }
    >
      {unreadCount > 0 && (
        <AppText variant="overline" tone="faint">{unreadCount} UNREAD</AppText>
      )}

      {notifications.length === 0 ? (
        <EmptyState
          icon="notifications-off-outline"
          title="Nothing new"
          body="Assignment offers, clarification requests and payment updates land here."
        />
      ) : (
        notifications.map((n, i) => (
          <FadeIn key={n.id} delay={Math.min(i, 8) * 35}>
            <Card
              level={1}
              padded={false}
              onPress={() => { if (!n.isRead) onMarkRead(n.id); onTapNotification(n); }}
            >
              <View style={{ flexDirection: 'row' }}>
                {/* Unread rail — reads at a glance, unlike a border tint. */}
                <View style={{ width: 4, backgroundColor: n.isRead ? 'transparent' : t.colors.accent }} />
                <View style={{ flex: 1, flexDirection: 'row', gap: t.space.md, padding: t.space.lg, alignItems: 'flex-start' }}>
                  <View style={{
                    width: 38, height: 38, borderRadius: t.radius.md,
                    backgroundColor: n.isRead ? t.colors.surfaceAlt : t.colors.accentSoft,
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Icon
                      name={iconFor(n.title)}
                      size={17}
                      color={n.isRead ? t.colors.textFaint : t.colors.accent}
                    />
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <AppText variant={n.isRead ? 'body' : 'bodyStrong'} numberOfLines={2}>{n.title}</AppText>
                    {n.message ? <AppText variant="small" tone="muted" numberOfLines={2}>{n.message}</AppText> : null}
                    <AppText variant="caption" tone="faint">{relative(n.createdAt)}</AppText>
                  </View>
                </View>
              </View>
            </Card>
          </FadeIn>
        ))
      )}
    </ScrollView>
  );
};
