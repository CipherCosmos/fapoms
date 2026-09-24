import React from 'react';
import { ScrollView, View } from 'react-native';
import { ApplicationStatus } from '@fapoms/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { AmbientGlow, AppText, Button, Icon } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import type { RegistrationApplication } from '../../services/self-registration.service';
import { applicationRef } from './registration-form';

/** The statuses with no form behind them. */
export const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  ApplicationStatus.PENDING_VALIDATION,
  ApplicationStatus.APPROVED,
  ApplicationStatus.REJECTED,
  ApplicationStatus.WITHDRAWN,
]);

/**
 * Submitted, approved, not approved or withdrawn — one short sentence, the reference to quote, and
 * Close. It used to be a facts grid and a three-stage timeline; a candidate needs to know it went
 * through and what number to give HR when they call.
 */
export const RegistrationStatus: React.FC<{ application: RegistrationApplication; onExit: () => void }> = ({
  application, onExit,
}) => {
  const t = useTheme();
  const tr = useT();
  const status = application.status;

  const view: { icon: string; color: string; soft: string; title: string; body: string | null } =
    status === ApplicationStatus.APPROVED
      ? {
        icon: 'ribbon', color: t.colors.success, soft: t.colors.successSoft,
        title: tr('selfRegistration.status.approvedTitle'), body: tr('selfRegistration.status.approvedBody'),
      }
      : status === ApplicationStatus.REJECTED
        ? {
          icon: 'close-circle', color: t.colors.danger, soft: t.colors.dangerSoft,
          title: tr('selfRegistration.status.rejectedTitle'),
          body: application.reviewNotes ? tr('selfRegistration.status.reviewNote', { note: application.reviewNotes }) : null,
        }
        : status === ApplicationStatus.WITHDRAWN
          ? {
            icon: 'remove-circle', color: t.colors.textMuted, soft: t.colors.surfaceAlt,
            title: tr('selfRegistration.status.withdrawnTitle'), body: tr('selfRegistration.status.withdrawnBody'),
          }
          : {
            icon: 'checkmark-circle', color: t.colors.success, soft: t.colors.successSoft,
            title: tr('selfRegistration.status.pendingTitle'), body: null,
          };

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
      <AmbientGlow />
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: t.space.xl, gap: t.space.xl }}>
        <View style={{ alignItems: 'center', gap: t.space.md }}>
          <View style={{ width: 76, height: 76, borderRadius: 38, backgroundColor: view.soft, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={view.icon} size={44} color={view.color} />
          </View>
          <AppText variant="h1" style={{ textAlign: 'center' }}>{view.title}</AppText>
          {view.body ? <AppText variant="body" tone="muted" style={{ textAlign: 'center' }}>{view.body}</AppText> : null}
          {status !== ApplicationStatus.WITHDRAWN && (
            <View style={{ alignItems: 'center', gap: 2, marginTop: t.space.sm }}>
              <AppText variant="caption" tone="faint">{tr('selfRegistration.status.refLabel')}</AppText>
              <AppText variant="h3">#{applicationRef(application.id)}</AppText>
            </View>
          )}
        </View>

        <View style={{ gap: t.space.md }}>
          <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>{tr('selfRegistration.status.help')}</AppText>
          <Button label={tr('common.close')} variant="neutral" size="lg" onPress={onExit} full />
        </View>
      </ScrollView>
    </View>
  );
};
