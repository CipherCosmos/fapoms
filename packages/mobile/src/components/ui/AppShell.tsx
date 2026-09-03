import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Pressable, Platform, StatusBar, TextStyle, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';

import { useTheme } from '../../theme/ThemeProvider';
import { AppText, Avatar, Icon, IconButton, Tappable } from './primitives';
import * as haptics from '../../lib/haptics';
import { useT } from '../../i18n';

/**
 * App chrome: the top bar and the bottom navigation.
 *
 * The old header was a cramped row of three bordered buttons and a fake
 * "● ONLINE" pill; the old tab bar was four equal boxes with 9px labels. Both
 * are replaced: the header now leads with who you are and what needs attention,
 * and the tab bar is a floating, animated dock sized for thumbs.
 */

type IconName = string;

export type TabType = 'HOME' | 'SCHEDULE' | 'QUERIES' | 'EARNINGS' | 'MY_PROFILE';

/** Safe top padding without pulling in react-native-safe-area-context. */
export const TOP_INSET = Platform.select({ ios: 54, android: (StatusBar.currentHeight ?? 24) + 10, default: 16 });
/** Home-indicator clearance on iOS; Android nav bars are handled by the OS. */
export const BOTTOM_INSET = Platform.select({ ios: 26, android: 24, default: 12 });

export const TopBar: React.FC<{
  name: string;
  subtitle?: string;
  unreadCount: number;
  onNotifications: () => void;
  /** Opens the profile. The avatar is the control — the tab that used to do this is gone. */
  onOpenProfile?: () => void;
  /**
   * Opens the upload outbox. Shown only while something is actually in it.
   *
   * The outbox had exactly one way in: a button inside an assignment's paperwork screen. An
   * assayer who captured a packet, left that assignment, and only then lost signal had no route
   * to the Retry button from anywhere in the app — their evidence sat on the phone, marked
   * failed, on a screen they could not reach. Here it is reachable from every tab, and it
   * disappears again when the queue is empty so it costs nothing the rest of the time.
   */
  onOpenUploads?: () => void;
  activeUploads?: number;
  failedUploads?: number;
}> = ({ name, subtitle, unreadCount, onNotifications, onOpenProfile, onOpenUploads, activeUploads = 0, failedUploads = 0 }) => {
  const t = useTheme();
  const tr = useT();

  return (
    <View style={{
      paddingTop: TOP_INSET, paddingHorizontal: t.space.xl, paddingBottom: t.space.md,
      backgroundColor: t.colors.bg,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    }}>
      {/*
        Identity is the way into the profile, which is how nearly every app of this shape
        works — so the fifth dock slot is free for the four things an assayer does all day.
        `flexShrink` (not `flex: 1`) plus `justifyContent: 'space-between'` on the row: a long
        name still truncates and never crowds the bell, but a short one no longer lets the row's
        own flex-growth put the avatar and the notifications button within a thumb's-width of
        each other — pinned to opposite ends of the bar regardless of name length.
      */}
      <Tappable
        onPress={onOpenProfile}
        accessibilityLabel={tr('shell.openProfile')}
        style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, flexShrink: 1, minWidth: 0, marginRight: t.space.lg }}
      >
        <Avatar name={name} size={44} />
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <AppText variant="h3" numberOfLines={1}>{name || tr('profile.identity.fallbackName')}</AppText>
          <AppText variant="caption" tone="muted" numberOfLines={1}>{subtitle ?? tr('profile.identity.fallbackName')}</AppText>
        </View>
      </Tappable>

      {/*
        No refresh button. Every scrollable screen already pulls to refresh, so this was a
        second control for the same action taking permanent space in the header — and the one
        an assayer reaches for by reflex is the pull.

        The theme toggle that also lived here has moved to Profile > App > Appearance, where
        the rest of the app's settings are.
      */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        {onOpenUploads && (activeUploads > 0 || failedUploads > 0) && (
          <IconButton
            // A failure is the case worth interrupting for, so it gets the danger tone and the
            // count; work merely in progress is shown without a number, because "3 sending" is
            // not something a field worker needs to act on.
            icon={failedUploads > 0 ? 'alert-circle-outline' : 'cloud-upload-outline'}
            tone={failedUploads > 0 ? 'danger' : 'default'}
            onPress={onOpenUploads}
            badge={failedUploads}
            accessibilityLabel={
              failedUploads > 0
                ? tr('shell.uploadsFailed', { count: failedUploads })
                : tr('shell.uploadsSending', { count: activeUploads })
            }
          />
        )}
        <IconButton
          icon="notifications-outline"
          onPress={onNotifications}
          badge={unreadCount}
          accessibilityLabel={unreadCount > 0 ? tr('shell.notificationsUnread', { count: unreadCount }) : tr('shell.notifications')}
        />
      </View>
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
  const tr = useT();
  const tabs: TabSpec[] = [
    { key: 'HOME', label: tr('shell.tabs.home'), icon: 'home-outline', iconActive: 'home' },
    { key: 'SCHEDULE', label: tr('shell.tabs.route'), icon: 'map-outline', iconActive: 'map' },
    { key: 'QUERIES', label: tr('shell.tabs.queries'), icon: 'chatbubble-ellipses-outline', iconActive: 'chatbubble-ellipses', badge: queryCount },
    { key: 'EARNINGS', label: tr('shell.tabs.earnings'), icon: 'wallet-outline', iconActive: 'wallet' },
    // Profile is deliberately absent: it is reached by tapping your own avatar in the header.
    // Four slots give the tabs an assayer actually works in room to breathe.
  ];

  const [width, setWidth] = React.useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const index = Math.max(0, tabs.findIndex((tb) => tb.key === selected));
  const seg = width > 0 ? (width - 10) / tabs.length : 0;

  useEffect(() => {
    Animated.spring(x, { toValue: index * seg, ...t.motion.spring }).start();
  }, [index, seg, x, t.motion.spring]);

  // Frosted material: content scrolls under the floating dock, so a real blur reads as the
  // translucent glass iOS uses for its own tab bar. The translucent tint keeps text legible over
  // the blur and doubles as the fallback fill if blur is unsupported.
  const dark = t.mode === 'dark';
  const material = dark ? 'rgba(25,28,36,0.66)' : 'rgba(255,255,255,0.62)';

  return (
    <View style={{
      position: 'absolute', left: t.space.lg, right: t.space.lg, bottom: BOTTOM_INSET,
    }}>
      <View style={[{ borderRadius: t.radius['2xl'] }, t.elevation(3)]}>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{
          flexDirection: 'row', borderRadius: t.radius['2xl'], padding: 5,
          borderWidth: 1, borderColor: t.colors.border, overflow: 'hidden',
          backgroundColor: material,
        }}
      >
        <BlurView
          intensity={dark ? 40 : 55}
          tint={dark ? 'dark' : 'light'}
          style={StyleSheet.absoluteFill}
        />
        {seg > 0 && (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute', top: 5, left: 5, bottom: 5, width: seg,
              backgroundColor: t.colors.primarySoft, borderRadius: t.radius.xl,
              // A hairline violet edge turns the selection pill from a flat tint into the lit
              // neon marker the identity is built on.
              borderWidth: 1, borderColor: t.colors.primary + '55',
              transform: [{ translateX: x }],
            }}
          />
        )}
        {tabs.map((tab) => {
          const active = tab.key === selected;
          return (
            <Pressable
              key={tab.key}
              onPress={() => { if (!active) haptics.select(); onSelect(tab.key); }}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={tab.label}
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
                    // 20px, not 18: the count is `caption` (12) now, and the badge has to be a
                    // circle around it. This started at 9pt and was raised to 10 — both below
                    // anything in the type scale. The people reading it are field workers, often
                    // in sunlight, and a count of waiting queries is not decoration. 12 is the
                    // readable floor for this app; the IconButton badge in primitives matches, so
                    // the two badges stay one badge.
                    position: 'absolute', top: -6, right: -10, minWidth: 20, height: 20, borderRadius: 10,
                    paddingHorizontal: 5, backgroundColor: t.colors.danger,
                    alignItems: 'center', justifyContent: 'center',
                    borderWidth: 2, borderColor: t.colors.surface,
                  }}>
                    <Text style={{ color: t.colors.onDanger, fontSize: 12, fontWeight: '800' }}>
                      {tab.badge > 9 ? '9+' : tab.badge}
                    </Text>
                  </View>
                )}
              </View>
              <Text
                numberOfLines={1}
                style={[
                  t.type.caption as TextStyle,
                  // The token, with no size override. These are the app's primary navigation
                  // labels for an audience that may read slowly, and they had been shrunk twice
                  // (10.5, then 11) to buy dock width. Width is the cheaper thing to give up:
                  // four tabs at 12pt still fit, and a label nobody can read costs more.
                  { color: active ? t.colors.primary : t.colors.textFaint },
                ]}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      </View>
    </View>
  );
};

/** Bottom padding a scroll view needs so content clears the floating dock. */
export const DOCK_CLEARANCE = 108;
