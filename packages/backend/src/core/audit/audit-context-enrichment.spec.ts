import { AuditService } from './audit.service';
import { AuditEvent } from './audit-event';
import { AuditRepository } from './audit.repository';
import { EventCategory } from '@fapoms/shared';
import { runWithRequestContext } from '../context/request-context';

/**
 * The whole point of the ambient context: an ordinary call site records an event knowing only the
 * business facts, and the actor/IP/role/session/request-id are filled in from the request it runs
 * inside — so all ~36 existing emitters gain compliance metadata with no signature change. These
 * pin that enrichment, and the two rules that keep it honest: an explicit value always wins, and
 * outside a request nothing is invented.
 */
describe('AuditService — enrichment from request context', () => {
  let captured: AuditEvent | null;
  let service: AuditService;

  beforeEach(() => {
    captured = null;
    const repo: Partial<AuditRepository> = {
      append: jest.fn(async (event: AuditEvent) => {
        captured = event;
        return { id: 'evt-1' };
      }),
    };
    service = new AuditService(repo as AuditRepository);
  });

  const businessEvent = {
    category: EventCategory.OPERATIONAL,
    eventType: 'PROJECT_CREATED',
    entityType: 'PROJECT',
    entityId: '11111111-1111-4111-8111-111111111111',
  };

  it('fills actor, IP, role, session and request id from the ambient request', async () => {
    await runWithRequestContext(
      {
        userId: '22222222-2222-4222-8222-222222222222',
        displayName: 'Ada Ops',
        role: 'OPERATIONS',
        ipAddress: '203.0.113.5',
        userAgent: 'Mozilla/5.0',
        sessionId: 'sess-1',
        requestId: 'req-1',
      },
      () => service.recordEvent(businessEvent),
    );

    expect(captured).toMatchObject({
      userId: '22222222-2222-4222-8222-222222222222',
      userDisplayName: 'Ada Ops',
      actorRole: 'OPERATIONS',
      ipAddress: '203.0.113.5',
      userAgent: 'Mozilla/5.0',
      sessionId: 'sess-1',
      requestId: 'req-1',
      outcome: 'SUCCESS',
    });
  });

  it('never overrides a value the caller set explicitly (login records the actor pre-guard)', async () => {
    await runWithRequestContext(
      { userId: '22222222-2222-4222-8222-222222222222', ipAddress: '203.0.113.5' },
      () =>
        service.recordEvent({
          ...businessEvent,
          eventType: 'USER_LOGIN',
          userId: '33333333-3333-4333-8333-333333333333',
          ipAddress: '198.51.100.9',
        }),
    );

    expect(captured).toMatchObject({
      userId: '33333333-3333-4333-8333-333333333333',
      ipAddress: '198.51.100.9',
    });
  });

  it('invents nothing outside a request — background events stay actor-less', async () => {
    await service.recordEvent(businessEvent);
    expect(captured).toMatchObject({
      userId: null,
      actorRole: null,
      ipAddress: null,
      sessionId: null,
      requestId: null,
    });
  });
});
