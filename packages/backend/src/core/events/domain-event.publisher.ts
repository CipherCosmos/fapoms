import { Inject, Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis-client.module';

export type EventCallback = (eventName: string, payload: any) => void;

/** Channel every process publishes domain events to and subscribes on. One channel, not one per event name. */
const CHANNEL = 'fapoms:domain-events';

/** What crosses the wire. `originId` is what stops a process from re-delivering its own event. */
interface EventEnvelope {
  originId: string;
  eventName: string;
  payload: any;
}

/**
 * In-process event bus, now bridged across processes over Redis pub/sub.
 *
 * ## Why this needed a bridge
 *
 * This was a plain in-process listener map: `publish()` walked a local array of callbacks and
 * called them synchronously. That is exactly right for a single process, and exactly wrong once
 * `PROCESS_ROLE` splits `api` and `worker` into separate processes (see `main.ts`) — an event
 * raised on a worker (the SLA scanner's `notification:new`, `billing:booked`, an outbox
 * re-publish) had no way to reach `EventsGateway` on an api replica, because that gateway only
 * ever hears about events published inside its own process. The socket clients connected to that
 * api replica would simply never see the update; the only workaround was refreshing the page,
 * which happens to poll the database directly instead of trusting the socket.
 *
 * ## How the bridge works
 *
 * `publish()` still delivers locally first and synchronously, exactly as before — single-process
 * deployments (`PROCESS_ROLE=all`, and every existing test that does `new DomainEventPublisher()`
 * with no Redis client) are unaffected. It then also fires the same event, wrapped in a small JSON
 * envelope carrying this process's random `originId`, onto one Redis pub/sub channel
 * (`fapoms:domain-events`). Every process — including this one — receives every message back from
 * Redis; a message whose `originId` matches this process's own is dropped, because that event was
 * already delivered locally by the `publish()` call that sent it. A message from a *different*
 * origin is delivered through the same local listener/global-callback path, so `EventsGateway`
 * (or any other subscriber) cannot tell whether an event originated in-process or crossed from
 * another replica — it is one API either way.
 *
 * Redis is optional (`@Optional()` injection) and every Redis operation here is best-effort: a
 * publish that fails, or a subscriber connection that cannot be established, is logged and
 * swallowed rather than thrown, the same as every other Redis-backed convenience in this
 * codebase (see redis-client.module.ts's own comment on that philosophy). Losing the bridge means
 * a worker-raised event stops reaching other replicas' sockets — degraded realtime, not a crash —
 * and single-process deployments never depended on it in the first place.
 *
 * A *second* Redis connection is used for subscribing (`redisClient.duplicate()`), because an
 * ioredis connection that has issued `SUBSCRIBE` can no longer issue ordinary commands like
 * `PUBLISH` — they are different connection modes, so publishing and subscribing on the shared
 * app-wide `REDIS_CLIENT` would break the very first `.publish()` call after `.subscribe()`.
 */
@Injectable()
export class DomainEventPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DomainEventPublisher');
  private listeners: Record<string, ((payload: any) => void)[]> = {};
  private globalCallbacks: EventCallback[] = [];

  /** Unique per process, so a message this process sent can be told apart from one it merely received. */
  private readonly originId = randomUUID();

  /** Dedicated subscriber connection — see class comment for why it can't share `redisClient`. */
  private subscriber: Redis | null = null;

  constructor(@Optional() @Inject(REDIS_CLIENT) private readonly redisClient?: Redis) {}

  async onModuleInit(): Promise<void> {
    if (!this.redisClient) return; // No Redis configured (e.g. most unit tests) — in-process only.

    try {
      this.subscriber = this.redisClient.duplicate();
      this.subscriber.on('error', (err: Error) => {
        this.logger.warn(`Domain-event Redis subscriber connection error: ${err.message}`);
      });
      await this.subscriber.subscribe(CHANNEL);
      this.subscriber.on('message', (_channel: string, message: string) => {
        this.handleRemoteMessage(message);
      });
    } catch (err: any) {
      this.logger.warn(
        `Could not subscribe to ${CHANNEL}; cross-process domain events are disabled on this replica: ${err?.message}`,
      );
      this.subscriber = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.quit().catch(() => undefined);
      this.subscriber = null;
    }
  }

  onPublish(callback: EventCallback) {
    this.globalCallbacks.push(callback);
  }

  subscribe(eventName: string, callback: (payload: any) => void) {
    if (!this.listeners[eventName]) {
      this.listeners[eventName] = [];
    }
    this.listeners[eventName].push(callback);
  }

  /**
   * Deliver locally, then hand the same event to Redis so other processes see it too.
   *
   * The local delivery is unconditional and synchronous, matching the pre-bridge behaviour
   * exactly. The Redis publish is fire-and-forget: nothing here awaits it, and a failure is
   * logged rather than thrown, because a caller of `publish()` must never fail because the
   * cross-process bridge (an optimisation for OTHER replicas) had trouble.
   */
  publish(eventName: string, payload: any) {
    this.deliverLocally(eventName, payload);

    if (!this.redisClient) return;
    const envelope: EventEnvelope = { originId: this.originId, eventName, payload };
    this.redisClient.publish(CHANNEL, JSON.stringify(envelope)).catch((err: any) => {
      this.logger.warn(`Could not publish ${eventName} to ${CHANNEL}: ${err?.message}`);
    });
  }

  /** The listener/global-callback fan-out. Shared by a local publish() and a remote message. */
  private deliverLocally(eventName: string, payload: any): void {
    const list = this.listeners[eventName] || [];
    for (const cb of list) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`Error handling event ${eventName}`, err);
      }
    }

    for (const cb of this.globalCallbacks) {
      try {
        cb(eventName, payload);
      } catch (err) {
        console.error(`Error in global callback for event ${eventName}`, err);
      }
    }
  }

  /** A message received over the Redis channel — from this process or another one. */
  private handleRemoteMessage(raw: string): void {
    let envelope: EventEnvelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      this.logger.warn(`Ignoring malformed domain-event message on ${CHANNEL}`);
      return;
    }

    // Own-origin messages were already delivered locally by the publish() call that sent them —
    // delivering them again here would double-fire every listener in a single-process deployment
    // just as readily as in a split one, since this process subscribes to its own channel too.
    if (envelope.originId === this.originId) return;

    this.deliverLocally(envelope.eventName, envelope.payload);
  }
}
