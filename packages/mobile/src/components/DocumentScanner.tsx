import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Modal, Platform, ActivityIndicator, Linking } from 'react-native';
import * as FileSystem from 'expo-file-system';
import {
  scanDocument,
  isDocumentScannerAvailable,
  type ScannedPage,
} from '../../modules/document-scanner';
import { scanPlanFor, scanFileName } from './document-scan-options';
import { captureWith, chooseFiles, isCameraAvailable, type CaptureOutcome } from './document-capture';
import { hintKeyFor } from '../services/registration-checklist';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Button, Icon, IconButton } from './ui/primitives';
import { useFeedback } from './ui/Feedback';
import { useT, serverErrorText } from '../i18n';

export interface ScannedDocument {
  /** Filename including extension — the document's own name (`scanFileName`), never typed. */
  fileName: string;
  /** `file://` URI of the assembled multi-page PDF, when ML Kit produced one (or a PDF was chosen). */
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
  /** What is being filed — names the file, and heads the fallback screen. */
  purpose?: string;
  /**
   * WHICH document this is (`OnboardingDocument`), so the phone scans it the way the browser does:
   * a card is capped at its one side, a form is left open-ended, and the sentence telling somebody
   * what to do with the paper is this document's own. One table behind both — `scanProfileFor` in
   * `@fapoms/shared`. Absent for scans that answer to no requirement, such as an audit packet.
   */
  requirement?: string | null;
}

/** Reads a scanned artifact off disk. Only used by callers that genuinely need the bytes. */
export async function readAsBase64(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
}

/**
 * Tap → Google's scanner → filed. Nothing in between.
 *
 * There used to be a "Save document" screen after every scan, with a file-name box and a "Save 1
 * page" button. Nobody filling in a form has a better name for their PAN card than "PAN card", and
 * the extra screen was one more place to get lost. The file is named by `scanFileName` — the
 * document's own label, the same naming the browser uses — and handed over as soon as ML Kit
 * returns. Cropping, rotating and re-taking all happen inside Google's own editor before that.
 *
 * Where ML Kit is not available (iOS, or a phone without it) a small screen offers the phone camera
 * and the file picker instead.
 */
export const DocumentScanner: React.FC<DocumentScannerProps> = ({
  visible,
  onClose,
  onSaved,
  purpose,
  requirement,
}) => {
  const t = useTheme();
  const tr = useT();
  const feedback = useFeedback();
  const plan = scanPlanFor(requirement);
  const hint = requirement ? hintKeyFor(requirement) : null;
  const scannerAvailable = isDocumentScannerAvailable();
  const cameraAvailable = isCameraAvailable();
  const [scanning, setScanning] = useState(false);
  const [cameraDenied, setCameraDenied] = useState(false);

  /**
   * Guards the auto-launch effect. Without this, any re-render while the scanner is open re-fires
   * the launch and stacks a second Google activity on top of the first.
   */
  const launchedRef = useRef(false);

  const dismiss = useCallback(() => {
    launchedRef.current = false;
    setScanning(false);
    setCameraDenied(false);
    onClose();
  }, [onClose]);

  const deliver = useCallback((doc: ScannedDocument) => {
    launchedRef.current = false;
    onSaved(doc);
  }, [onSaved]);

  const launchScanner = useCallback(async () => {
    setScanning(true);
    try {
      const result = await scanDocument(plan.options);
      if (result.status !== 'success' || result.pages.length === 0) {
        // Backing out of Google's scanner closes the whole flow, as it does in Drive.
        dismiss();
        return;
      }
      const pdfUri = result.pdf?.uri ?? null;
      deliver({
        fileName: scanFileName(purpose, pdfUri ? 'pdf' : 'jpg', new Date()),
        pdfUri,
        pages: result.pages,
        pageCount: result.pages.length,
        // The type is what the file actually is; relabelled JPEG bytes as PDF were unopenable.
        mimeType: pdfUri ? 'application/pdf' : 'image/jpeg',
      });
    } catch (err: any) {
      feedback.error(tr('scanner.unavailableTitle'), serverErrorText(err?.message, 'scanner.unavailableBody'));
      dismiss();
    } finally {
      setScanning(false);
    }
  }, [deliver, dismiss, feedback, plan.options, purpose, tr]);

  useEffect(() => {
    if (!visible || launchedRef.current) return;
    launchedRef.current = true;
    if (scannerAvailable) void launchScanner();
  }, [visible, launchScanner, scannerAvailable]);

  /** The camera or file picker's answer, turned into the same shape a scan hands over. */
  const take = useCallback((outcome: CaptureOutcome) => {
    if (outcome.status === 'cameraDenied') {
      setCameraDenied(true);
      return;
    }
    if (outcome.status === 'refused') {
      feedback.warning(tr('scanner.tooBigTitle'), outcome.message);
      return;
    }
    if (outcome.status === 'failed') {
      feedback.error(tr('scanner.pickFailedTitle'), serverErrorText(outcome.message, 'scanner.pickFailedBody'));
      return;
    }
    if (outcome.status !== 'captured') return;
    const pdf = outcome.files.find((f) => f.mimeType === 'application/pdf');
    const first = pdf ?? outcome.files[0];
    deliver({
      fileName: first.name,
      pdfUri: pdf?.uri ?? null,
      pages: outcome.files.map((f, i) => ({ uri: f.uri, pageNumber: i + 1 })),
      pageCount: outcome.files.length,
      mimeType: first.mimeType,
    });
  }, [deliver, feedback, tr]);

  const label = purpose ?? '';
  const takePhoto = async () => take(await captureWith('camera', requirement ?? '', label));
  // Several files only where a document has pages; an audit packet (no requirement) may have many.
  const pickFile = async () => take(await chooseFiles(label, { multiple: requirement ? plan.profile.multiPage : true, imagesOnly: false }));

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={dismiss}>
      <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
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
          <IconButton icon="close" onPress={dismiss} accessibilityLabel={tr('scanner.close')} />
          <View style={{ flex: 1 }}>
            <AppText variant="h3">{purpose || tr('scanner.scanTitle')}</AppText>
            {hint ? (
              <AppText variant="caption" tone="muted" style={{ marginTop: 2 }}>{tr(hint)}</AppText>
            ) : null}
          </View>
        </View>

        {scanning ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: t.space.md }}>
            <ActivityIndicator size="large" color={t.colors.primary} />
            <AppText variant="body" tone="muted">{tr('scanner.opening')}</AppText>
          </View>
        ) : (
          <View style={{ flex: 1, justifyContent: 'center', padding: t.space.xl, gap: t.space.lg }}>
            <View style={{ alignItems: 'center', gap: t.space.md }}>
              <Icon name="camera-outline" size={48} color={t.colors.textMuted} />
              <AppText variant="body" tone="muted" style={{ textAlign: 'center' }}>
                {tr('scanner.cameraBody')}
              </AppText>
            </View>
            {cameraAvailable && (
              <Button label={tr('scanner.takePhoto')} icon="camera" size="lg" onPress={() => { void takePhoto(); }} full />
            )}
            {cameraDenied && (
              <View style={{ gap: t.space.sm, alignItems: 'center' }}>
                <AppText variant="small" tone="danger" style={{ textAlign: 'center' }}>{tr('scanner.cameraDenied')}</AppText>
                <Button label={tr('scanner.openSettings')} variant="neutral" size="sm" onPress={() => { void Linking.openSettings(); }} />
              </View>
            )}
            <Button
              label={cameraAvailable ? tr('scanner.orChooseFile') : tr('scanner.chooseFile')}
              icon="document-attach-outline"
              variant={cameraAvailable ? 'ghost' : undefined}
              size={cameraAvailable ? 'md' : 'lg'}
              onPress={() => { void pickFile(); }}
              full
            />
          </View>
        )}
      </View>
    </Modal>
  );
};
