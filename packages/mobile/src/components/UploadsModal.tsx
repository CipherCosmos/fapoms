import React from 'react';
import { Modal, ScrollView, View, Platform } from 'react-native';
import type { OutboxUpload, OutboxStatus } from '../services/upload-outbox';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Badge, Button, Card, EmptyState, Icon, IconButton, ProgressBar, Tappable } from './ui/primitives';

interface UploadsModalProps {
  visible: boolean;
  uploads: OutboxUpload[];
  onClose: () => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}

/** How each status looks and reads to a non-technical field worker. */
const STATUS: Record<OutboxStatus, { label: string; tone: 'success' | 'info' | 'warning' | 'danger'; icon: string }> = {
  SENT: { label: 'Sent', tone: 'success', icon: 'checkmark-circle' },
  SENDING: { label: 'Sending', tone: 'info', icon: 'cloud-upload-outline' },
  PENDING: { label: 'Waiting to send', tone: 'info', icon: 'time-outline' },
  FAILED: { label: 'Not sent', tone: 'danger', icon: 'alert-circle-outline' },
};

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
};

const UploadRow: React.FC<{
  upload: OutboxUpload;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}> = ({ upload, onRetry, onDismiss }) => {
  const t = useTheme();
  const s = STATUS[upload.status];
  const sending = upload.status === 'SENDING';
  const failed = upload.status === 'FAILED';
  const done = upload.status === 'SENT';

  return (
    <Card level={1} style={{ gap: t.space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: t.radius.md,
            backgroundColor:
              s.tone === 'success' ? t.colors.successSoft
              : s.tone === 'danger' ? t.colors.dangerSoft
              : t.colors.primarySoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon
            name={s.icon}
            size={19}
            color={s.tone === 'success' ? t.colors.success : s.tone === 'danger' ? t.colors.danger : t.colors.primary}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <AppText variant="bodyStrong" numberOfLines={1}>{upload.branchName || 'Audit packet'}</AppText>
          <AppText variant="caption" tone="faint" numberOfLines={1}>{upload.fileName}</AppText>
        </View>
        <Badge label={s.label} tone={s.tone} dot />
      </View>

      {sending && (
        <View style={{ gap: 6 }}>
          <ProgressBar value={upload.progress / 100} tone="primary" />
          <AppText variant="caption" tone="muted">
            {upload.progress > 0 ? `${upload.progress}% sent` : 'Starting…'} — you can leave this screen, it keeps going.
          </AppText>
        </View>
      )}

      {failed && (
        <View style={{ gap: t.space.sm }}>
          <AppText variant="small" tone="muted">
            {upload.error || 'This packet did not reach the desk.'} Tap Retry to send it again — the parts already sent are kept.
          </AppText>
          <View style={{ flexDirection: 'row', gap: t.space.sm }}>
            <Button label="Retry" icon="refresh" onPress={() => onRetry(upload.id)} style={{ flex: 1 }} />
            <Button label="Remove" icon="trash-outline" variant="ghost" onPress={() => onDismiss(upload.id)} />
          </View>
        </View>
      )}

      {done && (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <AppText variant="caption" tone="faint">Delivered {timeOf(upload.updatedAt)}</AppText>
          <Tappable
            onPress={() => onDismiss(upload.id)}
            accessibilityRole="button"
            accessibilityLabel={`Clear ${upload.branchName || 'packet'} from the list`}
            hitSlop={10}
          >
            <AppText variant="caption" tone="primary">Clear</AppText>
          </Tappable>
        </View>
      )}
    </Card>
  );
};

/**
 * The uploads list.
 *
 * Every audit packet the assayer has captured, and where it is on the way to the desk: Sending,
 * Waiting, Not sent (with a Retry), or Sent. This is the record that used to not exist — an
 * in-flight packet lived only in the screen that started it, so leaving that screen lost it with
 * nothing to show it had failed. Now a packet stays here until it has actually arrived.
 */
export const UploadsModal: React.FC<UploadsModalProps> = ({ visible, uploads, onClose, onRetry, onDismiss }) => {
  const t = useTheme();

  // Newest first — the packet the assayer just captured is the one they came here to check on.
  const ordered = [...uploads].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const failed = ordered.filter((u) => u.status === 'FAILED').length;

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
        <View
          style={{
            paddingTop: Platform.OS === 'ios' ? 50 : 20,
            paddingHorizontal: t.space.lg,
            paddingBottom: t.space.md,
            backgroundColor: t.colors.surface,
            flexDirection: 'row',
            alignItems: 'center',
            gap: t.space.md,
            borderBottomWidth: 1,
            borderColor: t.colors.border,
          }}
        >
          <IconButton icon="arrow-back" onPress={onClose} accessibilityLabel="Back" />
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="h3" numberOfLines={1}>Uploads</AppText>
            <AppText variant="caption" tone="muted" numberOfLines={1}>
              {failed > 0
                ? `${failed} packet${failed === 1 ? '' : 's'} need${failed === 1 ? 's' : ''} retrying`
                : 'Your audit packets on their way to the desk'}
            </AppText>
          </View>
        </View>

        {ordered.length === 0 ? (
          <EmptyState
            icon="cloud-done-outline"
            title="Nothing to send"
            body="Packets you scan or attach show here until they reach the desk. If one fails, you can retry it from here."
          />
        ) : (
          <ScrollView contentContainerStyle={{ padding: t.space.lg, gap: t.space.md }}>
            {ordered.map((u) => (
              <UploadRow key={u.id} upload={u} onRetry={onRetry} onDismiss={onDismiss} />
            ))}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
};
