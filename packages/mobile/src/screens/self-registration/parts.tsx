import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { AppText, Button, Icon, type IconName } from '../../components/ui/primitives';
import { useT } from '../../i18n';

/** A group heading inside a step: icon, title, and an optional one-line note. */
export const GroupHeader: React.FC<{ icon: IconName; title: string; note?: string }> = ({ icon, title, note }) => {
  const t = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        <Icon name={icon} size={18} color={t.colors.primary} />
        <AppText variant="h3" style={{ flex: 1 }}>{title}</AppText>
      </View>
      {note ? <AppText variant="small" tone="muted">{note}</AppText> : null}
    </View>
  );
};

/**
 * A line the form says about an answer — what a lookup found, or what to check.
 * `busy` shows a spinner in place of the icon while a lookup is running.
 */
export const FieldNote: React.FC<{ text: string; tone?: 'info' | 'warning' | 'danger'; busy?: boolean }> = ({
  text, tone = 'info', busy,
}) => {
  const t = useTheme();
  const color = tone === 'warning' ? t.colors.warning : tone === 'danger' ? t.colors.danger : t.colors.primary;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
      {busy
        ? <ActivityIndicator size="small" color={t.colors.textMuted} style={{ transform: [{ scale: 0.7 }] }} />
        : <Icon name={tone === 'info' ? 'information-circle' : 'alert-circle'} size={14} color={color} style={{ marginTop: 1 }} />}
      <AppText variant="caption" style={{ flex: 1, color: busy ? t.colors.textMuted : color }}>{text}</AppText>
    </View>
  );
};

/**
 * Shares a row's width with its siblings. `Button`'s own `style` lands inside its press wrapper,
 * so `flex: 1` there never reaches the row; the wrapper has to be the row's child.
 */
export const Stretch: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <View style={{ flex: 1 }}>{children}</View>
);

/** Back and Continue at the foot of a step. `onBack` is omitted on the first step. */
export const StepFooter: React.FC<{
  onBack?: () => void;
  onContinue?: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
  continueLoading?: boolean;
}> = ({ onBack, onContinue, continueLabel, continueDisabled, continueLoading }) => {
  const t = useTheme();
  const tr = useT();
  return (
    <View style={{ flexDirection: 'row', gap: t.space.md, marginTop: t.space.sm }}>
      {onBack && (
        <Button label={tr('selfRegistration.steps.back')} icon="arrow-back" variant="neutral" size="lg" onPress={onBack} />
      )}
      {onContinue && (
        <Stretch>
          <Button
            label={continueLabel ?? tr('selfRegistration.steps.continue')}
            onPress={onContinue}
            disabled={continueDisabled}
            loading={continueLoading}
            size="lg"
            glow
            full
          />
        </Stretch>
      )}
    </View>
  );
};
