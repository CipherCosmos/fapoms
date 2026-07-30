import { EventsGateway } from './events.gateway';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

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
    gateway = new EventsGateway(mockJwtService as any, new DomainEventPublisher());
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
