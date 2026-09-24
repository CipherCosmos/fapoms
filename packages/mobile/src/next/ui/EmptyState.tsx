import React from 'react';
import { StyleSheet, View } from 'react-native';
import { colors, radii, space } from '../theme/tokens';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

/** Nothing to show: say why and, when there is one, what to do. */
export const EmptyState: React.FC<{
  icon: IconName;
  title: string;
  body?: string;
  actionLabel?: string;
  actionIcon?: IconName;
  onAction?: () => unknown;
}> = ({ icon, title, body, actionLabel, actionIcon, onAction }) => (
  <View style={styles.wrap}>
    <View style={styles.badge}>
      <Icon name={icon} size={36} color="inkSecondary" />
    </View>
    <Text variant="title" align="center" accessibilityRole="header">
      {title}
    </Text>
    {body ? (
      <Text variant="secondary" align="center">
        {body}
      </Text>
    ) : null}
    {actionLabel && onAction ? (
      <View style={styles.action}>
        <Button label={actionLabel} icon={actionIcon} variant="quiet" onPress={onAction} />
      </View>
    ) : null}
  </View>
);

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingVertical: space.xl, paddingHorizontal: space.md, gap: space.sm },
  badge: {
    width: 72,
    height: 72,
    borderRadius: radii.pill,
    backgroundColor: colors.disabledFill,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  action: { alignSelf: 'stretch', marginTop: space.xs },
});
