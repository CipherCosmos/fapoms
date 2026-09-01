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
  const makeService = () => {
    const update = jest.fn().mockResolvedValue(undefined);
    const found = { id: 'a-1', isActive: true, state: 'Sikkim', latitude: null };
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
    return { service, update, publish };
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
