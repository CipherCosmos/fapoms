import React, { useEffect, useRef, useState } from 'react';
import { Animated, BackHandler, Dimensions, Modal, PanResponder, ScrollView, StyleProp, View, ViewStyle } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { AppText, Icon, Tappable } from './primitives';
import { TOP_INSET } from './AppShell';

/**
 * A minimal push/pop stack, built from `Animated`/`PanResponder`/`View` — all pure JS, already
 * in React Native core. The obvious tool for "tap a settings row, slide to its own screen" is
 * `@react-navigation/native-stack`, but even the JS (non-native) stack pulls in
 * `react-native-gesture-handler` as a peer dependency, and gesture-handler is a native module.
 * Adding one changes the app's native fingerprint, which is exactly what this project spent this
 * session avoiding (see scripts/publish-ota.sh and the same reasoning in SwipeableRow.tsx) so
 * that a JS-only change like "profile screen navigation" ships over OTA in about a minute instead
 * of triggering a 15-40 minute native rebuild. A single-level push stack for one screen's own
 * sub-pages does not need a routing library at all — this is the whole surface area it needs.
 */
export function useStackNav() {
  const [stack, setStack] = useState<string[]>([]);
  const push = (key: string) => setStack((s) => [...s, key]);
  const pop = () => setStack((s) => s.slice(0, -1));
  const current = stack.length > 0 ? stack[stack.length - 1] : null;
  return { stack, push, pop, current };
}

const SCREEN_W = Dimensions.get('window').width;
/** How close to the left bezel a touch must start to count as the iOS edge-back gesture, rather
 *  than a drag over the sub-screen's own content (a horizontal ScrollView, a slider, etc). */
const EDGE_ZONE = 24;

interface SubScreenProps {
  /** Whether this sub-screen is the one currently on top of the stack. Controls both the slide
   *  animation and whether it consumes the hardware back button. */
  active: boolean;
  title: string;
  onBack: () => void;
  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

/**
 * One pushed screen: slides in from the right when it becomes active, slides back out on pop.
 *
 * Rendered through a `Modal`, not as a `position: absolute` overlay inside the scrolling
 * content it used to sit in. That first version anchored `top: 0` to ProfileScreen's own box,
 * which is itself a child of App.tsx's single shared vertical ScrollView — so the overlay's
 * position was relative to wherever Profile happened to be scrolled to, not to the actual
 * screen. Scroll down at all inside Profile before pushing a row, and the sub-screen's own back
 * header rendered scrolled away above the visible viewport — indistinguishable from "the page
 * is stuck under the app's header," which is exactly the bug this was. A `Modal` renders on its
 * own native layer, entirely outside the ScrollView's layout and scroll offset, so this problem
 * cannot recur regardless of where the root list was scrolled to. It also now correctly covers
 * the app's TopBar/tab dock while open, the way a real sub-screen should — the previous overlay
 * sat underneath both of those, a second header-like bar always visible above it.
 *
 * Kept mounted slightly past `active` going false (`mounted` state) purely so the exit slide has
 * something to animate — `Modal`'s `visible` prop has no transition of its own here
 * (`animationType="none"`; the slide is done by hand on `translateX` to match the edge-swipe).
 */
export const SubScreen: React.FC<SubScreenProps> = ({ active, title, onBack, trailing, style, children }) => {
  const t = useTheme();
  const translateX = useRef(new Animated.Value(SCREEN_W)).current;
  const [mounted, setMounted] = useState(active);

  useEffect(() => {
    if (active) {
      setMounted(true);
      translateX.setValue(SCREEN_W);
      Animated.timing(translateX, { toValue: 0, duration: t.motion.base, useNativeDriver: true }).start();
    } else if (mounted) {
      Animated.timing(translateX, { toValue: SCREEN_W, duration: t.motion.base, useNativeDriver: true })
        .start(() => setMounted(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Android hardware back (and the Android gesture-nav back swipe, which also fires
  // hardwareBackPress) pops this sub-screen instead of falling through to App.tsx's own
  // `hardwareBackPress` listener, which otherwise jumps straight to the Home tab — see App.tsx's
  // comment on its own listener for the precedence chain this has to sit in front of. Registering
  // a second listener is safe: RN calls listeners most-recently-added-first and stops at the
  // first one that returns true, so this one simply gets first refusal while it's mounted and
  // active, and App.tsx's listener is untouched and still runs once this unmounts or steps aside.
  useEffect(() => {
    if (!active) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [active, onBack]);

  // Swipe-from-left-edge to go back, the iOS convention. Gated to gesture.x0 < EDGE_ZONE so it
  // only claims touches that start right at the bezel — a sub-screen's own content (form fields,
  // horizontal scrollers) keeps normal touch behaviour everywhere else. Bubble-phase
  // `onMoveShouldSetPanResponder`, not `...Capture`, matching the convention established in
  // useSwipeSegments.ts: the deepest node (whatever this sub-screen renders) gets first refusal,
  // and this responder only activates for gestures nothing more specific already claimed.
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) =>
        gesture.x0 < EDGE_ZONE && gesture.dx > 24 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
      onPanResponderMove: (_, gesture) => {
        translateX.setValue(Math.max(0, gesture.dx));
      },
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dx > 80) {
          onBack();
        } else {
          Animated.timing(translateX, { toValue: 0, duration: t.motion.fast, useNativeDriver: true }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.timing(translateX, { toValue: 0, duration: t.motion.fast, useNativeDriver: true }).start();
      },
    })
  ).current;

  if (!mounted) return null;

  return (
    <Modal visible={mounted} transparent={false} animationType="none" onRequestClose={onBack} statusBarTranslucent>
      {/*
       * A plain, non-animated backdrop the full size of the Modal's window, painted BEFORE the
       * sliding panel. `translateX` starts off-screen (at `SCREEN_W`) and animates in over
       * `t.motion.base` — for that whole duration, the area the panel hasn't slid into yet was
       * showing whatever's behind it, which for a `transparent={false}` Modal on Android is the
       * native window's own default white background, not this app's theme. That's the "white
       * screen for a while" on every sub-page open: not a loading delay, the animation itself
       * revealing an unpainted backdrop the entire time it ran. Themed backdrop underneath fixes
       * it regardless of slide progress.
       */}
      <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
      <Animated.View
        {...panResponder.panHandlers}
        style={[
          { flex: 1, backgroundColor: t.colors.bg, transform: [{ translateX }] },
          style,
        ]}
      >
        {/*
         * `paddingTop: TOP_INSET`, the same constant AppShell's own TopBar uses — without it
         * the header sat right at y=0 of the Modal's window. `statusBarTranslucent` (below) lets
         * this Modal draw behind the status bar rather than have Android push its whole window
         * down and re-flow everything on open/close, but that means THIS view is now the one
         * responsible for clearing the status bar/notch itself. Without this padding the back
         * arrow and title rendered underneath the status bar — invisible, not merely misplaced —
         * which is indistinguishable from "the header disappeared" to whoever's holding the
         * phone, exactly the report this fixes.
         */}
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: t.space.sm,
          paddingTop: TOP_INSET, paddingHorizontal: t.space.sm, paddingBottom: t.space.md,
          borderBottomWidth: 1, borderBottomColor: t.colors.border,
        }}>
          <Tappable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}>
            <View style={{ flexDirection: 'row', alignItems: 'center', padding: t.space.sm }}>
              <Icon name="chevron-back" size={22} color={t.colors.primary} />
            </View>
          </Tappable>
          <AppText variant="h3" numberOfLines={1} style={{ flex: 1 }}>{title}</AppText>
          {trailing}
        </View>
        {/*
         * A ScrollView of its own: content taller than one viewport (Notifications' category
         * toggles, Security & Biometrics, Accreditation) needs somewhere to scroll to. No
         * padding here — every call site already wraps its own children in a padded/gapped View
         * (see ProfileScreen.tsx's `<SubScreen>` usages), so adding it here too would double it.
         */}
        <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </Animated.View>
      </View>
    </Modal>
  );
};
