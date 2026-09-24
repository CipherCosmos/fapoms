import React from 'react';
import { StyleSheet, View } from 'react-native';
import { colors, radii, space } from '../theme/tokens';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type ChipTone = 'success' | 'info' | 'danger' | 'accent' | 'neutral';

const TONES: Record<ChipTone, { bg: string; fg: string; icon: IconName }> = {
  success: { bg: colors.successSoft, fg: colors.success, icon: 'checkmark-circle' },
  info: { bg: colors.infoSoft, fg: colors.info, icon: 'information-circle' },
  danger: { bg: colors.dangerSoft, fg: colors.danger, icon: 'alert-circle' },
  accent: { bg: colors.accentSoft, fg: colors.accent, icon: 'ellipse' },
  neutral: { bg: colors.disabledFill, fg: colors.ink, icon: 'ellipse-outline' },
};

/** A status label: tint + icon + word. Not pressable. */
export const Chip: React.FC<{ label: string; tone?: ChipTone; icon?: IconName }> = ({ label, tone = 'neutral', icon }) => {
  const c = TONES[tone];
  return (
    <View style={[styles.chip, { backgroundColor: c.bg }]} accessible accessibilityLabel={label}>
      <Icon name={icon ?? c.icon} size={18} rawColor={c.fg} />
      <Text variant="label" style={{ color: c.fg }}>
        {label}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xxs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xxs,
    borderRadius: radii.pill,
  },
});
