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
  regionLabel,
  businessDateKey,
} from '@fapoms/shared';

import { TransportRateEntity, TransportRateScope } from './transport-rate.entity';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { SETTING_BY_KEY } from '../../infrastructure/settings/settings.registry';

/**
 * The transport rate card: what travelling actually costs, managed by the desk, consumed by
 * the quote engine.
 *
 * Resolution never guesses. A branch's place yields at most one applicable row per mode — the
 * most specific scope wins (STATE over REGION over NATIONAL) — and a place that matches no rows
 * yields no transport estimate at all, which tells `FeePolicyService` to fall back to the
 * legacy client per-km formula. Silence, not invention, is the failure mode: an offer grounded
 * in a rate that doesn't exist is worse than an offer that says it used the default.
 *
 * Recommendation weighs cost AGAINST TIME. The first version priced every mode against the same
 * kilometres and picked the cheapest, which meant a 14-hour bus beat a 3-hour train whenever it
 * was ₹200 cheaper — technically the lowest reimbursement, practically a lost working day and an
 * assayer who declines. `estimate()` now gives every mode a journey time, rules out modes that
 * make no sense for the distance (a flight for 80 km, an auto for 200), and recommends the best
 * balance of the two under weights the operator controls. Every mode is still returned, viable or
 * not, with its cost, its time and — when ruled out — the rule that did it, so the desk can see
 * the whole picture and override with reasons.
 */

/** The whole active rate card is one cache entry: it is small and read on every quote. */
const CACHE_KEY = 'ref:rates:transport';
const CACHE_TTL_SECONDS = 300;

const SCOPE_SPECIFICITY: Record<TransportRateScope, number> = {
  STATE: 3,
  REGION: 2,
  NATIONAL: 1,
};

/**
 * Modes whose journey time is the ROAD time: they drive (or are driven) the routed road.
 * Everything else — train, bus, flight, other — runs on its own network and timetable, for
 * which there is no free, reliable Indian data source, so those are estimated from distance
 * at a per-mode average speed. See `journeyTime()`.
 */
const ROAD_MODES: ReadonlySet<TravelMode> = new Set([
  TravelMode.CAR,
  TravelMode.TAXI,
  TravelMode.AUTO_RICKSHAW,
  TravelMode.TWO_WHEELER,
]);

export interface TransportPlace {
  state?: string | null;
  region?: string | null;
}

/**
 * Where an option's journey time came from — because a real figure and a guess must never
 * wear the same clothes.
 *
 *  - ROAD_ROUTE: the road duration handed in by the caller (the geo module's routing result).
 *    A REAL figure when the route came from OSRM; the routing layer's own straight-line-at-
 *    average-speed guess when its `source` was ESTIMATE — `TransportEstimate.road.source`
 *    says which, so a display can add "(estimated)". Either way it is the same number the day
 *    planner schedules by, which is why it is used as given rather than second-guessed here.
 *  - RATE_CARD_ESTIMATE: computed here as distance ÷ the mode's average-speed setting
 *    (`transport.avgSpeedKmh.<MODE>`, plus the fixed airport overhead for flights). Always an
 *    estimate. Used for train/bus/flight/other, and for road modes when no route was supplied.
 */
export type TransportTimeSource = 'ROAD_ROUTE' | 'RATE_CARD_ESTIMATE';

/**
 * A routed road leg, shaped to match the geo module's `RouteResult` so a routing result can be
 * passed straight through. `durationMinutes` follows the same convention as the estimate's
 * distance argument: one way by default, the whole loop when `distanceIsRoundTrip` is set.
 * `distanceKm` is accepted for structural compatibility but the positional distance argument is
 * what prices the journey — callers already pass it, and one of them (the assign path) passes
 * 0 on purpose when the assayer is already travelling that day, which must stay 0.
 */
export interface RoadLeg {
  distanceKm?: number;
  durationMinutes: number;
  /** OSRM = a real routed drive; ESTIMATE = the routing layer's haversine-at-40-km/h fallback. */
  source: 'OSRM' | 'ESTIMATE';
}

/**
 * The knobs behind a recommendation, read from platform settings on every estimate and echoed
 * on the result so a screen can say WHY ("flights only from 500 km", "cost 0.6 / time 0.4")
 * without a second call. All are operator-tunable at Administration → Platform Settings →
 * Transport recommendation; the shipped defaults live in the settings registry.
 */
export interface TransportPolicy {
  /** Weight on normalised cost in the score. Shipped 0.6. */
  weightCost: number;
  /** Weight on normalised journey time in the score. Shipped 0.4. */
  weightTime: number;
  /** FLIGHT is not viable under this many km one way. Shipped 500. */
  flightMinKm: number;
  /** TWO_WHEELER is not viable over this many km one way. Shipped 150. */
  twoWheelerMaxKm: number;
  /** AUTO_RICKSHAW is not viable over this many km one way. Shipped 40. */
  autoMaxKm: number;
  /** Fixed minutes added to each flight leg for airport transfers, check-in, security. Shipped 180. */
  flightOverheadMinutes: number;
  /** Door-to-door average speed per mode, used wherever no real road time exists. */
  avgSpeedKmh: Record<TravelMode, number>;
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

  /** Journey time one way, whole minutes. See `timeSource` for how honest it is. */
  oneWayMinutes: number;
  /** There and back — the figure the ranking uses, alongside `roundTripCost`. */
  roundTripMinutes: number;
  timeSource: TransportTimeSource;
  /** The km/h a RATE_CARD_ESTIMATE was derived from; null when the time is a routed figure. */
  assumedSpeedKmh: number | null;

  /**
   * False when a business rule rules this mode out for the distance. The option is still here
   * — with its cost and time — so the desk can see what was rejected and override deliberately.
   */
  viable: boolean;
  /** The rule that ruled it out, in one sentence with the numbers. Null when viable. */
  whyNot: string | null;

  /**
   * 1 = the recommendation. Viable modes come first in score order (a preferred row is moved
   * to the top when it wins), then non-viable ones cheapest-first. Also the order of `options`.
   */
  rank: number;
  /**
   * 0 (best) … 1 (worst) among the VIABLE options: weightCost × cost scaled 0–1 across them
   * + weightTime × time scaled 0–1 across them. Null when not viable. Two viable options with
   * identical cost and time both score 0.
   */
  score: number | null;
  /** One line saying why this is the recommendation. Set on the recommended option only. */
  reason: string | null;
}

export interface TransportEstimate {
  /** Always one way, whatever the caller supplied — every display ("~X km each way") assumes it. */
  distanceKm: number;
  /** In `rank` order: recommended first, viable by score, then the ruled-out modes. */
  options: TransportModeOption[];
  /**
   * The viable option with the lowest cost-time score — unless a rate row at the most specific
   * scope is marked preferred and viable, in which case that wins (policy beats arithmetic).
   * Null when no rate matches the place, when the distance is zero, or when every matched mode
   * is ruled out; the caller then falls back to legacy per-km travel.
   */
  recommended: TransportModeOption | null;
  /**
   * The road time this estimate was given, one way, or null when the caller had no route. When
   * present, road modes' times are this figure and `source` says whether it was a real OSRM
   * route or the routing layer's own estimate.
   */
  road: { oneWayMinutes: number; source: RoadLeg['source'] } | null;
  policy: TransportPolicy;
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

/** "~3h", "~2h 30m", "~45 min" — for the one-line reason; screens do their own formatting. */
const describeMinutes = (minutes: number): string => {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `~${m} min`;
  return m === 0 ? `~${h}h` : `~${h}h ${m}m`;
};

const rupees = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** Where a preference was declared, in words: "for Maharashtra", "in the South", "nationally". */
const scopePhrase = (scopeType: TransportRateScope, scopeValue: string | null): string => {
  if (scopeType === 'STATE') return `for ${scopeValue}`;
  if (scopeType === 'REGION') return `in the ${regionLabel(scopeValue)}`;
  return 'nationally';
};

@Injectable()
export class TransportRateService {
  constructor(
    @InjectRepository(TransportRateEntity)
    private readonly rateRepository: Repository<TransportRateEntity>,
    private readonly cache: CacheService,
    private readonly settings: PlatformSettingsService,
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
   * Per-mode journey costs AND times for a distance, which modes are sensible for it, and the
   * one the desk should recommend.
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
   * about the same journey. `road.durationMinutes`, when supplied, follows the same
   * convention: the loop's minutes with the flag, one way without.
   *
   * What happens, in order:
   *   1. Each matched rate row becomes an option with cost (as before) and TIME
   *      (`journeyTime()`): the routed road time for road modes when a route was given,
   *      otherwise distance ÷ the mode's average-speed setting, flights carrying a fixed
   *      airport overhead per leg. Every time figure says where it came from.
   *   2. Viability rules (`viability()`) mark modes that make no sense for the distance —
   *      each rule is named, has its threshold in platform settings, and writes a one-line
   *      `whyNot`. Ruled-out modes stay in the list; they just cannot be recommended.
   *   3. Among viable modes, cost and time are each scaled 0–1 and combined under the
   *      operator's weights (`rankOptions()`); the lowest score is recommended, unless a
   *      viable preferred row at the most specific scope exists, which wins outright — the
   *      pre-existing "reimburse at bus rate in the South" policy hook, kept intact.
   *
   * TRAIN and BUS appear only when the place has a rate row for them — that IS the "only if a
   * rate row exists for the scope" rule, satisfied by construction: no row, no option. This
   * service does not synthesise placeholder options for modes it has no price for; silence,
   * not invention, remains the failure mode.
   */
  async estimate(
    distanceKm: number,
    place: TransportPlace,
    onDate?: Date,
    opts: { distanceIsRoundTrip?: boolean; road?: RoadLeg | null } = {},
  ): Promise<TransportEstimate> {
    const policy = await this.policy();

    const km = Number.isFinite(distanceKm) && distanceKm > 0 ? distanceKm : 0;
    if (km <= 0) return { distanceKm: 0, options: [], recommended: null, road: null, policy };

    const oneWayKm = opts.distanceIsRoundTrip ? km / 2 : km;

    // A route with no usable duration is the same as no route: fall back to the estimate
    // rather than declare a 0-minute drive.
    const roadMinutes = Number(opts.road?.durationMinutes);
    const road =
      opts.road && Number.isFinite(roadMinutes) && roadMinutes > 0
        ? {
            oneWayMinutes: opts.distanceIsRoundTrip ? roadMinutes / 2 : roadMinutes,
            source: opts.road.source,
          }
        : null;

    const rates = await this.ratesFor(place, onDate);
    const options: TransportModeOption[] = rates.map((r) => {
      const baseFare = Number(r.baseFare);
      const perKm = Number(r.perKmRate);
      const oneWay = round(baseFare + perKm * oneWayKm);
      const fullJourney = opts.distanceIsRoundTrip
        ? round(2 * baseFare + perKm * km)
        : oneWay * 2;

      const time = this.journeyTime(r.mode, oneWayKm, road, policy);
      const whyNot = this.viability(r.mode, oneWayKm, policy);

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
        oneWayMinutes: round(time.oneWayMinutes),
        // Two legs. For a loop the road figure was already the loop's and was halved above,
        // so doubling here returns exactly what the router said; for estimated modes a loop of
        // 2 × oneWayKm at the same speed is the same arithmetic. Flights pay the airport
        // overhead on both legs, which is the truth of it.
        roundTripMinutes: round(time.oneWayMinutes * 2),
        timeSource: time.timeSource,
        assumedSpeedKmh: time.assumedSpeedKmh,
        viable: whyNot === null,
        whyNot,
        rank: 0,
        score: null,
        reason: null,
      };
    });

    const { ordered, recommended } = this.rankOptions(options, policy);

    return {
      // Always the one-way figure, whatever the caller supplied: every display of this value
      // ("~X km each way") assumes it.
      distanceKm: oneWayKm,
      options: ordered,
      recommended,
      road: road ? { oneWayMinutes: round(road.oneWayMinutes), source: road.source } : null,
      policy,
    };
  }

  // ---------------------------------------------------------------- recommendation

  /**
   * How long one leg takes by a mode, and how much to trust the answer.
   *
   * Road modes take the routed road time as given when there is one — that is the same figure
   * the day planner schedules by, and second-guessing it here would put two different drive
   * times for one journey on the same screen. Without a route (the Transport Costs estimator,
   * the single-branch assign path today) they get the same treatment as everything else:
   * distance ÷ a per-mode average speed from platform settings.
   *
   * Train and bus are ALWAYS estimated this way. There is no free, reliable API for Indian
   * rail or bus timetables (IRCTC's is closed; the third-party ones are scrapers with terms
   * that forbid exactly this use), and pretending otherwise — inventing station pairs, or
   * scraping — would produce confident wrong numbers. Road kilometres at 55 km/h for a train is
   * a stated, tunable estimate that the operator can correct per deployment, and every option
   * says so in `timeSource`. Rail routes are also not road routes: a train between two towns can
   * be shorter or far longer than the road, which is one more reason this is a ceiling on
   * honesty, not a timetable.
   *
   * Flight = a fixed overhead per leg (airport transfers, check-in, security, boarding,
   * baggage — 3 h shipped) + road km at the airborne average. Using ROAD km for the airborne
   * leg slightly overstates it (great-circle is shorter), which is the conservative side to
   * err on when the alternative is under-promising a train.
   */
  private journeyTime(
    mode: TravelMode,
    oneWayKm: number,
    road: { oneWayMinutes: number; source: RoadLeg['source'] } | null,
    policy: TransportPolicy,
  ): { oneWayMinutes: number; timeSource: TransportTimeSource; assumedSpeedKmh: number | null } {
    if (road && ROAD_MODES.has(mode)) {
      return { oneWayMinutes: road.oneWayMinutes, timeSource: 'ROAD_ROUTE', assumedSpeedKmh: null };
    }
    const speed = policy.avgSpeedKmh[mode];
    const cruiseMinutes = (oneWayKm / speed) * 60;
    const overhead = mode === TravelMode.FLIGHT ? policy.flightOverheadMinutes : 0;
    return {
      oneWayMinutes: overhead + cruiseMinutes,
      timeSource: 'RATE_CARD_ESTIMATE',
      assumedSpeedKmh: speed,
    };
  }

  /**
   * The business rules that rule a mode OUT for a distance. Returns the reason, or null when
   * the mode is fine. Each rule is one line, its threshold lives in platform settings, and its
   * message carries both numbers so the desk can see how far off it was.
   *
   *  - Flight minimum (`transport.flightMinKm`, 500): under this the airport overhead alone
   *    exceeds the train, and no domestic sector that short is sold as a day trip anyway.
   *  - Two-wheeler maximum (`transport.twoWheelerMaxKm`, 150): beyond this the ride is a
   *    working day in itself before the audit starts, and a safety question besides.
   *  - Auto-rickshaw maximum (`transport.autoMaxKm`, 40): autos are town transport; a 200 km
   *    auto is a number the old cheapest-wins rule would happily have recommended.
   *
   * Deliberately NOT rules: no upper bound on car/taxi/bus/train distance (a 1,500 km taxi is
   * silly but the time figure and the score make that plain without a hard stop), and no
   * "train/bus needs a row" check here — a mode with no rate row never becomes an option at
   * all, so that rule is enforced upstream by construction.
   */
  private viability(mode: TravelMode, oneWayKm: number, policy: TransportPolicy): string | null {
    const kmText = `${round(oneWayKm)} km`;
    if (mode === TravelMode.FLIGHT && oneWayKm < policy.flightMinKm) {
      return `Flights are only considered from ${policy.flightMinKm} km one way; this journey is ${kmText}`;
    }
    if (mode === TravelMode.TWO_WHEELER && oneWayKm > policy.twoWheelerMaxKm) {
      return `Two-wheeler journeys are capped at ${policy.twoWheelerMaxKm} km one way; this journey is ${kmText}`;
    }
    if (mode === TravelMode.AUTO_RICKSHAW && oneWayKm > policy.autoMaxKm) {
      return `Auto-rickshaw journeys are capped at ${policy.autoMaxKm} km one way; this journey is ${kmText}`;
    }
    return null;
  }

  /**
   * Score, order and choose. Mutates the options' rank/score/reason in place and returns them
   * in rank order with the recommendation.
   *
   * Scoring: among VIABLE options, cost and time are each scaled to 0–1 across the set as
   *   norm(x) = 1 − best / x
   * — 0 for the cheapest (or fastest), 0.5 for twice the best, approaching 1 as an option gets
   * arbitrarily worse — and
   *   score = wCost × costNorm + wTime × timeNorm
   * with the weights normalised to sum to 1 so the score itself is 0–1. Lowest wins. A single
   * viable option scores 0 by definition; two options identical on an axis both score 0 on it.
   *
   * Why this scaling. Cost is in rupees and time in minutes, and no exchange rate between them
   * is defensible in general (₹100 per hour? per whom?), so both must be made unitless before
   * they can be weighed. Two candidates were worked through with real numbers and rejected:
   *
   *  - Min–max, (x − min)/(max − min). Bounded, familiar — and blind to magnitude. With exactly
   *    two viable modes (a state that priced only BUS and TRAIN) one is 0 and the other 1 on
   *    every axis, so the score collapses to the weights alone: at 0.6/0.4 the cheaper mode wins
   *    whatever the gap. A 14-hour bus at ₹1,680 beats a 12.7-hour train at ₹1,880 because it is
   *    ₹200 cheaper — the exact bug this ranking exists to fix. It is also unstable under
   *    irrelevant alternatives: add a ₹25,000 taxi row and the bus's cost norm drops from 1 to
   *    0.03, flipping bus-vs-train though neither of them changed.
   *  - A rupees-per-hour value of time. The economically honest formulation, but it needs a
   *    number nobody will sign off, and the weights are that number in disguise anyway.
   *
   * 1 − best/x keeps the size of the gap: ₹200 on ₹1,880 is 0.106 (×0.6 = 0.064) while 4.8 hours
   * on 17.5 is 0.273 (×0.4 = 0.109), so the train wins; and each option's norm depends only on
   * itself and the best, so a taxi row appearing cannot reorder bus and train. In pairwise terms
   * the rule the weights express is: the cheaper mode wins iff 0.6 × (its saving as a fraction
   * of the dearer's cost) exceeds 0.4 × (the dearer's time saving as a fraction of the cheaper's
   * time). A train may cost up to ~1.8× a bus if it saves two-thirds of the time; ~2× if it
   * saves four-fifths. Also rejected: lexicographic cost-then-time (is exactly the old bug in a
   * hat).
   *
   * Preferred rows: the existing policy hook is kept. A row marked preferred at the most
   * specific matching scope is recommended if it is viable, however it scores — its reason
   * says "preferred for Maharashtra" so nobody mistakes policy for arithmetic. A preferred row
   * that fails a viability rule is skipped, and its `whyNot` explains.
   *
   * Non-viable options rank after every viable one, cheapest first, with a null score.
   */
  private rankOptions(
    options: TransportModeOption[],
    policy: TransportPolicy,
  ): { ordered: TransportModeOption[]; recommended: TransportModeOption | null } {
    const viable = options.filter((o) => o.viable);
    const ruledOut = options
      .filter((o) => !o.viable)
      .sort((a, b) => a.roundTripCost - b.roundTripCost || a.modeLabel.localeCompare(b.modeLabel));

    if (viable.length > 0) {
      const minC = Math.min(...viable.map((o) => o.roundTripCost));
      const minT = Math.min(...viable.map((o) => o.roundTripMinutes));
      // A best of 0 (a free mode; a 0-minute journey) makes the ratio meaningless — everyone
      // else is infinitely worse. Treat the axis as spent: only the best scores 0, the rest 1.
      const norm = (v: number, best: number) => (v <= best ? 0 : best > 0 ? 1 - best / v : 1);

      // Both weights zero would make every score 0 and the choice arbitrary; that is not a
      // policy anyone means, so it degrades to "cheapest", the pre-time behaviour.
      let wCost = Math.max(0, policy.weightCost);
      let wTime = Math.max(0, policy.weightTime);
      if (wCost + wTime <= 0) { wCost = 1; wTime = 0; }
      const wSum = wCost + wTime;
      wCost /= wSum; wTime /= wSum;

      for (const o of viable) {
        o.score = Number((wCost * norm(o.roundTripCost, minC) + wTime * norm(o.roundTripMinutes, minT)).toFixed(4));
      }
      viable.sort(
        (a, b) =>
          (a.score as number) - (b.score as number) ||
          a.roundTripCost - b.roundTripCost ||
          a.roundTripMinutes - b.roundTripMinutes ||
          a.modeLabel.localeCompare(b.modeLabel),
      );

      // Preference at a more specific scope beats preference at a broader one, so a national
      // "prefer bus" default can be overridden by one state that prefers own-vehicle rates.
      // Ties at the same scope go to the better score, since `viable` is already in that order
      // and the sort is stable.
      const preferred = viable
        .filter((o) => o.preferred)
        .sort((a, b) => SCOPE_SPECIFICITY[b.scopeType] - SCOPE_SPECIFICITY[a.scopeType])[0];
      if (preferred && preferred !== viable[0]) {
        viable.splice(viable.indexOf(preferred), 1);
        viable.unshift(preferred);
      }

      const recommended = viable[0];
      recommended.reason = this.reasonFor(recommended, viable, !!preferred);
      const ordered = [...viable, ...ruledOut];
      ordered.forEach((o, i) => { o.rank = i + 1; });
      return { ordered, recommended };
    }

    ruledOut.forEach((o, i) => { o.rank = i + 1; });
    return { ordered: ruledOut, recommended: null };
  }

  /** The one line under the recommendation. Policy first, then the arithmetic in plain words. */
  private reasonFor(rec: TransportModeOption, viable: TransportModeOption[], byPreference: boolean): string {
    if (byPreference) return `preferred ${scopePhrase(rec.scopeType, rec.scopeValue)}`;
    if (viable.length === 1) return 'only viable mode';
    const cheapest = rec.roundTripCost === Math.min(...viable.map((o) => o.roundTripCost));
    const fastest = rec.roundTripMinutes === Math.min(...viable.map((o) => o.roundTripMinutes));
    if (cheapest && fastest) return 'cheapest and fastest viable';
    if (cheapest) return 'cheapest viable';
    return `best cost-time balance: ${rupees(rec.roundTripCost)}, ${describeMinutes(rec.oneWayMinutes)} each way`;
  }

  /**
   * The recommendation policy as configured right now — one settings read per estimate. A
   * settings outage degrades to the shipped defaults rather than failing the quote: an offer
   * priced under default policy beats no offer, and the settings screen shows what is in force.
   */
  private async policy(): Promise<TransportPolicy> {
    const speedKey = (mode: TravelMode) => `transport.avgSpeedKmh.${mode}`;
    const keys = [
      'transport.weightCost',
      'transport.weightTime',
      'transport.flightMinKm',
      'transport.twoWheelerMaxKm',
      'transport.autoMaxKm',
      'transport.flightOverheadMinutes',
      ...Object.values(TravelMode).map(speedKey),
    ];
    const values: Record<string, unknown> = await this.settings.getMany(keys).catch(() => ({}));

    // A saved value that is somehow not a number or is negative falls back to the registry
    // default rather than poisoning the ranking; a speed of zero (which would make every
    // journey infinite) does the same.
    const num = (key: string): number => {
      const raw = Number(values[key]);
      const fallback = Number(SETTING_BY_KEY[key]?.default ?? 0);
      return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
    };
    const avgSpeedKmh = Object.fromEntries(
      Object.values(TravelMode).map((mode) => {
        const raw = Number(values[speedKey(mode)]);
        const fallback = Number(SETTING_BY_KEY[speedKey(mode)]?.default ?? 40);
        return [mode, Number.isFinite(raw) && raw > 0 ? raw : fallback];
      }),
    ) as Record<TravelMode, number>;

    return {
      weightCost: num('transport.weightCost'),
      weightTime: num('transport.weightTime'),
      flightMinKm: num('transport.flightMinKm'),
      twoWheelerMaxKm: num('transport.twoWheelerMaxKm'),
      autoMaxKm: num('transport.autoMaxKm'),
      flightOverheadMinutes: num('transport.flightOverheadMinutes'),
      avgSpeedKmh,
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
