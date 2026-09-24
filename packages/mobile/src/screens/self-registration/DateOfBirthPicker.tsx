import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { AppText, FieldLabel, SelectField } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import {
  MONTH_KEYS, assembleDateOfBirth, birthDayOptions, birthYearOptions, chooseDatePart, splitDateOfBirth,
  type DateOfBirthParts,
} from './date-of-birth';

/**
 * Date of birth as Day / Month / Year lists — nothing to type, nothing to misread.
 *
 * `onComplete` fires only with a whole `YYYY-MM-DD`; while a part is still unchosen the saved date
 * is left alone and `onIncomplete` clears the box on screen, so Next asks for the rest. Plain JS
 * lists (the same `SelectField` as every other choice on the form) — no native date picker.
 */
export const DateOfBirthPicker: React.FC<{
  value: string;
  error?: string;
  onComplete: (iso: string) => void;
  onIncomplete: () => void;
}> = ({ value, error, onComplete, onIncomplete }) => {
  const t = useTheme();
  const tr = useT();
  const [parts, setParts] = useState<DateOfBirthParts>(() => splitDateOfBirth(value));

  // A date arriving from outside (the saved application) is shown; a half-chosen one is kept.
  useEffect(() => {
    if (value && value !== assembleDateOfBirth(parts)) setParts(splitDateOfBirth(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const choose = (part: keyof DateOfBirthParts, picked: string) => {
    const next = chooseDatePart(parts, part, picked);
    setParts(next);
    const iso = assembleDateOfBirth(next);
    if (iso) onComplete(iso);
    else if (value) onIncomplete();
  };

  const close = tr('common.close');
  return (
    <View style={{ gap: t.space.sm }}>
      <FieldLabel>
        {tr('selfRegistration.form.dateOfBirth')}
        <AppText variant="caption" tone="danger"> *</AppText>
      </FieldLabel>
      <View style={{ flexDirection: 'row', gap: t.space.sm }}>
        <SelectField
          style={{ flex: 1 }}
          closeLabel={close}
          placeholder={tr('selfRegistration.form.dobDay')}
          value={parts.day}
          options={birthDayOptions(parts).map((d) => ({ value: String(d), label: String(d) }))}
          onChange={(v) => choose('day', v)}
        />
        <SelectField
          style={{ flex: 1.6 }}
          closeLabel={close}
          placeholder={tr('selfRegistration.form.dobMonth')}
          value={parts.month}
          options={MONTH_KEYS.map((key, i) => ({ value: String(i + 1), label: tr(key) }))}
          onChange={(v) => choose('month', v)}
        />
        <SelectField
          style={{ flex: 1.3 }}
          closeLabel={close}
          placeholder={tr('selfRegistration.form.dobYear')}
          value={parts.year}
          options={birthYearOptions().map((y) => ({ value: String(y), label: String(y) }))}
          onChange={(v) => choose('year', v)}
        />
      </View>
      {error ? <AppText variant="caption" tone="danger">{error}</AppText> : null}
    </View>
  );
};
