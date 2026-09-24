import React from 'react';
import { useT } from '../i18n/I18nProvider';
import { EmptyState, Screen } from '../ui';

/**
 * FOUNDATION placeholder: proves the invite deep link (`register/:token`) reaches the app. The
 * token arrives as `route.params.token` and is deliberately not shown — it is the candidate's
 * credential. The real registration flow (next phase) will call `SelfRegistrationApi.open(token)`,
 * the same service the current registration screen uses.
 */
export const RegisterScreen: React.FC = () => {
  const t = useT();
  return (
    <Screen title={t('register.title')}>
      <EmptyState icon="person-add-outline" title={t('register.title')} body={t('register.body')} />
    </Screen>
  );
};
