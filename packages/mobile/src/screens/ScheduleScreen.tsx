import React, { useState } from 'react';
import { View, Linking } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { MobileApiService } from '../services/api.service';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Badge, Button, Card, Divider, EmptyState, FadeIn, Icon, Segmented } from '../components/ui/primitives';
import { assignmentStatusLabel, isAssignmentTerminal, formatDateOnly } from '@fapoms/shared';
import { assignmentStatusTone } from '../utils/statusTone';
import { dayGroupHeader, dayKey, relativeDay } from '../utils/dates';
import { useT, useLocale, serverErrorText, t as translate } from '../i18n';
import { useSwipeSegments } from '../hooks/useSwipeSegments';

const SCHEDULE_TABS = ['ACTIVE', 'DONE'] as const;

interface ScheduleScreenProps {
  assignments: AssayerAssignment[];
  /** Assignment id whose accept/check-in is in flight — drives the button spinner + disable. */
  busyActionId?: string | null;
  onAcceptAssignment: (id: string) => void;
  onOpenRejectModal: (id: string) => void;
  onCheckIn: (assignment: AssayerAssignment) => void;
  /** Records that the assayer has left the branch. Does not finish the audit. */
  onCheckOut?: (assignment: AssayerAssignment) => void;
  onOpenPdfDocs: (assignment: AssayerAssignment) => void;
  onOpenScanner?: (assignment: AssayerAssignment) => void;
  onOpenQueryChat?: (assignment: AssayerAssignment) => void;
  onOpenMap?: (assignment: AssayerAssignment) => void;
  /**
   * Loads the next page of settled work older than the app's active window, newest first.
   * Returns an empty array when there is no more. Absent, the History tab simply shows what
   * the active list already carries.
   */
  onLoadOlderHistory?: () => Promise<AssayerAssignment[]>;
}

type Tone = 'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info';


const fmtDate = (d?: string | null) =>
  d ? formatDateOnly(d, { weekday: 'short', day: '2-digit', month: 'short' }) : translate('dates.today');

/**
 * The route: every branch this assayer owes work on.
 *
 * Rebuilt around one card per stop that leads with where and when, states
 * plainly what is being asked, and shows only the actions legal in the current
 * status. The old version stacked six nested inline-styled rows per card at
 * 11px type.
 *
 * There is deliberately no money on this screen — no fee, no counter-offer, no per-day
 * totals. Fees are ops-internal until the invoice invitation reveals them on the Earnings
 * tab; an offer here is accepted or declined on the work alone, and the figure is settled
 * with the desk by phone.
 */
export const ScheduleScreen: React.FC<ScheduleScreenProps> = ({
  assignments,
  busyActionId,
  onAcceptAssignment,
  onOpenRejectModal,
  onCheckIn,
  onCheckOut,
  onOpenPdfDocs,
  onOpenScanner,
  onOpenQueryChat,
  onOpenMap,
  onLoadOlderHistory,
}) => {
  const t = useTheme();
  const tr = useT();
  const locale = useLocale();
  const [tab, setTab] = React.useState<'ACTIVE' | 'DONE'>('ACTIVE');
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null);
  const [downloadMsg, setDownloadMsg] = React.useState<{ id: string; tone: 'ok' | 'warn'; text: string } | null>(null);

  const handleDownloadPdf = async (a: AssayerAssignment) => {
    if (downloadingId) return;
    setDownloadingId(a.id);
    setDownloadMsg(null);
    try {
      const { success, data, error } = await MobileApiService.getBranchDocuments(a.projectBranchId);
      if (!success || !data || data.length === 0) {
        // The readiness block from the API explains exactly why nothing is here yet.
        setDownloadMsg({ id: a.id, tone: 'warn', text: error || 'The audit packet is not available yet. You will be notified when it is sent.' });
        return;
      }
      /**
       * Only the branch's own packet.
       *
       * The CUSTOMER_MASTER_DATA fallback that used to sit here asked for the client's master
       * file, which covers *every* branch scheduled that day — the backend excludes it from
       * `ASSAYER_VISIBLE_TYPES` for exactly that reason, so this was requesting other
       * branches' customer records and only failing because the server refused.
       */
      const doc = data.find((d: any) => d.type === 'PRE_FIELD_AUDIT_PDF');
      if (!doc) {
        setDownloadMsg({ id: a.id, tone: 'warn', text: tr('schedule.packetNotSent') });
        return;
      }
      const res = await MobileApiService.getDocumentDownloadUrl(doc.id);
      if (!res.ok) {
        setDownloadMsg({ id: a.id, tone: 'warn', text: serverErrorText(res.message, 'schedule.packetUnavailable') });
        return;
      }
      await Linking.openURL(res.url);
      setDownloadMsg({ id: a.id, tone: 'ok', text: tr('schedule.downloadStarted') });
    } catch (e: any) {
      setDownloadMsg({ id: a.id, tone: 'warn', text: serverErrorText(e?.message, 'schedule.downloadFailed') });
    } finally {
      setDownloadingId(null);
    }
  };


  // CANCELLED was missing from this split, so a cancelled audit stayed under Active forever
  // while HomeScreen had already dropped it from current work.
  const active = assignments.filter((a) => !isAssignmentTerminal(a.status));

  /**
   * History: the settled work the live list carries (the recent window the server sends), plus
   * any older pages this screen has since pulled in. The server stopped sending an assayer's
   * entire career on every refresh — that list is fetched on a dozen events a minute — so older
   * jobs arrive on request instead, and the tab says so rather than quietly ending.
   */
  const [olderHistory, setOlderHistory] = useState<AssayerAssignment[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [noMoreHistory, setNoMoreHistory] = useState(false);

  const loadOlder = async () => {
    if (!onLoadOlderHistory || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await onLoadOlderHistory();
      if (page.length === 0) setNoMoreHistory(true);
      else setOlderHistory((prev) => [...prev, ...page.filter((p) => !prev.some((x) => x.id === p.id))]);
    } catch {
      // Left to the caller's feedback; the button simply stays available to try again.
    } finally {
      setLoadingOlder(false);
    }
  };

  const recentDone = assignments.filter((a) => isAssignmentTerminal(a.status));
  const done = [...recentDone, ...olderHistory.filter((o) => !recentDone.some((r) => r.id === o.id))];
  const shown = tab === 'ACTIVE' ? active : done;

  /**
   * Active stops as a route plan, not a pile.
   *
   * The flat list made the assayer do the calendar work themselves: every card showed a bare
   * date and nothing marked today, tomorrow, or the stop that slipped. Grouped by calendar
   * day — soonest first, overdue naturally rising to the top, unscheduled last — with the
   * day's stop count on the header, the screen answers "what does my week look like" at a
   * glance. History stays a flat reverse-chronological record; grouping a done-pile adds
   * nothing.
   */
  const groups = React.useMemo(() => {
    if (tab === 'DONE') {
      return [{ key: 'done', header: null as string | null, tone: 'neutral' as Tone, items: done }];
    }
    const sorted = [...active].sort((a, b) => {
      if (!a.scheduledDate) return 1;
      if (!b.scheduledDate) return -1;
      return +new Date(a.scheduledDate) - +new Date(b.scheduledDate);
    });
    const byDay = new Map<string, AssayerAssignment[]>();
    for (const a of sorted) {
      const k = dayKey(a.scheduledDate);
      const bucket = byDay.get(k);
      if (bucket) bucket.push(a);
      else byDay.set(k, [a]);
    }
    return [...byDay.entries()].map(([key, items]) => ({
      key,
      header: dayGroupHeader(items[0].scheduledDate),
      tone: relativeDay(items[0].scheduledDate).tone as Tone,
      items,
    }));
    // `locale` is a dependency because `dayGroupHeader` produces a translated sentence: without
    // it the day headers would keep the language they were built in when the assayer switches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, assignments, locale]);

  const swipeSegments = useSwipeSegments(SCHEDULE_TABS, tab, setTab);

  return (
    <View style={{ gap: t.space.lg }} {...swipeSegments.panHandlers}>
      {/* Large-title treatment, matching Home's greeting and Profile's name — the shared TopBar
          only ever shows the assayer's identity, never a per-screen title, so without this the
          route plan opened straight onto a segmented control with nothing above it naming the
          screen. Apple's own Mail/Reminders put the big title directly above their filter
          control, which is the same shape as Segmented here. */}
      <AppText variant="largeTitle">{tr('schedule.title')}</AppText>

      <Segmented
        value={tab}
        onChange={(k) => setTab(k as 'ACTIVE' | 'DONE')}
        options={[
          { key: 'ACTIVE', label: tr('schedule.tabActive'), count: active.length },
          { key: 'DONE', label: tr('schedule.tabHistory'), count: done.length },
        ]}
      />

      {shown.length === 0 ? (
        <EmptyState
          icon={tab === 'ACTIVE' ? 'map-outline' : 'checkmark-done-outline'}
          title={tab === 'ACTIVE' ? tr('schedule.emptyActiveTitle') : tr('schedule.emptyDoneTitle')}
          body={tab === 'ACTIVE' ? tr('schedule.emptyActiveBody') : tr('schedule.emptyDoneBody')}
        />
      ) : (
        groups.map((g) => (
          <View key={g.key} style={{ gap: t.space.md }}>
            {g.header && (
              <DayHeader
                header={g.header}
                tone={g.tone}
                count={g.items.length}
              />
            )}
            {g.items.map((a, i) => {
          // Wording from @fapoms/shared, tone from the app's one tone map — this screen used
          // to keep its own copy of both, and they had drifted from HomeScreen's.
          const meta = { label: assignmentStatusLabel(a.status), tone: assignmentStatusTone(a.status) as Tone };

          return (
            <FadeIn key={a.id} delay={Math.min(i, 6) * 45}>
              <Card level={1} style={{ gap: t.space.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: t.space.md }}>
                  <View style={{
                    width: 38, height: 38, borderRadius: t.radius.md, backgroundColor: t.colors.primarySoft,
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <AppText variant="bodyStrong" tone="primary">{i + 1}</AppText>
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <AppText variant="h3" numberOfLines={1}>{a.branchName}</AppText>
                    <AppText variant="small" tone="muted" numberOfLines={2}>{a.branchAddress}</AppText>
                  </View>
                </View>

                <View style={{ flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' }}>
                  <Badge label={meta.label} tone={meta.tone} dot />
                  {a.bankName ? <Badge label={a.bankName} tone="neutral" /> : null}
                </View>

                <Divider spacing={2} />

                <View style={{ flexDirection: 'row', gap: t.space.lg }}>
                  <Fact icon="calendar-outline" label={tr('schedule.factDate')} value={fmtDate(a.scheduledDate)} />
                  <Fact icon="cube-outline" label={tr('schedule.factPackets')} value={a.estimatedCustomerCount > 0 ? String(a.estimatedCustomerCount) : '—'} />
                </View>

                {/* Accept or decline, on the work alone — no fee is shown and no counter-offer
                    is possible: money is ops-internal until the invoice invitation. The decline
                    still demands a reason (RejectionModal), because replanning the branch needs
                    one. */}
                {a.status === 'PENDING' && (
                  <View style={{ flexDirection: 'row', gap: t.space.sm }}>
                    <Button label={tr('schedule.accept')} icon="checkmark" loading={busyActionId === a.id} disabled={busyActionId != null} onPress={() => onAcceptAssignment(a.id)} style={{ flex: 1 }} />
                    <Button label={tr('schedule.decline')} icon="close" variant="neutral" disabled={busyActionId != null} onPress={() => onOpenRejectModal(a.id)} style={{ flex: 1 }} />
                  </View>
                )}

                {a.status === 'ACCEPTED' && (
                  <View style={{ flexDirection: 'row', gap: t.space.sm }}>
                    {onOpenMap && (
                      <Button label={tr('schedule.navigate')} icon="navigate" variant="neutral" onPress={() => onOpenMap(a)} style={{ flex: 1 }} />
                    )}
                    <Button label={tr('schedule.checkIn')} icon="log-in-outline" loading={busyActionId === a.id} disabled={busyActionId != null} onPress={() => onCheckIn(a)} style={{ flex: 1 }} />
                  </View>
                )}

                {(a.status === 'CHECKED_IN' || a.status === 'IN_PROGRESS') && (
                  <View style={{ gap: t.space.sm }}>
                    {/*
                      One action, not two. "Scan audit sheets" and "Upload" used to sit side by
                      side as if they were alternatives; scanning *is* how the return is
                      produced, and the scanner already offers "Attach file" for the case where
                      a PDF exists on the device. Two doors to one room made the assayer choose
                      between them with nothing to go on.
                    */}
                    <Button
                      label={tr('schedule.scanAndSubmit')}
                      icon="scan"
                      onPress={() => (onOpenScanner ? onOpenScanner(a) : onOpenPdfDocs(a))}
                      full
                    />

                    {/*
                      Leaving the branch — the other end of check-in.

                      Secondary, and below the scan action, because it is not how work gets
                      finished: the audited return is. Check-out records only that they have left,
                      so the paperwork above stays available afterwards.

                      Shown once, then replaced by the time it recorded. Offering "Check out"
                      again to someone who has already left invites a second tap that the server
                      correctly ignores, which reads to the assayer as the app not working.
                    */}
                    {onCheckOut && (a.checkedOutAt ? (
                      <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>
                        {tr('schedule.leftAt', {
                          time: new Date(a.checkedOutAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
                        })}
                      </AppText>
                    ) : (
                      <Button
                        label={tr('schedule.checkOut')}
                        icon="log-out-outline"
                        variant="neutral"
                        loading={busyActionId === a.id}
                        disabled={busyActionId != null}
                        onPress={() => onCheckOut(a)}
                        full
                      />
                    ))}

                    {/*
                      The packet download appears only once operations has actually dispatched
                      it. `documentReadiness` comes down with the assignment, so this is decided
                      before the button is drawn rather than discovered after a failed tap.
                    */}
                    {a.documentReadiness?.state === 'READY' && (
                      <Button
                        label={downloadingId === a.id ? tr('schedule.opening') : tr('schedule.downloadPacket')}
                        icon="download-outline"
                        variant="neutral"
                        disabled={downloadingId !== null}
                        onPress={() => handleDownloadPdf(a)}
                        full
                      />
                    )}
                    {a.documentReadiness?.state === 'PREPARING' && (
                      <AppText variant="small" tone="muted">
                        {a.documentReadiness.message}
                      </AppText>
                    )}

                    {downloadMsg && downloadMsg.id === a.id && (
                      <AppText variant="small" style={{ color: downloadMsg.tone === 'ok' ? t.colors.success : t.colors.warning }}>
                        {downloadMsg.text}
                      </AppText>
                    )}
                  </View>
                )}

                {a.status === 'COMPLETED' && a.queries && a.queries.length > 0 && (
                  <Button
                    label={a.queries.length === 1
                      ? tr('schedule.oneClarification')
                      : tr('schedule.manyClarifications', { count: a.queries.length })}
                    icon="chatbubble-ellipses-outline"
                    variant="accent"
                    onPress={() => (onOpenQueryChat ? onOpenQueryChat(a) : onOpenPdfDocs(a))}
                    full
                  />
                )}
              </Card>
            </FadeIn>
          );
            })}
          </View>
        ))
      )}

      {/*
        Older jobs, on request. The live list carries recent settled work only — the server no
        longer sends an assayer's whole career on a list that refreshes on every desk event — so
        this says where the tab currently ends instead of letting it look like the whole record.
      */}
      {tab === 'DONE' && onLoadOlderHistory && (
        noMoreHistory ? (
          <AppText variant="small" tone="muted" style={{ textAlign: 'center', paddingVertical: t.space.md }}>
            {tr('schedule.historyComplete')}
          </AppText>
        ) : (
          <Button
            label={loadingOlder ? tr('schedule.loadingOlder') : tr('schedule.showOlder')}
            icon="time-outline"
            variant="neutral"
            loading={loadingOlder}
            disabled={loadingOlder}
            onPress={loadOlder}
          />
        )
      )}
    </View>
  );
};

/**
 * A day's header on the route: when, and how many stops. (It used to also total the day's
 * fees — money left this screen with the negotiation removal, so the header now speaks only
 * of the work.)
 */
const DayHeader: React.FC<{ header: string; tone: Tone; count: number }> = ({
  header, tone, count,
}) => {
  const t = useTheme();
  const tr = useT();
  const toneColor = {
    neutral: t.colors.textFaint, primary: t.colors.primary, accent: t.colors.accent,
    success: t.colors.success, warning: t.colors.warning, danger: t.colors.danger, info: t.colors.info,
  }[tone];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, paddingHorizontal: t.space.xs, marginTop: t.space.sm }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneColor }} />
      <AppText variant="overline" style={{ color: toneColor, flex: 1 }}>{header.toUpperCase()}</AppText>
      <AppText variant="caption" tone="faint">
        {count === 1 ? tr('schedule.oneStop') : tr('schedule.manyStops', { count })}
      </AppText>
    </View>
  );
};

const Fact: React.FC<{
  icon: string;
  label: string;
  value: string;
}> = ({ icon, label, value }) => {
  const t = useTheme();
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <Icon name={icon} size={12} color={t.colors.textFaint} />
        <AppText variant="overline" tone="faint">{label.toUpperCase()}</AppText>
      </View>
      <AppText variant="bodyStrong" numberOfLines={1}>{value}</AppText>
    </View>
  );
};
