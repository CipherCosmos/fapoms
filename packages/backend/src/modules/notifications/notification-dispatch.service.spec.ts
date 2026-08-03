import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationCategory, NotificationStatus } from '@fapoms/shared';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationEntity } from './notification.entity';
import { UserEntity } from '../user/user.entity';
import { AuditService } from '../../core/audit/audit.service';
import { NOTIFICATION_CATALOG, renderTemplate } from './notification-catalog';
import { NOTIFICATION_QUEUE } from './notification-delivery.worker';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

describe('NotificationDispatchService', () => {
  let service: NotificationDispatchService;
  let insertedRows: any[];
  let auditCalls: any[];
  let queuedJobs: any[];

  const mockQueue = { add: jest.fn(async (name: string, data: any) => { queuedJobs.push({ name, data }); return { id: '1' }; }) };
  const publishCalls: any[] = [];
  const mockEventPublisher = { publish: jest.fn((event: string, payload: any) => { publishCalls.push({ event, payload }); }) };

  const mockUserQb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
  };

  let idCounter = 0;

  const mockNotifRepo = {
    createQueryBuilder: jest.fn(() => ({
      insert: () => ({
        into: () => ({
          values: (rows: any[]) => {
            insertedRows = rows;
            return {
              orIgnore: () => ({ execute: async () => ({ identifiers: [] }) }),
            };
          },
        }),
      }),
      update: () => ({ set: () => ({ where: () => ({ andWhere: () => ({ execute: jest.fn() }) }) }) }),
    })),
    // The mock never simulates a real unique-constraint skip (that's a Postgres
    // concern, proven live against the real index, not a unit-test concern) —
    // so this always reports every attempted row as having been created, which
    // is exactly the behaviour every existing assertion below already expects.
    find: jest.fn(async ({ where }: any) => {
      return insertedRows
        .filter((r) => r.groupKey === where.groupKey)
        .map((r) => ({ ...r, id: `row-${++idCounter}`, createdAt: new Date() }));
    }),
  };

  beforeEach(async () => {
    insertedRows = [];
    auditCalls = [];
    queuedJobs = [];
    publishCalls.length = 0;
    mockQueue.add.mockClear();
    mockUserQb.getMany.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDispatchService,
        { provide: getRepositoryToken(NotificationEntity), useValue: mockNotifRepo },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: { createQueryBuilder: jest.fn(() => mockUserQb) },
        },
        { provide: getQueueToken(NOTIFICATION_QUEUE), useValue: mockQueue },
        { provide: DomainEventPublisher, useValue: mockEventPublisher },
        {
          provide: AuditService,
          useValue: { recordEvent: jest.fn(async (e) => { auditCalls.push(e); return e; }) },
        },
      ],
    }).compile();

    service = module.get(NotificationDispatchService);
  });

  it('fans one event out to every active holder of the catalogued roles', async () => {
    mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }, { id: 'ops-2' }, { id: 'admin-1' }]);

    const res = await service.emit({
      type: 'ASSIGNMENT_ESCALATED',
      entityType: 'ASSIGNMENT',
      entityId: 'asn-1',
      actorUserId: 'someone-else',
      payload: { branchName: 'Thrissur', reason: 'Client escalated.' },
    });

    expect(res.created).toBe(3);
    expect(res.recipients.userIds).toEqual(expect.arrayContaining(['ops-1', 'ops-2', 'admin-1']));
    expect(insertedRows).toHaveLength(3);
  });

  it('does not notify the person who performed the action', async () => {
    mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }, { id: 'ops-2' }]);

    const res = await service.emit({
      type: 'ASSIGNMENT_ACCEPTED',
      entityId: 'asn-1',
      actorUserId: 'ops-1',
      payload: { assayerName: 'R. Nair', branchName: 'Thrissur' },
    });

    expect(res.recipients.userIds).toEqual(['ops-2']);
  });

  it('renders the template with real values and marks in-app rows delivered', async () => {
    mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);

    await service.emit({
      type: 'ASSIGNMENT_REJECTED',
      entityId: 'asn-1',
      payload: { assayerName: 'R. Nair', branchName: 'Thrissur', reason: 'Double booked' },
    });

    expect(insertedRows[0].message).toContain('R. Nair');
    expect(insertedRows[0].message).toContain('Thrissur');
    expect(insertedRows[0].message).toContain('Double booked');
    expect(insertedRows[0].status).toBe(NotificationStatus.DELIVERED);
    expect(insertedRows[0].category).toBe(NotificationCategory.ASSIGNMENT);
  });

  it('gives each recipient of one event a distinct dedupe key', async () => {
    mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }, { id: 'ops-2' }]);

    await service.emit({
      type: 'ASSIGNMENT_ESCALATED',
      entityId: 'asn-1',
      payload: {},
    });

    const keys = insertedRows.map((r) => r.dedupeKey);
    expect(new Set(keys).size).toBe(2);
    keys.forEach((k) => expect(k).toContain('ASSIGNMENT_ESCALATED:asn-1'));
  });

  it('routes an assayer-targeted event to the assayer, not to a user row', async () => {
    mockUserQb.getMany.mockResolvedValue([]);

    const res = await service.emit({
      type: 'ASSIGNMENT_OFFERED',
      entityId: 'asn-1',
      assayerId: 'assayer-9',
      payload: { branchName: 'Thrissur', scheduledDate: '2026-08-10' },
    });

    expect(res.recipients.assayerIds).toEqual(['assayer-9']);
    expect(insertedRows[0].assayerId).toBe('assayer-9');
    expect(insertedRows[0].userId).toBeNull();
  });

  it('records an audit event so "nobody told me" is answerable', async () => {
    mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);

    await service.emit({
      type: 'ASSIGNMENT_ESCALATED', entityId: 'asn-1', payload: {}, actorUserId: 'u-1',
    });

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].eventType).toBe('NOTIFICATION_ASSIGNMENT_ESCALATED');
    expect(auditCalls[0].metadata.userIds).toEqual(['ops-1']);
  });

  it('an unknown event type sends nothing rather than throwing into the caller', async () => {
    const res = await service.emit({ type: 'NOT_A_REAL_EVENT', payload: {} });
    expect(res.created).toBe(0);
    expect(insertedRows).toHaveLength(0);
  });

  it('never lets a notification failure escape into the business action', async () => {
    mockUserQb.getMany.mockRejectedValue(new Error('db is down'));
    expect(() =>
      service.emitSafe({ type: 'ASSIGNMENT_ESCALATED', entityId: 'a', payload: {} }),
    ).not.toThrow();
  });

  describe('real-time', () => {
    it('publishes one notification:new event per recipient actually created', async () => {
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }, { id: 'ops-2' }]);

      await service.emit({
        type: 'ASSIGNMENT_ESCALATED', entityId: 'asn-1',
        payload: { branchName: 'Thrissur' },
      });

      expect(publishCalls).toHaveLength(2);
      expect(publishCalls.every((c) => c.event === 'notification:new')).toBe(true);
      expect(publishCalls.map((c) => c.payload.userId).sort()).toEqual(['ops-1', 'ops-2']);
    });

    it('carries the assayer id, not a user id, for an assayer-targeted event', async () => {
      mockUserQb.getMany.mockResolvedValue([]);

      await service.emit({
        type: 'ASSIGNMENT_OFFERED', entityId: 'asn-1', assayerId: 'assayer-9',
        payload: { branchName: 'Thrissur', scheduledDate: '2026-09-10' },
      });

      expect(publishCalls).toHaveLength(1);
      expect(publishCalls[0].payload.assayerId).toBe('assayer-9');
      expect(publishCalls[0].payload.userId).toBeNull();
    });

    it('a broken publisher does not stop the notification from being created', async () => {
      mockEventPublisher.publish.mockImplementationOnce(() => { throw new Error('socket down'); });
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);

      await expect(
        service.emit({ type: 'ASSIGNMENT_ESCALATED', entityId: 'asn-1', payload: {} }),
      ).resolves.toEqual(expect.objectContaining({ created: 1 }));
    });
  });

  describe('queue hand-off', () => {
    it('enqueues one push job per recipient of a push-carrying event', async () => {
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }, { id: 'ops-2' }]);

      await service.emit({ type: 'ASSIGNMENT_ESCALATED', entityId: 'asn-1', payload: {} });

      expect(queuedJobs).toHaveLength(2);
      expect(queuedJobs[0].name).toBe('deliver');
    });

    it('enqueues nothing for an in-app-only event', async () => {
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);

      await service.emit({ type: 'ASSIGNMENT_ACCEPTED', entityId: 'asn-1', payload: {} });

      expect(queuedJobs).toHaveLength(0);
    });

    it('a dead queue delays the push instead of failing the business action', async () => {
      // Redis down. The rows are already written, so the sweeper will find them;
      // what must not happen is this throwing back into the caller.
      mockQueue.add.mockRejectedValueOnce(new Error('Redis connection lost'));
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);

      await expect(
        service.emit({ type: 'ASSIGNMENT_ESCALATED', entityId: 'asn-1', payload: {} }),
      ).resolves.toEqual(expect.objectContaining({ created: 1 }));
    });
  });

  describe('catalog integrity', () => {
    it('every entry resolves to at least one recipient source', () => {
      for (const [name, def] of Object.entries(NOTIFICATION_CATALOG)) {
        expect(def.roles.length + (def.special?.length ?? 0)).toBeGreaterThan(0);
      }
    });

    it('no template placeholder renders as the literal word undefined', () => {
      for (const def of Object.values(NOTIFICATION_CATALOG)) {
        expect(renderTemplate(def.body, {})).not.toContain('undefined');
        expect(renderTemplate(def.title, {})).not.toContain('undefined');
      }
    });
  });
});
