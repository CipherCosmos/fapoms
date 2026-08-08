import React, { useCallback, useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  ScrollView,
  TextInput,
  StyleSheet,
  Image,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { AssayerAssignment } from '../types/mobile-app';
import { MobileApiService } from '../services/api.service';
import { connectMobileSocket } from '../services/socket';
import { DocumentScanner, readAsBase64 } from './DocumentScanner';
import { QueryThread } from './QueryThread';
import { useTheme } from '../theme/ThemeProvider';
import { useFeedback } from './ui/Feedback';
import { AppText, Icon, IconButton, Tappable } from './ui/primitives';

interface AssayerQueryChatModalProps {
  visible: boolean;
  onClose: () => void;
  assignment: AssayerAssignment | null;
}

export const AssayerQueryChatModal: React.FC<AssayerQueryChatModalProps> = ({
  visible,
  onClose,
  assignment,
}) => {
  const t = useTheme();
  const feedback = useFeedback();
  const [queries, setQueries] = useState<any[]>([]);
  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
  /** Bumped by the socket listeners so an open thread reloads when the desk replies. */
  const [threadVersion, setThreadVersion] = useState(0);
  const [responseText, setResponseText] = useState('');
  const [attachments, setAttachments] = useState<{ url: string; fileName: string; fileType: string; uploadedBy: string; timestamp: string }[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const scrollViewRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (visible && assignment) {
      loadQueries();
      const socket = connectMobileSocket();
      const handleQueryUpdate = () => {
        loadQueries();
        setThreadVersion((v) => v + 1);
      };
      socket?.on('query:raised', handleQueryUpdate);
      socket?.on('query:responded', handleQueryUpdate);
      return () => {
        socket?.off('query:raised', handleQueryUpdate);
        socket?.off('query:responded', handleQueryUpdate);
      };
    }
  }, [visible, assignment]);

  const loadQueries = async () => {
    if (!assignment) return;
    try {
      const assayerId = assignment.assayerId || MobileApiService.getCurrentUserId();
      if (!assayerId) return;
      const data = await MobileApiService.getAssayerQueries(assayerId);

      // Strict scoping: filter queries to ONLY those belonging to this specific assignment/branch
      const filtered = (data || []).filter((q: any) => {
        const queryPbId = q.validationCase?.projectBranchId || q.projectBranchId;
        const queryAsmId = q.validationCase?.assessmentId || q.assessmentId;
        const targetPbId = assignment.projectBranchId;
        const targetAsmId = assignment.id || (assignment as any).assessmentId;

        if (targetPbId && queryPbId) {
          return queryPbId === targetPbId;
        }
        if (targetAsmId && queryAsmId) {
          return queryAsmId === targetAsmId;
        }
        if ((assignment as any).validationCaseId && q.validationCaseId === (assignment as any).validationCaseId) {
          return true;
        }
        if (Array.isArray(assignment.queries)) {
          return assignment.queries.some((aq: any) => aq.id === q.id);
        }
        return false;
      });

      setQueries(filtered);
      if (filtered.length > 0) {
        const openQ = filtered.find((q: any) => q.status === 'OPEN') || filtered[0];
        setActiveQueryId(openQ.id);
      } else {
        setActiveQueryId(null);
      }
    } catch (err) {
      setQueries([]);
      setActiveQueryId(null);
    }
  };

  const [replyToMessage, setReplyToMessage] = useState<{ sender: string; text: string } | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);

  type Attachment = { url: string; fileName: string; fileType: string };

  /**
   * Picks and uploads files, returning what was stored so the composer can stage them.
   *
   * The web branch previously did its work inside an `onchange` callback, so the values could
   * never reach the caller — on web the picked file uploaded and then vanished. Wrapping the
   * DOM input in a promise is what lets both platforms return the same thing.
   */
  const handlePickAttachment = useCallback(async (): Promise<Attachment[]> => {
    try {
      const g: any = typeof globalThis !== 'undefined' ? globalThis : {};

      if (Platform.OS === 'web' && g.document) {
        return await new Promise<Attachment[]>((resolve) => {
          const input = g.document.createElement('input');
          input.type = 'file';
          input.multiple = true;
          // Resolves empty if the picker is dismissed, so the caller never hangs.
          input.oncancel = () => resolve([]);
          input.onchange = async (e: any) => {
            const files = Array.from(e.target?.files || []) as any[];
            const out: Attachment[] = [];
            for (const file of files) {
              const uploaded = await MobileApiService.uploadChatAttachment(file);
              if (uploaded && uploaded.length > 0) out.push(...uploaded);
              else feedback.error('Upload failed', `${file.name} was not attached.`);
            }
            resolve(out);
          };
          input.click();
        });
      }

      const result = await DocumentPicker.getDocumentAsync({
        type: ['*/*'],
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (result.canceled || !result.assets?.length) return [];

      const out: Attachment[] = [];
      for (const asset of result.assets) {
        const uploaded = await MobileApiService.uploadChatAttachment(asset);
        if (uploaded && uploaded.length > 0) out.push(...uploaded);
        else feedback.error('Upload failed', `${asset.name} was not attached.`);
      }
      return out;
    } catch (err: any) {
      feedback.error('Attachment failed', err?.message || 'The file could not be selected.');
      return [];
    }
  }, [feedback]);

  const removePendingAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSendResponse = async () => {
    if (!activeQueryId) return;
    if (!responseText.trim() && attachments.length === 0) {
      feedback.warning('Nothing to send', 'Enter a message or attach a file first.');
      return;
    }

    setIsSubmitting(true);
    try {
      let finalMsg = responseText.trim();
      if (replyToMessage) {
        finalMsg = `> ↩️ Replying to ${replyToMessage.sender}: "${replyToMessage.text.slice(0, 60)}${replyToMessage.text.length > 60 ? '...' : ''}"\n${finalMsg}`;
      }
      if (!finalMsg && attachments.length > 0) {
        finalMsg = 'Sent attachment(s)';
      }

      const success = await MobileApiService.respondToQuery(activeQueryId, finalMsg, attachments);
      if (success) {
        setResponseText('');
        setAttachments([]);
        setReplyToMessage(null);
        await loadQueries();
        setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 100);
      } else {
        feedback.error('Not delivered', 'The message could not be sent. Please retry.');
      }
    } catch (err: any) {
      feedback.error('Not delivered', err?.message || 'Network error.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const activeQuery = queries.find((q: any) => q.id === activeQueryId) ?? null;

  if (!visible || !assignment) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={{
          paddingTop: Platform.OS === 'ios' ? 50 : 20,
          paddingHorizontal: t.space.lg,
          paddingBottom: t.space.md,
          backgroundColor: t.colors.surface,
          flexDirection: 'row',
          alignItems: 'center',
          gap: t.space.md,
          borderBottomWidth: 1,
          borderColor: t.colors.border,
        }}>
          <IconButton icon="arrow-back" onPress={onClose} />
          <View style={{
            width: 40, height: 40, borderRadius: 20,
            backgroundColor: t.colors.primarySoft,
            alignItems: 'center', justifyContent: 'center',
          }}>
            <AppText variant="bodyStrong" tone="primary">DE</AppText>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="h3" numberOfLines={1}>Data Entry Team</AppText>
            <AppText variant="caption" tone="muted" numberOfLines={1}>{assignment.branchName}</AppText>
          </View>
        </View>

        {/*
          The thread itself. This replaced ~200 lines that rendered `queryText` and a single
          `assayerResponse` as if they were a conversation, plus a composer that could only ever
          POST one reply. The desk was already using the real message thread, so anything they
          sent after the assayer's first answer never reached the phone.
        */}
        {activeQuery ? (
          <QueryThread
            query={activeQuery}
            refreshKey={threadVersion}
            onAttach={handlePickAttachment}
            onScan={() => setIsCameraActive(true)}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.space.xl }}>
            <AppText variant="body" tone="muted" style={{ textAlign: 'center' }}>
              No clarifications have been raised for this branch.
            </AppText>
          </View>
        )}

        {/* Camera capture modal overlay for scanning/attaching photos directly inside chat */}
        <DocumentScanner
          visible={isCameraActive}
          purpose="Attach to this clarification"
          onClose={() => setIsCameraActive(false)}
          onSaved={async (doc) => {
            setIsCameraActive(false);

            /**
             * Attaches the assembled PDF when there is one, otherwise every page image.
             *
             * The thread stores attachments as inline data URLs, so the bytes have to be read
             * back off disk here — the scanner deliberately hands over file URIs rather than
             * base64 to keep multi-page scans off the bridge.
             */
            try {
              if (doc.pdfUri) {
                const base64 = await readAsBase64(doc.pdfUri);
                setAttachments((prev) => [
                  ...prev,
                  {
                    url: `data:application/pdf;base64,${base64}`,
                    fileName: doc.fileName,
                    fileType: 'application/pdf',
                    uploadedBy: 'ASSAYER',
                    timestamp: new Date().toISOString(),
                  },
                ]);
                return;
              }

              const base = doc.fileName.replace(/\.[^.]+$/, '');
              const total = doc.pages.length;
              const encoded = await Promise.all(doc.pages.map((pg) => readAsBase64(pg.uri)));
              setAttachments((prev) => [
                ...prev,
                ...doc.pages.map((pg, i) => ({
                  url: `data:image/jpeg;base64,${encoded[i]}`,
                  fileName: total === 1 ? doc.fileName : `${base}_p${pg.pageNumber}of${total}.jpg`,
                  fileType: 'image/jpeg',
                  uploadedBy: 'ASSAYER',
                  timestamp: new Date().toISOString(),
                })),
              ]);
            } catch (err: any) {
              feedback.error('Attachment failed', err?.message || 'The scanned document could not be read.');
            }
          }}
        />
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b141a', // WhatsApp Dark Mode background
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1f2c34', // WhatsApp Header green/dark
    paddingTop: Platform.OS === 'ios' ? 44 : 12,
    paddingBottom: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2a3942',
  },
  backBtn: {
    paddingRight: 8,
  },
  backArrow: {
    color: '#e9edef',
    fontSize: 22,
    fontWeight: '600',
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#00a884',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  avatarText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  headerInfo: {
    flex: 1,
  },
  headerName: {
    color: '#e9edef',
    fontSize: 15,
    fontWeight: '700',
  },
  headerSubtext: {
    color: '#8696a0',
    fontSize: 11,
    marginTop: 1,
  },
  lockBadge: {
    backgroundColor: 'rgba(0,168,132,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  lockIcon: {
    fontSize: 10,
  },
  lockText: {
    color: '#00a884',
    fontSize: 10,
    fontWeight: '700',
  },
  chatArea: {
    flex: 1,
    backgroundColor: '#0b141a',
  },
  chatContent: {
    padding: 12,
    paddingBottom: 24,
  },
  encryptedBanner: {
    backgroundColor: '#182229',
    padding: 8,
    borderRadius: 8,
    marginBottom: 16,
    alignSelf: 'center',
    maxWidth: '90%',
    borderWidth: 1,
    borderColor: '#222d34',
  },
  encryptedText: {
    color: '#ffe596',
    fontSize: 10,
    textAlign: 'center',
    lineHeight: 14,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  emptyStateText: {
    color: '#8696a0',
    fontSize: 13,
  },
  // Incoming Bubble (Left - Data Entry)
  incomingBubble: {
    backgroundColor: '#202c33',
    alignSelf: 'flex-start',
    maxWidth: '82%',
    borderRadius: 8,
    borderTopLeftRadius: 0,
    padding: 8,
    paddingHorizontal: 10,
    marginVertical: 2,
  },
  senderName: {
    color: '#53bdeb',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 2,
  },
  messageText: {
    color: '#e9edef',
    fontSize: 13,
    lineHeight: 18,
  },
  timeRow: {
    alignSelf: 'flex-end',
    marginTop: 2,
  },
  messageTime: {
    color: '#8696a0',
    fontSize: 9,
  },
  // Outgoing Bubble (Right - Assayer)
  outgoingBubble: {
    backgroundColor: '#005c4b', // WhatsApp Sent Green
    alignSelf: 'flex-end',
    maxWidth: '82%',
    borderRadius: 8,
    borderTopRightRadius: 0,
    padding: 8,
    paddingHorizontal: 10,
    marginVertical: 2,
  },
  outgoingMessageText: {
    color: '#e9edef',
    fontSize: 13,
    lineHeight: 18,
  },
  outgoingTimeRow: {
    flexDirection: 'row',
    alignSelf: 'flex-end',
    alignItems: 'center',
    marginTop: 2,
  },
  outgoingMessageTime: {
    color: '#8696a0',
    fontSize: 9,
  },
  doubleCheck: {
    color: '#53bdeb', // WhatsApp Blue Checkmarks
    fontSize: 10,
    fontWeight: '700',
  },
  attachmentsRow: {
    marginTop: 4,
    gap: 6,
  },
  imagePreview: {
    width: 200,
    height: 140,
    borderRadius: 6,
    marginBottom: 4,
  },
  fileDocRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 6,
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderRadius: 6,
  },
  fileName: {
    color: '#e9edef',
    fontSize: 12,
    fontWeight: '600',
  },
  fileMeta: {
    color: '#8696a0',
    fontSize: 10,
  },
  downloadTagText: {
    color: '#34d399',
    fontSize: 10,
    fontWeight: '600',
    marginTop: 2,
  },
  tapToReplyHint: {
    color: '#00a884',
    fontSize: 9,
    fontWeight: '600',
  },
  quoteBox: {
    backgroundColor: 'rgba(0,0,0,0.25)',
    borderLeftWidth: 3,
    borderLeftColor: '#00a884',
    padding: 4,
    paddingHorizontal: 8,
    borderRadius: 4,
    marginBottom: 4,
  },
  quoteText: {
    color: '#8696a0',
    fontSize: 11,
    fontStyle: 'italic',
  },
  replyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1f2c34',
    borderLeftWidth: 4,
    borderLeftColor: '#00a884',
    padding: 8,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: '#2a3942',
  },
  replySender: {
    color: '#00a884',
    fontSize: 11,
    fontWeight: '700',
  },
  replyPreview: {
    color: '#8696a0',
    fontSize: 12,
    marginTop: 2,
  },
  closeReplyBtn: {
    color: '#ff6b6b',
    fontSize: 16,
    fontWeight: '700',
    padding: 4,
  },
  pendingBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: '#1f2c34',
    padding: 8,
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: '#2a3942',
  },
  pendingTag: {
    backgroundColor: '#005c4b',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  pendingTagText: {
    color: '#e9edef',
    fontSize: 11,
  },
  removeTag: {
    color: '#ff6b6b',
    fontWeight: '700',
    fontSize: 11,
  },
  // WhatsApp Input Bar
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: '#1f2c34',
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: '#2a3942',
  },
  iconBtn: {
    padding: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  textInput: {
    flex: 1,
    backgroundColor: '#2a3942',
    color: '#e9edef',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 14,
    maxHeight: 100,
  },
  sendCircleBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#00a884',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendIcon: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    marginLeft: 2,
  },
});
