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

/**
 * These lock in the behaviour that the two old duplicate implementations disagreed on:
 * whether the free-commute allowance applies, and what the base-fee fallback is.
 */
describe('FeePolicyService', () => {
  let service: FeePolicyService;
  let clientConfigRepo: any;
  let commercialRepo: any;
  let projectRepo: any;
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeePolicyService,
        { provide: getRepositoryToken(ClientConfigurationEntity), useValue: clientConfigRepo },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: commercialRepo },
        { provide: getRepositoryToken(ProjectEntity), useValue: projectRepo },
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
});
