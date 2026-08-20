import { readCache, writeCache } from './token-store';

/**
 * The on-device outbox of completed audit packets waiting to reach the desk.
 *
 * The resumable uploader is good — it chunks, asks the server which chunks survived, and resends
 * only the gaps — but the transfer lived entirely in component state, and the screen told the
 * assayer "Stay on this screen." A branch packet is a multi-megabyte scan sent over rural mobile
 * data at the end of a visit, so an assayer who backed out, switched apps, or lost the app to the
 * OS lost the upload with no record it had ever failed. They drove away believing the branch was
 * filed.
 *
 * This is the same durable-queue idea as `location-queue.ts`: write the intent to disk first, do
 * the transfer later, and survive the app being killed at the worst possible moment. A packet is
 * written down the instant it is captured, and it keeps its place in the list — Sending / Failed /
 * Sent — until it has actually arrived, so a failed upload is something the assayer can SEE and
 * retry rather than a silent loss.
 *
 * The bytes are not copied in here. Only a *reference* to the file on disk is persisted (the
 * scanner and the file picker both already stage the packet in the cache directory), so the outbox
 * stays tiny even when the packet it points at is tens of megabytes. On web — the Expo preview,
 * not the field — there is no file path, so the decoded base64 is kept instead.
 */

export type OutboxStatus =
  /** Written down, not yet attempted (or explicitly re-queued by a Retry). */
  | 'PENDING'
  /** A transfer is in flight right now. */
  | 'SENDING'
  /** The desk has durably accepted the packet. */
  | 'SENT'
  /** The last attempt did not arrive. Kept so the assayer can retry it. */
  | 'FAILED';

export interface OutboxUpload {
  id: string;
  /** The assignment/assessment the packet belongs to — passed straight to the uploader. */
  assignmentId: string;
  /** For display, so the list reads in the assayer's own terms ("Kollam Main Branch"). */
  branchName: string;
  fileName: string;
  /** Native file path. The packet streams off disk from here; survives an app restart. */
  fileUri?: string;
  /** Web-only fallback: the decoded packet, since a browser has no file path to reference. */
  base64?: string;
  status: OutboxStatus;
  /** 0..100. Best-effort, driven by the uploader; resets across a restart, which is harmless
   *  because the server works out what actually survived on the next attempt. */
  progress: number;
  /** Why the last attempt failed, shown to the assayer verbatim. */
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** What a caller hands in to file a packet. The bookkeeping fields are filled in here. */
export interface OutboxInput {
  assignmentId: string;
  branchName: string;
  fileName: string;
  fileUri?: string;
  base64?: string;
}

const OUTBOX_KEY = 'upload_outbox';

/**
 * How many delivered packets to keep for reassurance before pruning. A working day is a handful
 * of branches, so this comfortably covers "did today's uploads all go?" while stopping the list
 * growing without bound on a handset that is never signed out. Non-delivered packets are never
 * pruned — losing one is the exact failure this exists to prevent.
 */
const MAX_KEEP_SENT = 15;

/** In-memory source of truth for the session; `null` until first loaded from storage. */
let buffer: OutboxUpload[] | null = null;
/** UI subscribers (the outbox hook). Notified on every change so the list re-renders live. */
const listeners = new Set<() => void>();
/** Guards against two overlapping drains — a foreground return and a manual retry can race. */
let processing = false;

async function load(): Promise<OutboxUpload[]> {
  if (buffer) return buffer;
  buffer = (await readCache<OutboxUpload[]>(OUTBOX_KEY)) ?? [];
  return buffer;
}

function emit(): void {
  listeners.forEach((notify) => {
    try {
      notify();
    } catch {
      /* a bad listener must never break persistence */
    }
  });
}

async function persist(): Promise<void> {
  if (buffer) await writeCache(OUTBOX_KEY, buffer);
  emit();
}

/** Trim delivered packets past the retention cap, oldest first. Never touches live uploads. */
function pruneSent(list: OutboxUpload[]): void {
  const sent = list.filter((u) => u.status === 'SENT');
  if (sent.length <= MAX_KEEP_SENT) return;
  const drop = new Set(
    sent
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, sent.length - MAX_KEEP_SENT)
      .map((u) => u.id),
  );
  for (let i = list.length - 1; i >= 0; i--) {
    if (drop.has(list[i].id)) list.splice(i, 1);
  }
}

/**
 * Subscribe to outbox changes. Returns an unsubscribe function.
 *
 * Kept module-level (not React state) for the same reason the location queue is: the outbox
 * outlives any one screen, and the upload keeps running when nothing is mounted to watch it.
 */
export function subscribeOutbox(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** A snapshot of the outbox, newest last. */
export async function getUploads(): Promise<OutboxUpload[]> {
  return [...(await load())];
}

/** Put a packet in the outbox. It starts PENDING; call `processOutbox` to send it. */
export async function enqueueUpload(input: OutboxInput): Promise<OutboxUpload> {
  const list = await load();
  const now = new Date().toISOString();
  const entry: OutboxUpload = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    assignmentId: input.assignmentId,
    branchName: input.branchName,
    fileName: input.fileName,
    fileUri: input.fileUri,
    base64: input.base64,
    status: 'PENDING',
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };
  list.push(entry);
  pruneSent(list);
  await persist();
  return entry;
}

/** Apply a change to one entry. `save` controls whether it is written to disk (vs. UI-only). */
async function mutate(id: string, changes: Partial<OutboxUpload>, save: boolean): Promise<void> {
  const list = await load();
  const entry = list.find((u) => u.id === id);
  if (!entry) return;
  Object.assign(entry, changes, { updatedAt: new Date().toISOString() });
  if (save) await persist();
  else emit();
}

/**
 * Re-queue a failed (or stuck) packet for another attempt.
 *
 * Flipping it back to PENDING is what a Retry means; the caller then runs `processOutbox`. The
 * transfer itself is resumable, so a retry resends only the parts that never arrived rather than
 * starting the whole packet again.
 */
export async function retryUpload(id: string): Promise<void> {
  await mutate(id, { status: 'PENDING', error: undefined }, true);
}

/** Remove an entry — a delivered one the assayer is clearing, or one they choose to abandon. */
export async function dismissUpload(id: string): Promise<void> {
  const list = await load();
  const i = list.findIndex((u) => u.id === id);
  if (i === -1) return;
  list.splice(i, 1);
  await persist();
}

/**
 * Send everything that is waiting, and keep whatever did not go.
 *
 * `upload` returns `{ success: true }` only when the desk has durably accepted the packet;
 * anything else leaves it FAILED and in the list for a retry. Both PENDING (never tried) and
 * FAILED (tried and dropped) are attempted, so a packet left failed on a bad connection is
 * resent on its own the next time the app comes forward or reconnects — the assayer does not
 * have to remember to press anything.
 *
 * Guarded against re-entry: a foreground return, a reconnect and a manual retry can all fire at
 * once, and two concurrent drains would upload the same packet twice.
 */
export async function processOutbox(
  upload: (
    entry: OutboxUpload,
    onProgress: (percent: number) => void,
  ) => Promise<{ success: boolean; error?: string }>,
  opts: { onSent?: (entry: OutboxUpload) => void } = {},
): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    const initial = await load();
    // Snapshot the ids to work through, so packets enqueued mid-drain wait for the next pass
    // rather than extending this one indefinitely.
    const todo = initial.filter((u) => u.status === 'PENDING' || u.status === 'FAILED').map((u) => u.id);

    for (const id of todo) {
      const entry = (await load()).find((u) => u.id === id);
      // It may have been dismissed, sent by a previous pass, or already in flight — re-read
      // rather than trusting the snapshot.
      if (!entry || (entry.status !== 'PENDING' && entry.status !== 'FAILED')) continue;

      await mutate(id, { status: 'SENDING', error: undefined, progress: 0 }, true);

      let result: { success: boolean; error?: string };
      try {
        // Progress ticks update the UI but are not written to disk — persisting on every chunk
        // would rewrite the whole file dozens of times per packet, the exact cost the location
        // queue's debounce exists to avoid.
        result = await upload(entry, (percent) => {
          void mutate(id, { progress: Math.max(0, Math.min(100, Math.round(percent))) }, false);
        });
      } catch (err: any) {
        result = { success: false, error: err?.message || 'The upload could not be completed.' };
      }

      if (result.success) {
        await mutate(id, { status: 'SENT', progress: 100, error: undefined }, true);
        const done = (await load()).find((u) => u.id === id);
        if (done) opts.onSent?.(done);
      } else {
        await mutate(id, { status: 'FAILED', error: result.error || 'Upload failed' }, true);
      }
    }
  } finally {
    processing = false;
  }
}

/**
 * Drop everything on sign-out — one assayer's packet must never be uploaded under another's
 * session on a shared handset, the same rule the location queue and cache follow.
 */
export async function clearOutbox(): Promise<void> {
  buffer = [];
  await persist();
}

/** Test seam: forget the in-memory buffer and any in-flight guard so the next call re-reads storage. */
export function __resetOutboxForTests(): void {
  buffer = null;
  processing = false;
  listeners.clear();
}
