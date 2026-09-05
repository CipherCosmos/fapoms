import { AssayerService } from './assayer.service';
import { BadRequestException } from '@nestjs/common';

/**
 * The assayer confirms their own base location from the app.
 *
 * The promise: a device GPS fix from the person standing at the spot becomes a MANUAL pin
 * (never re-geocoded), and — because that fix is ground truth — it corrects the recorded state
 * and region when a reverse lookup disagrees, which is exactly the roster data error that put
 * them on the wrong part of the map. A coordinate outside India is refused.
 */
jest.mock('./assayer.service', () => {
  const actual = jest.requireActual('./assayer.service');
  return actual;
});

describe('AssayerService.confirmBaseLocation', () => {
  const makeService = (over: Record<string, unknown> = {}) => {
    const update = jest.fn().mockResolvedValue(undefined);
    const found = { id: 'a-1', isActive: true, state: 'Sikkim', latitude: null, ...over };
    const service = Object.create(AssayerService.prototype) as AssayerService;
    (service as any).assayerRepository = {
      findOne: jest.fn().mockResolvedValue(found),
      update,
    };
    (service as any).activityRepository = { create: jest.fn((x) => x), save: jest.fn() };
    // recordActivity + findOne pass through the prototype; stub findOne's dependency chain.
    (service as any).hydrateWorkforceAttributes = jest.fn();
    // Confirming a pin announces itself like every other write to this record — the cached HR
    // overview and the open web roster both listen for it.
    const publish = jest.fn();
    (service as any).eventPublisher = { publish };
    return { service, update, publish, activity: (service as any).activityRepository.save };
  };

  it('refuses a coordinate that is not in India', async () => {
    const { service } = makeService();
    await expect(service.confirmBaseLocation('a-1', 0, 0, 'a-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores a valid India fix as a MANUAL pin at ~10 m', async () => {
    const { service, update } = makeService();
    await service.confirmBaseLocation('a-1', 27.04, 88.26, 'a-1'); // Darjeeling area, West Bengal
    expect(update).toHaveBeenCalledWith('a-1', expect.objectContaining({
      latitude: 27.04,
      longitude: 88.26,
      geoSource: 'manual',
      geoAccuracyMeters: 10,
    }));
  });

  it('writes a Point geometry with lng first (GeoJSON order)', async () => {
    const { service, update } = makeService();
    await service.confirmBaseLocation('a-1', 27.04, 88.26, 'a-1');
    const payload = update.mock.calls[0][1];
    expect(payload.location).toEqual({ type: 'Point', coordinates: [88.26, 27.04] });
  });

  /**
   * This path published nothing at all, which made it the one record gap an assayer could close
   * where the web was guaranteed not to notice: the cached HR overview kept its old figures for
   * the full TTL and the open roster never refreshed. `latitude` is a critical record field, so
   * the person fixing it is precisely the person being told their record is incomplete.
   */
  it('announces the change, so the roster and the cached overview both move', async () => {
    const { service, publish } = makeService();
    await service.confirmBaseLocation('a-1', 27.04, 88.26, 'a-1');
    expect(publish).toHaveBeenCalledWith('assayer:updated', expect.objectContaining({
      eventType: 'assayer:updated',
      aggregateId: 'a-1',
    }));
  });
});

/**
 * A device fix settles where the person IS. It does not make the address on their record right —
 * and the address is what lasts: it appears on documents, a clerk reads it, and it is what gets
 * geocoded again if the pin is ever cleared. So confirming a pin has to say when the two disagree,
 * rather than thanking the person and leaving a wrong address in place.
 */
describe('AssayerService.confirmBaseLocation — checking the written address against the fix', () => {
  const makeService = (over: Record<string, unknown>) => {
    const found = { id: 'a-1', isActive: true, ...over };
    const service = Object.create(AssayerService.prototype) as AssayerService;
    (service as any).assayerRepository = { findOne: jest.fn().mockResolvedValue(found), update: jest.fn() };
    (service as any).activityRepository = { create: jest.fn((x) => x), save: jest.fn() };
    (service as any).hydrateWorkforceAttributes = jest.fn();
    (service as any).eventPublisher = { publish: jest.fn() };
    return service;
  };

  /** Sikkim; the fixture states below are chosen to agree or disagree with this. */
  const IN_SIKKIM = [27.33, 88.61] as const;

  it('flags an address whose recorded state is not where the person actually is', async () => {
    // The record says Kerala, the person is standing in Sikkim. Nothing about that address is
    // salvageable by a better geocoder.
    const service = makeService({ state: 'Kerala', latitude: 9.9, longitude: 76.2, geoSource: 'pincode' });
    const saved: any = await service.confirmBaseLocation('a-1', ...IN_SIKKIM, 'a-1');
    expect(saved.addressCheck.looksWrong).toBe(true);
    expect(saved.addressCheck.recordedState).toBe('Kerala');
  });

  it('flags an address that geocoded far from where the person actually is', async () => {
    // Same state, but the written address placed them ~200 km away — within one state, which the
    // state check alone would miss.
    const service = makeService({ state: 'Sikkim', latitude: 25.5, longitude: 88.61, geoSource: 'pincode' });
    const saved: any = await service.confirmBaseLocation('a-1', ...IN_SIKKIM, 'a-1');
    expect(saved.addressCheck.looksWrong).toBe(true);
    expect(saved.addressCheck.kmFromWrittenAddress).toBeGreaterThan(25);
  });

  /**
   * The threshold has to sit past honest geocoding error or it fires on every correct address and
   * trains people to dismiss it. Most of this roster is placed from a pincode centroid, whose own
   * error bar is 3 km.
   */
  it('says nothing when the address merely resolved a few kilometres out', async () => {
    const service = makeService({ state: 'Sikkim', latitude: 27.36, longitude: 88.63, geoSource: 'pincode' });
    const saved: any = await service.confirmBaseLocation('a-1', ...IN_SIKKIM, 'a-1');
    expect(saved.addressCheck.looksWrong).toBe(false);
  });

  it('does not measure against a pin somebody had already placed by hand', async () => {
    // A previous manual pin says nothing about the ADDRESS, so comparing to it would report a
    // disagreement between two device fixes as though the address were at fault.
    const service = makeService({ state: 'Sikkim', latitude: 25.5, longitude: 88.61, geoSource: 'manual' });
    const saved: any = await service.confirmBaseLocation('a-1', ...IN_SIKKIM, 'a-1');
    expect(saved.addressCheck.kmFromWrittenAddress).toBeNull();
    expect(saved.addressCheck.looksWrong).toBe(false);
  });

  it('records the disagreement on the person\'s history, not only in the response', async () => {
    // The app tells the person; the record has to tell whoever looks at it next.
    const service = makeService({ state: 'Kerala', latitude: 9.9, longitude: 76.2, geoSource: 'pincode' });
    const save = (service as any).activityRepository.save as jest.Mock;
    await service.confirmBaseLocation('a-1', ...IN_SIKKIM, 'a-1');
    const note = JSON.stringify(save.mock.calls);
    expect(note).toMatch(/address .*does not agree|still needs fixing/i);
  });
});
