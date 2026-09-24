import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../i18n/I18nProvider';
import { APP_LANGUAGES, LANGUAGE_FACTS, type AppLanguage } from '../i18n/languages';
import { space } from '../theme/tokens';
import { Button, LockedField, Picker, Screen, Text } from '../ui';

/**
 * FOUNDATION placeholder for Me: name and code (from the session), the language — the app's only
 * setting — and sign-out. The real tab (next phase) adds the ID card, verified details locked
 * "Checked by HR" from `GET /assayers/me/capabilities`, and "HR asked you to update X".
 */
export const MeScreen: React.FC = () => {
  const { t, language, setLanguage } = useI18n();
  const { user, logout } = useAuth();
  const options = useMemo(
    () =>
      APP_LANGUAGES.map((code) => ({
        value: code,
        label: code === 'en' ? LANGUAGE_FACTS[code].nativeName : `${LANGUAGE_FACTS[code].nativeName} · ${LANGUAGE_FACTS[code].englishName}`,
        keywords: [LANGUAGE_FACTS[code].englishName],
      })),
    [],
  );

  return (
    <Screen title={t('me.title')} footer={<Button label={t('common.signOut')} icon="log-out-outline" variant="quiet" onPress={logout} />}>
      <Text variant="heading">{user?.name ?? ''}</Text>
      <View style={styles.block}>
        {user?.assayerCode ? <LockedField label={t('me.code')} value={user.assayerCode} /> : null}
        <Picker<AppLanguage> label={t('me.language')} value={language} options={options} onChange={setLanguage} searchable={false} />
      </View>
      <Text variant="secondary">{t('me.placeholderBody')}</Text>
    </Screen>
  );
};

const styles = StyleSheet.create({
  block: { gap: space.md },
});
