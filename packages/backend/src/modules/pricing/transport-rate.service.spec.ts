import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TravelMode, STATE_REGION_PAIRS, canonicalStateName } from '@fapoms/shared';

import { TransportRateService } from './transport-rate.service';
import { TransportRateEntity } from './transport-rate.entity';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { SETTING_BY_KEY } from '../../infrastructure/settings/settings.registry';

/**
 * The rules that make a transport rate defensible: the most specific scope wins, retired and
 * future rates never price anything, spellings from real imports still match, and when nothing
 * matches the answer is silence — not a guess — so the quote engine falls back to the legacy
 * formula it has always had.
 *
 * And the rules that make a RECOMMENDATION defensible: every mode gets a time as well as a
 * cost, modes that make no sense for the distance are ruled out by name, and the winner is the
 * best balance of cost and time — not merely the cheapest — unless the desk has said otherwise
 * with a preferred row.
 */
describe('TransportRateService', () => {
  let service: TransportRateService;
  let repo: any;
  /**
   * Saved platform settings for the test. Empty means every knob is at its shipped default
   * (0.6/0.4 weights, flights from 500 km, two-wheeler to 150, auto to 40, train 55 km/h,
   * bus 40, flight 500 + 180 min). Tests that turn a knob set it here.
   */
  let savedSettings: Record<string, unknown>;
  let settings: { getMany: jest.Mock };

  const rate = (over: Partial<TransportRateEntity>): TransportRateEntity =>
    ({
      id: over.id ?? 'r-' + Math.random().toString(36).slice(2, 8),
      mode: TravelMode.BUS,
      scopeType: 'NATIONAL',
      scopeValue: null,
      baseFare: 0,
      perKmRate: 2,
      isPreferred: false,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      isActive: true,
      ...over,
    } as TransportRateEntity);

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((v: any) => v),
      save: jest.fn(async (v: any) => v),
    };
    savedSettings = {};
    settings = {
      // Mirrors the real service's resolution for the keys the estimator asks about: a saved
      // value when the test set one, else the registry default.
      getMany: jest.fn(async (keys: string[]) =>
        Object.fromEntries(keys.map((k) => [k, savedSettings[k] ?? SETTING_BY_KEY[k]?.default])),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransportRateService,
        { provide: getRepositoryToken(TransportRateEntity), useValue: repo },
        {
          provide: CacheService,
          useValue: {
            wrap: jest.fn((_k: string, _t: number, load: () => any) => load()),
            del: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: PlatformSettingsService, useValue: settings },
      ],
    }).compile();

    service = module.get(TransportRateService);
  });

  describe('scope resolution', () => {
    it('prefers a state rate over region and national for the same mode', async () => {
      repo.find.mockResolvedValue([
        rate({ scopeType: 'NATIONAL', perKmRate: 2 }),
        rate({ scopeType: 'REGION', scopeValue: 'SOUTH', perKmRate: 3 }),
        rate({ scopeType: 'STATE', scopeValue: 'Kerala', perKmRate: 4 }),
      ]);
      const rates = await service.ratesFor({ state: 'Kerala' });
      expect(rates).toHaveLength(1);
      expect(rates[0].scopeType).toBe('STATE');
      expect(Number(rates[0].perKmRate)).toBe(4);
    });

    it('falls through to the region rate when the state has none', async () => {
      repo.find.mockResolvedValue([
        rate({ scopeType: 'NATIONAL', perKmRate: 2 }),
        rate({ scopeType: 'REGION', scopeValue: 'SOUTH', perKmRate: 3 }),
      ]);
      const rates = await service.ratesFor({ state: 'Kerala' });
      expect(rates[0].scopeType).toBe('REGION');
    });

    it('derives the region from the state when the caller has no region', async () => {
      // The branch row may predate region normalization; the state alone must be enough.
      repo.find.mockResolvedValue([rate({ scopeType: 'REGION', scopeValue: 'SOUTH' })]);
      const rates = await service.ratesFor({ state: 'Tamil Nadu' });
      expect(rates).toHaveLength(1);
    });

    it('matches the spellings real branch imports actually carry', async () => {
      // "ANDRAPRADESH" (dropped h, no space) is in the production data. A rate card that
      // only matches clean spellings silently prices half the country at the fallback.
      repo.find.mockResolvedValue([rate({ scopeType: 'STATE', scopeValue: 'Andhra Pradesh' })]);
      const rates = await service.ratesFor({ state: 'ANDRAPRADESH' });
      expect(rates).toHaveLength(1);
    });

    it('keeps national rates for modes the state does not override', async () => {
      repo.find.mockResolvedValue([
        rate({ mode: TravelMode.BUS, scopeType: 'STATE', scopeValue: 'Kerala', perKmRate: 4 }),
        rate({ mode: TravelMode.TWO_WHEELER, scopeType: 'NATIONAL', perKmRate: 4 }),
      ]);
      const rates = await service.ratesFor({ state: 'Kerala' });
      expect(rates).toHaveLength(2);
    });

    it('ignores rates outside their effective window', async () => {
      repo.find.mockResolvedValue([
        rate({ effectiveFrom: '2099-01-01' }),
        rate({ effectiveFrom: '2020-01-01', effectiveTo: '2020-12-31' }),
      ]);
      const rates = await service.ratesFor({ state: 'Kerala' }, new Date('2026-06-01'));
      expect(rates).toHaveLength(0);
    });

    it('picks the later-starting rate when two of the same scope overlap', async () => {
      repo.find.mockResolvedValue([
        rate({ scopeType: 'NATIONAL', effectiveFrom: '2025-01-01', perKmRate: 1.5 }),
        rate({ scopeType: 'NATIONAL', effectiveFrom: '2026-04-01', perKmRate: 1.8 }),
      ]);
      const rates = await service.ratesFor({}, new Date('2026-06-01'));
      expect(Number(rates[0].perKmRate)).toBe(1.8);
    });
  });

  describe('estimate', () => {
    it('prices a round trip — the assayer comes home', async () => {
      repo.find.mockResolvedValue([rate({ baseFare: 10, perKmRate: 1.5 })]);
      const est = await service.estimate(100, {});
      // One way: 10 + 150 = 160. Round trip: two tickets.
      expect(est.options[0].oneWayCost).toBe(160);
      expect(est.options[0].roundTripCost).toBe(320);
    });

    it('recommends the preferred mode even when a cheaper one exists', async () => {
      repo.find.mockResolvedValue([
        rate({ mode: TravelMode.BUS, perKmRate: 1.5, isPreferred: false }),
        rate({ mode: TravelMode.TRAIN, baseFare: 20, perKmRate: 1, isPreferred: true }),
      ]);
      const est = await service.estimate(50, {});
      expect(est.recommended?.mode).toBe(TravelMode.TRAIN);
    });

    it('recommends the cheapest when nothing is preferred', async () => {
      repo.find.mockResolvedValue([
        rate({ mode: TravelMode.TAXI, baseFare: 50, perKmRate: 18 }),
        rate({ mode: TravelMode.BUS, baseFare: 10, perKmRate: 1.5 }),
      ]);
      const est = await service.estimate(50, {});
      expect(est.recommended?.mode).toBe(TravelMode.BUS);
    });

    it('lets a specific scope override a broader preference', async () => {
      // National policy prefers bus; Kerala's desk prefers own two-wheeler rates. The state
      // preference must win in Kerala without disturbing anywhere else.
      repo.find.mockResolvedValue([
        rate({ mode: TravelMode.BUS, scopeType: 'NATIONAL', isPreferred: true, perKmRate: 1.5 }),
        rate({ mode: TravelMode.TWO_WHEELER, scopeType: 'STATE', scopeValue: 'Kerala', isPreferred: true, perKmRate: 4 }),
      ]);
      const est = await service.estimate(50, { state: 'Kerala' });
      expect(est.recommended?.mode).toBe(TravelMode.TWO_WHEELER);
    });

    it('charges a closed-loop journey once, not twice', async () => {
      // The day planner's optimized route already ends at home — an 80 km loop fed into the
      // default arithmetic was priced as an 80 km one-way PLUS its return, ~double the truth.
      repo.find.mockResolvedValue([rate({ baseFare: 10, perKmRate: 1.5 })]);
      const est = await service.estimate(80, {}, undefined, { distanceIsRoundTrip: true });
      // 2 boarding fares + the loop's kilometres, once.
      expect(est.options[0].roundTripCost).toBe(2 * 10 + 1.5 * 80);
      // And the reported distance stays one-way, since every display assumes it.
      expect(est.distanceKm).toBe(40);
    });

    it('prices there-and-back identically through both entry points', async () => {
      // A journey that is exactly out-and-home must cost the same whether described as
      // "40 km one way" or "an 80 km loop" — otherwise the two callers drift apart again.
      repo.find.mockResolvedValue([rate({ baseFare: 10, perKmRate: 1.5 })]);
      const oneWay = await service.estimate(40, {});
      const loop = await service.estimate(80, {}, undefined, { distanceIsRoundTrip: true });
      expect(loop.options[0].roundTripCost).toBe(oneWay.options[0].roundTripCost);
    });

    it('ignores a contradictory region when the state resolves', async () => {
      // The estimator UI (and stale branch rows) can supply both; the state is ground truth.
      repo.find.mockResolvedValue([
        rate({ scopeType: 'REGION', scopeValue: 'NORTH', perKmRate: 9 }),
        rate({ scopeType: 'REGION', scopeValue: 'SOUTH', perKmRate: 2 }),
      ]);
      const est = await service.estimate(50, { state: 'Kerala', region: 'NORTH' });
      expect(est.options).toHaveLength(1);
      expect(est.options[0].perKmRate).toBe(2);
    });

    it('returns silence, not an invention, when no rate matches', async () => {
      repo.find.mockResolvedValue([]);
      const est = await service.estimate(100, { state: 'Kerala' });
      expect(est.options).toHaveLength(0);
      expect(est.recommended).toBeNull();
    });

    it('returns nothing for a zero distance — there is no journey to price', async () => {
      repo.find.mockResolvedValue([rate({})]);
      const est = await service.estimate(0, {});
      expect(est.recommended).toBeNull();
    });
  });

  /**
   * The scenario table. Each row is a journey the desk actually faces, priced against a rate
   * card modelled on the dev database's (national own-vehicle/hired rows; Maharashtra-style
   * intercity bus and train with real base fares; a domestic flight). Every expected figure
   * below was worked by hand from the formulas in the service — the comments show the working
   * so a future change to a default is a conscious re-derivation, not a snapshot update.
   *
   * Shipped policy throughout unless a test turns a knob: weights 0.6 cost / 0.4 time; flights
   * from 500 km; two-wheeler to 150 km; auto to 40 km; speeds car/taxi 45, two-wheeler 40,
   * auto 25, bus 40, train 55, flight 500 km/h + 180 min overhead per leg.
   */
  describe('recommendation — cost AND time', () => {
    const card = () => [
      rate({ mode: TravelMode.TWO_WHEELER, baseFare: 0, perKmRate: 4 }),
      rate({ mode: TravelMode.CAR, baseFare: 0, perKmRate: 10 }),
      rate({ mode: TravelMode.TAXI, baseFare: 50, perKmRate: 18 }),
      rate({ mode: TravelMode.AUTO_RICKSHAW, baseFare: 25, perKmRate: 12 }),
      rate({ mode: TravelMode.BUS, baseFare: 80, perKmRate: 6 }),
      rate({ mode: TravelMode.TRAIN, baseFare: 40, perKmRate: 2 }),
      rate({ mode: TravelMode.FLIGHT, baseFare: 2500, perKmRate: 3 }),
    ];
    const byMode = (est: any, mode: TravelMode) => est.options.find((o: any) => o.mode === mode);

    it('short city hop (8 km): the two-wheeler wins; the auto is viable; a flight is ruled out', async () => {
      // Round trips: 2W ₹64/24 min · car ₹160/21 · taxi ₹388/21 · auto ₹242/38 · bus ₹256/24 ·
      // train ₹112/17 · flight ₹5,048 (not viable). Cheapest is the two-wheeler (cost norm 0),
      // fastest the train (time norm 0). 2W: 0.4 × (1 − 17/24) = 0.117. Train: 0.6 × (1 − 64/112)
      // = 0.257. Nothing else comes close (car 0.436, bus 0.567, auto 0.662).
      repo.find.mockResolvedValue(card());
      const est = await service.estimate(8, {});

      expect(est.recommended?.mode).toBe(TravelMode.TWO_WHEELER);
      expect(est.recommended?.rank).toBe(1);
      expect(est.recommended?.reason).toBe('cheapest viable');
      expect(est.recommended?.roundTripCost).toBe(64);
      expect(est.recommended?.roundTripMinutes).toBe(24);

      const auto = byMode(est, TravelMode.AUTO_RICKSHAW);
      expect(auto.viable).toBe(true);
      expect(auto.whyNot).toBeNull();

      const flight = byMode(est, TravelMode.FLIGHT);
      expect(flight.viable).toBe(false);
      expect(flight.whyNot).toBe('Flights are only considered from 500 km one way; this journey is 8 km');
      expect(flight.score).toBeNull();
      // Ruled-out modes come last, but they ARE returned — with their cost and time.
      expect(flight.rank).toBe(7);
      expect(flight.roundTripCost).toBe(5048);
      expect(est.options.map((o) => o.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('200 km with a real road route: the train wins on both counts; car time is the routed figure', async () => {
      // OSRM says 240 min one way. Round trips: car ₹4,000/480 (ROAD_ROUTE) · taxi ₹7,300/480 ·
      // bus ₹2,560/600 · train ₹880/436 · 2W ₹1,600 (ruled out >150) · auto ₹4,850 (ruled out)
      // · flight (ruled out <500). Train is cheapest AND fastest.
      repo.find.mockResolvedValue(card());
      const est = await service.estimate(200, {}, undefined, {
        road: { distanceKm: 200, durationMinutes: 240, source: 'OSRM' },
      });

      expect(est.recommended?.mode).toBe(TravelMode.TRAIN);
      expect(est.recommended?.reason).toBe('cheapest and fastest viable');
      expect(est.recommended?.score).toBe(0);

      const car = byMode(est, TravelMode.CAR);
      expect(car).toMatchObject({
        viable: true,
        oneWayMinutes: 240,
        roundTripMinutes: 480,
        timeSource: 'ROAD_ROUTE',
        assumedSpeedKmh: null,
      });
      const train = byMode(est, TravelMode.TRAIN);
      // 200 km ÷ 55 km/h = 218 min — an estimate, and it says so.
      expect(train).toMatchObject({ oneWayMinutes: 218, timeSource: 'RATE_CARD_ESTIMATE', assumedSpeedKmh: 55 });
      expect(est.road).toEqual({ oneWayMinutes: 240, source: 'OSRM' });

      expect(byMode(est, TravelMode.TWO_WHEELER)).toMatchObject({
        viable: false,
        whyNot: 'Two-wheeler journeys are capped at 150 km one way; this journey is 200 km',
      });
      expect(byMode(est, TravelMode.AUTO_RICKSHAW)).toMatchObject({
        viable: false,
        whyNot: 'Auto-rickshaw journeys are capped at 40 km one way; this journey is 200 km',
      });
      // Viable modes all rank ahead of ruled-out ones.
      const viableRanks = est.options.filter((o) => o.viable).map((o) => o.rank);
      const ruledOutRanks = est.options.filter((o) => !o.viable).map((o) => o.rank);
      expect(Math.max(...viableRanks)).toBeLessThan(Math.min(...ruledOutRanks));
    });

    it('200 km, time is all that matters: the car wins on the routed figure, beating the taxi on cost at a tie', async () => {
      // weightTime 1 / weightCost 0, and an expressway: OSRM says 150 min one way, so car and
      // taxi (both ROAD_ROUTE, 300 min round trip) beat the train's estimated 436. Car and taxi
      // tie on time; the tie is broken by cost, so the car ranks first and the taxi second.
      savedSettings['transport.weightCost'] = 0;
      savedSettings['transport.weightTime'] = 1;
      repo.find.mockResolvedValue(card());
      const est = await service.estimate(200, {}, undefined, {
        road: { distanceKm: 200, durationMinutes: 150, source: 'OSRM' },
      });
      expect(est.recommended?.mode).toBe(TravelMode.CAR);
      expect(byMode(est, TravelMode.TAXI).rank).toBe(2);
    });

    it('800 km: the flight is viable and second, but the ₹3,280 train beats the ₹9,800 flight under shipped weights', async () => {
      // Train ₹3,280 / 1,745 min (873 each way at 55 km/h). Flight ₹9,800 / 552 min (180 overhead
      // + 96 airborne, each way). Train: 0.4 × (1 − 552/1745) = 0.273. Flight: 0.6 × (1 −
      // 3280/9800) = 0.399. Bus ₹9,760/2,400 = 0.706, car ₹16,000/2,133 = 0.774.
      repo.find.mockResolvedValue(card());
      const est = await service.estimate(800, {});

      expect(est.recommended?.mode).toBe(TravelMode.TRAIN);
      expect(est.recommended?.reason).toBe('cheapest viable');
      const flight = byMode(est, TravelMode.FLIGHT);
      expect(flight).toMatchObject({
        viable: true,
        rank: 2,
        oneWayMinutes: 276,
        roundTripMinutes: 552,
        roundTripCost: 9800,
        timeSource: 'RATE_CARD_ESTIMATE',
        assumedSpeedKmh: 500,
      });
    });

    it('800 km when time weighs more (0.6): the flight wins', async () => {
      // Train: 0.6 × 0.684 = 0.410. Flight: 0.4 × 0.665 = 0.266. The knob is the policy.
      savedSettings['transport.weightCost'] = 0.4;
      savedSettings['transport.weightTime'] = 0.6;
      repo.find.mockResolvedValue(card());
      const est = await service.estimate(800, {});
      expect(est.recommended?.mode).toBe(TravelMode.FLIGHT);
      expect(est.recommended?.reason).toMatch(/^best cost-time balance: ₹9,800, ~4h 36m each way$/);
    });

    it('the headline bug: a ₹200-cheaper 17.5-hour bus no longer beats a 12.7-hour train', async () => {
      // Only bus and train priced (a state that reimburses public transport). 700 km. Bus ₹1,680
      // (0 + 1.2/km, ×2) / 2,100 min. Train ₹1,880 (100 + 1.2/km, ×2) / 1,527 min.
      // Train: 0.6 × (1 − 1680/1880) = 0.064. Bus: 0.4 × (1 − 1527/2100) = 0.109. Train wins.
      // Under the old cheapest-wins rule — and under min–max scaling with two options — the bus
      // would have won on ₹200.
      repo.find.mockResolvedValue([
        rate({ mode: TravelMode.BUS, baseFare: 0, perKmRate: 1.2 }),
        rate({ mode: TravelMode.TRAIN, baseFare: 100, perKmRate: 1.2 }),
      ]);
      const est = await service.estimate(700, {});
      expect(est.recommended?.mode).toBe(TravelMode.TRAIN);
      expect(est.recommended?.reason).toBe('best cost-time balance: ₹1,880, ~12h 44m each way');
      expect(byMode(est, TravelMode.BUS)).toMatchObject({ rank: 2, roundTripCost: 1680, roundTripMinutes: 2100 });
    });

    it('…and with time weighted zero it is the old cheapest-wins rule again, by choice', async () => {
      savedSettings['transport.weightCost'] = 1;
      savedSettings['transport.weightTime'] = 0;
      repo.find.mockResolvedValue([
        rate({ mode: TravelMode.BUS, baseFare: 0, perKmRate: 1.2 }),
        rate({ mode: TravelMode.TRAIN, baseFare: 100, perKmRate: 1.2 }),
      ]);
      const est = await service.estimate(700, {});
      expect(est.recommended?.mode).toBe(TravelMode.BUS);
      expect(est.recommended?.reason).toBe('cheapest viable');
    });

    it('a preferred row at the most specific scope wins over the arithmetic, and says so', async () => {
      // Maharashtra prefers bus. At 150 km the train is cheaper (₹680 vs ₹1,960) AND faster
      // (327 vs 450 min) — the bus scores worse on both — but policy is policy. The bus is
      // rank 1 with the reason spelt out; the train is rank 2 with the better score, visible.
      repo.find.mockResolvedValue([
        rate({ mode: TravelMode.BUS, scopeType: 'STATE', scopeValue: 'Maharashtra', baseFare: 80, perKmRate: 6, isPreferred: true }),
        rate({ mode: TravelMode.TRAIN, scopeType: 'STATE', scopeValue: 'Maharashtra', baseFare: 40, perKmRate: 2 }),
        rate({ mode: TravelMode.CAR, scopeType: 'NATIONAL', baseFare: 0, perKmRate: 10 }),
      ]);
      const est = await service.estimate(150, { state: 'Maharashtra' });

      expect(est.recommended?.mode).toBe(TravelMode.BUS);
      expect(est.recommended?.reason).toBe('preferred for Maharashtra');
      expect(est.recommended?.rank).toBe(1);
      const train = byMode(est, TravelMode.TRAIN);
      expect(train.rank).toBe(2);
      expect(train.score).toBe(0);
      expect(est.recommended!.score).toBeGreaterThan(0);
    });

    it('a preferred row that fails a viability rule is skipped, and its whyNot explains', async () => {
      // Kerala prefers own two-wheeler rates — sensible for the usual 30 km hop, not for a
      // 200 km run. The preference does not force a ruled-out mode; the arithmetic decides.
      repo.find.mockResolvedValue([
        rate({ mode: TravelMode.TWO_WHEELER, scopeType: 'STATE', scopeValue: 'Kerala', perKmRate: 4, isPreferred: true }),
        rate({ mode: TravelMode.BUS, scopeType: 'NATIONAL', baseFare: 10, perKmRate: 1.5 }),
      ]);
      const est = await service.estimate(200, { state: 'Kerala' });
      expect(est.recommended?.mode).toBe(TravelMode.BUS);
      expect(est.recommended?.reason).toBe('only viable mode');
      expect(byMode(est, TravelMode.TWO_WHEELER)).toMatchObject({
        viable: false,
        preferred: true,
        whyNot: expect.stringMatching(/capped at 150 km/),
      });
    });

    it('names the region when a regional preference wins', async () => {
      repo.find.mockResolvedValue([
        rate({ mode: TravelMode.BUS, scopeType: 'REGION', scopeValue: 'SOUTH', baseFare: 10, perKmRate: 1.5, isPreferred: true }),
        rate({ mode: TravelMode.TRAIN, scopeType: 'NATIONAL', baseFare: 20, perKmRate: 1 }),
      ]);
      const est = await service.estimate(100, { state: 'Kerala' });
      expect(est.recommended?.reason).toBe('preferred in the South');
    });

    it('rate rows matched but every mode ruled out: nothing recommended, the options still explain', async () => {
      // An auto-only card and a 60 km run. The caller (FeePolicyService) will price this the
      // legacy way; what it must NOT do is recommend a 60 km auto because it was the only row.
      repo.find.mockResolvedValue([rate({ mode: TravelMode.AUTO_RICKSHAW, baseFare: 25, perKmRate: 12 })]);
      const est = await service.estimate(60, {});
      expect(est.recommended).toBeNull();
      expect(est.options).toHaveLength(1);
      expect(est.options[0]).toMatchObject({
        viable: false,
        rank: 1,
        score: null,
        whyNot: 'Auto-rickshaw journeys are capped at 40 km one way; this journey is 60 km',
      });
    });

    it('no rate rows at all: silence — the caller falls back to legacy per-km pricing', async () => {
      // This is the dev database's state today: ten rows, all retired. Every quote there is
      // priced by the legacy formula, and this is the path that makes that safe.
      repo.find.mockResolvedValue([]);
      const est = await service.estimate(300, { state: 'Maharashtra' });
      expect(est.options).toEqual([]);
      expect(est.recommended).toBeNull();
      expect(est.road).toBeNull();
      // The policy still comes back so a screen can show what WOULD apply.
      expect(est.policy.flightMinKm).toBe(500);
    });

    it('a closed loop with a routed duration: half each way, the loop in total', async () => {
      // The day planner's 80 km loop took 120 min by road. Car time is 60 each way / 120 total,
      // exactly what the router said; distance stays one-way for display.
      repo.find.mockResolvedValue([rate({ mode: TravelMode.CAR, perKmRate: 10 })]);
      const est = await service.estimate(80, {}, undefined, {
        distanceIsRoundTrip: true,
        road: { distanceKm: 80, durationMinutes: 120, source: 'ESTIMATE' },
      });
      expect(est.distanceKm).toBe(40);
      expect(est.options[0]).toMatchObject({ oneWayMinutes: 60, roundTripMinutes: 120, timeSource: 'ROAD_ROUTE' });
      // The routing layer's own estimate is passed through as such, never dressed up as OSRM.
      expect(est.road).toEqual({ oneWayMinutes: 60, source: 'ESTIMATE' });
    });

    it('a route with no usable duration is treated as no route', async () => {
      repo.find.mockResolvedValue([rate({ mode: TravelMode.CAR, perKmRate: 10 })]);
      const est = await service.estimate(90, {}, undefined, {
        road: { distanceKm: 90, durationMinutes: 0, source: 'OSRM' },
      });
      // 90 km at the car's 45 km/h setting = 120 min, and honestly labelled.
      expect(est.options[0]).toMatchObject({ oneWayMinutes: 120, timeSource: 'RATE_CARD_ESTIMATE', assumedSpeedKmh: 45 });
      expect(est.road).toBeNull();
    });

    it('a settings outage falls back to the shipped policy rather than failing the quote', async () => {
      settings.getMany.mockRejectedValue(new Error('redis down'));
      repo.find.mockResolvedValue(card());
      const est = await service.estimate(8, {});
      expect(est.recommended?.mode).toBe(TravelMode.TWO_WHEELER);
      expect(est.policy).toMatchObject({ weightCost: 0.6, weightTime: 0.4, flightMinKm: 500, twoWheelerMaxKm: 150, autoMaxKm: 40 });
      expect(est.policy.avgSpeedKmh.TRAIN).toBe(55);
    });

    it('both weights zero degrade to cheapest-wins rather than an arbitrary pick', async () => {
      savedSettings['transport.weightCost'] = 0;
      savedSettings['transport.weightTime'] = 0;
      repo.find.mockResolvedValue([
        rate({ mode: TravelMode.BUS, baseFare: 0, perKmRate: 1.2 }),
        rate({ mode: TravelMode.TRAIN, baseFare: 100, perKmRate: 1.2 }),
      ]);
      const est = await service.estimate(700, {});
      expect(est.recommended?.mode).toBe(TravelMode.BUS);
    });

    it('every travel mode has an average-speed setting — the estimator builds the key from the enum', () => {
      // A mode without a registry entry would silently fall back to a hardcoded 40 km/h; this
      // keeps the enum and the settings screen in lockstep.
      for (const mode of Object.values(TravelMode)) {
        expect({ mode, def: SETTING_BY_KEY[`transport.avgSpeedKmh.${mode}`] }).toEqual({
          mode,
          def: expect.objectContaining({ type: 'number', group: 'transport' }),
        });
      }
    });
  });

  describe('validation', () => {
    it('canonicalises the state spelling on write so lookups can compare by equality', async () => {
      const saved = await service.create({
        mode: 'BUS',
        scopeType: 'STATE',
        scopeValue: 'TAMILNADU',
        perKmRate: 1.5,
        effectiveFrom: '2026-01-01',
      });
      expect(saved.scopeValue).toBe('Tamil Nadu');
    });

    it('rejects a state nobody can resolve', async () => {
      await expect(
        service.create({
          mode: 'BUS',
          scopeType: 'STATE',
          scopeValue: 'Atlantis',
          perKmRate: 1.5,
          effectiveFrom: '2026-01-01',
        }),
      ).rejects.toThrow(/not a recognised state/);
    });

    it('rejects a scope value on a national rate', async () => {
      await expect(
        service.create({
          mode: 'BUS',
          scopeType: 'NATIONAL',
          scopeValue: 'Kerala',
          perKmRate: 1.5,
          effectiveFrom: '2026-01-01',
        }),
      ).rejects.toThrow(/must not carry a scope value/);
    });

    it('rejects a calendar-impossible date that the format check alone would admit', async () => {
      await expect(
        service.create({
          mode: 'BUS', scopeType: 'NATIONAL', perKmRate: 1.5, effectiveFrom: '2026-13-45',
        }),
      ).rejects.toThrow(/real YYYY-MM-DD/);
    });

    it('rejects a per-km rate that would overflow the column', async () => {
      await expect(
        service.create({
          mode: 'BUS', scopeType: 'NATIONAL', perKmRate: 1_000_000, effectiveFrom: '2026-01-01',
        }),
      ).rejects.toThrow(/between/);
    });

    it('rejects an all-zero rate that would recommend free travel', async () => {
      await expect(
        service.create({
          mode: 'BUS',
          scopeType: 'NATIONAL',
          perKmRate: 0,
          baseFare: 0,
          effectiveFrom: '2026-01-01',
        }),
      ).rejects.toThrow(/free travel/);
    });
  });

  describe('shared state map lockstep', () => {
    it('canonicalises every spelling the region map recognises', () => {
      // The promise made in regions.ts: STATE_TO_REGION (recognition) and
      // STATE_CANONICAL_NAMES (naming) cover exactly the same spellings. A state that can be
      // assigned a region but not a canonical name would take region-scoped rates while
      // silently never matching state-scoped ones.
      for (const [alias] of STATE_REGION_PAIRS) {
        expect({ alias, canonical: canonicalStateName(alias) }).toEqual({
          alias,
          canonical: expect.any(String),
        });
      }
    });
  });
});
