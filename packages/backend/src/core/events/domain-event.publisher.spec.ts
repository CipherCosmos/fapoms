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
