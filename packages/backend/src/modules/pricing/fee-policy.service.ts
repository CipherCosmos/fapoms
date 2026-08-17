import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';

import { ClientConfigurationEntity } from '../client/client-configuration.entity';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { ProjectEntity } from '../project/project.entity';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { TravelMode } from '@fapoms/shared';
import { TransportRateService, TransportEstimate, TransportPlace, RoadLeg } from './transport-rate.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { SETTING_BY_KEY } from '../../infrastructure/settings/settings.registry';

/** Rate cards change rarely (contract renegotiations); a short TTL bounds staleness cheaply. */
const RATES_CACHE_TTL_SECONDS = 300;

/**
 * The single source of truth for what a field audit costs.
 *
 * Before this existed the same calculation lived in two services that disagreed:
 *
 *   assignment.service.ts   base 1200, travel = max(0, km - 10) * 8
 *   day-planner.service.ts  base 1500, travel = km * 8
 *
 * So an assayer 25 km from a branch was quoted ₹200 of travel by the Day Plan screen and
 * stored as ₹120 by the single-branch assign path — same assayer, same branch, ₹80 apart
 * depending on which button ops pressed. Neither number was wrong on its own; there were
 * simply two formulas for one business rule. There is now one.
 *
 * Rates resolve per client (contract terms, versioned by the configuration row's
 * effectiveFrom/effectiveTo) and fall back to the platform defaults below only when a
 * client has not negotiated its own.
 */

/**
 * Platform fallbacks — the SHIPPED values, and the last resort of three.
 *
 * These are no longer the live numbers on their own: an operator can change them at
 * Administration → Platform Settings → Fees, and `platformDefaults()` reads that first. They
 * remain exported as the value used when settings cannot be read, and as what "reset" restores
 * — and they are DERIVED from the registry, so there is exactly one place the shipped number
 * is written down.
 * Do not compare against them directly to decide anything — ask the settings service, or two
 * screens will disagree about the same fee (which is exactly what happened to the Operations
 * Inbox's fee-warning flag).
 */
export const PLATFORM_DEFAULT_TRAVEL_FEE_PER_KM = Number(SETTING_BY_KEY['fees.platformTravelPerKm'].default);
export const PLATFORM_DEFAULT_FREE_TRAVEL_ALLOWANCE_KM = Number(SETTING_BY_KEY['fees.platformFreeTravelKm'].default);
export const PLATFORM_DEFAULT_BASE_FEE = Number(SETTING_BY_KEY['fees.platformBaseFee'].default);

export interface FeeRates {
  travelFeePerKm: number;
  freeTravelAllowanceKm: number;
  defaultBaseFee: number;
  /** False when the client had no configuration row and platform defaults were used. */
  clientConfigured: boolean;
}

export interface FeeBreakdown {
  /** Base fee for a single branch audit. */
  baseFee: number;
  /** Number of branches this quote covers (day plans cover several). */
  branchCount: number;
  /** Total base component: baseFee * branchCount. */
  baseComponent: number;
  /** Raw distance considered, in km. */
  distanceKm: number;
  /** Distance actually charged after the free commute allowance. */
  chargeableKm: number;
  travelFee: number;
  total: number;
  rates: FeeRates;
  /** True when the assayer had no active commercial profile and defaultBaseFee was used. */
  usedFallbackBaseFee: boolean;
  /** Where the base fee came from — shown wherever a fee is displayed, so a number is never anonymous. */
  feeSource: 'ASSAYER_CONTRACT' | 'CLIENT_RATE_CARD' | 'PLATFORM_DEFAULT';
  /**
   * Where the travel component came from. TRANSPORT_RATE_CARD means a desk-managed transport
   * rate matched the branch's place and priced the actual journey (round trip, by the
   * recommended mode); the other two mean the legacy per-km contract formula.
   */
  travelSource: 'TRANSPORT_RATE_CARD' | 'CLIENT_RATE_CARD' | 'PLATFORM_DEFAULT';
  /**
   * How the assayer is expected to travel when the rate card priced the journey — the
   * recommended mode — and how long that takes ONE WAY in minutes, so the card can say
   * "by train, ~3h each way" next to the fee. One way, like `distanceKm` on the estimate: every
   * "each way" display assumes it, and the round-trip figure sits on `transport.recommended`.
   * Both null under the legacy per-km formula, which knows nothing about how anyone travels.
   * The time is a real routed figure only for road modes given a route; otherwise an estimate
   * from an average speed — `transport.recommended.timeSource` says which.
   */
  travelMode: TravelMode | null;
  travelDurationMinutes: number | null;
  /**
   * The transport grounding behind `travelFee` when a rate card matched — the recommended
   * mode and every alternative, each with cost, time, and (when ruled out) why, so the desk can
   * see *why* the number is what it is and argue with it in specifics. Null when no rate row
   * matched the place at all. When rows matched but every mode was ruled out for the distance,
   * this still carries them (with their `whyNot`) while `travelSource` says the fee itself came
   * from the legacy formula — the desk sees both what was considered and what was charged.
   */
  transport: TransportEstimate | null;
  /**
   * Sanity guard. baseFee ÷ the client's reference rate; `feeFlagged` when it exceeds
   * FEE_FLAG_MULTIPLIER (default 1.5×). A mis-entered contract rate (the way ₹4,224 audits
   * once shipped as offers) surfaces as a visible warning instead of silently becoming money.
   */
  feeDeviation: number;
  feeFlagged: boolean;
}

/**
 * Base fees above this multiple of the client's reference rate are flagged, never blocked.
 *
 * The shipped value, derived from the registry so the settings screen and this constant cannot
 * state different numbers. Ask the settings service for the live one.
 */
export const FEE_FLAG_MULTIPLIER =
  Number(process.env.FEE_FLAG_MULTIPLIER) || Number(SETTING_BY_KEY['fees.flagMultiplier'].default);

@Injectable()
export class FeePolicyService implements OnModuleInit {
  private readonly logger = new Logger(FeePolicyService.name);

  onModuleInit(): void {
    /**
     * Client rate cards are cached for five minutes, and a cached entry embeds whichever
     * platform fallbacks were in force when it was written. Changing "what an unpriced audit is
     * worth" and then watching the old number keep coming out for five minutes is exactly the
     * kind of thing that makes people stop trusting a settings screen, so the cache is dropped
     * the moment a fee setting changes.
     */
    this.settings.onChange('fees.', async () => {
      await this.cache.delByPattern('ref:rates:*').catch(() => undefined);
    });
  }

  constructor(
    @InjectRepository(ClientConfigurationEntity)
    private readonly clientConfigRepository: Repository<ClientConfigurationEntity>,
    @InjectRepository(AssayerCommercialProfileEntity)
    private readonly commercialRepository: Repository<AssayerCommercialProfileEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    private readonly cache: CacheService,
    private readonly transportRateService: TransportRateService,
    private readonly settings: PlatformSettingsService,
  ) {}

  /**
   * The platform fallbacks, as configured.
   *
   * These were exported constants — the last three business decisions in this file that only a
   * deploy could change. They are still the LAST resort: an assayer's contracted fee and a
   * client's rate card both win over them, exactly as before. Reading them through settings
   * only means an operator can correct "what an unpriced audit is worth" without an engineer.
   */
  private async platformDefaults(): Promise<{ baseFee: number; perKm: number; freeKm: number }> {
    const [baseFee, perKm, freeKm] = await Promise.all([
      this.settings.getNumber('fees.platformBaseFee', PLATFORM_DEFAULT_BASE_FEE),
      this.settings.getNumber('fees.platformTravelPerKm', PLATFORM_DEFAULT_TRAVEL_FEE_PER_KM),
      this.settings.getNumber('fees.platformFreeTravelKm', PLATFORM_DEFAULT_FREE_TRAVEL_ALLOWANCE_KM),
    ]).catch(() => [PLATFORM_DEFAULT_BASE_FEE, PLATFORM_DEFAULT_TRAVEL_FEE_PER_KM, PLATFORM_DEFAULT_FREE_TRAVEL_ALLOWANCE_KM]);
    return { baseFee, perKm, freeKm };
  }

  /**
   * Resolve which client's rate card applies from a project. Lets callers quote without
   * having to carry a clientId around the UI just to price something.
   */
  async resolveClientIdForProject(projectId: string): Promise<string | null> {
    const project = await this.projectRepository
      .findOne({ where: { id: projectId }, select: ['id', 'clientId'] })
      .catch(() => null);
    return project?.clientId ?? null;
  }

  /**
   * Resolve the rate card in force for a client.
   *
   * Callers that already hold a loaded `configuration` relation should pass it to
   * `ratesFromConfiguration` instead of paying for another query.
   */
  async getRates(clientId?: string | null): Promise<FeeRates> {
    const fallbacks = await this.platformDefaults();
    // Read on every fee quote; cache the resolved rate card so a hot quoting path
    // doesn't hit the configuration table each time. Read-through, so a cache miss
    // (including Redis being down) simply resolves from the database as before.
    if (!clientId) {
      // Not cached under a shared key: the platform fallbacks can change from the settings
      // screen, and a five-minute stale copy of "what an audit costs" is worth less than the
      // one query this saves.
      return this.ratesFromConfiguration(null, fallbacks);
    }

    return this.cache.wrap(`ref:rates:client:${clientId}`, RATES_CACHE_TTL_SECONDS, async () => {
      const config = await this.clientConfigRepository
        .findOne({ where: { clientId }, order: { effectiveFrom: 'DESC' } })
        .catch(() => null);

      return this.ratesFromConfiguration(config, fallbacks);
    });
  }

  /** Same resolution, for callers that already loaded the configuration row. */
  ratesFromConfiguration(
    config: Partial<ClientConfigurationEntity> | null | undefined,
    fallbacks?: { baseFee: number; perKm: number; freeKm: number },
  ): FeeRates {
    const fb = fallbacks ?? {
      baseFee: PLATFORM_DEFAULT_BASE_FEE,
      perKm: PLATFORM_DEFAULT_TRAVEL_FEE_PER_KM,
      freeKm: PLATFORM_DEFAULT_FREE_TRAVEL_ALLOWANCE_KM,
    };
    const num = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    return {
      travelFeePerKm: num(config?.travelFeePerKm) ?? fb.perKm,
      // 0 is a legitimate value here ("charge from the first kilometre"), so this must
      // distinguish null from zero — `??`, never `||`.
      freeTravelAllowanceKm: num(config?.freeTravelAllowanceKm) ?? fb.freeKm,
      defaultBaseFee: num(config?.defaultBaseFee) ?? fb.baseFee,
      clientConfigured: !!config,
    };
  }

  /**
   * The assayer's contracted base fee on a given date, or the client's default when the
   * assayer has no active profile.
   */
  async resolveBaseFee(
    assayerId: string,
    rates: FeeRates,
    onDate?: Date,
  ): Promise<{ baseFee: number; usedFallback: boolean }> {
    const at = onDate ?? new Date();

    const profile = await this.commercialRepository
      .createQueryBuilder('p')
      .where('p.assayerId = :assayerId', { assayerId })
      .andWhere('p.isActive = true')
      .andWhere('p.effectiveStartDate <= :at', { at })
      .andWhere('(p.effectiveEndDate IS NULL OR p.effectiveEndDate >= :at)', { at })
      .orderBy('p.effectiveStartDate', 'DESC')
      .getOne()
      .catch(() => null);

    const fee = profile?.baseFee !== undefined && profile?.baseFee !== null ? Number(profile.baseFee) : NaN;

    if (Number.isFinite(fee) && fee > 0) {
      return { baseFee: fee, usedFallback: false };
    }
    return { baseFee: rates.defaultBaseFee, usedFallback: true };
  }

  /**
   * The same rule as `resolveBaseFee`, answered for many assayers in one query.
   *
   * The candidate list called `resolveBaseFee` once per ranked assayer, which is one indexed
   * round trip each — invisible for one branch and multiplied by every branch when a project-
   * wide plan asks for candidates across a whole book. Selection is identical: among a
   * candidate's active profiles that are in force on `onDate`, the one with the latest
   * effective start; anything else falls back to the client's default rate. Deriving both from
   * one loader keeps the batch and single-row paths from disagreeing about what an assayer costs.
   */
  async resolveBaseFees(
    assayerIds: string[],
    rates: FeeRates,
    onDate?: Date,
  ): Promise<Map<string, { baseFee: number; usedFallback: boolean }>> {
    const at = onDate ?? new Date();
    const result = new Map<string, { baseFee: number; usedFallback: boolean }>();
    if (assayerIds.length === 0) return result;

    const profiles = await this.commercialRepository
      .createQueryBuilder('p')
      .where('p.assayerId IN (:...assayerIds)', { assayerIds })
      .andWhere('p.isActive = true')
      .andWhere('p.effectiveStartDate <= :at', { at })
      .andWhere('(p.effectiveEndDate IS NULL OR p.effectiveEndDate >= :at)', { at })
      // Ascending, so the last write per assayer below is the latest start date — the same row
      // `getOne()` returns for a DESC order.
      .orderBy('p.effectiveStartDate', 'ASC')
      .getMany()
      .catch(() => []);

    const winning = new Map<string, (typeof profiles)[number]>();
    for (const profile of profiles) winning.set(profile.assayerId, profile);

    for (const assayerId of assayerIds) {
      const profile = winning.get(assayerId);
      const fee = profile?.baseFee !== undefined && profile?.baseFee !== null ? Number(profile.baseFee) : NaN;
      result.set(
        assayerId,
        Number.isFinite(fee) && fee > 0
          ? { baseFee: fee, usedFallback: false }
          : { baseFee: rates.defaultBaseFee, usedFallback: true },
      );
    }
    return result;
  }

  /**
   * Travel allowance for a distance. The free commute allowance is deducted first —
   * this is the rule that the day-planner path used to skip entirely.
   */
  calculateTravelFee(distanceKm: number, rates: FeeRates): { chargeableKm: number; travelFee: number } {
    const km = Number.isFinite(distanceKm) && distanceKm > 0 ? distanceKm : 0;
    const chargeableKm = Math.max(0, km - rates.freeTravelAllowanceKm);
    return {
      chargeableKm,
      travelFee: Math.round(chargeableKm * rates.travelFeePerKm),
    };
  }

  /**
   * Full quote. `branchCount` > 1 covers a day plan visiting several branches on one
   * trip: the base fee is per branch audited, travel is charged once for the whole route.
   */
  async quote(params: {
    assayerId: string;
    clientId?: string | null;
    distanceKm: number;
    branchCount?: number;
    onDate?: Date;
    /** Pre-loaded configuration, to avoid a redundant query. */
    configuration?: Partial<ClientConfigurationEntity> | null;
    /**
     * Where the journey ends — the branch's state and/or region. When supplied and a transport
     * rate matches, the travel component is the real journey cost by the recommended mode
     * instead of the legacy contract per-km. Callers that cannot say where the work is (or
     * pass 0 km) keep the legacy formula unchanged.
     */
    place?: TransportPlace | null;
    /**
     * True when `distanceKm` already covers the whole journey (a day plan's optimized route
     * is a closed loop ending at home). The transport estimate then charges the loop once
     * instead of doubling it. The legacy per-km formula is unaffected — it has always
     * charged whatever distance it was handed exactly once.
     */
    distanceIsRoundTrip?: boolean;
    /**
     * The routed road leg for this journey, when the caller has one (the day planner and the
     * candidate ranker route before they quote). Gives car/taxi/auto/two-wheeler their REAL
     * drive time in the mode comparison instead of a distance-÷-speed estimate; the fee is
     * unaffected either way. Same convention as `distanceKm`: the loop's minutes under
     * `distanceIsRoundTrip`, one way otherwise.
     */
    road?: RoadLeg | null;
  }): Promise<FeeBreakdown> {
    const rates = params.configuration !== undefined
      ? this.ratesFromConfiguration(params.configuration, await this.platformDefaults())
      : await this.getRates(params.clientId);

    const { baseFee, usedFallback } = await this.resolveBaseFee(params.assayerId, rates, params.onDate);
    const branchCount = Math.max(1, params.branchCount ?? 1);

    /**
     * Travel: the transport rate card when it can speak for this place, the contract per-km
     * formula otherwise.
     *
     * The two differ on purpose. The legacy formula deducts the client's free-commute
     * allowance and charges one way, because it prices what the *client* is billed. A
     * transport rate prices what the journey *costs the assayer* — a bus ticket has no free
     * first 10 km and must be bought in both directions — so it uses the full distance, round
     * trip, and no allowance. Which one produced the number is never ambiguous:
     * `travelSource` says, and `transport` carries the workings.
     *
     * The rate card lookup failing (cache down, table unreachable) falls back to the legacy
     * formula rather than failing the quote — an offer priced the old way beats no offer.
     *
     * The fee is `recommended.roundTripCost`, exactly as before the recommendation learned
     * about time: the mode comparison decides WHICH mode's cost becomes the fee, never the
     * arithmetic of that cost. Rates matched but every mode ruled out (an auto-only rate card
     * and a 200 km journey) is treated like no match for the money — legacy formula — but the
     * ruled-out options ride along in `transport` so the desk can see what was considered.
     */
    let chargeableKm: number;
    let travelFee: number;
    let travelSource: FeeBreakdown['travelSource'];
    let travelMode: TravelMode | null = null;
    let travelDurationMinutes: number | null = null;
    let transport: TransportEstimate | null = null;

    const estimate = params.place
      ? await this.transportRateService
          .estimate(params.distanceKm, params.place, params.onDate, {
            distanceIsRoundTrip: params.distanceIsRoundTrip,
            road: params.road ?? null,
          })
          .catch((err) => {
            this.logger.warn(`Transport rate lookup failed; quoting legacy travel: ${err?.message ?? err}`);
            return null;
          })
      : null;

    if (estimate && estimate.options.length > 0) transport = estimate;

    if (estimate?.recommended) {
      chargeableKm = estimate.distanceKm;
      travelFee = estimate.recommended.roundTripCost;
      travelSource = 'TRANSPORT_RATE_CARD';
      travelMode = estimate.recommended.mode;
      travelDurationMinutes = estimate.recommended.oneWayMinutes;
    } else {
      const legacy = this.calculateTravelFee(params.distanceKm, rates);
      chargeableKm = legacy.chargeableKm;
      travelFee = legacy.travelFee;
      travelSource = rates.clientConfigured ? 'CLIENT_RATE_CARD' : 'PLATFORM_DEFAULT';
    }

    const baseComponent = baseFee * branchCount;

    const feeSource: FeeBreakdown['feeSource'] = !usedFallback
      ? 'ASSAYER_CONTRACT'
      : rates.clientConfigured
      ? 'CLIENT_RATE_CARD'
      : 'PLATFORM_DEFAULT';
    const reference = rates.defaultBaseFee > 0 ? rates.defaultBaseFee : baseFee;
    const feeDeviation = reference > 0 ? Number((baseFee / reference).toFixed(2)) : 1;
    const flagMultiplier = await this.settings
      .getNumber('fees.flagMultiplier', FEE_FLAG_MULTIPLIER)
      .catch(() => FEE_FLAG_MULTIPLIER);

    return {
      baseFee,
      branchCount,
      baseComponent,
      distanceKm: Number.isFinite(params.distanceKm) && params.distanceKm > 0 ? params.distanceKm : 0,
      chargeableKm,
      travelFee,
      total: baseComponent + travelFee,
      rates,
      usedFallbackBaseFee: usedFallback,
      feeSource,
      travelSource,
      travelMode,
      travelDurationMinutes,
      transport,
      feeDeviation,
      feeFlagged: feeDeviation > flagMultiplier,
    };
  }
}
