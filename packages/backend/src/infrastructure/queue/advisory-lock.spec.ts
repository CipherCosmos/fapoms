import { isAdvisoryLockHeld, withAdvisoryLock } from './advisory-lock';

/** One fake Postgres: a set of held keys shared by every "session" (query runner). */
const fakePg = () => {
  const held = new Map<string, number>();
  let nextSession = 0;
  const runners: any[] = [];
  const dataSource = {
    createQueryRunner: () => {
      const session = ++nextSession;
      const runner = {
        connect: jest.fn(async () => undefined),
        release: jest.fn(async () => undefined),
        query: jest.fn(async (sql: string, [key]: [string]) => {
          if (sql.includes('pg_try_advisory_lock')) {
            const owner = held.get(key);
            if (owner && owner !== session) return [{ ok: false }];
            held.set(key, session);
            return [{ ok: true }];
          }
          if (sql.includes('pg_advisory_unlock')) { if (held.get(key) === session) held.delete(key); return [{}]; }
          throw new Error(`unexpected sql ${sql}`);
        }),
      };
      runners.push(runner);
      return runner;
    },
  };
  return { dataSource: dataSource as any, held, runners };
};

describe('withAdvisoryLock', () => {
  it('runs the work holding the lock, then releases it and the connection', async () => {
    const pg = fakePg();
    let heldDuring = false;
    const out = await withAdvisoryLock(pg.dataSource, 'k', async () => { heldDuring = pg.held.has('k'); return 7; });
    expect(out).toEqual({ acquired: true, result: 7 });
    expect(heldDuring).toBe(true);
    expect(pg.held.has('k')).toBe(false);
    expect(pg.runners[0].release).toHaveBeenCalled();
  });

  it('refuses a second overlapping run instead of running it beside the first', async () => {
    const pg = fakePg();
    let release!: () => void;
    const first = withAdvisoryLock(pg.dataSource, 'k', () => new Promise<void>((r) => { release = r; }));
    await new Promise((r) => setImmediate(r));
    const second = jest.fn(async () => 'ran');
    await expect(withAdvisoryLock(pg.dataSource, 'k', second)).resolves.toEqual({ acquired: false });
    expect(second).not.toHaveBeenCalled();
    expect(await isAdvisoryLockHeld(pg.dataSource, 'k')).toBe(true);
    release();
    await first;
    expect(await isAdvisoryLockHeld(pg.dataSource, 'k')).toBe(false);
  });

  it('with wait, runs after the holder finishes', async () => {
    const pg = fakePg();
    let release!: () => void;
    const first = withAdvisoryLock(pg.dataSource, 'k', () => new Promise<void>((r) => { release = r; }));
    await new Promise((r) => setImmediate(r));
    const onWait = jest.fn();
    const second = withAdvisoryLock(pg.dataSource, 'k', async () => 'second', { wait: true, pollMs: 5, onWait });
    await new Promise((r) => setTimeout(r, 20));
    expect(onWait).toHaveBeenCalledTimes(1);
    release();
    await first;
    await expect(second).resolves.toEqual({ acquired: true, result: 'second' });
  });

  it('releases the lock when the work throws', async () => {
    const pg = fakePg();
    await expect(withAdvisoryLock(pg.dataSource, 'k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(pg.held.size).toBe(0);
  });
});
