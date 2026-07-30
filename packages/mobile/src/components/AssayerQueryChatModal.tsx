import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  ScrollView,
  TextInput,
  Alert,
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
import { MLKitScannerModal } from './MLKitScannerModal';
import { Ionicons } from '@expo/vector-icons';

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
  const [queries, setQueries] = useState<any[]>([]);
  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
  const [responseText, setResponseText] = useState('');
  const [attachments, setAttachments] = useState<{ url: string; fileName: string; fileType: string; uploadedBy: string; timestamp: string }[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const scrollViewRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (visible && assignment) {
      loadQueries();
      const socket = connectMobileSocket();
      const handleQueryUpdate = () => loadQueries();
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
      setQueries(data || []);
      if (data && data.length > 0) {
        const openQ = data.find((q: any) => q.status === 'OPEN') || data[0];
        setActiveQueryId(openQ.id);
      }
    } catch (err) {
      setQueries([]);
    }
  };

  const [replyToMessage, setReplyToMessage] = useState<{ sender: string; text: string } | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);

  const handlePickAttachment = async () => {
    try {
      const g: any = typeof globalThis !== 'undefined' ? globalThis : {};

      // Web browser DOM fallback for file picking
      if (Platform.OS === 'web' && g.document) {
        const input = g.document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = async (e: any) => {
          const files = Array.from(e.target?.files || []);
          for (const file of files as any[]) {
            const uploadRes = await MobileApiService.uploadChatAttachment(file);
            if (uploadRes && uploadRes.length > 0) {
              setAttachments((prev) => [...prev, ...uploadRes]);
            } else {
              Alert.alert('Upload Failed', `Could not upload ${file.name}. Please retry.`);
            }
          }
        };
        input.click();
        return;
      }

      // Native mobile Expo DocumentPicker
      const result = await DocumentPicker.getDocumentAsync({
        type: ['*/*'],
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0];
        const uploadRes = await MobileApiService.uploadChatAttachment(asset);
        if (uploadRes && uploadRes.length > 0) {
          setAttachments((prev) => [...prev, ...uploadRes]);
        } else {
          Alert.alert('Upload Failed', `Could not upload ${asset.name}. Please retry.`);
        }
      }
    } catch (err: any) {
      Alert.alert('Attachment Error', err?.message || 'Failed to select file.');
    }
  };

  const removePendingAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSendResponse = async () => {
    if (!activeQueryId) return;
    if (!responseText.trim() && attachments.length === 0) {
      Alert.alert('Empty Message', 'Please enter a message or attach a file.');
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
        Alert.alert('Delivery Failed', 'Could not send message. Please retry.');
      }
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Network error.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!visible || !assignment) return null;

  // Flatten queries into a chronological message stream for WhatsApp chat view
  const currentQuery = queries.find((q) => q.id === activeQueryId) || queries[0];

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* WhatsApp-style Header Bar */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.backBtn}>
            <Text style={styles.backArrow}>←</Text>
          </TouchableOpacity>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>DE</Text>
          </View>
          <View style={styles.headerInfo}>
            <Text style={styles.headerName}>Data Entry Team</Text>
            <Text style={styles.headerSubtext}>
              {assignment.branchName} • <Text style={{ color: '#25D366' }}>● Online</Text>
            </Text>
          </View>
          <View style={styles.lockBadge}>
            <Ionicons name="lock-closed" size={10} color="#00a884" />
            <Text style={styles.lockText}>Confidential</Text>
          </View>
        </View>

        {/* WhatsApp Wallpaper Chat Area */}
        <ScrollView
          ref={scrollViewRef}
          style={styles.chatArea}
          contentContainerStyle={styles.chatContent}
          onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
        >
          {/* Encryption Banner */}
          <View style={styles.encryptedBanner}>
            <Text style={styles.encryptedText}>
              <Ionicons name="lock-closed" size={10} color="#ffe596" /> Messages & files are end-to-end encrypted within FAPOMS. No third-party access.
            </Text>
          </View>

          {/* Queries / Messages stream across ALL queries for this audit */}
          {queries.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="chatbubble" size={36} color="#8696a0" />
              <Text style={styles.emptyStateText}>No active queries for this branch.</Text>
            </View>
          ) : (
            <View style={{ gap: 12 }}>
              {/* Sort all queries chronologically (oldest first, newest at bottom) */}
              {[...queries]
                .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
                .map((q: any) => (
                  <View key={q.id} style={{ gap: 8 }}>
                    {/* Data Entry Query (Left Bubble - Incoming) */}
                      {/* Incoming Query Bubble — hide placeholder when attachments exist */}
                      {q.queryText && (q.queryText !== 'Sent attachment(s)' || (!q.attachments || q.attachments.length === 0)) && (
                        <TouchableOpacity
                          activeOpacity={0.8}
                          onPress={() => {
                            setActiveQueryId(q.id);
                            setReplyToMessage({ sender: 'Data Entry', text: q.queryText });
                          }}
                          style={styles.incomingBubble}
                        >
                          <Text style={styles.senderName}>Data Entry Team</Text>
                          <Text style={styles.messageText}>{q.queryText}</Text>
                          <View style={styles.timeRow}>
                            <Text style={styles.messageTime}>
                              {new Date(q.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </Text>
                            <Text style={styles.tapToReplyHint}> • Tap to reply</Text>
                          </View>
                        </TouchableOpacity>
                      )}

                    {/* Assayer Responses (Right Bubble - Outgoing) */}
                      {q.assayerResponse ? (
                      q.assayerResponse.split('\n').map((line: string, idx: number) => {
                        const cleanLine = line.replace(/^\[.*?\]\s*/, '');
                        const isQuote = cleanLine.startsWith('> ↩️ Replying to');
                        if (cleanLine === 'Sent attachment(s)' && q.attachments && q.attachments.length > 0) return null;
                        return (
                          <TouchableOpacity
                            key={idx}
                            activeOpacity={0.8}
                            onPress={() => {
                              setActiveQueryId(q.id);
                              setReplyToMessage({ sender: 'Assayer', text: cleanLine });
                            }}
                            style={styles.outgoingBubble}
                          >
                            {isQuote ? (
                              <View style={styles.quoteBox}>
                                <Text style={styles.quoteText}>{cleanLine.split('\n')[0]}</Text>
                              </View>
                            ) : null}
                            <Text style={styles.outgoingMessageText}>
                              {isQuote ? cleanLine.split('\n').slice(1).join('\n') : cleanLine}
                            </Text>
                            <View style={styles.outgoingTimeRow}>
                              <Text style={styles.outgoingMessageTime}>
                                {q.respondedAt
                                  ? new Date(q.respondedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                  : 'Just now'}
                              </Text>
                              <Ionicons name="checkmark-done" size={10} color="#53bdeb" />
                            </View>
                          </TouchableOpacity>
                        );
                      })
                    ) : null}

                    {/* Attachments for this Query */}
                    {q.attachments && q.attachments.length > 0 && (
                      q.attachments.flat(Infinity).filter((att: any) => att && (att.url || typeof att === 'string')).map((att: any, idx: number) => {
                        const rawUrl = typeof att === 'string' ? att : att.url;
                        const fileName = att.fileName || `Attachment #${idx + 1}`;
                        const fileType = att.fileType || '';
                        const isOutgoing = att.uploadedBy === 'ASSAYER' || !att.uploadedBy;
                        
                        // Resolve the full URL: server-stored files use relative paths like /api/v1/...
                        const resolveUrl = (url: string) => {
                          if (!url) return '';
                          if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://')) return url;
                          // Relative server URL — prepend the API origin
                          const apiOrigin = MobileApiService.getApiOrigin();
                          return `${apiOrigin}${url}`;
                        };
                        const fullUrl = resolveUrl(rawUrl);

                        const handleDownloadFile = () => {
                          try {
                            if (!fullUrl) return;
                            const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
                            if (g.window) {
                              const link = g.document.createElement('a');
                              link.href = fullUrl;
                              link.download = fileName;
                              link.target = '_blank';
                              g.document.body.appendChild(link);
                              link.click();
                              setTimeout(() => g.document.body.removeChild(link), 500);
                            }
                          } catch (err: any) {
                            Alert.alert('Download Error', err?.message || 'Could not download file.');
                          }
                        };

                        return (
                          <TouchableOpacity
                            key={idx}
                            activeOpacity={0.7}
                            onPress={handleDownloadFile}
                            style={isOutgoing ? styles.outgoingBubble : styles.incomingBubble}
                          >
                            {att.fileType?.startsWith('image/') ? (
                              <Image source={{ uri: fullUrl }} style={styles.imagePreview} />
                            ) : (
                              <View style={styles.fileDocRow}>
                                <Ionicons name="document-text" size={24} color="#e9edef" />
                                <View style={{ flex: 1 }}>
                                  <Text style={styles.fileName}>{att.fileName || `Document #${idx + 1}`}</Text>
                                  <Text style={{ fontSize: 10, color: '#34d399', fontWeight: '700', marginTop: 2 }}><Ionicons name="download" size={10} color="#34d399" /> Tap to Save / Download</Text>
                                </View>
                              </View>
                            )}
                            <View style={isOutgoing ? styles.outgoingTimeRow : styles.timeRow}>
                              <Text style={isOutgoing ? styles.outgoingMessageTime : styles.messageTime}>
                                {new Date(att.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </Text>
                              {isOutgoing && <Ionicons name="checkmark-done" size={10} color="#53bdeb" />}
                            </View>
                          </TouchableOpacity>
                        );
                      })
                    )}
                  </View>
                ))}
            </View>
          )}
        </ScrollView>

        {/* Tagged Reply Banner */}
        {replyToMessage && (
          <View style={styles.replyBanner}>
            <View style={{ flex: 1 }}>
              <Text style={styles.replySender}><Ionicons name="return-down-back" size={12} color="#00a884" /> Replying to {replyToMessage.sender}</Text>
              <Text style={styles.replyPreview} numberOfLines={1}>{replyToMessage.text}</Text>
            </View>
            <TouchableOpacity onPress={() => setReplyToMessage(null)}>
              <Ionicons name="close" size={16} color="#ff6b6b" />
            </TouchableOpacity>
          </View>
        )}

        {/* Pending Attachment Preview Bar */}
        {attachments.length > 0 && (
          <View style={styles.pendingBar}>
            {attachments.map((att, idx) => (
              <View key={idx} style={styles.pendingTag}>
                <Ionicons name="paperclip" size={11} color="#e9edef" />
                <Text style={styles.pendingTagText}>{att.fileName}</Text>
                <TouchableOpacity onPress={() => removePendingAttachment(idx)}>
                  <Ionicons name="close" size={11} color="#ff6b6b" />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* WhatsApp-style Input Footer Bar or Resolved Lock Banner */}
        {queries.length > 0 && queries.every((q: any) => q.status === 'RESOLVED') ? (
          <View style={{ backgroundColor: '#182229', padding: 14, borderTopWidth: 1, borderTopColor: '#2a3942', alignItems: 'center' }}>
            <Text style={{ color: '#8696a0', fontSize: 12, fontWeight: '700' }}>
              <Ionicons name="lock-closed" size={10} color="#8696a0" /> Clarification Query Marked Resolved by Data Entry. Chat is Closed.
            </Text>
          </View>
        ) : (
          <View style={styles.inputBar}>
            <TouchableOpacity style={styles.iconBtn} onPress={handlePickAttachment}>
              <Ionicons name="paperclip" size={22} color="#8696a0" />
            </TouchableOpacity>

            <TouchableOpacity style={styles.iconBtn} onPress={() => setIsCameraActive(true)}>
              <Ionicons name="camera" size={22} color="#8696a0" />
            </TouchableOpacity>

            <TextInput
              style={styles.textInput}
              placeholder="Type a message..."
              placeholderTextColor="#8696a0"
              value={responseText}
              onChangeText={setResponseText}
              multiline
            />

            <TouchableOpacity
              style={[styles.sendCircleBtn, isSubmitting && { opacity: 0.5 }]}
              onPress={handleSendResponse}
              disabled={isSubmitting}
            >
              <Text style={styles.sendIcon}>{isSubmitting ? '...' : <Ionicons name="send" size={16} color="#fff" />}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Camera capture modal overlay for scanning/attaching photos directly inside chat */}
        <MLKitScannerModal
          visible={isCameraActive}
          onClose={() => setIsCameraActive(false)}
          onPdfGenerated={(pdfName: string, base64Pdf: string) => {
            setIsCameraActive(false);
            setAttachments((prev) => [
              ...prev,
              {
                url: `data:application/pdf;base64,${base64Pdf}`,
                fileName: pdfName,
                fileType: 'application/pdf',
                uploadedBy: 'ASSAYER',
                timestamp: new Date().toISOString(),
              },
            ]);
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
