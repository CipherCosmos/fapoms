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
import { callingAvailable, startCall } from '../services/calls';

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
  const [attachments, setAttachments] = useState<{ url: string; fileName: string; fileType: string; uploadedBy: string; timestamp: string }[]>([]);
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
      // Fired for EVERY message posted to a thread — raised/responded only mark
      // lifecycle transitions, so without this a desk follow-up never appears live.
      socket?.on('query:message', handleQueryUpdate);
      return () => {
        socket?.off('query:raised', handleQueryUpdate);
        socket?.off('query:responded', handleQueryUpdate);
        socket?.off('query:message', handleQueryUpdate);
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


  const activeQuery = queries.find((q: any) => q.id === activeQueryId) ?? null;

  if (!visible || !assignment) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: t.colors.bg }]}
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
          {/* Voice call to the desk about the open clarification. Only offered when the
              native WebRTC module exists (dev-client/production build — hidden in Expo Go)
              and the active query is still open; there is nothing to discuss on a closed one. */}
          {callingAvailable && activeQuery && activeQuery.status !== 'RESOLVED' && activeQuery.status !== 'CLOSED' && (
            <IconButton
              icon="call"
              tone="primary"
              accessibilityLabel="Call the data entry team about this query"
              onPress={() => {
                startCall({
                  queryId: activeQuery.id,
                  peerName: 'Data Entry Team',
                  queryText: activeQuery.queryText || '',
                }).catch((err: any) => {
                  feedback.error('Call not started', err?.message || 'The call could not be placed.');
                });
              }}
            />
          )}
        </View>

        {/*
          The thread itself. This replaced ~200 lines that rendered `queryText` and a single
          `assayerResponse` as if they were a conversation, plus a composer that could only ever
          POST one reply. The desk was already using the real message thread, so anything they
          sent after the assayer's first answer never reached the phone.
        */}
        {/*
          A branch can carry several clarifications. `activeQueryId` was only ever set
          automatically to the first open one and never changed after, so on an assignment with
          three questions the assayer could reach exactly one and the other two were
          unanswerable from the app.
        */}
        {queries.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0, borderBottomWidth: 1, borderColor: t.colors.border }}
            contentContainerStyle={{ padding: t.space.md, gap: t.space.sm }}
          >
            {queries.map((q: any, i: number) => {
              const active = q.id === activeQueryId;
              const open = q.status === 'OPEN';
              return (
                <Tappable key={q.id} onPress={() => setActiveQueryId(q.id)}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                      paddingVertical: 7,
                      paddingHorizontal: t.space.md,
                      borderRadius: t.radius.pill,
                      backgroundColor: active ? t.colors.primarySoft : t.colors.surfaceAlt,
                      borderWidth: 1,
                      borderColor: active ? t.colors.primary : t.colors.border,
                    }}
                  >
                    {open && (
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.colors.warning }} />
                    )}
                    <AppText variant="caption" tone={active ? 'primary' : 'muted'} numberOfLines={1}>
                      {q.customerName || q.accountNumber || `Query ${i + 1}`}
                    </AppText>
                  </View>
                </Tappable>
              );
            })}
          </ScrollView>
        )}

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
            if (!activeQueryId) return;

            /**
             * Uploads the scan and posts it into the thread.
             *
             * The old path inlined the bytes as a `data:` URL on a local attachments array
             * that the new composer no longer reads — the scan simply disappeared. Uploading
             * through the same endpoint the file picker uses means the desk sees a real,
             * downloadable document rather than a multi-megabyte string embedded in a message.
             */
            try {
              const asset = doc.pdfUri
                ? { uri: doc.pdfUri, name: doc.fileName, mimeType: 'application/pdf' }
                : null;

              const uploaded = asset
                ? await MobileApiService.uploadChatAttachment(asset)
                : (
                    await Promise.all(
                      doc.pages.map((pg, i) =>
                        MobileApiService.uploadChatAttachment({
                          uri: pg.uri,
                          name: `${doc.fileName.replace(/\.[^.]+$/, '')}_p${i + 1}.jpg`,
                          mimeType: 'image/jpeg',
                        }),
                      ),
                    )
                  ).flat();

              if (!uploaded || uploaded.length === 0) {
                feedback.error('Not attached', 'The scan could not be uploaded. Please retry.');
                return;
              }

              const res = await MobileApiService.postQueryMessage(activeQueryId, '', uploaded);
              if (!res.success) {
                feedback.error('Not sent', res.error || 'The scan could not be sent.');
                return;
              }
              setThreadVersion((v) => v + 1);
              feedback.success('Sent', `${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'} sent to the desk.`);
            } catch (err: any) {
              feedback.error('Attachment failed', err?.message || 'The scanned document could not be sent.');
            }
          }}
        />
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  // Only the flex container survives; the former WhatsApp-clone palette (a parallel
  // colour scheme that ignored the design system) is gone. Background comes from the
  // theme at the call site so it follows light/dark like the rest of the app.
  container: { flex: 1 },
});
