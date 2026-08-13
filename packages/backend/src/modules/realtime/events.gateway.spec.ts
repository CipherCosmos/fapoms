import { EventsGateway } from './events.gateway';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

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
    const client = await connect(gw, jwt, ['OPERATIONS_MANAGER']);
    const joined = client.join.mock.calls.map((c: any[]) => c[0]);
    expect(joined).toContain('region:WEST');
    expect(joined).not.toContain('region:SOUTH');
  });

  // An unassigned account is national; it must keep seeing everything it saw before.
  it('puts an unassigned staff account in every region room', async () => {
    const { gw, jwt } = makeGateway(null, null);
    const client = await connect(gw, jwt, ['HR_MANAGER']);
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
