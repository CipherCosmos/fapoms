import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';
import { CallsService } from './calls.service';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';
import { ValidationQueryMessageEntity } from '../validation-query/validation-query-message.entity';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { ValidationQueryService } from '../validation-query/validation-query.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

/**
 * Who may get a LiveKit token for a live call.
 *
 * Two holes, both closed here:
 *   1. Rejoin. A second `initiate` on a clarification with a live call handed a room token to
 *      whoever asked — so any desk user could silently join someone else's call. Now only the
 *      caller or a named callee rejoins; a desk-wide ring can additionally be picked up by staff.
 *   2. Empty callee list. `calleeUserIds.length === 0` made EVERY user a callee, so anyone could
 *      answer, decline or hang up a desk-wide ring. An empty list now names nobody; the desk-wide
 *      case is an explicit `openToDesk` flag that admits staff only, under the region ceiling.
 */
describe('CallsService — call membership and region ceiling', () => {
  let service: CallsService;

  const query = {
    id: 'query-1', isActive: true, assayerId: 'assayer-1',
    raisedByUserId: 'staff-1', queryText: 'Which purity?',
  };
  const queryRepo = { findOne: jest.fn(), update: jest.fn().mockResolvedValue({}) };
  const messageRepo = {
    findOne: jest.fn(),
    create: jest.fn((d: any) => d),
    save: jest.fn((d: any) => Promise.resolve(d)),
  };
  const publisher = { publish: jest.fn() };
  const notificationDispatch = { emitSafe: jest.fn() };
  const validationQueries = { resolveRegion: jest.fn() };
  const regionGuard = { assertRegionAllowedStaged: jest.fn() };

  const assayer = { id: 'assayer-1', name: 'Nilesh', isAssayer: true };
  const raiser = { id: 'staff-1', name: 'Raiser', isAssayer: false };
  const otherStaff = { id: 'staff-9', name: 'Bystander', isAssayer: false };
  const otherAssayer = { id: 'assayer-2', name: 'Other', isAssayer: true };
  const NORTH = { regions: ['NORTH'] as any };

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
        { provide: NotificationDispatchService, useValue: notificationDispatch },
        { provide: ValidationQueryService, useValue: validationQueries },
        { provide: RegionGuardService, useValue: regionGuard },
      ],
    }).compile();
    service = module.get(CallsService);
    jest.clearAllMocks();
    queryRepo.findOne.mockResolvedValue({ ...query });
    messageRepo.findOne.mockResolvedValue(null);
    validationQueries.resolveRegion.mockResolvedValue('SOUTH');
    regionGuard.assertRegionAllowedStaged.mockResolvedValue(undefined);
  });

  afterEach(() => jest.useRealTimers());

  describe('rejoining a live call (initiate while one is live)', () => {
    it('refuses a desk user who is neither caller nor callee', async () => {
      await service.initiate(assayer, 'query-1'); // rings staff-1 only
      await expect(service.initiate(otherStaff, 'query-1')).rejects.toThrow(ForbiddenException);
    });

    it('refuses a bystander on a staff-initiated call too', async () => {
      await service.initiate(raiser, 'query-1'); // rings the assayer
      await expect(service.initiate(otherStaff, 'query-1')).rejects.toThrow(ForbiddenException);
    });

    it('lets the named callee rejoin the same room', async () => {
      const first = await service.initiate(assayer, 'query-1');
      const again = await service.initiate(raiser, 'query-1');
      expect(again.roomName).toBe(first.roomName);
      expect(again.rejoined).toBe(true);
    });

    it('lets the caller rejoin (double-tap)', async () => {
      const first = await service.initiate(assayer, 'query-1');
      const again = await service.initiate(assayer, 'query-1');
      expect(again.roomName).toBe(first.roomName);
    });
  });

  describe('an empty callee list names nobody', () => {
    beforeEach(() => {
      queryRepo.findOne.mockResolvedValue({ ...query, raisedByUserId: null }); // → desk-wide ring
    });

    it('another assayer can neither answer, decline nor hang up a desk-wide ring', async () => {
      const { roomName } = await service.initiate(assayer, 'query-1');
      await expect(service.answer(otherAssayer, roomName)).rejects.toThrow(ForbiddenException);
      await expect(service.decline(otherAssayer, roomName)).rejects.toThrow(ForbiddenException);
      await expect(service.hangup(otherAssayer, roomName)).rejects.toThrow(ForbiddenException);
    });

    it('an unanswered desk member cannot hang up a desk-wide ring', async () => {
      const { roomName } = await service.initiate(assayer, 'query-1');
      await expect(service.hangup(otherStaff, roomName)).rejects.toThrow(ForbiddenException);
    });

    it('a desk member may pick it up, and then becomes the only callee', async () => {
      const { roomName } = await service.initiate(assayer, 'query-1');
      const res = await service.answer(otherStaff, roomName);
      expect(res.token).toEqual(expect.any(String));
      // A second desk member can no longer take the same call.
      await expect(service.answer(raiser, roomName)).rejects.toThrow(ForbiddenException);
      await expect(service.initiate(raiser, 'query-1')).rejects.toThrow(ForbiddenException);
      // The one who picked it up can hang up.
      await expect(service.hangup(otherStaff, roomName)).resolves.toEqual({ ok: true });
    });

    it('a staff call (non-empty callee list) is never open to the desk', async () => {
      queryRepo.findOne.mockResolvedValue({ ...query });
      const { roomName } = await service.initiate(raiser, 'query-1');
      await expect(service.answer(otherStaff, roomName)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('region ceiling for staff', () => {
    it('initiate runs the staged check on the clarification region for a region-scoped staff caller', async () => {
      regionGuard.assertRegionAllowedStaged.mockRejectedValue(new ForbiddenException('out of region'));
      await expect(service.initiate({ ...raiser, scope: NORTH }, 'query-1')).rejects.toThrow(ForbiddenException);
      expect(validationQueries.resolveRegion).toHaveBeenCalledWith('query-1');
      expect(regionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith('SOUTH', NORTH, 'calls:initiate');
      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('an out-of-region desk member cannot pick up a desk-wide ring', async () => {
      queryRepo.findOne.mockResolvedValue({ ...query, raisedByUserId: null });
      const { roomName } = await service.initiate(assayer, 'query-1');
      regionGuard.assertRegionAllowedStaged.mockRejectedValue(new ForbiddenException('out of region'));
      await expect(service.answer({ ...otherStaff, scope: NORTH }, roomName)).rejects.toThrow(ForbiddenException);
      expect(regionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith('SOUTH', NORTH, 'calls:answer');
    });

    it('skips the lookup for an unrestricted staff caller and for an assayer', async () => {
      await service.initiate(raiser, 'query-1');
      await service.hangup(raiser, [...(service as any).active.keys()][0]);
      await service.initiate(assayer, 'query-1');
      expect(validationQueries.resolveRegion).not.toHaveBeenCalled();
    });
  });
});
