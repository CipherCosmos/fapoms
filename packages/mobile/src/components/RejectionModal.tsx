import React, { useEffect, useState } from 'react';
import { Modal, View, TextInput, TextStyle, KeyboardAvoidingView, Platform } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Card, Tappable } from './ui/primitives';
import { useT, type TranslationKey } from '../i18n';
import {
  REJECTION_REASON_CATEGORIES,
  composeRejectionReason,
  canSubmitRejectionReason,
  type RejectionReasonCategory,
} from './rejection-reasons';

/** Catalogue key per preset chip. See `rejection-reasons.ts` for why these differ from
 *  `ReportIssueModal`'s categories: this is a decline before the work starts, not a problem on
 *  a job already accepted. */
const CATEGORY_LABEL_KEYS: Record<RejectionReasonCategory, TranslationKey> = {
  TOO_FAR: 'decline.categories.tooFar',
  FEE_TOO_LOW: 'decline.categories.feeTooLow',
  SCHEDULE_CONFLICT: 'decline.categories.scheduleConflict',
  UNCOMFORTABLE_BRANCH: 'decline.categories.uncomfortableBranch',
  OTHER: 'decline.categories.other',
};

interface RejectionModalProps {
  visible: boolean;
  rejectReason: string;
  /** True while the decline is being persisted - drives the button spinner + prevents double-submit. */
  submitting?: boolean;
  onChangeReason: (text: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export const RejectionModal: React.FC<RejectionModalProps> = ({
  visible,
  submitting,
  onChangeReason,
  onConfirm,
  onCancel,
}) => {
  const t = useTheme();
  const tr = useT();

  /**
   * Local, not driven by the `rejectReason` prop.
   *
   * `App.tsx` keeps `rejectReason` only so it can validate and send whatever this modal last
   * reported through `onChangeReason` - it never needs to feed a value back in. This component
   * stays mounted across opens (see `App.tsx`: it renders `<RejectionModal visible={...} />`
   * unconditionally, it does not mount/unmount per offer), so state is reset explicitly below
   * whenever the modal opens, rather than a stale category or detail from the PREVIOUS decline
   * leaking into this one - the same bug `useOverlay.ts` documents for the reason string itself.
   */
  const [category, setCategory] = useState<RejectionReasonCategory | null>(null);
  const [detail, setDetail] = useState('');

  useEffect(() => {
    if (visible) {
      setCategory(null);
      setDetail('');
      onChangeReason('');
    }
    // Only `visible`'s transition matters here - including `onChangeReason` would refire this
    // reset on every keystroke, since the parent passes a fresh closure on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const report = (nextCategory: RejectionReasonCategory | null, nextDetail: string) => {
    onChangeReason(composeRejectionReason(nextCategory, nextDetail));
  };

  const selectCategory = (c: RejectionReasonCategory) => {
    const next = category === c ? null : c;
    setCategory(next);
    report(next, detail);
  };

  const changeDetail = (text: string) => {
    setDetail(text);
    report(category, text);
  };

  if (!visible) return null;

  const canSubmit = canSubmitRejectionReason(category, detail);

  const inputStyle: TextStyle = {
    backgroundColor: t.colors.bg,
    borderRadius: t.radius.md,
    borderWidth: 1.5,
    borderColor: t.colors.border,
    paddingHorizontal: t.space.lg,
    paddingVertical: t.space.md,
    minHeight: 72,
    color: t.colors.text,
    fontSize: 15,
    fontWeight: '500',
    textAlignVertical: 'top',
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={{
          flex: 1,
          backgroundColor: t.colors.scrim,
          justifyContent: 'center',
          padding: t.space.xl,
        }}>
        <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl }}>
          <AppText variant="h2">{tr('decline.title')}</AppText>

          <View style={{ gap: t.space.sm }}>
            <AppText variant="overline" tone="faint">{tr('decline.reasonLabel')}</AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
              {REJECTION_REASON_CATEGORIES.map((c) => {
                const active = category === c;
                return (
                  <Tappable key={c} onPress={() => selectCategory(c)} accessibilityRole="button" accessibilityLabel={tr(CATEGORY_LABEL_KEYS[c])}>
                    <View
                      style={{
                        paddingVertical: t.space.sm,
                        paddingHorizontal: t.space.md,
                        borderRadius: t.radius.pill,
                        backgroundColor: active ? t.colors.primarySoft : t.colors.surface,
                        borderWidth: 1,
                        borderColor: active ? t.colors.primary : t.colors.border,
                      }}
                    >
                      <AppText variant="caption" tone={active ? 'primary' : 'muted'}>
                        {tr(CATEGORY_LABEL_KEYS[c])}
                      </AppText>
                    </View>
                  </Tappable>
                );
              })}
            </View>
          </View>

          <View style={{ gap: t.space.xs }}>
            <AppText variant="overline" tone="faint">{tr('decline.detailsLabel')}</AppText>
            <TextInput
              style={inputStyle}
              placeholder={tr('decline.reasonPlaceholder')}
              placeholderTextColor={t.colors.textFaint}
              multiline
              maxLength={1000}
              value={detail}
              onChangeText={changeDetail}
            />
          </View>

          <View style={{ flexDirection: 'row', gap: t.space.md, marginTop: t.space.sm }}>
            <Button label={tr('decline.confirm')} variant="danger" icon="close" loading={submitting} disabled={submitting || !canSubmit} onPress={onConfirm} style={{ flex: 1 }} />
            <Button label={tr('common.cancel')} variant="neutral" disabled={submitting} onPress={onCancel} style={{ flex: 1 }} />
          </View>
        </Card>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};
