import React, { useMemo } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Badge, Button, Card, EmptyState, GroupedRow, GroupedSection, Icon, Section, Tappable } from '../components/ui/primitives';
import { AssignmentStatus, assignmentStatusLabel, formatRupees as money, formatDateOnly } from '@fapoms/shared';
import { assignmentStatusTone } from '../utils/statusTone';
import { relativeDay, RelativeDay } from '../utils/dates';
import { StatsScreen } from './StatsScreen';
import { countOpenQueries, countResolvedQueries } from '../utils/queries';
import { getAssignmentTotalFee } from '../utils/fees';
import type { AssayerAssignment, ExpenseSummary } from '../types/mobile-app';

export interface HomeScreenProps {
  assignments: AssayerAssignment[];
  totalAssignments: number;
  completedAssignments: number;
  averageRating?: number;
  runningBalance: number;
  expenseSummary: ExpenseSummary;
  onOpenAssignment: (a: AssayerAssignment) => void;
  onCheckIn: (a: AssayerAssignment) => void;
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
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
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
  runningBalance,
  expenseSummary,
  onOpenAssignment,
  onCheckIn,
  onScan,
  onNavigate,
  onAcceptOffer,
  onDeclineOffer,
  onSeeSchedule,
  onSeeQueries,
  busyActionId,
  stale,
  lastSyncedAt,
}) => {
  const t = useTheme();

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
            Showing your last synced schedule
            {lastSyncedAt
              ? ` from ${new Date(lastSyncedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`
              : ''}
            . Pull down to retry.
          </AppText>
        </View>
      )}

      {current ? (
        <CurrentJobCard
          assignment={current}
          busy={busyActionId === current.id}
          onOpen={() => onOpenAssignment(current)}
          onCheckIn={() => onCheckIn(current)}
          onScan={() => onScan(current)}
          onNavigate={() => onNavigate(current)}
        />
      ) : offers.length === 0 ? (
        <Card level={1}>
          <EmptyState
            icon="checkmark-done-circle-outline"
            title="Nothing scheduled"
            body="You have no open assignments. New work will appear here as soon as it is assigned."
          />
        </Card>
      ) : null}

      {offers.length > 0 && (
        <Section title={offers.length === 1 ? 'New offer' : `New offers (${offers.length})`}>
          <View style={{ gap: t.space.md }}>
            {offers.slice(0, 2).map((offer) => (
              <OfferCard
                key={offer.id}
                assignment={offer}
                busy={busyActionId === offer.id}
                onAccept={() => onAcceptOffer(offer)}
                onDecline={() => onDeclineOffer(offer)}
              />
            ))}
            {offers.length > 2 && (
              <Tappable
                onPress={onSeeSchedule}
                accessibilityRole="button"
                accessibilityLabel={`See all ${offers.length} offers`}
              >
                <View style={{ alignItems: 'center', paddingVertical: t.space.sm }}>
                  <AppText variant="caption" tone="primary">
                    See all {offers.length} offers
                  </AppText>
                </View>
              </Tappable>
            )}
          </View>
        </Section>
      )}

      <Section
        title="Today"
        action={
          todays.length > 0 ? (
            <Tappable
              onPress={onSeeSchedule}
              accessibilityRole="button"
              accessibilityLabel={`See all ${todays.length} assignments scheduled today`}
              // The default 8px Tappable hitSlop is fine on a big card, but this is a bare
              // caption sitting in a section header — padding gives it a real touch target
              // instead of relying entirely on hitSlop for a one-handed outdoor tap.
              style={{ paddingVertical: t.space.xs, paddingHorizontal: t.space.xs }}
            >
              <AppText variant="caption" tone="primary">
                See all
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
            label="Scheduled today"
            value={String(todays.length)}
            onPress={onSeeSchedule}
            chevron
            accessibilityLabel={`Scheduled today: ${todays.length}`}
          />
          <GroupedRow
            icon="help-circle-outline"
            tone={openQueries > 0 ? 'warning' : 'neutral'}
            label="Open queries"
            value={String(openQueries)}
            onPress={onSeeQueries}
            chevron
            accessibilityLabel={`Open queries: ${openQueries}`}
          />
          <GroupedRow
            icon="wallet-outline"
            tone="accent"
            label="Balance due to you"
            value={money(runningBalance)}
          />
          {expenseSummary.pending > 0 && (
            <GroupedRow
              icon="receipt-outline"
              tone="info"
              label="Claims awaiting approval"
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
        <Meta icon="navigate-outline" label={`${assignment.distanceKm.toFixed(1)} km`} />
      )}
      {assignment.estimatedCustomerCount > 0 && (
        <Meta icon="people-outline" label={`${assignment.estimatedCustomerCount} customers`} />
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
  const fee = getAssignmentTotalFee(assignment);
  const subtitle = [assignment.bankName, assignment.branchCode].filter(Boolean).join(' · ');
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
        <Button label="Accept" icon="checkmark" loading={busy} disabled={busy} onPress={onAccept} style={{ flex: 1 }} />
        <Button label="Decline" icon="close" variant="neutral" disabled={busy} onPress={onDecline} style={{ flex: 1 }} />
      </View>
    </Card>
  );
};

const CurrentJobCard: React.FC<{
  assignment: AssayerAssignment;
  busy?: boolean;
  onOpen: () => void;
  onCheckIn: () => void;
  onScan: () => void;
  onNavigate: () => void;
}> = ({ assignment, busy, onOpen, onCheckIn, onScan, onNavigate }) => {
  const t = useTheme();
  const checkedIn = assignment.status === 'CHECKED_IN' || assignment.status === 'IN_PROGRESS';
  const subtitle = [assignment.bankName, assignment.branchCode].filter(Boolean).join(' · ');
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
          <Button label="Scan audited return" icon="scan-outline" onPress={onScan} glow full />
        ) : (
          <Button label="Check in at branch" icon="location-outline" onPress={onCheckIn} glow full />
        )}
        {/*
          Directions disappear once the assayer is checked in — they are standing in the
          branch, so a route to it is the one thing they cannot need. It was offered at every
          status, which put a live control on the card for a journey already finished. The
          schedule list already worked this way; this card did not.
        */}
        <View style={{ flexDirection: 'row', gap: t.space.sm }}>
          {!checkedIn && (
            <Button label="Navigate" icon="navigate" variant="neutral" onPress={onNavigate} style={{ flex: 1 }} />
          )}
          <Button label="Details" icon="chevron-forward" variant="neutral" onPress={onOpen} style={{ flex: 1 }} />
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

