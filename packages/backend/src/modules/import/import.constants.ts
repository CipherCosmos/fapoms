/**
 * Queue and job names for spreadsheet imports, in their own leaf file.
 *
 * Kept separate for the same reason as `notification.constants.ts`: the producer
 * (`ImportJobService`) and the consumers (`ImportJobWorker`, `RosterImportWorker`,
 * `CustomerMasterImportWorker`) all need these names, and if either side imported them from the
 * other, a cycle would leave the constant `undefined` at decorator-evaluation time.
 * `@Processor(undefined)` and `@InjectQueue(undefined)` do not fail — they silently bind to Bull's
 * *default* queue, so the producer and consumer end up on two different queues and every job sits
 * unprocessed forever. A leaf module with no imports of its own cannot recreate that.
 *
 * ## One queue per import kind
 *
 * All three kinds used to share `import-jobs`, each in its own `@Processor` class at
 * `concurrency: 1`, on the belief that this ran each kind one at a time. It did not. Bull has no
 * per-name slots: every `@Process({ name, concurrency })` adds `concurrency` loops to the QUEUE
 * (`Queue.prototype.run`), and each loop pops the next waiting job of ANY name. Three handlers at
 * one each were three shared loops, so two roster uploads could run side by side writing the same
 * people, and two customer-master uploads for one project could each register a version unaware of
 * the other. A queue of its own, with one handler at `concurrency: 1`, is the only shape in which
 * "one at a time" is actually true — and `import-queue-routing.spec.ts` fails if a second consumer
 * ever joins one of these queues.
 */

/**
 * The branch-import queue, deliberately not the shared `background-jobs` one.
 *
 * `background-jobs` is broken: `BullQueueManager` adds *named* jobs to it while
 * `bull-processor.ts` declares an unnamed `@Process()`. Bull routes a named job only to a
 * handler registered under that exact name, so nothing on that queue is ever picked up — every
 * job added to it stalls and is eventually dead-lettered. Imports must not inherit that, and a
 * dedicated queue also means a long import cannot starve unrelated background work of the
 * shared concurrency budget.
 *
 * Kept under its original name (it was the first import queue) so a branch import already waiting
 * in Redis is still picked up after a deploy.
 */
export const IMPORT_QUEUE = 'import-jobs';

/**
 * The appraiser-roster queue. Its own queue so two roster uploads cannot run at once — see the
 * header above for why sharing `import-jobs` never prevented that.
 *
 * Running alongside a branch import is fine and always was: `politely()` (geo/osm-geocoder.ts)
 * chains geocoder calls per host across the whole process, so concurrent importers of different
 * kinds still produce one request per second at the provider.
 */
export const ROSTER_IMPORT_QUEUE = 'roster-import-jobs';

/**
 * The customer-master queue. Its own queue so two uploads cannot reconcile at once: each reads
 * the latest version number and registers the next one, so two side by side register the same
 * number twice, each superseding a version it never saw.
 */
export const CUSTOMER_MASTER_IMPORT_QUEUE = 'customer-master-import-jobs';

/**
 * Job name for a project branch spreadsheet import.
 *
 * Must match the `@Process({ name: … })` in `ImportJobWorker` exactly — that equality is the
 * whole routing mechanism, and getting it wrong fails silently in the way described above.
 */
export const BRANCH_IMPORT_JOB = 'branch-import';

/**
 * Job name for an appraiser-roster spreadsheet import, on `ROSTER_IMPORT_QUEUE`.
 *
 * Must match the `@Process({ name: … })` in `RosterImportWorker` exactly, for the same reason.
 */
export const ROSTER_IMPORT_JOB = 'roster-import';

/**
 * Job name for a customer-master spreadsheet import, on `CUSTOMER_MASTER_IMPORT_QUEUE`.
 *
 * The last import that still ran inside the request: it reconciles every row against the client's
 * branches by SOL ID and registers a version, which on a real daily file is thousands of lookups
 * the operator sat and watched.
 */
export const CUSTOMER_MASTER_IMPORT_JOB = 'customer-master-import';
