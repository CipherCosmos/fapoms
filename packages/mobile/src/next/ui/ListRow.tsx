import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { colors, space, touch } from '../theme/tokens';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  /** Right-hand text, e.g. the current language. */
  value?: string;
  icon?: IconName;
  onPress?: () => void;
  /** Draw the hairline under the row (off for the last row). */
  divider?: boolean;
  accessibilityHint?: string;
}

/** A plain row: icon, words, value, chevron when it goes somewhere. 64 tall, one tap target. */
export const ListRow: React.FC<ListRowProps> = ({ title, subtitle, value, icon, onPress, divider = true, accessibilityHint }) => {
  const content = (
    <View style={[styles.row, divider && styles.divider]}>
      {icon ? <Icon name={icon} color="inkSecondary" /> : null}
      <View style={styles.text}>
        <Text variant="bodyStrong">{title}</Text>
        {subtitle ? <Text variant="secondary">{subtitle}</Text> : null}
      </View>
      {value ? <Text variant="secondary">{value}</Text> : null}
      {onPress ? <Icon name="chevron-forward" color="inkSecondary" /> : null}
    </View>
  );
  if (!onPress) {
    return (
      <View accessible accessibilityLabel={[title, subtitle, value].filter(Boolean).join(', ')}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[title, subtitle, value].filter(Boolean).join(', ')}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [pressed && { backgroundColor: colors.pressed }]}
    >
      {content}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  row: { minHeight: touch.row, flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  text: { flex: 1 },
});
