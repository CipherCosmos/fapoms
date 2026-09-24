import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '../i18n/I18nProvider';
import { colors, motion, radii, space, touch } from '../theme/tokens';
import { Icon } from './Icon';
import { Text } from './Text';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /** Let the body take most of the screen (long lists). */
  tall?: boolean;
}

/**
 * A panel that rises from the bottom. Calm motion (a critically damped spring, no bounce); none
 * at all when the phone asks for reduced motion. Closes on the scrim, the close button and the
 * Android back button. Rises with the keyboard, so a search box inside is never covered.
 */
export const Sheet: React.FC<SheetProps> = ({ visible, onClose, title, children, tall }) => {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  // Kept mounted through the closing animation, then removed.
  const [mounted, setMounted] = useState(visible);
  const progress = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      progress.value = reduceMotion ? 1 : withSpring(1, motion.sheetSpring);
    } else if (mounted) {
      if (reduceMotion) {
        progress.value = 0;
        setMounted(false);
      } else {
        progress.value = withTiming(0, { duration: motion.base, easing: Easing.bezier(...motion.easing) }, (done) => {
          if (done) runOnJS(setMounted)(false);
        });
      }
    }
    // `progress` is a stable shared value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reduceMotion]);

  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - progress.value) * height }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  if (!mounted) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]}>
          <Pressable
            style={styles.fill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t('a11y.closeSheet')}
          />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.panel,
            { paddingBottom: space.md + insets.bottom, maxHeight: height * (tall ? 0.9 : 0.75) },
            tall && { height: height * 0.9 },
            panelStyle,
          ]}
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.flex}>
              {title ? (
                <Text variant="title" accessibilityRole="header">
                  {title}
                </Text>
              ) : null}
            </View>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={styles.close}
              accessibilityRole="button"
              accessibilityLabel={t('a11y.closeSheet')}
            >
              <Icon name="close" size={28} />
            </Pressable>
          </View>
          <View style={tall ? styles.flex : undefined}>{children}</View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1 },
  scrim: { backgroundColor: colors.scrim },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    paddingHorizontal: space.md,
    paddingTop: space.xs,
  },
  handle: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: colors.line, marginBottom: space.xs },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: space.xs },
  close: { width: touch.minTarget, height: touch.minTarget, alignItems: 'center', justifyContent: 'center' },
});
