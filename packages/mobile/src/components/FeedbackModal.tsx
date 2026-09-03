import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, View, TextInput, ScrollView, ActivityIndicator, Platform } from 'react-native';
import Constants from 'expo-constants';
import * as DocumentPicker from 'expo-document-picker';
import { MAX_FEEDBACK_ATTACHMENTS } from '@fapoms/shared';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Icon, IconButton, Card, Tappable, Badge, EmptyState } from './ui/primitives';
import { MobileApiService } from '../services/api.service';

import { FEEDBACK_STATUS_LABELS, feedbackCategoryLabel } from '@fapoms/shared';
import { useT, t as translate } from '../i18n';
/**
 * The assayer's side of the two-way feedback & collaboration channel.
 *
 * One modal, three views: the list of things they've raised, a compose form for a
 * new item, and the conversation on one item. Mirrors the clarification thread the
 * app already has (QueryThread), with the product team as the counterparty instead
 * of the desk. Category is optional — the server's classifier fills it in — so the
 * fastest path is just "type what's wrong and send".
 */

interface Props {
  visible: boolean;
  onClose: () => void;
}

type ViewMode = 'list' | 'compose' | 'thread';

/**
 * Icons are a mobile concern; the WORDING comes from shared.
 *
 * These used to be written here, and the web triage desk had its own set — "Idea" and "Seen" on
 * the phone against "Enhancement" and "Acknowledged" on the desk, for the same thread. An assayer
 * would say their issue was marked "Seen" while the product team looked at "Acknowledged", and
 * neither could tell they meant the same state.
 */
// A function, not a constant: the "Auto" chip is translated, and a module-level array would
// have frozen it in whatever language was active when this file was first imported — which is
// before the saved language preference has been applied at all.
const categories = (): { key: string; label: string; icon: string }[] => [
  { key: '', label: translate('feedback.kindAuto'), icon: 'sparkles-outline' },
  { key: 'BUG', label: feedbackCategoryLabel('BUG'), icon: 'bug-outline' },
  { key: 'ENHANCEMENT', label: feedbackCategoryLabel('ENHANCEMENT'), icon: 'bulb-outline' },
  { key: 'PROCESS', label: feedbackCategoryLabel('PROCESS'), icon: 'git-branch-outline' },
  { key: 'QUESTION', label: feedbackCategoryLabel('QUESTION'), icon: 'help-circle-outline' },
];

const STATUS_LABEL: Record<string, string> = FEEDBACK_STATUS_LABELS;

const fmtWhen = (d: string | null) =>
  d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

export const FeedbackModal: React.FC<Props> = ({ visible, onClose }) => {
  const t = useTheme();
  const tr = useT();
  const [view, setView] = useState<ViewMode>('list');
  const [threads, setThreads] = useState<any[] | null>(null);

  // compose
  const [category, setCategory] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Chosen files and how each upload is going. Uploads start on pick, not on send. */
  const [files, setFiles] = useState<any[]>([]);

  // thread
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<any | null>(null);
  const [messages, setMessages] = useState<any[] | null>(null);
  const [draft, setDraft] = useState('');
  const [replying, setReplying] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  /**
   * Pick files and start sending them straight away.
   *
   * At most five, matching the server's ceiling, and each one goes up on its own so a failure
   * is attributable and the rest still land. The assayer carries on typing while they upload.
   */
  const pickFiles = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'application/pdf'],
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (result.canceled || !result.assets?.length) return;

      const room = MAX_FEEDBACK_ATTACHMENTS - files.length;
      if (room <= 0) { setErr(`A report can carry ${MAX_FEEDBACK_ATTACHMENTS} files.`); return; }

      for (const asset of result.assets.slice(0, room)) {
        const entry = { asset, uploading: true } as any;
        setFiles((prev) => [...prev, entry]);

        MobileApiService.uploadFeedbackAttachments([asset])
          .then(([uploaded]) => setFiles((prev) => prev.map((f) => (
            f.asset === asset
              ? { ...f, uploading: false, uploaded, error: uploaded ? undefined : 'Could not be attached.' }
              : f
          ))))
          .catch(() => setFiles((prev) => prev.map((f) => (
            f.asset === asset ? { ...f, uploading: false, error: 'Could not be attached.' } : f
          ))));
      }
    } catch {
      setErr('Could not open the file picker.');
    }
  }, [files.length]);

  const loadList = useCallback(() => {
    setThreads(null);
    MobileApiService.getMyFeedback().then(setThreads).catch(() => setThreads([]));
  }, []);

  useEffect(() => {
    if (!visible) return;
    setView('list');
    loadList();
  }, [visible, loadList]);

  const loadThread = useCallback((id: string) => {
    setMessages(null);
    setActiveId(id);
    MobileApiService.getFeedbackThread(id).then(setActiveThread).catch(() => setActiveThread(null));
    MobileApiService.getFeedbackMessages(id).then(setMessages).catch(() => setMessages([]));
  }, []);

  const openThread = (id: string) => { loadThread(id); setView('thread'); };

  const submitNew = async () => {
    if (!body.trim() || sending) return;
    if (files.some((f) => f.uploading)) { setErr('One moment — an attachment is still sending.'); return; }
    setSending(true);
    setErr(null);
    /**
     * Whatever finished uploading while the report was being written.
     *
     * Uploads start when a file is picked, not here — on a branch connection, doing them inside
     * Send meant the button sat spinning for as long as the photo took, with nothing to show for
     * it. Anything that failed is named rather than silently dropped, and never blocks the
     * report: an assayer who has typed the problem out must not lose it to a photo that will
     * not go up.
     */
    const attachments = files.map((f) => f.uploaded).filter(Boolean);
    const failed = files.filter((f) => f.error).length;
    if (failed) {
      setErr(`${failed} file(s) could not be attached — sending the report without them.`);
    }

    const res = await MobileApiService.createFeedback({
      title: title.trim() || undefined,
      body: body.trim(),
      category: category || undefined,
      attachments: attachments.length ? attachments : undefined,
      appContext: { platform: 'mobile', appVersion: Constants.expoConfig?.version ?? '1.0.0' },
    });
    setSending(false);
    if (res.success) {
      setTitle(''); setBody(''); setCategory(''); setFiles([]);
      loadList();
      if (res.id) openThread(res.id); else setView('list');
    } else {
      setErr(res.error ?? 'Could not send.');
    }
  };

  const sendReply = async () => {
    if (!draft.trim() || !activeId || replying) return;
    setReplying(true);
    const res = await MobileApiService.postFeedbackMessage(activeId, draft.trim());
    setReplying(false);
    if (res.success) { setDraft(''); loadThread(activeId); }
    else setErr(res.error ?? 'Could not send.');
  };

  const close = () => { setView('list'); setErr(null); onClose(); };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: t.colors.scrim, justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: t.colors.bg,
          borderTopLeftRadius: t.radius.xl, borderTopRightRadius: t.radius.xl,
          height: '88%', paddingTop: t.space.md,
        }}>
          <View style={{ alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: t.colors.border, marginBottom: t.space.sm }} />

          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, paddingHorizontal: t.space.xl, paddingBottom: t.space.md }}>
            {view !== 'list' ? (
              <IconButton icon="chevron-back" onPress={() => { setView('list'); setErr(null); loadList(); }} accessibilityLabel={tr('common.back')} size={36} />
            ) : (
              <Icon name="chatbox-ellipses-outline" size={20} color={t.colors.primary} />
            )}
            <AppText variant="h2" style={{ flex: 1 }}>
              {view === 'compose'
                ? tr('feedback.newTitle')
                : view === 'thread' ? (activeThread?.title ?? tr('feedback.title')) : tr('feedback.title')}
            </AppText>
            <IconButton icon="close" onPress={close} accessibilityLabel={tr('common.close')} size={36} />
          </View>

          {view === 'list' && (
            <>
              <View style={{ paddingHorizontal: t.space.xl, paddingBottom: t.space.sm }}>
                <Button label={tr('feedback.sendNew')} icon="add" onPress={() => { setView('compose'); setErr(null); }} full />
              </View>
              <ScrollView contentContainerStyle={{ padding: t.space.xl, paddingTop: t.space.sm, gap: t.space.md }}>
                {threads === null && <ActivityIndicator color={t.colors.primary} style={{ marginTop: t.space.xl }} />}
                {threads?.length === 0 && (
                  <EmptyState icon="chatbox-outline" title={tr('feedback.emptyTitle')} body={tr('feedback.emptyBody')} />
                )}
                {threads?.map((th) => (
                  <Tappable key={th.id} onPress={() => openThread(th.id)}>
                    <Card level={1} style={{ gap: t.space.sm }}>
                      <AppText variant="bodyStrong">{th.title}</AppText>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, flexWrap: 'wrap' }}>
                        <Badge label={STATUS_LABEL[th.status] ?? th.status} tone={th.status === 'RESOLVED' ? 'success' : th.status === 'OPEN' ? 'warning' : 'primary'} />
                        <AppText variant="caption" tone="faint">{feedbackCategoryLabel(th.category)} · {fmtWhen(th.lastMessageAt)}</AppText>
                      </View>
                    </Card>
                  </Tappable>
                ))}
              </ScrollView>
            </>
          )}

          {view === 'compose' && (
            <ScrollView contentContainerStyle={{ padding: t.space.xl, paddingTop: 0, gap: t.space.lg }} keyboardShouldPersistTaps="handled">
              <View style={{ gap: t.space.sm }}>
                <AppText variant="overline" tone="faint">{tr('feedback.kindLabel')}</AppText>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
                  {categories().map((c) => {
                    const active = category === c.key;
                    return (
                      <Tappable key={c.key || 'AUTO'} onPress={() => setCategory(c.key)}>
                        <View style={{
                          flexDirection: 'row', alignItems: 'center', gap: 6,
                          paddingVertical: t.space.sm, paddingHorizontal: t.space.md, borderRadius: t.radius.pill,
                          backgroundColor: active ? t.colors.primarySoft : t.colors.surface,
                          borderWidth: 1, borderColor: active ? t.colors.primary : t.colors.border,
                        }}>
                          <Icon name={c.icon} size={15} color={active ? t.colors.primary : t.colors.textFaint} />
                          <AppText variant="caption" tone={active ? 'primary' : 'muted'}>{c.label}</AppText>
                        </View>
                      </Tappable>
                    );
                  })}
                </View>
              </View>

              <View style={{ gap: t.space.sm }}>
                <AppText variant="overline" tone="faint">{tr('feedback.titleLabel')}</AppText>
                <View style={{ backgroundColor: t.colors.surface, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.colors.border, paddingHorizontal: t.space.md }}>
                  <TextInput value={title} onChangeText={setTitle} placeholder={tr('feedback.titlePlaceholder')} placeholderTextColor={t.colors.textFaint} maxLength={200}
                    style={{ color: t.colors.text, paddingVertical: t.space.md, ...(t.type.body as object) }} />
                </View>
              </View>

              <View style={{ gap: t.space.sm }}>
                <AppText variant="overline" tone="faint">{tr('feedback.detailsLabel')}</AppText>
                <View style={{ backgroundColor: t.colors.surface, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.colors.border, paddingHorizontal: t.space.md }}>
                  <TextInput value={body} onChangeText={setBody} placeholder={tr('feedback.detailsPlaceholder')} placeholderTextColor={t.colors.textFaint}
                    multiline numberOfLines={5} maxLength={4000}
                    style={{ color: t.colors.text, paddingVertical: t.space.md, minHeight: 120, textAlignVertical: 'top', ...(t.type.body as object) }} />
                </View>
              </View>

              {/*
                * Attach a photo of the screen.
                * An assayer describing a problem on a branch connection is far better served by
                * one photo than by three paragraphs typed on a phone.
                */}
              <View style={{ gap: t.space.sm }}>
                <Tappable
                  onPress={pickFiles}
                  accessibilityLabel={tr('feedback.attach')}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
                    paddingVertical: t.space.sm, paddingHorizontal: t.space.md,
                    borderRadius: t.radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: t.colors.border,
                  }}
                >
                  <Icon name="attach" size={14} color={t.colors.textMuted} />
                  <AppText variant="caption" tone="muted">
                    {files.length ? tr('feedback.attachAnother') : tr('feedback.attach')}
                  </AppText>
                </Tappable>

                {files.map((f, i) => (
                  <View
                    key={`${f.asset?.name ?? f.asset?.uri}-${i}`}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: t.space.sm,
                      backgroundColor: t.colors.surface, borderRadius: t.radius.sm,
                      paddingVertical: 6, paddingHorizontal: t.space.md,
                    }}
                  >
                    <Icon
                      name={f.uploaded ? 'checkmark-circle' : 'attach'}
                      size={12}
                      color={f.error ? t.colors.danger : f.uploaded ? t.colors.success : t.colors.textMuted}
                    />
                    <AppText
                      variant="caption"
                      numberOfLines={1}
                      style={{ flex: 1 }}
                      tone={f.error ? 'danger' : undefined}
                    >
                      {(() => {
                        const name = f.asset?.name ?? tr('feedback.attachmentFallback');
                        if (f.uploading) return tr('feedback.attachmentSending', { file: name });
                        if (f.error) return tr('feedback.attachmentFailed', { file: name, reason: f.error });
                        return name;
                      })()}
                    </AppText>
                    <Tappable
                      onPress={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                      accessibilityLabel={tr('feedback.removeAttachment', {
                        file: f.asset?.name ?? tr('feedback.attachmentFallback'),
                      })}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Icon name="close" size={12} color={t.colors.textMuted} />
                    </Tappable>
                  </View>
                ))}
              </View>

              {err && <AppText variant="caption" tone="danger">{err}</AppText>}
              <Button label={sending ? tr('feedback.sending') : tr('feedback.send')} icon="send" onPress={submitNew} loading={sending} disabled={!body.trim()} size="lg" full />
            </ScrollView>
          )}

          {view === 'thread' && (
            <View style={{ flex: 1 }}>
              {activeThread && (
                <View style={{ paddingHorizontal: t.space.xl, paddingBottom: t.space.sm, flexDirection: 'row', gap: t.space.sm, alignItems: 'center' }}>
                  <Badge label={STATUS_LABEL[activeThread.status] ?? activeThread.status} tone={activeThread.status === 'RESOLVED' ? 'success' : activeThread.status === 'OPEN' ? 'warning' : 'primary'} />
                  <AppText variant="caption" tone="faint">
                    {tr(
                      activeThread.firstRespondedAt ? 'feedback.categoryResponded' : 'feedback.categoryAwaiting',
                      { category: feedbackCategoryLabel(activeThread.category) },
                    )}
                  </AppText>
                </View>
              )}
              <ScrollView ref={scrollRef} onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
                contentContainerStyle={{ padding: t.space.xl, paddingTop: t.space.sm, gap: t.space.md }}>
                {messages === null && <ActivityIndicator color={t.colors.primary} style={{ marginTop: t.space.lg }} />}
                {messages?.filter((m) => m.authorType !== 'SYSTEM' || m.body).map((m) => {
                  if (m.authorType === 'SYSTEM') {
                    return (
                      <View key={m.id} style={{ alignSelf: 'center', maxWidth: '90%' }}>
                        <AppText variant="caption" tone="faint" style={{ textAlign: 'center', fontStyle: 'italic' }}>{m.body} · {fmtWhen(m.createdAt)}</AppText>
                      </View>
                    );
                  }
                  const mine = m.authorType === 'REPORTER';
                  return (
                    <View key={m.id} style={{ alignItems: mine ? 'flex-end' : 'flex-start' }}>
                      <AppText variant="caption" tone="faint" style={{ marginBottom: 3 }}>
                        {mine ? tr('feedback.you') : (m.authorName ?? tr('feedback.productTeam'))} · {fmtWhen(m.createdAt)}
                      </AppText>
                      <View style={{
                        maxWidth: '85%', paddingVertical: t.space.sm + 2, paddingHorizontal: t.space.md, borderRadius: t.radius.lg,
                        backgroundColor: mine ? t.colors.primary : t.colors.surface,
                        borderWidth: mine ? 0 : 1, borderColor: t.colors.border,
                      }}>
                        {/* onPrimary, not a literal white — the bubble sits on t.colors.primary,
                            and onPrimary is the token that already tracks what stays readable on
                            it (near-black in dark mode, white in light). A literal '#fff' here
                            would go unreadable the moment light mode's primary got any lighter. */}
                        <AppText variant="body" style={{ color: mine ? t.colors.onPrimary : t.colors.text }}>{m.body}</AppText>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>

              {activeThread?.status !== 'CLOSED' && (
                <View style={{ flexDirection: 'row', gap: t.space.sm, padding: t.space.md, paddingBottom: t.space.xl, borderTopWidth: 1, borderTopColor: t.colors.border, alignItems: 'flex-end' }}>
                  <View style={{ flex: 1, backgroundColor: t.colors.surface, borderRadius: t.radius.lg, borderWidth: 1, borderColor: t.colors.border, paddingHorizontal: t.space.md }}>
                    <TextInput value={draft} onChangeText={setDraft} placeholder={tr('feedback.replyPlaceholder')} placeholderTextColor={t.colors.textFaint}
                      multiline maxLength={4000} style={{ color: t.colors.text, paddingVertical: t.space.sm + 2, maxHeight: 100, ...(t.type.body as object) }} />
                  </View>
                  <IconButton icon={replying ? 'hourglass-outline' : 'send'} onPress={sendReply} accessibilityLabel={tr('feedback.sendReply')} size={44} tone={draft.trim() && !replying ? 'primary' : 'default'} />
                </View>
              )}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
};

export default FeedbackModal;
