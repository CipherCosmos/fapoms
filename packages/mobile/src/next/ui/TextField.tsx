import React, { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View, type KeyboardTypeOptions, type TextInputProps } from 'react-native';
import { useI18n, useT } from '../i18n/I18nProvider';
import { colors, radii, space, touch } from '../theme/tokens';
import { MAX_FONT_SCALE, fontFamilyFor, type } from '../theme/typography';
import { Icon } from './Icon';
import { fieldIssueKey, normaliseField } from './logic';
import { Text, useLoadedFonts } from './Text';

export interface TextFieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  hint?: string;
  /** A problem from outside (the server said no). Shown in place of the field's own check. */
  error?: string | null;
  required?: boolean;
  maxLength?: number;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  autoComplete?: TextInputProps['autoComplete'];
  textContentType?: TextInputProps['textContentType'];
  secureTextEntry?: boolean;
  /**
   * Which shared rule checks this field (`panNumber`, `ifscCode`, `aadhaarNumber`, `pincode`,
   * `bankAccountNumber`, `phone`…) — the same rules the web form and the server use.
   */
  ruleKey?: string;
  /** Force the inline check to show now (e.g. after the form's main button was pressed). */
  showErrors?: boolean;
  returnKeyType?: TextInputProps['returnKeyType'];
  onSubmitEditing?: () => void;
  testID?: string;
}

/**
 * A labelled box. The label is always above (never a placeholder that vanishes when typing
 * starts); the problem, if any, is under it in words with an icon; a password gets a show/hide
 * button. The check runs when the person leaves the box, not on every keystroke, so a half-typed
 * number is not scolded.
 */
export const TextField: React.FC<TextFieldProps> = ({
  label,
  value,
  onChangeText,
  hint,
  error,
  required,
  maxLength,
  keyboardType,
  autoCapitalize = 'none',
  autoComplete,
  textContentType,
  secureTextEntry,
  ruleKey,
  showErrors,
  returnKeyType,
  onSubmitEditing,
  testID,
}) => {
  const t = useT();
  const { language } = useI18n();
  const fonts = useLoadedFonts();
  const [focused, setFocused] = useState(false);
  const [touched, setTouched] = useState(false);
  const [reveal, setReveal] = useState(false);

  const issue = touched || showErrors ? fieldIssueKey(value, { ruleKey, required, maxLength }) : null;
  const message = error || (issue ? t(issue, { max: maxLength ?? 0 }) : null);

  return (
    <View style={styles.wrap}>
      <Text variant="label">{label}</Text>
      <View
        style={[
          styles.box,
          focused && { borderColor: colors.accent, borderWidth: 2 },
          !!message && { borderColor: colors.danger, borderWidth: 2 },
        ]}
      >
        <TextInput
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setTouched(true);
            const tidy = normaliseField(value, ruleKey);
            if (tidy !== value) onChangeText(tidy);
          }}
          maxLength={maxLength}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoComplete={autoComplete}
          textContentType={textContentType}
          autoCorrect={false}
          secureTextEntry={secureTextEntry && !reveal}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
          accessibilityLabel={label}
          accessibilityHint={message ? t('a11y.error', { message }) : hint}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          placeholderTextColor={colors.inkSecondary}
          style={[
            styles.input,
            { fontSize: type.body.fontSize, fontFamily: fontFamilyFor(language, 'regular', fonts), color: colors.ink },
          ]}
        />
        {secureTextEntry ? (
          <Pressable
            onPress={() => setReveal((r) => !r)}
            style={styles.eye}
            accessibilityRole="button"
            accessibilityLabel={reveal ? t('login.hidePassword') : t('login.showPassword')}
          >
            <Icon name={reveal ? 'eye-off' : 'eye'} color="inkSecondary" />
          </Pressable>
        ) : null}
      </View>
      {message ? (
        <View style={styles.msg} accessibilityLiveRegion="polite">
          <Icon name="alert-circle" size={20} color="danger" />
          <Text variant="secondary" color="danger" style={styles.flex}>
            {message}
          </Text>
        </View>
      ) : hint ? (
        <Text variant="secondary">{hint}</Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { gap: space.xxs },
  box: {
    minHeight: touch.field,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: colors.lineStrong,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  input: { flex: 1, minHeight: touch.field, paddingHorizontal: space.md, paddingVertical: space.xs },
  eye: { width: touch.minTarget, height: touch.minTarget, alignItems: 'center', justifyContent: 'center' },
  msg: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xxs },
  flex: { flex: 1 },
});
