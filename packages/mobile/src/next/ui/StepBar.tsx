import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useT } from '../i18n/I18nProvider';
import { colors, radii, space } from '../theme/tokens';
import { Icon } from './Icon';
import { stepStates } from './logic';
import { Text } from './Text';

/**
 * The job's progress: Reached → Papers → Done. A done step is a green tick, the current one is
 * the accent, the rest are hollow. Each step says its state aloud; colour is never the only cue.
 */
export const StepBar: React.FC<{ steps: string[]; current: number }> = ({ steps, current }) => {
  const t = useT();
  const states = stepStates(steps.length, current);
  return (
    <View style={styles.row} accessibilityRole="progressbar">
      {steps.map((label, i) => {
        const state = states[i];
        const a11y = t(
          state === 'done' ? 'a11y.stepDone' : state === 'current' ? 'a11y.stepCurrent' : 'a11y.stepTodo',
          { index: i + 1, total: steps.length, label },
        );
        return (
          <View key={label} style={styles.step} accessible accessibilityLabel={a11y}>
            <View style={styles.markRow}>
              <View
                style={[
                  styles.dot,
                  state === 'done' && { backgroundColor: colors.success, borderColor: colors.success },
                  state === 'current' && { backgroundColor: colors.accent, borderColor: colors.accent },
                ]}
              >
                {state === 'done' ? <Icon name="checkmark" size={18} rawColor="#FFFFFF" /> : null}
                {state === 'current' ? <View style={styles.inner} /> : null}
              </View>
              {i < steps.length - 1 ? (
                <View style={[styles.line, state === 'done' && { backgroundColor: colors.success }]} />
              ) : null}
            </View>
            <Text variant={state === 'current' ? 'label' : 'secondary'} color={state === 'todo' ? 'inkSecondary' : 'ink'}>
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
};

const DOT = 28;
const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  step: { flex: 1, gap: space.xxs },
  markRow: { flexDirection: 'row', alignItems: 'center' },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inner: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.onAccent },
  line: { flex: 1, height: 3, marginHorizontal: space.xxs, backgroundColor: colors.line, borderRadius: 2 },
});
