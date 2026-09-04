import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { useFeedback } from '../components/ui/Feedback';
import { assetToBase64 } from '../utils/pickDocument';
import type { OutboxInput } from '../services/upload-outbox';
import type { AssayerAssignment } from '../types/mobile-app';
import { useT, serverErrorText } from '../i18n';

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
  /** Stage a file the scanner already produced — the scan-then-review counterpart to `selectFile`. */
  stageScannedFile: (name: string, uri: string) => void;
  /** Send what is staged. Resolves true when it arrived. */
  submit: () => Promise<boolean>;
}

/**
 * The audited return: opening an assignment's paperwork, attaching a PDF, and filing it.
 *
 * This is the app's one job of record — the evidence a bank collateral audit actually produces —
 * and it was spread across App.tsx as three pieces of state and five handlers interleaved with
 * navigation, notifications and profile code.
 *
 * Filing no longer *does* the upload here. It hands the packet to the durable outbox, which
 * carries it to the desk in the background and survives the assayer leaving this screen — the
 * transfer used to live in this hook's state and was lost the moment they navigated away. The
 * screen is free to close as soon as the packet is safely written down.
 */
export function useReturnPaperwork(options: { onEnqueue: (input: OutboxInput) => void | Promise<void> }): ReturnPaperwork {
  const { onEnqueue } = options;
  const feedback = useFeedback();
  const tr = useT();

  const [assignment, setAssignment] = useState<AssayerAssignment | null>(null);
  const [staged, setStaged] = useState<StagedPdf | null>(null);
  const [uploading, setUploading] = useState(false);

  /**
   * Which assignment's draft `staged` belongs to, independent of whether the screen is on
   * screen right now. `close()` hides the screen (the in-app back arrow at the top of
   * PdfDocsScreen, and the hardware/gesture back handler in App.tsx both call it) but must not
   * forget a PDF the assayer already attached — this used to be cleared right alongside
   * `assignment` in both `open()` and `close()`, so attaching a PDF, glancing back at Home for
   * anything (the balance, a notification), and reopening "Details" on the very same job found
   * "Nothing captured yet — complete step 1 first", with no warning it had thrown the attachment
   * away. The assayer either re-attached it, having no idea whether the first one had silently
   * gone anywhere, or assumed the job could not be completed.
   *
   * A ref rather than reading `assignment` in `open`'s closure, so `open` keeps one stable
   * identity across renders — it is handed to child screens as a prop (`onOpenAssignment`,
   * `onOpenPdfDocs`) and does not need to change just because state it does not read changed.
   */
  const stagedForRef = useRef<string | null>(null);

  const open = useCallback((a: AssayerAssignment) => {
    // Only a genuinely different assignment clears the draft. Reopening the one already in
    // progress — including after `close()` — must find it exactly as it was left.
    if (stagedForRef.current !== a.id) {
      setStaged(null);
      stagedForRef.current = a.id;
    }
    setAssignment(a);
  }, []);

  const close = useCallback(() => {
    // Deliberately leaves `staged` (and `stagedForRef`) alone — see the comment above. The draft
    // is cleared by `open()` on switching assignments, and by `submit()` once it is safely
    // handed to the outbox.
    setAssignment(null);
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
      feedback.success(tr('paperwork.attachedTitle'), tr('paperwork.attachedBody', { file: name }));
    } catch (err: any) {
      feedback.error(
        tr('paperwork.pickFailedTitle'),
        serverErrorText(err?.message, 'paperwork.pickFailedBody'),
      );
    }
  }, [feedback, tr]);

  /**
   * Stage a file the document scanner just produced, the same way `selectFile` stages one the
   * picker returned — so "Scan pages" and "Attach PDF" leave the Review/Submit steps in the same
   * state instead of only one of them ever unlocking Step 2.
   *
   * Native only: on native the scanner always returns a file `uri` (never base64), matching what
   * `submit()` already expects for `Platform.OS !== 'web'`.
   */
  const stageScannedFile = useCallback((name: string, uri: string) => {
    setStaged({ name, uri });
    feedback.success(tr('paperwork.attachedTitle'), tr('paperwork.attachedBody', { file: name }));
  }, [feedback, tr]);

  const submit = useCallback(async () => {
    if (!assignment) return false;
    if (!staged) {
      feedback.warning(tr('paperwork.nothingToSubmitTitle'), tr('paperwork.nothingToSubmitBody'));
      return false;
    }

    setUploading(true);
    try {
      // Hand the packet to the outbox rather than uploading it here. Native passes the file path
      // so the bytes stream off disk and the transfer is resumable; web has no path, so it passes
      // the decoded content. Either way it is written down durably and sent in the background —
      // the assayer can leave this screen and watch it in Uploads.
      await onEnqueue({
        target: {
          kind: 'ASSIGNMENT_PACKET',
          assignmentId: assignment.id,
          branchName: assignment.branchName,
        },
        fileName: staged.name,
        fileUri: Platform.OS !== 'web' ? staged.uri : undefined,
        base64: Platform.OS === 'web' ? staged.base64 : undefined,
      });
      feedback.success(tr('paperwork.queuedTitle'), tr('paperwork.queuedBody', { file: staged.name }));
      // The draft is spent: it has been handed to the outbox and is now that system's problem
      // (see UploadsModal for its progress). Without this, reopening this same assignment later
      // found the same file still sitting in "Ready to submit" — already sent, but with nothing
      // to say so — inviting a second, redundant submit of a packet the desk already has.
      setStaged(null);
      return true;
    } catch {
      feedback.error(tr('paperwork.queueFailedTitle'), tr('paperwork.queueFailedBody'));
      return false;
    } finally {
      setUploading(false);
    }
  }, [assignment, staged, feedback, onEnqueue, tr]);

  return { assignment, staged, uploading, open, close, selectFile, stageScannedFile, submit };
}
