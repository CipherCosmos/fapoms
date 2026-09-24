import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useT } from '../i18n/I18nProvider';
import { colors, space, touch } from '../theme/tokens';
import { Icon } from './Icon';
import { Text } from './Text';

/**
 * A detail HR has verified: shown, not editable, and it says who checked it. When HR asks for it
 * again (`FieldGate.mode === 'reopened'`), the screen shows a TextField instead of this.
 */
export const LockedField: React.FC<{ label: string; value?: string | null }> = ({ label, value }) => {
  const t = useT();
  const shown = value && value.trim() ? value : t('common.notSet');
  return (
    <View style={styles.wrap} accessible accessibilityLabel={t('a11y.locked', { label, value: shown })}>
      <Text variant="label" color="inkSecondary">
        {label}
      </Text>
      <View style={styles.row}>
        <Text variant="body" style={styles.value}>
          {shown}
        </Text>
        <Icon name="lock-closed" size={20} color="inkSecondary" />
      </View>
      <View style={styles.note}>
        <Icon name="shield-checkmark" size={18} color="success" />
        <Text variant="secondary" color="success">
          {t('me.lockedByHr')}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { gap: space.xxs, paddingVertical: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  row: { minHeight: touch.minTarget, flexDirection: 'row', alignItems: 'center', gap: space.xs },
  value: { flex: 1 },
  note: { flexDirection: 'row', alignItems: 'center', gap: space.xxs },
});
