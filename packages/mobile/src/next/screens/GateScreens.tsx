import React, { useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { applyLanguagePreference } from '../../i18n';
import { ChangePasswordScreen } from '../../screens/ChangePasswordScreen';
import { LockScreen } from '../../screens/LockScreen';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { useI18n } from '../i18n/I18nProvider';
import { useT } from '../i18n/I18nProvider';
import { Button, EmptyState, Screen } from '../ui';

/**
 * The session gates, reusing the current app's own screens for now — the biometric lock and the
 * forced password change are security flows that already work, and rebuilding them is not
 * foundation work. They render inside the current app's theme and translator; that translator
 * only has English and Hindi, so other languages see English there until these are rebuilt.
 */
function useLegacyLanguage() {
  const { language } = useI18n();
  useEffect(() => {
    applyLanguagePreference(language === 'hi' ? 'hi' : 'en');
  }, [language]);
}

export const LockedGate: React.FC = () => {
  useLegacyLanguage();
  const { assayerName, unlock, logout, skipUnlock } = useAuth();
  return (
    <ThemeProvider>
      <LockScreen name={assayerName} onUnlock={unlock} onSignOut={logout} onSkip={skipUnlock} />
    </ThemeProvider>
  );
};

export const PasswordGate: React.FC = () => {
  useLegacyLanguage();
  const { clearMustChangePassword, logout } = useAuth();
  return (
    <ThemeProvider>
      <ChangePasswordScreen onChanged={clearMustChangePassword} onLogout={logout} />
    </ThemeProvider>
  );
};

/** A registration-only session: nothing else will load until HR releases it. */
export const RegistrationGate: React.FC = () => {
  const t = useT();
  const { logout, recheckRegistration } = useAuth();
  return (
    <Screen footer={<Button label={t('common.signOut')} icon="log-out-outline" variant="quiet" onPress={logout} />}>
      <EmptyState
        icon="hourglass-outline"
        title={t('gate.registrationTitle')}
        body={t('gate.registrationBody')}
        actionLabel={t('today.refresh')}
        actionIcon="refresh"
        onAction={recheckRegistration}
      />
    </Screen>
  );
};
