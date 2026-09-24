/** The SLA scanner's queue: the 15-minute scan and the morning digest. */
export const SLA_SCANNER_QUEUE = 'sla-scanner';

/**
 * Registered ONCE (in `NotificationsModule`, which `SlaScannerModule` imports) with these settings.
 * It used to be registered by both modules — two Queue instances, two sets of Redis connections,
 * for one queue.
 *
 * `maxStalledCount: 0`: a stalled job is failed, never re-run. The digest SENDS as it goes and keeps
 * no record of who it reached, so a stall redelivery (a long synchronous stretch starving lock
 * renewal, a worker restart mid-run) re-mailed everyone the morning brief. A duplicate brief is
 * worse than a missed one; tomorrow's supersedes it. The scan loses one tick at worst — every phase
 * is idempotent and the next tick is fifteen minutes away.
 */
export const SLA_SCANNER_QUEUE_SETTINGS = { maxStalledCount: 0 };
