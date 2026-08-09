import type { EntityManager } from 'typeorm';

/**
 * Hand a domain event to the transaction rather than to the bus.
 *
 * The distinction matters: an event passed here is released only if the transaction commits.
 * Calling the publisher directly from inside a transaction announces state that a later
 * statement can still roll back, and `DomainEventPublisher` is synchronous and in-process, so
 * a subscriber observes that uncommitted state immediately rather than eventually.
 */
export type EmitFn = (event: string, payload: Record<string, unknown>) => void;

export type TransactionWork<T> = (manager: EntityManager, emit: EmitFn) => Promise<T>;

/**
 * One atomic change to persistent state, plus the events that describe it.
 *
 * ## Why this exists as a port
 *
 * `BillingEngineService` grew a private `inTx` helper that did exactly this — open a
 * transaction at READ COMMITTED, buffer domain events, release them after COMMIT. It was
 * correct, but it was correct in one file. Every other service that needs the same guarantee
 * (`AssignmentService`, `CustomerMasterService`, `SchedulingService` all call
 * `DataSource.transaction` directly) would have had to re-derive the event-ordering rule, and
 * the two that already do publish events do so from inside the transaction.
 *
 * Making it a port moves two decisions out of domain services and into one place:
 *
 *   - **Isolation level.** READ COMMITTED is deliberate, not a default. Combined with the
 *     `FOR UPDATE` locks callers take, a second writer blocks until the first commits and then
 *     re-reads the row at its new committed value — which is what the guards need, because
 *     they must judge the *current* state, not the state at request arrival. REPEATABLE READ
 *     would instead abort the second writer with a serialization failure and push the retry
 *     onto the caller for no gain.
 *   - **When events become visible.** After COMMIT, never before.
 *
 * A service that depends on this no longer injects `DataSource`, so it can no longer open a
 * transaction at the wrong isolation level or publish an event at the wrong moment.
 *
 * ## The manager is an acknowledged leak
 *
 * `run` hands the callback a TypeORM `EntityManager`. That is not the end state — a fully
 * isolated domain layer would receive repository ports instead. It is where this stops today
 * because the alternative is defining ports for all 66 entities before anything can use the
 * transaction boundary at all. The boundary is worth having first; narrowing what crosses it
 * is the next step, and the guard in `persistence-boundary.spec.ts` records which services
 * still reach through.
 *
 * Declared as an abstract class rather than an interface so it can be a Nest injection token
 * directly, without a separate string symbol.
 */
export abstract class UnitOfWork {
  abstract run<T>(work: TransactionWork<T>): Promise<T>;
}
