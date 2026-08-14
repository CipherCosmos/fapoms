import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationCategory, NotificationStatus } from '@fapoms/shared';
import { NotificationDispatchService } from './notification-dispatch.service';
import { EmailProvider } from '../../infrastructure/notifications/email-provider';
import { NotificationSettingsService } from './notification-settings.service';
import { NotificationEntity } from './notification.entity';
import { NotificationPreferenceEntity } from './notification-preference.entity';
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

  const mockQueue = {
    add: jest.fn(async (name: string, data: any) => { queuedJobs.push({ name, data }); return { id: '1' }; }),
    addBulk: jest.fn(async (jobs: any[]) => { for (const j of jobs) queuedJobs.push({ name: j.name, data: j.data }); return jobs.map((_, i) => ({ id: String(i) })); }),
  };
  const publishCalls: any[] = [];
  const mockEventPublisher = { publish: jest.fn((event: string, payload: any) => { publishCalls.push({ event, payload }); }) };

  /** Resolves to the shipped catalog entry unless a test says otherwise. */
  const mockSettings = {
    defFor: jest.fn(),
    effectiveCatalog: jest.fn(async () => ({})),
  };

  const mockUserQb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
  };

  let idCounter = 0;
  /** Saved preference rows. Empty = everybody opted in, which is the default state. */
  let mockPreferences: any[] = [];
  /** An unread notification the collapse lookup should find, or null for "no open burst". */
  let openBurstRow: any = null;
  let collapseUpdates: any[] = [];

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
      update: () => ({
        set: (values: any) => {
          collapseUpdates.push(values);
          return {
            where: () => ({ execute: jest.fn(), andWhere: () => ({ execute: jest.fn() }) }),
          };
        },
      }),
      // The collapse lookup: "is there still an unread one of this type for this recipient?"
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => openBurstRow),
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
    mockPreferences = [];
    openBurstRow = null;
    collapseUpdates = [];
    mockQueue.add.mockClear();
    mockQueue.addBulk.mockClear();
    mockUserQb.getMany.mockReset();
    mockSettings.defFor.mockReset();
    mockSettings.defFor.mockImplementation(async (t: string) => {
      const base = NOTIFICATION_CATALOG[t];
      return base ? { ...base, type: t, enabled: true, overridden: [], notes: null } : null;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDispatchService,
        { provide: getRepositoryToken(NotificationEntity), useValue: mockNotifRepo },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: { createQueryBuilder: jest.fn(() => mockUserQb) },
        },
        {
          // No saved preferences: everyone is opted in, which is the state these tests are about.
          // A recipient who has muted every channel a type uses is dropped before the insert —
          // see the "recipient preferences" block below.
          provide: getRepositoryToken(NotificationPreferenceEntity),
          useValue: {
            // Honours the category filter, because "does muting one category silence another?"
            // is a question this mock has to be able to answer wrongly for the test to mean
            // anything. The real query filters on category and recipient.
            find: jest.fn(async ({ where }: any) => {
              const categories = new Set(
                (Array.isArray(where) ? where : [where]).map((w: any) => w?.category).filter(Boolean),
              );
              return mockPreferences.filter((p) => categories.has(p.category));
            }),
          },
        },
        { provide: getQueueToken(NOTIFICATION_QUEUE), useValue: mockQueue },
        { provide: EmailProvider, useValue: { isEnabled: jest.fn().mockReturnValue(true), send: jest.fn() } },
        { provide: NotificationSettingsService, useValue: mockSettings },
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

  it('renders the template with real values', async () => {
    mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);

    await service.emit({
      type: 'ASSIGNMENT_REJECTED',
      entityId: 'asn-1',
      payload: { assayerName: 'R. Nair', branchName: 'Thrissur', reason: 'Double booked' },
    });

    expect(insertedRows[0].message).toContain('R. Nair');
    expect(insertedRows[0].message).toContain('Thrissur');
    expect(insertedRows[0].message).toContain('Double booked');
    expect(insertedRows[0].category).toBe(NotificationCategory.ASSIGNMENT);
  });

  it('leaves a row that still owes a push PENDING, so the delivery worker will send it', async () => {
    // ASSIGNMENT_REJECTED carries IN_APP *and* PUSH. Being born DELIVERED because the in-app
    // half was instant made the worker's terminal-state guard skip the push entirely — every
    // both-channel notification silently never reached a phone.
    mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);

    await service.emit({
      type: 'ASSIGNMENT_REJECTED',
      entityId: 'asn-1',
      payload: { assayerName: 'R. Nair', branchName: 'Thrissur', reason: 'Double booked' },
    });

    expect(insertedRows[0].status).toBe(NotificationStatus.PENDING);
    expect(insertedRows[0].deliveredAt).toBeNull();
  });

  it('marks an in-app-only row delivered on creation, since the row is the delivery', async () => {
    mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);

    await service.emit({
      type: 'ASSIGNMENT_ACCEPTED',
      entityId: 'asn-1',
      payload: { assayerName: 'R. Nair', branchName: 'Thrissur' },
    });

    expect(insertedRows[0].status).toBe(NotificationStatus.DELIVERED);
    expect(insertedRows[0].deliveredAt).toBeInstanceOf(Date);
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

  describe('operator overrides', () => {
    it('raises nothing at all for a type switched off in the admin screen', async () => {
      // Unit-testing defFor in isolation is not enough: this is the integration where a
      // legitimate "disabled" null was once mistaken for a failed lookup and quietly replaced
      // with the shipped default, so the off switch generated notifications anyway.
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }, { id: 'ops-2' }]);
      mockSettings.defFor.mockResolvedValueOnce(null);

      const res = await service.emit({ type: 'ASSIGNMENT_ESCALATED', entityId: 'asn-1', payload: {} });

      expect(res.created).toBe(0);
      expect(insertedRows).toHaveLength(0);
      expect(queuedJobs).toHaveLength(0);
    });

    it('still delivers on the shipped default when the settings lookup is broken', async () => {
      // The opposite failure: settings unreadable must never mean silence.
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);
      mockSettings.defFor.mockRejectedValueOnce(new Error('settings table gone'));

      const res = await service.emit({ type: 'ASSIGNMENT_ESCALATED', entityId: 'asn-1', payload: {} });

      expect(res.created).toBe(1);
    });

    it('uses the operator’s channels rather than the shipped ones', async () => {
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);
      mockSettings.defFor.mockResolvedValueOnce({
        ...NOTIFICATION_CATALOG['ASSIGNMENT_ESCALATED'],
        type: 'ASSIGNMENT_ESCALATED',
        enabled: true,
        overridden: ['channels'],
        notes: null,
        channels: ['IN_APP'],
      } as any);

      await service.emit({ type: 'ASSIGNMENT_ESCALATED', entityId: 'asn-1', payload: {} });

      expect(insertedRows[0].channels).toEqual(['IN_APP']);
      // No push job, and no email bookkeeping, because neither channel applies any more.
      expect(queuedJobs).toHaveLength(0);
      expect(insertedRows[0].emailStatus).toBeNull();
    });
  });

  describe('queue hand-off', () => {
    it('enqueues one push job and one email job per recipient of an escalation', async () => {
      // ASSIGNMENT_ESCALATED is a decision-forcing event: it pushes AND emails. Each channel
      // gets its own job so an FCM outage cannot burn email's retries, and vice versa.
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }, { id: 'ops-2' }]);

      await service.emit({ type: 'ASSIGNMENT_ESCALATED', entityId: 'asn-1', payload: {} });

      expect(queuedJobs.filter((j: any) => j.name === 'deliver')).toHaveLength(2);
      expect(queuedJobs.filter((j: any) => j.name === 'deliver-email')).toHaveLength(2);
    });

    it('enqueues nothing for an in-app-only event', async () => {
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);

      await service.emit({ type: 'ASSIGNMENT_ACCEPTED', entityId: 'asn-1', payload: {} });

      expect(queuedJobs).toHaveLength(0);
    });

    it('a dead queue delays the push instead of failing the business action', async () => {
      // Redis down. The rows are already written, so the sweeper will find them;
      // what must not happen is this throwing back into the caller.
      mockQueue.addBulk.mockRejectedValueOnce(new Error('Redis connection lost'));
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);

      await expect(
        service.emit({ type: 'ASSIGNMENT_ESCALATED', entityId: 'asn-1', payload: {} }),
      ).resolves.toEqual(expect.objectContaining({ created: 1 }));
    });
  });

  /**
   * Preferences were half-enforced: the delivery worker honoured `push`, and nothing anywhere
   * honoured `inApp`. A user who muted a category — through a dialog promising "you will stop
   * seeing these in your notification bell entirely" — kept receiving every one of them.
   */
  describe('recipient preferences', () => {
    it('drops a recipient who has muted every channel this type uses', async () => {
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }, { id: 'ops-2' }]);
      // ASSIGNMENT_ACCEPTED is in-app only, so in-app off is all of it.
      mockPreferences = [
        { userId: 'ops-1', assayerId: null, category: NotificationCategory.ASSIGNMENT, inApp: false, push: true },
      ];

      const res = await service.emit({
        type: 'ASSIGNMENT_ACCEPTED',
        entityId: 'asn-1',
        payload: { assayerName: 'R. Nair', branchName: 'Thrissur' },
      });

      expect(res.recipients.userIds).toEqual(['ops-2']);
      expect(insertedRows).toHaveLength(1);
    });

    it('still writes the row when in-app is off but push is on — the push is sent from it', async () => {
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);
      // ASSIGNMENT_REJECTED carries IN_APP and PUSH; only one of the two is muted.
      mockPreferences = [
        { userId: 'ops-1', assayerId: null, category: NotificationCategory.ASSIGNMENT, inApp: false, push: true },
      ];

      const res = await service.emit({
        type: 'ASSIGNMENT_REJECTED',
        entityId: 'asn-1',
        payload: { assayerName: 'R. Nair', branchName: 'Thrissur', reason: 'Double booked' },
      });

      // Hiding it from their bell is a read-side concern (NotificationService.findByUser);
      // dropping the row here would take the push with it.
      expect(res.created).toBe(1);
    });

    it('treats a missing preference row as opted in', async () => {
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);
      mockPreferences = [];

      const res = await service.emit({
        type: 'ASSIGNMENT_ACCEPTED',
        entityId: 'asn-1',
        payload: { assayerName: 'R. Nair', branchName: 'Thrissur' },
      });

      expect(res.created).toBe(1);
    });

    it('muting one category does not silence another', async () => {
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);
      mockPreferences = [
        { userId: 'ops-1', assayerId: null, category: NotificationCategory.WORKFORCE, inApp: false, push: false },
      ];

      const res = await service.emit({
        type: 'ASSIGNMENT_ACCEPTED',
        entityId: 'asn-1',
        payload: { assayerName: 'R. Nair', branchName: 'Thrissur' },
      });

      expect(res.created).toBe(1);
    });
  });

  /**
   * One operator action must not produce one notification per record. Measured: activating 25
   * assayers through the bulk lifecycle endpoint wrote 50 rows in a minute — 25 identical lines
   * into each of two operations users' bells.
   */
  describe('burst collapse', () => {
    const onboarded = () => service.emit({
      type: 'ASSAYER_ONBOARDED',
      entityType: 'ASSAYER',
      entityId: 'asr-1',
      assayerId: 'asr-1',
      payload: { assayerName: 'Shinil T' },
    });

    it('folds a second event into the unread one already in the bell', async () => {
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);
      openBurstRow = { id: 'notif-1', collapsedCount: 1, payload: { assayerName: 'R. Nair' }, link: '/hr' };

      const res = await onboarded();

      // No new row at all, which is also what keeps the push count down: pushes are enqueued
      // from inserted rows.
      expect(res.created).toBe(0);
      expect(res.suppressed).toBe(1);
      expect(insertedRows).toHaveLength(0);
    });

    it('rewrites the surviving row to the summary, counting both events', async () => {
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);
      openBurstRow = { id: 'notif-1', collapsedCount: 1, payload: { assayerName: 'R. Nair' }, link: '/hr' };

      await onboarded();

      expect(collapseUpdates).toHaveLength(1);
      expect(collapseUpdates[0].title).toBe('2 new assayers onboarded');
      // Counted in SQL, so parallel merges still add up rather than both writing 2.
      expect(typeof collapseUpdates[0].collapsedCount).toBe('function');
    });

    it('starts a new notification when nothing is open — the ordinary case is unchanged', async () => {
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);
      openBurstRow = null;

      const res = await onboarded();

      expect(res.created).toBe(1);
      expect(insertedRows[0].title).toBe('New assayer onboarded');
      expect(insertedRows[0].collapsedCount).toBeUndefined();
    });

    it('leaves a type with no collapse rule alone', async () => {
      mockUserQb.getMany.mockResolvedValue([{ id: 'ops-1' }]);
      // Would be found if the lookup ran at all; ASSIGNMENT_ACCEPTED declares no collapse.
      openBurstRow = { id: 'notif-1', collapsedCount: 1, payload: {}, link: null };

      const res = await service.emit({
        type: 'ASSIGNMENT_ACCEPTED',
        entityId: 'asn-1',
        payload: { assayerName: 'R. Nair', branchName: 'Thrissur' },
      });

      expect(res.created).toBe(1);
      expect(collapseUpdates).toHaveLength(0);
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

    /**
     * A summary that still names one record out of several is worse than no summary — it tells
     * the reader the burst was about that one thing. So a collapse template must carry the count
     * and must not deep-link to a single entity.
     */
    it('every collapse summary states the count and links to a list, not one record', () => {
      for (const [name, def] of Object.entries(NOTIFICATION_CATALOG)) {
        if (!def.collapse) continue;
        expect(`${name}: ${def.collapse.title} ${def.collapse.body}`).toContain('${count}');
        const link = def.collapse.link ?? def.link ?? '';
        expect(`${name} -> ${link}`).not.toMatch(/\$\{\w*[Ii]d\}/);
        expect(def.collapse.windowSeconds).toBeGreaterThan(0);
      }
    });
  });
});
