import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '../i18n/I18nProvider';
import { colors, motion, radii, space } from '../theme/tokens';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

/**
 * Short confirmations near the bottom of the screen:
 *  - `done`   — "Done ✓": the server has it.
 *  - `saved`  — "Saved on your phone": written down, will send by itself (queued, no signal).
 *  - `error`  — something needs attention, in words.
 * Announced to screen readers as well as shown.
 */
export type ToastKind = 'done' | 'saved' | 'error';

interface ToastMessage {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
}

interface ToastApi {
  show: (kind: ToastKind, title?: string, body?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const LOOK: Record<ToastKind, { bg: string; icon: IconName }> = {
  done: { bg: colors.success, icon: 'checkmark-circle' },
  saved: { bg: colors.info, icon: 'phone-portrait' },
  error: { bg: colors.danger, icon: 'alert-circle' },
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const t = useT();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const [current, setCurrent] = useState<ToastMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const show = useCallback(
    (kind: ToastKind, title?: string, body?: string) => {
      const resolved =
        title ?? (kind === 'done' ? t('common.done') : kind === 'saved' ? t('common.savedOnPhone') : t('common.somethingWrong'));
      const resolvedBody = body ?? (kind === 'saved' && !title ? t('common.savedOnPhoneBody') : undefined);
      seq.current += 1;
      setCurrent({ id: seq.current, kind, title: resolved, body: resolvedBody });
      AccessibilityInfo.announceForAccessibility([resolved, resolvedBody].filter(Boolean).join('. '));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCurrent(null), motion.toastMs + (resolvedBody ? 1500 : 0));
    },
    [t],
  );

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <View pointerEvents="none" style={[styles.host, { bottom: insets.bottom + 88 }]}>
        {current ? (
          <Animated.View
            key={current.id}
            entering={reduceMotion ? undefined : FadeInDown.duration(motion.base)}
            exiting={reduceMotion ? undefined : FadeOutDown.duration(motion.fast)}
            style={[styles.toast, { backgroundColor: LOOK[current.kind].bg }]}
            accessibilityLiveRegion="polite"
          >
            <Icon name={LOOK[current.kind].icon} rawColor="#FFFFFF" />
            <View style={styles.flex}>
              <Text variant="bodyStrong" style={styles.white}>
                {current.title}
              </Text>
              {current.body ? (
                <Text variant="secondary" style={styles.white}>
                  {current.body}
                </Text>
              ) : null}
            </View>
          </Animated.View>
        ) : null}
      </View>
    </ToastContext.Provider>
  );
};

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: space.md, right: space.md },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radii.md,
  },
  flex: { flex: 1 },
  white: { color: '#FFFFFF' },
});
