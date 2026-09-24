import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  EMPTY_DATE_OF_BIRTH,
  assembleDateOfBirth,
  chooseDatePart,
  daysInMonth,
  splitDateOfBirth,
  type DateOfBirthParts,
} from '../../screens/self-registration/date-of-birth';
import { useT } from '../i18n/I18nProvider';
import { monthName } from '../i18n/format';
import { space } from '../theme/tokens';
import { Icon } from './Icon';
import { Picker } from './Picker';
import { Text } from './Text';

export interface DateFieldProps {
  label: string;
  /** `YYYY-MM-DD` or null. */
  value: string | null;
  /** Called with a whole date only — a half-chosen date is never passed out. */
  onChange: (value: string | null) => void;
  /** Years offered, newest first by default. */
  years: readonly number[];
  error?: string | null;
  showIncomplete?: boolean;
}

/**
 * Day / Month / Year as three pickers — the rule the registration form already proved: typed
 * dates get misread (21-04-1990 became the year 21), three lists cannot be. The day-count and
 * "a day the month does not have is cleared, not moved" logic is the registration form's own
 * (`date-of-birth.ts`), reused rather than repeated.
 */
export const DateField: React.FC<DateFieldProps> = ({ label, value, onChange, years, error, showIncomplete }) => {
  const t = useT();
  const [parts, setParts] = useState<DateOfBirthParts>(() => (value ? splitDateOfBirth(value) : { ...EMPTY_DATE_OF_BIRTH }));

  // A new value from outside (a record loaded) replaces what is on screen.
  useEffect(() => {
    if (value && value !== assembleDateOfBirth(parts)) setParts(splitDateOfBirth(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const dayCount = daysInMonth(Number(parts.month) || 0, Number(parts.year) || null);
  const dayOptions = useMemo(
    () => Array.from({ length: dayCount }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
    [dayCount],
  );
  const monthOptions = useMemo(
    () => Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: monthName(t, i), keywords: [String(i + 1)] })),
    [t],
  );
  const yearOptions = useMemo(() => years.map((y) => ({ value: String(y), label: String(y) })), [years]);

  const choose = (part: keyof DateOfBirthParts, v: string) => {
    const next = chooseDatePart(parts, part, v);
    setParts(next);
    onChange(assembleDateOfBirth(next));
  };

  const incomplete = showIncomplete && !assembleDateOfBirth(parts);
  const message = error || (incomplete ? t('dateField.incomplete') : null);

  return (
    <View style={styles.wrap} accessibilityRole="none">
      <Text variant="label">{label}</Text>
      <View style={styles.row}>
        <View style={styles.day}>
          <Picker label={t('dateField.day')} value={parts.day || null} options={dayOptions} onChange={(v) => choose('day', v)} placeholder="—" />
        </View>
        <View style={styles.month}>
          <Picker label={t('dateField.month')} value={parts.month || null} options={monthOptions} onChange={(v) => choose('month', v)} placeholder="—" />
        </View>
        <View style={styles.year}>
          <Picker label={t('dateField.year')} value={parts.year || null} options={yearOptions} onChange={(v) => choose('year', v)} placeholder="—" />
        </View>
      </View>
      {message ? (
        <View style={styles.msg} accessibilityLiveRegion="polite">
          <Icon name="alert-circle" size={20} color="danger" />
          <Text variant="secondary" color="danger" style={styles.flex}>
            {message}
          </Text>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { gap: space.xxs },
  row: { flexDirection: 'row', gap: space.xs, flexWrap: 'wrap' },
  day: { flexGrow: 1, flexBasis: 80 },
  month: { flexGrow: 2, flexBasis: 140 },
  year: { flexGrow: 1, flexBasis: 100 },
  msg: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xxs },
  flex: { flex: 1 },
});
