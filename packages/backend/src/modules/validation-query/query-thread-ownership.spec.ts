import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { QueryThreadService } from './query-thread.service';
import { ValidationQueryEntity } from './validation-query.entity';
import { ValidationQueryMessageEntity } from './validation-query-message.entity';
import { ValidationCaseEntity } from '../validation/validation-case.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { runWithRequestContext } from '../../core/context/request-context';

/**
 * Reactions, star and mark-read on a clarification thread.
 *
 * These routes admit ASSAYER and every staff role but took only a message/query id, so a field
 * assayer could react to, star, or mark read ANY thread's messages (and got the message back),
 * and region-assigned staff reached other regions' threads. The service now loads message →
 * clarification and applies the thread's rule: assayer = owner only; staff = staged region
 * ceiling on the clarification's region.
 */
describe('QueryThreadService — reactions / star / mark-read are object-scoped', () => {
  let service: QueryThreadService;

  const query: any = { id: 'q-1', assayerId: 'as-1', validationCaseId: 'vc-1' };
  const message: any = { id: 'm-1', validationQueryId: 'q-1', reactions: [], isStarred: false, authorId: 'staff-1' };

  const qb: any = {
    leftJoin: jest.fn(() => qb), select: jest.fn(() => qb), where: jest.fn(() => qb),
    getRawOne: jest.fn(async () => ({ region: 'SOUTH' })),
  };
  const queryRepo = { findOne: jest.fn(), save: jest.fn(), createQueryBuilder: jest.fn(() => qb) };
  const messageRepo = {
    findOne: jest.fn(),
    find: jest.fn(async () => [{ ...message, isRead: false }]),
    save: jest.fn(async (m: any) => m),
  };
  const regionGuard = { getUserRegions: jest.fn(), assertRegionAllowedStaged: jest.fn() };

  const asAssayer = (id: string) => ({ userId: id, roleNames: ['ASSAYER'] });
  const asStaff = (id: string) => ({ userId: id, roleNames: ['DESK_OPERATOR'] });
  const inCtx = <T>(ctx: any, fn: () => Promise<T>) => runWithRequestContext(ctx, fn);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueryThreadService,
        { provide: getRepositoryToken(ValidationQueryEntity), useValue: queryRepo },
        { provide: getRepositoryToken(ValidationQueryMessageEntity), useValue: messageRepo },
        { provide: getRepositoryToken(ValidationCaseEntity), useValue: {} },
        { provide: getRepositoryToken(AssignmentEntity), useValue: {} },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        { provide: RegionGuardService, useValue: regionGuard },
      ],
    }).compile();
    service = module.get(QueryThreadService);
    jest.clearAllMocks();
    queryRepo.findOne.mockResolvedValue({ ...query });
    messageRepo.findOne.mockResolvedValue({ ...message, reactions: [] });
    regionGuard.getUserRegions.mockResolvedValue(null);
    regionGuard.assertRegionAllowedStaged.mockResolvedValue(undefined);
  });

  const ops: Array<[string, (s: QueryThreadService) => Promise<unknown>]> = [
    ['addReaction', (s) => s.addReaction('m-1', '👍', 'x', 'X')],
    ['removeReaction', (s) => s.removeReaction('m-1', '👍', 'x')],
    ['toggleStarMessage', (s) => s.toggleStarMessage('m-1')],
    ['markThreadAsRead', (s) => s.markThreadAsRead('q-1', 'x')],
  ];

  describe.each(ops)('%s', (_name, op) => {
    it("refuses an assayer on another assayer's clarification, and writes nothing", async () => {
      await expect(inCtx(asAssayer('as-2'), () => op(service))).rejects.toThrow(ForbiddenException);
      expect(messageRepo.save).not.toHaveBeenCalled();
    });

    it('allows the owning assayer', async () => {
      await expect(inCtx(asAssayer('as-1'), () => op(service))).resolves.toBeDefined();
      expect(regionGuard.getUserRegions).not.toHaveBeenCalled();
    });

    it('runs the staged region ceiling for region-assigned staff, and refuses out of region', async () => {
      regionGuard.getUserRegions.mockResolvedValue(['NORTH']);
      regionGuard.assertRegionAllowedStaged.mockRejectedValue(new ForbiddenException('region'));
      await expect(inCtx(asStaff('staff-9'), () => op(service))).rejects.toThrow(ForbiddenException);
      expect(regionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith(
        'SOUTH', { regions: ['NORTH'] }, expect.stringMatching(/^validation-query:/),
      );
      expect(messageRepo.save).not.toHaveBeenCalled();
    });

    it('lets unrestricted staff through without a region lookup', async () => {
      await expect(inCtx(asStaff('staff-9'), () => op(service))).resolves.toBeDefined();
      expect(queryRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('refuses when there is no authenticated caller in context', async () => {
      await expect(op(service)).rejects.toThrow(ForbiddenException);
      expect(messageRepo.save).not.toHaveBeenCalled();
    });
  });

  it('resolves the message to ITS clarification, not one the caller names', async () => {
    messageRepo.findOne.mockResolvedValue({ ...message, validationQueryId: 'q-other' });
    queryRepo.findOne.mockImplementation(async ({ where }: any) =>
      where.id === 'q-other' ? { ...query, id: 'q-other', assayerId: 'as-2' } : { ...query });
    await expect(inCtx(asAssayer('as-1'), () => service.toggleStarMessage('m-1'))).rejects.toThrow(ForbiddenException);
  });

  it('an unknown message is still a 404', async () => {
    messageRepo.findOne.mockResolvedValue(null);
    await expect(inCtx(asAssayer('as-1'), () => service.addReaction('nope', '👍', 'as-1', 'A'))).rejects.toThrow(NotFoundException);
  });
});
