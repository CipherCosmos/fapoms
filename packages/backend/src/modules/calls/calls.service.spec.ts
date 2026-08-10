import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CallsService } from './calls.service';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';
import { ValidationQueryMessageEntity } from '../validation-query/validation-query-message.entity';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

/**
 * The call lifecycle, which is the part of calling this server owns. Media is LiveKit's
 * problem; ringing the right person, refusing the wrong one, and leaving a truthful line
 * in the clarification thread are this service's.
 */
describe('CallsService', () => {
  let service: CallsService;

  const staffQuery = {
    id: 'query-1', isActive: true, assayerId: 'assayer-1',
    raisedByUserId: 'staff-1', queryText: 'Which purity was struck through on page 3?',
  };

  const queryRepo = {
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  };
  const messageRepo = {
    create: jest.fn((d: any) => d),
    save: jest.fn((d: any) => Promise.resolve({ ...d, createdAt: new Date() })),
  };
  const publisher = { publish: jest.fn() };

  const assayer = { id: 'assayer-1', name: 'Nilesh', isAssayer: true };
  const staff = { id: 'staff-1', name: 'Desk', isAssayer: false };

  beforeEach(async () => {
    jest.useFakeTimers();
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secret';

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CallsService,
        { provide: getRepositoryToken(ValidationQueryEntity), useValue: queryRepo },
        { provide: getRepositoryToken(ValidationQueryMessageEntity), useValue: messageRepo },
        { provide: DomainEventPublisher, useValue: publisher },
      ],
    }).compile();

    service = module.get(CallsService);
    jest.clearAllMocks();
    queryRepo.findOne.mockResolvedValue({ ...staffQuery });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('an assayer ringing their own clarification rings the user who raised it', async () => {
    const res = await service.initiate(assayer, 'query-1');

    expect(res.token).toEqual(expect.any(String));
    expect(res.roomName).toContain('query-query-1');
    const ring = publisher.publish.mock.calls.find(([e]) => e === 'call:incoming')![1];
    expect(ring.targetUserIds).toEqual(['staff-1']);
    expect(ring.ringStaffRoom).toBe(false);
    expect(ring.callerName).toBe('Nilesh');
  });

  it('staff ringing a clarification rings its assayer', async () => {
    await service.initiate(staff, 'query-1');
    const ring = publisher.publish.mock.calls.find(([e]) => e === 'call:incoming')![1];
    expect(ring.targetUserIds).toEqual(['assayer-1']);
  });

  it('falls back to ringing the whole desk when the raiser is unrecorded', async () => {
    // An unanswerable ring is worse than a broad one — but only in this direction, and
    // only when there is genuinely nobody specific to ring.
    queryRepo.findOne.mockResolvedValue({ ...staffQuery, raisedByUserId: null });
    await service.initiate(assayer, 'query-1');
    const ring = publisher.publish.mock.calls.find(([e]) => e === 'call:incoming')![1];
    expect(ring.targetUserIds).toEqual([]);
    expect(ring.ringStaffRoom).toBe(true);
  });

  it('refuses an assayer calling about a clarification that is not theirs', async () => {
    await expect(service.initiate({ ...assayer, id: 'assayer-2' }, 'query-1'))
      .rejects.toThrow(ForbiddenException);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('a second initiate while ringing joins the existing call instead of double-ringing', async () => {
    const first = await service.initiate(assayer, 'query-1');
    const second = await service.initiate(staff, 'query-1');

    expect(second.roomName).toBe(first.roomName);
    expect(second.rejoined).toBe(true);
    // Exactly one ring went out.
    expect(publisher.publish.mock.calls.filter(([e]) => e === 'call:incoming')).toHaveLength(1);
  });

  it('answer cancels the missed-call clock and tells both sides', async () => {
    const { roomName } = await service.initiate(assayer, 'query-1');
    await service.answer(staff, roomName);

    const answered = publisher.publish.mock.calls.find(([e]) => e === 'call:answered')![1];
    expect(answered.targetUserIds).toEqual(expect.arrayContaining(['assayer-1', 'staff-1']));

    // The ring window elapsing after an answer must not mark the call missed.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(publisher.publish.mock.calls.find(([e]) => e === 'call:ended')).toBeUndefined();
  });

  it('an unanswered ring becomes a missed call in the thread', async () => {
    await service.initiate(assayer, 'query-1');
    await jest.advanceTimersByTimeAsync(41_000);

    const ended = publisher.publish.mock.calls.find(([e]) => e === 'call:ended')![1];
    expect(ended.reason).toBe('missed');
    expect(messageRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      validationQueryId: 'query-1',
      body: expect.stringContaining('Missed call'),
    }));
  });

  it('declining logs the refusal rather than pretending nothing happened', async () => {
    const { roomName } = await service.initiate(assayer, 'query-1');
    await service.decline(staff, roomName);

    const ended = publisher.publish.mock.calls.find(([e]) => e === 'call:ended')![1];
    expect(ended.reason).toBe('declined');
    expect(messageRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('declined'),
    }));
  });

  it('hanging up an answered call records its duration; the room is then gone', async () => {
    const { roomName } = await service.initiate(assayer, 'query-1');
    await service.answer(staff, roomName);
    await jest.advanceTimersByTimeAsync(95_000);
    await service.hangup(assayer, roomName);

    const ended = publisher.publish.mock.calls.find(([e]) => e === 'call:ended')![1];
    expect(ended.reason).toBe('ended');
    expect(messageRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringMatching(/Voice call — 1m 35s/),
    }));

    await expect(service.hangup(assayer, roomName)).rejects.toThrow(NotFoundException);
  });

  it('hanging up before answer is a cancellation, not a completed call', async () => {
    const { roomName } = await service.initiate(assayer, 'query-1');
    await service.hangup(assayer, roomName);

    expect(messageRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('cancelled'),
    }));
  });

  it('a stranger to the call can neither answer nor hang it up', async () => {
    queryRepo.findOne.mockResolvedValue({ ...staffQuery });
    const { roomName } = await service.initiate(staff, 'query-1');
    await expect(service.answer({ id: 'intruder-1' }, roomName)).rejects.toThrow(ForbiddenException);
    await expect(service.hangup({ id: 'intruder-1' }, roomName)).rejects.toThrow(ForbiddenException);
  });
});
