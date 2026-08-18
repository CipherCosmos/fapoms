import React, { useRef, useState } from 'react';
import { Animated, PanResponder, StyleProp, View, ViewStyle } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { AppText, Icon } from './primitives';
import * as haptics from '../../lib/haptics';

interface SwipeAction {
  icon: string;
  label: string;
  /** Background the reveal panel takes as the row is dragged over it. */
  color: string;
  onTrigger: () => void;
}

interface SwipeableRowProps {
  children: React.ReactNode;
  /** Revealed when the row is dragged rightward (finger moves right, content follows). */
  leftAction?: SwipeAction;
  /** Revealed when the row is dragged leftward. */
  rightAction?: SwipeAction;
  style?: StyleProp<ViewStyle>;
}

/** How far a drag must travel before release commits the action, in points. */
const TRIGGER_DISTANCE = 84;
/** How far the row is allowed to travel past the trigger point, for a bit of give. */
const MAX_DRAG = 120;

/**
 * A row that reveals an action underneath it as it's dragged sideways — no gesture library.
 *
 * `react-native-gesture-handler`/`reanimated` would be the conventional way to build this, but
 * both are native modules: adding either changes the app's native fingerprint, so every future
 * JS-only fix would stop qualifying for the OTA path this project just built specifically to
 * avoid 15-40 minute rebuilds (see .eas/workflows/publish-update.yml and
 * scripts/publish-ota.sh). `PanResponder` + `Animated` are pure JS, already in React Native
 * core, and are enough for a single-row swipe: no native dependency, no fingerprint change,
 * still ships in under a minute.
 */
export const SwipeableRow: React.FC<SwipeableRowProps> = ({ children, leftAction, rightAction, style }) => {
  const t = useTheme();
  const translateX = useRef(new Animated.Value(0)).current;
  const triggeredRef = useRef(false);
  const [dragDx, setDragDx] = useState(0);

  const panResponder = useRef(
    PanResponder.create({
      // A mostly-horizontal, deliberate drag — not a vertical scroll passing through this row.
      onMoveShouldSetPanResponder: (_, gesture) =>
        Math.abs(gesture.dx) > 10 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
      onPanResponderGrant: () => {
        triggeredRef.current = false;
      },
      onPanResponderMove: (_, gesture) => {
        const action = gesture.dx > 0 ? leftAction : gesture.dx < 0 ? rightAction : null;
        if (!action) return;
        const clamped = Math.max(-MAX_DRAG, Math.min(MAX_DRAG, gesture.dx));
        translateX.setValue(clamped);
        setDragDx(clamped);
        const past = Math.abs(clamped) > TRIGGER_DISTANCE;
        if (past && !triggeredRef.current) {
          triggeredRef.current = true;
          haptics.select();
        } else if (!past) {
          triggeredRef.current = false;
        }
      },
      onPanResponderRelease: (_, gesture) => {
        const action = gesture.dx > 0 ? leftAction : gesture.dx < 0 ? rightAction : null;
        const past = Math.abs(gesture.dx) > TRIGGER_DISTANCE;
        if (action && past) {
          haptics.success();
          action.onTrigger();
        }
        setDragDx(0);
        Animated.spring(translateX, { toValue: 0, ...t.motion.spring }).start();
      },
      onPanResponderTerminate: () => {
        setDragDx(0);
        Animated.spring(translateX, { toValue: 0, ...t.motion.spring }).start();
      },
    })
  ).current;

  const revealing = dragDx > 0 ? leftAction : dragDx < 0 ? rightAction : null;
  const revealStrength = Math.min(1, Math.abs(dragDx) / TRIGGER_DISTANCE);

  return (
    <View style={[{ borderRadius: t.radius.lg, overflow: 'hidden' }, style]}>
      {revealing && (
        <View
          pointerEvents="none"
          style={{
            ...(dragDx > 0 ? { alignItems: 'flex-start' } : { alignItems: 'flex-end' }),
            position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
            backgroundColor: revealing.color, justifyContent: 'center', paddingHorizontal: t.space.lg,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, opacity: 0.4 + revealStrength * 0.6 }}>
            {dragDx < 0 && <AppText variant="small" style={{ color: '#fff', fontWeight: '700' }}>{revealing.label}</AppText>}
            <Icon name={revealing.icon} size={18} color="#fff" />
            {dragDx > 0 && <AppText variant="small" style={{ color: '#fff', fontWeight: '700' }}>{revealing.label}</AppText>}
          </View>
        </View>
      )}
      <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateX }] }}>
        {children}
      </Animated.View>
    </View>
  );
};
