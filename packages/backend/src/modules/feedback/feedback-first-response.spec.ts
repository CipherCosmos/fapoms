import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FeedbackStatus, FeedbackSeverity, FeedbackCategory } from '@fapoms/shared';
import { FeedbackService } from './feedback.service';
import { FeedbackThreadEntity } from './feedback-thread.entity';
import { FeedbackMessageEntity } from './feedback-message.entity';
import { FeedbackVoteEntity } from './feedback-vote.entity';
import { UserEntity } from '../user/user.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { FEEDBACK_INTELLIGENCE } from './feedback-intelligence';

/**
 * `triage(id, { note })` posts the note as a reporter-visible message — the same thing a real
 * chat reply does — so it must close the first-response SLA clock the same way
 * `FeedbackThreadService.postMessage()` does for a team chat reply. Before this fix it did not:
 * `FeedbackEscalationService.attention()`'s `firstResponseOverdue` query reads only
 * `first_responded_at`, so a thread the team had genuinely written back on (via the note path)
 * still read as never having received a first response, and — for anything not already
 * RESOLVED/CLOSED by the time of the note — would go on being flagged by the daily SLA scan
 * forever.
 *
 * Confirmed live first (`QATRACK-N-001`, direct API): triaging a fresh thread with only a
 * `note` left `first_responded_at` NULL in Postgres, while the identical text sent through
 * `POST /feedback/:id/messages` (the real chat-reply screen) stamped it correctly.
 */
describe('FeedbackService — first-response stamping on triage notes', () => {
  let service: FeedbackService;
  let savedThread: any;

  const baseThread = (overrides: Partial<FeedbackThreadEntity> = {}) => ({
    id: 't-1',
    category: FeedbackCategory.BUG,
    severity: FeedbackSeverity.MEDIUM,
    status: FeedbackStatus.OPEN,
    assignedToUserId: null,
    duplicateOfId: null,
    reporterUserId: 'reporter-1',
    reporterAssayerId: null,
    title: 'Something is off',
    firstRespondedAt: null,
    resolvedAt: null,
    resolvedByUserId: null,
    ...overrides,
  });

  const mockThreadRepo = {
    findOne: jest.fn(),
    save: jest.fn(async (t: any) => { savedThread = t; return t; }),
  };
  const mockMessageRepo = {
    create: jest.fn((x: any) => x),
    save: jest.fn(async (m: any) => m),
  };

  beforeEach(async () => {
    savedThread = null;
    mockThreadRepo.findOne.mockReset();
    mockThreadRepo.save.mockClear();
    mockMessageRepo.create.mockClear();
    mockMessageRepo.save.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeedbackService,
        { provide: getRepositoryToken(FeedbackThreadEntity), useValue: mockThreadRepo },
        { provide: getRepositoryToken(FeedbackMessageEntity), useValue: mockMessageRepo },
        { provide: getRepositoryToken(FeedbackVoteEntity), useValue: { create: jest.fn(), save: jest.fn(), count: jest.fn(), findOne: jest.fn() } },
        { provide: getRepositoryToken(UserEntity), useValue: { createQueryBuilder: jest.fn() } },
        { provide: AuditService, useValue: { recordEventSafe: jest.fn(), recordEvent: jest.fn() } },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: FEEDBACK_INTELLIGENCE, useValue: { classify: jest.fn(), similarity: jest.fn() } },
      ],
    }).compile();

    service = module.get(FeedbackService);
  });

  it('stamps firstRespondedAt when a note is left on a thread that has never been replied to', async () => {
    mockThreadRepo.findOne.mockResolvedValue(baseThread());

    const before = Date.now();
    await service.triage('t-1', { note: 'Looking into this now.' }, 'admin-1');

    expect(savedThread.firstRespondedAt).toBeInstanceOf(Date);
    expect(savedThread.firstRespondedAt.getTime()).toBeGreaterThanOrEqual(before);
    // The note itself still becomes a real, reporter-visible message — unchanged behaviour.
    expect(mockMessageRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Looking into this now.' }),
    );
  });

  it('leaves firstRespondedAt null for a triage change that carries no note', async () => {
    mockThreadRepo.findOne.mockResolvedValue(baseThread());

    await service.triage('t-1', { status: FeedbackStatus.IN_PROGRESS }, 'admin-1');

    expect(savedThread.firstRespondedAt).toBeNull();
  });

  it('does not move an already-stamped firstRespondedAt on a later note', async () => {
    const original = new Date('2026-01-01T00:00:00.000Z');
    mockThreadRepo.findOne.mockResolvedValue(baseThread({ firstRespondedAt: original } as any));

    await service.triage('t-1', { note: 'Following up again.' }, 'admin-1');

    expect(savedThread.firstRespondedAt).toBe(original);
  });

  it('does not stamp firstRespondedAt for a note that is only whitespace', async () => {
    mockThreadRepo.findOne.mockResolvedValue(baseThread());

    await service.triage('t-1', { note: '   ' }, 'admin-1');

    expect(savedThread.firstRespondedAt).toBeNull();
  });
});
