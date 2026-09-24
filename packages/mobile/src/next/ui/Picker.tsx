import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useI18n, useT } from '../i18n/I18nProvider';
import { colors, radii, space, touch } from '../theme/tokens';
import { MAX_FONT_SCALE, fontFamilyFor, type } from '../theme/typography';
import { Icon } from './Icon';
import { SEARCH_THRESHOLD, filterOptions, selectedIndex, type PickerOption } from './logic';
import { Sheet } from './Sheet';
import { Text, useLoadedFonts } from './Text';

export interface PickerProps<V extends string> {
  label: string;
  value: V | null;
  options: readonly PickerOption<V>[];
  onChange: (value: V) => void;
  /** Shown in the field when nothing is chosen. */
  placeholder?: string;
  error?: string | null;
  disabled?: boolean;
  /** Force the search box on or off; by default it appears for lists longer than 8. */
  searchable?: boolean;
  testID?: string;
}

const ROW = touch.row;

/**
 * A field that opens a sheet list. Long lists get a search box; the list opens scrolled to the
 * current choice, so "1987" in a list of years is not a long scroll away.
 */
export function Picker<V extends string>({
  label,
  value,
  options,
  onChange,
  placeholder,
  error,
  disabled,
  searchable,
  testID,
}: PickerProps<V>): React.ReactElement {
  const t = useT();
  const { language } = useI18n();
  const fonts = useLoadedFonts();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const showSearch = searchable ?? options.length > SEARCH_THRESHOLD;
  const shown = useMemo(() => filterOptions(options, query), [options, query]);
  const current = options.find((o) => o.value === value);
  const startAt = query ? 0 : selectedIndex(shown, value);

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  return (
    <View style={styles.wrap}>
      <Text variant="label">{label}</Text>
      <Pressable
        testID={testID}
        disabled={disabled}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${current?.label ?? placeholder ?? t('common.choose')}`}
        accessibilityHint={t('picker.choose', { label })}
        accessibilityState={{ disabled: !!disabled }}
        style={({ pressed }) => [
          styles.field,
          pressed && { backgroundColor: colors.pressed },
          !!error && { borderColor: colors.danger, borderWidth: 2 },
          disabled && { backgroundColor: colors.disabledFill },
        ]}
      >
        <Text variant="body" color={current ? 'ink' : 'inkSecondary'} style={styles.flex}>
          {current?.label ?? placeholder ?? t('common.choose')}
        </Text>
        <Icon name="chevron-down" color="inkSecondary" />
      </Pressable>
      {error ? (
        <View style={styles.msg} accessibilityLiveRegion="polite">
          <Icon name="alert-circle" size={20} color="danger" />
          <Text variant="secondary" color="danger" style={styles.flex}>
            {error}
          </Text>
        </View>
      ) : null}

      <Sheet visible={open} onClose={close} title={label} tall={options.length > SEARCH_THRESHOLD}>
        {showSearch ? (
          <View style={styles.search}>
            <Icon name="search" color="inkSecondary" />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t('picker.searchPlaceholder')}
              placeholderTextColor={colors.inkSecondary}
              accessibilityLabel={t('picker.searchLabel')}
              autoCorrect={false}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              style={[styles.searchInput, { fontSize: type.body.fontSize, fontFamily: fontFamilyFor(language, 'regular', fonts) }]}
            />
          </View>
        ) : null}
        <FlatList
          data={shown}
          keyExtractor={(o) => o.value}
          keyboardShouldPersistTaps="handled"
          initialScrollIndex={shown.length > 0 ? Math.min(startAt, shown.length - 1) : undefined}
          getItemLayout={(_, index) => ({ length: ROW, offset: ROW * index, index })}
          ListEmptyComponent={
            <Text variant="secondary" style={styles.empty}>
              {t('picker.noMatches', { query })}
            </Text>
          }
          renderItem={({ item }) => {
            const selected = item.value === value;
            return (
              <Pressable
                onPress={() => {
                  onChange(item.value);
                  close();
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected, checked: selected }}
                accessibilityLabel={item.label}
                style={({ pressed }) => [styles.row, selected && { backgroundColor: colors.accentSoft }, pressed && { backgroundColor: colors.pressed }]}
              >
                <Text variant={selected ? 'bodyStrong' : 'body'} numberOfLines={1} style={styles.flex}>
                  {item.label}
                </Text>
                {selected ? <Icon name="checkmark" color="accent" /> : null}
              </Pressable>
            );
          }}
        />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xxs },
  flex: { flex: 1 },
  field: {
    minHeight: touch.field,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    borderWidth: 1.5,
    borderColor: colors.lineStrong,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  msg: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xxs },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: touch.field,
    paddingHorizontal: space.sm,
    borderWidth: 1.5,
    borderColor: colors.lineStrong,
    borderRadius: radii.md,
    marginBottom: space.xs,
  },
  searchInput: { flex: 1, minHeight: touch.field, color: colors.ink },
  row: {
    height: ROW,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    borderRadius: radii.sm,
  },
  empty: { padding: space.md },
});
