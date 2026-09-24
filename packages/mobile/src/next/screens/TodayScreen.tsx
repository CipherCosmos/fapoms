import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useRoute, type RouteProp } from '@react-navigation/native';
import { useAuth } from '../../context/AuthContext';
import type { AssayerAssignment } from '../../types/mobile-app';
import { checkIn, readPermissionFacts, syncGeofences } from '../background/runtime';
import { planGeofences } from '../background/geofence-plan';
import { permissionStep, type PermissionStep } from '../background/permission-flow';
import { declineArrivalPermission, ensureForegroundLocation, requestArrivalPermission } from '../background/permission-request';
import { actionsFor, jobStep, partitionToday, type ActionView } from '../data/job-view';
import { useJobs } from '../data/useJobs';
import { useT } from '../i18n/I18nProvider';
import { formatDay, formatDayTime } from '../i18n/format';
import type { TranslationKey } from '../i18n/catalogues';
import type { TabParamList } from '../nav/linking';
import { colors, space } from '../theme/tokens';
import { Button, Card, Chip, EmptyState, Icon, Screen, StepBar, Text, useToast, type ChipTone, type IconName } from '../ui';

const ACTION_ICON: Record<string, IconName> = {
  ACCEPT: 'checkmark-circle-outline',
  DECLINE: 'close-circle-outline',
  CHECK_IN: 'location-outline',
  CHECK_OUT: 'exit-outline',
  SUBMIT_RETURN: 'document-attach-outline',
  CLAIM_EXPENSE: 'car-outline',
  REPORT_ISSUE: 'warning-outline',
};

const STATUS_TONE: Record<string, ChipTone> = {
  PENDING: 'accent',
  ACCEPTED: 'info',
  CHECKED_IN: 'success',
  IN_PROGRESS: 'success',
  COMPLETED: 'success',
  REJECTED: 'neutral',
  CANCELLED: 'danger',
};

/**
 * FOUNDATION placeholder for Today: the assayer's real jobs, with each job's buttons exactly as the
 * server's `capabilities` allow (allowed → button; not allowed → disabled with the reason). Only
 * "I have reached" is wired (it is the one-tap fallback of automatic check-in); the other actions
 * say they are not ready yet. The job-now card, the Yes/No offer and the step bar use the real kit.
 */
export const TodayScreen: React.FC = () => {
  const t = useT();
  const toast = useToast();
  const { user } = useAuth();
  const route = useRoute<RouteProp<TabParamList, 'Today'>>();
  const { jobs, loading, stale, savedAt, loaded, refresh } = useJobs();
  const [permission, setPermission] = useState<PermissionStep>('quiet');
  const now = new Date();

  const parts = useMemo(() => partitionToday(jobs, new Date()), [jobs]);
  const watchable = useMemo(
    () => planGeofences(jobs, { now: new Date(), platform: Platform.OS === 'ios' ? 'ios' : 'android' }).zones.length > 0,
    [jobs],
  );

  const recheckPermission = useCallback(async () => {
    setPermission(permissionStep(await readPermissionFacts(watchable)));
  }, [watchable]);
  useEffect(() => {
    void recheckPermission();
  }, [recheckPermission]);

  const onAction = useCallback(
    async (job: AssayerAssignment, view: ActionView) => {
      if (view.action !== 'CHECK_IN') {
        toast.show('error', t('common.notReadyYet'));
        return;
      }
      if (!(await ensureForegroundLocation())) {
        toast.show('error', t('arrival.locationNeeded'));
        return;
      }
      const outcome = await checkIn(job.id, new Date().toISOString());
      if (outcome.kind === 'done') toast.show('done', t('arrival.checkedIn', { place: job.branchName || job.bankName }));
      else if (outcome.kind === 'queued') toast.show('saved');
      else if (outcome.kind === 'no-position') toast.show('error', t('arrival.noFix'));
      else toast.show('error', (outcome.kind === 'refused' && outcome.message) || t('common.somethingWrong'));
      void refresh();
    },
    [refresh, t, toast],
  );

  const actionsBlock = (job: AssayerAssignment) => {
    const views = actionsFor(job);
    if (views.length === 0) return null;
    return (
      <View style={styles.actions}>
        {views.map((v) => {
          const label = t(`today.actions.${v.action}` as TranslationKey);
          const why = v.allowed
            ? undefined
            : [v.reason || t('today.actionNotAllowed'), v.opensAt ? t('today.opensAt', { when: formatDayTime(v.opensAt, now, t) }) : null]
                .filter(Boolean)
                .join(' ');
          return (
            <View key={v.action} style={styles.action}>
              <Button
                label={label}
                icon={ACTION_ICON[v.action] ?? 'ellipse-outline'}
                variant={v.weight === 'danger' ? 'danger' : v.weight === 'main' ? 'main' : 'quiet'}
                disabled={!v.allowed}
                accessibilityHint={why}
                onPress={() => onAction(job, v)}
              />
              {why ? (
                <View style={styles.why}>
                  <Icon name="information-circle-outline" size={20} color="inkSecondary" />
                  <Text variant="secondary" style={styles.flex}>
                    {why}
                  </Text>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    );
  };

  const jobHeader = (job: AssayerAssignment) => (
    <View style={styles.jobHead}>
      <Chip label={t(`today.status.${job.status}` as TranslationKey)} tone={STATUS_TONE[job.status] ?? 'neutral'} />
      <Text variant="title">{job.branchName || job.bankName || job.assignmentCode}</Text>
      <Text variant="secondary">
        {[job.bankName, formatDay(job.scheduledDate, now, t)].filter(Boolean).join(' · ')}
      </Text>
      {job.branchAddress ? <Text variant="secondary">{job.branchAddress}</Text> : null}
    </View>
  );

  const highlighted = route.params?.assignmentId;
  const stepLabels = [t('today.steps.reached'), t('today.steps.papers'), t('today.steps.done')];
  const openCount = (parts.now ? 1 : 0) + parts.offers.length + parts.later.length;

  return (
    <Screen
      title={t('today.hello', { name: user?.name ?? '' })}
      subtitle={loaded ? t('today.jobCount', { count: openCount }) : t('common.loading')}
      refreshing={loading}
      onRefresh={() => void refresh()}
    >
      {stale ? (
        <View style={styles.banner} accessibilityLiveRegion="polite">
          <Icon name="cloud-offline-outline" color="info" />
          <Text variant="secondary" color="info" style={styles.flex}>
            {t('today.showingSaved', { when: savedAt ? formatDayTime(savedAt, now, t) : '' })}
          </Text>
        </View>
      ) : null}

      {permission === 'explain' ? (
        <Card tone="accent">
          <Text variant="title">{t('arrival.askTitle')}</Text>
          <Text variant="body">{t('arrival.askBody')}</Text>
          {Platform.OS === 'android' ? <Text variant="secondary">{t('arrival.askBodyAndroid')}</Text> : null}
          <Button
            label={t('arrival.allow')}
            icon="navigate-circle-outline"
            onPress={async () => {
              if (await requestArrivalPermission()) {
                toast.show('done');
                if (user?.id) await syncGeofences(user.id, jobs).catch(() => undefined);
              }
              await recheckPermission();
            }}
          />
          <Button
            label={t('arrival.notNow')}
            variant="quiet"
            onPress={async () => {
              await declineArrivalPermission();
              await recheckPermission();
            }}
          />
        </Card>
      ) : null}

      {parts.now ? (
        <Card tone={highlighted === parts.now.id ? 'accent' : 'plain'}>
          <Text variant="label" color="accent">
            {t('today.now')}
          </Text>
          {jobHeader(parts.now)}
          {jobStep(parts.now) != null ? <StepBar steps={stepLabels} current={jobStep(parts.now) ?? 0} /> : null}
          {actionsBlock(parts.now)}
          {permission === 'fallback' && parts.now.status === 'ACCEPTED' && !parts.now.checkedInAt ? (
            <Text variant="secondary">{t('arrival.offNote')}</Text>
          ) : null}
        </Card>
      ) : null}

      {parts.offers.map((job) => (
        <Card key={job.id} tone={highlighted === job.id ? 'accent' : 'plain'}>
          {jobHeader(job)}
          {actionsBlock(job)}
        </Card>
      ))}

      {parts.later.length > 0 ? (
        <View style={styles.later}>
          <Text variant="label" color="inkSecondary" accessibilityRole="header">
            {t('today.later')}
          </Text>
          {parts.later.map((job) => (
            <View key={job.id} style={[styles.laterRow, highlighted === job.id && styles.highlight]}>
              {jobHeader(job)}
              {actionsBlock(job)}
            </View>
          ))}
        </View>
      ) : null}

      {loaded && openCount === 0 ? (
        <EmptyState
          icon="sunny-outline"
          title={stale ? t('today.loadFailed') : t('today.emptyTitle')}
          body={stale ? undefined : t('today.emptyBody')}
          actionLabel={t('today.refresh')}
          actionIcon="refresh"
          onAction={refresh}
        />
      ) : null}
    </Screen>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  banner: {
    flexDirection: 'row',
    gap: space.xs,
    alignItems: 'flex-start',
    padding: space.sm,
    borderRadius: 12,
    backgroundColor: colors.infoSoft,
  },
  jobHead: { gap: space.xxs },
  actions: { gap: space.sm, marginTop: space.xs },
  action: { gap: space.xxs },
  why: { flexDirection: 'row', gap: space.xxs, alignItems: 'flex-start' },
  later: { gap: space.sm },
  laterRow: {
    gap: space.sm,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  highlight: { backgroundColor: colors.accentSoft, paddingHorizontal: space.sm, borderRadius: 12 },
});
