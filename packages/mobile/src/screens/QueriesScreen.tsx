import React from 'react';
import { View } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Badge, Button, Card, EmptyState, FadeIn, Segmented } from '../components/ui/primitives';

interface QueriesScreenProps {
  assignments: AssayerAssignment[];
  onOpenQueryChat: (assignment: AssayerAssignment) => void;
}

/**
 * Clarifications raised by the data entry desk about audits you submitted.
 *
 * Sorted so anything still waiting on *you* is at the top — the old screen
 * listed them in whatever order the API returned, so an open question could sit
 * below a dozen resolved ones.
 */
export const QueriesScreen: React.FC<QueriesScreenProps> = ({ assignments, onOpenQueryChat }) => {
  const t = useTheme();
  const [tab, setTab] = React.useState<'OPEN' | 'ALL'>('OPEN');

  const withQueries = assignments.filter((a) => a.queries && a.queries.length > 0);

  const stateOf = (a: AssayerAssignment) => {
    const qs = a.queries || [];
    if (qs.some((q) => q.status === 'OPEN')) return 'NEEDS_YOU' as const;
    if (qs.some((q) => q.status === 'RESPONDED')) return 'WAITING_DESK' as const;
    return 'RESOLVED' as const;
  };

  const rank = { NEEDS_YOU: 0, WAITING_DESK: 1, RESOLVED: 2 };
  const sorted = withQueries.slice().sort((a, b) => rank[stateOf(a)] - rank[stateOf(b)]);
  const openOnly = sorted.filter((a) => stateOf(a) !== 'RESOLVED');
  const shown = tab === 'OPEN' ? openOnly : sorted;

  const META = {
    NEEDS_YOU: { label: 'Needs your reply', tone: 'danger' as const, cta: 'Reply now', icon: 'chatbubble-ellipses' as const },
    WAITING_DESK: { label: 'With the desk', tone: 'warning' as const, cta: 'Open conversation', icon: 'chatbubble-ellipses-outline' as const },
    RESOLVED: { label: 'Resolved', tone: 'success' as const, cta: 'View history', icon: 'eye-outline' as const },
  };

  return (
    <View style={{ gap: t.space.lg }}>
      <Segmented
        value={tab}
        onChange={(k) => setTab(k as 'OPEN' | 'ALL')}
        options={[
          { key: 'OPEN', label: 'Needs attention', count: openOnly.length },
          { key: 'ALL', label: 'All', count: sorted.length },
        ]}
      />

      {shown.length === 0 ? (
        <EmptyState
          icon="checkmark-circle-outline"
          title={tab === 'OPEN' ? 'Nothing waiting on you' : 'No clarifications yet'}
          body="When the data entry desk cannot read something on a sheet you submitted, they ask here — with the exact area of the page marked."
        />
      ) : (
        shown.map((a, i) => {
          const meta = META[stateOf(a)];
          const count = (a.queries || []).length;
          return (
            <FadeIn key={a.id} delay={Math.min(i, 6) * 45}>
              <Card level={1} style={{ gap: t.space.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: t.space.md }}>
                  <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                    <AppText variant="h3" numberOfLines={1}>{a.branchName}</AppText>
                    <AppText variant="caption" tone="faint" numberOfLines={1}>
                      {a.bankName ?? '—'}{a.branchCode ? ` · ${a.branchCode}` : ''}
                    </AppText>
                  </View>
                  <Badge label={`${count}`} tone={meta.tone} icon="chatbubble-outline" />
                </View>

                <View style={{ flexDirection: 'row' }}>
                  <Badge label={meta.label} tone={meta.tone} dot />
                </View>

                <Button
                  label={meta.cta}
                  icon={meta.icon}
                  variant={stateOf(a) === 'RESOLVED' ? 'neutral' : 'primary'}
                  onPress={() => onOpenQueryChat(a)}
                  full
                />
              </Card>
            </FadeIn>
          );
        })
      )}
    </View>
  );
};
