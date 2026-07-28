import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { styles } from '../theme/styles';

interface HeaderProps {
  assayerName: string;
  unreadNotifCount: number;
  onRefresh: () => void;
  onLogout: () => void;
  onNotificationsPress?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ assayerName, unreadNotifCount, onRefresh, onLogout, onNotificationsPress }) => {
  return (
    <View style={styles.header}>
      <View style={{ flex: 1 }}>
        <Text style={styles.appTitle}>FAPOMS</Text>
        <Text style={styles.assayerSubtitle}>{assayerName}</Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <TouchableOpacity
          style={styles.notifBellBtn}
          onPress={onNotificationsPress}
          activeOpacity={0.7}
        >
          <Text style={{ fontSize: 18 }}>🔔</Text>
          {unreadNotifCount > 0 && (
            <View style={styles.notifBadge}>
              <Text style={styles.notifBadgeText}>
                {unreadNotifCount > 99 ? '99+' : unreadNotifCount}
              </Text>
            </View>
          )}
        </TouchableOpacity>
        <TouchableOpacity style={styles.refreshBtn} onPress={onRefresh}>
          <Text style={styles.refreshBtnText}>🔄</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.refreshBtn, { borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.15)' }]} onPress={onLogout}>
          <Text style={{ color: '#f87171', fontSize: 13, fontWeight: '700' }}>🚪</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};
