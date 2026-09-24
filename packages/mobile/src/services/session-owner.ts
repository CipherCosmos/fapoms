/**
 * Whose queued work is on this phone, and what happens to it when somebody signs in.
 *
 * Three queues hold work filed on the phone and sent later: the action queue (check-in/out, offer
 * replies, claims, query replies), the upload outbox (audit packets, registration scans) and the
 * location queue (the movement trail). Each is sent under whatever session is live when it drains.
 *
 * Sign-out empties all three. But a session can also end without a sign-out — the cold-start
 * check finding it revoked — and the login screen that follows is open to anybody holding the
 * handset. Without a record of whose work was left behind, the next person to sign in would send
 * the previous person's check-in, packet or GPS trail under their own name.
 *
 * So the owner is written down (in the cache file, which sign-out deletes along with the queues),
 * and a sign-in by somebody else empties the queues before anything can drain. The same person
 * signing back in keeps their work: that is exactly the case a revoked session leaves behind.
 */

export const QUEUE_OWNER_CACHE_KEY = 'queue_owner';

export interface QueueOwnerDeps {
  readOwner: () => Promise<string | null>;
  writeOwner: (userId: string) => Promise<void>;
  /** Empty every user-scoped queue, in memory and on disk. */
  clearQueues: () => Promise<void>;
  /** Give pre-ownership action-queue entries to this user. See `adoptUnownedActions`. */
  adoptUnowned: (userId: string) => Promise<void>;
  /** Tell the action queue whose session is live. */
  setOwner: (userId: string | null) => void;
}

export type QueueClaim = 'kept' | 'cleared' | 'adopted';

/**
 * Decide what happens to queued work when `userId`'s session starts.
 *
 * - Somebody else's work on the phone: cleared.
 * - Same person: kept.
 * - No record at all: on a restored session this is the first launch of a build that keeps the
 *   record, so the work on the phone was filed by the session being restored — it is adopted. On
 *   a fresh sign-in there is nothing to adopt: sign-out already emptied the queues, and anything
 *   unowned left behind cannot be shown to be this person's, so the action queue keeps refusing it.
 */
export function decideQueueClaim(
  previousOwner: string | null,
  userId: string,
  how: 'restored' | 'signed-in',
): QueueClaim {
  if (previousOwner && previousOwner !== userId) return 'cleared';
  if (!previousOwner && how === 'restored') return 'adopted';
  return 'kept';
}

export async function claimQueuedWorkFor(
  userId: string,
  how: 'restored' | 'signed-in',
  deps: QueueOwnerDeps,
): Promise<QueueClaim> {
  let previous: string | null = null;
  try {
    previous = await deps.readOwner();
  } catch {
    previous = null;
  }
  const claim = decideQueueClaim(previous, userId, how);
  if (claim === 'cleared') await deps.clearQueues();
  if (claim === 'adopted') await deps.adoptUnowned(userId);
  await deps.writeOwner(userId);
  deps.setOwner(userId);
  return claim;
}
