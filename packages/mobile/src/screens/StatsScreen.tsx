import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Card, ProgressBar, Section, StatStrip, StatTile } from '../components/ui/primitives';

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

  const bars: { label: string; value: number; tone: 'primary' | 'success'; caption: string }[] = [
    {
      label: 'Assignments completed',
      value: completionRate,
      tone: 'success',
      caption: `${completedAssignments} of ${totalAssignments}`,
    },
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

  return (
    <View style={{ gap: t.space.xl }}>
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
