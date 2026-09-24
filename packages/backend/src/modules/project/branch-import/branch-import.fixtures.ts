/**
 * Test doubles for the branch import: an in-memory branch master that the rehearsal reads and the
 * commit writes, and directories that count every question they are asked.
 *
 * Not a spec (no `.spec.ts`), so it is compiled but never collected as a suite; only specs import it.
 */

import * as xlsx from 'xlsx';
import { parseSheet, type ParsedSheet } from '../../../core/excel/sheet-reader';
import type { ChunkToWrite, CommitStore } from './branch-import.commit';
import type { RehearsalReads } from './branch-import.rehearsal';
import type {
  BranchImportHooks,
  BranchImportLookups,
  BranchImportTarget,
  GeoFix,
  GeocodeRequest,
  MasterBranch,
  OtherClientBranch,
} from './branch-import.types';

export function sheetOf(rows: Array<Record<string, unknown>>, opts: { titleRow?: boolean } = {}): Buffer {
  const wb = xlsx.utils.book_new();
  const ws = opts.titleRow
    ? xlsx.utils.aoa_to_sheet([['Branch list — Q3'], []])
    : xlsx.utils.json_to_sheet(rows);
  if (opts.titleRow) xlsx.utils.sheet_add_json(ws, rows, { origin: 'A3' });
  xlsx.utils.book_append_sheet(wb, ws, 'Branch');
  return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

export function parsed(rows: Array<Record<string, unknown>>, opts: { titleRow?: boolean } = {}): ParsedSheet {
  return parseSheet(sheetOf(rows, opts), ['BRANCH', 'BRANCH_NAME', 'STATE']);
}

export function target(overrides: Partial<BranchImportTarget> = {}): BranchImportTarget {
  return {
    scopeType: 'CLIENT',
    projectId: null,
    clientId: 'client-1',
    organizationId: 'org-1',
    clientName: 'State Bank of India',
    bankCode: 'SBIN',
    priority: 'MEDIUM',
    minutesPerPacket: 15,
    label: 'SBI',
    ...overrides,
  };
}

export function master(overrides: Partial<MasterBranch> & { solId: string }): MasterBranch {
  return {
    id: `b-${overrides.solId}`,
    name: `Branch ${overrides.solId}`,
    state: 'Kerala',
    district: 'PALAKKAD',
    city: 'PALAKKAD',
    address: '1 Main Road, Palakkad 678001',
    pincode: '678001',
    latitude: 10.78,
    longitude: 76.65,
    geoSource: 'pincode',
    geoAccuracyMeters: 5000,
    region: 'SOUTH',
    zoneId: 'zone-south',
    isActive: true,
    complexity: 'STANDARD',
    estimatedDurationHours: 6,
    ...overrides,
  };
}

/** Directories that answer instantly (or after `delayMs`) and count every call. */
export function countingLookups(opts: { delayMs?: number; usesAddress?: boolean } = {}) {
  const calls = { ifsc: [] as string[], pincode: [] as string[], geocode: [] as GeocodeRequest[] };
  const wait = () => (opts.delayMs ? new Promise((r) => setTimeout(r, opts.delayMs)) : Promise.resolve());
  const lookups: BranchImportLookups = {
    ifsc: async (_bank, code) => {
      calls.ifsc.push(code);
      await wait();
      return {
        bankName: 'State Bank of India', branchName: 'X', city: null, district: 'THRISSUR', state: 'Kerala',
        address: `IFSC address for ${code}`, pincode: '680001', phone: '0487-2333333', bankCode: 'SBIN', ifsc: code,
      };
    },
    pincode: async (pin) => {
      calls.pincode.push(pin);
      await wait();
      return { state: 'Kerala', district: 'Palakkad', city: 'Palakkad', source: 'directory' as const };
    },
    geocode: async (request): Promise<GeoFix> => {
      calls.geocode.push(request);
      await wait();
      return { lat: 10.5, lng: 76.2, geoSource: 'pincode', geoAccuracyMeters: 5000, geoMatchedName: request.pincode };
    },
    geocodeUsesAddress: !!opts.usesAddress,
  };
  return { lookups, calls };
}

export function quietHooks(overrides: Partial<BranchImportHooks> = {}): BranchImportHooks & { stages: string[] } {
  const stages: string[] = [];
  return {
    stages,
    progress: async (_p, _t, stage) => { if (stage && stages[stages.length - 1] !== stage) stages.push(stage); },
    throwIfCancelled: async () => undefined,
    ...overrides,
  };
}

/**
 * The branch master and project links, in memory. `writeChunk` is all-or-nothing like the real
 * transaction: a row whose SOL ID is in `failSols` fails the whole chunk it is in.
 */
export class MemoryBranchStore {
  branches = new Map<string, MasterBranch>(); // by id
  links: Array<{ id: string; projectId: string; branchId: string; packetCount: number | null }> = [];
  assessments: Array<{ projectId: string; branchId: string }> = [];
  others: OtherClientBranch[] = [];
  chunks: number[] = [];
  announced: number[] = [];
  geographyChecks: string[] = [];
  failSols = new Set<string>();
  badGeography = new Set<string>();
  private seq = 0;

  constructor(seed: MasterBranch[] = []) {
    for (const b of seed) this.branches.set(b.id, { ...b });
  }

  bySol(sol: string): MasterBranch | undefined {
    return [...this.branches.values()].find((b) => b.solId.toUpperCase() === sol.toUpperCase());
  }

  reads(): RehearsalReads {
    return {
      masterBySol: async (sols) => {
        const want = new Set(sols.map((s) => s.trim().toUpperCase()));
        return [...this.branches.values()].filter((b) => want.has(b.solId.toUpperCase())).map((b) => ({ ...b }));
      },
      otherClientsBySol: async (sols) => {
        const want = new Set(sols.map((s) => s.trim().toUpperCase()));
        return this.others.filter((o) => want.has(o.solId.toUpperCase()));
      },
      validateGeography: (state, district, city) => this.validateGeography(state, district, city),
    };
  }

  commitStore(): CommitStore {
    return {
      masterBySol: this.reads().masterBySol,
      projectLinks: async (projectId) => this.links.filter((l) => l.projectId === projectId).map((l) => ({ ...l })),
      assessedBranchIds: async (projectId) => this.assessments.filter((a) => a.projectId === projectId).map((a) => a.branchId),
      zoneIdForState: async (state) => `zone-${state.toLowerCase()}`,
      validateGeography: (state, district, city) => this.validateGeography(state, district, city),
      writeChunk: async (chunk) => this.writeChunk(chunk),
      announce: (_t, count) => { this.announced.push(count); },
    };
  }

  /** One geography rule for both phases: a state or a district in `badGeography` fails. */
  private async validateGeography(state: string, district: string, city: string): Promise<void> {
    this.geographyChecks.push(`${state}|${district}|${city}`);
    if (this.badGeography.has(state)) throw new Error(`Could not verify '${state}' as a real state.`);
    if (district && this.badGeography.has(district)) throw new Error(`Could not verify '${city}, ${district}, ${state}' as a real place.`);
  }

  private async writeChunk(chunk: ChunkToWrite): Promise<Map<number, string>> {
    this.chunks.push(chunk.rows.length);
    if (chunk.rows.some((r) => this.failSols.has(r.solId))) {
      const err = new Error('duplicate key value violates unique constraint "UQ_branches_client_sol_id"') as Error & { code: string };
      err.code = '23505';
      throw err;
    }
    const ids = new Map<number, string>();
    for (const r of chunk.rows) {
      if (r.create) {
        const id = `new-${++this.seq}`;
        this.branches.set(id, {
          id, solId: r.create.solId, name: r.create.name, state: r.create.state, district: r.create.district,
          city: r.create.city, address: r.create.address, pincode: r.create.pincode, latitude: r.create.latitude,
          longitude: r.create.longitude, geoSource: r.create.geoSource, geoAccuracyMeters: r.create.geoAccuracyMeters,
          region: r.create.region, zoneId: r.create.zoneId, isActive: true, complexity: r.create.complexity,
          estimatedDurationHours: r.create.estimatedDurationHours,
        });
        ids.set(r.rowNumber, id);
      } else if (r.existing) {
        const b = this.branches.get(r.existing.branchId)!;
        const { location: _location, geoMatchedName: _g, geoResolvedAt: _r, ...patch } = r.existing.patch;
        Object.assign(b, patch, r.existing.restore ? { isActive: true } : {});
        ids.set(r.rowNumber, b.id);
      }
      const branchId = ids.get(r.rowNumber)!;
      if (r.link?.create) {
        this.links.push({ id: `pb-${++this.seq}`, projectId: chunk.target.projectId!, branchId, packetCount: r.link.packetCount });
        if (r.link.openAssessment) this.assessments.push({ projectId: chunk.target.projectId!, branchId });
      } else if (r.link?.linkId) {
        const link = this.links.find((l) => l.id === r.link!.linkId)!;
        link.packetCount = r.link.packetCount;
      }
    }
    return ids;
  }
}
