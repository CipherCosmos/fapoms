import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { EmailDigestService } from './email-digest.service';
import { DeskEscalationService } from '../../modules/validation/desk-escalation.service';
import { FeedbackEscalationService } from '../../modules/feedback/feedback-escalation.service';
import { HrWorkforceService } from '../../modules/assayer/hr-workforce.service';
import { EmailProvider } from '../notifications/email-provider';
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
  const email = { isEnabled: jest.fn().mockReturnValue(true), send: jest.fn() };
  const dataSource = { query: jest.fn() };

  /** The audience query returns one row per (user, role). */
  const audience = (rows: Array<{ id: string; email: string; role_name: string }>) => {
    dataSource.query.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('user_roles') ? rows : [{}]),
    );
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    email.isEnabled.mockReturnValue(true);
    email.send.mockResolvedValue({ success: true });
    desk.attention.mockResolvedValue({ ...emptyDesk });
    feedback.attention.mockResolvedValue({ firstResponseOverdue: [], resolutionOverdue: [] });
    hr.credentialsExpiringWithin.mockResolvedValue([]);
    // Finance queries return empty aggregates by default; audience query returns nobody.
    dataSource.query.mockResolvedValue([{ n: 0, total: 0 }]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailDigestService,
        { provide: DataSource, useValue: dataSource },
        { provide: DeskEscalationService, useValue: desk },
        { provide: FeedbackEscalationService, useValue: feedback },
        { provide: HrWorkforceService, useValue: hr },
        { provide: EmailProvider, useValue: email },
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
    expect(result.sent).toBe(0);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('does nothing at all when email is not configured', async () => {
    email.isEnabled.mockReturnValue(false);
    desk.attention.mockResolvedValue({ ...emptyDesk, entryOverdue: bucket(1) });
    const result = await service.run();
    expect(result.sent).toBe(0);
    expect(desk.attention).not.toHaveBeenCalled();
  });

  it('emails the desk heads when the desk has stalled items', async () => {
    desk.attention.mockResolvedValue({
      ...emptyDesk,
      entryOverdue: bucket(2),
      submitOverdue: bucket(1),
    });
    audience([{ id: 'u-1', email: 'head@x.in', role_name: 'DATA_ENTRY_HEAD' }]);

    const result = await service.run();

    expect(result.sent).toBe(1);
    const payload = email.send.mock.calls[0][0];
    expect(payload.to).toBe('head@x.in');
    expect(payload.text).toContain('2 entry overdue');
    expect(payload.text).toContain('1 submission to client overdue');
  });

  it('merges sections for a person whose roles span audiences — one email, not two', async () => {
    desk.attention.mockResolvedValue({ ...emptyDesk, entryOverdue: bucket(1) });
    feedback.attention.mockResolvedValue({
      firstResponseOverdue: [{ id: 'f1', title: 'Broken export', ageHours: 30 }],
      resolutionOverdue: [],
    });
    audience([
      { id: 'u-1', email: 'both@x.in', role_name: 'DATA_ENTRY_HEAD' },
      { id: 'u-1', email: 'both@x.in', role_name: 'SUPER_ADMINISTRATOR' },
    ]);

    const result = await service.run();

    expect(result.sent).toBe(1);
    const payload = email.send.mock.calls[0][0];
    expect(payload.text).toContain('entry overdue');
    expect(payload.text).toContain('first response');
  });

  it('only sends people the sections their roles entitle them to', async () => {
    desk.attention.mockResolvedValue({ ...emptyDesk, entryOverdue: bucket(1) });
    feedback.attention.mockResolvedValue({
      firstResponseOverdue: [{ id: 'f1', title: 'X', ageHours: 30 }],
      resolutionOverdue: [],
    });
    audience([
      { id: 'u-1', email: 'desk@x.in', role_name: 'VALIDATION_MANAGER' },
      { id: 'u-2', email: 'support@x.in', role_name: 'SUPER_ADMINISTRATOR' },
    ]);

    await service.run();

    const toDesk = email.send.mock.calls.find((c: any[]) => c[0].to === 'desk@x.in')?.[0];
    const toSupport = email.send.mock.calls.find((c: any[]) => c[0].to === 'support@x.in')?.[0];
    expect(toDesk.text).toContain('entry overdue');
    expect(toDesk.text).not.toContain('first response');
    expect(toSupport.text).toContain('first response');
    expect(toSupport.text).not.toContain('entry overdue');
  });

  it('a broken section costs its own content, never the whole brief', async () => {
    desk.attention.mockRejectedValue(new Error('validation db down'));
    feedback.attention.mockResolvedValue({
      firstResponseOverdue: [{ id: 'f1', title: 'X', ageHours: 30 }],
      resolutionOverdue: [],
    });
    audience([{ id: 'u-1', email: 'support@x.in', role_name: 'SUPER_ADMINISTRATOR' }]);

    const result = await service.run();

    expect(result.sent).toBe(1);
    expect(email.send.mock.calls[0][0].text).toContain('first response');
  });
});
