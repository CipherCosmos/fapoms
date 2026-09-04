import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TravelMode } from '@fapoms/shared';

import { TransportRateService } from './transport-rate.service';
import { TransportRateEntity } from './transport-rate.entity';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { AuditService } from '../../core/audit/audit.service';

/**
 * Create/update/deactivate on the transport rate card had no audit trail at all — a desk could
 * not answer "who changed this fare and when". Each test here fails on the pre-fix code with
 * "recordEventSafe was never called".
 */
describe('TransportRateService — audit trail for create/update/deactivate', () => {
  let service: TransportRateService;
  let repo: any;
  const audit = { recordEvent: jest.fn(), recordEventSafe: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((v: any) => v),
      save: jest.fn(async (v: any) => ({ id: 'r-1', ...v })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransportRateService,
        { provide: getRepositoryToken(TransportRateEntity), useValue: repo },
        { provide: CacheService, useValue: { wrap: jest.fn((_k: string, _t: number, load: () => any) => load()), del: jest.fn().mockResolvedValue(undefined) } },
        { provide: PlatformSettingsService, useValue: { getMany: jest.fn().mockResolvedValue({}) } },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(TransportRateService);
    jest.clearAllMocks();
  });

  it('records TRANSPORT_RATE_CREATED on create', async () => {
    await service.create({
      mode: TravelMode.BUS, scopeType: 'NATIONAL', scopeValue: null,
      baseFare: 100, perKmRate: 5, effectiveFrom: '2026-01-01',
    } as any, 'user-1');

    expect(audit.recordEventSafe).toHaveBeenCalledTimes(1);
    expect(audit.recordEventSafe.mock.calls[0][0].eventType).toBe('TRANSPORT_RATE_CREATED');
  });

  it('records TRANSPORT_RATE_UPDATED on update, with the fare before and after', async () => {
    repo.findOne.mockResolvedValue({
      id: 'r-1', mode: TravelMode.BUS, scopeType: 'NATIONAL', scopeValue: null,
      baseFare: 100, perKmRate: 5, isPreferred: false, effectiveFrom: '2026-01-01',
      effectiveTo: null, isActive: true, notes: null,
    });

    await service.update('r-1', { baseFare: 200 } as any, 'user-1');

    expect(audit.recordEventSafe).toHaveBeenCalledTimes(1);
    const dto = audit.recordEventSafe.mock.calls[0][0];
    expect(dto.eventType).toBe('TRANSPORT_RATE_UPDATED');
    expect(dto.metadata.previousValue.baseFare).toBe(100);
    expect(dto.metadata.newValue.baseFare).toBe(200);
  });

  /** deactivate() goes through update() (one UPDATED event) plus its own DEACTIVATED event. */
  it('records both TRANSPORT_RATE_UPDATED and TRANSPORT_RATE_DEACTIVATED on deactivate', async () => {
    repo.findOne.mockResolvedValue({
      id: 'r-1', mode: TravelMode.BUS, scopeType: 'NATIONAL', scopeValue: null,
      baseFare: 100, perKmRate: 5, isPreferred: false, effectiveFrom: '2026-01-01',
      effectiveTo: null, isActive: true, notes: null,
    });

    await service.deactivate('r-1', 'user-1');

    expect(audit.recordEventSafe).toHaveBeenCalledTimes(2);
    const eventTypes = audit.recordEventSafe.mock.calls.map((c) => c[0].eventType);
    expect(eventTypes).toEqual(['TRANSPORT_RATE_UPDATED', 'TRANSPORT_RATE_DEACTIVATED']);
  });
});
