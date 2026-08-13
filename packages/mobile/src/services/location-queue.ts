import { readCache, writeCache } from './token-store';

/**
 * The on-device queue of position fixes waiting to reach the server.
 *
 * Without this, the movement trail is only ever as good as the signal — and the places this app is
 * used are precisely the places without any. An assayer driving through rural Kerala and into a
 * bank strongroom produces the most important part of a journey exactly where the handset cannot
 * report it, so a fire-and-forget push loses it permanently. Every lost stretch shows up later as
 * unobserved time, and unobserved time is what stops the platform being able to confirm an honest
 * assayer's travel claim.
 *
 * So fixes are written down first and sent later. The queue lives in memory during a session and
 * is persisted behind a short debounce; see `schedulePersist` for why it is not written on every
 * append. Nothing here decides anything about a journey — it only makes sure the evidence survives
 * the trip home.
 */

export interface QueuedFix {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
  speedMps?: number | null;
  /** Device clock at the moment of the fix. The server dedupes on (assayer, recordedAt). */
  recordedAt: string;
  assignmentId?: string | null;
  isMocked?: boolean;
}

const QUEUE_KEY = 'location_queue';

/**
 * Roughly sixteen hours of 30-second fixes. Past this the oldest are dropped: a trail from days
 * ago is worth far less than the drive happening now, and an unbounded queue on a cheap handset is
 * a way to fill its storage.
 */
const MAX_QUEUED = 2_000;

/** The server refuses batches larger than this, so drain in slices that match. */
const MAX_BATCH = 1000;

/**
 * How long an append may sit in memory before it is written to disk.
 *
 * Persisting on *every* append is what this replaced, and it was quietly expensive: the storage
 * layer rewrites its whole JSON file per call, so each 30-second fix re-serialised the entire
 * backlog — O(n) work and a full file write, on the cheapest handsets, all day. Coalescing means
 * an app killed at the worst possible moment loses at most the last couple of seconds of fixes
 * (one, in practice), which is a far better trade than the battery and flash wear.
 */
const PERSIST_DEBOUNCE_MS = 2_000;

/** In-memory source of truth for the session; `null` until first loaded from storage. */
let buffer: QueuedFix[] | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

async function load(): Promise<QueuedFix[]> {
  if (buffer) return buffer;
  buffer = (await readCache<QueuedFix[]>(QUEUE_KEY)) ?? [];
  return buffer;
}

async function persistNow(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (buffer) await writeCache(QUEUE_KEY, buffer);
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, PERSIST_DEBOUNCE_MS);
  // Never hold the app open just to write a cache file.
  (persistTimer as any)?.unref?.();
}

export async function queueFix(fix: QueuedFix): Promise<void> {
  const queue = await load();
  queue.push(fix);
  // Trim from the front: the newest fixes are the ones a current journey depends on.
  if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED);
  schedulePersist();
}

export async function queuedCount(): Promise<number> {
  return (await load()).length;
}

/**
 * Send what is queued, oldest first, and keep whatever did not go.
 *
 * `upload` returns true only when the server has durably accepted the slice. Anything else — no
 * signal, a 500, an expired token — leaves the queue untouched so the fixes are retried rather
 * than silently dropped. Re-sending a slice the server already stored is safe and expected: it
 * dedupes on (assayer, recordedAt), which is what allows this to retry without inflating any
 * distance derived from the trail.
 *
 * Guarded against re-entry, because both a timer and a reconnect can call it at once and two
 * concurrent drains would send the same fixes twice.
 */
export async function flushQueue(
  upload: (batch: QueuedFix[]) => Promise<boolean>,
): Promise<{ sent: number; remaining: number }> {
  const queue = await load();
  if (flushing) return { sent: 0, remaining: queue.length };
  flushing = true;
  try {
    let sent = 0;
    /**
     * Only drain what was already waiting when this flush began.
     *
     * The device keeps taking fixes while an upload is in flight, so a loop that simply ran until
     * the queue was empty would never finish whenever fixes arrive as fast as batches leave — it
     * would hold the flush lock forever and grow without bound. Whatever is queued during this
     * pass is picked up by the next one, which the reconnect handler and each new fix already
     * trigger.
     */
    let budget = queue.length;
    while (queue.length > 0 && budget > 0) {
      const batch = queue.slice(0, Math.min(MAX_BATCH, budget));
      const ok = await upload(batch);
      if (!ok) break;

      // Remove exactly what was accepted. Splicing the live array rather than writing back a
      // remainder captured earlier is what keeps a fix queued mid-upload from being discarded.
      queue.splice(0, batch.length);
      sent += batch.length;
      budget -= batch.length;
      await persistNow();
    }
    return { sent, remaining: queue.length };
  } finally {
    flushing = false;
  }
}

/** Dropped on sign-out — one assayer's movements must never be uploaded under another's session. */
export async function clearQueue(): Promise<void> {
  buffer = [];
  await persistNow();
}

/**
 * Write the queue out immediately.
 *
 * For the app-backgrounding path: the debounce above is a small window, but it is a window, and
 * the OS suspending the process is exactly when it would be open.
 */
export async function persistQueue(): Promise<void> {
  await persistNow();
}

/** Test seam: forget the in-memory buffer so the next call re-reads storage. */
export function __resetQueueForTests(): void {
  buffer = null;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  flushing = false;
}
