import React from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';
import { colors, radii, space } from '../theme/tokens';

/**
 * A surface on the ground. Use sparingly — the job-now card, the bill-ready card — and never one
 * inside another: grouping inside a card is done with space and hairlines, not more boxes.
 */
export const Card: React.FC<ViewProps & { tone?: 'plain' | 'accent' }> = ({ style, tone = 'plain', ...rest }) => (
  <View
    {...rest}
    style={[styles.card, tone === 'accent' && { borderColor: colors.accent, borderWidth: 2 }, style]}
  />
);

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.md,
    gap: space.sm,
  },
});
