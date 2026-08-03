import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Pressable, Platform, StatusBar, TextStyle } from 'react-native';

import { useTheme } from '../../theme/ThemeProvider';
import { AppText, Avatar, Icon, IconButton, Tappable } from './primitives';

/**
 * App chrome: the top bar and the bottom navigation.
 *
 * The old header was a cramped row of three bordered buttons and a fake
 * "● ONLINE" pill; the old tab bar was four equal boxes with 9px labels. Both
 * are replaced: the header now leads with who you are and what needs attention,
 * and the tab bar is a floating, animated dock sized for thumbs.
 */

type IconName = string;

export type TabType = 'SCHEDULE' | 'QUERIES' | 'EARNINGS' | 'MY_PROFILE';

/** Safe top padding without pulling in react-native-safe-area-context. */
const TOP_INSET = Platform.select({ ios: 54, android: (StatusBar.currentHeight ?? 24) + 10, default: 16 });
/** Home-indicator clearance on iOS; Android nav bars are handled by the OS. */
export const BOTTOM_INSET = Platform.select({ ios: 26, android: 12, default: 12 });

export const TopBar: React.FC<{
  name: string;
  subtitle?: string;
  unreadCount: number;
  onNotifications: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}> = ({ name, subtitle, unreadCount, onNotifications, onRefresh, refreshing }) => {
  const t = useTheme();

  return (
    <View style={{
      paddingTop: TOP_INSET, paddingHorizontal: t.space.xl, paddingBottom: t.space.md,
      backgroundColor: t.colors.bg,
      flexDirection: 'row', alignItems: 'center', gap: t.space.md,
    }}>
      <Avatar name={name} size={44} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="h3" numberOfLines={1}>{name || 'Field Assayer'}</AppText>
        <AppText variant="caption" tone="muted" numberOfLines={1}>{subtitle ?? 'Field Assayer'}</AppText>
      </View>

      {onRefresh && (
        <IconButton
          icon="refresh-outline"
          onPress={onRefresh}
        />
      )}
      <IconButton icon="notifications-outline" onPress={onNotifications} badge={unreadCount} />
    </View>
  );
};

interface TabSpec { key: TabType; label: string; icon: IconName; iconActive: IconName; badge?: number }

/**
 * Floating dock. The active tab's pill slides between slots with a spring, and
 * the icon swaps to its filled variant — so the current location is obvious at a
 * glance rather than being a 1px colour difference on a 9px label.
 */
export const TabDock: React.FC<{
  selected: TabType;
  onSelect: (t: TabType) => void;
  queryCount?: number;
}> = ({ selected, onSelect, queryCount }) => {
  const t = useTheme();
  const tabs: TabSpec[] = [
    { key: 'SCHEDULE', label: 'Route', icon: 'map-outline', iconActive: 'map' },
    { key: 'QUERIES', label: 'Queries', icon: 'chatbubble-ellipses-outline', iconActive: 'chatbubble-ellipses', badge: queryCount },
    { key: 'EARNINGS', label: 'Earnings', icon: 'wallet-outline', iconActive: 'wallet' },
    { key: 'MY_PROFILE', label: 'Profile', icon: 'person-outline', iconActive: 'person' },
  ];

  const [width, setWidth] = React.useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const index = Math.max(0, tabs.findIndex((tb) => tb.key === selected));
  const seg = width > 0 ? (width - 10) / tabs.length : 0;

  useEffect(() => {
    Animated.spring(x, { toValue: index * seg, ...t.motion.spring }).start();
  }, [index, seg, x, t.motion.spring]);

  return (
    <View style={{
      position: 'absolute', left: t.space.lg, right: t.space.lg, bottom: BOTTOM_INSET,
    }}>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={[{
          flexDirection: 'row', backgroundColor: t.colors.surface,
          borderRadius: t.radius['2xl'], padding: 5,
          borderWidth: 1, borderColor: t.colors.border,
        }, t.elevation(3)]}
      >
        {seg > 0 && (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute', top: 5, left: 5, bottom: 5, width: seg,
              backgroundColor: t.colors.primarySoft, borderRadius: t.radius.xl,
              transform: [{ translateX: x }],
            }}
          />
        )}
        {tabs.map((tab) => {
          const active = tab.key === selected;
          return (
            <Pressable
              key={tab.key}
              onPress={() => onSelect(tab.key)}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, gap: 3 }}
            >
              <View>
                <Icon
                  name={active ? tab.iconActive : tab.icon}
                  size={21}
                  color={active ? t.colors.primary : t.colors.textFaint}
                />
                {tab.badge != null && tab.badge > 0 && (
                  <View style={{
                    position: 'absolute', top: -4, right: -8, minWidth: 16, height: 16, borderRadius: 8,
                    paddingHorizontal: 4, backgroundColor: t.colors.danger,
                    alignItems: 'center', justifyContent: 'center',
                    borderWidth: 2, borderColor: t.colors.surface,
                  }}>
                    <Text style={{ color: '#fff', fontSize: 9, fontWeight: '800' }}>
                      {tab.badge > 9 ? '9+' : tab.badge}
                    </Text>
                  </View>
                )}
              </View>
              <Text style={[
                t.type.caption as TextStyle,
                { fontSize: 10.5, color: active ? t.colors.primary : t.colors.textFaint },
              ]}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
};

/** Bottom padding a scroll view needs so content clears the floating dock. */
export const DOCK_CLEARANCE = 108;
