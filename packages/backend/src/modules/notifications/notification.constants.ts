/**
 * Queue name, kept in its own file on purpose.
 *
 * It previously lived in `notification-delivery.worker.ts`, which the sweeper
 * imports — while the worker imports the sweeper. That cycle left the constant
 * `undefined` at decorator-evaluation time, so `@InjectQueue(NOTIFICATION_QUEUE)`
 * silently resolved to Bull's *default* queue instead of failing loudly, and the
 * application would not start. A leaf module with no imports cannot recreate it.
 */
export const NOTIFICATION_QUEUE = 'notification-delivery';

/**
 * The emails actions ask for (`OutboundMessageService`) — a queue of their own, not a job name on the
 * one above.
 *
 * Bull does not give a named handler its own slots: `@Process({ name, concurrency })` adds that many
 * worker loops to the QUEUE, and every loop takes the next job of any name off one shared wait list
 * (bull 4.16 `Queue.prototype.run` / `getNextJob`). On the notification queue a 540-person credential
 * run would therefore sit in front of — and hold every loop away from — the push offers and the
 * SLA-breach alert emails queued after it. A separate queue is the only real isolation.
 */
export const OUTBOUND_EMAIL_QUEUE = 'outbound-email';

/**
 * Texts (`SmsService`), on the same ledger and lifecycle as emails but their own queue for the same
 * reason emails have theirs: a slow SMS gateway must not hold the loops a burst of emails needs, nor
 * the reverse.
 */
export const OUTBOUND_SMS_QUEUE = 'outbound-sms';
