import { DomainEventPublisher } from './domain-event.publisher';

/**
 * A fake ioredis pub/sub that behaves like a tiny in-memory Redis: `publish` on one fake client
 * fans out to `message` listeners registered (via `subscribe`) on every fake client sharing the
 * same `bus` array — including the publisher's own subscriber, which is what makes the
 * own-origin filter in DomainEventPublisher worth testing at all.
 */
class FakeRedisBus {
  clients: FakeRedisClient[] = [];
}

class FakeRedisClient {
  private handlers: Array<(channel: string, message: string) => void> = [];
  public quit = jest.fn().mockResolvedValue(undefined);

  constructor(private readonly bus: FakeRedisBus) {
    this.bus.clients.push(this);
  }

  duplicate(): FakeRedisClient {
    return new FakeRedisClient(this.bus);
  }

  on(event: string, cb: any) {
    if (event === 'message') this.handlers.push(cb);
    return this;
  }

  async subscribe(_channel: string): Promise<void> {
    // No-op: this fake tracks subscribers by which clients exist on the bus, not by channel.
  }

  async publish(channel: string, message: string): Promise<number> {
    for (const client of this.bus.clients) {
      for (const handler of client['handlers']) {
        handler(channel, message);
      }
    }
    return this.bus.clients.length;
  }

  async quitReal() {
    return this.quit();
  }
}

describe('DomainEventPublisher', () => {
  describe('single-process mode (no Redis client)', () => {
    it('delivers to a named subscriber synchronously', () => {
      const publisher = new DomainEventPublisher();
      const seen: any[] = [];
      publisher.subscribe('thing:happened', (payload) => seen.push(payload));

      publisher.publish('thing:happened', { id: 1 });

      expect(seen).toEqual([{ id: 1 }]);
    });

    it('delivers to a global onPublish callback with the event name', () => {
      const publisher = new DomainEventPublisher();
      const seen: Array<[string, any]> = [];
      publisher.onPublish((name, payload) => seen.push([name, payload]));

      publisher.publish('thing:happened', { id: 2 });

      expect(seen).toEqual([['thing:happened', { id: 2 }]]);
    });

    it('does not throw when a listener throws', () => {
      const publisher = new DomainEventPublisher();
      publisher.subscribe('thing:happened', () => {
        throw new Error('boom');
      });

      expect(() => publisher.publish('thing:happened', {})).not.toThrow();
    });
  });

  describe('cross-process bridge (fake Redis pub/sub)', () => {
    it('an event published on one publisher reaches a global listener on another', async () => {
      const bus = new FakeRedisBus();
      const redisA = new FakeRedisClient(bus);
      const redisB = new FakeRedisClient(bus);

      // Cast to `any` — the fakes implement exactly the ioredis surface DomainEventPublisher
      // uses (duplicate/on/subscribe/publish), not the whole ioredis type.
      const publisherA = new DomainEventPublisher(redisA as any);
      const publisherB = new DomainEventPublisher(redisB as any);
      await publisherA.onModuleInit();
      await publisherB.onModuleInit();

      const seenOnB: Array<[string, any]> = [];
      publisherB.onPublish((name, payload) => seenOnB.push([name, payload]));

      publisherA.publish('billing:booked', { assignmentId: 'a1' });

      expect(seenOnB).toEqual([['billing:booked', { assignmentId: 'a1' }]]);
    });

    it('ignores its own message coming back over the wire (no double delivery)', async () => {
      const bus = new FakeRedisBus();
      const redis = new FakeRedisClient(bus);
      const publisher = new DomainEventPublisher(redis as any);
      await publisher.onModuleInit();

      const seen: any[] = [];
      publisher.onPublish((_name, payload) => seen.push(payload));

      publisher.publish('notification:new', { id: 'n1' });

      // Delivered exactly once — the local synchronous delivery — not twice (local + the
      // own-origin echo that this process also received back from the fake bus).
      expect(seen).toEqual([{ id: 'n1' }]);
    });

    it('a malformed message on the channel is dropped, not thrown', async () => {
      const bus = new FakeRedisBus();
      const redis = new FakeRedisClient(bus);
      const publisher = new DomainEventPublisher(redis as any);
      await publisher.onModuleInit();

      expect(async () => redis.publish('fapoms:domain-events', '{not json')).not.toThrow();
    });

    it('closes its subscriber connection on module destroy', async () => {
      const bus = new FakeRedisBus();
      const redis = new FakeRedisClient(bus);
      const publisher = new DomainEventPublisher(redis as any);
      await publisher.onModuleInit();
      await publisher.onModuleDestroy();

      // The subscriber is the *duplicate*, not the injected client itself — publish() must go
      // on being usable after destroy in a real app (it isn't the one that got quit()).
      const duplicated = bus.clients[1];
      expect(duplicated.quit).toHaveBeenCalled();
    });
  });
});

/**
 * The two things that stopped this bridge working in production, both silent.
 *
 * The class comment explains why the bridge exists: PROCESS_ROLE splits api and worker into
 * separate containers, so an event a worker raises can only reach an api replica's EventsGateway
 * over Redis. What the comment could not say was that it never did — the shared client is built
 * with `enableOfflineQueue: false` (correct for request-path cache reads, which must fail rather
 * than stall), `duplicate()` copied that, and the SUBSCRIBE issued while the new connection was
 * still handshaking was rejected every single boot with "Stream isn't writeable". The catch logged
 * a warning, nulled the subscriber, and never retried. Every deploy came up with realtime dead and
 * one warning line to say so.
 */
describe('the subscriber connection', () => {
  /** Records what `duplicate()` was asked for, which the bus fake above does not care about. */
  class OptionRecordingClient extends FakeRedisClient {
    public duplicateOptions: any;
    duplicate(override?: any): any {
      this.duplicateOptions = override;
      return super.duplicate();
    }
  }

  it('turns the offline queue on, so a SUBSCRIBE issued mid-handshake is queued rather than rejected', async () => {
    const client = new OptionRecordingClient(new FakeRedisBus());
    const publisher = new DomainEventPublisher(client as any);

    await publisher.onModuleInit();

    // The one setting that mattered. Inheriting `false` from the shared client is what broke it.
    expect(client.duplicateOptions).toEqual(expect.objectContaining({ enableOfflineQueue: true }));
    await publisher.onModuleDestroy();
  });

  it('starts without waiting for Redis to answer', async () => {
    // A subscribe that never settles is exactly what the offline queue produces while Redis is
    // unreachable. Awaiting it inside onModuleInit would hold up application start for as long as
    // the outage lasts — taking /health down with it, which is a worse failure than the degraded
    // realtime the bridge exists to prevent.
    // On the duplicate, which is where the publisher actually subscribes. Stubbing the injected
    // client instead leaves the duplicate's no-op subscribe in place, and the test then passes
    // against the very code it is meant to reject.
    const bus = new FakeRedisBus();
    const client: any = new FakeRedisClient(bus);
    client.duplicate = () => {
      const sub: any = new FakeRedisClient(bus);
      sub.subscribe = () => new Promise<void>(() => { /* never settles */ });
      return sub;
    };
    const publisher = new DomainEventPublisher(client);

    await expect(
      Promise.race([
        publisher.onModuleInit().then(() => 'started'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 50)),
      ]),
    ).resolves.toBe('started');

    await publisher.onModuleDestroy();
  });

  it('is already listening the moment the channel goes live', async () => {
    // The handler used to be attached after `await subscribe()`, leaving a window where the
    // channel was live and nothing was reading it. Anything delivered in that window was gone —
    // rare, silent, and impossible to tell apart from an event that was never published.
    const bus = new FakeRedisBus();
    let deliveredDuringSubscribe = false;

    // The publisher subscribes on the DUPLICATE, not on the injected client, so the stand-in for
    // "a message arrives the instant the channel goes live" has to live there.
    const client: any = new FakeRedisClient(bus);
    client.duplicate = () => {
      const sub: any = new FakeRedisClient(bus);
      sub.subscribe = async () => {
        await sub.publish(
          'fapoms:domain-events',
          JSON.stringify({ originId: 'somewhere-else', eventName: 'thing:happened', payload: { id: 1 } }),
        );
      };
      return sub;
    };

    const publisher = new DomainEventPublisher(client);
    publisher.subscribe('thing:happened', () => { deliveredDuringSubscribe = true; });
    await publisher.onModuleInit();
    await new Promise((r) => setImmediate(r));

    expect(deliveredDuringSubscribe).toBe(true);
    await publisher.onModuleDestroy();
  });
});
