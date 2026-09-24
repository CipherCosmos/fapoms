import React from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, space } from '../theme/tokens';
import { Text } from './Text';

export interface ScreenProps {
  title?: string;
  /** A line under the title. */
  subtitle?: string;
  children: React.ReactNode;
  /** Stays above the keyboard and the home bar: the screen's main action. */
  footer?: React.ReactNode;
  /** false for screens that manage their own list (FlatList). */
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Stack screens with a native header already show the title. */
  hideTitle?: boolean;
}

/**
 * Safe area + a scroll that never clips its last item + keyboard awareness.
 *
 * The bottom padding includes the home-bar inset, so the last row is never hidden under it; the
 * footer sits outside the scroll so the main action is always on screen; on iOS the whole screen
 * lifts with the keyboard (Android resizes the window itself).
 */
export const Screen: React.FC<ScreenProps> = ({
  title,
  subtitle,
  children,
  footer,
  scroll = true,
  refreshing,
  onRefresh,
  hideTitle,
}) => {
  const insets = useSafeAreaInsets();
  const header = !hideTitle && (title || subtitle) ? (
    <View style={styles.header}>
      {title ? (
        <Text variant="heading" accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      {subtitle ? <Text variant="secondary">{subtitle}</Text> : null}
    </View>
  ) : null;

  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[styles.content, { paddingBottom: space.xl + (footer ? 0 : insets.bottom) }]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />
        ) : undefined
      }
    >
      {header}
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, styles.content]}>
      {header}
      {children}
    </View>
  );

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {body}
        {footer ? (
          <View style={[styles.footer, { paddingBottom: space.md + insets.bottom }]}>{footer}</View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  flex: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: space.md, paddingTop: space.md, gap: space.md },
  header: { gap: space.xxs, marginBottom: space.xs },
  footer: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    gap: space.sm,
    backgroundColor: colors.ground,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
});
