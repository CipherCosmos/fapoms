import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  DomainEventPublisher,
  EVENTS_REQUIRING_A_NAMED_SUBSCRIBER,
} from './domain-event.publisher';

/**
 * AN EVENT NOBODY HANDLES MUST NOT BE RECORDED AS DELIVERED.
 *
 * The outbox marks a row `dispatched_at` when `publishAsync` resolves. It resolves happily over an
 * empty listener array, so a renamed or unregistered subscriber discarded every event of that name
 * for ever: no error, no retry, nothing in the dead-letter queue. For `assignment:status-changed`
 * that is a payable never booked.
 *
 * ## Why this file drives the REAL publisher
 *
 * The first attempt at that guard counted named listeners and catch-alls together and asked
 * whether the total was zero. It was dead code from the moment it shipped — `EventsGateway`
 * registers a global callback in its constructor for the life of the process, so the total is
 * never zero. It passed its unit tests because those tests mocked `publishAsync` to return 0,
 * which the real publisher cannot do. A mock returns whatever it is told; that is the whole
 * failure mode.
 *
 * So every case below constructs `DomainEventPublisher` itself, registers a catch-all exactly as
 * the gateway does, and asks what the real object reports.
 */
describe('what a published event actually reached', () => {
  const publisher = () => new DomainEventPublisher();

  /** What `EventsGateway` does in its constructor, and the reason the first guard never fired. */
  const withGatewayCatchAll = (p: DomainEventPublisher) => {
    const seen: string[] = [];
    p.onPublish((eventName) => { seen.push(eventName); });
    return seen;
  };

  it('separates a named handler from a catch-all, because they answer different questions', async () => {
    const p = publisher();
    const broadcast = withGatewayCatchAll(p);
    const handled: unknown[] = [];
    p.subscribe('assignment:status-changed', (payload) => { handled.push(payload); });

    const count = await p.publishAsync('assignment:status-changed', { id: 'a1' });

    expect(count).toEqual({ named: 1, global: 1 });
    expect(handled).toHaveLength(1);
    expect(broadcast).toEqual(['assignment:status-changed']);
  });

  it('reports named: 0 for an event only the catch-all saw — the case the old guard could not see', async () => {
    const p = publisher();
    const broadcast = withGatewayCatchAll(p);

    const count = await p.publishAsync('assignment:status-changed', { id: 'a1' });

    // The old check asked whether the TOTAL was zero. It is 1 here, and it is 1 for every event
    // name that will ever exist, which is why it never fired.
    expect(count.named + count.global).toBe(1);
    expect(count.named).toBe(0);
    expect(broadcast).toEqual(['assignment:status-changed']);
  });

  it('still reports the catch-all for a broadcast-only event, which is a real delivery', async () => {
    // `billing:booked` and eighteen others have no named subscriber by design: reaching a socket
    // IS what they are for. Treating those as undelivered would dead-letter the outbox.
    const p = publisher();
    withGatewayCatchAll(p);

    const count = await p.publishAsync('billing:booked', { id: 'b1' });

    expect(count).toEqual({ named: 0, global: 1 });
    expect(EVENTS_REQUIRING_A_NAMED_SUBSCRIBER.has('billing:booked')).toBe(false);
  });

  it('still rethrows a subscriber error, so the relay does not mark the row dispatched', async () => {
    const p = publisher();
    withGatewayCatchAll(p);
    p.subscribe('assignment:status-changed', () => { throw new Error('billing queue unreachable'); });

    await expect(p.publishAsync('assignment:status-changed', {})).rejects.toThrow(/billing queue unreachable/);
  });
});

/**
 * The declared set has to stay true, and only one direction of that is worth enforcing.
 *
 * Checking that every listed name is subscribed somewhere catches the renaming this exists for:
 * delete or rename the billing subscriber and the build fails. Checking the other direction —
 * that every subscribed name is listed — would not, because the honest response to "I removed the
 * subscriber" would then be to remove the name from the list, which is precisely the protection
 * being given up.
 */
describe('every event declared to need a handler still has one', () => {
  const SRC = join(__dirname, '..', '..');

  const subscribed = (() => {
    const names = new Set<string>();
    (function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== 'node_modules' && entry !== '_historical') walk(full);
        } else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
          const text = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/\/\/[^\n]*/g, ' ');
          for (const m of text.matchAll(/\.subscribe\(\s*'([^']+)'/g)) names.add(m[1]);
        }
      }
    })(SRC);
    return names;
  })();

  it('finds the subscriptions at all, so a broken scan cannot pass as a clean result', () => {
    expect(subscribed.size).toBeGreaterThanOrEqual(5);
    expect(subscribed.has('assignment:status-changed')).toBe(true);
  });

  it.each([...EVENTS_REQUIRING_A_NAMED_SUBSCRIBER])('%s is subscribed somewhere in the source', (name) => {
    // If this fails, a handler was renamed or removed. Either restore it, or take the event out
    // of EVENTS_REQUIRING_A_NAMED_SUBSCRIBER deliberately — but know that doing so means the
    // outbox will call that event delivered when nothing receives it.
    expect(subscribed.has(name)).toBe(true);
  });

  it('names the money and authorization paths, which are the ones that fail silently', () => {
    // A payable never booked, and an authorization cache never invalidated. Both look like
    // nothing happening rather than like an error.
    expect(EVENTS_REQUIRING_A_NAMED_SUBSCRIBER.has('assignment:status-changed')).toBe(true);
    expect(EVENTS_REQUIRING_A_NAMED_SUBSCRIBER.has('user:role-changed')).toBe(true);
  });
});
