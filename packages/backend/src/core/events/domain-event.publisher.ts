import { Inject, Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis-client.module';

export type EventCallback = (eventName: string, payload: any) => any;
export type EventListener = (payload: any) => any;

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
/** What one local delivery actually reached. Named listeners and catch-alls are not the same thing. */
export interface DeliveryCount {
  /** Handlers registered for THIS event name. */
  named: number;
  /** Catch-alls registered for every event — currently the realtime gateway, always at least one. */
  global: number;
}

/**
 * Events whose delivery does something other than reach a socket, and must therefore have a
 * handler of their own.
 *
 * Most events are broadcast-only: the gateway's catch-all is their whole purpose, and a missing
 * named subscriber they never had is not a fault. These are the ones where no handler means a
 * business effect silently not happening — a payable never booked, an authorization cache never
 * invalidated — and where the relay must refuse to call the event delivered.
 *
 * `event-subscribers.spec.ts` fails the build if any name here stops being subscribed anywhere in
 * the source, which is the renaming this list exists to catch.
 */
export const EVENTS_REQUIRING_A_NAMED_SUBSCRIBER: ReadonlySet<string> = new Set([
  'assignment:status-changed',
  'assignment:fee-updated',
  'assayer:created',
  'assayer:updated',
  'assayer:deleted',
  'user:updated',
  'user:role-changed',
  'user:password-changed',
]);

@Injectable()
export class DomainEventPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DomainEventPublisher');
  private listeners: Record<string, EventListener[]> = {};
  private globalCallbacks: EventCallback[] = [];

  /** Unique per process, so a message this process sent can be told apart from one it merely received. */
  private readonly originId = randomUUID();

  /** Dedicated subscriber connection — see class comment for why it can't share `redisClient`. */
  private subscriber: Redis | null = null;

  constructor(@Optional() @Inject(REDIS_CLIENT) private readonly redisClient?: Redis) {}

  async onModuleInit(): Promise<void> {
    if (!this.redisClient) return; // No Redis configured (e.g. most unit tests) — in-process only.

    /**
     * `enableOfflineQueue: true`, overriding the shared client's own setting.
     *
     * The shared client is built by `failFastRedisOptions`, which turns the offline queue OFF on
     * purpose: a cache read on the request path must fail immediately during an outage rather
     * than stall behind a reconnect. `duplicate()` copies those options, and that setting is
     * exactly wrong here — the duplicated connection is still handshaking when this method runs,
     * so the SUBSCRIBE below was rejected with "Stream isn't writeable and enableOfflineQueue
     * options is false" on EVERY boot, the catch swallowed it, and the bridge was set to null
     * for the life of the process with no retry.
     *
     * That was not a degraded edge case on this deployment, it was the normal state. Production
     * runs PROCESS_ROLE=api and PROCESS_ROLE=worker as separate containers, which is the entire
     * reason this bridge exists: every event a worker raises — the SLA scanner's
     * `notification:new`, `billing:booked`, an outbox re-publish — reached no api replica, so
     * `EventsGateway` never pushed it and connected browsers saw nothing until someone refreshed.
     *
     * The offline queue is the right trade for this connection specifically. It issues exactly one
     * command, once, at startup, and nothing waits on it — so "queue it until Redis answers" costs
     * nothing, where on the request path it would have cost a stall per read.
     */
    this.subscriber = this.redisClient.duplicate({ enableOfflineQueue: true });

    this.subscriber.on('error', (err: Error) => {
      this.logger.warn(`Domain-event Redis subscriber connection error: ${err.message}`);
    });

    // Handler before SUBSCRIBE, not after. Registering it afterwards leaves a window in which the
    // channel is live and nothing is listening, and anything delivered in it is gone.
    this.subscriber.on('message', (_channel: string, message: string) => {
      this.handleRemoteMessage(message);
    });

    /**
     * Deliberately not awaited.
     *
     * With the offline queue on, this promise settles whenever Redis first becomes reachable,
     * which during an outage may be minutes or never. `onModuleInit` blocking on that would stop
     * the API from starting at all while Redis is down — a far worse failure than the degraded
     * realtime this bridge exists to prevent, and one that would take down `/health` with it.
     *
     * Nothing is lost by letting it settle later: ioredis re-issues subscriptions itself after a
     * reconnect, so once the queued SUBSCRIBE lands the bridge stays up across later blips
     * without anything here retrying by hand.
     */
    void this.subscriber.subscribe(CHANNEL).then(
      () => this.logger.log(`Cross-process domain events bridged over ${CHANNEL}`),
      (err: Error) => this.logger.warn(
        `Could not subscribe to ${CHANNEL}; cross-process domain events are disabled on this replica: ${err?.message}`,
      ),
    );
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

  subscribe(eventName: string, callback: EventListener) {
    if (!this.listeners[eventName]) {
      this.listeners[eventName] = [];
    }
    this.listeners[eventName].push(callback);
  }

  /**
   * Deliver locally, awaiting any promise-returning listeners, then hand the same event to Redis.
   *
   * Crucial for durable outbox dispatch: if a subscriber (e.g. durable queue enqueue) throws or rejects,
   * publishAsync rethrows so the UnitOfWork fast-path or OutboxRelay does NOT mark the outbox record
   * as dispatched!
   */
  async publishAsync(eventName: string, payload: any): Promise<DeliveryCount> {
    const handled = await this.deliverLocallyAsync(eventName, payload);

    if (!this.redisClient) return handled;
    const envelope: EventEnvelope = { originId: this.originId, eventName, payload };
    this.redisClient.publish(CHANNEL, JSON.stringify(envelope)).catch((err: any) => {
      this.logger.warn(`Could not publish ${eventName} to ${CHANNEL}: ${err?.message}`);
    });
    return handled;
  }

  /** How many local handlers an event name would reach right now. Zero means nobody is listening. */
  subscriberCount(eventName: string): number {
    return (this.listeners[eventName] || []).length + this.globalCallbacks.length;
  }

  /**
   * Synchronous / fire-and-forget publish.
   */
  publish(eventName: string, payload: any) {
    this.deliverLocally(eventName, payload);

    if (!this.redisClient) return;
    const envelope: EventEnvelope = { originId: this.originId, eventName, payload };
    this.redisClient.publish(CHANNEL, JSON.stringify(envelope)).catch((err: any) => {
      this.logger.warn(`Could not publish ${eventName} to ${CHANNEL}: ${err?.message}`);
    });
  }

  /**
   * The listener/global-callback fan-out with Promise awaiting. Rethrows subscriber errors.
   *
   * Returns the two counts SEPARATELY, which is the whole point.
   *
   * With no subscriber for an event name this resolves happily over an empty array, and the relay
   * counted that as a delivery — so a renamed subscriber discarded every event of that name in
   * silence. "Nothing threw" and "somebody received it" are different facts.
   *
   * The first attempt at that guard returned ONE total, and was dead code: `EventsGateway`
   * registers a global callback in its constructor for the life of the process, so the total is
   * never zero and the check could not fire. It passed its unit tests because they mocked
   * `publishAsync` to return 0, which the real publisher cannot do.
   *
   * The two counts answer different questions and only one is "was this delivered". Nineteen
   * event names — `billing:booked`, `assignment:created`, the seven `DESK_*` ones — have no named
   * subscriber at all and never will: the gateway broadcasting them over websockets IS their
   * delivery. Counting only named listeners would dead-letter every one of them.
   */
  private async deliverLocallyAsync(eventName: string, payload: any): Promise<DeliveryCount> {
    const list = this.listeners[eventName] || [];
    for (const cb of list) {
      await cb(payload);
    }

    for (const cb of this.globalCallbacks) {
      await cb(eventName, payload);
    }
    return { named: list.length, global: this.globalCallbacks.length };
  }

  /** The listener/global-callback fan-out. Shared by a local publish() and a remote message. */
  private deliverLocally(eventName: string, payload: any): void {
    const list = this.listeners[eventName] || [];
    for (const cb of list) {
      try {
        const res = cb(payload);
        if (res && typeof (res as Promise<any>).catch === 'function') {
          (res as Promise<any>).catch((err) => {
            this.logger.error(`Error handling async event ${eventName}`, err);
          });
        }
      } catch (err) {
        console.error(`Error handling event ${eventName}`, err);
      }
    }

    for (const cb of this.globalCallbacks) {
      try {
        const res = cb(eventName, payload);
        if (res && typeof (res as Promise<any>).catch === 'function') {
          (res as Promise<any>).catch((err) => {
            this.logger.error(`Error in global async callback for event ${eventName}`, err);
          });
        }
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
