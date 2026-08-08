import React, { useMemo } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Badge, Button, Card, EmptyState, Icon, Section, Tappable } from '../components/ui/primitives';
import { AssignmentStatus, assignmentStatusLabel, formatRupees as money, isAssignmentTerminal } from '@fapoms/shared';
import { assignmentStatusTone } from '../utils/statusTone';
import { StatsScreen } from './StatsScreen';
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
  onSeeSchedule: () => void;
  onSeeQueries: () => void;
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
  onSeeSchedule,
  onSeeQueries,
  stale,
  lastSyncedAt,
}) => {
  const t = useTheme();

  const { current, todays, openQueries, resolvedQueries } = useMemo(() => {
    const today = new Date();
    const todaysJobs = assignments.filter((a) => isSameDay(a.scheduledDate, today));

    // "Current" is whatever the assayer is part-way through, else the next thing due today,
    // else the next thing due at all — so the card is never empty while work remains.
    const inFlight = assignments.find((a) => a.status === 'CHECKED_IN' || a.status === 'IN_PROGRESS');
    const nextToday = todaysJobs.find((a) => a.status === 'ACCEPTED' || a.status === 'PENDING');
    const nextEver = [...assignments]
      .filter((a) => !isAssignmentTerminal(a.status))
      .sort((a, b) => +new Date(a.scheduledDate) - +new Date(b.scheduledDate))[0];

    const queries = assignments.flatMap((a) => a.queries || []);

    return {
      current: inFlight || nextToday || nextEver || null,
      todays: todaysJobs,
      /**
       * Three states, counted as three.
       *
       * `!== 'OPEN'` previously folded RESPONDED in with RESOLVED, so a query the assayer had
       * answered but nobody had closed was reported back to them as resolved — and the
       * resolution rate on the stats card counted work that is still outstanding.
       */
      openQueries: queries.filter((q) => q.status === 'OPEN').length,
      resolvedQueries: queries.filter((q) => q.status === 'RESOLVED').length,
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
        <AppText variant="h2">{greeting()}</AppText>
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
          onOpen={() => onOpenAssignment(current)}
          onCheckIn={() => onCheckIn(current)}
          onScan={() => onScan(current)}
          onNavigate={() => onNavigate(current)}
        />
      ) : (
        <Card level={1}>
          <EmptyState
            icon="checkmark-done-circle-outline"
            title="Nothing scheduled"
            body="You have no open assignments. New work will appear here as soon as it is assigned."
          />
        </Card>
      )}

      <Section
        title="Today"
        action={
          todays.length > 0 ? (
            <Tappable onPress={onSeeSchedule}>
              <AppText variant="caption" tone="primary">
                See all
              </AppText>
            </Tappable>
          ) : undefined
        }
      >
        <Card level={1} style={{ gap: t.space.md }}>
          <SummaryRow
            icon="calendar-outline"
            label="Scheduled today"
            value={String(todays.length)}
            onPress={onSeeSchedule}
          />
          <SummaryRow
            icon="help-circle-outline"
            label="Open queries"
            value={String(openQueries)}
            tone={openQueries > 0 ? 'warning' : undefined}
            onPress={onSeeQueries}
          />
          <SummaryRow icon="wallet-outline" label="Balance due to you" value={money(runningBalance)} />
          {expenseSummary.pending > 0 && (
            <SummaryRow
              icon="receipt-outline"
              label="Claims awaiting approval"
              value={money(expenseSummary.pending)}
              tone="info"
            />
          )}
        </Card>
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


const CurrentJobCard: React.FC<{
  assignment: AssayerAssignment;
  onOpen: () => void;
  onCheckIn: () => void;
  onScan: () => void;
  onNavigate: () => void;
}> = ({ assignment, onOpen, onCheckIn, onScan, onNavigate }) => {
  const t = useTheme();
  const when = new Date(assignment.scheduledDate);
  const checkedIn = assignment.status === 'CHECKED_IN' || assignment.status === 'IN_PROGRESS';
  const subtitle = [assignment.bankName, assignment.branchCode].filter(Boolean).join(' · ');

  return (
    <Card level={2} style={{ gap: t.space.lg }}>
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

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.lg }}>
        <Meta icon="time-outline" label={when.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} />
        {assignment.distanceKm != null && (
          <Meta icon="navigate-outline" label={`${assignment.distanceKm.toFixed(1)} km`} />
        )}
        {assignment.estimatedCustomerCount > 0 && (
          <Meta icon="people-outline" label={`${assignment.estimatedCustomerCount} customers`} />
        )}
      </View>

      {/*
        One primary action, chosen by where the job actually is. Showing check-in, scan and
        navigate as three equal buttons made the assayer decide what the app already knows.
      */}
      <View style={{ gap: t.space.sm }}>
        {checkedIn ? (
          <Button label="Scan audited return" icon="scan-outline" onPress={onScan} full />
        ) : (
          <Button label="Check in at branch" icon="location-outline" onPress={onCheckIn} full />
        )}
        <View style={{ flexDirection: 'row', gap: t.space.sm }}>
          <Button label="Navigate" icon="navigate" variant="neutral" onPress={onNavigate} style={{ flex: 1 }} />
          <Button label="Details" icon="chevron-forward" variant="neutral" onPress={onOpen} style={{ flex: 1 }} />
        </View>
      </View>
    </Card>
  );
};

const Meta: React.FC<{ icon: string; label: string }> = ({ icon, label }) => {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs }}>
      <Icon name={icon} size={14} color={t.colors.textFaint} />
      <AppText variant="small" tone="muted">
        {label}
      </AppText>
    </View>
  );
};

const SummaryRow: React.FC<{
  icon: string;
  label: string;
  value: string;
  tone?: 'warning' | 'info';
  onPress?: () => void;
}> = ({ icon, label, value, tone, onPress }) => {
  const t = useTheme();
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
      <Icon name={icon} size={18} color={tone ? t.colors[tone] : t.colors.textFaint} />
      <AppText variant="body" style={{ flex: 1 }}>
        {label}
      </AppText>
      <AppText variant="bodyStrong" tone={tone === 'warning' ? 'warning' : undefined}>
        {value}
      </AppText>
      {onPress ? <Icon name="chevron-forward" size={16} color={t.colors.textFaint} /> : null}
    </View>
  );

  return onPress ? <Tappable onPress={onPress}>{body}</Tappable> : body;
};
