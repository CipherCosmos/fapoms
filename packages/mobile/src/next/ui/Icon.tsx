import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, type ColorToken } from '../theme/tokens';

/**
 * The one icon set: Ionicons, which the current app already ships (its font is in every build).
 * Icons are decoration next to a word, so they are hidden from screen readers by default.
 */
export type IconName = React.ComponentProps<typeof Ionicons>['name'];

export const Icon: React.FC<{ name: IconName; size?: number; color?: ColorToken; rawColor?: string }> = ({
  name,
  size = 24,
  color = 'ink',
  rawColor,
}) => (
  <Ionicons
    name={name}
    size={size}
    color={rawColor ?? colors[color]}
    accessible={false}
    importantForAccessibility="no"
  />
);
