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
      estimate: jest.fn().mockResolvedValue({ distanceKm: 0, options: [], recommended: null, road: null, policy: {} }),
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

  /**
   * The legacy per-km travel figure, stated as the rule rather than as a number.
   *
   * These expectations were literals worked out from a 10 km free allowance — `(60 - 10) * 8`.
   * Raising the allowance to 50 km broke six of them, all reporting the formula wrong when the
   * formula had not changed. A test of "travel is charged beyond the free allowance" should say
   * exactly that, and keep passing when somebody moves the allowance.
   */
  const legacyTravel = (km: number): number =>
    Math.round(
      Math.max(0, km - PLATFORM_DEFAULT_FREE_TRAVEL_ALLOWANCE_KM) * PLATFORM_DEFAULT_TRAVEL_FEE_PER_KM,
    );

  describe('quote', () => {
    it('prices a single-branch assignment as base + allowance-adjusted travel', async () => {
      qb.getOne.mockResolvedValue({ baseFee: 1200 });
      const q = await service.quote({ assayerId: 'a1', clientId: null, distanceKm: 25 });
      expect(q).toMatchObject({
        baseFee: 1200, branchCount: 1,
        travelFee: legacyTravel(25), total: 1200 + legacyTravel(25),
      });
    });

    /**
     * A branch inside the assayer's own city is their commute, not a journey the company sends
     * them on. At the previous 10 km allowance almost every audit carried a travel line — most of
     * them for a few rupees — and each still had to be quoted, agreed, carved out of the payable
     * and reconciled against a claim.
     */
    it('pays nothing for travel inside the free commute allowance', async () => {
      qb.getOne.mockResolvedValue({ baseFee: 1200 });

      const nearby = await service.quote({
        assayerId: 'a1', clientId: null,
        distanceKm: PLATFORM_DEFAULT_FREE_TRAVEL_ALLOWANCE_KM - 1,
      });
      expect(nearby.travelFee).toBe(0);
      expect(nearby.total).toBe(1200);

      // And exactly at the boundary: the allowance is inclusive.
      const atTheEdge = await service.quote({
        assayerId: 'a1', clientId: null, distanceKm: PLATFORM_DEFAULT_FREE_TRAVEL_ALLOWANCE_KM,
      });
      expect(atTheEdge.travelFee).toBe(0);
    });

    it('charges only the distance beyond the allowance, not the whole journey', async () => {
      qb.getOne.mockResolvedValue({ baseFee: 1200 });
      const km = PLATFORM_DEFAULT_FREE_TRAVEL_ALLOWANCE_KM + 10;

      const q = await service.quote({ assayerId: 'a1', clientId: null, distanceKm: km });

      expect(q.travelFee).toBe(10 * PLATFORM_DEFAULT_TRAVEL_FEE_PER_KM);
      expect(q.travelFee).toBeLessThan(km * PLATFORM_DEFAULT_TRAVEL_FEE_PER_KM);
    });

    it('charges base fee per branch but travel once for a multi-branch day plan', async () => {
      qb.getOne.mockResolvedValue({ baseFee: 1200 });
      const q = await service.quote({ assayerId: 'a1', clientId: null, distanceKm: 60, branchCount: 3 });
      expect(q.baseComponent).toBe(3600);
      // Charged once for the route, however many branches it covers.
      expect(q.travelFee).toBe(legacyTravel(60));
      expect(q.total).toBe(3600 + legacyTravel(60));
    });

    it('produces the same figure regardless of which caller asks — the divergence regression', async () => {
      qb.getOne.mockResolvedValue({ baseFee: 1200 });
      const assignLike = await service.quote({ assayerId: 'a1', clientId: null, distanceKm: 25 });
      const planLike = await service.quote({ assayerId: 'a1', clientId: null, distanceKm: 25, branchCount: 1 });
      expect(assignLike.total).toBe(planLike.total);
    });
  });

  describe('quote with a transport rate card', () => {
    const busOption = {
      mode: 'BUS', modeLabel: 'Bus', scopeType: 'NATIONAL', scopeValue: null,
      baseFare: 10, perKmRate: 1.5, oneWayCost: 48, roundTripCost: 96, preferred: true,
      // 25 km at the bus's 40 km/h setting: 38 min each way — an estimate, labelled as one.
      oneWayMinutes: 38, roundTripMinutes: 75, timeSource: 'RATE_CARD_ESTIMATE', assumedSpeedKmh: 40,
      viable: true, whyNot: null, rank: 1, score: 0, reason: 'preferred nationally',
    };
    const policy = {
      weightCost: 0.6, weightTime: 0.4, flightMinKm: 500, twoWheelerMaxKm: 150, autoMaxKm: 40,
      flightOverheadMinutes: 180, avgSpeedKmh: {},
    };
    const busEstimate = {
      distanceKm: 25,
      options: [busOption],
      recommended: busOption,
      road: null,
      policy,
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
      // "by bus, ~38 min each way" — the mode and its one-way time ride on the breakdown.
      expect(q.travelMode).toBe('BUS');
      expect(q.travelDurationMinutes).toBe(38);
    });

    it('hands the routed road leg to the estimator, so road modes are timed by the real drive', async () => {
      qb.getOne.mockResolvedValue({ baseFee: 1200 });
      transportRates.estimate.mockResolvedValue(busEstimate);
      const road = { distanceKm: 25, durationMinutes: 41, source: 'OSRM' as const };

      await service.quote({
        assayerId: 'a1', clientId: null, distanceKm: 25, place: { state: 'Kerala' }, road,
      });

      expect(transportRates.estimate).toHaveBeenCalledWith(
        25, { state: 'Kerala' }, undefined, expect.objectContaining({ road }),
      );
    });

    it('keeps the legacy formula when no rate matches the place', async () => {
      qb.getOne.mockResolvedValue({ baseFee: 1200 });
      transportRates.estimate.mockResolvedValue({ distanceKm: 25, options: [], recommended: null, road: null, policy });

      const q = await service.quote({
        assayerId: 'a1', clientId: null, distanceKm: 25, place: { state: 'Kerala' },
      });

      expect(q.travelFee).toBe(legacyTravel(25)); // (25 - 10) * 8
      expect(q.travelSource).toBe('PLATFORM_DEFAULT');
      expect(q.transport).toBeNull();
      expect(q.travelMode).toBeNull();
      expect(q.travelDurationMinutes).toBeNull();
    });

    it('prices the legacy way when rates matched but every mode was ruled out — and still shows them', async () => {
      // An auto-only rate card and a 60 km run: the old rule would have recommended a 60 km
      // auto because it was the only row. Now nothing is recommended, the fee is the legacy
      // per-km, and the ruled-out option rides along so the desk can see what was considered.
      qb.getOne.mockResolvedValue({ baseFee: 1200 });
      const ruledOut = {
        ...busOption, mode: 'AUTO_RICKSHAW', modeLabel: 'Auto-rickshaw', roundTripCost: 1490,
        viable: false, whyNot: 'Auto-rickshaw journeys are capped at 40 km one way; this journey is 60 km',
        score: null, reason: null, preferred: false,
      };
      transportRates.estimate.mockResolvedValue({ distanceKm: 60, options: [ruledOut], recommended: null, road: null, policy });

      const q = await service.quote({
        assayerId: 'a1', clientId: null, distanceKm: 60, place: { state: 'Kerala' },
      });

      expect(q.travelFee).toBe(legacyTravel(60)); // the legacy formula, not ₹1,490 by auto
      expect(q.travelSource).toBe('PLATFORM_DEFAULT');
      expect(q.travelMode).toBeNull();
      expect(q.transport?.options[0]).toMatchObject({ mode: 'AUTO_RICKSHAW', viable: false });
      expect(q.transport?.recommended).toBeNull();
    });

    it('keeps the legacy formula when the caller cannot say where the work is', async () => {
      qb.getOne.mockResolvedValue({ baseFee: 1200 });
      const q = await service.quote({ assayerId: 'a1', clientId: null, distanceKm: 25 });
      expect(q.travelFee).toBe(legacyTravel(25));
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

      expect(q.travelFee).toBe(legacyTravel(25));
      expect(q.travelSource).toBe('PLATFORM_DEFAULT');
    });
  });
});
