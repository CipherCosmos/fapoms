import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { styles } from '../theme/styles';
import { Ionicons } from '@expo/vector-icons';

export type TabType = 'SCHEDULE' | 'QUERIES' | 'EARNINGS' | 'MY_PROFILE';

interface TabBarProps {
  selectedTab: TabType;
  onSelectTab: (tab: TabType) => void;
  openQueriesCount: number;
  unreadNotifCount: number;
}

export const TabBar: React.FC<TabBarProps> = ({ selectedTab, onSelectTab, openQueriesCount, unreadNotifCount }) => {
  const tabs: { key: TabType; label: string; icon: React.ComponentProps<typeof Ionicons>['name']; badge?: number }[] = [
    { key: 'SCHEDULE', label: 'Audit Route', icon: 'location' },
    { key: 'QUERIES', label: 'Clarifications', icon: 'flash' },
    { key: 'EARNINGS', label: 'Financial Ledger', icon: 'card' },
    { key: 'MY_PROFILE', label: 'Settings', icon: 'settings-outline' },
  ];

  return (
    <View style={styles.tabBar}>
      {tabs.map((tab) => (
        <TouchableOpacity
          key={tab.key}
          style={[styles.tabItem, selectedTab === tab.key && styles.activeTabItem]}
          onPress={() => onSelectTab(tab.key)}
        >
          <View style={{ position: 'relative', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons
              name={tab.icon}
              size={16}
              color={selectedTab === tab.key ? '#6366f1' : '#94a3b8'}
            />
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
