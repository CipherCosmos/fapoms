import React, { useMemo } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Badge, Button, Card, EmptyState, FadeIn, GroupedRow, GroupedSection, Icon, Section, Tappable } from '../components/ui/primitives';
import { AssignmentStatus, assignmentStatusLabel, formatRupees as money, formatDateOnly } from '@fapoms/shared';
import { assignmentStatusTone } from '../utils/statusTone';
import { relativeDay, RelativeDay } from '../utils/dates';
import { useT, t } from '../i18n';
import { StatsScreen } from './StatsScreen';
import { countOpenQueries, countResolvedQueries } from '../utils/queries';
import { assignmentFeeValue } from '../utils/fees';
import type { AssayerAssignment, AssayerStatement, ExpenseSummary } from '../types/mobile-app';
import { LocationConfirmBanner } from '../components/LocationConfirmBanner';
import { RegistrationPapersBanner } from '../components/RegistrationPapersBanner';

export interface HomeScreenProps {
  assignments: AssayerAssignment[];
  totalAssignments: number;
  completedAssignments: number;
  averageRating?: number;
  /** The assayer's statement — the one source for what they are owed. Null while it loads. */
  statement?: AssayerStatement | null;
  /** True when the last statement read failed: show a dash, never a stale or invented figure. */
  statementError?: boolean;
  expenseSummary: ExpenseSummary;
  onOpenAssignment: (a: AssayerAssignment) => void;
  onCheckIn: (a: AssayerAssignment) => void;
  /** Records leaving the branch. Does not finish the audit. */
  onCheckOut?: (a: AssayerAssignment) => void;
  onScan: (a: AssayerAssignment) => void;
  onNavigate: (a: AssayerAssignment) => void;
  onAcceptOffer: (a: AssayerAssignment) => void;
  onDeclineOffer: (a: AssayerAssignment) => void;
  onSeeSchedule: () => void;
  onSeeQueries: () => void;
  /** Assignment id whose accept/check-in is in flight — drives the button spinner + disable. */
  busyActionId?: string | null;
  /** Set when the list came from cache because the last refresh failed. */
  stale?: boolean;
  lastSyncedAt?: string | null;
  /** The signed-in assayer's id and whether the server flagged their map location as unreliable. */
  assayerId?: string;
  locationNeedsConfirmation?: boolean;
  onLocationConfirmed?: () => void;
  /**
   * Registration paperwork the office is still waiting for, and any scan whose upload failed.
   * Both default to zero, so a checklist that did not load simply shows no banner — this is an
   * optional shortcut and must never be in anybody's way.
   */
  papersOutstanding?: number;
  papersFailed?: number;
  onOpenRegistration?: () => void;
}

const isSameDay = (iso: string, day: Date): boolean => {
  const d = new Date(iso);
  return (
    d.getFullYear() === day.getFullYear() &&
    d.getMonth() === day.getMonth() &&
    d.getDate() === day.getDate()
  );
};

const greeting = (): string => {
  const h = new Date().getHours();
  if (h < 12) return t('home.greetingMorning');
  if (h < 17) return t('home.greetingAfternoon');
  return t('home.greetingEvening');
};

/**
 * The landing screen: what needs doing right now.
 *
 * The app previously opened straight onto the full schedule list, which shows every
 * assignment with equal weight — an assayer standing outside a branch had to find today's
 * job among them and then work out which action came next. This puts the current job and
 * its one next action first, and demotes everything else to a summary.
 */
export const HomeScreen: React.FC<HomeScreenProps> = ({
  assignments,
  totalAssignments,
  completedAssignments,
  averageRating,
  statement,
  statementError,
  expenseSummary,
  onOpenAssignment,
  onCheckIn,
  onCheckOut,
  onScan,
  onNavigate,
  onAcceptOffer,
  onDeclineOffer,
  onSeeSchedule,
  onSeeQueries,
  busyActionId,
  stale,
  lastSyncedAt,
  assayerId,
  locationNeedsConfirmation,
  onLocationConfirmed,
  papersOutstanding = 0,
  papersFailed = 0,
  onOpenRegistration,
}) => {
  const t = useTheme();
  const tr = useT();

  const { current, offers, todays, openQueries, resolvedQueries } = useMemo(() => {
    const today = new Date();
    const todaysJobs = assignments.filter((a) => isSameDay(a.scheduledDate, today));

    /**
     * PENDING is excluded from "current job" on purpose.
     *
     * An assignment the assayer has not accepted is an offer, not their work — but it used to
     * be promoted straight into the hero card, which handed them "Check in at branch",
     * Navigate and the full packet detail for a job that is not theirs yet. Someone could
     * drive to a branch and check in against an offer they never accepted, and the one
     * decision the offer actually needs — accept or decline — was nowhere on the screen.
     */
    const pendingOffers = assignments
      .filter((a) => a.status === 'PENDING')
      .sort((a, b) => +new Date(a.scheduledDate) - +new Date(b.scheduledDate));

    const inFlight = assignments.find((a) => a.status === 'CHECKED_IN' || a.status === 'IN_PROGRESS');
    const accepted = [...assignments]
      .filter((a) => a.status === 'ACCEPTED')
      .sort((a, b) => +new Date(a.scheduledDate) - +new Date(b.scheduledDate));
    const nextToday = accepted.find((a) => isSameDay(a.scheduledDate, today));

    return {
      current: inFlight || nextToday || accepted[0] || null,
      offers: pendingOffers,
      todays: todaysJobs,
      // Both from the shared helper — the tab badge reads the same one.
      openQueries: countOpenQueries(assignments),
      resolvedQueries: countResolvedQueries(assignments),
    };
  }, [assignments]);

  return (
    <View style={{ gap: t.space['2xl'] }}>
      {/*
        Greeting and date only — the app bar directly above already shows the assayer's name
        and code, so repeating the name here in display type spent the most valuable space on
        the screen restating what the user just read.
      */}
      <View style={{ gap: 2 }}>
        <AppText variant="largeTitle">{greeting()}</AppText>
        <AppText variant="small" tone="muted">
          {new Date().toLocaleDateString('en-IN', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          })}
        </AppText>
      </View>

      {/*
        Placing themselves on the map: shown only to assayers the server flagged, so the ~75
        with a coarse or missing position see it and the 1,080 already pinned never do.
      */}
      {locationNeedsConfirmation && assayerId && (
        <LocationConfirmBanner assayerId={assayerId} onConfirmed={onLocationConfirmed} />
      )}

      {/*
        Registration paperwork. Below the location banner rather than above it: a missing map pin
        stops work being sent to this person at all, while missing papers are handled at the desk
        either way — so if both are showing, the one that actually costs them jobs is on top.
      */}
      {onOpenRegistration && (
        <RegistrationPapersBanner
          outstanding={papersOutstanding}
          failed={papersFailed}
          onOpen={onOpenRegistration}
        />
      )}

      {/*
        Says plainly that the screen is not live. Without this an assayer in a vault cannot
        tell "no work today" apart from "the app could not reach the server" — and those two
        call for opposite actions.
      */}
      {stale && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: t.space.sm,
            padding: t.space.md,
            borderRadius: t.radius.md,
            backgroundColor: t.colors.warningSoft,
          }}
        >
          <Icon name="cloud-offline-outline" size={16} color={t.colors.warning} />
          <AppText variant="small" tone="warning" style={{ flex: 1 }}>
            {tr('home.stale', {
              since: lastSyncedAt
                ? tr('home.staleSince', {
                    time: new Date(lastSyncedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }),
                  })
                : '',
            })}
          </AppText>
        </View>
      )}

      {current ? (
        <CurrentJobCard
          assignment={current}
          busy={busyActionId === current.id}
          onOpen={() => onOpenAssignment(current)}
          onCheckIn={() => onCheckIn(current)}
          onCheckOut={onCheckOut && !current.checkedOutAt ? () => onCheckOut(current) : undefined}
          onScan={() => onScan(current)}
          onNavigate={() => onNavigate(current)}
        />
      ) : offers.length === 0 ? (
        <Card level={1}>
          <EmptyState
            icon="checkmark-done-circle-outline"
            title={tr('home.emptyTitle')}
            body={tr('home.emptyBody')}
          />
        </Card>
      ) : null}

      {offers.length > 0 && (
        <Section title={offers.length === 1 ? tr('home.oneOffer') : tr('home.manyOffers', { count: offers.length })}>
          <View style={{ gap: t.space.md }}>
            {/* Staggered entrance, matching ScheduleScreen's assignment list — this was the one
                list of rows in the app with a hard cut while its sibling screen crossfades in,
                which is exactly the kind of felt-not-named inconsistency the audit was for. */}
            {offers.slice(0, 2).map((offer, i) => (
              <FadeIn key={offer.id} delay={Math.min(i, 6) * 45}>
                <OfferCard
                  assignment={offer}
                  busy={busyActionId === offer.id}
                  onAccept={() => onAcceptOffer(offer)}
                  onDecline={() => onDeclineOffer(offer)}
                />
              </FadeIn>
            ))}
            {offers.length > 2 && (
              <Tappable
                onPress={onSeeSchedule}
                accessibilityRole="button"
                accessibilityLabel={tr('home.seeAllOffers', { count: offers.length })}
              >
                <View style={{ alignItems: 'center', paddingVertical: t.space.sm }}>
                  <AppText variant="caption" tone="primary">
                    {tr('home.seeAllOffers', { count: offers.length })}
                  </AppText>
                </View>
              </Tappable>
            )}
          </View>
        </Section>
      )}

      <Section
        title={tr('home.today')}
        action={
          todays.length > 0 ? (
            <Tappable
              onPress={onSeeSchedule}
              accessibilityRole="button"
              accessibilityLabel={tr('home.seeAllToday', { count: todays.length })}
              // The default 8px Tappable hitSlop is fine on a big card, but this is a bare
              // caption sitting in a section header — padding gives it a real touch target
              // instead of relying entirely on hitSlop for a one-handed outdoor tap.
              style={{ paddingVertical: t.space.xs, paddingHorizontal: t.space.xs }}
            >
              <AppText variant="caption" tone="primary">
                {tr('home.seeAll')}
              </AppText>
            </Tappable>
          ) : undefined
        }
      >
        {/*
          These four are exactly what GroupedRow/GroupedSection exist for — navigable or
          informational option rows, not a stat or an assignment. The old markup was a Card
          with a bespoke SummaryRow per line, each drawing its own full-bleed divider; that
          is precisely the "stack of separately-bordered rows" pattern ProfileScreen's grouped
          list replaced. One rounded container with inset hairlines reads as a single unit
          instead of four unrelated boxes stacked with gaps.
        */}
        <GroupedSection>
          <GroupedRow
            icon="calendar-outline"
            tone="primary"
            label={tr('home.scheduledToday')}
            value={String(todays.length)}
            onPress={onSeeSchedule}
            chevron
            accessibilityLabel={tr('home.scheduledTodayValue', { count: todays.length })}
          />
          <GroupedRow
            icon="help-circle-outline"
            tone={openQueries > 0 ? 'warning' : 'neutral'}
            label={tr('home.openQueries')}
            value={String(openQueries)}
            onPress={onSeeQueries}
            chevron
            accessibilityLabel={tr('home.openQueriesValue', { count: openQueries })}
          />
          <GroupedRow
            icon="wallet-outline"
            tone="accent"
            label={tr('home.balance')}
            value={statement ? money(statement.totals.outstanding) : statementError ? '—' : '…'}
          />
          {expenseSummary.pending > 0 && (
            <GroupedRow
              icon="receipt-outline"
              tone="info"
              label={tr('home.claimsPending')}
              value={money(expenseSummary.pending)}
            />
          )}
        </GroupedSection>
      </Section>

      <StatsScreen
        totalAssignments={totalAssignments}
        completedAssignments={completedAssignments}
        averageRating={averageRating}
        openQueries={openQueries}
        resolvedQueries={resolvedQueries}
      />
    </View>
  );
};



/**
 * The line of facts under an assignment's title: when, where, how big, what it pays.
 *
 * Rendered identically by the offer card and the job card, and it was written out twice —
 * same badge, same date rule, same distance and customer formatting. Two copies of a display
 * rule drift: change how distance rounds and you change it in one place, and the same branch
 * then reads differently depending on whether the assayer is looking at the offer or the job
 * they accepted.
 *
 * The fee is the one real difference. It belongs on an offer, where the assayer is deciding
 * whether to take the work, and not on the job afterwards, where it is settled and the card is
 * about getting there.
 */
const AssignmentMeta: React.FC<{
  assignment: AssayerAssignment;
  /** From `relativeDay` — the label, its urgency tone and the calendar-day offset. */
  when: RelativeDay;
  /** Shown only when there is a fee to show — offers, not accepted jobs. */
  fee?: number;
}> = ({ assignment, when, fee }) => {
  const t = useTheme();
  const tr = useT();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: t.space.sm }}>
      {/* Urgency first: overdue reads danger, today accent, tomorrow warning. */}
      <Badge label={when.label} tone={when.tone} icon="time-outline" />
      {/* The concrete date stays for anything not today — "In 8 days" alone would make the
          assayer open Details just to write the date down. */}
      {when.diffDays !== 0 && (
        <Meta icon="calendar-outline" label={formatDateOnly(assignment.scheduledDate, { day: 'numeric', month: 'short' })} />
      )}
      {assignment.distanceKm != null && (
        <Meta icon="navigate-outline" label={tr('home.distanceKm', { km: assignment.distanceKm.toFixed(1) })} />
      )}
      {assignment.estimatedCustomerCount > 0 && (
        <Meta icon="people-outline" label={tr('home.customers', { count: assignment.estimatedCustomerCount })} />
      )}
      {fee != null && fee > 0 && <Meta icon="wallet-outline" label={money(fee)} />}
    </View>
  );
};

/**
 * A job offer awaiting the assayer's decision.
 *
 * Deliberately carries only what that decision needs — where, when, how far, how many
 * customers, and the fee — plus the two answers. No check-in, no scanning, no packet
 * documents: those belong to work the assayer has agreed to do. The offer's operational
 * detail stays minimal until acceptance.
 */
const OfferCard: React.FC<{
  assignment: AssayerAssignment;
  busy?: boolean;
  onAccept: () => void;
  onDecline: () => void;
}> = ({ assignment, busy, onAccept, onDecline }) => {
  const t = useTheme();
  const tr = useT();
  const fee = assignmentFeeValue(assignment);
  const subtitle = [assignment.bankName, assignment.solId].filter(Boolean).join(' · ');
  // Accepting an offer is a commitment to a date; "Tomorrow" and "In 3 days" are different
  // decisions, and the bare date left that arithmetic to the assayer.
  const when = relativeDay(assignment.scheduledDate);

  return (
    <Card level={2} style={{ gap: t.space.lg }}>
      <View style={{ gap: t.space.xs }}>
        <Badge label={assignmentStatusLabel(assignment.status)} tone="warning" dot />
        <AppText variant="h2">{assignment.branchName}</AppText>
        {subtitle ? (
          <AppText variant="small" tone="muted">
            {subtitle}
          </AppText>
        ) : null}
      </View>

      <AssignmentMeta assignment={assignment} when={when} fee={fee} />

      <View style={{ flexDirection: 'row', gap: t.space.sm }}>
        <Button label={tr('home.accept')} icon="checkmark" loading={busy} disabled={busy} onPress={onAccept} style={{ flex: 1 }} />
        <Button label={tr('home.decline')} icon="close" variant="neutral" disabled={busy} onPress={onDecline} style={{ flex: 1 }} />
      </View>
    </Card>
  );
};

const CurrentJobCard: React.FC<{
  assignment: AssayerAssignment;
  busy?: boolean;
  onOpen: () => void;
  onCheckIn: () => void;
  /** Absent when the assayer has already left, so the card stops offering it. */
  onCheckOut?: () => void;
  onScan: () => void;
  onNavigate: () => void;
}> = ({ assignment, busy, onOpen, onCheckIn, onCheckOut, onScan, onNavigate }) => {
  const t = useTheme();
  const tr = useT();
  const checkedIn = assignment.status === 'CHECKED_IN' || assignment.status === 'IN_PROGRESS';
  const subtitle = [assignment.bankName, assignment.solId].filter(Boolean).join(' · ');
  // "Today" / "In 8 days" / "3 days overdue" — the calendar arithmetic done for the assayer.
  // The bare date this replaces answered "when is it?" but not the question the hero card
  // exists for: "is this now?".
  const when = relativeDay(assignment.scheduledDate);

  return (
    <Card level={2} style={{ gap: t.space.lg, borderColor: t.colors.primary + '40' }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: t.space.md }}>
        <View style={{ flex: 1, gap: t.space.xs }}>
          <Badge
            label={assignmentStatusLabel(assignment.status)}
            tone={assignmentStatusTone(assignment.status)}
            dot
          />
          <AppText variant="h2">{assignment.branchName}</AppText>
          {/*
            Only the parts that exist get joined. Interpolating both unconditionally rendered a
            stranded "· 203" whenever the branch had no bank name on it — which is the case for
            real branches in this data, so the separator was visible on the very first card.
          */}
          {subtitle ? (
            <AppText variant="small" tone="muted">
              {subtitle}
            </AppText>
          ) : null}
        </View>
      </View>

      <AssignmentMeta assignment={assignment} when={when} />

      {/*
        One primary action, chosen by where the job actually is. Showing check-in, scan and
        navigate as three equal buttons made the assayer decide what the app already knows.
      */}
      <View style={{ gap: t.space.sm }}>
        {/* The one glowing CTA on the screen — the next real-world step for the current job. */}
        {checkedIn ? (
          <Button label={tr('home.scanReturn')} icon="scan-outline" onPress={onScan} glow full />
        ) : (
          <Button label={tr('home.checkIn')} icon="location-outline" onPress={onCheckIn} glow full />
        )}
        {/*
          Directions disappear once the assayer is checked in — they are standing in the
          branch, so a route to it is the one thing they cannot need. It was offered at every
          status, which put a live control on the card for a journey already finished. The
          schedule list already worked this way; this card did not.
        */}
        <View style={{ flexDirection: 'row', gap: t.space.sm }}>
          {!checkedIn && (
            <Button label={tr('home.navigate')} icon="navigate" variant="neutral" onPress={onNavigate} style={{ flex: 1 }} />
          )}
          {/*
            Check-out takes the slot Navigate vacates once the assayer is on site — the row is
            otherwise empty at exactly that status. Secondary on purpose: the audited return is
            still the primary action, because leaving the branch is not what finishes the job.
          */}
          {checkedIn && onCheckOut && (
            <Button label={tr('home.checkOut')} icon="log-out-outline" variant="neutral" onPress={onCheckOut} style={{ flex: 1 }} />
          )}
          <Button label={tr('home.details')} icon="chevron-forward" variant="neutral" onPress={onOpen} style={{ flex: 1 }} />
        </View>
      </View>
    </Card>
  );
};

/**
 * A meta fact as a neon chip — time, distance, customers, fee.
 *
 * Was a bare icon+label row that dissolved into the card. As a tinted pill with a cyan glyph
 * it reads as a scannable tag, the pattern every modern field/delivery app uses to surface the
 * few numbers that matter at a glance.
 */
const Meta: React.FC<{ icon: string; label: string }> = ({ icon, label }) => {
  const t = useTheme();
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: t.colors.surfaceAlt,
      borderWidth: 1, borderColor: t.colors.border,
      paddingHorizontal: 10, paddingVertical: 6, borderRadius: t.radius.pill,
    }}>
      <Icon name={icon} size={13} color={t.colors.accent} />
      <AppText variant="caption" tone="muted">
        {label}
      </AppText>
    </View>
  );
};

