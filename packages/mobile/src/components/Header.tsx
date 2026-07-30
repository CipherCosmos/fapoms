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
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={styles.appTitle}>SUMERU AUDIT</Text>
          <View style={{ backgroundColor: 'rgba(16,185,129,0.15)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)' }}>
            <Text style={{ fontSize: 10, color: '#34d399', fontWeight: '800' }}>● ONLINE</Text>
          </View>
        </View>
        <Text style={styles.assayerSubtitle}>Field Assayer: {assayerName || 'Authorized Auditor'}</Text>
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
          <Text style={styles.refreshBtnText}>🔄 Sync</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.refreshBtn, { borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.15)' }]} onPress={onLogout}>
          <Text style={{ color: '#f87171', fontSize: 12, fontWeight: '800' }}>🚪 Exit</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};
