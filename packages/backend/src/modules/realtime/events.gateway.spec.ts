import { EventsGateway } from './events.gateway';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { UserEntity } from '../user/user.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';

describe('EventsGateway — socket authentication', () => {
  let gateway: EventsGateway;
  let mockJwtService: { verifyAsync: jest.Mock; decode: jest.Mock };

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
    gateway = new EventsGateway(
      mockJwtService as any,
      new DomainEventPublisher(),
      {} as RegionGuardService,
    );
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

/**
 * Room subscriptions are a read grant on the entity's whole event stream (status, schedule,
 * comments, fees), so a join must prove the same entitlement the HTTP layer would demand.
 * These tests run the real RegionGuardService over a mocked DataSource, so the actual
 * policy — owner shortcut, staff region membership, external refusal — is what is verified,
 * not a mock of it.
 */
describe('EventsGateway — room subscription entitlement', () => {
  const ASSIGNMENT_ID = '11111111-1111-1111-1111-111111111111';
  const QUERY_ID = '22222222-2222-2222-2222-222222222222';

  // Rows returned by the mocked lookups; tests overwrite per scenario.
  let assignmentRow: any;
  let queryRow: any;
  let userRow: any;

  let assignmentRepo: { createQueryBuilder: jest.Mock };
  let queryRepo: { createQueryBuilder: jest.Mock };
  let userRepo: { findOne: jest.Mock };
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

    assignmentRepo = { createQueryBuilder: jest.fn(() => makeQueryBuilder(() => assignmentRow)) };
    queryRepo = { createQueryBuilder: jest.fn(() => makeQueryBuilder(() => queryRow)) };
    userRepo = { findOne: jest.fn(async () => userRow) };

    const dataSource = {
      getRepository: jest.fn((entity: any) => {
        if (entity === AssignmentEntity) return assignmentRepo;
        if (entity === ValidationQueryEntity) return queryRepo;
        if (entity === UserEntity) return userRepo;
        throw new Error('Unexpected repository request');
      }),
    };

    gateway = new EventsGateway(
      {} as any,
      new DomainEventPublisher(),
      new RegionGuardService(dataSource as any),
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
});
