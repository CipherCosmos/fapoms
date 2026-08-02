import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Card, ProgressBar, Section, StatStrip, StatTile } from '../components/ui/primitives';

interface StatsScreenProps {
  qualityScore: number;
  totalCompleted: number;
  queryResolutionRate: number;
  avgAuditHours: string;
  totalAssignments?: number;
  averageRating?: number;
  onTimePercentage?: number;
}

/**
 * How this assayer is performing.
 *
 * Percentages now render as bars as well as numbers, so a score reads as a
 * position on a scale rather than an isolated figure in a 4-box grid.
 */
export const StatsScreen: React.FC<StatsScreenProps> = ({
  qualityScore,
  totalCompleted,
  queryResolutionRate,
  avgAuditHours,
  totalAssignments,
  averageRating,
  onTimePercentage,
}) => {
  const t = useTheme();

  const bars: { label: string; value: number; tone: 'primary' | 'success' | 'warning' }[] = [
    { label: 'Quality score', value: qualityScore, tone: 'primary' },
    { label: 'Queries resolved', value: queryResolutionRate, tone: 'warning' },
    ...(onTimePercentage != null
      ? [{ label: 'On-time completion', value: onTimePercentage, tone: 'success' as const }]
      : []),
  ];

  return (
    <View style={{ gap: t.space.xl }}>
      <StatStrip>
        <StatTile label="Completed" value={totalCompleted} icon="checkmark-done" tone="success" />
        <StatTile label="Assigned" value={totalAssignments ?? totalCompleted} icon="clipboard-outline" />
        <StatTile label="Avg duration" value={avgAuditHours} icon="time-outline" tone="info" />
        {averageRating != null && averageRating > 0 && (
          <StatTile label="Rating" value={averageRating.toFixed(1)} icon="star" tone="accent" hint="out of 5" />
        )}
      </StatStrip>

      <Section title="Performance">
        <Card level={1} style={{ gap: t.space.lg }}>
          {bars.map((b) => (
            <View key={b.label} style={{ gap: t.space.sm }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <AppText variant="small" tone="muted">{b.label}</AppText>
                <AppText variant="bodyStrong" tone={b.tone}>{Math.round(b.value)}%</AppText>
              </View>
              <ProgressBar value={b.value / 100} tone={b.tone} />
            </View>
          ))}
        </Card>
      </Section>
    </View>
  );
};
