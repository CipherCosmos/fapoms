import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Platform, StyleSheet, View } from 'react-native';
import { useRoute, type RouteProp } from '@react-navigation/native';
import { useAuth } from '../../context/AuthContext';
import type { AssayerAssignment } from '../../types/mobile-app';
import { answerOffer, checkIn, checkOut, readPermissionFacts, syncGeofences, type CheckInOutcome } from '../background/runtime';
import { dismissAction, generateClientRequestId, getRefusedActions, subscribeActionQueue, type QueuedAction } from '../../services/action-queue';
import { reasonText, refusalWords } from '../data/reasons';
import { planGeofences } from '../background/geofence-plan';
import { permissionStep, type PermissionStep } from '../background/permission-flow';
import { declineArrivalPermission, ensureForegroundLocation, requestArrivalPermission } from '../background/permission-request';
import { actionsFor, jobStep, partitionToday, type ActionView } from '../data/job-view';
import { useJobs } from '../data/useJobs';
import { canOpenPapers, openBranchPapers, papersBeingPrepared } from '../data/packet';
import { MobileApiService } from '../../services/api.service';
import { useI18n, useT } from '../i18n/I18nProvider';
import { formatDay, formatDayTime } from '../i18n/format';
import type { TranslationKey } from '../i18n/catalogues';
import type { TabParamList } from '../nav/linking';
import { colors, space } from '../theme/tokens';
import { Button, Card, Chip, EmptyState, Icon, Screen, Sheet, StepBar, Text, TextField, useToast, type ChipTone, type IconName } from '../ui';

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
 * Today: the assayer's real jobs, with each job's buttons exactly as the server's `capabilities`
 * allow (allowed → button; not allowed → disabled with the reason, translated by its code). Wired:
 * Yes/No to an offer (No asks why), "I have reached" and "I am leaving", all through the same
 * action queue as the current app. Actions not built here yet are drawn disabled as "coming soon"
 * (`WIRED_ACTIONS` in job-view.ts) — never an enabled button that only says "not ready".
 */
export const TodayScreen: React.FC = () => {
  const t = useT();
  const { language } = useI18n();
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

  /** Actions saved on the phone that the office then refused — listed until dismissed. */
  const [refused, setRefused] = useState<QueuedAction[]>([]);
  useEffect(() => {
    let live = true;
    const read = () => void getRefusedActions().then((list) => { if (live) setRefused(list); }).catch(() => undefined);
    read();
    const unsubscribe = subscribeActionQueue(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [user?.id]);

  /** The decline form: which job, what they typed, and one key per form (the server's idempotency key). */
  const [declining, setDeclining] = useState<{ job: AssayerAssignment; reason: string; requestKey: string; tried: boolean } | null>(null);

  /** One toast per outcome, the same for every wired action. */
  const report = useCallback(
    (outcome: CheckInOutcome, doneTitle: string) => {
      if (outcome.kind === 'done') toast.show('done', doneTitle);
      else if (outcome.kind === 'queued') toast.show('saved');
      else if (outcome.kind === 'no-position') toast.show('error', t('arrival.noFix'));
      else if (outcome.kind === 'refused') toast.show('error', reasonText(t, language, outcome.code, outcome.message, 'common.somethingWrong'));
      else toast.show('error', t('common.somethingWrong'));
    },
    [language, t, toast],
  );

  const onAction = useCallback(
    async (job: AssayerAssignment, view: ActionView) => {
      if (view.comingSoon || !view.allowed) return;
      const place = job.branchName || job.bankName;
      switch (view.action) {
        case 'ACCEPT':
          report(await answerOffer(job.id, { accept: true }), t('work.accepted'));
          break;
        case 'DECLINE':
          setDeclining({ job, reason: '', requestKey: generateClientRequestId(), tried: false });
          return;
        case 'CHECK_IN':
          if (!(await ensureForegroundLocation())) {
            toast.show('error', t('arrival.locationNeeded'));
            return;
          }
          report(await checkIn(job.id, new Date().toISOString()), t('arrival.checkedIn', { place }));
          break;
        case 'CHECK_OUT': {
          // One-way: the server keeps the first departure it is given, so it is confirmed first.
          const sure = await new Promise<boolean>((resolve) =>
            Alert.alert(t('work.checkOutTitle'), t('work.checkOutBody', { place }), [
              { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
              { text: t('today.actions.CHECK_OUT'), style: 'destructive', onPress: () => resolve(true) },
            ], { cancelable: true, onDismiss: () => resolve(false) }),
          );
          if (!sure) return;
          if (!(await ensureForegroundLocation())) {
            toast.show('error', t('arrival.locationNeeded'));
            return;
          }
          report(await checkOut(job.id), t('work.checkedOut', { place }));
          break;
        }
        default:
          return;
      }
      void refresh();
    },
    [refresh, report, t, toast],
  );

  const sendDecline = useCallback(async () => {
    if (!declining) return;
    const reason = declining.reason.trim();
    if (!reason) {
      setDeclining({ ...declining, tried: true });
      return;
    }
    const outcome = await answerOffer(declining.job.id, { accept: false, reason, requestKey: declining.requestKey });
    report(outcome, t('work.declined'));
    // The form stays open on a refusal the assayer can act on; otherwise it is done.
    if (outcome.kind !== 'refused') setDeclining(null);
    void refresh();
  }, [declining, refresh, report, t]);

  /**
   * The branch's audit papers, once the assayer has reached the branch and operations has sent
   * them — the old app's "Download packet", through the same two calls.
   */
  const [openingPapersFor, setOpeningPapersFor] = useState<string | null>(null);
  const onOpenPapers = useCallback(
    async (job: AssayerAssignment) => {
      if (openingPapersFor) return;
      setOpeningPapersFor(job.id);
      try {
        const outcome = await openBranchPapers(job.projectBranchId, {
          getBranchDocuments: (id) => MobileApiService.getBranchDocuments(id),
          getDocumentDownloadUrl: (id) => MobileApiService.getDocumentDownloadUrl(id),
          openURL: (url) => Linking.openURL(url),
        });
        if (outcome.kind === 'not-sent') toast.show('error', t('today.papers.notSent'));
        else if (outcome.kind === 'not-available') toast.show('error', t('today.papers.notAvailable'));
        else if (outcome.kind === 'session-ended') toast.show('error', t('today.papers.sessionEnded'));
        else if (outcome.kind === 'failed') toast.show('error', t('today.papers.failed'));
      } finally {
        setOpeningPapersFor(null);
      }
    },
    [openingPapersFor, t, toast],
  );

  const papersBlock = (job: AssayerAssignment) => {
    if (canOpenPapers(job)) {
      return (
        <Button
          label={openingPapersFor === job.id ? t('today.papers.opening') : t('today.papers.open')}
          icon="document-text-outline"
          variant="quiet"
          disabled={openingPapersFor !== null}
          onPress={() => void onOpenPapers(job)}
        />
      );
    }
    if (papersBeingPrepared(job)) {
      return (
        <View style={styles.why}>
          <Icon name="time-outline" size={20} color="inkSecondary" />
          <Text variant="secondary" style={styles.flex}>
            {t('today.papers.preparing')}
          </Text>
        </View>
      );
    }
    return null;
  };

  const actionsBlock = (job: AssayerAssignment) => {
    const views = actionsFor(job);
    if (views.length === 0) return null;
    return (
      <View style={styles.actions}>
        {views.map((v) => {
          const label = t(`today.actions.${v.action}` as TranslationKey);
          const why = v.comingSoon
            ? t('work.comingSoon')
            : v.allowed
              ? undefined
              : [
                  reasonText(t, language, v.code, v.reason, 'today.actionNotAllowed'),
                  v.opensAt ? t('today.opensAt', { when: formatDayTime(v.opensAt, now, t) }) : null,
                ]
                  .filter(Boolean)
                  .join(' ');
          return (
            <View key={v.action} style={styles.action}>
              <Button
                label={label}
                icon={ACTION_ICON[v.action] ?? 'ellipse-outline'}
                variant={v.weight === 'danger' ? 'danger' : v.weight === 'main' ? 'main' : 'quiet'}
                disabled={!v.allowed || v.comingSoon}
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

      {refused.length > 0 ? (
        <Card tone="plain">
          <View style={styles.why} accessibilityLiveRegion="polite">
            <Icon name="alert-circle-outline" color="danger" />
            <Text variant="title" style={styles.flex}>{t('queue.title')}</Text>
          </View>
          {refused.map((entry) => (
            <View key={entry.id} style={styles.action}>
              <Text variant="body">{refusalWords(t, language, entry).line}</Text>
              <Button label={t('queue.dismiss')} variant="quiet" onPress={() => dismissAction(entry.id)} />
            </View>
          ))}
        </Card>
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
          {papersBlock(parts.now)}
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
              {papersBlock(job)}
            </View>
          ))}
        </View>
      ) : null}

      <Sheet visible={declining !== null} onClose={() => setDeclining(null)} title={t('work.declineTitle')}>
        <TextField
          label={t('work.declineLabel')}
          hint={t('work.declineHint')}
          value={declining?.reason ?? ''}
          onChangeText={(reason) => setDeclining((d) => (d ? { ...d, reason } : d))}
          required
          maxLength={500}
          showErrors={declining?.tried}
        />
        <Button label={t('work.declineSend')} icon="close-circle-outline" variant="danger" onPress={sendDecline} />
      </Sheet>

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
