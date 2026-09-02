/**
 * Queue and job names for spreadsheet imports, in their own leaf file.
 *
 * Kept separate for the same reason as `notification.constants.ts`: the producer
 * (`ImportJobService`) and the consumer (`ImportJobWorker`) both need these names, and if either
 * imported them from the other, a cycle would leave the constant `undefined` at
 * decorator-evaluation time. `@Processor(undefined)` and `@InjectQueue(undefined)` do not fail —
 * they silently bind to Bull's *default* queue, so the producer and consumer end up on two
 * different queues and every job sits unprocessed forever. A leaf module with no imports of its
 * own cannot recreate that.
 */

/**
 * A queue of this module's own, deliberately not the shared `background-jobs` one.
 *
 * `background-jobs` is broken: `BullQueueManager` adds *named* jobs to it while
 * `bull-processor.ts` declares an unnamed `@Process()`. Bull routes a named job only to a
 * handler registered under that exact name, so nothing on that queue is ever picked up — every
 * job added to it stalls and is eventually dead-lettered. Imports must not inherit that, and a
 * dedicated queue also means a long import cannot starve unrelated background work of the
 * shared concurrency budget.
 */
export const IMPORT_QUEUE = 'import-jobs';

/**
 * Job name for a project branch spreadsheet import.
 *
 * Must match the `@Process({ name: … })` in `ImportJobWorker` exactly — that equality is the
 * whole routing mechanism, and getting it wrong fails silently in the way described above.
 */
export const BRANCH_IMPORT_JOB = 'branch-import';

/**
 * Job name for an appraiser-roster spreadsheet import.
 *
 * On the same queue as the branch import, deliberately: both are long, both are rate-limited by
 * the same geocoding providers, and both must not run two at a time in one process. A second queue
 * would give each its own concurrency budget and reintroduce exactly the double-rate problem
 * `concurrency: 1` exists to prevent.
 */
export const ROSTER_IMPORT_JOB = 'roster-import';
