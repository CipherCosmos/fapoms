import React, { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useT } from '../i18n/I18nProvider';
import { colors, radii, space, touch } from '../theme/tokens';
import { Icon, type IconName } from './Icon';
import { createTapGuard } from './logic';
import { Text } from './Text';

export type ButtonVariant = 'main' | 'quiet' | 'success' | 'danger';

export interface ButtonProps {
  label: string;
  icon?: IconName;
  variant?: ButtonVariant;
  /** May return a promise; while it runs the button shows "busy" and ignores further taps. */
  onPress: () => unknown;
  disabled?: boolean;
  /** Force the busy state from outside (e.g. a parent's own request). */
  busy?: boolean;
  size?: 'regular' | 'large';
  /** Read after the label by screen readers: what will happen, or why it is disabled. */
  accessibilityHint?: string;
  testID?: string;
}

const FILL: Record<ButtonVariant, { bg: string; pressed: string; fg: string; border?: string }> = {
  main: { bg: colors.accent, pressed: colors.accentPressed, fg: colors.onAccent },
  success: { bg: colors.success, pressed: '#145A33', fg: '#FFFFFF' },
  danger: { bg: colors.danger, pressed: '#8E1B12', fg: '#FFFFFF' },
  quiet: { bg: colors.surface, pressed: colors.pressed, fg: colors.accent, border: colors.line },
};

/**
 * Icon + word, full width, 56–60 tall. One `main` per screen is the rule the design sets.
 */
export const Button: React.FC<ButtonProps> = ({
  label,
  icon,
  variant = 'main',
  onPress,
  disabled,
  busy: busyProp,
  size = 'regular',
  accessibilityHint,
  testID,
}) => {
  const t = useT();
  const [busyInternal, setBusyInternal] = useState(false);
  // One guard for the component's life: a re-render mid-request must not reset "busy".
  const guardRef = useRef(createTapGuard(setBusyInternal));
  const busy = busyProp || busyInternal;
  const inactive = disabled || busy;
  const fill = disabled ? { bg: colors.disabledFill, pressed: colors.disabledFill, fg: colors.disabledInk } : FILL[variant];

  const handlePress = useMemo(
    () => () => {
      if (inactive) return;
      void guardRef.current.run(onPress).catch(() => undefined);
    },
    [inactive, onPress],
  );

  return (
    <Pressable
      testID={testID}
      onPress={handlePress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={busy ? t('a11y.busy') : accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: size === 'large' ? touch.buttonLarge : touch.button,
          backgroundColor: pressed && !inactive ? fill.pressed : fill.bg,
          borderColor: disabled ? colors.disabledFill : FILL[variant].border ?? 'transparent',
        },
      ]}
    >
      <View style={styles.row}>
        {busy ? (
          <ActivityIndicator color={fill.fg} />
        ) : icon ? (
          <Icon name={icon} size={24} rawColor={fill.fg} />
        ) : null}
        <Text variant="button" style={{ color: fill.fg, flexShrink: 1 }} align="center">
          {label}
        </Text>
      </View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  base: {
    width: '100%',
    borderRadius: radii.md,
    borderWidth: 1.5,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    justifyContent: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs },
});
