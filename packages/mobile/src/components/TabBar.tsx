import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { styles } from '../theme/styles';

export type TabType = 'SCHEDULE' | 'PDF_DOCUMENTS' | 'QUERIES' | 'EARNINGS' | 'PERFORMANCE' | 'MY_PROFILE' | 'NOTIFICATIONS';

interface TabBarProps {
  selectedTab: TabType;
  onSelectTab: (tab: TabType) => void;
  openQueriesCount: number;
  unreadNotifCount: number;
}

export const TabBar: React.FC<TabBarProps> = ({ selectedTab, onSelectTab, openQueriesCount, unreadNotifCount }) => {
  const tabs: { key: TabType; label: string; icon: string; badge?: number }[] = [
    { key: 'SCHEDULE', label: 'Schedule', icon: '📅' },
    { key: 'PDF_DOCUMENTS', label: 'PDF Docs', icon: '📄' },
    { key: 'QUERIES', label: 'Queries', icon: '💬', badge: openQueriesCount > 0 ? openQueriesCount : undefined },
    { key: 'EARNINGS', label: 'Earnings', icon: '💰' },
    { key: 'PERFORMANCE', label: 'Stats', icon: '📊' },
    { key: 'NOTIFICATIONS', label: 'Alerts', icon: '🔔', badge: unreadNotifCount > 0 ? unreadNotifCount : undefined },
    { key: 'MY_PROFILE', label: 'Profile', icon: '👤' },
  ];

  return (
    <View style={styles.tabBar}>
      {tabs.map((tab) => (
        <TouchableOpacity
          key={tab.key}
          style={[styles.tabItem, selectedTab === tab.key && styles.activeTabItem]}
          onPress={() => onSelectTab(tab.key)}
        >
          <View style={{ position: 'relative' }}>
            <Text style={[styles.tabLabel, selectedTab === tab.key && styles.activeTabLabel]}>
              {tab.icon}
            </Text>
            {tab.badge ? (
              <View style={{
                position: 'absolute',
                top: -6,
                right: -12,
                backgroundColor: '#ef4444',
                borderRadius: 8,
                minWidth: 16,
                height: 16,
                alignItems: 'center',
                justifyContent: 'center',
                paddingHorizontal: 4,
              }}>
                <Text style={{ color: '#fff', fontSize: 9, fontWeight: '800' }}>
                  {tab.badge > 99 ? '99+' : tab.badge}
                </Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.tabLabel, { fontSize: 9 }, selectedTab === tab.key && styles.activeTabLabel]}>
            {tab.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
};
