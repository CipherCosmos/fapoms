import { EventEmitter } from 'events';
import { RedisIoAdapter } from './redis-io.adapter';
import { REDIS_CLIENT } from '../redis/redis-client.module';

/**
 * `duplicate()` returns a client whose socket has not connected yet. The base client (and
 * therefore every duplicate) carries `enableOfflineQueue: false`, so a command issued before the
 * client reaches `ready` is rejected immediately instead of being queued. `connectToRedis` used
 * to `ping()` right after `duplicate()`, which failed on every boot — 218/218 in production logs
 * — and the caller's catch always fell back to the single-node in-memory adapter, permanently
 * reporting `/health/ready` as degraded. This fake ioredis client starts at `status: 'connecting'`
 * and only reaches `'ready'` (and only then answers `ping`) once `goReady()` is called, so a fix
 * that pings before waiting for `ready` fails these tests the same way the real client failed in
 * production.
 */
class FakeRedis extends EventEmitter {
  status: string = 'connecting';
  private readonly duplicates: FakeRedis[] = [];

  duplicate(): FakeRedis {
    const dup = new FakeRedis();
    this.duplicates.push(dup);
    return dup;
  }

  /** The duplicated clients `connectToRedis` created, in creation order. */
  createdDuplicates(): FakeRedis[] {
    return this.duplicates;
  }

  ping(): Promise<string> {
    if (this.status !== 'ready') {
      return Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
    }
    return Promise.resolve('PONG');
  }

  /** Simulate the connection finishing, as ioredis does asynchronously after `duplicate()`. */
  goReady(): void {
    this.status = 'ready';
    this.emit('ready');
  }
}

describe('RedisIoAdapter.connectToRedis', () => {
  it('does not ping a duplicated client before it reaches ready', async () => {
    const base = new FakeRedis();
    const app = { get: (token: string) => (token === REDIS_CLIENT ? base : undefined) } as any;
    const adapter = new RedisIoAdapter(app);

    const connectPromise = adapter.connectToRedis();
    let settled = false;
    connectPromise.then(() => (settled = true), () => (settled = true));

    // Flush pending microtasks. Neither duplicate has reached 'ready' yet, so a correct
    // implementation must still be waiting — a broken one that pinged immediately would already
    // have rejected by now.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    const [pubClient, subClient] = base.createdDuplicates();
    expect(pubClient).toBeDefined();
    expect(subClient).toBeDefined();

    pubClient.goReady();
    subClient.goReady();

    await expect(connectPromise).resolves.toBeUndefined();
  });

  it('resolves immediately when the duplicated clients are already ready', async () => {
    class AlreadyReadyRedis extends FakeRedis {
      duplicate(): FakeRedis {
        const dup = super.duplicate();
        dup.status = 'ready';
        return dup;
      }
    }
    const base = new AlreadyReadyRedis();
    const app = { get: () => base } as any;
    const adapter = new RedisIoAdapter(app);

    await expect(adapter.connectToRedis()).resolves.toBeUndefined();
  });

  it('throws (so the caller falls back to the in-memory adapter) when a duplicate errors before ready', async () => {
    class ErroringOnConnectRedis extends FakeRedis {
      duplicate(): FakeRedis {
        const dup = super.duplicate();
        setImmediate(() => dup.emit('error', new Error('ECONNREFUSED')));
        return dup;
      }
    }
    const base = new ErroringOnConnectRedis();
    const app = { get: () => base } as any;
    const adapter = new RedisIoAdapter(app);

    await expect(adapter.connectToRedis()).rejects.toThrow('ECONNREFUSED');
  });
});
