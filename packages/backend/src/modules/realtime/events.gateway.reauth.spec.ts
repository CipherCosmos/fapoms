import { EventsGateway } from './events.gateway';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

/**
 * Socket authorization must be as revocable as it is grantable. Three fixes, all confirmed from
 * source during the 2026-09-04 assessment:
 *
 *  1. CONNECT STATUS GATE — the handshake verifies the JWT directly, not through `loadPrincipal`,
 *     so the assayer status gate added there did not cover the socket. A terminated / suspended /
 *     soft-deleted assayer holding a still-valid 15-minute token could open a socket and join rooms.
 *  2. REGION FAIL-CLOSED — a region lookup FAILURE at connect used to fall back to ALL_REGIONS
 *     (`.catch(() => null)` → national firehose). A restricted operator whose lookup errored joined
 *     every region's room. It must fail closed (no region rooms) instead.
 *  3. RE-AUTH ON CHANGE — rooms are joined once at connect and never re-evaluated, so a role
 *     downgrade / region removal / suspension left an already-connected socket receiving its old
 *     rooms' events for the connection's life. The gateway now drops the user's sockets on the
 *     `user:role-changed` / `user:updated` / `user:password-changed` events UserService publishes.
 */
describe('EventsGateway — socket re-authorization', () => {
  const makeClient = (id = 'sock-1') => ({
    id,
    handshake: { auth: { token: 'signed.jwt' }, query: {} },
    emit: jest.fn(),
    disconnect: jest.fn(),
    join: jest.fn().mockResolvedValue(undefined),
    user: undefined as any,
  });

  const build = (opts: {
    payload: any;
    assayer?: any;
    getUserRegions?: jest.Mock;
  }) => {
    const publisher = new DomainEventPublisher();
    const gateway = new EventsGateway(
      { verifyAsync: jest.fn().mockResolvedValue(opts.payload), decode: jest.fn() } as any,
      publisher,
      {
        getUserRegions: opts.getUserRegions ?? jest.fn().mockResolvedValue(null),
        resolveEventRegion: jest.fn().mockResolvedValue(null),
      } as any,
      { findOne: jest.fn().mockResolvedValue(opts.assayer ?? null) } as any,
    );
    return { gateway, publisher };
  };

  // ── 1. connect-time status gate (the socket side of the loadPrincipal fix) ──────────────
  it('refuses a TERMINATED assayer at connect (account closed, no rooms joined)', async () => {
    const { gateway } = build({
      payload: { sub: 'asr-1', roles: ['ASSAYER'] },
      assayer: { id: 'asr-1', lifecycleStatus: 'TERMINATED', mustChangePassword: false, isActive: true },
    });
    const c = makeClient();
    await gateway.handleConnection(c as any);
    expect(c.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'ACCOUNT_CLOSED' }));
    expect(c.disconnect).toHaveBeenCalled();
    expect(c.join).not.toHaveBeenCalled();
  });

  it('refuses a soft-deleted assayer (isActive:false) even while lifecycle still says ACTIVE', async () => {
    const { gateway } = build({
      payload: { sub: 'asr-1', roles: ['ASSAYER'] },
      assayer: { id: 'asr-1', lifecycleStatus: 'ACTIVE', mustChangePassword: false, isActive: false },
    });
    const c = makeClient();
    await gateway.handleConnection(c as any);
    expect(c.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'ACCOUNT_CLOSED' }));
    expect(c.disconnect).toHaveBeenCalled();
  });

  it('still lets an ACTIVE assayer connect', async () => {
    const { gateway } = build({
      payload: { sub: 'asr-1', roles: ['ASSAYER'] },
      assayer: { id: 'asr-1', lifecycleStatus: 'ACTIVE', mustChangePassword: false, isActive: true },
    });
    const c = makeClient();
    await gateway.handleConnection(c as any);
    expect(c.disconnect).not.toHaveBeenCalled();
    expect(c.join).toHaveBeenCalledWith('user:asr-1');
  });

  // ── 2. region rooms fail CLOSED on lookup error ─────────────────────────────────────────
  it('joins NO region room when the region lookup throws (fail-closed, not ALL_REGIONS)', async () => {
    const { gateway } = build({
      payload: { sub: 'op-1', roles: [{ name: 'OPERATIONS' }] },
      getUserRegions: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const c = makeClient();
    await gateway.handleConnection(c as any);
    const joined = c.join.mock.calls.map((a: any[]) => a[0]);
    expect(joined).toContain('user:op-1');
    expect(joined).toContain('staff');
    expect(joined.some((r: string) => r.startsWith('region:'))).toBe(false);
  });

  it('an unrestricted staff account (null regions, no error) still joins every region room', async () => {
    const { gateway } = build({
      payload: { sub: 'op-1', roles: [{ name: 'OPERATIONS' }] },
      getUserRegions: jest.fn().mockResolvedValue(null),
    });
    const c = makeClient();
    await gateway.handleConnection(c as any);
    const joined = c.join.mock.calls.map((a: any[]) => a[0]);
    expect(joined.some((r: string) => r.startsWith('region:'))).toBe(true);
  });

  // ── 3. an authorization change drops the live socket ────────────────────────────────────
  it.each(['user:role-changed', 'user:updated', 'user:password-changed'])(
    'disconnects a live socket on %s for that user',
    async (event) => {
      const { gateway, publisher } = build({ payload: { sub: 'op-1', roles: [{ name: 'OPERATIONS' }] } });
      const c = makeClient('sock-op-1');
      await gateway.handleConnection(c as any);
      expect(c.disconnect).not.toHaveBeenCalled(); // connected fine

      // Wire a minimal server registry so disconnectUserForReauth can find the socket.
      (gateway as any).server = {
        sockets: { sockets: new Map([['sock-op-1', c]]) },
        to: () => ({ emit: jest.fn() }),
      };

      publisher.publish(event, { userId: 'op-1' });

      expect(c.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'REAUTH_REQUIRED' }));
      expect(c.disconnect).toHaveBeenCalled();
    },
  );

  it('does not disconnect OTHER users on an auth-change event', async () => {
    const { gateway, publisher } = build({ payload: { sub: 'op-1', roles: [{ name: 'OPERATIONS' }] } });
    const c = makeClient('sock-op-1');
    await gateway.handleConnection(c as any);
    (gateway as any).server = { sockets: { sockets: new Map([['sock-op-1', c]]) }, to: () => ({ emit: jest.fn() }) };

    publisher.publish('user:role-changed', { userId: 'someone-else' });

    expect(c.disconnect).not.toHaveBeenCalled();
  });
});
