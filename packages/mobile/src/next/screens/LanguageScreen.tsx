import React, { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useI18n } from '../i18n/I18nProvider';
import { ALL_SCRIPTS, APP_LANGUAGES, LANGUAGE_FACTS } from '../i18n/languages';
import { loadScripts } from '../theme/fonts';
import { colors, radii, space, touch } from '../theme/tokens';
import { Button, Icon, Screen, Text } from '../ui';

/**
 * First launch: choose the language. Each name is written in its own script (so a Tamil reader
 * finds "தமிழ்" without reading English) with the English name under it. English is preselected.
 */
export const LanguageScreen: React.FC = () => {
  const { language, setLanguage, confirmLanguage, t } = useI18n();

  // Every script's font, so each name draws in its own face.
  useEffect(() => {
    void loadScripts(ALL_SCRIPTS);
  }, []);

  return (
    <Screen
      title={t('language.title')}
      subtitle={t('language.subtitle')}
      footer={<Button label={t('common.continue')} icon="arrow-forward" size="large" onPress={confirmLanguage} />}
    >
      <View accessibilityRole="radiogroup" style={styles.list}>
        {APP_LANGUAGES.map((code) => {
          const facts = LANGUAGE_FACTS[code];
          const selected = code === language;
          return (
            <Pressable
              key={code}
              onPress={() => setLanguage(code)}
              accessibilityRole="radio"
              accessibilityState={{ selected, checked: selected }}
              accessibilityLabel={code === 'en' ? facts.nativeName : `${facts.nativeName}, ${facts.englishName}`}
              style={({ pressed }) => [
                styles.row,
                selected && styles.selected,
                pressed && !selected && { backgroundColor: colors.pressed },
              ]}
            >
              <View style={styles.flex}>
                <Text variant="title" language={code}>
                  {facts.nativeName}
                </Text>
                {code !== 'en' ? (
                  <Text variant="secondary" language="en">
                    {facts.englishName}
                  </Text>
                ) : null}
              </View>
              <Icon name={selected ? 'radio-button-on' : 'radio-button-off'} size={28} color={selected ? 'accent' : 'inkSecondary'} />
            </Pressable>
          );
        })}
      </View>
    </Screen>
  );
};

const styles = StyleSheet.create({
  list: { gap: space.xs },
  row: {
    minHeight: touch.row + 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  selected: { borderColor: colors.accent, borderWidth: 2, backgroundColor: colors.accentSoft },
  flex: { flex: 1 },
});
