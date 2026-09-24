import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useAuth } from '../../context/AuthContext';
import { useT } from '../i18n/I18nProvider';
import { space } from '../theme/tokens';
import { Button, Icon, Screen, Text, TextField } from '../ui';

const NETWORKISH = /network|timed? ?out|timeout|fetch|unreachable|abort/i;

/**
 * Sign in with the code and password the office gave. Uses the existing `AuthContext.login`
 * (tokens in the keystore, queue ownership, session epoch) — no parallel auth. There is no
 * server-address box: the address is fixed at build time.
 */
export const LoginScreen: React.FC = () => {
  const t = useT();
  const { login } = useAuth();
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const submit = async () => {
    setTried(true);
    setError(null);
    if (!id.trim() || !password) return;
    const res = await login(id.trim(), password);
    if (!res.success) {
      setError(NETWORKISH.test(res.error ?? '') ? t('login.noSignal') : t('login.failed'));
    }
  };

  return (
    <Screen
      title={t('login.title')}
      subtitle={t('login.subtitle')}
      footer={<Button label={t('login.submit')} icon="log-in-outline" size="large" onPress={submit} testID="login-submit" />}
    >
      <View style={styles.form}>
        <TextField
          label={t('login.idLabel')}
          hint={t('login.idHint')}
          value={id}
          onChangeText={setId}
          autoCapitalize="characters"
          autoComplete="username"
          textContentType="username"
          required
          showErrors={tried}
          error={tried && !id.trim() ? t('login.missingId') : null}
          returnKeyType="next"
          testID="login-id"
        />
        <TextField
          label={t('login.passwordLabel')}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
          textContentType="password"
          required
          showErrors={tried}
          error={tried && !password ? t('login.missingPassword') : null}
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          testID="login-password"
        />
        {error ? (
          <View style={styles.error} accessibilityLiveRegion="assertive">
            <Icon name="alert-circle" color="danger" />
            <Text variant="bodyStrong" color="danger" style={styles.flex}>
              {error}
            </Text>
          </View>
        ) : null}
        <Text variant="secondary">{t('login.inviteHint')}</Text>
      </View>
    </Screen>
  );
};

const styles = StyleSheet.create({
  form: { gap: space.lg },
  error: { flexDirection: 'row', gap: space.xs, alignItems: 'flex-start' },
  flex: { flex: 1 },
});
