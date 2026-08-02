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
