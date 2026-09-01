import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ValidationQueryService } from './validation-query.service';
import { ValidationQueryEntity } from './validation-query.entity';
import { ValidationCaseEntity } from '../validation/validation-case.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationService } from '../notifications/notification.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { QueryThreadService } from './query-thread.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { Region } from '@fapoms/shared';

/**
 * validation-query had zero region scoping: a region-restricted account (`users.regions` set)
 * saw every region's clarifications through `findAll`/`GET assayer/:assayerId`, the same gap
 * already closed on branch/assignment/project/etc.
 *
 * `findAllQueries` and `findByAssayer` are staged behind `RegionGuardService.stagedMode()`:
 *  - unrestricted account (`scope.regions` null/empty): `stagedMode()` is never even consulted.
 *  - `off`: response identical to before this change.
 *  - `log`: same unfiltered response as `off`, plus a warning computed from the page already
 *    fetched — no second query just to produce it.
 *  - `enforce`: the region ceiling actually narrows the result. A row whose region cannot be
 *    resolved (no branch, no project branch) is never excluded — a data gap, not a security
 *    boundary, per `RegionGuardService.assertRegionAllowed`'s own doc comment.
 */
describe('validation-query region scoping', () => {
  let service: ValidationQueryService;
  const stagedMode = jest.fn();
  const find = jest.fn();
  const findAndCount = jest.fn();
  const count = jest.fn();
  const createQueryBuilder = jest.fn();

  beforeEach(async () => {
    stagedMode.mockReset();
    find.mockReset();
    findAndCount.mockReset();
    count.mockReset();
    createQueryBuilder.mockReset();

    const noop = {};
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ValidationQueryService,
        {
          provide: getRepositoryToken(ValidationQueryEntity),
          useValue: { find, findAndCount, count, createQueryBuilder, manager: { query: jest.fn() } },
        },
        { provide: getRepositoryToken(ValidationCaseEntity), useValue: noop },
        { provide: getRepositoryToken(AssignmentEntity), useValue: noop },
        { provide: AuditService, useValue: noop },
        { provide: DomainEventPublisher, useValue: noop },
        { provide: NotificationService, useValue: noop },
        { provide: PushNotificationService, useValue: noop },
        { provide: QueryThreadService, useValue: noop },
        { provide: NotificationDispatchService, useValue: noop },
        { provide: RegionGuardService, useValue: { stagedMode } },
      ],
    }).compile();
    service = module.get(ValidationQueryService);
  });

  describe('findAllQueries', () => {
    const items = [{ id: 'q-north' }, { id: 'q-south' }, { id: 'q-noregion' }];

    it('never consults stagedMode() for an unrestricted (national) account', async () => {
      findAndCount.mockResolvedValue([items, 3]);

      const result = await service.findAllQueries(1, 50, { regions: null });

      expect(stagedMode).not.toHaveBeenCalled();
      expect(createQueryBuilder).not.toHaveBeenCalled();
      expect(findAndCount).toHaveBeenCalledWith({
        where: { isActive: true },
        order: { createdAt: 'DESC' },
        take: 50,
        skip: 0,
      });
      expect(result).toEqual({ items, total: 3, page: 1, limit: 50 });
    });

    it('off mode: response identical to before, no query builder touched', async () => {
      stagedMode.mockResolvedValue('off');
      findAndCount.mockResolvedValue([items, 3]);

      const result = await service.findAllQueries(1, 50, { regions: [Region.NORTH] });

      expect(createQueryBuilder).not.toHaveBeenCalled();
      expect(result).toEqual({ items, total: 3, page: 1, limit: 50 });
    });

    it('log mode: returns the same unfiltered page and total as off mode, byte-for-byte', async () => {
      stagedMode.mockResolvedValue('log');
      const qb: any = {
        leftJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn().mockResolvedValue({
          entities: items,
          raw: [{ region_gate: 'SOUTH' }, { region_gate: 'SOUTH' }, { region_gate: null }],
        }),
      };
      createQueryBuilder.mockReturnValue(qb);
      count.mockResolvedValue(3);

      const result = await service.findAllQueries(1, 50, { regions: [Region.NORTH] });

      expect(findAndCount).not.toHaveBeenCalled();
      expect(result).toEqual({ items, total: 3, page: 1, limit: 50 });
    });

    it('log mode logs the would-be exclusion from the page already fetched', async () => {
      stagedMode.mockResolvedValue('log');
      const qb: any = {
        leftJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn().mockResolvedValue({
          entities: items,
          // q-north is in scope; q-south is not; q-noregion has no resolvable region and never
          // counts as "would be excluded".
          raw: [{ region_gate: 'NORTH' }, { region_gate: 'SOUTH' }, { region_gate: null }],
        }),
      };
      createQueryBuilder.mockReturnValue(qb);
      count.mockResolvedValue(3);
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

      await service.findAllQueries(1, 50, { regions: [Region.NORTH] });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('would filter 1/3 rows'));
      warnSpy.mockRestore();
    });

    it('enforce mode narrows the query itself, keeping null-region rows visible', async () => {
      stagedMode.mockResolvedValue('enforce');
      const qb: any = {
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[items[0], items[2]], 2]),
      };
      createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAllQueries(1, 50, { regions: [Region.NORTH] });

      expect(findAndCount).not.toHaveBeenCalled();
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(b.region IS NULL OR b.region IN (:...regions))',
        { regions: [Region.NORTH] },
      );
      expect(result).toEqual({ items: [items[0], items[2]], total: 2, page: 1, limit: 50 });
    });
  });

  describe('findByAssayer', () => {
    const ASSAYER_ID = '11111111-1111-1111-1111-111111111111';
    const eagerItems = [{ id: 'q-north', validationCase: {} }, { id: 'q-south', validationCase: {} }];

    it('never consults stagedMode() for an unrestricted (national) account', async () => {
      find.mockResolvedValue(eagerItems);

      const result = await service.findByAssayer(ASSAYER_ID, { regions: null });

      expect(stagedMode).not.toHaveBeenCalled();
      expect(createQueryBuilder).not.toHaveBeenCalled();
      expect(find).toHaveBeenCalledWith({
        where: { assayerId: ASSAYER_ID, isActive: true },
        relations: ['validationCase'],
        order: { createdAt: 'DESC' },
      });
      expect(result).toEqual(eagerItems);
    });

    it('off mode: response identical to before, no query builder touched', async () => {
      stagedMode.mockResolvedValue('off');
      find.mockResolvedValue(eagerItems);

      const result = await service.findByAssayer(ASSAYER_ID, { regions: [Region.NORTH] });

      expect(createQueryBuilder).not.toHaveBeenCalled();
      expect(result).toEqual(eagerItems);
    });

    it('log mode: returns every row unfiltered and logs what it would have excluded', async () => {
      stagedMode.mockResolvedValue('log');
      const qb: any = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn().mockResolvedValue({
          entities: eagerItems,
          raw: [{ region: 'NORTH' }, { region: 'SOUTH' }],
        }),
      };
      createQueryBuilder.mockReturnValue(qb);
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

      const result = await service.findByAssayer(ASSAYER_ID, { regions: [Region.NORTH] });

      expect(find).not.toHaveBeenCalled();
      expect(result).toEqual(eagerItems);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('would filter 1 of 2'));
      warnSpy.mockRestore();
    });

    it('enforce mode filters per-row, since one assayer can span more than one region', async () => {
      stagedMode.mockResolvedValue('enforce');
      const qb: any = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn().mockResolvedValue({
          entities: eagerItems,
          raw: [{ region: 'NORTH' }, { region: 'SOUTH' }],
        }),
      };
      createQueryBuilder.mockReturnValue(qb);

      const result = await service.findByAssayer(ASSAYER_ID, { regions: [Region.NORTH] });

      expect(result).toEqual([eagerItems[0]]);
    });
  });
});
