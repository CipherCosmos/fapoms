import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { View, Animated, Platform, Alert, Pressable } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { AppText, Icon } from './primitives';
import type { IconName } from './primitives';

export type Tone = 'success' | 'error' | 'warning' | 'info';

export interface Notice {
  id: number;
  tone: Tone;
  title: string;
  message?: string;
}

interface FeedbackApi {
  /** Transient status. Never blocks; stacks and auto-dismisses. */
  notify: (tone: Tone, title: string, message?: string) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
  /**
   * A real yes/no decision that must block.
   *
   * Kept on the OS dialog deliberately: a destructive or irreversible choice should
   * interrupt, and the platform dialog is what users already trust for that. The
   * problem was never Alert itself — it was using it to report routine status.
   */
  confirm: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
}

const FeedbackContext = createContext<FeedbackApi | null>(null);

/** How long each tone stays up. Errors linger; success gets out of the way. */
const DURATION: Record<Tone, number> = {
  success: 2600,
  info: 3000,
  warning: 4200,
  error: 5200,
};

const ICON: Record<Tone, IconName> = {
  success: 'checkmark-circle',
  error: 'alert-circle',
  warning: 'warning',
  info: 'information-circle',
};

export const FeedbackProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(1);
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  const dismiss = useCallback((id: number) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
    const timer = timers.current[id];
    if (timer) {
      clearTimeout(timer);
      delete timers.current[id];
    }
  }, []);

  const notify = useCallback(
    (tone: Tone, title: string, message?: string) => {
      const id = nextId.current++;
      // Capped at three so a burst of failures (a per-page upload loop, say) cannot
      // bury the screen in toasts.
      setNotices((prev) => [...prev.slice(-2), { id, tone, title, message }]);
      timers.current[id] = setTimeout(() => dismiss(id), DURATION[tone]);
    },
    [dismiss],
  );

  // Timers outlive the component if the app is closed mid-toast; clear them so a
  // dismissed provider cannot call setState after unmount.
  useEffect(
    () => () => {
      Object.values(timers.current).forEach(clearTimeout);
      timers.current = {};
    },
    [],
  );

  const api = useMemo<FeedbackApi>(
    () => ({
      notify,
      success: (t, m) => notify('success', t, m),
      error: (t, m) => notify('error', t, m),
      warning: (t, m) => notify('warning', t, m),
      info: (t, m) => notify('info', t, m),
      confirm: (title, message, confirmLabel = 'Confirm') =>
        new Promise<boolean>((resolve) => {
          Alert.alert(title, message, [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: confirmLabel, style: 'destructive', onPress: () => resolve(true) },
          ]);
        }),
    }),
    [notify],
  );

  return (
    <FeedbackContext.Provider value={api}>
      {children}
      <ToastStack notices={notices} onDismiss={dismiss} />
    </FeedbackContext.Provider>
  );
};

export function useFeedback(): FeedbackApi {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error('useFeedback must be used inside <FeedbackProvider>.');
  return ctx;
}

const ToastStack: React.FC<{ notices: Notice[]; onDismiss: (id: number) => void }> = ({
  notices,
  onDismiss,
}) => {
  const t = useTheme();
  if (notices.length === 0) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: Platform.OS === 'ios' ? 56 : 28,
        left: t.space.lg,
        right: t.space.lg,
        gap: t.space.sm,
        zIndex: 9999,
      }}
    >
      {notices.map((n) => (
        <Toast key={n.id} notice={n} onDismiss={() => onDismiss(n.id)} />
      ))}
    </View>
  );
};

const Toast: React.FC<{ notice: Notice; onDismiss: () => void }> = ({ notice, onDismiss }) => {
  const t = useTheme();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(anim, {
      toValue: 1,
      useNativeDriver: true,
      damping: 18,
      stiffness: 220,
    }).start();
  }, [anim]);

  const tint = t.colors[notice.tone === 'error' ? 'danger' : notice.tone];

  return (
    <Animated.View
      style={{
        opacity: anim,
        transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] }) }],
      }}
    >
      <Pressable
        onPress={onDismiss}
        accessibilityRole="alert"
        accessibilityLabel={`${notice.title}${notice.message ? `. ${notice.message}` : ''}`}
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: t.space.md,
          padding: t.space.md,
          borderRadius: t.radius.lg,
          backgroundColor: t.colors.surfaceAlt,
          borderLeftWidth: 3,
          borderLeftColor: tint,
          ...t.elevation(3),
        }}
      >
        <Icon name={ICON[notice.tone]} size={18} color={tint} />
        <View style={{ flex: 1, gap: 2 }}>
          <AppText variant="bodyStrong">{notice.title}</AppText>
          {notice.message ? (
            <AppText variant="small" tone="muted">
              {notice.message}
            </AppText>
          ) : null}
        </View>
      </Pressable>
    </Animated.View>
  );
};
