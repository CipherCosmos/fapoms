import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis-client.module';

/**
 * Socket.IO adapter backed by Redis pub/sub.
 *
 * Why this exists: the gateway delivers every event with room-scoped emits
 * (`server.to('user:123').emit(...)`). With the default in-memory adapter those
 * emits only reach sockets connected to the *same* Node process, so the moment
 * the API runs more than one replica a client connected to instance B never
 * receives an event emitted on instance A — realtime silently half-works and
 * the bug is invisible on a single-box dev setup.
 *
 * The Redis adapter republishes every broadcast over Redis, so each instance
 * re-emits to its own local sockets in the target room. Room membership,
 * `server.to(room).emit(...)` and `socket.join(room)` all become cluster-wide
 * with no change to the gateway itself. This is the single keystone that lets
 * the backend scale horizontally.
 *
 * Fault tolerance: the pub/sub clients are duplicates of the app's shared
 * ioredis client (same host/credentials/retry policy). Their `error` events are
 * handled so a transient Redis blip logs and reconnects instead of taking down
 * the process. If Redis cannot be reached at boot, `connectToRedis` throws and
 * the caller falls back to the in-memory adapter (correct for a single node).
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const base = this.app.get<Redis>(REDIS_CLIENT);
    const pubClient = base.duplicate();
    const subClient = base.duplicate();

    // A dropped Redis connection must never crash the API. ioredis reconnects on
    // its own (retryStrategy from RedisClientModule); we just keep the process alive.
    pubClient.on('error', (err: Error) =>
      this.logger.error(`Redis pub client error: ${err.message}`),
    );
    subClient.on('error', (err: Error) =>
      this.logger.error(`Redis sub client error: ${err.message}`),
    );

    // Surface a hard failure at boot so the caller can decide to fall back.
    await Promise.all([pubClient.ping(), subClient.ping()]);

    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log('Socket.IO Redis adapter connected — realtime is now multi-node.');
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      // Applies to the default namespace and every namespace created afterwards
      // (the gateway's `/events` namespace included).
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
