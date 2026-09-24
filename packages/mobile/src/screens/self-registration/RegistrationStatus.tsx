import React from 'react';
import { ScrollView, View } from 'react-native';
import { ApplicationStatus, candidateJourney, type CandidateJourneyProgress } from '@fapoms/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { AmbientGlow, AppText, Button, Card, Icon } from '../../components/ui/primitives';
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
 *
 * Submitted and approved also show the road still ahead (owner, 2026-09-24: the page was "very
 * basic eventhough they need to pass through several other steps"): the steps, the one they are
 * on, and one sentence — `candidateJourney` in shared, the same list the web link shows, with the
 * words from the same place. Anything HR has asked of an approved candidate comes first. A paused
 * joiner is told only that, whatever paused them.
 */
export const RegistrationStatus: React.FC<{
  application: RegistrationApplication;
  /** Where an approved candidate has got to, from the server; null before approval or from an older server. */
  journey: CandidateJourneyProgress | null;
  onExit: () => void;
}> = ({ application, journey: progress, onExit }) => {
  const t = useTheme();
  const tr = useT();
  const status = application.status;
  const journey = candidateJourney(status, progress);

  const view: { icon: string; color: string; soft: string; title: string; body: string | null } =
    journey?.paused
      ? {
        icon: 'pause-circle', color: t.colors.textMuted, soft: t.colors.surfaceAlt,
        title: tr('selfRegistration.journey.pausedTitle'), body: tr('selfRegistration.journey.pausedBody'),
      }
      : status === ApplicationStatus.APPROVED
        ? {
          icon: 'ribbon', color: t.colors.success, soft: t.colors.successSoft,
          title: tr('selfRegistration.status.approvedTitle'), body: null,
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
        {/* What HR asked for goes first. The link cannot take the file — after approval the record
            changes only behind their own sign-in — so the card says where to answer it. */}
        {journey && journey.asks.length > 0 && (
          <Card level={1} style={{ gap: t.space.sm, borderColor: t.colors.warning, borderWidth: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
              <Icon name="document-attach" size={20} color={t.colors.warning} />
              <AppText variant="bodyStrong" style={{ flex: 1 }}>{tr('selfRegistration.journey.resendHeading')}</AppText>
            </View>
            {journey.asks.map((ask) => (
              <AppText key={ask.requirement} variant="body">
                <AppText variant="bodyStrong">{ask.label}</AppText>
                {' — '}{ask.note ?? tr('selfRegistration.journey.resendFallback')}
              </AppText>
            ))}
            <AppText variant="small" tone="muted">{tr('selfRegistration.journey.resendHowInApp')}</AppText>
          </Card>
        )}

        <View style={{ alignItems: 'center', gap: t.space.md }}>
          <View style={{ width: 76, height: 76, borderRadius: 38, backgroundColor: view.soft, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={view.icon} size={44} color={view.color} />
          </View>
          <AppText variant="h1" style={{ textAlign: 'center' }}>{view.title}</AppText>
          {view.body ? <AppText variant="body" tone="muted" style={{ textAlign: 'center' }}>{view.body}</AppText> : null}
        </View>

        {journey && !journey.paused && (
          <View style={{ gap: t.space.md }}>
            <View accessibilityRole="list" accessibilityLabel={tr('selfRegistration.journey.stepsLabel')} style={{ gap: 2 }}>
              {journey.steps.map(({ step, state }) => (
                <View
                  key={step}
                  accessibilityState={{ selected: state === 'current' }}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: t.space.sm,
                    paddingVertical: 6, paddingHorizontal: t.space.sm, borderRadius: t.radius.sm,
                    backgroundColor: state === 'current' ? t.colors.primarySoft : 'transparent',
                  }}
                >
                  <Icon
                    name={state === 'done' ? 'checkmark-circle' : state === 'current' ? 'radio-button-on' : 'ellipse-outline'}
                    size={20}
                    color={state === 'done' ? t.colors.success : state === 'current' ? t.colors.primary : t.colors.textFaint}
                  />
                  <AppText
                    variant={state === 'current' ? 'bodyStrong' : 'body'}
                    tone={state === 'ahead' ? 'faint' : state === 'current' ? 'default' : 'muted'}
                    style={{ flex: 1 }}
                  >
                    {tr(`selfRegistration.journeySteps.${step}`)}
                  </AppText>
                </View>
              ))}
            </View>
            {journey.next ? <AppText variant="body" tone="muted">{tr(`selfRegistration.journeyNext.${journey.next}`)}</AppText> : null}
          </View>
        )}

        {status !== ApplicationStatus.WITHDRAWN && (
          <View style={{ alignItems: 'center', gap: 2 }}>
            <AppText variant="caption" tone="faint">{tr('selfRegistration.status.refLabel')}</AppText>
            <AppText variant="h3">#{applicationRef(application.id)}</AppText>
          </View>
        )}

        <View style={{ gap: t.space.md }}>
          <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>{tr('selfRegistration.status.help')}</AppText>
          <Button label={tr('common.close')} variant="neutral" size="lg" onPress={onExit} full />
        </View>
      </ScrollView>
    </View>
  );
};
