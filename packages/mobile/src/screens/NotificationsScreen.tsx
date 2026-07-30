import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, ScrollView, RefreshControl } from 'react-native';
import { AppNotification } from '../types/mobile-app';
import { styles } from '../theme/styles';
import { Ionicons } from '@expo/vector-icons';

interface NotificationsScreenProps {
  notifications: AppNotification[];
  loading: boolean;
  unreadCount: number;
  onRefresh: () => void;
  onMarkRead: (id: string) => void;
  onTapNotification: (notification: AppNotification) => void;
}

export const NotificationsScreen: React.FC<NotificationsScreenProps> = ({
  notifications,
  loading,
  unreadCount,
  onRefresh,
  onMarkRead,
  onTapNotification,
}) => {
  if (loading && notifications.length === 0) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#6366f1" />
        <Text style={styles.loadingText}>Loading notifications...</Text>
      </View>
    );
  }

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  };

  return (
    <ScrollView
      style={styles.contentScroll}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor="#6366f1" colors={['#6366f1']} />}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Text style={styles.sectionHeading}>Notifications</Text>
        {unreadCount > 0 && (
          <View style={{ backgroundColor: '#6366f1', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 }}>
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>{unreadCount} new</Text>
          </View>
        )}
      </View>

      {notifications.length === 0 ? (
        <View style={styles.emptyBox}>
          <Ionicons name="notifications" size={32} color="#94a3b8" style={{ marginBottom: 8 }} />
          <Text style={styles.emptyText}>No notifications yet</Text>
          <Text style={{ color: '#64748b', fontSize: 13, marginTop: 4, textAlign: 'center' }}>
            Assignment updates and alerts will appear here
          </Text>
        </View>
      ) : (
        notifications.map((n) => (
          <TouchableOpacity
            key={n.id}
            style={[
              localStyles.notifCard,
              !n.isRead && localStyles.notifCardUnread,
            ]}
            onPress={() => {
              if (!n.isRead) onMarkRead(n.id);
              onTapNotification(n);
            }}
            activeOpacity={0.7}
          >
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
              <View style={[localStyles.iconBox, !n.isRead && localStyles.iconBoxUnread]}>
                <Ionicons
                  name={n.title.includes('Assignment') || n.title.includes('audit') ? 'clipboard' : 'notifications'}
                  size={16}
                  color="#f8fafc"
                />
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <Text style={[localStyles.notifTitle, !n.isRead && localStyles.notifTitleUnread]} numberOfLines={1}>
                    {n.title}
                  </Text>
                  {!n.isRead && <View style={localStyles.unreadDot} />}
                </View>
                <Text style={localStyles.notifMessage} numberOfLines={2}>{n.message}</Text>
                <Text style={localStyles.notifTime}>{formatTime(n.createdAt)}</Text>
              </View>
            </View>
          </TouchableOpacity>
        ))
      )}
    </ScrollView>
  );
};

const localStyles = {
  notifCard: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.15)',
  } as any,
  notifCardUnread: {
    backgroundColor: 'rgba(99, 102, 241, 0.08)',
    borderColor: 'rgba(99, 102, 241, 0.35)',
  } as any,
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
  } as any,
  iconBoxUnread: {
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
  } as any,
  notifTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#cbd5e1',
    flex: 1,
  } as any,
  notifTitleUnread: {
    color: '#ffffff',
    fontWeight: '800',
  } as any,
  notifMessage: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 4,
    lineHeight: 18,
  } as any,
  notifTime: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 6,
    fontWeight: '500',
  } as any,
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#6366f1',
    marginLeft: 8,
    marginTop: 4,
  } as any,
};
