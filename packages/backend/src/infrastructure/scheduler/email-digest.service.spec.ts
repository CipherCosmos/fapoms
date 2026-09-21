import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { EmailDigestService } from './email-digest.service';
import { DeskEscalationService } from '../../modules/validation/desk-escalation.service';
import { FeedbackEscalationService } from '../../modules/feedback/feedback-escalation.service';
import { HrWorkforceService } from '../../modules/assayer/hr-workforce.service';
import { EmailService } from '../../modules/notifications/email.service';
import { PlatformSettingsService } from '../settings/platform-settings.service';

/**
 * The digest's contract: one email per person per morning, sections merged across roles,
 * silence when nothing needs attention, and a broken section costs its own content — never
 * the whole brief.
 */
describe('EmailDigestService', () => {
  let service: EmailDigestService;

  /**
   * Each bucket is `{ items, total }`: the sample shown on screen, and the real breach count.
   * The digest reports `total`, so a brief cannot understate a backlog by quoting the row cap.
   */
  const bucket = (total = 0) => ({ items: Array.from({ length: Math.min(total, 50) }, (_, i) => ({ id: `d${i}` })), total });
  const emptyDesk = {
    slaHours: {},
    unassignedOverdue: bucket(), entryOverdue: bucket(), reworkStale: bucket(),
    reviewOverdue: bucket(), submitOverdue: bucket(), ocrStuck: bucket(), clarificationsOverdue: bucket(),
  };
  const desk = { attention: jest.fn() };
  const feedback = { attention: jest.fn() };
  const hr = { credentialsExpiringWithin: jest.fn() };
  const email = { isEnabled: jest.fn().mockReturnValue(true), queue: jest.fn(), sendNow: jest.fn() };
  /** The queued request for one recipient (or the first), and the sections the template will show. */
  const queuedTo = (to?: string) => email.queue.mock.calls.map((c: any[]) => c[0]).find((r: any) => !to || r.to === to);
  const sectionsOf = (to?: string): string => queuedTo(to)?.content?.data?.digestSectionsHtml ?? '';
  const dataSource = { query: jest.fn(), getRepository: jest.fn() };

  /**
   * `resolveRecipients` opens a `UserEntity` repository directly (not through `dataSource.query`)
   * for the `SECTION_FALLBACK_PERMISSIONS` half of the audience — see `usersHoldingPermission`.
   * Every section but `feedback` now carries a fallback permission, so any test that populates
   * `desk` or `finance` (most of them) exercises this path whether or not it cares about custom
   * roles. Defaults to finding nobody, which keeps every pre-existing, name-only test's
   * expectations unchanged; `permissionQb.getMany` is overridden per-test below for the one that
   * actually exercises the fallback.
   */
  const permissionQb = {
    innerJoin: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
  };

  /** The audience query returns one row per (user, role). */
  const audience = (rows: Array<{ id: string; email: string; role_name: string }>) => {
    dataSource.query.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('user_roles') ? rows : [{}]),
    );
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    email.isEnabled.mockReturnValue(true);
    email.queue.mockImplementation(async (r: any) => ({ id: `e-${r.to}`, status: 'QUEUED', to: r.to }));
    desk.attention.mockResolvedValue({ ...emptyDesk });
    feedback.attention.mockResolvedValue({ firstResponseOverdue: [], resolutionOverdue: [] });
    hr.credentialsExpiringWithin.mockResolvedValue([]);
    // Finance queries return empty aggregates by default; audience query returns nobody.
    dataSource.query.mockResolvedValue([{ n: 0, total: 0 }]);
    permissionQb.getMany.mockResolvedValue([]);
    dataSource.getRepository.mockReturnValue({ createQueryBuilder: jest.fn(() => permissionQb) });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailDigestService,
        { provide: DataSource, useValue: dataSource },
        { provide: DeskEscalationService, useValue: desk },
        { provide: FeedbackEscalationService, useValue: feedback },
        { provide: HrWorkforceService, useValue: hr },
        { provide: EmailService, useValue: email },
        {
          provide: PlatformSettingsService,
          // Nothing configured in tests: every lookup falls through to the caller's fallback,
          // which is the shipped constant.
          useValue: {
            get: jest.fn(async () => null),
            getMany: jest.fn(async () => ({})),
            getNumber: jest.fn(async (_k: string, fb?: number) => fb as number),
            describeAll: jest.fn(async () => []),
            onChange: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(EmailDigestService);
  });

  it('sends nothing when nothing needs attention — silence is the feature', async () => {
    const result = await service.run();
    expect(result.queued).toBe(0);
    expect(email.queue).not.toHaveBeenCalled();
  });

  it('does nothing at all when email is not configured', async () => {
    email.isEnabled.mockReturnValue(false);
    desk.attention.mockResolvedValue({ ...emptyDesk, entryOverdue: bucket(1) });
    const result = await service.run();
    expect(result.queued).toBe(0);
    expect(desk.attention).not.toHaveBeenCalled();
    expect(email.queue).not.toHaveBeenCalled();
  });

  it('emails the desk heads when the desk has stalled items', async () => {
    desk.attention.mockResolvedValue({
      ...emptyDesk,
      entryOverdue: bucket(2),
      submitOverdue: bucket(1),
    });
    audience([{ id: 'u-1', email: 'head@x.in', role_name: 'DESK' }]);

    const result = await service.run();

    expect(result.queued).toBe(1);
    expect(queuedTo().to).toBe('head@x.in');
    expect(sectionsOf()).toContain('2 entry overdue');
    expect(sectionsOf()).toContain('1 submission to client overdue');
  });

  /**
   * One email implementation: the digest decides who gets what and queues it. It never sends,
   * never renders, and never builds a second copy of the wording beside the template's.
   */
  it('queues each brief through the morning-digest template — it does not send, and does not render', async () => {
    desk.attention.mockResolvedValue({ ...emptyDesk, entryOverdue: bucket(2) });
    audience([{ id: 'u-1', email: 'head@x.in', role_name: 'DESK' }]);

    await service.run();

    expect(email.sendNow).not.toHaveBeenCalled();
    const request = queuedTo();
    expect(request).toEqual(expect.objectContaining({
      kind: 'MORNING_DIGEST',
      to: 'head@x.in',
      entityType: 'DIGEST',
      requestedBy: null,
    }));
    expect(request.entityId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(request.content.template).toBe('morning-digest');
    expect(Object.keys(request.content)).toEqual(['template', 'data']);
    expect(request.content.data).toEqual(expect.objectContaining({
      subjectCounts: expect.stringContaining('Data desk'),
      briefDate: expect.any(String),
      portalUrl: expect.stringMatching(/\/validation$/),
      logoUrl: expect.any(String),
    }));
  });

  it('escapes what people typed — the sections are the template\'s raw HTML token', async () => {
    feedback.attention.mockResolvedValue({
      firstResponseOverdue: [{ id: 'f1', title: '<img src=x onerror=alert(1)>', ageHours: 30 }],
      resolutionOverdue: [],
    });
    audience([{ id: 'u-1', email: 'support@x.in', role_name: 'DEVELOPER' }]);

    await service.run();

    expect(sectionsOf()).not.toContain('<img');
    expect(sectionsOf()).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('counts a brief the queue did not take, and still queues everyone else', async () => {
    desk.attention.mockResolvedValue({ ...emptyDesk, entryOverdue: bucket(1) });
    audience([
      { id: 'u-1', email: 'first@x.in', role_name: 'DESK' },
      { id: 'u-2', email: 'second@x.in', role_name: 'DESK' },
    ]);
    email.queue.mockImplementationOnce(async () => ({ id: null, status: 'NOT_QUEUED', to: 'first@x.in', error: 'db down' }));

    const result = await service.run();

    expect(result).toEqual({ queued: 1, notQueued: 1 });
    expect(email.queue).toHaveBeenCalledTimes(2);
  });

  it('merges sections for a person whose roles span audiences — one email, not two', async () => {
    desk.attention.mockResolvedValue({ ...emptyDesk, entryOverdue: bucket(1) });
    feedback.attention.mockResolvedValue({
      firstResponseOverdue: [{ id: 'f1', title: 'Broken export', ageHours: 30 }],
      resolutionOverdue: [],
    });
    audience([
      { id: 'u-1', email: 'both@x.in', role_name: 'DESK' },
      // DEVELOPER owns the feedback desk since 2026-09-05 (feedback-roles.ts); ADMIN no longer
      // maps to any section.
      { id: 'u-1', email: 'both@x.in', role_name: 'DEVELOPER' },
    ]);

    const result = await service.run();

    expect(result.queued).toBe(1);
    expect(sectionsOf()).toContain('entry overdue');
    expect(sectionsOf()).toContain('first response');
  });

  it('only sends people the sections their roles entitle them to', async () => {
    desk.attention.mockResolvedValue({ ...emptyDesk, entryOverdue: bucket(1) });
    feedback.attention.mockResolvedValue({
      firstResponseOverdue: [{ id: 'f1', title: 'X', ageHours: 30 }],
      resolutionOverdue: [],
    });
    audience([
      { id: 'u-1', email: 'desk@x.in', role_name: 'DESK' },
      { id: 'u-2', email: 'support@x.in', role_name: 'DEVELOPER' },
    ]);

    await service.run();

    expect(sectionsOf('desk@x.in')).toContain('entry overdue');
    expect(sectionsOf('desk@x.in')).not.toContain('first response');
    expect(sectionsOf('support@x.in')).toContain('first response');
    expect(sectionsOf('support@x.in')).not.toContain('entry overdue');
  });

  /**
   * `SECTION_FALLBACK_PERMISSIONS` mirrors the notification catalog's `fallbackPermissions`
   * (see `notification-dispatch.service.spec.ts`'s own "custom-role permission fallback"
   * describe block for the same mechanism on the other pipeline): a role built in Admin ->
   * Roles matches no name in `SECTION_AUDIENCES`, so without this a custom role holding
   * VALIDATION:VIEW:ORGANIZATION never heard about the desk section, however precisely its
   * permissions matched what /data-entry itself requires.
   */
  it('also reaches a custom role holding the section fallback permission, by union with the name match', async () => {
    desk.attention.mockResolvedValue({ ...emptyDesk, entryOverdue: bucket(3) });
    // Name match finds nobody; the permission fallback finds a custom-role holder instead.
    audience([]);
    permissionQb.getMany.mockResolvedValue([
      {
        id: 'custom-1',
        email: 'deskbot@x.in',
        roles: [
          {
            name: 'DATA_DESK_LEAD',
            permissions: [{ resource: 'VALIDATION', action: 'VIEW', scope: 'ORGANIZATION' }],
          },
        ],
      },
    ]);

    const result = await service.run();

    expect(result.queued).toBe(1);
    expect(queuedTo().to).toBe('deskbot@x.in');
    expect(sectionsOf()).toContain('entry overdue');
  });

  it('a broken section costs its own content, never the whole brief', async () => {
    desk.attention.mockRejectedValue(new Error('validation db down'));
    feedback.attention.mockResolvedValue({
      firstResponseOverdue: [{ id: 'f1', title: 'X', ageHours: 30 }],
      resolutionOverdue: [],
    });
    audience([{ id: 'u-1', email: 'support@x.in', role_name: 'DEVELOPER' }]);

    const result = await service.run();

    expect(result.queued).toBe(1);
    expect(sectionsOf()).toContain('first response');
  });
});
