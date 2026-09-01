import { ClientService } from './client.service';
import { Region } from '@fapoms/shared';

/**
 * `ClientService.filterQualifiedAssayersByRegion` — the one staged region check this module
 * wires (see `client.controller.ts` for the "why not the other five routes" reasoning: a client
 * has no `region` column of its own, so `findOne`/`findAll`/`findContacts`/`findContracts`/
 * `findBilling` are deliberately left unscoped).
 *
 * Exercised directly against the method the way `client-tunables.spec.ts` reaches
 * `validateTunables` — the method touches only `regionGuard` and `dataSource`, so it needs
 * neither the full DI graph nor a real database.
 */
describe('ClientService.filterQualifiedAssayersByRegion', () => {
  const NORTH = Region.NORTH;
  const SOUTH = Region.SOUTH;

  const row = (assayerId: string, extra: Record<string, unknown> = {}) => ({
    assayer: { id: assayerId, displayName: assayerId, assayerCode: assayerId, city: null, state: null },
    computed: 80,
    effective: 80,
    standing: null,
    barred: false,
    gaps: [],
    ...extra,
  });

  function makeService(mode: 'off' | 'log' | 'enforce', regionByAssayerId: Record<string, string | null>) {
    const service = Object.create(ClientService.prototype) as ClientService;
    (service as any).regionGuard = { stagedMode: jest.fn().mockResolvedValue(mode) };
    (service as any).dataSource = {
      query: jest.fn().mockImplementation((_sql: string, params: any[]) => {
        const ids: string[] = params[0];
        return Promise.resolve(
          ids
            .filter((id) => id in regionByAssayerId)
            .map((id) => ({ id, region: regionByAssayerId[id] })),
        );
      }),
    };
    (service as any).logger = { warn: jest.fn() };
    return service;
  }

  it('off mode: returns rows completely untouched, no DB query at all', async () => {
    const service = makeService('off', { a1: SOUTH });
    const rows = [row('a1')];

    const result = await service.filterQualifiedAssayersByRegion(rows, { regions: [NORTH] });

    expect(result).toBe(rows); // same reference — byte-for-byte identical
    expect((service as any).dataSource.query).not.toHaveBeenCalled();
  });

  it('unrestricted caller (regions: null): returns rows untouched in every mode, no query', async () => {
    for (const mode of ['off', 'log', 'enforce'] as const) {
      const service = makeService(mode, { a1: SOUTH });
      const rows = [row('a1')];

      const result = await service.filterQualifiedAssayersByRegion(rows, { regions: null });

      expect(result).toBe(rows);
      expect((service as any).dataSource.query).not.toHaveBeenCalled();
    }
  });

  it('log mode: response is byte-for-byte identical to the unscoped result, but warns', async () => {
    const service = makeService('log', { a1: NORTH, a2: SOUTH });
    const rows = [row('a1'), row('a2')];

    const result = await service.filterQualifiedAssayersByRegion(rows, { regions: [NORTH] });

    expect(result).toEqual(rows);
    expect(result.length).toBe(2); // nothing dropped
    expect((service as any).logger.warn).toHaveBeenCalledTimes(1);
    expect((service as any).logger.warn.mock.calls[0][0]).toContain('would filter 1 of 2');
  });

  it('log mode: an assayer with a null/unresolved region is never counted as out of scope', async () => {
    const service = makeService('log', { a1: null as any });
    const rows = [row('a1')];

    const result = await service.filterQualifiedAssayersByRegion(rows, { regions: [NORTH] });

    expect(result).toEqual(rows);
    expect((service as any).logger.warn).not.toHaveBeenCalled();
  });

  it('enforce mode: drops assayers outside the caller\'s regions, keeps in-region and regionless ones', async () => {
    const service = makeService('enforce', { a1: NORTH, a2: SOUTH, a3: null as any });
    const rows = [row('a1'), row('a2'), row('a3')];

    const result = await service.filterQualifiedAssayersByRegion(rows, { regions: [NORTH] });

    expect(result.map((r) => r.assayer.id)).toEqual(['a1', 'a3']);
  });

  it('enforce mode: an unrestricted account sees every row (regions: null bypasses filtering)', async () => {
    const service = makeService('enforce', { a1: NORTH, a2: SOUTH });
    const rows = [row('a1'), row('a2')];

    const result = await service.filterQualifiedAssayersByRegion(rows, { regions: null });

    expect(result).toBe(rows);
  });

  it('empty result set: short-circuits without a query in any mode', async () => {
    for (const mode of ['off', 'log', 'enforce'] as const) {
      const service = makeService(mode, {});
      const result = await service.filterQualifiedAssayersByRegion([], { regions: [NORTH] });
      expect(result).toEqual([]);
      expect((service as any).dataSource.query).not.toHaveBeenCalled();
    }
  });
});
