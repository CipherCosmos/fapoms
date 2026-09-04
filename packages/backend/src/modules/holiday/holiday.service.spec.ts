import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { HolidayService } from './holiday.service';
import { HolidayEntity } from './holiday.entity';
import { ClientConfigurationEntity } from '../client/client-configuration.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { CacheService } from '../../infrastructure/cache/cache.service';

/**
 * `isHoliday` decides whether an audit may be scheduled on a date — a wrong answer either
 * blocks a legitimate booking (false positive) or lets one through on a day nobody may work
 * (false negative). This file covers the client-scoping bug found live: a holiday registered
 * for one bank (`clientId` set, no `applicableStates`) was reported as a holiday for every
 * OTHER client too whenever the caller queried without a `clientId` at all — the SQL `WHERE`
 * that scopes rows to the caller's client only runs when a `clientId` is passed, and the
 * in-memory matching below it never checked `clientId`, so an unscoped caller saw every
 * client's private calendar mixed in and read each entry as nationwide.
 */
describe('HolidayService.isHoliday', () => {
  let service: HolidayService;
  let holidayRepo: any;
  let holidayRows: Partial<HolidayEntity>[];

  // 2026-09-16 is a plain Wednesday — not a Sunday, not a 2nd/4th Saturday — so the only way
  // it reads as unworkable is via a registered row in `holidayRows`.
  const WEDNESDAY = new Date('2026-09-16T00:00:00.000Z');
  const SBI = 'sbi-client-id';
  const HDFC = 'hdfc-client-id';

  beforeEach(async () => {
    holidayRows = [];
    holidayRepo = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn(async () => holidayRows),
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HolidayService,
        { provide: getRepositoryToken(HolidayEntity), useValue: holidayRepo },
        {
          provide: getRepositoryToken(ClientConfigurationEntity),
          // No client has configured working days for this test — every date falls back to
          // the platform default (Mon-Sat minus 2nd/4th Saturday) unless a holiday row says
          // otherwise, which is what these tests are actually exercising.
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        { provide: AuditService, useValue: {} },
        { provide: DomainEventPublisher, useValue: {} },
        {
          provide: CacheService,
          useValue: {
            wrap: jest.fn((_k: string, _t: number, load: () => any) => load()),
            delByPattern: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get(HolidayService);
  });

  it('reports a genuinely global holiday (no clientId on the row) with no clientId in the query', async () => {
    holidayRows = [{ clientId: null, applicableStates: null } as HolidayEntity];
    expect(await service.isHoliday(WEDNESDAY)).toBe(true);
  });

  it('reports a genuinely global holiday even when a clientId IS passed', async () => {
    holidayRows = [{ clientId: null, applicableStates: null } as HolidayEntity];
    expect(await service.isHoliday(WEDNESDAY, undefined, SBI)).toBe(true);
  });

  it('does NOT report a client-specific holiday when the query carries no clientId at all', async () => {
    // The exact bug: an SBI-only holiday leaking into an unscoped check.
    holidayRows = [{ clientId: SBI, applicableStates: null } as HolidayEntity];
    expect(await service.isHoliday(WEDNESDAY)).toBe(false);
  });

  it('reports a client-specific holiday for the client it belongs to', async () => {
    holidayRows = [{ clientId: SBI, applicableStates: null } as HolidayEntity];
    expect(await service.isHoliday(WEDNESDAY, undefined, SBI)).toBe(true);
  });

  it('does NOT report a client-specific holiday for a different client', async () => {
    holidayRows = [{ clientId: SBI, applicableStates: null } as HolidayEntity];
    expect(await service.isHoliday(WEDNESDAY, undefined, HDFC)).toBe(false);
  });

  it('applies the same client scoping alongside a state restriction', async () => {
    holidayRows = [{ clientId: SBI, applicableStates: ['Maharashtra'] } as HolidayEntity];
    // Right state, wrong (missing) client — must not leak.
    expect(await service.isHoliday(WEDNESDAY, 'Maharashtra')).toBe(false);
    // Right state, right client.
    expect(await service.isHoliday(WEDNESDAY, 'Maharashtra', SBI)).toBe(true);
    // Right client, wrong state.
    expect(await service.isHoliday(WEDNESDAY, 'Karnataka', SBI)).toBe(false);
  });

  it('returns false for an ordinary weekday with no matching holiday row', async () => {
    holidayRows = [];
    expect(await service.isHoliday(WEDNESDAY)).toBe(false);
  });
});

/**
 * Nothing previously stopped the same holiday (same name, same date, same client scope) from
 * being saved twice — a double-click, or two people running "Copy last year's holidays" at
 * once, silently produced two active rows for one date. `isHoliday()` was never wrong (it only
 * asks whether at least one match exists), but the admin calendar listed the same day twice,
 * independently editable and deletable, with nothing distinguishing them.
 */
describe('HolidayService.create — duplicate prevention', () => {
  let service: HolidayService;
  let holidayRepo: any;
  let existingClash: Partial<HolidayEntity> | undefined;

  beforeEach(async () => {
    existingClash = undefined;
    holidayRepo = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => existingClash ?? null),
      })),
      create: jest.fn((v: any) => ({ ...v })),
      save: jest.fn(async (v: any) => ({ id: 'new-holiday-id', ...v })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HolidayService,
        { provide: getRepositoryToken(HolidayEntity), useValue: holidayRepo },
        { provide: getRepositoryToken(ClientConfigurationEntity), useValue: { findOne: jest.fn() } },
        { provide: AuditService, useValue: { recordEvent: jest.fn().mockResolvedValue(undefined) } },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        {
          provide: CacheService,
          useValue: {
            wrap: jest.fn((_k: string, _t: number, load: () => any) => load()),
            delByPattern: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get(HolidayService);
  });

  it('rejects an exact repeat — same name, date and client scope', async () => {
    existingClash = { id: 'existing-1', name: 'Diwali' };
    await expect(
      service.create({ name: 'Diwali', date: '2026-10-20', type: 'NATIONAL' }, 'user-1'),
    ).rejects.toThrow(/already registered for this date/);
  });

  it('allows it when nothing clashes', async () => {
    existingClash = undefined;
    await expect(
      service.create({ name: 'Diwali', date: '2026-10-20', type: 'NATIONAL' }, 'user-1'),
    ).resolves.toBeDefined();
  });
});
