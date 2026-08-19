import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, View, TextInput, ScrollView, ActivityIndicator, Platform } from 'react-native';
import Constants from 'expo-constants';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Icon, IconButton, Card, Tappable, Badge, EmptyState } from './ui/primitives';
import { MobileApiService } from '../services/api.service';

import { FEEDBACK_STATUS_LABELS, feedbackCategoryLabel } from '@fapoms/shared';
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
const CATEGORIES: { key: string; label: string; icon: string }[] = [
  { key: '', label: 'Auto', icon: 'sparkles-outline' },
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
  const [view, setView] = useState<ViewMode>('list');
  const [threads, setThreads] = useState<any[] | null>(null);

  // compose
  const [category, setCategory] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // thread
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<any | null>(null);
  const [messages, setMessages] = useState<any[] | null>(null);
  const [draft, setDraft] = useState('');
  const [replying, setReplying] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

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
    setSending(true);
    setErr(null);
    const res = await MobileApiService.createFeedback({
      title: title.trim() || undefined,
      body: body.trim(),
      category: category || undefined,
      appContext: { platform: 'mobile', appVersion: Constants.expoConfig?.version ?? '1.0.0' },
    });
    setSending(false);
    if (res.success) {
      setTitle(''); setBody(''); setCategory('');
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
              <IconButton icon="chevron-back" onPress={() => { setView('list'); setErr(null); loadList(); }} accessibilityLabel="Back" size={36} />
            ) : (
              <Icon name="chatbox-ellipses-outline" size={20} color={t.colors.primary} />
            )}
            <AppText variant="h2" style={{ flex: 1 }}>
              {view === 'compose' ? 'New feedback' : view === 'thread' ? (activeThread?.title ?? 'Feedback') : 'Feedback'}
            </AppText>
            <IconButton icon="close" onPress={close} accessibilityLabel="Close" size={36} />
          </View>

          {view === 'list' && (
            <>
              <View style={{ paddingHorizontal: t.space.xl, paddingBottom: t.space.sm }}>
                <Button label="Send new feedback" icon="add" onPress={() => { setView('compose'); setErr(null); }} full />
              </View>
              <ScrollView contentContainerStyle={{ padding: t.space.xl, paddingTop: t.space.sm, gap: t.space.md }}>
                {threads === null && <ActivityIndicator color={t.colors.primary} style={{ marginTop: t.space.xl }} />}
                {threads?.length === 0 && (
                  <EmptyState icon="chatbox-outline" title="No feedback yet" body="Report a bug, suggest an improvement or ask a question — the product team will reply here." />
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
                <AppText variant="overline" tone="faint">WHAT KIND?</AppText>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
                  {CATEGORIES.map((c) => {
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
                <AppText variant="overline" tone="faint">TITLE (OPTIONAL)</AppText>
                <View style={{ backgroundColor: t.colors.surface, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.colors.border, paddingHorizontal: t.space.md }}>
                  <TextInput value={title} onChangeText={setTitle} placeholder="Short summary" placeholderTextColor={t.colors.textFaint} maxLength={200}
                    style={{ color: t.colors.text, paddingVertical: t.space.md, ...(t.type.body as object) }} />
                </View>
              </View>

              <View style={{ gap: t.space.sm }}>
                <AppText variant="overline" tone="faint">DETAILS</AppText>
                <View style={{ backgroundColor: t.colors.surface, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.colors.border, paddingHorizontal: t.space.md }}>
                  <TextInput value={body} onChangeText={setBody} placeholder="What happened, or what would help?" placeholderTextColor={t.colors.textFaint}
                    multiline numberOfLines={5} maxLength={4000}
                    style={{ color: t.colors.text, paddingVertical: t.space.md, minHeight: 120, textAlignVertical: 'top', ...(t.type.body as object) }} />
                </View>
              </View>

              {err && <AppText variant="caption" tone="danger">{err}</AppText>}
              <Button label={sending ? 'Sending…' : 'Send'} icon="send" onPress={submitNew} loading={sending} disabled={!body.trim()} size="lg" full />
            </ScrollView>
          )}

          {view === 'thread' && (
            <View style={{ flex: 1 }}>
              {activeThread && (
                <View style={{ paddingHorizontal: t.space.xl, paddingBottom: t.space.sm, flexDirection: 'row', gap: t.space.sm, alignItems: 'center' }}>
                  <Badge label={STATUS_LABEL[activeThread.status] ?? activeThread.status} tone={activeThread.status === 'RESOLVED' ? 'success' : activeThread.status === 'OPEN' ? 'warning' : 'primary'} />
                  <AppText variant="caption" tone="faint">
                    {feedbackCategoryLabel(activeThread.category)}{activeThread.firstRespondedAt ? ' · team responded' : ' · awaiting first response'}
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
                        {mine ? 'You' : (m.authorName ?? 'Product team')} · {fmtWhen(m.createdAt)}
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
                    <TextInput value={draft} onChangeText={setDraft} placeholder="Add to the conversation…" placeholderTextColor={t.colors.textFaint}
                      multiline maxLength={4000} style={{ color: t.colors.text, paddingVertical: t.space.sm + 2, maxHeight: 100, ...(t.type.body as object) }} />
                  </View>
                  <IconButton icon={replying ? 'hourglass-outline' : 'send'} onPress={sendReply} accessibilityLabel="Send" size={44} tone={draft.trim() && !replying ? 'primary' : 'default'} />
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
