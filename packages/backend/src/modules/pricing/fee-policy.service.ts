import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';

import { ClientConfigurationEntity } from '../client/client-configuration.entity';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { ProjectEntity } from '../project/project.entity';
import { CacheService } from '../../infrastructure/cache/cache.service';

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

/** Platform fallbacks. Only used when a client has no configured rate. */
export const PLATFORM_DEFAULT_TRAVEL_FEE_PER_KM = 8;
export const PLATFORM_DEFAULT_FREE_TRAVEL_ALLOWANCE_KM = 10;
export const PLATFORM_DEFAULT_BASE_FEE = 1200;

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
   * Sanity guard. baseFee ÷ the client's reference rate; `feeFlagged` when it exceeds
   * FEE_FLAG_MULTIPLIER (default 1.5×). A mis-entered contract rate (the way ₹4,224 audits
   * once shipped as offers) surfaces as a visible warning instead of silently becoming money.
   */
  feeDeviation: number;
  feeFlagged: boolean;
}

/** Base fees above this multiple of the client's reference rate are flagged, never blocked. */
export const FEE_FLAG_MULTIPLIER = Number(process.env.FEE_FLAG_MULTIPLIER) || 1.5;

@Injectable()
export class FeePolicyService {
  private readonly logger = new Logger(FeePolicyService.name);

  constructor(
    @InjectRepository(ClientConfigurationEntity)
    private readonly clientConfigRepository: Repository<ClientConfigurationEntity>,
    @InjectRepository(AssayerCommercialProfileEntity)
    private readonly commercialRepository: Repository<AssayerCommercialProfileEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    private readonly cache: CacheService,
  ) {}

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
    // Read on every fee quote; cache the resolved rate card so a hot quoting path
    // doesn't hit the configuration table each time. Read-through, so a cache miss
    // (including Redis being down) simply resolves from the database as before.
    if (!clientId) {
      return this.cache.wrap('ref:rates:default', RATES_CACHE_TTL_SECONDS, async () =>
        this.ratesFromConfiguration(null),
      );
    }

    return this.cache.wrap(`ref:rates:client:${clientId}`, RATES_CACHE_TTL_SECONDS, async () => {
      const config = await this.clientConfigRepository
        .findOne({ where: { clientId }, order: { effectiveFrom: 'DESC' } })
        .catch(() => null);

      return this.ratesFromConfiguration(config);
    });
  }

  /** Same resolution, for callers that already loaded the configuration row. */
  ratesFromConfiguration(config: Partial<ClientConfigurationEntity> | null | undefined): FeeRates {
    const num = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    return {
      travelFeePerKm: num(config?.travelFeePerKm) ?? PLATFORM_DEFAULT_TRAVEL_FEE_PER_KM,
      // 0 is a legitimate value here ("charge from the first kilometre"), so this must
      // distinguish null from zero — `??`, never `||`.
      freeTravelAllowanceKm:
        num(config?.freeTravelAllowanceKm) ?? PLATFORM_DEFAULT_FREE_TRAVEL_ALLOWANCE_KM,
      defaultBaseFee: num(config?.defaultBaseFee) ?? PLATFORM_DEFAULT_BASE_FEE,
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
  }): Promise<FeeBreakdown> {
    const rates = params.configuration !== undefined
      ? this.ratesFromConfiguration(params.configuration)
      : await this.getRates(params.clientId);

    const { baseFee, usedFallback } = await this.resolveBaseFee(params.assayerId, rates, params.onDate);
    const branchCount = Math.max(1, params.branchCount ?? 1);
    const { chargeableKm, travelFee } = this.calculateTravelFee(params.distanceKm, rates);

    const baseComponent = baseFee * branchCount;

    const feeSource: FeeBreakdown['feeSource'] = !usedFallback
      ? 'ASSAYER_CONTRACT'
      : rates.clientConfigured
      ? 'CLIENT_RATE_CARD'
      : 'PLATFORM_DEFAULT';
    const reference = rates.defaultBaseFee > 0 ? rates.defaultBaseFee : baseFee;
    const feeDeviation = reference > 0 ? Number((baseFee / reference).toFixed(2)) : 1;

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
      feeDeviation,
      feeFlagged: feeDeviation > FEE_FLAG_MULTIPLIER,
    };
  }
}
