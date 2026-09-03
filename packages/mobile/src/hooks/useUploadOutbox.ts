import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import { MobileApiService } from '../services/api.service';
import {
  OutboxInput,
  OutboxUpload,
  dismissUpload,
  enqueueUpload,
  getUploads,
  processOutbox,
  retryUpload,
  subscribeOutbox,
} from '../services/upload-outbox';

export interface UploadOutbox {
  uploads: OutboxUpload[];
  /** How many packets are still trying (PENDING or SENDING) and how many have failed. */
  counts: { active: number; failed: number; sent: number };
  /** File a packet and start sending it in the background. */
  enqueue: (input: OutboxInput) => Promise<void>;
  /** Re-queue a failed packet and try it again now. */
  retry: (id: string) => Promise<void>;
  /** Remove a packet from the list (a delivered one, or one being abandoned). */
  dismiss: (id: string) => Promise<void>;
  /** Nudge the outbox to drain — safe to call often, it no-ops when idle. */
  process: () => void;
}

/**
 * Turn one outbox entry into an actual transfer.
 *
 * The destination decides the endpoint. An audit packet goes to the assignment's document store;
 * a registration scan goes onto the person's own HR record. They share this queue because they
 * share the problem it solves — a big file, captured in the field, on a connection that may not
 * be there — and nothing about durability, retry or "the assayer can see it failed" differs
 * between them.
 *
 * Native streams the packet off disk with the resumable uploader — the one that asks the server
 * which chunks survived and resends only the gaps. Web has no file path to stream, so it keeps
 * the single-shot path (which retries the whole file on its own).
 */
async function sendOne(
  entry: OutboxUpload,
  onProgress: (percent: number) => void,
): Promise<{ success: boolean; error?: string }> {
  if (entry.target.kind === 'REGISTRATION_DOCUMENT') {
    // Not chunked. These are single photographs of a card or a signed form — a few hundred
    // kilobytes against an audit packet's tens of megabytes — so the session handshake the
    // resumable uploader needs would cost more round trips than the file itself. A failure
    // re-sends the whole thing, which at this size is what a retry means anyway.
    onProgress(10);
    const res = await MobileApiService.uploadRegistrationDocument(entry.target.requirement, {
      uri: entry.fileUri,
      name: entry.fileName,
    });
    if (res.success) onProgress(100);
    return res;
  }

  const { assignmentId } = entry.target;
  if (entry.fileUri && Platform.OS !== 'web') {
    const res = await MobileApiService.uploadAuditPdfResumable(
      assignmentId,
      entry.fileName,
      entry.fileUri,
      assignmentId,
      onProgress,
    );
    return { success: !!res?.success, error: res?.error };
  }
  const res = await MobileApiService.uploadCompletedAuditPdf(
    assignmentId,
    entry.fileName,
    { uri: entry.fileUri, base64: entry.base64 },
    assignmentId,
  );
  return { success: !!res?.success, error: res?.error };
}

/**
 * The persistent upload outbox, as a hook.
 *
 * Delivery lives in `services/upload-outbox.ts`, which survives navigation and app restarts; this
 * exposes the current list to the UI and keeps the outbox draining — on mount, whenever the app
 * comes back to the foreground, and whenever a packet is enqueued or retried. `onUploaded` fires
 * once a packet is durably accepted, so the caller can refresh the assignment (filing the return
 * moves the job on server-side).
 */
export function useUploadOutbox(opts: { onUploaded?: () => void } = {}): UploadOutbox {
  const { onUploaded } = opts;
  const [uploads, setUploads] = useState<OutboxUpload[]>([]);

  const refresh = useCallback(() => {
    void getUploads().then(setUploads);
  }, []);

  useEffect(() => {
    const unsub = subscribeOutbox(refresh);
    refresh();
    return unsub;
  }, [refresh]);

  const process = useCallback(() => {
    void processOutbox(sendOne, { onSent: () => onUploaded?.() });
  }, [onUploaded]);

  const enqueue = useCallback(
    async (input: OutboxInput) => {
      await enqueueUpload(input);
      process();
    },
    [process],
  );

  const retry = useCallback(
    async (id: string) => {
      await retryUpload(id);
      process();
    },
    [process],
  );

  const dismiss = useCallback(async (id: string) => {
    await dismissUpload(id);
  }, []);

  // Drain on mount, and again every time the app returns to the foreground — the moment a phone
  // that spent a branch visit without signal is most likely to have some again.
  useEffect(() => {
    process();
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') process();
    });
    return () => sub.remove();
  }, [process]);

  const counts = useMemo(() => {
    let active = 0;
    let failed = 0;
    let sent = 0;
    for (const u of uploads) {
      if (u.status === 'PENDING' || u.status === 'SENDING') active++;
      else if (u.status === 'FAILED') failed++;
      else if (u.status === 'SENT') sent++;
    }
    return { active, failed, sent };
  }, [uploads]);

  return { uploads, counts, enqueue, retry, dismiss, process };
}
