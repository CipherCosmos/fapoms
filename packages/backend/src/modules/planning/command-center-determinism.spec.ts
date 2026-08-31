import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CommandCenterService } from './command-center.service';
import { CacheService } from '../../infrastructure/cache/cache.service';

/**
 * The guarantee under test: the Command Room answer is a function of the data, not of the
 * query plan that fetched it.
 *
 * Neither population query in this service can order its own rows for free — an `ORDER BY`
 * on the branch query costs an external merge sort of 40,087 wide rows — so the total order
 * is imposed in TypeScript instead. That makes it invisible: nothing about
 * `branches.map(...)` announces that deleting one `orderedById` call would let a staffing
 * dashboard return a different answer on identical data. This spec is the tripwire.
 *
 * It works by running the same fixture twice with the row arrays reversed, which is exactly
 * what a plan change does. Every tie-break the response depends on is represented:
 *
 *  - two territories tied on `packets`, so their order is decided by arrival alone;
 *  - three branches in one district whose audit hours (0.1, 0.2, 0.3) sum to
 *    0.6000000000000001 in one direction and 0.6 in the other — float addition is not
 *    associative, and both accumulators used to reach the wire unrounded;
 *  - branches tied on nearest-assayer distance beyond the serviceable radius, contesting the
 *    last `coverageGaps` slot and the truncated pin arrays.
 *
 * Reversing the input on the unfixed service changes the response. It must not change it here.
 */
describe('CommandCenterService — determinism against row order', () => {
  /** Raw branch rows in the shape the population query returns them. */
  const branchRow = (
    id: string,
    state: string,
    district: string,
    packets: number,
    km: number | null,
  ) => ({
    id,
    name: `Branch ${id}`,
    branch_code: `BR-${id}`,
    district,
    state,
    latitude: '19.1',
    longitude: '72.8',
    project_branch_id: `pb-${id}`,
    branch_status: 'PENDING',
    packet_count: packets,
    scheduled_date: null,
    project_id: 'proj-1',
    project_name: 'Project 1',
    client_id: 'client-1',
    client_name: 'Client 1',
    // 6 minutes a packet, so 1/2/3 packets are 0.1/0.2/0.3 audit hours exactly.
    minutes_per_packet: 6,
    serviceable_radius_km: 150,
    nearest_assayer_id: km === null ? null : 'asy-1',
    nearest_assayer_name: km === null ? null : 'Assayer One',
    nearest_assayer_km: km,
    assignment_count: 0,
    realised_revenue: 0,
  });

  // Two states, tied at 6 packets each, so nothing but arrival order separates them.
  // Within each, three branches share a district and two sit beyond the 150 km radius at an
  // identical 200.5 km — a tie at the coverage-gap boundary.
  const BRANCHES = [
    branchRow('b1', 'Maharashtra', 'PUNE', 1, 200.5),
    branchRow('b2', 'Maharashtra', 'PUNE', 2, 200.5),
    branchRow('b3', 'Maharashtra', 'PUNE', 3, 40.2),
    branchRow('b4', 'Kerala', 'KOCHI', 1, 200.5),
    branchRow('b5', 'Kerala', 'KOCHI', 2, 200.5),
    branchRow('b6', 'Kerala', 'KOCHI', 3, 40.2),
  ];

  const ASSAYERS = [
    { id: 'a1', display_name: 'One', assayer_code: 'A1', district: 'PUNE', state: 'Maharashtra', latitude: '19.1', longitude: '72.8', max_daily_workload: 3, base_fee: '1000.00', open_assignments: '0' },
    { id: 'a2', display_name: 'Two', assayer_code: 'A2', district: 'KOCHI', state: 'Kerala', latitude: '9.9', longitude: '76.2', max_daily_workload: 3, base_fee: '2000.00', open_assignments: '0' },
    { id: 'a3', display_name: 'Three', assayer_code: 'A3', district: 'PUNE', state: 'Maharashtra', latitude: '19.2', longitude: '72.9', max_daily_workload: 3, base_fee: '3000.00', open_assignments: '1' },
  ];

  /** Runs the service against the fixture, optionally with every row array reversed. */
  async function overviewWith(reversed: boolean): Promise<any> {
    const branches = reversed ? [...BRANCHES].reverse() : [...BRANCHES];
    const assayers = reversed ? [...ASSAYERS].reverse() : [...ASSAYERS];

    // The statements this service issues, told apart by a fragment unique to each.
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('catchment_counts')) {
        const counts = branches.map((b) => ({ project_branch_id: b.project_branch_id, assayers_in_range: '2' }));
        return reversed ? counts.reverse() : counts;
      }
      if (sql.includes('WITH roster AS')) return assayers;
      // The project-less master branches appended to the live map — none in this fixture.
      if (sql.includes('NOT EXISTS') && sql.includes('project_branches')) return [];
      return branches;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommandCenterService,
        { provide: getDataSourceToken(), useValue: { query } as Partial<DataSource> },
        // Straight through — the cache would mask the second run entirely.
        { provide: CacheService, useValue: { wrap: (_k: string, _ttl: number, fn: () => any) => fn() } },
      ],
    }).compile();

    const result = await module.get(CommandCenterService).overview({});
    // A clock read, not an output.
    delete result.generatedAt;
    return result;
  }

  const stripped = (r: any) => JSON.parse(JSON.stringify(r));

  it('returns the same response whichever order the rows arrive in', async () => {
    const forwards = await overviewWith(false);
    const backwards = await overviewWith(true);
    expect(stripped(backwards)).toEqual(stripped(forwards));
  });

  it('holds when the bounded pin arrays have to cut through a tie', async () => {
    // Small enough that both layers truncate, so which pins survive is decided by row order.
    const previous = process.env.COMMAND_CENTER_MAX_POINTS;
    process.env.COMMAND_CENTER_MAX_POINTS = '2';
    try {
      const forwards = await overviewWith(false);
      const backwards = await overviewWith(true);
      expect(forwards.meta.branchPoints.truncated).toBe(true);
      expect(stripped(backwards)).toEqual(stripped(forwards));
    } finally {
      if (previous === undefined) delete process.env.COMMAND_CENTER_MAX_POINTS;
      else process.env.COMMAND_CENTER_MAX_POINTS = previous;
    }
  });

  it('appends project-less branches to the live map without disturbing the work aggregates', async () => {
    // A branch that exists in the master but sits in no project — imported through the Branches
    // page. The live map must still show it; the packets/coverage totals must not count it.
    const orphan = {
      id: 'orphan-1', name: 'Orphan Branch', branch_code: 'OB-1', district: 'THANE',
      state: 'Maharashtra', latitude: '19.2', longitude: '72.97', client_id: 'client-1',
      client_name: 'Client 1',
    };
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('catchment_counts')) return BRANCHES.map((b) => ({ project_branch_id: b.project_branch_id, assayers_in_range: '2' }));
      if (sql.includes('WITH roster AS')) return ASSAYERS;
      if (sql.includes('NOT EXISTS') && sql.includes('project_branches')) return [orphan];
      return BRANCHES;
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommandCenterService,
        { provide: getDataSourceToken(), useValue: { query } as Partial<DataSource> },
        { provide: CacheService, useValue: { wrap: (_k: string, _ttl: number, fn: () => any) => fn() } },
      ],
    }).compile();

    const result = await module.get(CommandCenterService).overview({});

    // The orphan is on the map…
    const pin = result.branchPoints.find((b: any) => b.id === 'orphan-1');
    expect(pin).toBeDefined();
    expect(pin.packets).toBe(0);
    expect(pin.projectBranchId).toBeNull();
    // …counted in what the map shows and in the branch total (a book with branches but no
    // projects must not read as empty)…
    expect(result.meta.branchPoints.total).toBe(BRANCHES.length + 1);
    expect(result.totals.branches).toBe(BRANCHES.length + 1);
    // …it shows up in its territory's branch tally, in the THANE district…
    const withThane = result.territories.find((t: any) => t.districts.some((d: any) => d.district === 'THANE'));
    expect(withThane).toBeDefined();
    expect(withThane.districts.find((d: any) => d.district === 'THANE').branches).toBe(1);
    // Maharashtra's tally is its 3 project branches (PUNE) plus the 1 project-less (THANE).
    expect(withThane.branches).toBe(4);
    // …but adds nothing to the *work* figures.
    expect(result.totals.packets).toBe(BRANCHES.reduce((s, b) => s + b.packet_count, 0));
    expect(result.totals.auditHours).toBe(
      Math.round(BRANCHES.reduce((s, b) => s + (b.packet_count * 6) / 60, 0) * 10) / 10,
    );
  });

  it('does not append the master list when a projectId scopes the view (planning map)', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('catchment_counts')) return [];
      if (sql.includes('WITH roster AS')) return [];
      if (sql.includes('NOT EXISTS') && sql.includes('project_branches')) throw new Error('extras query must not run when projectId is set');
      return [];
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommandCenterService,
        { provide: getDataSourceToken(), useValue: { query } as Partial<DataSource> },
        { provide: CacheService, useValue: { wrap: (_k: string, _ttl: number, fn: () => any) => fn() } },
      ],
    }).compile();

    await expect(module.get(CommandCenterService).overview({ projectId: 'proj-1' })).resolves.toBeDefined();
  });

  it('keeps the unrounded distance accumulators off the response', async () => {
    const result = await overviewWith(false);
    for (const territory of result.territories) {
      expect(territory).not.toHaveProperty('nearestKmSum');
      expect(territory).not.toHaveProperty('nearestKmCount');
      // Everything that is published is rounded to the precision it is displayed at.
      for (const district of territory.districts) {
        expect(district.auditHours).toBe(Math.round(district.auditHours * 10) / 10);
      }
    }
  });
});
