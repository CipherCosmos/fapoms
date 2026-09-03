import React from 'react';
import { View } from 'react-native';
import { AssayerAssignment, ValidationQuery } from '../types/mobile-app';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Badge, EmptyState, FadeIn, GroupedRow, GroupedSection, Segmented } from '../components/ui/primitives';
import { calendarDayDiff } from '../utils/dates';
import { useSwipeSegments } from '../hooks/useSwipeSegments';
import { useT, t as translate, type TranslationKey } from '../i18n';

const QUERY_TABS = ['OPEN', 'ALL'] as const;

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
  if (days >= 2) return { label: translate('queries.waitingDays', { count: days }), tone: 'danger' };
  if (days === 1) return { label: translate('queries.waitingOneDay'), tone: 'warning' };
  const hours = Math.max(0, Math.floor((Date.now() - then) / 3_600_000));
  if (hours >= 1) return { label: translate('queries.waitingHours', { count: hours }), tone: 'neutral' };
  return { label: translate('queries.justNow'), tone: 'neutral' };
}

/** GroupedRow's hint has no line clamp (unlike the old per-row Card, which clamped the
 *  preview at 2 lines), so a long question is cut here rather than left to wrap the row
 *  to an unpredictable height inside the shared grouped-list container. */
function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

/**
 * Clarifications raised by the data entry desk about audits you submitted.
 *
 * Presented as a single Apple-style grouped list — the same container/inset-divider
 * shape as ProfileScreen's settings — because this is exactly that shape of content:
 * an icon identifying the thread's state, a title (branch), a one-line preview of the
 * question, and a trailing badge for how urgent it is, the way Messages.app lists a
 * conversation. It used to be a stack of individually-bordered Cards with a gap
 * between every one; a thread list reads as a single scannable inbox, not a deck of
 * separate cards, once state and wait-time are conveyed by an icon tint + badge
 * instead of a whole card's worth of chrome per row.
 */
export const QueriesScreen: React.FC<QueriesScreenProps> = ({ assignments, onOpenQueryChat }) => {
  const t = useTheme();
  const tr = useT();
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

  const META: Record<ThreadState, { labelKey: TranslationKey; tone: 'danger' | 'warning' | 'success'; icon: string }> = {
    NEEDS_YOU: { labelKey: 'queries.state.needsYou', tone: 'danger', icon: 'chatbubble-ellipses-outline' },
    WAITING_DESK: { labelKey: 'queries.state.withDesk', tone: 'warning', icon: 'hourglass-outline' },
    RESOLVED: { labelKey: 'queries.state.resolved', tone: 'success', icon: 'checkmark-circle-outline' },
  };

  const nothingToShow = shownOpen.length === 0 && (!showResolved || resolvedThreads.length === 0);

  const swipeSegments = useSwipeSegments(QUERY_TABS, tab, setTab);

  return (
    <View style={{ gap: t.space.lg }} {...swipeSegments.panHandlers}>
      <Segmented
        value={tab}
        onChange={(k) => setTab(k as 'OPEN' | 'ALL')}
        options={[
          { key: 'OPEN', label: tr('queries.tabNeedsAttention'), count: openThreads.length },
          { key: 'ALL', label: tr('queries.tabAll'), count: sorted.length },
        ]}
      />

      {nothingToShow ? (
        <EmptyState
          icon="checkmark-circle-outline"
          title={tab === 'OPEN' ? tr('queries.allClearTitle') : tr('queries.noneTitle')}
          body={tr('queries.emptyBody')}
        />
      ) : (
        <>
          {shownOpen.length === 0 && showResolved && (
            <EmptyState
              icon="checkmark-circle-outline"
              title={tr('queries.allClearTitle')}
              body={tr('queries.historyBody')}
            />
          )}

          {shownOpen.length > 0 && (
            <FadeIn>
              <GroupedSection>
                {shownOpen.map((a) => {
                  const state = stateOf(a);
                  const meta = META[state];
                  const q = previewOf(a);
                  const wait = state === 'NEEDS_YOU' ? waitingFor(q?.createdAt) : null;
                  const count = (a.queries || []).length;
                  const countLabel = count === 1 ? tr('queries.oneQuestion') : tr('queries.manyQuestions', { count });
                  const stateLabel = tr(meta.labelKey);
                  // Assembled from a key rather than by joining fragments: word order differs by
                  // language, and `.toLowerCase()` on the state was a no-op in Devanagari anyway.
                  const rowLabel = wait
                    ? tr('queries.rowAccessibilityWaiting', {
                        branch: a.branchName, state: stateLabel, wait: wait.label, count: countLabel,
                      })
                    : tr('queries.rowAccessibility', {
                        branch: a.branchName, state: stateLabel, count: countLabel,
                      });
                  return (
                    <GroupedRow
                      key={a.id}
                      icon={meta.icon}
                      tone={state === 'NEEDS_YOU' ? 'danger' : 'warning'}
                      label={a.branchName}
                      hint={q ? truncate(q.queryText, 64) : [a.bankName, a.solId].filter(Boolean).join(' · ') || undefined}
                      value={countLabel}
                      trailing={
                        wait ? (
                          <Badge label={wait.label} tone={wait.tone} icon="time-outline" />
                        ) : (
                          <Badge label={stateLabel} tone={meta.tone} dot />
                        )
                      }
                      onPress={() => onOpenQueryChat(a)}
                      accessibilityLabel={rowLabel}
                      chevron
                    />
                  );
                })}
              </GroupedSection>
            </FadeIn>
          )}

          {/* Resolved threads: history, not work — same grouped-list shape, but a distinct,
              muted group under its own "Resolved" header so it reads as settled record rather
              than more of the pile above that still needs a reply. */}
          {showResolved && resolvedThreads.length > 0 && (
            <FadeIn>
              <GroupedSection title={tr('queries.resolvedSection', { count: resolvedThreads.length })}>
                {resolvedThreads.map((a) => {
                  const q = previewOf(a);
                  const count = (a.queries || []).length;
                  const countLabel = count === 1 ? tr('queries.oneQuestion') : tr('queries.manyQuestions', { count });
                  return (
                    <GroupedRow
                      key={a.id}
                      icon="checkmark-circle-outline"
                      tone="success"
                      label={a.branchName}
                      hint={q?.queryText ? truncate(q.queryText, 64) : [a.bankName, a.solId].filter(Boolean).join(' · ') || undefined}
                      value={countLabel}
                      onPress={() => onOpenQueryChat(a)}
                      accessibilityLabel={tr('queries.rowAccessibilityResolved', { branch: a.branchName, count: countLabel })}
                      chevron
                    />
                  );
                })}
              </GroupedSection>
            </FadeIn>
          )}
        </>
      )}
    </View>
  );
};
