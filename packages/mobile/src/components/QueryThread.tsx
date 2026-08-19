import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, ScrollView, TextInput, Image, Linking, Platform, ActivityIndicator } from 'react-native';
import { MobileApiService } from '../services/api.service';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Badge, Button, Card, Icon, IconButton, Tappable } from './ui/primitives';
import { useFeedback } from './ui/Feedback';
import type { QueryMessage, ValidationQuery } from '../types/mobile-app';

interface QueryThreadProps {
  query: ValidationQuery;
  /** Bumped by the parent when a socket event says this thread changed. */
  refreshKey?: number;
  onAttach: () => Promise<{ url: string; fileName: string; fileType: string }[]>;
  onScan: () => void;
}

const isImage = (fileType?: string, fileName?: string) =>
  /^image\//i.test(fileType || '') || /\.(png|jpe?g|webp|gif)$/i.test(fileName || '');

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
};

const dayOf = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

/**
 * The clarification conversation, as an actual conversation.
 *
 * The previous screen rendered two frozen fields — the desk's original `queryText` and the
 * assayer's single `assayerResponse` — and could only ever POST one reply. The data-entry team
 * was meanwhile using `/validation-queries/:id/messages`, a real thread, so every follow-up
 * they sent after the first exchange was invisible on the assayer's phone. Both sides now read
 * and write the same thread, which is also what lets the server move the query's status
 * correctly as each side speaks.
 */
export const QueryThread: React.FC<QueryThreadProps> = ({ query, refreshKey, onAttach, onScan }) => {
  const t = useTheme();
  const feedback = useFeedback();
  const scrollRef = useRef<ScrollView>(null);

  const [messages, setMessages] = useState<QueryMessage[]>([]);
  const [loading, setLoading] = useState(true);
  // Distinct from "no messages": the fetch itself failed. See `getQueryMessages` for why the two
  // must not share a value — this used to render as an invitation to reply.
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<{ url: string; fileName: string; fileType: string }[]>([]);
  const [sending, setSending] = useState(false);

  /**
   * Signed URLs for every attachment in the thread, keyed by s3Key.
   *
   * The stored `url` points at a route that only accepts a signed HMAC token — a plain JWT in
   * the query string is rejected — so rendering it directly showed a broken image and an
   * unopenable file. Resolving once per load keeps it off the render path.
   */
  const [signed, setSigned] = useState<Record<string, string>>({});

  /**
   * Which load is allowed to write. Bumped by every new load and by the effect's cleanup, so a
   * response that arrives late is dropped instead of applied.
   *
   * A branch can carry several clarifications and the parent switches between them in place —
   * this component is not remounted, only handed a different `query`. On a branch connection a
   * fetch routinely takes several seconds, so tapping query A and then query B while A is still
   * in flight used to end with A's messages rendered under B's question, and the assayer
   * answering the wrong desk request. The same window opens on its own: `refreshKey` is bumped
   * once per incoming socket message, so a desk sending three in a row starts three overlapping
   * loads whose completion order is not the order they were issued.
   */
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    const list = await MobileApiService.getQueryMessages(query.id);
    if (seq !== loadSeqRef.current) return;
    if (list === null) {
      // Keep whatever was already on screen rather than blanking it, and say plainly that this
      // is a load failure with a way to try again — not an empty thread.
      setLoadFailed(true);
      setLoading(false);
      return;
    }
    setLoadFailed(false);
    setMessages(list);
    setLoading(false);

    const keys = [...new Set(list.flatMap((m) => m.attachments.map((a) => a.s3Key).filter(Boolean)))] as string[];
    if (keys.length === 0) return;
    const pairs = await Promise.all(
      keys.map(async (k) => [k, await MobileApiService.getAttachmentUrl(k)] as const),
    );
    if (seq !== loadSeqRef.current) return;
    setSigned(Object.fromEntries(pairs.filter(([, v]) => !!v) as [string, string][]));
  }, [query.id]);

  useEffect(() => {
    setLoading(true);
    load();
    // Invalidates whatever is still in flight when the query changes or the thread closes.
    return () => {
      loadSeqRef.current++;
    };
  }, [load, refreshKey]);

  // Land on the newest message, which is what the assayer opened the thread to read.
  useEffect(() => {
    if (messages.length === 0) return;
    const id = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 60);
    return () => clearTimeout(id);
  }, [messages.length]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body && pending.length === 0) return;

    setSending(true);
    /**
     * The draft clears only after the server accepts it. Clearing optimistically loses what the
     * assayer typed when the branch has no signal — the exact moment it is hardest to retype.
     */
    const res = await MobileApiService.postQueryMessage(query.id, body, pending);
    setSending(false);

    if (!res.success) {
      feedback.error('Not sent', res.error || 'Your message could not be delivered.');
      return;
    }
    setDraft('');
    setPending([]);
    await load();
  }, [draft, pending, query.id, feedback, load]);

  const attach = useCallback(async () => {
    try {
      const added = await onAttach();
      if (added.length > 0) setPending((prev) => [...prev, ...added]);
    } catch (err: any) {
      feedback.error('Attachment failed', err?.message || 'The file could not be attached.');
    }
  }, [onAttach, feedback]);

  const open = useCallback(
    async (url: string) => {
      const resolved = url;
      if (!resolved) return;
      const ok = await Linking.canOpenURL(resolved).catch(() => false);
      if (!ok) {
        feedback.error('Cannot open', 'No app on this device can open that file.');
        return;
      }
      Linking.openURL(resolved);
    },
    [feedback],
  );

  const grouped = useMemo(() => {
    const out: { day: string; items: QueryMessage[] }[] = [];
    for (const m of messages) {
      const day = dayOf(m.createdAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(m);
      else out.push({ day, items: [m] });
    }
    return out;
  }, [messages]);

  const resolved = query.status === 'RESOLVED';

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ padding: t.space.lg, gap: t.space.md, flexGrow: 1 }}
      >
        {/* The question as raised, always at the top so the ask stays in view. */}
        <Card level={1} style={{ gap: t.space.sm, borderLeftWidth: 3, borderLeftColor: t.colors.warning }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
            <Icon name="help-circle" size={16} color={t.colors.warning} />
            <AppText variant="caption" tone="muted" style={{ flex: 1 }}>
              {query.validatorName || 'Data entry'} asked about {query.customerName || 'this packet'}
            </AppText>
            {resolved ? <Badge label="Resolved" tone="success" /> : null}
          </View>
          <AppText variant="body">{query.queryText}</AppText>
          {query.accountNumber ? (
            <AppText variant="caption" tone="faint">
              A/C {query.accountNumber}
            </AppText>
          ) : null}
        </Card>

        {loading ? (
          <View style={{ paddingVertical: t.space['3xl'], alignItems: 'center' }}>
            <ActivityIndicator color={t.colors.primary} />
          </View>
        ) : loadFailed && grouped.length === 0 ? (
          <View style={{ paddingVertical: t.space['2xl'], alignItems: 'center', gap: t.space.md }}>
            <AppText variant="small" tone="muted" style={{ textAlign: 'center' }}>
              Couldn't load this thread. The desk may have replied — check your connection and try again.
            </AppText>
            <Button label="Retry" icon="refresh" variant="neutral" onPress={() => { setLoading(true); void load(); }} />
          </View>
        ) : grouped.length === 0 ? (
          <View style={{ paddingVertical: t.space['2xl'], alignItems: 'center' }}>
            <AppText variant="small" tone="faint">
              No replies yet. Answer below and the desk will see it immediately.
            </AppText>
          </View>
        ) : (
          <>
          {loadFailed && (
            // Older messages are still shown, but the latest refresh failed — say so, or the
            // assayer reads a stale thread as current.
            <Tappable onPress={() => { setLoading(true); void load(); }} accessibilityRole="button" accessibilityLabel="Retry loading the thread">
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, alignSelf: 'center', paddingVertical: t.space.xs, paddingHorizontal: t.space.md, borderRadius: t.radius.pill, backgroundColor: t.colors.surfaceAlt, borderWidth: 1, borderColor: t.colors.border }}>
                <Icon name="cloud-offline-outline" size={14} color={t.colors.warning} />
                <AppText variant="caption" tone="muted">Showing an older copy — tap to refresh</AppText>
              </View>
            </Tappable>
          )}
          {grouped.map((g) => (
            <View key={g.day} style={{ gap: t.space.md }}>
              <View style={{ alignItems: 'center' }}>
                <AppText variant="caption" tone="faint">
                  {g.day}
                </AppText>
              </View>
              {g.items.map((m) => (
                <Bubble key={m.id} message={m} signed={signed} onOpenAttachment={open} />
              ))}
            </View>
          ))}
          </>
        )}
      </ScrollView>

      {/* Composer */}
      {resolved ? (
        <View style={{ padding: t.space.lg, borderTopWidth: 1, borderColor: t.colors.border }}>
          <AppText variant="small" tone="muted" style={{ textAlign: 'center' }}>
            This clarification is resolved. The desk will reopen it if anything else is needed.
          </AppText>
        </View>
      ) : (
        <View
          style={{
            borderTopWidth: 1,
            borderColor: t.colors.border,
            backgroundColor: t.colors.surface,
            padding: t.space.md,
            gap: t.space.sm,
          }}
        >
          {pending.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: t.space.sm }}>
              {pending.map((a, i) => (
                <View
                  key={`${a.url}-${i}`}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingVertical: 6,
                    paddingHorizontal: t.space.sm,
                    borderRadius: t.radius.pill,
                    backgroundColor: t.colors.primarySoft,
                  }}
                >
                  <Icon name={isImage(a.fileType, a.fileName) ? 'image' : 'document-text'} size={13} color={t.colors.primary} />
                  <AppText variant="caption" tone="primary" numberOfLines={1}>
                    {a.fileName}
                  </AppText>
                  <Tappable
                    onPress={() => setPending((prev) => prev.filter((_, idx) => idx !== i))}
                    accessibilityLabel={`Remove ${a.fileName}`}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Icon name="close" size={13} color={t.colors.primary} />
                  </Tappable>
                </View>
              ))}
            </ScrollView>
          )}

          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: t.space.sm }}>
            <IconButton icon="attach" onPress={attach} accessibilityLabel="Attach a file" />
            <IconButton icon="scan" onPress={onScan} accessibilityLabel="Scan a document" />
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Reply to the desk…"
              placeholderTextColor={t.colors.textFaint}
              multiline
              style={{
                flex: 1,
                maxHeight: 120,
                minHeight: 42,
                paddingHorizontal: t.space.md,
                paddingTop: Platform.OS === 'ios' ? 11 : 8,
                paddingBottom: 8,
                borderRadius: t.radius.lg,
                backgroundColor: t.colors.bg,
                borderWidth: 1,
                borderColor: t.colors.border,
                color: t.colors.text,
                fontSize: 15,
              }}
            />
            <Tappable onPress={send} disabled={sending || (!draft.trim() && pending.length === 0)} accessibilityRole="button" accessibilityLabel={sending ? "Sending" : "Send reply"}>
              <View
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 21,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor:
                    sending || (!draft.trim() && pending.length === 0) ? t.colors.surfaceAlt : t.colors.primary,
                }}
              >
                {sending ? (
                  <ActivityIndicator size="small" color={t.colors.onPrimary} />
                ) : (
                  <Icon name="arrow-up" size={19} color={t.colors.onPrimary} />
                )}
              </View>
            </Tappable>
          </View>
        </View>
      )}
    </View>
  );
};

const Bubble: React.FC<{
  message: QueryMessage;
  signed: Record<string, string>;
  onOpenAttachment: (url: string) => void;
}> = ({ message, signed, onOpenAttachment }) => {
  const t = useTheme();
  const mine = message.authorType === 'ASSAYER';

  return (
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start' }}>
      <View
        style={{
          maxWidth: '86%',
          gap: 6,
          padding: t.space.md,
          borderRadius: t.radius.lg,
          // The assayer's own replies carry the accent; the desk's stay neutral, so a glance
          // tells you who is speaking without reading the name.
          backgroundColor: mine ? t.colors.primarySoft : t.colors.surfaceAlt,
          borderWidth: 1,
          borderColor: mine ? t.colors.primarySoft : t.colors.border,
        }}
      >
        {!mine && message.authorName ? (
          <AppText variant="caption" tone="primary">
            {message.authorName}
          </AppText>
        ) : null}

        {message.body ? <AppText variant="body">{message.body}</AppText> : null}

        {message.attachments.map((a, i) => {
          const href = (a.s3Key && signed[a.s3Key]) || '';
          return (
          <Tappable key={`${a.url}-${i}`} onPress={() => href && onOpenAttachment(href)}>
            {isImage(a.fileType, a.fileName) && href ? (
              <Image
                source={{ uri: href }}
                style={{ width: 200, height: 150, borderRadius: t.radius.md, marginTop: 2 }}
                resizeMode="cover"
              />
            ) : (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: t.space.sm,
                  padding: t.space.sm,
                  borderRadius: t.radius.md,
                  backgroundColor: t.colors.bg,
                }}
              >
                <Icon name="document-text" size={16} color={t.colors.primary} />
                <AppText variant="small" numberOfLines={1} style={{ flex: 1 }}>
                  {a.fileName}
                </AppText>
                <Icon name="open-outline" size={14} color={t.colors.textFaint} />
              </View>
            )}
          </Tappable>
          );
        })}

        {/* The desk can anchor a question to a page of the audit PDF; say so. */}
        {message.pageNumber != null ? (
          <AppText variant="caption" tone="faint">
            Refers to page {message.pageNumber}
          </AppText>
        ) : null}

        <AppText variant="caption" tone="faint" style={{ alignSelf: 'flex-end' }}>
          {timeOf(message.createdAt)}
        </AppText>
      </View>
    </View>
  );
};
