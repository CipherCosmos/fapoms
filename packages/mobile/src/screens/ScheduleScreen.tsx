import React from 'react';
import { View, Linking } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { MobileApiService } from '../services/api.service';
import { getAssignmentTotalFee } from '../utils/fees';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Badge, Button, Card, Divider, EmptyState, FadeIn, Icon, Segmented } from '../components/ui/primitives';
import { formatRupees as money, assignmentStatusLabel, isAssignmentTerminal, formatDateOnly } from '@fapoms/shared';
import { assignmentStatusTone } from '../utils/statusTone';
import { dayGroupHeader, dayKey, relativeDay } from '../utils/dates';

interface ScheduleScreenProps {
  assignments: AssayerAssignment[];
  /** Assignment id whose accept/check-in is in flight — drives the button spinner + disable. */
  busyActionId?: string | null;
  onAcceptAssignment: (id: string) => void;
  onOpenRejectModal: (id: string) => void;
  onCheckIn: (assignment: AssayerAssignment) => void;
  onOpenPdfDocs: (assignment: AssayerAssignment) => void;
  onOpenScanner?: (assignment: AssayerAssignment) => void;
  onCounterOffer?: (assignment: AssayerAssignment) => void;
  onOpenQueryChat?: (assignment: AssayerAssignment) => void;
  onOpenMap?: (assignment: AssayerAssignment) => void;
}

type Tone = 'neutral' | 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info';


const fmtDate = (d?: string | null) =>
  d ? formatDateOnly(d, { weekday: 'short', day: '2-digit', month: 'short' }) : 'Today';

/**
 * The route: every branch this assayer owes work on.
 *
 * Rebuilt around one card per stop that leads with where and when, states
 * plainly what is being asked, and shows only the actions legal in the current
 * status. The old version stacked six nested inline-styled rows per card at
 * 11px type and repeated the fee in three places.
 */
export const ScheduleScreen: React.FC<ScheduleScreenProps> = ({
  assignments,
  busyActionId,
  onAcceptAssignment,
  onOpenRejectModal,
  onCheckIn,
  onOpenPdfDocs,
  onOpenScanner,
  onCounterOffer,
  onOpenQueryChat,
  onOpenMap,
}) => {
  const t = useTheme();
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
        setDownloadMsg({ id: a.id, tone: 'warn', text: 'The audit packet has not been sent for this branch yet.' });
        return;
      }
      const res = await MobileApiService.getDocumentDownloadUrl(doc.id);
      if (!res.ok) {
        setDownloadMsg({ id: a.id, tone: 'warn', text: res.message || 'This document is not available to download right now.' });
        return;
      }
      await Linking.openURL(res.url);
      setDownloadMsg({ id: a.id, tone: 'ok', text: 'Download started — check your browser/downloads.' });
    } catch (e: any) {
      setDownloadMsg({ id: a.id, tone: 'warn', text: e?.message || 'Could not open the audit packet.' });
    } finally {
      setDownloadingId(null);
    }
  };


  // CANCELLED was missing from this split, so a cancelled audit stayed under Active forever
  // while HomeScreen had already dropped it from current work.
  const active = assignments.filter((a) => !isAssignmentTerminal(a.status));
  const done = assignments.filter((a) => isAssignmentTerminal(a.status));
  const shown = tab === 'ACTIVE' ? active : done;

  /**
   * Active stops as a route plan, not a pile.
   *
   * The flat list made the assayer do the calendar work themselves: every card showed a bare
   * date and nothing marked today, tomorrow, or the stop that slipped. Grouped by calendar
   * day — soonest first, overdue naturally rising to the top, unscheduled last — with the
   * day's stop count and its total fee on the header, the screen answers "what does my week
   * look like and what is each day worth" at a glance. History stays a flat reverse-
   * chronological record; grouping a done-pile adds nothing.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, assignments]);

  return (
    <View style={{ gap: t.space.lg }}>
      <Segmented
        value={tab}
        onChange={(k) => setTab(k as 'ACTIVE' | 'DONE')}
        options={[
          { key: 'ACTIVE', label: 'Active', count: active.length },
          { key: 'DONE', label: 'History', count: done.length },
        ]}
      />

      {shown.length === 0 ? (
        <EmptyState
          icon={tab === 'ACTIVE' ? 'map-outline' : 'checkmark-done-outline'}
          title={tab === 'ACTIVE' ? 'No active stops' : 'Nothing completed yet'}
          body={tab === 'ACTIVE'
            ? 'New branch assignments appear here as soon as operations dispatch them to you.'
            : 'Audits you finish or decline are kept here for your records.'}
        />
      ) : (
        groups.map((g) => (
          <View key={g.key} style={{ gap: t.space.md }}>
            {g.header && (
              <DayHeader
                header={g.header}
                tone={g.tone}
                count={g.items.length}
                totalFee={g.items.reduce((s, x) => s + getAssignmentTotalFee(x), 0)}
              />
            )}
            {g.items.map((a, i) => {
          // Wording from @fapoms/shared, tone from the app's one tone map — this screen used
          // to keep its own copy of both, and they had drifted from HomeScreen's.
          const meta = { label: assignmentStatusLabel(a.status), tone: assignmentStatusTone(a.status) as Tone };
          const fee = getAssignmentTotalFee(a);
          const rounds = a.negotiationCount || 0;

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
                  <Fact icon="calendar-outline" label="Date" value={fmtDate(a.scheduledDate)} />
                  <Fact icon="cube-outline" label="Packets" value={a.estimatedCustomerCount > 0 ? String(a.estimatedCustomerCount) : '—'} />
                  <Fact
                    icon="cash-outline"
                    label="Fee"
                    value={fee > 0 ? money(fee) : 'Fee not set'}
                    tone={fee > 0 ? 'success' : 'warning'}
                  />
                </View>

                {a.status === 'PENDING' && (
                  <View style={{ gap: t.space.sm }}>
                    {rounds > 0 && (
                      <View style={{
                        padding: t.space.md, borderRadius: t.radius.md,
                        backgroundColor: t.colors.accentSoft, gap: 3,
                      }}>
                        <AppText variant="caption" tone="accent">
                          Counter-offer round {rounds} of 3 · proposed {money(a.proposedFee ?? 0)}
                        </AppText>
                        {a.remarks ? <AppText variant="small" tone="muted">{a.remarks}</AppText> : null}
                      </View>
                    )}
                    <View style={{ flexDirection: 'row', gap: t.space.sm }}>
                      <Button label="Accept" icon="checkmark" loading={busyActionId === a.id} disabled={busyActionId != null} onPress={() => onAcceptAssignment(a.id)} style={{ flex: 1 }} />
                      <Button label="Decline" icon="close" variant="neutral" disabled={busyActionId != null} onPress={() => onOpenRejectModal(a.id)} style={{ flex: 1 }} />
                    </View>
                    {onCounterOffer && (
                      <Button
                        label={rounds >= 3 ? 'Negotiation closed' : `Propose a different fee (${rounds}/3)`}
                        icon={rounds >= 3 ? 'lock-closed-outline' : 'swap-horizontal'}
                        variant="neutral"
                        disabled={rounds >= 3}
                        onPress={() => onCounterOffer(a)}
                        full
                      />
                    )}
                  </View>
                )}

                {a.status === 'ACCEPTED' && (
                  <View style={{ flexDirection: 'row', gap: t.space.sm }}>
                    {onOpenMap && (
                      <Button label="Navigate" icon="navigate" variant="neutral" onPress={() => onOpenMap(a)} style={{ flex: 1 }} />
                    )}
                    <Button label="Check in" icon="log-in-outline" loading={busyActionId === a.id} disabled={busyActionId != null} onPress={() => onCheckIn(a)} style={{ flex: 1 }} />
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
                      label="Scan & submit audited return"
                      icon="scan"
                      onPress={() => (onOpenScanner ? onOpenScanner(a) : onOpenPdfDocs(a))}
                      full
                    />

                    {/*
                      The packet download appears only once operations has actually dispatched
                      it. `documentReadiness` comes down with the assignment, so this is decided
                      before the button is drawn rather than discovered after a failed tap.
                    */}
                    {a.documentReadiness?.state === 'READY' && (
                      <Button
                        label={downloadingId === a.id ? 'Opening…' : 'Download audit packet'}
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
                    label={`${a.queries.length} clarification${a.queries.length > 1 ? 's' : ''} from the desk`}
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
    </View>
  );
};

/**
 * A day's header on the route: when, how many stops, and what the day is worth.
 * The fee total is the figure an assayer plans a travel day around, and it was
 * previously only computable by opening every card and adding in your head.
 */
const DayHeader: React.FC<{ header: string; tone: Tone; count: number; totalFee: number }> = ({
  header, tone, count, totalFee,
}) => {
  const t = useTheme();
  const toneColor = {
    neutral: t.colors.textFaint, primary: t.colors.primary, accent: t.colors.accent,
    success: t.colors.success, warning: t.colors.warning, danger: t.colors.danger, info: t.colors.info,
  }[tone];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, paddingHorizontal: t.space.xs, marginTop: t.space.sm }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneColor }} />
      <AppText variant="overline" style={{ color: toneColor, flex: 1 }}>{header.toUpperCase()}</AppText>
      <AppText variant="caption" tone="faint">
        {count} {count === 1 ? 'stop' : 'stops'}{totalFee > 0 ? ` · ${money(totalFee)}` : ''}
      </AppText>
    </View>
  );
};

const Fact: React.FC<{
  icon: string;
  label: string;
  value: string;
  tone?: 'success' | 'warning';
}> = ({ icon, label, value, tone }) => {
  const t = useTheme();
  const color = tone === 'success' ? t.colors.success : tone === 'warning' ? t.colors.warning : t.colors.text;
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <Icon name={icon} size={12} color={t.colors.textFaint} />
        <AppText variant="overline" tone="faint">{label.toUpperCase()}</AppText>
      </View>
      <AppText variant="bodyStrong" numberOfLines={1} style={{ color }}>{value}</AppText>
    </View>
  );
};
