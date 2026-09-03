import { EventsGateway } from './events.gateway';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

/**
 * A restricted session gets no socket either.
 *
 * `JwtAuthGuard` refuses an onboarding principal on every HTTP route outside registration, and
 * refuses anybody still holding an issued password on every route but the one that changes it.
 * Neither guard runs on the WebSocket path: `handleConnection` verifies the token's signature and
 * joins rooms straight from its payload. Both gates therefore stopped at the HTTP boundary, and
 * the socket was a way round them.
 *
 * No exposure existed when this was written — 1,155 of 1,163 assayers have no `organization_id`,
 * so an onboarding session's `org:` room is empty and the only `role:` broadcast goes to
 * super-admins. That is a fact about this deployment's data, not about the design. Give such a
 * person an organisation and they would receive that org's assignment changes, counter-offers and
 * fee updates live, with the HTTP guard none the wiser.
 */
describe('the socket honours the same gates as the HTTP guard', () => {
  const gatewayFor = (assayer: any) => new EventsGateway(
    { verifyAsync: jest.fn().mockResolvedValue({ sub: 'asr-1', roles: [], organizationId: 'org-1' }) } as any,
    new DomainEventPublisher(),
    { resolveEventRegion: jest.fn().mockResolvedValue(null) } as any,
    { findOne: jest.fn().mockResolvedValue(assayer) } as any,
  );

  const client = () => ({
    handshake: { auth: { token: 'signed.jwt' }, query: {} },
    emit: jest.fn(),
    disconnect: jest.fn(),
    join: jest.fn().mockResolvedValue(undefined),
    id: 'sock-1',
  }) as any;

  it('refuses a session that may only finish registering', async () => {
    const c = client();
    await gatewayFor({ id: 'asr-1', lifecycleStatus: 'DOCUMENT_VERIFICATION', mustChangePassword: false })
      .handleConnection(c);

    expect(c.disconnect).toHaveBeenCalled();
    expect(c.join).not.toHaveBeenCalled();
    expect(c.emit).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ code: 'REGISTRATION_IN_PROGRESS' }));
  });

  it('refuses a session still on a password somebody else chose', async () => {
    const c = client();
    await gatewayFor({ id: 'asr-1', lifecycleStatus: 'ACTIVE', mustChangePassword: true })
      .handleConnection(c);

    expect(c.disconnect).toHaveBeenCalled();
    expect(c.emit).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ code: 'PASSWORD_CHANGE_REQUIRED' }));
  });

  it('reports the password change first when both apply', async () => {
    // Same ordering as the HTTP guard. Telling a freshly invited assayer their registration is
    // incomplete, when what blocks them is a password they can change themselves, sends them to
    // their HR contact for nothing.
    const c = client();
    await gatewayFor({ id: 'asr-1', lifecycleStatus: 'INVITED', mustChangePassword: true })
      .handleConnection(c);

    expect(c.emit).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ code: 'PASSWORD_CHANGE_REQUIRED' }));
  });

  it('lets an active assayer connect', async () => {
    const c = client();
    await gatewayFor({ id: 'asr-1', lifecycleStatus: 'ACTIVE', mustChangePassword: false })
      .handleConnection(c);

    expect(c.disconnect).not.toHaveBeenCalled();
    expect(c.join).toHaveBeenCalledWith('user:asr-1');
  });

  it('lets a staff principal connect — the lookup finds no assayer row', async () => {
    // Staff ids never match an assayer, so the lookup returns null and the gate must not fire.
    // Treating "not found" as restricted would disconnect every member of staff.
    const c = client();
    await gatewayFor(null).handleConnection(c);

    expect(c.disconnect).not.toHaveBeenCalled();
    expect(c.join).toHaveBeenCalledWith('user:asr-1');
  });
});
