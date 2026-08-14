import { useCallback, useState } from 'react';
import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { MobileApiService } from '../services/api.service';
import { useFeedback } from '../components/ui/Feedback';
import { assetToBase64 } from '../utils/pickDocument';
import type { AssayerAssignment } from '../types/mobile-app';

/**
 * A completed audit packet waiting to be submitted.
 *
 * Native stages a file path so the bytes never enter JS memory; web has no path to stage and
 * keeps the decoded content instead.
 */
export type StagedPdf = { name: string; uri?: string; base64?: string };

export interface ReturnPaperwork {
  /** The assignment whose paperwork is open, or null when no detail view is showing. */
  assignment: AssayerAssignment | null;
  staged: StagedPdf | null;
  uploading: boolean;
  open: (assignment: AssayerAssignment) => void;
  close: () => void;
  /** Choose a PDF already on the device. */
  selectFile: () => Promise<void>;
  /** Send what is staged. Resolves true when it arrived. */
  submit: () => Promise<boolean>;
}

/**
 * The audited return: opening an assignment's paperwork, attaching a PDF, and filing it.
 *
 * This is the app's one job of record — the evidence a bank collateral audit actually produces —
 * and it was spread across App.tsx as three pieces of state and five handlers interleaved with
 * navigation, notifications and profile code.
 */
export function useReturnPaperwork(options: { onSubmitted: () => void | Promise<void> }): ReturnPaperwork {
  const { onSubmitted } = options;
  const feedback = useFeedback();

  const [assignment, setAssignment] = useState<AssayerAssignment | null>(null);
  const [staged, setStaged] = useState<StagedPdf | null>(null);
  const [uploading, setUploading] = useState(false);

  const open = useCallback((a: AssayerAssignment) => {
    setAssignment(a);
    setStaged(null);
  }, []);

  const close = useCallback(() => {
    setAssignment(null);
    setStaged(null);
    setUploading(false);
  }, []);

  /**
   * Stage the picked file by reference, not by value.
   *
   * This used to read the whole PDF into a base64 string, hold that string in React state, and
   * hand it to the uploader — which then wrote it back out to a temp file so it could stream it.
   * A completed audit packet is scanned pages, routinely tens of megabytes, so that was a ~1.33x
   * copy of the entire file living in JS memory for as long as the screen was open, on handsets
   * that do not have it to spare. The uploader has taken a `uri` and streamed it straight off
   * disk all along; nothing was passing one.
   *
   * Web has no file path to reference, so it still stages base64 — there the picker has already
   * decoded the file into a data: URL anyway.
   */
  const selectFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const name = asset.name || 'audit_packet.pdf';
      setStaged(
        Platform.OS === 'web'
          ? { name, base64: await assetToBase64(asset) }
          : { name, uri: asset.uri },
      );
      feedback.success('PDF attached', `${name} is ready to submit.`);
    } catch (err: any) {
      feedback.error('File Picker Error', err?.message || 'Failed to select a PDF file.');
    }
  }, [feedback]);

  const submit = useCallback(async () => {
    if (!assignment) return false;
    if (!staged) {
      feedback.warning('Nothing to submit', 'Attach a PDF or scan the pages first.');
      return false;
    }

    setUploading(true);
    try {
      // A picked file gets the same resumable transfer the scanner does. It is the same operation
      // over the same field connections, and there was no reason for one of them to have to start
      // over from zero when the signal dropped. Resumable needs a real file path, so web keeps
      // the single-shot path (which retries on its own).
      const res =
        staged.uri && Platform.OS !== 'web'
          ? await MobileApiService.uploadAuditPdfResumable(
              assignment.id,
              staged.name,
              staged.uri,
              assignment.id,
            )
          : await MobileApiService.uploadCompletedAuditPdf(
              assignment.id,
              staged.name,
              { uri: staged.uri, base64: staged.base64 },
              assignment.id,
            );

      if (!res?.success) {
        feedback.error('Upload Failed', res?.error || 'The document could not be uploaded.');
        return false;
      }

      feedback.success('Upload Complete', `${staged.name} was uploaded successfully.`);
      await onSubmitted();
      return true;
    } catch {
      feedback.error('Upload Failed', 'The document could not be uploaded. Please try again.');
      return false;
    } finally {
      setUploading(false);
    }
  }, [assignment, staged, feedback, onSubmitted]);

  return { assignment, staged, uploading, open, close, selectFile, submit };
}
