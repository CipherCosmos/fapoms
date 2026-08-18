import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Card, Divider, EmptyState, ProgressBar, Section, StatStrip, StatTile } from '../components/ui/primitives';

export interface StatsScreenProps {
  totalAssignments: number;
  completedAssignments: number;
  averageRating?: number;
  openQueries: number;
  resolvedQueries: number;
}

/**
 * How this assayer is performing.
 *
 * Every figure here is one the backend genuinely returns. The previous version was written
 * against `qualityScore`, `queryResolutionRate`, `avgAuditHours` and `onTimePercentage` —
 * none of which exist on the assayer record or anywhere in the API. That is why the screen
 * was never wired into the app: there was nothing to feed it. Completion and query rates are
 * derived here from counts the server does return, rather than invented.
 */
export const StatsScreen: React.FC<StatsScreenProps> = ({
  totalAssignments,
  completedAssignments,
  averageRating,
  openQueries,
  resolvedQueries,
}) => {
  const t = useTheme();

  const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
  const completionRate = pct(completedAssignments, totalAssignments);
  const totalQueries = openQueries + resolvedQueries;
  const queryRate = pct(resolvedQueries, totalQueries);

  // Completion rate gets its own hero treatment below rather than sitting in this list — it is
  // the one figure a field assayer actually opens this screen to check, and Apple's own
  // Health/Wallet apps lead with one big number rather than giving every stat equal weight in
  // a flat list of bars. Anything else performance-shaped (currently just query resolution)
  // stays in the secondary "Performance" list beneath it.
  const bars: { label: string; value: number; tone: 'primary' | 'success'; caption: string }[] = [
    ...(totalQueries > 0
      ? [
          {
            label: 'Queries resolved',
            value: queryRate,
            tone: 'primary' as const,
            caption: `${resolvedQueries} of ${totalQueries}`,
          },
        ]
      : []),
  ];

  // A brand-new assayer with no assignments yet would otherwise see a completion bar reading
  // "0% — 0 of 0", which reads as a broken chart rather than as "nothing has happened yet".
  if (totalAssignments === 0) {
    return (
      <EmptyState
        icon="stats-chart-outline"
        title="No performance data yet"
        body="Once you're offered and complete your first audit, your completion rate and query stats will show up here."
      />
    );
  }

  return (
    <View style={{ gap: t.space.xl }}>
      {/* ── Completion hero: the number this screen exists to answer ──────────── */}
      <Card level={2} style={{ gap: t.space.md }}>
        <AppText variant="overline" tone="faint">ASSIGNMENTS COMPLETED</AppText>
        <AppText variant="display" tone="success">{completionRate}%</AppText>
        <AppText variant="caption" tone="muted">
          {completedAssignments} of {totalAssignments} offered assignments finished.
        </AppText>

        <Divider spacing={2} />

        {/* A thin, subtle-track bar under the hero number rather than a second, competing
            headline figure — the percentage above already said the number; this just shows
            it as a shape. Track colour is the same low-contrast surfacePress every other
            progress indicator in the app uses, so it reads as quiet infrastructure, not
            another thing demanding attention next to the big figure above it. */}
        <ProgressBar value={completionRate / 100} tone="success" />
      </Card>

      <StatStrip>
        <StatTile label="Completed" value={completedAssignments} icon="checkmark-done" tone="success" />
        <StatTile label="Assigned" value={totalAssignments} icon="clipboard-outline" />
        {openQueries > 0 && (
          <StatTile label="Open queries" value={openQueries} icon="help-circle-outline" tone="warning" />
        )}
        {averageRating != null && averageRating > 0 && (
          <StatTile label="Rating" value={averageRating.toFixed(1)} icon="star" tone="accent" hint="out of 5" />
        )}
      </StatStrip>

      {bars.length > 0 && (
        <Section title="Performance">
          <Card level={1} style={{ gap: t.space.lg }}>
            {bars.map((b) => (
              <View key={b.label} style={{ gap: t.space.sm }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <AppText variant="small" tone="muted">
                    {b.label}
                  </AppText>
                  <AppText variant="bodyStrong" tone={b.tone}>
                    {b.value}%
                  </AppText>
                </View>
                <ProgressBar value={b.value / 100} tone={b.tone} />
                <AppText variant="caption" tone="faint">
                  {b.caption}
                </AppText>
              </View>
            ))}
          </Card>
        </Section>
      )}
    </View>
  );
};
