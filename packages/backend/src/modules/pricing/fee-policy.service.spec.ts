import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  FeePolicyService,
  PLATFORM_DEFAULT_TRAVEL_FEE_PER_KM,
  PLATFORM_DEFAULT_FREE_TRAVEL_ALLOWANCE_KM,
  PLATFORM_DEFAULT_BASE_FEE,
} from './fee-policy.service';
import { ClientConfigurationEntity } from '../client/client-configuration.entity';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { ProjectEntity } from '../project/project.entity';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { TransportRateService } from './transport-rate.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';

/**
 * These lock in the behaviour that the two old duplicate implementations disagreed on:
 * whether the free-commute allowance applies, and what the base-fee fallback is.
 */
describe('FeePolicyService', () => {
  let service: FeePolicyService;
  let clientConfigRepo: any;
  let commercialRepo: any;
  let projectRepo: any;
  let transportRates: any;
  let qb: any;

  beforeEach(async () => {
    qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    clientConfigRepo = { findOne: jest.fn().mockResolvedValue(null) };
    commercialRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    projectRepo = { findOne: jest.fn().mockResolvedValue(null) };
    // No transport rates by default — the legacy travel formula these tests were written
    // against stays in force unless a test provides an estimate.
    transportRates = {
      estimate: jest.fn().mockResolvedValue({ distanceKm: 0, options: [], recommended: null }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeePolicyService,
        { provide: getRepositoryToken(ClientConfigurationEntity), useValue: clientConfigRepo },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: commercialRepo },
        { provide: getRepositoryToken(ProjectEntity), useValue: projectRepo },
        { provide: TransportRateService, useValue: transportRates },
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
        {
          provide: CacheService,
          useValue: {
            // Read-through: run the loader so these tests hit the real resolution logic.
            wrap: jest.fn((_key: string, _ttl: number, load: () => any) => load()),
            getJson: jest.fn().mockResolvedValue(null),
            setJson: jest.fn(),
            del: jest.fn(),
            delByPattern: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<FeePolicyService>(FeePolicyService);
  });

  describe('rate resolution', () => {
    it('falls back to platform defaults when the client has no configuration', () => {
      const rates = service.ratesFromConfiguration(null);
      expect(rates.travelFeePerKm).toBe(PLATFORM_DEFAULT_TRAVEL_FEE_PER_KM);
      expect(rates.freeTravelAllowanceKm).toBe(PLATFORM_DEFAULT_FREE_TRAVEL_ALLOWANCE_KM);
      expect(rates.defaultBaseFee).toBe(PLATFORM_DEFAULT_BASE_FEE);
      expect(rates.clientConfigured).toBe(false);
    });

    it("prefers the client's contracted rates over the platform defaults", () => {
      const rates = service.ratesFromConfiguration({
        travelFeePerKm: 12 as any,
        freeTravelAllowanceKm: 25 as any,
        defaultBaseFee: 1800 as any,
      });
      expect(rates).toMatchObject({ travelFeePerKm: 12, freeTravelAllowanceKm: 25, defaultBaseFee: 1800 });
    });

    it('treats a zero free-travel allowance as "charge from the first km", not as unset', () => {
      // Guards the `??` vs `||` distinction — with `||` this would silently become 10.
      const rates = service.ratesFromConfiguration({ freeTravelAllowanceKm: 0 as any });
      expect(rates.freeTravelAllowanceKm).toBe(0);
    });

    it('ignores non-numeric configured values rather than producing NaN fees', () => {
      const rates = service.ratesFromConfiguration({ travelFeePerKm: 'abc' as any });
      expect(rates.travelFeePerKm).toBe(PLATFORM_DEFAULT_TRAVEL_FEE_PER_KM);
    });
  });

  describe('calculateTravelFee', () => {
    const rates = { travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: true };

    it('exempts the local commute allowance', () => {
      // The exact case the two implementations disagreed on: at 25 km the day planner
      // charged 25*8 = 200, the assign path charged (25-10)*8 = 120. 120 is the rule.
      expect(service.calculateTravelFee(25, rates)).toEqual({ chargeableKm: 15, travelFee: 120 });
    });

    it('charges nothing inside the allowance', () => {
      expect(service.calculateTravelFee(7, rates)).toEqual({ chargeableKm: 0, travelFee: 0 });
    });

    it('treats a missing or negative distance as zero rather than a negative fee', () => {
      expect(service.calculateTravelFee(NaN, rates).travelFee).toBe(0);
      expect(service.calculateTravelFee(-5, rates).travelFee).toBe(0);
    });
  });

  describe('resolveBaseFee', () => {
    const rates = { travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: true };

    it("uses the assayer's active commercial profile when one exists", async () => {
      qb.getOne.mockResolvedValue({ baseFee: '1650.00' });
      await expect(service.resolveBaseFee('a1', rates)).resolves.toEqual({ baseFee: 1650, usedFallback: false });
    });

    it('falls back to the client default when the assayer has no active profile', async () => {
      qb.getOne.mockResolvedValue(null);
      await expect(service.resolveBaseFee('a1', rates)).resolves.toEqual({ baseFee: 1200, usedFallback: true });
    });

    it('flags the fallback so callers can surface an unpriced assayer', async () => {
      qb.getOne.mockResolvedValue({ baseFee: 0 });
      const result = await service.resolveBaseFee('a1', rates);
      expect(result.usedFallback).toBe(true);
    });
  });

  describe('quote', () => {
    it('prices a single-branch assignment as base + allowance-adjusted travel', async () => {
      qb.getOne.mockResolvedValue({ baseFee: 1200 });
      const q = await service.quote({ assayerId: 'a1', clientId: null, distanceKm: 25 });
      expect(q).toMatchObject({ baseFee: 1200, branchCount: 1, travelFee: 120, total: 1320 });
    });

    it('charges base fee per branch but travel once for a multi-branch day plan', async () => {
      qb.getOne.mockResolvedValue({ baseFee: 1200 });
      const q = await service.quote({ assayerId: 'a1', clientId: null, distanceKm: 60, branchCount: 3 });
      expect(q.baseComponent).toBe(3600);
      expect(q.travelFee).toBe(400); // (60 - 10) * 8, charged once for the route
      expect(q.total).toBe(4000);
    });

    it('produces the same figure regardless of which caller asks — the divergence regression', async () => {
      qb.getOne.mockResolvedValue({ baseFee: 1200 });
      const assignLike = await service.quote({ assayerId: 'a1', clientId: null, distanceKm: 25 });
      const planLike = await service.quote({ assayerId: 'a1', clientId: null, distanceKm: 25, branchCount: 1 });
      expect(assignLike.total).toBe(planLike.total);
    });
  });

  describe('quote with a transport rate card', () => {
    const busEstimate = {
      distanceKm: 25,
      options: [
        {
          mode: 'BUS', modeLabel: 'Bus', scopeType: 'NATIONAL', scopeValue: null,
          baseFare: 10, perKmRate: 1.5, oneWayCost: 48, roundTripCost: 96, preferred: true,
        },
      ],
      recommended: {
        mode: 'BUS', modeLabel: 'Bus', scopeType: 'NATIONAL', scopeValue: null,
        baseFare: 10, perKmRate: 1.5, oneWayCost: 48, roundTripCost: 96, preferred: true,
      },
    };

    it('prices travel from the rate card when the place has one, and says so', async () => {
      qb.getOne.mockResolvedValue({ baseFee: 1200 });
      transportRates.estimate.mockResolvedValue(busEstimate);

      const q = await service.quote({
        assayerId: 'a1', clientId: null, distanceKm: 25, place: { state: 'Kerala' },
      });

      // Round-trip bus cost, full distance — no free-km deduction: a bus ticket has no free
      // first 10 km and must be bought both ways.
      expect(q.travelFee).toBe(96);
      expect(q.chargeableKm).toBe(25);
      expect(q.total).toBe(1296);
      expect(q.travelSource).toBe('TRANSPORT_RATE_CARD');
      expect(q.transport?.recommended?.mode).toBe('BUS');
    });

    it('keeps the legacy formula when no rate matches the place', async () => {
      qb.getOne.mockResolvedValue({ baseFee: 1200 });
      transportRates.estimate.mockResolvedValue({ distanceKm: 25, options: [], recommended: null });

      const q = await service.quote({
        assayerId: 'a1', clientId: null, distanceKm: 25, place: { state: 'Kerala' },
      });

      expect(q.travelFee).toBe(120); // (25 - 10) * 8
      expect(q.travelSource).toBe('PLATFORM_DEFAULT');
      expect(q.transport).toBeNull();
    });

    it('keeps the legacy formula when the caller cannot say where the work is', async () => {
      qb.getOne.mockResolvedValue({ baseFee: 1200 });
      const q = await service.quote({ assayerId: 'a1', clientId: null, distanceKm: 25 });
      expect(q.travelFee).toBe(120);
      expect(transportRates.estimate).not.toHaveBeenCalled();
    });

    it('quotes legacy travel rather than failing when the rate lookup breaks', async () => {
      // An offer priced the old way beats no offer. The desk seeing CLIENT_RATE_CARD /
      // PLATFORM_DEFAULT provenance is the honest account of what happened.
      qb.getOne.mockResolvedValue({ baseFee: 1200 });
      transportRates.estimate.mockRejectedValue(new Error('redis down'));

      const q = await service.quote({
        assayerId: 'a1', clientId: null, distanceKm: 25, place: { state: 'Kerala' },
      });

      expect(q.travelFee).toBe(120);
      expect(q.travelSource).toBe('PLATFORM_DEFAULT');
    });
  });
});
