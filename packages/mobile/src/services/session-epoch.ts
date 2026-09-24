/**
 * Which session a piece of fetched data belongs to — so an answer that arrives late cannot land in
 * somebody else's session.
 *
 * A read (the schedule, the profile, earnings, notifications) is started under one session and
 * answered seconds later. If the assayer signs out in between — or the session ends and somebody
 * else signs in on the same phone — that answer used to be written anyway: into the on-disk cache
 * sign-out had just wiped, or into screen state the next person was about to see. On a shared
 * handset that shows person A's work, bank details or pay to person B.
 *
 * Every start and end of a session advances the epoch. A reader takes a stamp when it starts and
 * checks it before writing anything; a stamp from an earlier epoch, or from nobody's session, is
 * stale and the answer is dropped.
 */
export interface SessionStamp {
  readonly epoch: number;
  readonly owner: string | null;
}

let epoch = 0;
let owner: string | null = null;

/** Called whenever a session starts (with its user) or ends (with `null`). */
export function advanceSession(userId: string | null | undefined): void {
  epoch += 1;
  owner = userId ? userId : null;
}

export function stampSession(): SessionStamp {
  return { epoch, owner };
}

/** True only while the same session that took the stamp is still the live one. */
export function isStampCurrent(stamp: SessionStamp): boolean {
  return stamp.owner !== null && stamp.epoch === epoch && stamp.owner === owner;
}

/** Test seam. */
export function __resetSessionEpochForTests(): void {
  epoch = 0;
  owner = null;
}
