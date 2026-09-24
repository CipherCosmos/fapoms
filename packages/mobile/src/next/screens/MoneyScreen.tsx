import React from 'react';
import { useT } from '../i18n/I18nProvider';
import { EmptyState, Screen } from '../ui';

/**
 * FOUNDATION placeholder for Money. The real tab (next phase) shows NO amounts for unbilled work,
 * a "Bill ready" card, and sent bills with amounts (`formatRupees`).
 */
export const MoneyScreen: React.FC = () => {
  const t = useT();
  return (
    <Screen title={t('money.title')}>
      <EmptyState icon="wallet-outline" title={t('money.placeholderTitle')} body={t('money.placeholderBody')} />
    </Screen>
  );
};
