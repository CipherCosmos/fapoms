import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Modal, Image, TextInput, ScrollView, Platform, ActivityIndicator } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import {
  scanDocument,
  isDocumentScannerAvailable,
  type ScannedPage,
} from '../../modules/document-scanner';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Icon, IconButton, Badge } from './ui/primitives';
import { useFeedback } from './ui/Feedback';
import { assetToBase64 } from '../utils/pickDocument';

export interface ScannedDocument {
  /** Filename the user confirmed, including extension. */
  fileName: string;
  /** `file://` URI of the assembled multi-page PDF, when ML Kit produced one. */
  pdfUri: string | null;
  /** Per-page images, in order. */
  pages: ScannedPage[];
  pageCount: number;
  mimeType: string;
}

export interface DocumentScannerProps {
  visible: boolean;
  onClose: () => void;
  onSaved: (doc: ScannedDocument) => void;
  /** Shown on the save screen so the assayer knows what they are filing. */
  purpose?: string;
}

/**
 * Drive names scans by capture time rather than making the user invent one, which matters
 * when an assayer files several packets at one branch and needs them to sort predictably.
 */
const defaultName = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `Scan_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

/** Reads a scanned artifact off disk. Only used by callers that genuinely need the bytes. */
export async function readAsBase64(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
}

export const DocumentScanner: React.FC<DocumentScannerProps> = ({
  visible,
  onClose,
  onSaved,
  purpose,
}) => {
  const t = useTheme();
  const feedback = useFeedback();
  const [pages, setPages] = useState<ScannedPage[]>([]);
  const [pdfUri, setPdfUri] = useState<string | null>(null);
  const [fileName, setFileName] = useState(defaultName);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);

  /**
   * Guards the auto-launch effect.
   *
   * Without this, any re-render while the scanner is open re-fires the launch and stacks a
   * second Google activity on top of the first.
   */
  const launchedRef = useRef(false);

  const reset = useCallback(() => {
    setPages([]);
    setPdfUri(null);
    setFileName(defaultName());
    setScanning(false);
    setSaving(false);
    launchedRef.current = false;
  }, []);

  const dismiss = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  /**
   * Hands straight over to Google's scanner instead of showing a wrapper screen first.
   *
   * The previous implementation opened a custom modal — header, filter chips, empty state —
   * and launched the native scanner behind it, so the assayer saw two unrelated UIs stitched
   * together. Drive goes from tap to viewfinder with nothing in between.
   */
  const launchScanner = useCallback(async () => {
    setScanning(true);
    try {
      const result = await scanDocument({ resultFormat: 'both', galleryImportAllowed: true });
      if (result.status !== 'success' || result.pages.length === 0) {
        // Backing out of the scanner without capturing closes the whole flow, as it does in
        // Drive — landing the user on an empty review screen would be a dead end.
        if (pages.length === 0) {
          dismiss();
          return;
        }
        return;
      }
      setPages(result.pages);
      setPdfUri(result.pdf?.uri ?? null);
    } catch (err: any) {
      feedback.error('Scanner unavailable', err?.message || 'The document scanner could not be opened.');
      dismiss();
    } finally {
      setScanning(false);
    }
  }, [dismiss, feedback, pages.length]);

  useEffect(() => {
    if (!visible || launchedRef.current) return;
    launchedRef.current = true;

    if (isDocumentScannerAvailable()) {
      launchScanner();
    }
  }, [visible, launchScanner]);

  /** Fallback for iOS/web/Expo Go, where the ML Kit scanner does not exist. */
  const pickFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'application/pdf'],
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (result.canceled || !result.assets?.length) return;

      const picked = result.assets.map((a, i) => ({ uri: a.uri, pageNumber: pages.length + i + 1 }));
      const pdf = result.assets.find((a) => a.mimeType === 'application/pdf');
      setPages((prev) => [...prev, ...picked]);
      if (pdf) setPdfUri(pdf.uri);
      if (result.assets[0]?.name) setFileName(result.assets[0].name.replace(/\.[^.]+$/, ''));
    } catch (err: any) {
      feedback.error('Could not open files', err?.message || 'File selection failed.');
    }
  }, [feedback, pages.length]);

  const save = useCallback(() => {
    const trimmed = fileName.trim();
    if (!trimmed) {
      feedback.warning('Name required', 'Give the document a name before saving.');
      return;
    }
    if (pages.length === 0) return;

    setSaving(true);
    /**
     * Prefers the single PDF and only falls back to images when ML Kit did not produce one.
     *
     * The mime type is whatever the artifact actually is. The old flow relabelled JPEG bytes
     * as `application/pdf`, which put unopenable files into the audit record.
     */
    const hasPdf = Boolean(pdfUri);
    onSaved({
      fileName: hasPdf ? `${trimmed}.pdf` : `${trimmed}.jpg`,
      pdfUri,
      pages,
      pageCount: pages.length,
      mimeType: hasPdf ? 'application/pdf' : 'image/jpeg',
    });
    reset();
  }, [feedback, fileName, onSaved, pages, pdfUri, reset]);

  if (!visible) return null;

  const unavailable = !isDocumentScannerAvailable();
  const hasScan = pages.length > 0;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={dismiss}>
      <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
        {/* Header */}
        <View
          style={{
            paddingTop: Platform.OS === 'ios' ? 56 : 24,
            paddingHorizontal: t.space.lg,
            paddingBottom: t.space.md,
            flexDirection: 'row',
            alignItems: 'center',
            gap: t.space.sm,
            backgroundColor: t.colors.surface,
            borderBottomWidth: 1,
            borderColor: t.colors.border,
          }}
        >
          <IconButton icon="close" onPress={dismiss} accessibilityLabel="Close scanner" />
          <View style={{ flex: 1 }}>
            <AppText variant="h3">{hasScan ? 'Save document' : 'Scan document'}</AppText>
            {purpose ? (
              <AppText variant="caption" tone="muted" style={{ marginTop: 2 }}>
                {purpose}
              </AppText>
            ) : null}
          </View>
          {hasScan ? <Badge label={`${pages.length} page${pages.length === 1 ? '' : 's'}`} tone="primary" /> : null}
        </View>

        {scanning ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: t.space.md }}>
            <ActivityIndicator size="large" color={t.colors.primary} />
            <AppText variant="body" tone="muted">
              Opening scanner…
            </AppText>
          </View>
        ) : hasScan ? (
          <ScrollView contentContainerStyle={{ padding: t.space.lg, gap: t.space.lg }}>
            {/* File name — Drive lets you rename before the document is filed. */}
            <View style={{ gap: t.space.xs }}>
              <AppText variant="caption" tone="muted">
                FILE NAME
              </AppText>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: t.space.sm,
                  backgroundColor: t.colors.surface,
                  borderWidth: 1,
                  borderColor: t.colors.border,
                  borderRadius: t.radius.md,
                  paddingHorizontal: t.space.md,
                }}
              >
                <Icon name="document-text-outline" size={18} color={t.colors.textMuted} />
                <TextInput
                  value={fileName}
                  onChangeText={setFileName}
                  selectTextOnFocus
                  placeholder="Document name"
                  placeholderTextColor={t.colors.textMuted}
                  style={{ flex: 1, paddingVertical: t.space.md, color: t.colors.text, fontSize: 15 }}
                />
                <AppText variant="caption" tone="muted">
                  {pdfUri ? '.pdf' : '.jpg'}
                </AppText>
              </View>
            </View>

            {/* Page previews */}
            <View style={{ gap: t.space.sm }}>
              <AppText variant="caption" tone="muted">
                PAGES
              </AppText>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.md }}>
                {pages.map((page) => (
                  <View
                    key={page.uri}
                    style={{
                      width: '30%',
                      aspectRatio: 0.72,
                      borderRadius: t.radius.md,
                      overflow: 'hidden',
                      borderWidth: 1,
                      borderColor: t.colors.border,
                      backgroundColor: t.colors.surfaceAlt,
                    }}
                  >
                    <Image source={{ uri: page.uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                    <View
                      style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        paddingVertical: 3,
                        alignItems: 'center',
                        backgroundColor: 'rgba(0,0,0,0.6)',
                      }}
                    >
                      <AppText variant="caption" style={{ color: '#fff' }}>
                        {page.pageNumber}
                      </AppText>
                    </View>
                  </View>
                ))}
              </View>
              <AppText variant="caption" tone="muted">
                {pdfUri
                  ? 'Saved as a single PDF. Reorder, crop, rotate and filter pages from the scanner screen.'
                  : 'Pages will be saved as images.'}
              </AppText>
            </View>
          </ScrollView>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.space.xl, gap: t.space.md }}>
            <Icon name="scan-outline" size={48} color={t.colors.textMuted} />
            <AppText variant="h3" style={{ textAlign: 'center' }}>
              {unavailable ? 'Scanner not available here' : 'Ready to scan'}
            </AppText>
            <AppText variant="body" tone="muted" style={{ textAlign: 'center' }}>
              {unavailable
                ? 'On-device document scanning needs the Android app. Attach an existing file instead.'
                : 'Position the document in the frame. Edges are detected automatically.'}
            </AppText>
          </View>
        )}

        {/* Footer */}
        {!scanning && (
          <View
            style={{
              padding: t.space.lg,
              gap: t.space.md,
              backgroundColor: t.colors.surface,
              borderTopWidth: 1,
              borderColor: t.colors.border,
            }}
          >
            <View style={{ flexDirection: 'row', gap: t.space.md }}>
              {!unavailable && (
                <Button
                  label={hasScan ? 'Rescan' : 'Open scanner'}
                  icon="camera"
                  variant={hasScan ? 'neutral' : undefined}
                  onPress={launchScanner}
                  disabled={saving}
                  style={{ flex: 1 }}
                />
              )}
              <Button
                label="Attach file"
                icon="document-attach"
                variant="neutral"
                onPress={pickFile}
                disabled={saving}
                style={{ flex: 1 }}
              />
            </View>

            {hasScan && (
              <Button
                label={`Save ${pages.length} page${pages.length === 1 ? '' : 's'}`}
                icon="checkmark"
                variant="accent"
                onPress={save}
                loading={saving}
                disabled={saving}
                full
              />
            )}
          </View>
        )}
      </View>
    </Modal>
  );
};
