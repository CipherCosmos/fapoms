import {
  GENESIS_HASH,
  canonicalEventString,
  computeRowHash,
  type SealableEvent,
} from './hash-chain';

/**
 * The chain is the tamper-evidence, so its two guarantees are worth pinning directly: a hash
 * commits to the FULL content of an event (any change moves the hash), and it commits to POSITION
 * (a deletion or reorder breaks the linkage even though each event's own content is untouched). The
 * last test replays the verifier's walk over an in-memory chain to prove it catches edit, delete and
 * reorder — the DB wiring is thin over exactly this.
 */
describe('audit hash chain', () => {
  const base: SealableEvent = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    category: 'DATA_ACCESS',
    eventType: 'ASSAYER_RECORD_VIEWED',
    entityType: 'ASSAYER_RECORD',
    entityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    previousState: null,
    newState: null,
    userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    userDisplayName: 'Ada Ops',
    ipAddress: '203.0.113.5',
    actorRole: 'OPERATIONS',
    userAgent: 'Mozilla/5.0',
    sessionId: 'sess-1',
    requestId: 'req-1',
    outcome: 'SUCCESS',
    remarks: null,
    metadata: { access: 'READ', queryKeys: ['include'] },
    before: null,
    after: null,
    occurredAt: new Date('2026-09-04T10:00:00.000Z'),
  };

  it('is deterministic and stable across equal values', () => {
    expect(computeRowHash(GENESIS_HASH, base)).toBe(computeRowHash(GENESIS_HASH, base));
  });

  it('does not depend on JSON key order in metadata (an honest round-trip is not tampering)', () => {
    const reordered: SealableEvent = {
      ...base,
      metadata: { queryKeys: ['include'], access: 'READ' },
    };
    expect(canonicalEventString(reordered)).toBe(canonicalEventString(base));
  });

  it('changes when ANY committed field changes', () => {
    const h = computeRowHash(GENESIS_HASH, base);
    const fields: Array<Partial<SealableEvent>> = [
      { eventType: 'ASSAYER_RECORD_EDITED' },
      { entityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      { userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
      { ipAddress: '198.51.100.9' },
      { actorRole: 'ADMIN' },
      { sessionId: 'sess-2' },
      { outcome: 'DENIED' },
      { metadata: { access: 'READ' } },
      { occurredAt: new Date('2026-09-04T10:00:01.000Z') },
    ];
    for (const patch of fields) {
      expect(computeRowHash(GENESIS_HASH, { ...base, ...patch })).not.toBe(h);
    }
  });

  it('binds position — the same event at a different chain point hashes differently', () => {
    expect(computeRowHash(GENESIS_HASH, base)).not.toBe(computeRowHash('f'.repeat(64), base));
  });

  describe('the verifier walk detects', () => {
    // Build a genuine 3-event chain.
    const events: SealableEvent[] = [0, 1, 2].map((i) => ({
      ...base,
      id: `0000000${i}-0000-4000-8000-000000000000`,
      requestId: `req-${i}`,
    }));
    const seal = (evs: SealableEvent[]) => {
      let prev = GENESIS_HASH;
      return evs.map((e) => {
        const rowHash = computeRowHash(prev, e);
        const link = { prevHash: prev, rowHash, event: e };
        prev = rowHash;
        return link;
      });
    };
    /** The verifier's algorithm, over an in-memory chain. Returns the first broken index, or -1. */
    const walk = (chain: Array<{ prevHash: string; rowHash: string; event: SealableEvent }>) => {
      let expectedPrev = GENESIS_HASH;
      for (let i = 0; i < chain.length; i++) {
        const link = chain[i];
        if (link.prevHash !== expectedPrev) return i;
        if (computeRowHash(expectedPrev, link.event) !== link.rowHash) return i;
        expectedPrev = link.rowHash;
      }
      return -1;
    };

    it('a clean chain (returns no break)', () => {
      expect(walk(seal(events))).toBe(-1);
    });

    it('an edited event', () => {
      const chain = seal(events);
      chain[1] = { ...chain[1], event: { ...chain[1].event, ipAddress: '10.0.0.1' } };
      expect(walk(chain)).toBe(1);
    });

    it('a deleted event (link no longer matches)', () => {
      const chain = seal(events);
      chain.splice(1, 1); // remove the middle link
      expect(walk(chain)).toBe(1);
    });

    it('a reordered chain', () => {
      const chain = seal(events);
      [chain[1], chain[2]] = [chain[2], chain[1]];
      expect(walk(chain)).toBe(1);
    });
  });
});
