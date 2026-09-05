import { readCache, writeCache } from './token-store';

/**
 * The on-device queue for one-shot field actions: check-in, check-out, offer accept/reject,
 * an expense claim, a clarification reply.
 *
 * These used to be a bare `await fetch(...)`, shown or lost on the spot. `upload-outbox.ts` and
 * `location-queue.ts` already solved this shape of problem — write the intent to disk before
 * attempting it, so an app killed mid-request (a bad handover in a strongroom, the OS reclaiming
 * memory) does not silently drop something the assayer believes went through. This is the same
 * idea generalised to a small JSON action instead of a file or a GPS fix, so those two queues did
 * not have to be duplicated a third time for "everything else that hits the network".
 *
 * NOT everything that hits the network belongs here. The invoice-invitation submit goes around
 * this queue on purpose (see `MobileApiService.submitInvoiceInvitation`): it is consent to the
 * exact figures on screen, and a deferred replay could bind that consent to a different
 * document. A queue is for actions whose meaning survives a delay.
 *
 * Two things distinguish an action from a location fix or a packet:
 *
 *  - It carries a `clientRequestId` (a v4-shaped UUID, generated once and persisted with the
 *    action) so a retry that actually reached the server the first time — the response was just
 *    lost — does not create a second expense claim. Check-in/out and offer accept/reject do not
 *    need this: the server already treats them as idempotent by nature (first arrival kept;
 *    already-checked-out returns success). The expense claim is the one queued action that
 *    creates a new record each time it is POSTed, so it is the one the backend contract keys
 *    on `clientRequestId`.
 *  - A failure can be terminal. A validation 4xx ("this claim is over the single-claim limit")
 *    will fail forever no matter how many times it is retried, and retrying it silently
 *    would leave the assayer thinking a rejected request was still "trying". Only a transport
 *    failure (`retryable: true` from the dispatcher) re-queues the action; anything else is
 *    surfaced immediately and taken off the queue.
 */

export type ActionKind =
  | 'CHECK_IN'
  | 'CHECK_OUT'
  | 'ASSIGNMENT_STATUS'
  | 'EXPENSE_CLAIM'
  | 'QUERY_MESSAGE';

export type ActionStatus =
  /** Written down, not yet attempted (or re-queued after a retryable failure). */
  | 'PENDING'
  /** A request is in flight right now. */
  | 'SENDING'
  /** The server has durably accepted it. */
  | 'SENT'
  /** A transport/timeout failure. Kept for automatic retry — never shown as a dead end. */
  | 'RETRYING'
  /** A non-retryable failure (a validation 4xx). Terminal: shown to the assayer, then dismissed. */
  | 'ERROR';

export interface QueuedAction<TPayload = any> {
  id: string;
  kind: ActionKind;
  payload: TPayload;
  /**
   * Generated once, at the moment the action is first queued, and never regenerated on retry —
   * regenerating it on every attempt would defeat the point, since a retry after a lost response
   * needs to look identical to the request the server may already have received.
   */
  clientRequestId: string;
  status: ActionStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  /**
   * Defaults to true when a dispatcher throws (the common case: a thrown error is a transport or
   * timeout failure — `fetchWithAuth` only throws once its own transport retries are exhausted).
   * A dispatcher that resolves with `{ success: false }` must say explicitly whether the failure
   * is worth retrying; unset is treated as non-retryable, since a resolved (non-thrown) failure
   * is normally the server having actually answered "no".
   */
  retryable?: boolean;
}

export type ActionDispatcher<TPayload = any> = (
  payload: TPayload,
  clientRequestId: string,
) => Promise<ActionResult>;

const QUEUE_KEY = 'action_queue';

/** In-memory source of truth for the session; `null` until first loaded from storage. */
let buffer: QueuedAction[] | null = null;
const listeners = new Set<() => void>();
/** Guards against two overlapping drains — a foreground return and a manual action can race. */
let processing = false;

async function load(): Promise<QueuedAction[]> {
  if (buffer) return buffer;
  buffer = (await readCache<QueuedAction[]>(QUEUE_KEY)) ?? [];
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
  if (buffer) await writeCache(QUEUE_KEY, buffer);
  emit();
}

/** Best-effort v4-shaped UUID. Only needs to be unique per action, not cryptographically random —
 *  it exists so the server can recognise a retried request, not to guard anything secret. Kept
 *  local rather than adding a dependency: React Native has no guaranteed `crypto.randomUUID`. */
export function generateClientRequestId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Turn an HTTP status into a retry decision, for dispatchers built over the plain `{ success,
 * error, status }` shape most `MobileApiService` methods already return rather than throwing.
 *
 * A missing status (the request never got a response — DNS failure, timeout, offline) is treated
 * as retryable, the same as a thrown transport error. 5xx and 429 are the server's own way of
 * saying "try again"; everything else in the 4xx range (bad request, forbidden, conflict,
 * validation) means the request itself was refused and will be refused identically next time.
 */
export function isRetryableStatus(status?: number): boolean {
  if (status == null) return true;
  if (status === 429) return true;
  return status >= 500;
}

export function subscribeActionQueue(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function getQueuedActions(): Promise<QueuedAction[]> {
  return [...(await load())];
}

/** File an action. It starts PENDING; call `processActionQueue` (or `runQueuedAction`) to send it. */
export async function enqueueAction<TPayload>(
  kind: ActionKind,
  payload: TPayload,
): Promise<QueuedAction<TPayload>> {
  const list = await load();
  const now = new Date().toISOString();
  const entry: QueuedAction<TPayload> = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind,
    payload,
    clientRequestId: generateClientRequestId(),
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
  };
  list.push(entry);
  await persist();
  return entry;
}

async function mutate(id: string, changes: Partial<QueuedAction>): Promise<void> {
  const list = await load();
  const entry = list.find((a) => a.id === id);
  if (!entry) return;
  Object.assign(entry, changes, { updatedAt: new Date().toISOString() });
  await persist();
}

/** Attempt one action now and record the outcome. Shared by the immediate call site and the
 *  background drain, so a manual "do it now" and an automatic retry behave identically. */
async function attempt(entry: QueuedAction, dispatch: ActionDispatcher): Promise<ActionResult> {
  await mutate(entry.id, { status: 'SENDING', error: undefined });
  let result: ActionResult;
  try {
    result = await dispatch(entry.payload, entry.clientRequestId);
  } catch (err: any) {
    result = { success: false, error: err?.message || 'Network error', retryable: true };
  }

  if (result.success) {
    await mutate(entry.id, { status: 'SENT', error: undefined });
  } else if (result.retryable) {
    await mutate(entry.id, { status: 'RETRYING', error: result.error });
  } else {
    await mutate(entry.id, { status: 'ERROR', error: result.error });
  }
  return result;
}

/**
 * Enqueue an action and attempt it immediately, returning the outcome so an existing screen can
 * keep its current "show success/error now" flow. A retryable failure is left in the queue —
 * `processActionQueue` picks it up on the next foreground/reconnect — a non-retryable one is
 * removed, since it has already been shown to the assayer and retrying it can only fail the same
 * way again.
 */
export async function enqueueAndRun<TPayload>(
  kind: ActionKind,
  payload: TPayload,
  dispatch: ActionDispatcher<TPayload>,
): Promise<ActionResult & { queued: boolean }> {
  const entry = await enqueueAction(kind, payload);
  const result = await attempt(entry, dispatch as ActionDispatcher);
  if (result.success || !result.retryable) {
    await dismissAction(entry.id);
  }
  return { ...result, queued: !result.success && !!result.retryable };
}

/** Remove a terminal (SENT or ERROR) entry, or one the caller chooses to abandon. */
export async function dismissAction(id: string): Promise<void> {
  const list = await load();
  const i = list.findIndex((a) => a.id === id);
  if (i === -1) return;
  list.splice(i, 1);
  await persist();
}

/**
 * Send everything still waiting (PENDING or RETRYING), oldest first, and keep whatever did not
 * go. Called on app start, on reconnect, and whenever the app returns to the foreground — the
 * moments a handset that lost signal mid-branch is most likely to have some again.
 *
 * `dispatchers` is keyed by `ActionKind` because each kind hits a different endpoint; a kind with
 * no dispatcher registered is left untouched rather than dropped.
 *
 * Guarded against re-entry the same way the upload outbox is: a foreground return, a reconnect
 * and a fresh `enqueueAndRun` can all land at once.
 */
export async function processActionQueue(
  dispatchers: Partial<Record<ActionKind, ActionDispatcher>>,
): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    const initial = await load();
    const todo = initial
      .filter((a) => a.status === 'PENDING' || a.status === 'RETRYING')
      .map((a) => a.id);

    for (const id of todo) {
      const entry = (await load()).find((a) => a.id === id);
      if (!entry || (entry.status !== 'PENDING' && entry.status !== 'RETRYING')) continue;
      const dispatch = dispatchers[entry.kind];
      if (!dispatch) continue;

      const result = await attempt(entry, dispatch);
      if (result.success || !result.retryable) {
        await dismissAction(id);
      }
    }
  } finally {
    processing = false;
  }
}

/** Dropped on sign-out — one assayer's pending actions must never fire under another's session. */
export async function clearActionQueue(): Promise<void> {
  buffer = [];
  await persist();
}

/** Test seam: forget the in-memory buffer and any in-flight guard so the next call re-reads storage. */
export function __resetActionQueueForTests(): void {
  buffer = null;
  processing = false;
  listeners.clear();
}
