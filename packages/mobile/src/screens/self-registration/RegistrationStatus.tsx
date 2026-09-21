import React from 'react';
import { ScrollView, View } from 'react-native';
import { ApplicationStatus, EmploymentCategory } from '@fapoms/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { AmbientGlow, AppText, Button, Card, Icon } from '../../components/ui/primitives';
import { useT, type TranslationKey } from '../../i18n';
import type { RegistrationApplication } from '../../services/self-registration.service';
import { applicationRef } from './registration-form';

/** The statuses with no form behind them. */
export const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  ApplicationStatus.PENDING_VALIDATION,
  ApplicationStatus.APPROVED,
  ApplicationStatus.REJECTED,
  ApplicationStatus.WITHDRAWN,
]);

/** Submitted, approved, not approved or withdrawn — what happened, and what happens next. */
export const RegistrationStatus: React.FC<{ application: RegistrationApplication; onExit: () => void }> = ({
  application, onExit,
}) => {
  const t = useTheme();
  const tr = useT();
  const name = application.fullName || tr('selfRegistration.status.candidate');
  const status = application.status;

  const view: { icon: string; color: string; soft: string; title: string; body: string } =
    status === ApplicationStatus.APPROVED
      ? {
        icon: 'ribbon', color: t.colors.success, soft: t.colors.successSoft,
        title: tr('selfRegistration.status.approvedTitle', { name }), body: tr('selfRegistration.status.approvedBody'),
      }
      : status === ApplicationStatus.REJECTED
        ? {
          icon: 'close-circle', color: t.colors.danger, soft: t.colors.dangerSoft,
          title: tr('selfRegistration.status.rejectedTitle'),
          body: application.reviewNotes
            ? `${tr('selfRegistration.status.rejectedBody')} ${tr('selfRegistration.status.reviewNote', { note: application.reviewNotes })}`
            : tr('selfRegistration.status.rejectedBody'),
        }
        : status === ApplicationStatus.WITHDRAWN
          ? {
            icon: 'remove-circle', color: t.colors.textMuted, soft: t.colors.surfaceAlt,
            title: tr('selfRegistration.status.withdrawnTitle'), body: tr('selfRegistration.status.withdrawnBody'),
          }
          : {
            icon: 'checkmark-circle', color: t.colors.success, soft: t.colors.successSoft,
            title: tr('selfRegistration.status.pendingTitle', { name }), body: tr('selfRegistration.status.pendingBody'),
          };

  const category = application.employmentCategory === EmploymentCategory.PROPRIETOR
    ? tr('selfRegistration.form.proprietor')
    : application.employmentCategory === EmploymentCategory.FREELANCER
      ? tr('selfRegistration.form.freelancer')
      : '—';

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
      <AmbientGlow />
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: t.space.xl, gap: t.space.xl }}>
        <View style={{ alignItems: 'center', gap: t.space.md }}>
          <View style={{ width: 76, height: 76, borderRadius: 38, backgroundColor: view.soft, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={view.icon} size={44} color={view.color} />
          </View>
          <AppText variant="h1" style={{ textAlign: 'center' }}>{view.title}</AppText>
          <AppText variant="body" tone="muted" style={{ textAlign: 'center' }}>{view.body}</AppText>
        </View>

        {status !== ApplicationStatus.WITHDRAWN && (
          <Card level={1} style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: t.space.md }}>
            <Fact label={tr('selfRegistration.status.refLabel')} value={`#${applicationRef(application.id)}`} />
            <Fact label={tr('selfRegistration.status.mobileLabel')} value={application.mobile ? `+91 ${application.mobile}` : '—'} />
            <Fact label={tr('selfRegistration.status.categoryLabel')} value={category} />
            <Fact label={tr('selfRegistration.status.emailLabel')} value={application.email || '—'} />
          </Card>
        )}

        {status === ApplicationStatus.PENDING_VALIDATION && (
          <Card level={1} style={{ gap: t.space.lg }}>
            <AppText variant="overline" tone="faint">{tr('selfRegistration.status.nextTitle')}</AppText>
            <Stage state="done" title="selfRegistration.status.stage1Title" body="selfRegistration.status.stage1Body" />
            <Stage state="current" title="selfRegistration.status.stage2Title" body="selfRegistration.status.stage2Body" />
            <Stage state="next" title="selfRegistration.status.stage3Title" body="selfRegistration.status.stage3Body" />
          </Card>
        )}

        <View style={{ gap: t.space.md }}>
          <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>{tr('selfRegistration.status.help')}</AppText>
          <Button label={tr('common.close')} variant="neutral" size="lg" onPress={onExit} full />
        </View>
      </ScrollView>
    </View>
  );
};

const Fact: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View style={{ width: '50%', gap: 2, paddingRight: 8 }}>
    <AppText variant="overline" tone="faint">{label}</AppText>
    <AppText variant="bodyStrong" numberOfLines={1}>{value}</AppText>
  </View>
);

const Stage: React.FC<{ state: 'done' | 'current' | 'next'; title: TranslationKey; body: TranslationKey }> = ({
  state, title, body,
}) => {
  const t = useTheme();
  const tr = useT();
  const color = state === 'done' ? t.colors.success : state === 'current' ? t.colors.warning : t.colors.textFaint;
  return (
    <View style={{ flexDirection: 'row', gap: t.space.md }}>
      <Icon
        name={state === 'done' ? 'checkmark-circle' : state === 'current' ? 'time' : 'ellipse-outline'}
        size={22}
        color={color}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="bodyStrong" tone={state === 'next' ? 'muted' : 'default'}>{tr(title)}</AppText>
        <AppText variant="small" tone="muted">{tr(body)}</AppText>
      </View>
    </View>
  );
};
