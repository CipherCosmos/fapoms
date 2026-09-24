import { EventsGateway, assayerAuthChangeId, NATIONAL_ROOM } from './events.gateway';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { realtimeHealth } from '../../infrastructure/realtime/realtime-health';
import { AuthService } from '../auth/auth.service';

/**
 * Delivery contract of the realtime gateway across processes, rooms and sessions.
 *
 *  - one socket emission per event across N processes (the Redis adapter fans out; the bridge
 *    must not re-emit), while the per-process re-auth half still runs everywhere;
 *  - operational traffic never goes to `org:` (assayers sit there) and fails closed on region;
 *  - a socket runs the HTTP session gate and takes roles from the principal, not the token, and
 *    dies at token expiry;
 *  - a reassignment reaches both phones; expense decisions reach the claimant.
 */

/** A shared in-memory Redis pub/sub for the domain-event bridge. */
class Bus {
  clients: FakeRedis[] = [];
}
class FakeRedis {
  handlers: Array<(c: string, m: string) => void> = [];
  quit = jest.fn().mockResolvedValue(undefined);
  constructor(private readonly bus: Bus) { bus.clients.push(this); }
  duplicate() { return new FakeRedis(this.bus); }
  on(ev: string, cb: any) { if (ev === 'message') this.handlers.push(cb); return this; }
  async subscribe() { /* every client on the bus hears every message */ }
  async publish(ch: string, msg: string) {
    for (const c of this.bus.clients) for (const h of c.handlers) h(ch, msg);
    return 1;
  }
}

const guard = (region: string | null = null) => ({
  getUserRegions: jest.fn().mockResolvedValue(null),
  resolveEventRegion: jest.fn().mockResolvedValue(region),
});
const noAssayer = () => ({ findOne: jest.fn().mockResolvedValue(null) }) as any;
const flush = () => new Promise((r) => setImmediate(r));

describe('EventsGateway — one emission per event across two processes', () => {
  const saved = realtimeHealth.crossProcessFanOut;
  afterEach(() => { realtimeHealth.crossProcessFanOut = saved; });

  /** Two processes: their publishers share one bridge, their gateways one (adapter-backed) room space. */
  const twoProcesses = async () => {
    const bus = new Bus();
    const emissions: Array<{ room: string; event: string }> = [];
    const server = () => ({
      to: (room: string) => ({ emit: (event: string) => emissions.push({ room, event }) }),
      sockets: { sockets: new Map() },
    });
    const pubA = new DomainEventPublisher(new FakeRedis(bus) as any);
    const pubB = new DomainEventPublisher(new FakeRedis(bus) as any);
    await pubA.onModuleInit();
    await pubB.onModuleInit();
    const gwA = new EventsGateway({} as any, pubA, guard('WEST') as any, noAssayer());
    const gwB = new EventsGateway({} as any, pubB, guard('WEST') as any, noAssayer());
    (gwA as any).server = server();
    (gwB as any).server = server();
    return { pubA, pubB, gwA, gwB, emissions };
  };

  it('emits each socket event once in total when the Redis adapter fans out', async () => {
    realtimeHealth.crossProcessFanOut = true;
    const { pubA, emissions } = await twoProcesses();

    pubA.publish('assignment:status-changed', { assignmentId: 'a1', assayerId: 'x1', newState: 'ACCEPTED' });
    await flush();

    const count = (room: string) => emissions.filter((e) => e.room === room).length;
    expect(count('assignment:a1')).toBe(1);
    expect(count('user:x1')).toBe(1);
    expect(count('region:WEST')).toBe(1);
  });

  it('still emits locally for a remote event when this process has no cross-process adapter', async () => {
    realtimeHealth.crossProcessFanOut = false;
    const { pubA, emissions } = await twoProcesses();

    pubA.publish('assignment:created', { assignmentId: 'a1', assayerId: 'x1' });
    await flush();

    // Each in-memory process must reach its own sockets.
    expect(emissions.filter((e) => e.room === 'user:x1')).toHaveLength(2);
  });

  it('drops the affected user\'s sockets in EVERY process, remote included', async () => {
    realtimeHealth.crossProcessFanOut = true;
    const { pubA, gwA, gwB } = await twoProcesses();
    const reauthA = jest.spyOn(gwA as any, 'disconnectUserForReauth');
    const reauthB = jest.spyOn(gwB as any, 'disconnectUserForReauth');

    pubA.publish('user:role-changed', { userId: 'u9' });

    expect(reauthA).toHaveBeenCalledWith('u9');
    expect(reauthB).toHaveBeenCalledWith('u9');
  });
});

describe('EventsGateway — assayer lifecycle is an auth change', () => {
  it('keys an assayer deletion or lifecycle transition on aggregateId, and ignores a profile edit', () => {
    expect(assayerAuthChangeId('assayer:deleted', { aggregateId: 'a1' })).toBe('a1');
    expect(assayerAuthChangeId('AssayerSuspendedEvent', { aggregateId: 'a1', newState: 'SUSPENDED' })).toBe('a1');
    expect(assayerAuthChangeId('AssayerTerminatedEvent', { aggregateId: 'a1', newState: 'TERMINATED' })).toBe('a1');
    expect(assayerAuthChangeId('assayer:updated', { aggregateId: 'a1' })).toBeNull();
  });

  it('drops the assayer\'s socket when they are suspended', () => {
    const pub = new DomainEventPublisher();
    const gw = new EventsGateway({} as any, pub, guard() as any, noAssayer());
    (gw as any).server = { to: () => ({ emit: jest.fn() }), sockets: { sockets: new Map() } };
    const reauth = jest.spyOn(gw as any, 'disconnectUserForReauth');
    pub.publish('AssayerSuspendedEvent', { aggregateId: 'a1', previousState: 'ACTIVE', newState: 'SUSPENDED' });
    expect(reauth).toHaveBeenCalledWith('a1');
  });
});

describe('EventsGateway — no operational event reaches an assayer through org:', () => {
  const makeGw = (region: string | null) => {
    const gw = new EventsGateway({} as any, new DomainEventPublisher(), guard(region) as any, noAssayer());
    const to = jest.fn().mockReturnValue({ emit: jest.fn() });
    (gw as any).server = { to };
    return { gw, rooms: () => to.mock.calls.map((c: any[]) => c[0] as string) };
  };

  it.each([
    ['assignment:created', { assignmentId: 'a1', assayerId: 'x1', organizationId: 'o1' }],
    ['assignment:status-changed', { assignmentId: 'a1', organizationId: 'o1' }],
    ['assignment:fee-updated', { assignmentId: 'a1', assayerId: 'x1', organizationId: 'o1' }],
    ['schedule:created', { assignmentId: 'a1', organizationId: 'o1' }],
    ['query:raised', { queryId: 'q1', organizationId: 'o1' }],
    ['branch:updated', { branchId: 'b1', clientId: 'c1', organizationId: 'o1' }],
    ['client:updated', { clientId: 'c1', organizationId: 'o1' }],
    ['assayer:updated', { aggregateId: 'x1', organizationId: 'o1' }],
    ['project:updated', { aggregateId: 'p1', organizationId: 'o1' }],
    ['ProjectCompletedEvent', { aggregateId: 'p1', metadata: { organizationId: 'o1' } }],
  ])('%s is never sent to org:', async (event, payload) => {
    const { gw, rooms } = makeGw('WEST');
    gw.broadcastEvent(event, payload);
    await flush();
    expect(rooms().filter((r) => r.startsWith('org:'))).toEqual([]);
  });

  it('never sends assignment:fee-updated to the assayer\'s own room', async () => {
    const { gw, rooms } = makeGw('WEST');
    gw.broadcastEvent('assignment:fee-updated', { assignmentId: 'a1', assayerId: 'x1', organizationId: 'o1' });
    await flush();
    expect(rooms()).not.toContain('user:x1');
    expect(rooms()).toEqual(['region:WEST']);
  });

  it.each(['billing:booked', 'billing:invoice-changed'])('keeps %s off the assayer\'s phone', async (event) => {
    const { gw, rooms } = makeGw('WEST');
    gw.broadcastEvent(event, { assignmentId: 'a1', assayerId: 'x1' });
    await flush();
    expect(rooms()).not.toContain('user:x1');
  });

  it('routes a reassignment to both phones, the job room and the desk', async () => {
    const { gw, rooms } = makeGw('WEST');
    gw.broadcastEvent('assignment:reassigned', {
      assignmentId: 'a1', oldAssayerId: 'old', previousAssayerId: 'old', newAssayerId: 'new', assayerId: 'new',
    });
    await flush();
    expect(rooms()).toEqual(['assignment:a1', 'user:old', 'user:new', 'region:WEST']);
  });

  it('sends an expense decision to the claimant', async () => {
    const { gw, rooms } = makeGw('WEST');
    gw.broadcastEvent('expense:decided', { expenseId: 'e1', assignmentId: 'a1', assayerId: 'x1', status: 'APPROVED' });
    await flush();
    expect(rooms()).toEqual(['user:x1', 'region:WEST']);
  });

  it('sends a document event to the assayer it names', async () => {
    const { gw, rooms } = makeGw(null);
    gw.broadcastEvent('document:status-changed', { documentId: 'd1', assayerId: 'x1' });
    await flush();
    expect(rooms()).toContain('user:x1');
  });
});

describe('EventsGateway — the socket runs the HTTP session gate', () => {
  const client = () => ({
    id: 's1', handshake: { auth: { token: 't' }, query: {} },
    emit: jest.fn(), disconnect: jest.fn(), join: jest.fn(),
  } as any);
  const gateway = (validate: jest.Mock, tokenClaims: any, regions: string[] | null = null) => {
    const jwt = { verifyAsync: jest.fn().mockResolvedValue(tokenClaims) };
    const g = { getUserRegions: jest.fn().mockResolvedValue(regions), resolveEventRegion: jest.fn() };
    const moduleRef = { get: jest.fn((token: any) => (token === AuthService ? { validateJwtPayload: validate } : null)) };
    return new EventsGateway(jwt as any, new DomainEventPublisher(), g as any, noAssayer(), moduleRef as any);
  };

  it('refuses a socket whose session is revoked or idle, as HTTP would', async () => {
    const validate = jest.fn().mockResolvedValue(null);
    const c = client();
    await gateway(validate, { sub: 'u1', sid: 's-dead', roles: ['ADMIN'] }).handleConnection(c);
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ sub: 'u1', sid: 's-dead' }));
    expect(c.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'SESSION_INVALID' }));
    expect(c.disconnect).toHaveBeenCalled();
    expect(c.join).not.toHaveBeenCalled();
  });

  it('takes roles and organisation from the principal, not the token', async () => {
    // The token still claims ADMIN; the account has since been downgraded to an assayer-like
    // external role. The socket must not join the staff or admin rooms on the stale claim.
    const validate = jest.fn().mockResolvedValue({ id: 'u1', roles: [{ name: 'CLIENT_USER' }], organizationId: 'o2' });
    const c = client();
    await gateway(validate, { sub: 'u1', roles: ['ADMIN'], organizationId: 'o1' }).handleConnection(c);
    const joined = c.join.mock.calls.map((x: any[]) => x[0]);
    expect(joined).toEqual(['user:u1', 'role:CLIENT_USER', 'org:o2']);
  });

  it('puts only an unrestricted staff account in the national room', async () => {
    const national = client();
    await gateway(jest.fn().mockResolvedValue({ roles: [{ name: 'OPERATIONS' }] }), { sub: 'u1' }, null).handleConnection(national);
    expect(national.join.mock.calls.map((x: any[]) => x[0])).toContain(NATIONAL_ROOM);

    const west = client();
    await gateway(jest.fn().mockResolvedValue({ roles: [{ name: 'OPERATIONS' }] }), { sub: 'u2' }, ['WEST']).handleConnection(west);
    expect(west.join.mock.calls.map((x: any[]) => x[0])).not.toContain(NATIONAL_ROOM);
  });

  it('drops the socket when its access token expires, and forgets the timer on disconnect', async () => {
    jest.useFakeTimers();
    try {
      const exp = Math.floor(Date.now() / 1000) + 60;
      const c = client();
      const gw = gateway(jest.fn().mockResolvedValue({ roles: [{ name: 'OPERATIONS' }] }), { sub: 'u1', exp });
      await gw.handleConnection(c);
      expect(c.disconnect).not.toHaveBeenCalled();
      jest.advanceTimersByTime(61_000);
      expect(c.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
      expect(c.disconnect).toHaveBeenCalled();

      const c2 = client();
      await gw.handleConnection(c2);
      gw.handleDisconnect(c2);
      jest.advanceTimersByTime(61_000);
      expect(c2.disconnect).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses rather than skip the gate when the auth service cannot be resolved', async () => {
    const jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub: 'u1', roles: ['ADMIN'] }) };
    const moduleRef = { get: jest.fn(() => { throw new Error('not found'); }) };
    const gw = new EventsGateway(jwt as any, new DomainEventPublisher(), guard() as any, noAssayer(), moduleRef as any);
    const c = client();
    await gw.handleConnection(c);
    expect(c.join).not.toHaveBeenCalled();
    expect(c.disconnect).toHaveBeenCalled();
  });
});
