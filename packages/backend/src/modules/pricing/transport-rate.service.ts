import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TravelMode,
  Region,
  isRegion,
  resolveRegion,
  canonicalStateName,
  travelModeLabel,
  businessDateKey,
} from '@fapoms/shared';

import { TransportRateEntity, TransportRateScope } from './transport-rate.entity';
import { CacheService } from '../../infrastructure/cache/cache.service';

/**
 * The transport rate card: what travelling actually costs, managed by the desk, consumed by
 * the quote engine.
 *
 * Resolution never guesses. A branch's place yields at most one applicable row per mode — the
 * most specific scope wins (STATE over REGION over NATIONAL) — and a place that matches no rows
 * yields no transport estimate at all, which tells `FeePolicyService` to fall back to the
 * legacy client per-km formula. Silence, not invention, is the failure mode: an offer grounded
 * in a rate that doesn't exist is worse than an offer that says it used the default.
 */

/** The whole active rate card is one cache entry: it is small and read on every quote. */
const CACHE_KEY = 'ref:rates:transport';
const CACHE_TTL_SECONDS = 300;

const SCOPE_SPECIFICITY: Record<TransportRateScope, number> = {
  STATE: 3,
  REGION: 2,
  NATIONAL: 1,
};

export interface TransportPlace {
  state?: string | null;
  region?: string | null;
}

export interface TransportModeOption {
  mode: TravelMode;
  modeLabel: string;
  scopeType: TransportRateScope;
  scopeValue: string | null;
  baseFare: number;
  perKmRate: number;
  /** baseFare + perKmRate × km, whole rupees. */
  oneWayCost: number;
  /** Two single journeys — the assayer comes home. This is the figure recommendations use. */
  roundTripCost: number;
  preferred: boolean;
}

export interface TransportEstimate {
  distanceKm: number;
  /** Sorted cheapest-first by round trip. */
  options: TransportModeOption[];
  /** The preferred mode at the most specific scope that declares one, else the cheapest. */
  recommended: TransportModeOption | null;
}

export interface CreateTransportRateDto {
  mode: string;
  scopeType: string;
  scopeValue?: string | null;
  baseFare?: number;
  perKmRate: number;
  isPreferred?: boolean;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string | null;
}

export type UpdateTransportRateDto = Partial<CreateTransportRateDto> & { isActive?: boolean };

const round = (n: number) => Math.round(n);

@Injectable()
export class TransportRateService {
  constructor(
    @InjectRepository(TransportRateEntity)
    private readonly rateRepository: Repository<TransportRateEntity>,
    private readonly cache: CacheService,
  ) {}

  // ---------------------------------------------------------------- CRUD

  async findAll(): Promise<TransportRateEntity[]> {
    // The dashboard lists everything including retired rows — the history is the point.
    return this.rateRepository.find({
      order: { scopeType: 'ASC', scopeValue: 'ASC', mode: 'ASC', effectiveFrom: 'DESC' },
    });
  }

  async create(dto: CreateTransportRateDto, userId?: string): Promise<TransportRateEntity> {
    const normalized = this.validate(dto);
    const entity = this.rateRepository.create({
      ...normalized,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.rateRepository.save(entity);
    await this.invalidate();
    return saved;
  }

  async update(id: string, dto: UpdateTransportRateDto, userId?: string): Promise<TransportRateEntity> {
    const existing = await this.rateRepository.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('Transport rate not found');

    const merged = this.validate({
      mode: dto.mode ?? existing.mode,
      scopeType: dto.scopeType ?? existing.scopeType,
      // `undefined` means "not supplied"; null is a real value (national scope).
      scopeValue: dto.scopeValue !== undefined ? dto.scopeValue : existing.scopeValue,
      baseFare: dto.baseFare ?? Number(existing.baseFare),
      perKmRate: dto.perKmRate ?? Number(existing.perKmRate),
      isPreferred: dto.isPreferred ?? existing.isPreferred,
      effectiveFrom: dto.effectiveFrom ?? existing.effectiveFrom,
      effectiveTo: dto.effectiveTo !== undefined ? dto.effectiveTo : existing.effectiveTo,
      notes: dto.notes !== undefined ? dto.notes : existing.notes,
    });

    Object.assign(existing, merged, {
      isActive: dto.isActive ?? existing.isActive,
      updatedBy: userId,
    });
    const saved = await this.rateRepository.save(existing);
    await this.invalidate();
    return saved;
  }

  /**
   * Hard delete is deliberately absent. A rate that has priced even one offer is part of that
   * offer's audit trail; retiring it (isActive=false, or an effectiveTo date) removes it from
   * every future quote while keeping the past explicable.
   */
  async deactivate(id: string, userId?: string): Promise<TransportRateEntity> {
    return this.update(id, { isActive: false }, userId);
  }

  // ---------------------------------------------------------------- resolution

  /**
   * The applicable rate per mode for a place on a date: most specific scope wins per mode.
   */
  async ratesFor(place: TransportPlace, onDate?: Date): Promise<TransportRateEntity[]> {
    const all = await this.activeRates();
    const at = onDate ?? new Date();
    // The business day, not the UTC one: a rate effective "from the 14th" must start pricing
    // at midnight in India, not at 05:30 IST when UTC finally catches up.
    const atKey = businessDateKey(at);

    const state = canonicalStateName(place.state);
    // When the state is recognised, the region is DERIVED from it rather than trusted from the
    // caller — the state is ground truth about where the branch is, and a contradictory region
    // (a stale branch column, or mismatched estimator inputs) must not pull in another
    // region's rates. The supplied region only matters when there is no usable state.
    const region: Region | null = state
      ? resolveRegion(state)
      : isRegion(place.region)
        ? place.region
        : resolveRegion(place.region) ?? resolveRegion(place.state);

    const applicable = all.filter((r) => {
      if (r.effectiveFrom > atKey) return false;
      if (r.effectiveTo && r.effectiveTo < atKey) return false;
      if (r.scopeType === 'NATIONAL') return true;
      if (r.scopeType === 'REGION') return region != null && r.scopeValue === region;
      return state != null && r.scopeValue === state;
    });

    const byMode = new Map<string, TransportRateEntity>();
    for (const rate of applicable) {
      const held = byMode.get(rate.mode);
      if (!held || this.moreSpecific(rate, held)) byMode.set(rate.mode, rate);
    }
    return [...byMode.values()];
  }

  /**
   * Per-mode journey costs for a distance, and the one the desk should recommend.
   *
   * Costs are round trip: the assayer comes home, and a reimbursement that covers half the
   * journey is not a recommendation anyone can stand behind. Returns empty options rather
   * than throwing when nothing matches — absence of a rate card is a normal state, handled
   * by the caller's fallback.
   *
   * `distanceIsRoundTrip` says the supplied kilometres already cover the WHOLE journey —
   * the day planner's TSP route is a closed loop (home → branches → home). Feeding a loop
   * into the default one-way arithmetic doubled it: an 80 km loop was priced as an 80 km
   * one-way plus its return, ~2× the real cost. For a loop, the full-journey cost is
   * 2 × baseFare + perKm × loopKm — identical to the round-trip formula when the loop is
   * exactly there-and-back, which is what keeps the two entry points from ever disagreeing
   * about the same journey.
   */
  async estimate(
    distanceKm: number,
    place: TransportPlace,
    onDate?: Date,
    opts: { distanceIsRoundTrip?: boolean } = {},
  ): Promise<TransportEstimate> {
    const km = Number.isFinite(distanceKm) && distanceKm > 0 ? distanceKm : 0;
    if (km <= 0) return { distanceKm: 0, options: [], recommended: null };

    const oneWayKm = opts.distanceIsRoundTrip ? km / 2 : km;

    const rates = await this.ratesFor(place, onDate);
    const options: TransportModeOption[] = rates
      .map((r) => {
        const baseFare = Number(r.baseFare);
        const perKm = Number(r.perKmRate);
        const oneWay = round(baseFare + perKm * oneWayKm);
        const fullJourney = opts.distanceIsRoundTrip
          ? round(2 * baseFare + perKm * km)
          : oneWay * 2;
        return {
          mode: r.mode,
          modeLabel: travelModeLabel(r.mode),
          scopeType: r.scopeType,
          scopeValue: r.scopeValue,
          baseFare,
          perKmRate: perKm,
          oneWayCost: oneWay,
          roundTripCost: fullJourney,
          preferred: r.isPreferred,
        };
      })
      .sort((a, b) => a.roundTripCost - b.roundTripCost);

    // Preference at a more specific scope beats preference at a broader one, so a national
    // "prefer bus" default can be overridden by one state that prefers own-vehicle rates.
    const preferred = options
      .filter((o) => o.preferred)
      .sort((a, b) => SCOPE_SPECIFICITY[b.scopeType] - SCOPE_SPECIFICITY[a.scopeType])[0];

    return {
      // Always the one-way figure, whatever the caller supplied: every display of this value
      // ("~X km each way") assumes it.
      distanceKm: oneWayKm,
      options,
      recommended: preferred ?? options[0] ?? null,
    };
  }

  // ---------------------------------------------------------------- internals

  private async activeRates(): Promise<TransportRateEntity[]> {
    return this.cache.wrap(CACHE_KEY, CACHE_TTL_SECONDS, async () =>
      this.rateRepository.find({ where: { isActive: true } }),
    );
  }

  private async invalidate(): Promise<void> {
    await this.cache.del(CACHE_KEY).catch(() => undefined);
  }

  private moreSpecific(a: TransportRateEntity, b: TransportRateEntity): boolean {
    const bySpecificity = SCOPE_SPECIFICITY[a.scopeType] - SCOPE_SPECIFICITY[b.scopeType];
    if (bySpecificity !== 0) return bySpecificity > 0;
    // Same scope: the later-starting rate is the current word on the matter.
    return a.effectiveFrom > b.effectiveFrom;
  }

  /**
   * Validation canonicalises rather than merely accepts: scopeValue is stored exactly as the
   * lookup will compare it, so "TAMILNADU" typed into the dashboard becomes "Tamil Nadu" in
   * the row, not a string that never matches any branch.
   */
  private validate(dto: CreateTransportRateDto): Partial<TransportRateEntity> {
    if (!Object.values(TravelMode).includes(dto.mode as TravelMode)) {
      throw new BadRequestException(`Unknown travel mode "${dto.mode}"`);
    }

    const scopeType = dto.scopeType as TransportRateScope;
    let scopeValue: string | null = null;
    if (scopeType === 'NATIONAL') {
      if (dto.scopeValue) {
        throw new BadRequestException('A national rate must not carry a scope value');
      }
    } else if (scopeType === 'REGION') {
      const region = isRegion(dto.scopeValue) ? dto.scopeValue : resolveRegion(dto.scopeValue);
      if (!region) {
        throw new BadRequestException(`"${dto.scopeValue}" is not a recognised region`);
      }
      scopeValue = region;
    } else if (scopeType === 'STATE') {
      const state = canonicalStateName(dto.scopeValue);
      if (!state) {
        throw new BadRequestException(`"${dto.scopeValue}" is not a recognised state`);
      }
      scopeValue = state;
    } else {
      throw new BadRequestException(`Unknown scope type "${dto.scopeType}"`);
    }

    // Bounds sit inside what the numeric(10,x) columns can hold, so an absurd figure is a
    // clear 400 with a reason instead of a numeric-overflow 500 from Postgres. The ceilings
    // are far above any real fare (a helicopter is ~₹1.5L/hour) — they reject typos, not
    // expensive modes.
    const perKm = Number(dto.perKmRate);
    if (!Number.isFinite(perKm) || perKm < 0 || perKm > 100_000) {
      throw new BadRequestException('Per-km rate must be between ₹0 and ₹100,000');
    }
    const baseFare = Number(dto.baseFare ?? 0);
    if (!Number.isFinite(baseFare) || baseFare < 0 || baseFare > 10_000_000) {
      throw new BadRequestException('Base fare must be between ₹0 and ₹1,00,00,000');
    }
    if (perKm === 0 && baseFare === 0) {
      throw new BadRequestException('A rate of ₹0 would recommend free travel — set a per-km rate or base fare');
    }

    // The regex admits "2026-13-45"; the round-trip through Date is what rejects it.
    const validDate = (s: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
      const d = new Date(`${s}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    };

    if (!dto.effectiveFrom || !validDate(dto.effectiveFrom)) {
      throw new BadRequestException('effectiveFrom must be a real YYYY-MM-DD date');
    }
    if (dto.effectiveTo != null && dto.effectiveTo !== '') {
      if (!validDate(dto.effectiveTo)) {
        throw new BadRequestException('effectiveTo must be a real YYYY-MM-DD date');
      }
      if (dto.effectiveTo < dto.effectiveFrom) {
        throw new BadRequestException('effectiveTo cannot precede effectiveFrom');
      }
    }

    return {
      mode: dto.mode as TravelMode,
      scopeType,
      scopeValue,
      baseFare,
      perKmRate: perKm,
      isPreferred: !!dto.isPreferred,
      effectiveFrom: dto.effectiveFrom,
      effectiveTo: dto.effectiveTo || null,
      notes: dto.notes?.trim() || null,
    };
  }
}
