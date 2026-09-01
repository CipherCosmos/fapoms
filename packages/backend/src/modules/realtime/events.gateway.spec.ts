import { EventsGateway } from './events.gateway';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { UserEntity } from '../user/user.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';
import { FeedbackThreadEntity } from '../feedback/feedback-thread.entity';

describe('EventsGateway — socket authentication', () => {
  let gateway: EventsGateway;
  let mockJwtService: { verifyAsync: jest.Mock; decode: jest.Mock };
  let mockRegionGuard: { getUserRegions: jest.Mock; resolveEventRegion: jest.Mock };

  const makeClient = (auth: Record<string, any> = {}) => ({
    id: 'socket-1',
    handshake: { auth, query: {} },
    emit: jest.fn(),
    disconnect: jest.fn(),
    join: jest.fn(),
  });

  beforeEach(() => {
    mockJwtService = {
      verifyAsync: jest.fn(),
      decode: jest.fn(),
    };
    mockRegionGuard = {
      getUserRegions: jest.fn().mockResolvedValue(null),
      resolveEventRegion: jest.fn().mockResolvedValue(null),
    };
    gateway = new EventsGateway(mockJwtService as any, new DomainEventPublisher(), mockRegionGuard as any);
  });

  it('rejects a connection with no token at all', async () => {
    const client = makeClient({});
    await gateway.handleConnection(client as any);

    expect(client.emit).toHaveBeenCalledWith('error', expect.objectContaining({ message: expect.any(String) }));
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('rejects an invalid/unsigned token instead of decoding it without verification', async () => {
    mockJwtService.verifyAsync.mockRejectedValue(new Error('invalid signature'));
    const client = makeClient({ token: 'not-a-real-jwt' });

    await gateway.handleConnection(client as any);

    // Must never fall back to jwtService.decode() (unsigned) or trust the raw token string
    expect(mockJwtService.decode).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('error', { message: 'Invalid or expired token' });
    expect(client.disconnect).toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
  });

  it('accepts a connection with a properly verified JWT', async () => {
    mockJwtService.verifyAsync.mockResolvedValue({ sub: 'user-1', roles: ['ASSAYER'], organizationId: 'org-1' });
    const client = makeClient({ token: 'valid.jwt.token' });

    await gateway.handleConnection(client as any);

    expect(client.emit).toHaveBeenCalledWith('connected', expect.objectContaining({ userId: 'user-1' }));
    expect(client.join).toHaveBeenCalledWith('user:user-1');
    expect(client.disconnect).not.toHaveBeenCalled();
  });
});

describe('EventsGateway — territorial rooms', () => {
  const makeGateway = (regions: string[] | null, eventRegion: string | null) => {
    const jwt = { verifyAsync: jest.fn(), decode: jest.fn() };
    const guard = {
      getUserRegions: jest.fn().mockResolvedValue(regions),
      resolveEventRegion: jest.fn().mockResolvedValue(eventRegion),
    };
    const gw = new EventsGateway(jwt as any, new DomainEventPublisher(), guard as any);
    const emit = jest.fn();
    (gw as any).server = { to: jest.fn().mockReturnValue({ emit }) };
    return { gw, jwt, guard, emit };
  };

  const connect = async (gw: EventsGateway, jwt: any, roles: string[]) => {
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', roles });
    const client: any = {
      id: 's1', handshake: { auth: { token: 't' }, query: {} },
      emit: jest.fn(), disconnect: jest.fn(), join: jest.fn(),
    };
    await gw.handleConnection(client);
    return client;
  };

  it('puts a region-assigned operator only in their own region rooms', async () => {
    const { gw, jwt } = makeGateway(['WEST'], null);
    const client = await connect(gw, jwt, ['OPERATIONS']);
    const joined = client.join.mock.calls.map((c: any[]) => c[0]);
    expect(joined).toContain('region:WEST');
    expect(joined).not.toContain('region:SOUTH');
  });

  // An unassigned account is national; it must keep seeing everything it saw before.
  it('puts an unassigned staff account in every region room', async () => {
    const { gw, jwt } = makeGateway(null, null);
    const client = await connect(gw, jwt, ['OPERATIONS']);
    const joined = client.join.mock.calls.map((c: any[]) => c[0]);
    expect(joined).toEqual(expect.arrayContaining(['region:WEST', 'region:SOUTH', 'region:NORTH']));
  });

  it('leaves field assayers out of the staff and region rooms entirely', async () => {
    const { gw, jwt } = makeGateway(null, null);
    const client = await connect(gw, jwt, ['ASSAYER']);
    const joined = client.join.mock.calls.map((c: any[]) => c[0]);
    expect(joined).not.toContain('staff');
    expect(joined.some((r: string) => r.startsWith('region:'))).toBe(false);
  });

  it('routes a region-bearing event to that region room, not the whole staff room', async () => {
    const { gw, emit } = makeGateway(null, 'SOUTH');
    (gw as any).emitOperational('branch:updated', { branchId: 'b1', name: 'Chennai Main' });
    await new Promise((r) => setImmediate(r));
    expect((gw as any).server.to).toHaveBeenCalledWith('region:SOUTH');
    expect((gw as any).server.to).not.toHaveBeenCalledWith('staff');
    expect(emit).toHaveBeenCalled();
  });

  // Events with no resolvable region (client, zone, billing) keep the previous behaviour
  // rather than being dropped.
  it('falls back to the staff room when the event has no region', async () => {
    const { gw } = makeGateway(null, null);
    (gw as any).emitOperational('client:updated', { clientId: 'c1' });
    await new Promise((r) => setImmediate(r));
    expect((gw as any).server.to).toHaveBeenCalledWith('staff');
  });

  it('does not drop an event when region resolution throws', async () => {
    const { gw } = makeGateway(null, null);
    (gw as any).regionGuard.resolveEventRegion = jest.fn().mockRejectedValue(new Error('db down'));
    (gw as any).emitOperational('branch:updated', { branchId: 'b1' });
    await new Promise((r) => setImmediate(r));
    expect((gw as any).server.to).toHaveBeenCalledWith('staff');
  });
});

/**
 * Negotiation event routing.
 *
 * A fee negotiation runs on `assignment:counter-offered`, and that event had no case in
 * `broadcastEvent` at all — it fell through to the generic path, whose only delivery is
 * `emitOperational` (staff / region / org). Assayers are deliberately excluded from those rooms,
 * so the desk's counter never reached the phone that had to answer it: the assayer saw the old
 * fee until they pulled to refresh, while the web app saw the assayer's counters live. These
 * cases pin both directions.
 */
describe('EventsGateway — negotiation event routing', () => {
  const ASSIGNMENT_ID = '11111111-1111-1111-1111-111111111111';

  const makeGateway = (eventRegion: string | null = 'WEST') => {
    const guard = {
      getUserRegions: jest.fn().mockResolvedValue(null),
      resolveEventRegion: jest.fn().mockResolvedValue(eventRegion),
    };
    const gw = new EventsGateway({} as any, new DomainEventPublisher(), guard as any);
    const emit = jest.fn();
    (gw as any).server = { to: jest.fn().mockReturnValue({ emit }) };
    return { gw, emit };
  };

  /** `emitOperational` resolves the region asynchronously and emits on the microtask queue. */
  const settle = () => new Promise((r) => setImmediate(r));

  const counterOffer = {
    eventType: 'assignment:counter-offered',
    assignmentId: ASSIGNMENT_ID,
    assayerId: 'assayer-1',
    proposedFee: 1800,
    userId: 'ops-1',
  };

  it('delivers a counter-offer to the assayer it concerns', async () => {
    const { gw } = makeGateway();
    gw.broadcastEvent('assignment:counter-offered', counterOffer);
    await settle();
    expect((gw as any).server.to).toHaveBeenCalledWith('user:assayer-1');
  });

  it('delivers a counter-offer to the room watching that assignment', async () => {
    const { gw } = makeGateway();
    gw.broadcastEvent('assignment:counter-offered', counterOffer);
    await settle();
    expect((gw as any).server.to).toHaveBeenCalledWith(`assignment:${ASSIGNMENT_ID}`);
  });

  // The direction that already worked must keep working.
  it('still delivers a counter-offer to the desk, scoped to the branch region', async () => {
    const { gw } = makeGateway('WEST');
    gw.broadcastEvent('assignment:counter-offered', counterOffer);
    await settle();
    expect((gw as any).server.to).toHaveBeenCalledWith('region:WEST');
  });

  it('emits under the counter-offered name the clients subscribe to', async () => {
    const { gw, emit } = makeGateway();
    gw.broadcastEvent('assignment:counter-offered', counterOffer);
    await settle();
    expect(emit).toHaveBeenCalledWith('assignment:counter-offered', counterOffer);
  });

  /**
   * `assignment:created` and `assignment:fee-updated` reached the desk only through `org:`, and
   * most tokens issued here carry no organizationId — so a new offer and an agreed fee, the two
   * numbers a negotiation starts and ends on, moved the assayer's phone and not the desk.
   */
  it('delivers a fee update to the desk, not only to the org room', async () => {
    const { gw } = makeGateway('SOUTH');
    gw.broadcastEvent('assignment:fee-updated', {
      eventType: 'assignment:fee-updated',
      assignmentId: ASSIGNMENT_ID,
      assayerId: 'assayer-1',
      agreedFee: 2000,
    });
    await settle();
    expect((gw as any).server.to).toHaveBeenCalledWith('user:assayer-1');
    expect((gw as any).server.to).toHaveBeenCalledWith('region:SOUTH');
  });

  it('delivers a newly created assignment to the desk as well as the assayer', async () => {
    const { gw } = makeGateway('NORTH');
    gw.broadcastEvent('assignment:created', {
      eventType: 'assignment:created',
      assignmentId: ASSIGNMENT_ID,
      assayerId: 'assayer-1',
    });
    await settle();
    expect((gw as any).server.to).toHaveBeenCalledWith('user:assayer-1');
    expect((gw as any).server.to).toHaveBeenCalledWith('region:NORTH');
  });
});

/**
 * Room entitlement — carried over from the branch that added it.
 *
 * Main's realtime work was newer in every other respect, but it had reverted the join to a bare
 * authentication check, so any principal could subscribe to any assignment or query UUID. These
 * cases are what stop that coming back.
 */
describe('EventsGateway — room subscription entitlement', () => {
  const ASSIGNMENT_ID = '11111111-1111-1111-1111-111111111111';
  const QUERY_ID = '22222222-2222-2222-2222-222222222222';

  // Rows returned by the mocked lookups; tests overwrite per scenario.
  let assignmentRow: any;
  let queryRow: any;
  let userRow: any;
  let feedbackRow: any;

  let assignmentRepo: { createQueryBuilder: jest.Mock };
  let queryRepo: { createQueryBuilder: jest.Mock };
  let userRepo: { findOne: jest.Mock };
  let feedbackRepo: { createQueryBuilder: jest.Mock };
  let gateway: EventsGateway;

  const makeQueryBuilder = (row: () => any) => {
    const qb: any = {};
    for (const method of ['leftJoin', 'select', 'addSelect', 'where']) {
      qb[method] = jest.fn(() => qb);
    }
    qb.getRawOne = jest.fn(async () => row());
    return qb;
  };

  const makeClient = (user: { id: string; roles?: any[] }) => ({
    id: 'socket-1',
    user,
    emit: jest.fn(),
    join: jest.fn(),
    leave: jest.fn(),
  });

  beforeEach(() => {
    assignmentRow = null;
    queryRow = null;
    userRow = null;
    feedbackRow = null;

    assignmentRepo = { createQueryBuilder: jest.fn(() => makeQueryBuilder(() => assignmentRow)) };
    queryRepo = { createQueryBuilder: jest.fn(() => makeQueryBuilder(() => queryRow)) };
    userRepo = { findOne: jest.fn(async () => userRow) };
    feedbackRepo = { createQueryBuilder: jest.fn(() => makeQueryBuilder(() => feedbackRow)) };

    const dataSource = {
      getRepository: jest.fn((entity: any) => {
        if (entity === AssignmentEntity) return assignmentRepo;
        if (entity === ValidationQueryEntity) return queryRepo;
        if (entity === UserEntity) return userRepo;
        if (entity === FeedbackThreadEntity) return feedbackRepo;
        throw new Error('Unexpected repository request');
      }),
    };

    gateway = new EventsGateway(
      {} as any,
      new DomainEventPublisher(),
      new RegionGuardService(dataSource as any, { get: jest.fn().mockResolvedValue('log') } as any),
    );
  });

  it('refuses an assayer subscribing to another assayer\'s assignment', async () => {
    assignmentRow = { id: ASSIGNMENT_ID, assayerId: 'assayer-1', region: 'WEST' };
    const client = makeClient({ id: 'assayer-2', roles: [{ name: 'ASSAYER' }] });

    await gateway.handleSubscribeAssignment(client as any, ASSIGNMENT_ID);

    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('error', {
      message: `Not authorized to subscribe to assignment:${ASSIGNMENT_ID}`,
    });
    // An external principal is refused outright — never promoted to the staff region path.
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('admits the assignment\'s own assayer', async () => {
    assignmentRow = { id: ASSIGNMENT_ID, assayerId: 'assayer-1', region: 'WEST' };
    const client = makeClient({ id: 'assayer-1', roles: [{ name: 'ASSAYER' }] });

    await gateway.handleSubscribeAssignment(client as any, ASSIGNMENT_ID);

    expect(client.join).toHaveBeenCalledWith(`assignment:${ASSIGNMENT_ID}`);
    expect(client.emit).not.toHaveBeenCalled();
  });

  it('refuses a staff user whose regions do not cover the assignment\'s branch region', async () => {
    assignmentRow = { id: ASSIGNMENT_ID, assayerId: 'assayer-1', region: 'WEST' };
    userRow = { id: 'staff-1', regions: ['NORTH'] };
    const client = makeClient({ id: 'staff-1', roles: [{ name: 'OPERATIONS' }] });

    await gateway.handleSubscribeAssignment(client as any, ASSIGNMENT_ID);

    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('error', {
      message: `Not authorized to subscribe to assignment:${ASSIGNMENT_ID}`,
    });
  });

  it('admits a staff user whose regions cover the branch region', async () => {
    assignmentRow = { id: ASSIGNMENT_ID, assayerId: 'assayer-1', region: 'WEST' };
    userRow = { id: 'staff-1', regions: ['WEST', 'SOUTH'] };
    const client = makeClient({ id: 'staff-1', roles: [{ name: 'OPERATIONS' }] });

    await gateway.handleSubscribeAssignment(client as any, ASSIGNMENT_ID);

    expect(client.join).toHaveBeenCalledWith(`assignment:${ASSIGNMENT_ID}`);
  });

  it('admits an unrestricted staff account (no region assignment)', async () => {
    assignmentRow = { id: ASSIGNMENT_ID, assayerId: 'assayer-1', region: 'WEST' };
    userRow = { id: 'staff-1', regions: null };
    const client = makeClient({ id: 'staff-1', roles: [{ name: 'ADMIN' }] });

    await gateway.handleSubscribeAssignment(client as any, ASSIGNMENT_ID);

    expect(client.join).toHaveBeenCalledWith(`assignment:${ASSIGNMENT_ID}`);
  });

  it('refuses a restricted staff account when the assignment resolves to no branch region', async () => {
    // Same direction the HTTP scope filter fails: over-filter, never leak.
    assignmentRow = { id: ASSIGNMENT_ID, assayerId: 'assayer-1', region: null };
    userRow = { id: 'staff-1', regions: ['NORTH'] };
    const client = makeClient({ id: 'staff-1', roles: [{ name: 'OPERATIONS' }] });

    await gateway.handleSubscribeAssignment(client as any, ASSIGNMENT_ID);

    expect(client.join).not.toHaveBeenCalled();
  });

  it('refuses a client user even for an assignment in their org', async () => {
    assignmentRow = { id: ASSIGNMENT_ID, assayerId: 'assayer-1', region: 'WEST' };
    const client = makeClient({ id: 'client-user-1', roles: [{ name: 'CLIENT_USER' }] });

    await gateway.handleSubscribeAssignment(client as any, ASSIGNMENT_ID);

    expect(client.join).not.toHaveBeenCalled();
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('refuses an unknown assignment id without caching the verdict', async () => {
    assignmentRow = null;
    const client = makeClient({ id: 'assayer-1', roles: [{ name: 'ASSAYER' }] });

    await gateway.handleSubscribeAssignment(client as any, ASSIGNMENT_ID);
    expect(client.join).not.toHaveBeenCalled();

    // The assignment appears (e.g. the client subscribed off a `created` event that raced
    // persistence) — the next attempt must re-check rather than replay a pinned refusal.
    assignmentRow = { id: ASSIGNMENT_ID, assayerId: 'assayer-1', region: 'WEST' };
    await gateway.handleSubscribeAssignment(client as any, ASSIGNMENT_ID);
    expect(client.join).toHaveBeenCalledWith(`assignment:${ASSIGNMENT_ID}`);
  });

  it('caches the verdict per socket so repeated subscribes do not re-query', async () => {
    assignmentRow = { id: ASSIGNMENT_ID, assayerId: 'assayer-1', region: 'WEST' };
    const client = makeClient({ id: 'assayer-1', roles: [{ name: 'ASSAYER' }] });

    await gateway.handleSubscribeAssignment(client as any, ASSIGNMENT_ID);
    await gateway.handleSubscribeAssignment(client as any, ASSIGNMENT_ID);

    expect(assignmentRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(client.join).toHaveBeenCalledTimes(2);
  });

  it('refuses a malformed id without touching the database', async () => {
    const client = makeClient({ id: 'assayer-1', roles: [{ name: 'ASSAYER' }] });

    await gateway.handleSubscribeAssignment(client as any, 'not-a-uuid' as any);

    expect(assignmentRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('error', expect.objectContaining({ message: expect.any(String) }));
  });

  it('refuses an assayer subscribing to another assayer\'s query thread', async () => {
    queryRow = { id: QUERY_ID, assayerId: 'assayer-1', raisedByUserId: 'staff-9', region: 'WEST' };
    const client = makeClient({ id: 'assayer-2', roles: [{ name: 'ASSAYER' }] });

    await gateway.handleSubscribeQuery(client as any, QUERY_ID);

    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('error', {
      message: `Not authorized to subscribe to query:${QUERY_ID}`,
    });
  });

  it('admits the query\'s own assayer and its raiser', async () => {
    queryRow = { id: QUERY_ID, assayerId: 'assayer-1', raisedByUserId: 'staff-9', region: 'WEST' };

    const assayer = makeClient({ id: 'assayer-1', roles: [{ name: 'ASSAYER' }] });
    await gateway.handleSubscribeQuery(assayer as any, QUERY_ID);
    expect(assayer.join).toHaveBeenCalledWith(`query:${QUERY_ID}`);

    const raiser = makeClient({ id: 'staff-9', roles: [{ name: 'VALIDATION' }] });
    await gateway.handleSubscribeQuery(raiser as any, QUERY_ID);
    expect(raiser.join).toHaveBeenCalledWith(`query:${QUERY_ID}`);
  });

  it('refuses a staff user out of region for a query thread', async () => {
    queryRow = { id: QUERY_ID, assayerId: 'assayer-1', raisedByUserId: 'staff-9', region: 'WEST' };
    userRow = { id: 'staff-1', regions: ['EAST'] };
    const client = makeClient({ id: 'staff-1', roles: [{ name: 'VALIDATION' }] });

    await gateway.handleSubscribeQuery(client as any, QUERY_ID);

    expect(client.join).not.toHaveBeenCalled();
  });

  /**
   * subscribe:feedback used to be a bare `if (client.user?.id) join(...)` — any authenticated
   * socket, an assayer included, could subscribe to any feedback thread by guessing its UUID
   * and receive internal team messages. These pin the restored entitlement gate.
   */
  const THREAD_ID = '33333333-3333-3333-3333-333333333333';

  it('refuses a socket that is neither the reporter nor on the feedback team', async () => {
    feedbackRow = { id: THREAD_ID, reporterUserId: 'reporter-1', reporterAssayerId: null };
    const client = makeClient({ id: 'assayer-2', roles: [{ name: 'ASSAYER' }] });

    await gateway.handleSubscribeFeedback(client as any, THREAD_ID);

    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('error', {
      message: `Not authorized to subscribe to feedback:${THREAD_ID}`,
    });
  });

  it('admits the thread\'s own reporter, by user id', async () => {
    feedbackRow = { id: THREAD_ID, reporterUserId: 'reporter-1', reporterAssayerId: null };
    const client = makeClient({ id: 'reporter-1', roles: [{ name: 'OPERATIONS' }] });

    await gateway.handleSubscribeFeedback(client as any, THREAD_ID);

    expect(client.join).toHaveBeenCalledWith(`feedback:${THREAD_ID}`);
  });

  it('admits the thread\'s own reporter, by assayer id', async () => {
    feedbackRow = { id: THREAD_ID, reporterUserId: null, reporterAssayerId: 'assayer-1' };
    const client = makeClient({ id: 'assayer-1', roles: [{ name: 'ASSAYER' }] });

    await gateway.handleSubscribeFeedback(client as any, THREAD_ID);

    expect(client.join).toHaveBeenCalledWith(`feedback:${THREAD_ID}`);
  });

  it('admits a feedback-team member who is not the reporter', async () => {
    feedbackRow = { id: THREAD_ID, reporterUserId: 'reporter-1', reporterAssayerId: null };
    const client = makeClient({ id: 'admin-1', roles: [{ name: 'ADMIN' }] });

    await gateway.handleSubscribeFeedback(client as any, THREAD_ID);

    expect(client.join).toHaveBeenCalledWith(`feedback:${THREAD_ID}`);
  });

  it('refuses an unknown feedback thread id', async () => {
    feedbackRow = null;
    const client = makeClient({ id: 'assayer-1', roles: [{ name: 'ASSAYER' }] });

    await gateway.handleSubscribeFeedback(client as any, THREAD_ID);

    expect(client.join).not.toHaveBeenCalled();
  });
});

/**
 * Per-socket subscribe budget. Every subscribe:* handler can run an uncached DB verdict on a
 * not-found id, so a client spraying random UUIDs could previously issue an unbounded stream of
 * queries. This caps attempts per socket without affecting any real client.
 */
describe('EventsGateway — subscribe rate budget', () => {
  const ASSIGNMENT_ID = '11111111-1111-1111-1111-111111111111';

  const makeClient = (user: { id: string; roles?: any[] }) => ({
    id: 'socket-1',
    user,
    emit: jest.fn(),
    join: jest.fn(),
    leave: jest.fn(),
  });

  it('refuses further subscribe attempts once the per-socket budget is spent', async () => {
    const dataSource = {
      // Every lookup refuses cleanly (unknown id) — the point here is the attempt count, not
      // the entitlement outcome.
      getRepository: jest.fn(() => ({
        createQueryBuilder: jest.fn(() => {
          const qb: any = {};
          for (const method of ['leftJoin', 'select', 'addSelect', 'where']) qb[method] = jest.fn(() => qb);
          qb.getRawOne = jest.fn(async () => null);
          return qb;
        }),
      })),
    };
    const gateway = new EventsGateway(
      {} as any,
      new DomainEventPublisher(),
      new RegionGuardService(dataSource as any, { get: jest.fn().mockResolvedValue('log') } as any),
    );
    const client = makeClient({ id: 'assayer-1', roles: [{ name: 'ASSAYER' }] });

    for (let i = 0; i < 60; i++) {
      await gateway.handleSubscribeAssignment(client as any, ASSIGNMENT_ID);
    }
    client.emit.mockClear();

    await gateway.handleSubscribeAssignment(client as any, ASSIGNMENT_ID);

    expect(client.emit).toHaveBeenCalledWith('error', {
      message: 'Too many subscription attempts; please slow down.',
    });
  });

  it('does not budget one socket against another', async () => {
    const dataSource = {
      getRepository: jest.fn(() => ({
        createQueryBuilder: jest.fn(() => {
          const qb: any = {};
          for (const method of ['leftJoin', 'select', 'addSelect', 'where']) qb[method] = jest.fn(() => qb);
          qb.getRawOne = jest.fn(async () => null);
          return qb;
        }),
      })),
    };
    const gateway = new EventsGateway(
      {} as any,
      new DomainEventPublisher(),
      new RegionGuardService(dataSource as any, { get: jest.fn().mockResolvedValue('log') } as any),
    );
    const spent = makeClient({ id: 'assayer-1', roles: [{ name: 'ASSAYER' }] });
    for (let i = 0; i < 60; i++) {
      await gateway.handleSubscribeAssignment(spent as any, ASSIGNMENT_ID);
    }

    const fresh = makeClient({ id: 'assayer-2', roles: [{ name: 'ASSAYER' }] });
    await gateway.handleSubscribeAssignment(fresh as any, ASSIGNMENT_ID);

    expect(fresh.emit).not.toHaveBeenCalledWith('error', {
      message: 'Too many subscription attempts; please slow down.',
    });
  });
});
