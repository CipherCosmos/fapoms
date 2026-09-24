import type { DataSource, QueryRunner } from 'typeorm';

/**
 * A Postgres session advisory lock around a piece of background work, so two runs of the same
 * work cannot overlap — across processes and replicas, not only inside one.
 *
 * Why Postgres and not a Bull setting: Bull's `timeout` fails a job but does NOT stop its handler,
 * and a stalled job is redelivered while the first handler may still be running. Either way a
 * second run starts beside the first. A session advisory lock is held by one database connection
 * for the whole run and is released by Postgres itself if that process dies, so it cannot outlive
 * the work it guards the way a row flag or a Redis key with a TTL can.
 *
 * The cost is one pooled connection held idle for the run's duration — see `worker-concurrency.ts`.
 */
export interface AdvisoryLockOptions {
  /** Keep trying until acquired (polling), instead of giving up at once. */
  wait?: boolean;
  /** Poll interval while waiting. */
  pollMs?: number;
  /** Called once when the first attempt finds the lock taken and `wait` is set. */
  onWait?: () => void | Promise<void>;
}

export type AdvisoryLockResult<T> = { acquired: true; result: T } | { acquired: false };

const SQL_TRY = `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS "ok"`;
const SQL_UNLOCK = `SELECT pg_advisory_unlock(hashtextextended($1, 0))`;

async function tryLock(runner: QueryRunner, key: string): Promise<boolean> {
  const rows = await runner.query(SQL_TRY, [key]);
  return rows?.[0]?.ok === true;
}

export async function withAdvisoryLock<T>(
  dataSource: Pick<DataSource, 'createQueryRunner'>,
  key: string | string[],
  work: () => Promise<T>,
  opts: AdvisoryLockOptions = {},
): Promise<AdvisoryLockResult<T>> {
  const keys = Array.isArray(key) ? key : [key];
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  const held: string[] = [];
  /** All keys or none: a partial acquisition is given back so it never blocks anyone. */
  const tryAll = async (): Promise<boolean> => {
    for (const k of keys) {
      if (!(await tryLock(runner, k))) {
        for (const h of held.splice(0)) await runner.query(SQL_UNLOCK, [h]).catch(() => undefined);
        return false;
      }
      held.push(k);
    }
    return true;
  };
  try {
    let got = await tryAll();
    if (!got && opts.wait) {
      await opts.onWait?.();
      const pollMs = opts.pollMs ?? 5_000;
      while (!got) {
        await new Promise((r) => setTimeout(r, pollMs));
        got = await tryAll();
      }
    }
    if (!got) return { acquired: false };
    return { acquired: true, result: await work() };
  } finally {
    for (const h of held) await runner.query(SQL_UNLOCK, [h]).catch(() => undefined);
    await runner.release().catch(() => undefined);
  }
}

/**
 * Whether some session holds the lock right now — i.e. the guarded work is still running
 * somewhere. Takes and immediately drops the lock to find out; true when it could not be taken.
 * An error answers "held": the callers use this to decide NOT to declare a run dead.
 */
export async function isAdvisoryLockHeld(dataSource: Pick<DataSource, 'createQueryRunner'>, key: string): Promise<boolean> {
  let runner: QueryRunner | null = null;
  try {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    const got = await tryLock(runner, key);
    if (got) await runner.query(SQL_UNLOCK, [key]);
    return !got;
  } catch {
    return true;
  } finally {
    await runner?.release().catch(() => undefined);
  }
}
