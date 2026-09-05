import { AssayerService } from './assayer.service';

/**
 * The map pool read: pins get exactly the fields a pin needs — the full 78-column record
 * (banking, KYC, HR detail) must never ride along to the map layer again — plus the two
 * grouped facts the row itself cannot answer: bank standings and committed-today.
 */
describe('AssayerService.mapRoster', () => {
  const makeService = (opts: {
    assayers: any[];
    empanelmentRows?: any[];
    workRows?: any[];
  }) => {
    const find = jest.fn().mockResolvedValue(opts.assayers);
    const query = jest
      .fn()
      .mockResolvedValueOnce(opts.empanelmentRows ?? [])
      .mockResolvedValueOnce(opts.workRows ?? []);
    const service = Object.create(AssayerService.prototype) as AssayerService;
    (service as any).assayerRepository = { find, manager: { query } };
    return { service, find, query };
  };

  const person = (id: string) => ({
    id, assayerCode: `AS000${id}`, displayName: `Person ${id}`, phone: '9800000000',
    status: 'ACTIVE', lifecycleStatus: 'ACTIVE', latitude: 10, longitude: 76,
    state: 'Kerala', district: 'Kozhikode',
  });

  it('returns pin fields plus empanelments and today-commitment — and nothing else', async () => {
    const { service } = makeService({
      assayers: [person('1')],
      empanelmentRows: [
        { assayer_id: '1', client_id: 'c-rbl', status: 'ACTIVE', client_name: 'RBL' },
        { assayer_id: '1', client_id: 'c-axis', status: 'REJECTED', client_name: 'AXIS' },
      ],
      workRows: [{ assayer_id: '1', open: 3, today: 1 }],
    });
    const [row] = await service.mapRoster();
    expect(Object.keys(row).sort()).toEqual([
      'approxLocation', 'assayerCode', 'assignedToday', 'displayName', 'district', 'empanelments', 'id',
      'latitude', 'lifecycleStatus', 'longitude', 'openAssignments', 'phone', 'state', 'status',
    ]);
    expect(row.empanelments).toEqual([
      { clientId: 'c-rbl', clientName: 'RBL', status: 'ACTIVE' },
      { clientId: 'c-axis', clientName: 'AXIS', status: 'REJECTED' },
    ]);
    expect(row.assignedToday).toBe(true);
    expect(row.openAssignments).toBe(3);
  });

  it('selects only the pin columns from the roster table', async () => {
    const { service, find } = makeService({ assayers: [] });
    await service.mapRoster();
    const select: string[] = find.mock.calls[0][0].select;
    expect(select).not.toContain('bankAccountNumber');
    expect(select).not.toContain('panNumber');
    expect(select).not.toContain('aadhaarNumber');
    expect(select).not.toContain('notes');
  });

  it('honours the region scope the way findAll does', async () => {
    const { service, find } = makeService({ assayers: [] });
    await service.mapRoster({ regions: ['SOUTH'] } as any);
    expect(find.mock.calls[0][0].where.region).toBeDefined();
  });

  it('no commitments and no standings read as free and bankless, not as errors', async () => {
    const { service } = makeService({ assayers: [person('2')] });
    const [row] = await service.mapRoster();
    expect(row.empanelments).toEqual([]);
    expect(row.assignedToday).toBe(false);
    expect(row.openAssignments).toBe(0);
  });

  /**
   * This used to fetch every active assayer with no ceiling at all — fine at 1,155 rows, and not
   * a promise worth keeping as the roster grows. A layer that renders map dots, not a data export,
   * gets a generous clamp instead (the controller supplies the caller-facing ParseLimitPipe;
   * this is the service-level default for any direct/internal caller that passes none).
   */
  it('clamps the pool it fetches rather than holding the whole roster unconditionally', async () => {
    const { service, find } = makeService({ assayers: [] });
    await service.mapRoster();
    expect(find.mock.calls[0][0].take).toBe(2000);

    await service.mapRoster(undefined, 750);
    expect(find.mock.calls[1][0].take).toBe(750);
  });
});
