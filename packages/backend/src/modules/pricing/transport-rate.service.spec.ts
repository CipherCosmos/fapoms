import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TravelMode, STATE_REGION_PAIRS, canonicalStateName } from '@fapoms/shared';

import { TransportRateService } from './transport-rate.service';
import { TransportRateEntity } from './transport-rate.entity';
import { CacheService } from '../../infrastructure/cache/cache.service';

/**
 * The rules that make a transport rate defensible: the most specific scope wins, retired and
 * future rates never price anything, spellings from real imports still match, and when nothing
 * matches the answer is silence — not a guess — so the quote engine falls back to the legacy
 * formula it has always had.
 */
describe('TransportRateService', () => {
  let service: TransportRateService;
  let repo: any;

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
