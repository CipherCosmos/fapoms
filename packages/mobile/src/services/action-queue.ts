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
 *    lost — does not create a second expense claim. The server honours it on the expense claim
 *    (`expenses.client_request_id`) and on offer accept/decline (`POST /assignments/:id/transition`
 *    keeps `assignment_idempotency_records`), so a replayed accept or decline is answered with the
 *    original result instead of an "invalid transition" for a decline that already landed.
 *    Check-in/out do not send one: the server treats them as idempotent by nature (first arrival
 *    kept; already-checked-out returns success).
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
  /** The machine-readable companion to `error`, when the dispatcher's response carried one. */
  code?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * The signed-in user who filed this action. An action is only ever sent under its owner's
   * session: on a shared handset, A's pending check-in, claim or offer reply must never reach the
   * server under B's token. Absent only on entries written by builds before this field existed;
   * see `adoptUnownedActions` for what happens to those.
   */
  ownerId?: string;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  /** The machine-readable companion to `error`, when the dispatcher's response carried one. */
  code?: string;
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
/**
 * Whose session is live right now, or `null` when nobody is signed in. Set by `AuthContext` the
 * moment a session starts or ends. Every entry is stamped with it when filed, and nothing is sent
 * unless the entry's owner is this user.
 */
let owner: string | null = null;

/** Tell the queue whose session is live. `null` (or an empty id) means nobody is signed in. */
export function setActionQueueOwner(userId: string | null | undefined): void {
  owner = userId ? userId : null;
}

export function getActionQueueOwner(): string | null {
  return owner;
}

/** Said when something tries to file or send an action with no session to send it under. */
export const NOT_SIGNED_IN_ERROR = 'You are not signed in.';

/** Still waiting to go: written down, being retried, or in flight right now. */
function isOpen(a: QueuedAction): boolean {
  return a.status === 'PENDING' || a.status === 'RETRYING' || a.status === 'SENDING';
}

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

/**
 * File an action for the signed-in user. It starts PENDING; call `processActionQueue` (or
 * `enqueueAndRun`) to send it. Refuses (throws) when nobody is signed in: an action with no owner
 * could never be sent, and silently keeping it would only let it surface under the wrong person.
 *
 * `clientRequestId` lets a caller supply the key itself — one generated when a form opened, so a
 * second press on the same form reuses the key instead of minting a new one.
 */
export async function enqueueAction<TPayload>(
  kind: ActionKind,
  payload: TPayload,
  opts: { clientRequestId?: string } = {},
): Promise<QueuedAction<TPayload>> {
  const ownerId = owner;
  if (!ownerId) throw new Error(NOT_SIGNED_IN_ERROR);
  const list = await load();
  const now = new Date().toISOString();
  const entry: QueuedAction<TPayload> = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind,
    payload,
    clientRequestId: opts.clientRequestId || generateClientRequestId(),
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    ownerId,
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
  // Checked immediately before sending, not only when the drain began: a sign-out or a switch to
  // another account can land while an earlier action is still on the wire.
  if (!owner || entry.ownerId !== owner) {
    return { success: false, error: NOT_SIGNED_IN_ERROR, retryable: false };
  }
  // Claimed synchronously (the entry is the buffer's own object), so a drain and an
  // `enqueueAndRun` that both looked at it in the same tick cannot both send it.
  entry.status = 'SENDING';
  await mutate(entry.id, { status: 'SENDING', error: undefined, code: undefined });
  let result: ActionResult;
  try {
    result = await dispatch(entry.payload, entry.clientRequestId);
  } catch (err: any) {
    result = { success: false, error: err?.message || 'Network error', retryable: true };
  }

  if (result.success) {
    await mutate(entry.id, { status: 'SENT', error: undefined, code: undefined });
  } else if (result.retryable) {
    await mutate(entry.id, { status: 'RETRYING', error: result.error, code: result.code });
  } else {
    await mutate(entry.id, { status: 'ERROR', error: result.error, code: result.code });
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
  opts: {
    /** A key the caller holds for this one submission (see `enqueueAction`). */
    clientRequestId?: string;
    /**
     * Recognise an action already waiting that this one would duplicate — e.g. a second "Accept"
     * on an offer whose first accept is still waiting for signal. When one matches, it is sent
     * again (or left in flight) instead of a second copy being filed.
     */
    sameAs?: (existing: QueuedAction<TPayload>) => boolean;
  } = {},
): Promise<ActionResult & { queued: boolean }> {
  if (!owner) {
    return { success: false, error: NOT_SIGNED_IN_ERROR, retryable: false, queued: false };
  }
  const existing = (await load()).find(
    (a) =>
      a.ownerId === owner
      && a.kind === kind
      && isOpen(a)
      && ((!!opts.clientRequestId && a.clientRequestId === opts.clientRequestId)
        || (!!opts.sameAs && opts.sameAs(a as QueuedAction<TPayload>))),
  );
  if (existing?.status === 'SENDING') {
    // Already on the wire from an earlier press or a background drain. Its outcome will land in
    // the queue; filing it again is exactly the duplicate this exists to prevent.
    return { success: false, retryable: true, queued: true };
  }
  const entry = existing ?? (await enqueueAction(kind, payload, { clientRequestId: opts.clientRequestId }));
  const result = await attempt(entry, dispatch as ActionDispatcher);
  if (result.success || !result.retryable) {
    await dismissAction(entry.id);
  }
  return { ...result, queued: !result.success && !!result.retryable };
}

/**
 * What a screen should do with an `enqueueAndRun` result, in one place so the three callers that
 * file offer replies and claims cannot drift apart.
 *
 * `queued` is a success from the assayer's point of view: the action is written down on the phone
 * and will send itself. It used to be returned as a failure ("will retry"), which kept the form
 * open and invited a second press — and every press filed another copy.
 */
export type SubmitOutcome =
  | { success: true; queued: boolean }
  | { success: false; queued: false; error?: string; code?: string };

export function toSubmitOutcome(
  result: ActionResult & { queued: boolean },
  fallbackError?: string,
): SubmitOutcome {
  if (result.success) return { success: true, queued: false };
  if (result.queued) return { success: true, queued: true };
  return { success: false, queued: false, error: result.error || fallbackError, code: result.code };
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
  // Nobody signed in: send nothing and drop nothing. The owner is set as a session starts, and a
  // drain that happens to run first must not mistake "not yet known" for "someone else".
  if (!owner) return;
  processing = true;
  try {
    const initial = await load();

    // Anything filed by a different user is dropped, never sent. Sign-out clears the queue, but
    // a session can also end without one (the server revoking it) and the next person to sign
    // in on the same handset must not have the previous person's actions sent under their name.
    const foreign = initial.filter((a) => a.ownerId !== owner).map((a) => a.id);
    for (const id of foreign) await dismissAction(id);

    const todo = (await load())
      .filter((a) => a.status === 'PENDING' || a.status === 'RETRYING')
      .map((a) => a.id);

    for (const id of todo) {
      const entry = (await load()).find((a) => a.id === id);
      if (!entry || (entry.status !== 'PENDING' && entry.status !== 'RETRYING')) continue;
      if (entry.ownerId !== owner) continue;
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

/**
 * Give entries written before actions carried an owner to the user whose session was restored.
 *
 * Called only when the app resumes a saved session and has no record of whose queued work is on
 * the phone — i.e. the first launch after this build replaced one that did not tag actions. Those
 * entries were filed on this handset by the session that is still signed in (sign-out deletes the
 * cache file), so dropping them would silently lose a claim or check-in the assayer believes is
 * on its way. A fresh sign-in never adopts: there, an unowned entry can only be somebody else's.
 */
export async function adoptUnownedActions(userId: string): Promise<void> {
  const list = await load();
  let changed = false;
  for (const a of list) {
    if (!a.ownerId) {
      a.ownerId = userId;
      changed = true;
    }
  }
  if (changed) await persist();
}

/**
 * Dropped on sign-out — one assayer's pending actions must never fire under another's session.
 *
 * Replaces the in-memory copy as well as the stored one. Clearing only the file was not enough:
 * the buffer outlived it and was written straight back on the next action, carrying the previous
 * person's check-in or claim into the next session.
 */
export async function clearActionQueue(): Promise<void> {
  buffer = [];
  await persist();
}

/** Test seam: forget the in-memory buffer and any in-flight guard so the next call re-reads storage. */
export function __resetActionQueueForTests(): void {
  buffer = null;
  processing = false;
  owner = null;
  listeners.clear();
}
