import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Icon } from './ui/primitives';
import { useT } from '../i18n';
import { refusalNotice } from '../i18n/refusal-notice';
import type { QueuedAction } from '../services/action-queue';

/**
 * Actions the assayer was told were "saved on your phone, will send by itself" and that the
 * server then refused — each with the server's reason (translated by code where known), until
 * the assayer taps OK. Renders nothing when there are none.
 */
export const RefusedActionsBanner: React.FC<{
  refused: QueuedAction[];
  onDismiss: (id: string) => void;
}> = ({ refused, onDismiss }) => {
  const t = useTheme();
  const tr = useT();
  if (refused.length === 0) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ gap: t.space.sm, padding: t.space.md, borderRadius: t.radius.md, backgroundColor: t.colors.dangerSoft, marginBottom: t.space.md }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        <Icon name="alert-circle-outline" size={18} color={t.colors.danger} />
        <AppText variant="bodyStrong" tone="danger">{tr('queue.refusedTitle')}</AppText>
      </View>
      {refused.map((entry) => {
        const notice = refusalNotice(entry);
        return (
          <View key={entry.id} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
            <AppText variant="small" style={{ flex: 1 }}>{notice.line}</AppText>
            <Button
              label={tr('queue.dismiss')}
              size="sm"
              variant="neutral"
              onPress={() => onDismiss(entry.id)}
            />
          </View>
        );
      })}
    </View>
  );
};
