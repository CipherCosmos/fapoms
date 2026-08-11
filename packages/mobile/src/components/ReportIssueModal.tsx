import React, { useState } from 'react';
import { Modal, View, TextInput } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Icon, IconButton, Tappable } from './ui/primitives';
import {
  ASSIGNMENT_ISSUE_CATEGORIES,
  assignmentIssueCategoryLabel,
  type AssignmentIssueCategory,
} from '@fapoms/shared';
import type { AssayerAssignment } from '../types/mobile-app';

const CATEGORY_ICON: Record<AssignmentIssueCategory, string> = {
  CANNOT_ATTEND: 'calendar-clear-outline',
  BRANCH_INACCESSIBLE: 'lock-closed-outline',
  NEEDS_CLARIFICATION: 'help-circle-outline',
  SAFETY_CONCERN: 'warning-outline',
  OTHER: 'ellipsis-horizontal-circle-outline',
};

export interface ReportIssueModalProps {
  visible: boolean;
  assignment: AssayerAssignment | null;
  onClose: () => void;
  /** Resolves to true on success so the caller can close and confirm. */
  onSubmit: (category: AssignmentIssueCategory, note: string) => Promise<boolean>;
}

/**
 * The assayer's channel to raise a problem to the operations desk.
 *
 * Deliberately not a cancel button: the field app cannot release or reassign work — that stays
 * with the desk. This records the problem and notifies ops, who then take the back-office
 * action. So the wording is "report", never "cancel", and the categories are the situations a
 * field worker actually hits.
 */
export const ReportIssueModal: React.FC<ReportIssueModalProps> = ({ visible, assignment, onClose, onSubmit }) => {
  const t = useTheme();
  const [category, setCategory] = useState<AssignmentIssueCategory | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setCategory(null);
    setNote('');
    setBusy(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    if (!category || busy) return;
    setBusy(true);
    const ok = await onSubmit(category, note);
    setBusy(false);
    if (ok) close();
  };

  if (!assignment) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: t.colors.scrim, justifyContent: 'flex-end' }}>
        <Tappable onPress={close} style={{ flex: 1 }} accessibilityLabel="Dismiss">
          <View style={{ flex: 1 }} />
        </Tappable>

        <View
          style={{
            backgroundColor: t.colors.bg,
            borderTopLeftRadius: t.radius.xl,
            borderTopRightRadius: t.radius.xl,
            paddingHorizontal: t.space.xl,
            paddingTop: t.space.md,
            paddingBottom: t.space['2xl'],
            gap: t.space.lg,
          }}
        >
          <View style={{ alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: t.colors.border }} />

          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: t.space.md }}>
            <View style={{ flex: 1, gap: t.space.xs }}>
              <AppText variant="h2">Report an issue</AppText>
              <AppText variant="small" tone="muted">
                {assignment.branchName} · the operations desk will be notified and will follow up.
              </AppText>
            </View>
            <IconButton icon="close" onPress={close} accessibilityLabel="Close" size={38} />
          </View>

          <View style={{ gap: t.space.sm }}>
            <AppText variant="overline" tone="faint">WHAT'S THE PROBLEM?</AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
              {ASSIGNMENT_ISSUE_CATEGORIES.map((c) => {
                const active = category === c;
                return (
                  <Tappable key={c} onPress={() => setCategory(c)}>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingVertical: t.space.sm,
                        paddingHorizontal: t.space.md,
                        borderRadius: t.radius.pill,
                        backgroundColor: active ? t.colors.primarySoft : t.colors.surface,
                        borderWidth: 1,
                        borderColor: active ? t.colors.primary : t.colors.border,
                      }}
                    >
                      <Icon
                        name={CATEGORY_ICON[c]}
                        size={15}
                        color={active ? t.colors.primary : t.colors.textFaint}
                      />
                      <AppText variant="caption" tone={active ? 'primary' : 'muted'}>
                        {assignmentIssueCategoryLabel(c)}
                      </AppText>
                    </View>
                  </Tappable>
                );
              })}
            </View>
          </View>

          <View style={{ gap: t.space.sm }}>
            <AppText variant="overline" tone="faint">DETAILS (OPTIONAL)</AppText>
            <View
              style={{
                backgroundColor: t.colors.surface,
                borderRadius: t.radius.md,
                borderWidth: 1,
                borderColor: t.colors.border,
                paddingHorizontal: t.space.md,
              }}
            >
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="Add anything the desk needs to know…"
                placeholderTextColor={t.colors.textFaint}
                multiline
                numberOfLines={3}
                maxLength={1000}
                style={{
                  color: t.colors.text,
                  paddingVertical: t.space.md,
                  minHeight: 72,
                  textAlignVertical: 'top',
                  ...(t.type.body as object),
                }}
              />
            </View>
          </View>

          <Button
            label={busy ? 'Sending…' : 'Send to desk'}
            icon="send"
            onPress={submit}
            loading={busy}
            disabled={!category}
            size="lg"
            full
          />
        </View>
      </View>
    </Modal>
  );
};
