import React from 'react';
import { View } from 'react-native';
import { AssayerAssignment, ValidationQuery } from '../types/mobile-app';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Avatar, Badge, Card, EmptyState, FadeIn, Icon, Segmented, Tappable } from '../components/ui/primitives';
import { calendarDayDiff } from '../utils/dates';

interface QueriesScreenProps {
  assignments: AssayerAssignment[];
  onOpenQueryChat: (assignment: AssayerAssignment) => void;
}

type ThreadState = 'NEEDS_YOU' | 'WAITING_DESK' | 'RESOLVED';

/**
 * How long a question has sat unanswered, phrased as the SLA risk it is.
 *
 * Same-day is calm, one day old leans warning ("answer before you leave the
 * branch"), two days or more is danger — by then the desk is blocked on you.
 * Hours for the first day because "waiting 0 days" hides a morning-to-evening gap.
 */
function waitingFor(iso: string | undefined): { label: string; tone: 'neutral' | 'warning' | 'danger' } | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const days = -calendarDayDiff(iso);
  if (days >= 2) return { label: `Waiting ${days}d`, tone: 'danger' };
  if (days === 1) return { label: 'Waiting 1d', tone: 'warning' };
  const hours = Math.max(0, Math.floor((Date.now() - then) / 3_600_000));
  if (hours >= 1) return { label: `Waiting ${hours}h`, tone: 'neutral' };
  return { label: 'Just now', tone: 'neutral' };
}

/**
 * Clarifications raised by the data entry desk about audits you submitted.
 *
 * Redesigned as an inbox: every row reads like a conversation — who asked,
 * what they asked (two-line preview), and how long it has been waiting on you.
 * Open threads sit on top with an unread dot and an aging badge; resolved
 * threads collapse into a muted history strip below, because they are records,
 * not work.
 */
export const QueriesScreen: React.FC<QueriesScreenProps> = ({ assignments, onOpenQueryChat }) => {
  const t = useTheme();
  const [tab, setTab] = React.useState<'OPEN' | 'ALL'>('OPEN');

  const withQueries = assignments.filter((a) => a.queries && a.queries.length > 0);

  const stateOf = (a: AssayerAssignment): ThreadState => {
    const qs = a.queries || [];
    if (qs.some((q) => q.status === 'OPEN')) return 'NEEDS_YOU';
    if (qs.some((q) => q.status === 'RESPONDED')) return 'WAITING_DESK';
    return 'RESOLVED';
  };

  /** The message the row previews: the oldest still-open question (the one aging), else the newest. */
  const previewOf = (a: AssayerAssignment): ValidationQuery | undefined => {
    const qs = (a.queries || []).slice().sort((x, y) => (x.createdAt || '').localeCompare(y.createdAt || ''));
    return qs.find((q) => q.status === 'OPEN') || qs[qs.length - 1];
  };

  /** Oldest thread first within the open pile — the longest wait is the biggest risk. */
  const rank: Record<ThreadState, number> = { NEEDS_YOU: 0, WAITING_DESK: 1, RESOLVED: 2 };
  const sorted = withQueries.slice().sort((a, b) => {
    const byState = rank[stateOf(a)] - rank[stateOf(b)];
    if (byState !== 0) return byState;
    return (previewOf(a)?.createdAt || '').localeCompare(previewOf(b)?.createdAt || '');
  });
  const openThreads = sorted.filter((a) => stateOf(a) !== 'RESOLVED');
  const resolvedThreads = sorted.filter((a) => stateOf(a) === 'RESOLVED');
  const shownOpen = openThreads;
  const showResolved = tab === 'ALL';

  const META: Record<ThreadState, { label: string; tone: 'danger' | 'warning' | 'success' }> = {
    NEEDS_YOU: { label: 'Needs your reply', tone: 'danger' },
    WAITING_DESK: { label: 'With the desk', tone: 'warning' },
    RESOLVED: { label: 'Resolved', tone: 'success' },
  };

  const nothingToShow = shownOpen.length === 0 && (!showResolved || resolvedThreads.length === 0);

  return (
    <View style={{ gap: t.space.lg }}>
      <Segmented
        value={tab}
        onChange={(k) => setTab(k as 'OPEN' | 'ALL')}
        options={[
          { key: 'OPEN', label: 'Needs attention', count: openThreads.length },
          { key: 'ALL', label: 'All', count: sorted.length },
        ]}
      />

      {nothingToShow ? (
        <EmptyState
          icon="checkmark-circle-outline"
          title={tab === 'OPEN' ? 'All clear — nothing waiting on you' : 'No queries from the desk'}
          body="When the data entry desk cannot read something on a sheet you submitted, they ask here — with the exact area of the page marked."
        />
      ) : (
        <>
          {shownOpen.length === 0 && showResolved && (
            <EmptyState
              icon="checkmark-circle-outline"
              title="All clear — nothing waiting on you"
              body="Everything below is settled history."
            />
          )}

          {shownOpen.map((a, i) => {
            const state = stateOf(a);
            const meta = META[state];
            const q = previewOf(a);
            const wait = state === 'NEEDS_YOU' ? waitingFor(q?.createdAt) : null;
            const count = (a.queries || []).length;
            return (
              <FadeIn key={a.id} delay={Math.min(i, 6) * 45}>
                <Card level={1} onPress={() => onOpenQueryChat(a)} style={{ gap: t.space.md }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                    {/* Unread-style dot: lit while the thread is on the assayer. */}
                    <View
                      style={{
                        width: 8, height: 8, borderRadius: 4,
                        backgroundColor: state === 'NEEDS_YOU' ? t.colors.danger : 'transparent',
                      }}
                    />
                    <Avatar name={q?.validatorName || a.branchName} size={40} />
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <AppText variant="h3" numberOfLines={1}>{a.branchName}</AppText>
                      <AppText variant="caption" tone="faint" numberOfLines={1}>
                        {[a.bankName, a.branchCode].filter(Boolean).join(' · ') || '—'}
                      </AppText>
                    </View>
                    {wait ? (
                      <Badge label={wait.label} tone={wait.tone} icon="time-outline" />
                    ) : (
                      <Badge label={meta.label} tone={meta.tone} dot />
                    )}
                  </View>

                  {q && (
                    <View
                      style={{
                        backgroundColor: t.colors.surfaceAlt,
                        borderRadius: t.radius.md,
                        borderWidth: 1,
                        borderColor: t.colors.border,
                        padding: t.space.md,
                        gap: 4,
                      }}
                    >
                      <AppText variant="body" numberOfLines={2}>{q.queryText}</AppText>
                      <AppText variant="caption" tone="faint" numberOfLines={1}>
                        {[q.validatorName, q.customerName].filter(Boolean).join(' · about ')}
                      </AppText>
                    </View>
                  )}

                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <AppText variant="caption" tone="muted">
                      {count === 1 ? '1 question' : `${count} questions`}
                      {wait ? '' : ` · ${meta.label.toLowerCase()}`}
                    </AppText>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <AppText variant="caption" tone={state === 'NEEDS_YOU' ? 'primary' : 'muted'}>
                        {state === 'NEEDS_YOU' ? 'Reply' : 'Open thread'}
                      </AppText>
                      <Icon
                        name="chevron-forward"
                        size={14}
                        color={state === 'NEEDS_YOU' ? t.colors.primary : t.colors.textMuted}
                      />
                    </View>
                  </View>
                </Card>
              </FadeIn>
            );
          })}

          {/* Resolved threads: history, not work — muted, compact, below the fold. */}
          {showResolved && resolvedThreads.length > 0 && (
            <View style={{ gap: t.space.sm }}>
              <View style={{ paddingHorizontal: t.space.xs, paddingTop: t.space.sm }}>
                <AppText variant="overline" tone="faint">
                  {`RESOLVED · ${resolvedThreads.length}`}
                </AppText>
              </View>
              {resolvedThreads.map((a, i) => {
                const q = previewOf(a);
                const count = (a.queries || []).length;
                return (
                  <FadeIn key={a.id} delay={Math.min(i, 6) * 35}>
                    <Tappable onPress={() => onOpenQueryChat(a)} scaleTo={0.985}>
                      <View
                        style={{
                          flexDirection: 'row', alignItems: 'center', gap: t.space.md,
                          backgroundColor: t.colors.surface, borderRadius: t.radius.lg,
                          borderWidth: 1, borderColor: t.colors.border,
                          paddingHorizontal: t.space.lg, paddingVertical: t.space.md,
                        }}
                      >
                        <Icon name="checkmark-circle" size={18} color={t.colors.success} />
                        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                          <AppText variant="bodyStrong" tone="muted" numberOfLines={1}>{a.branchName}</AppText>
                          <AppText variant="caption" tone="faint" numberOfLines={1}>
                            {q?.queryText || [a.bankName, a.branchCode].filter(Boolean).join(' · ') || '—'}
                          </AppText>
                        </View>
                        <AppText variant="caption" tone="faint">{count}</AppText>
                        <Icon name="chevron-forward" size={14} color={t.colors.textFaint} />
                      </View>
                    </Tappable>
                  </FadeIn>
                );
              })}
            </View>
          )}
        </>
      )}
    </View>
  );
};
