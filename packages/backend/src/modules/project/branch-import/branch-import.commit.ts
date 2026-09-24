/**
 * FAPOMS — the branch-import COMMIT: write what the person approved, fast, and name what it did not.
 *
 * ## What it starts from
 *
 * Not rows from the browser. It starts from the rehearsal's review, stored on the server, and the
 * person's decisions (see `applyBranchDecisions` in `@fapoms/shared`): removed rows, typed-over
 * fields, a hand-placed pin, and whether to write every valid row or only the exactly located ones.
 * A coordinate, a geo source or a region can therefore only come from the server's own lookups or a
 * pin the person placed — never from a request body.
 *
 * ## Why it is not `BranchService.update` in a loop
 *
 * That was the old commit: per row a `findOne`, a geography check that may call a place-lookup
 * service, a precise (rate-limited, ~1/s) geocode when the address moved, a save, an audit write and
 * a `branch:updated` socket broadcast — so a 5,000-row commit was 5,000 of each, every open Branches
 * page refetched 5,000 times, and a single constraint error was a 500 for the whole file.
 *
 * Here the master is read once for the file; geography is checked once per distinct
 * state/district/city; anything that must be placed again is placed once per distinct place, on
 * the fast tiers, and handed to the precision worker afterwards (as the importer always did for new
 * branches); rows are written 200 to a transaction with multi-row inserts; each branch still gets
 * its own audit entry, written in the same transaction as the change it describes; and each chunk
 * sends ONE `branch:updated` notice rather than one per row. A chunk that fails is retried row by
 * row, so a bad row is reported by number and costs only itself.
 *
 * ## Why running it twice is safe
 *
 * Every row is found by SOL ID against a read taken at the start; branches are created only when
 * absent, and project links and assessments only where missing. A second run from the top — after
 * a worker died mid-way — finds the first run's rows and converges (the kind is `idempotent`).
 */

import {
  applyBranchDecisions,
  INDIAN_PINCODE,
  resolveRegion,
  type BranchImportCommitCounts,
  type BranchImportDecisions,
  type BranchImportRowNote,
  type BranchReviewReport,
  type BranchReviewRow,
} from '@fapoms/shared';
import { isPlausibleIndianCoord, needsBetterFix } from '../../geo/coordinate-resolution';
import { branchRegionAfterUpdate } from '../../branch/branch.service';
import { lookupEachOnce } from './lookup-pool';
import { geocodeKey, geographyCity, pincodeFor } from './branch-import.rehearsal';
import {
  COMMIT_CHUNK_SIZE,
  LOOKUP_CONCURRENCY,
  type BranchImportHooks,
  type BranchImportLookups,
  type BranchImportTarget,
  type GeoFix,
  type GeocodeRequest,
  type MasterBranch,
} from './branch-import.types';

/** The columns a new branch is inserted with. */
export interface NewBranchValues {
  solId: string;
  name: string;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode: string | null;
  branchType: string;
  latitude: number;
  longitude: number;
  location: { type: 'Point'; coordinates: [number, number] };
  geoSource: string;
  geoAccuracyMeters: number;
  geoMatchedName: string | null;
  geoResolvedAt: Date;
  organizationId: string | null;
  clientId: string | null;
  zoneId: string | null;
  region: string | null;
  territory: string;
  managerName: string | null;
  phone: string | null;
  email: string | null;
  riskCategory: string;
  riskScore: number;
  complexity: string;
  estimatedDurationHours: number;
  createdBy: string;
  updatedBy: string;
}

/** What an existing branch changes to. Only the fields that actually changed are present. */
export type BranchPatch = Partial<Pick<NewBranchValues,
  'name' | 'address' | 'state' | 'district' | 'pincode' | 'region' | 'latitude' | 'longitude' | 'location'
  | 'geoSource' | 'geoAccuracyMeters' | 'geoMatchedName' | 'geoResolvedAt' | 'complexity' | 'estimatedDurationHours'>>;

/** One row's writes, planned before anything is written. */
export interface PlannedRow {
  rowNumber: number;
  solId: string;
  name: string;
  /** A branch to insert. */
  create?: NewBranchValues;
  /** An existing branch: its id, what changes (possibly nothing), and whether it comes back from the archive. */
  existing?: { branchId: string; zoneId: string | null; patch: BranchPatch; restore: boolean };
  /** PROJECT imports: link the branch (and open its assessment), or refresh the link's packet count. */
  link?: { create: boolean; linkId?: string; packetCount: number | null; openAssessment: boolean };
  /** Set when the branch landed on a fallback coordinate. */
  imprecise?: string;
}

export interface ChunkToWrite {
  rows: PlannedRow[];
  target: BranchImportTarget;
  userId: string;
  jobId: string;
}

/** The writes, and who they announce themselves to. One transaction per `writeChunk`. */
export interface CommitStore {
  masterBySol(solIds: string[]): Promise<MasterBranch[]>;
  projectLinks(projectId: string): Promise<Array<{ id: string; branchId: string; packetCount: number | null }>>;
  assessedBranchIds(projectId: string): Promise<string[]>;
  zoneIdForState(state: string): Promise<string | null>;
  /** Throws (with a sentence) when the state/district/city cannot be verified — `BranchService`'s rule. */
  validateGeography(state: string, district: string, city: string): Promise<void>;
  /** Writes every row of the chunk in ONE transaction, or none. Returns the branch id per row number. */
  writeChunk(chunk: ChunkToWrite): Promise<Map<number, string>>;
  /** One notice to open screens that branches changed — per chunk, never per row. */
  announce(target: BranchImportTarget, count: number): void;
}

export interface CommitInput {
  report: BranchReviewReport;
  decisions: BranchImportDecisions;
  target: BranchImportTarget;
  userId: string;
  jobId: string;
  /** The requester's regions; null when unrestricted. A row outside them is refused, never written. */
  regions: string[] | null;
}

export interface CommitOutcome {
  /** A cancel stopped it between chunks; everything before the stop was written. */
  stoppedEarly: boolean;
  /** Planned rows worked through, of `toSave`. */
  saved: number;
  toSave: number;
  counts: BranchImportCommitCounts;
  skipped: BranchImportRowNote[];
  imprecise: BranchImportRowNote[];
  revived: BranchImportRowNote[];
  /** Removed in the review — reported, not counted as skipped. */
  removed: BranchImportRowNote[];
  /** Branches placed on a fallback coordinate, for the precision worker. */
  impreciseBranchIds: string[];
  /** How many distinct places had to be located at commit time. */
  geocoded: number;
}

const METRO_DISTRICTS = new Set(['BANGALORE', 'CHENNAI', 'PUNE', 'NOIDA']);
const upper = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 0–10, from the project's priority — see the note on `riskScoreFromCategory` history in ProjectService. */
export function riskScoreFromCategory(category: string): number {
  switch (category) {
    case 'CRITICAL': return 9;
    case 'HIGH': return 7;
    case 'MEDIUM': return 4;
    default: return 2;
  }
}

/** Complexity from packet volume: ≤40 simple, ≤100 standard, more complex; none recorded → standard. */
export function complexityFromPackets(packets: number | null | undefined): 'SIMPLE' | 'STANDARD' | 'COMPLEX' {
  if (packets === null || packets === undefined || !Number.isFinite(packets) || packets <= 0) return 'STANDARD';
  if (packets <= 40) return 'SIMPLE';
  if (packets <= 100) return 'STANDARD';
  return 'COMPLEX';
}

const POINT = (lat: number, lng: number) => ({ type: 'Point' as const, coordinates: [lng, lat] as [number, number] });

export async function commitBranchImport(
  input: CommitInput,
  store: CommitStore,
  lookups: BranchImportLookups,
  hooks: BranchImportHooks,
): Promise<CommitOutcome> {
  const { target, userId, regions } = input;
  const skipped: BranchImportRowNote[] = [];
  const imprecise: BranchImportRowNote[] = [];
  const revived: BranchImportRowNote[] = [];
  const impreciseBranchIds: string[] = [];
  const counts: BranchImportCommitCounts = { created: 0, updated: 0, unchanged: 0, revived: 0, linked: 0, skipped: 0, imprecise: 0 };

  // ── The decisions, applied to the stored review. ───────────────────────────────────────────
  await hooks.progress(0, input.report.rows.length, 'Checking the reviewed rows');
  const applied = applyBranchDecisions(input.report.rows, input.decisions, isPlausibleIndianCoord);
  skipped.push(...applied.left);

  // A person may type one row's SOL ID into another's: the first keeps it, the rest are named.
  const firstRowForSol = new Map<string, number>();
  const rows: BranchReviewRow[] = [];
  for (const row of applied.rows) {
    const key = upper(row.solId);
    const first = firstRowForSol.get(key);
    if (first !== undefined) {
      skipped.push({ row: row.rowNumber, solId: row.solId, reason: `Duplicate of row ${first} (SOL ID ${row.solId}) — the first row was kept.` });
      continue;
    }
    firstRowForSol.set(key, row.rowNumber);
    rows.push(row);
  }

  // ── Read the master once, now — not the rehearsal's copy, which may be hours old. ──────────
  await hooks.throwIfCancelled();
  const master = rows.length ? await store.masterBySol(rows.map((r) => r.solId)) : [];
  const masterBySol = new Map(master.map((b) => [upper(b.solId), b]));
  const links = target.projectId ? await store.projectLinks(target.projectId) : [];
  const linkByBranchId = new Map(links.map((l) => [l.branchId, l]));
  const assessed = new Set(target.projectId ? await store.assessedBranchIds(target.projectId) : []);

  // ── Place, once per distinct place, whatever the review left unplaced or an edit moved. ────
  const needGeo = new Map<number, { key: string; request: GeocodeRequest }>();
  for (const row of rows) {
    const existing = masterBySol.get(upper(row.solId));
    const unplaced = row.latitude === undefined || row.longitude === undefined;
    const movedByEdit = applied.movedByEdit.has(row.rowNumber) && row.geoSource !== 'manual' && existing?.geoSource !== 'manual';
    if (!unplaced && !movedByEdit) continue;
    const district = row.district ?? '';
    const request: GeocodeRequest = {
      address: row.address || `${row.name}, ${district}, ${row.state}`,
      name: row.name,
      district,
      state: row.state!,
      pincode: pincodeFor(row.pincode, row.address),
    };
    needGeo.set(row.rowNumber, { key: geocodeKey(request, lookups.geocodeUsesAddress), request });
  }
  const requestsByKey = new Map<string, GeocodeRequest>();
  for (const { key, request } of needGeo.values()) if (!requestsByKey.has(key)) requestsByKey.set(key, request);
  let fixes = new Map<string, GeoFix | null>();
  if (requestsByKey.size > 0) {
    const stage = `Locating ${requestsByKey.size.toLocaleString('en-IN')} addresses`;
    await hooks.progress(0, requestsByKey.size, stage);
    fixes = await lookupEachOnce(requestsByKey.keys(), (key) => lookups.geocode(requestsByKey.get(key)!), {
      concurrency: LOOKUP_CONCURRENCY.geocode,
      checkpoint: () => hooks.throwIfCancelled(),
      onAnswered: (n, of) => hooks.progress(n, of, stage),
    });
  }
  for (const row of rows) {
    const need = needGeo.get(row.rowNumber);
    const fix = need ? fixes.get(need.key) : null;
    if (!fix) continue;
    row.latitude = fix.lat;
    row.longitude = fix.lng;
    row.geoSource = fix.geoSource;
    row.geoAccuracyMeters = fix.geoAccuracyMeters;
  }

  // ── Plan every row. Nothing is written yet; a row that cannot be planned is named. ─────────
  const zoneByState = new Map<string, string | null>();
  const zoneFor = async (state: string) => {
    const key = upper(state);
    if (!zoneByState.has(key)) zoneByState.set(key, await store.zoneIdForState(state));
    return zoneByState.get(key) ?? null;
  };
  const geographyVerdict = new Map<string, string | null>();
  const checkGeography = async (state: string, district: string, city: string): Promise<string | null> => {
    const key = [state, district, city].map(upper).join('|');
    if (!geographyVerdict.has(key)) {
      try {
        await store.validateGeography(state, district, city);
        geographyVerdict.set(key, null);
      } catch (err) {
        geographyVerdict.set(key, (err as Error)?.message || 'The state and district could not be verified.');
      }
    }
    return geographyVerdict.get(key) ?? null;
  };

  const riskCategory = upper(target.priority) || 'MEDIUM';
  const plans: PlannedRow[] = [];
  for (const row of rows) {
    try {
      const plan = await planRow(row, masterBySol.get(upper(row.solId)), {
        target, userId, regions, riskCategory, zoneFor, checkGeography, linkByBranchId, assessed,
        placeEdited: applied.movedByEdit,
      });
      if ('refused' in plan) skipped.push({ row: row.rowNumber, solId: row.solId, reason: plan.refused });
      else plans.push(plan);
    } catch (err) {
      skipped.push({ row: row.rowNumber, solId: row.solId, reason: (err as Error)?.message || 'This row could not be prepared.' });
    }
  }

  // ── Write, a chunk to a transaction. ───────────────────────────────────────────────────────
  const total = plans.length;
  let done = 0;
  const stageFor = () => `Saving ${done.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')}`;
  await hooks.progress(0, total, stageFor());
  let stoppedEarly = false;
  for (let start = 0; start < plans.length; start += COMMIT_CHUNK_SIZE) {
    // Between chunks, never inside one: a cancelled commit stops with whole chunks written, and
    // says how far it got.
    if (start > 0 && hooks.shouldStop && (await hooks.shouldStop())) {
      stoppedEarly = true;
      break;
    }
    if (start === 0) await hooks.throwIfCancelled();
    const chunk = plans.slice(start, start + COMMIT_CHUNK_SIZE);
    const written = await writeIsolating(chunk, input, store, skipped);
    for (const plan of chunk) {
      const branchId = written.get(plan.rowNumber);
      if (!branchId) continue;
      tally(plan, branchId, counts, revived, imprecise, impreciseBranchIds);
      if (plan.link?.create) {
        linkByBranchId.set(branchId, { id: '', branchId, packetCount: plan.link.packetCount });
        assessed.add(branchId);
      }
    }
    if (written.size > 0) store.announce(target, written.size);
    done += chunk.length;
    await hooks.progress(done, total, stageFor());
  }

  counts.skipped = skipped.length;
  counts.imprecise = imprecise.length;
  return {
    stoppedEarly,
    saved: done,
    toSave: total,
    counts,
    skipped: skipped.sort((a, b) => a.row - b.row),
    imprecise,
    revived,
    removed: applied.removed,
    impreciseBranchIds,
    geocoded: requestsByKey.size,
  };
}

interface PlanContext {
  target: BranchImportTarget;
  userId: string;
  regions: string[] | null;
  riskCategory: string;
  zoneFor(state: string): Promise<string | null>;
  checkGeography(state: string, district: string, city: string): Promise<string | null>;
  /** Rows whose state, district, address or pincode was typed over in the review. */
  placeEdited: Set<number>;
  linkByBranchId: Map<string, { id: string; branchId: string; packetCount: number | null }>;
  assessed: Set<string>;
}

async function planRow(
  row: BranchReviewRow,
  existing: MasterBranch | undefined,
  ctx: PlanContext,
): Promise<PlannedRow | { refused: string }> {
  const { target, userId } = ctx;
  const state = (row.state ?? '').trim();
  const pincode = (row.pincode ?? '').trim();
  if (pincode && !INDIAN_PINCODE.test(pincode)) {
    return { refused: `"${pincode}" is not a valid pincode for "${row.name}" — expected 6 digits.` };
  }
  if (row.solId.length > 50) return { refused: 'The SOL ID is longer than 50 characters.' };
  if (row.name.length > 255) return { refused: 'The branch name is longer than 255 characters.' };
  if (state.length > 100 || (row.district ?? '').length > 100 || (row.city ?? '').length > 100) {
    return { refused: 'The state, district or city is longer than 100 characters.' };
  }

  // The region ceiling, at the row. The request already refused a file reaching outside the
  // requester's regions; this is the backstop for anything that changed in between.
  const landing = existing
    ? branchRegionAfterUpdate({ state: state && upper(state) !== upper(existing.state) ? state : undefined }, existing)
    : resolveRegion(state);
  for (const region of [landing, existing?.region]) {
    if (region && ctx.regions && !ctx.regions.includes(region)) {
      return { refused: `This branch is in the ${region} region, which your account is not assigned to.` };
    }
  }

  const packets = row.packetCount && row.packetCount > 0 ? row.packetCount : null;
  const hours = packets !== null ? round2((packets * target.minutesPerPacket) / 60) : null;
  const plan: PlannedRow = { rowNumber: row.rowNumber, solId: row.solId, name: row.name };

  if (!existing) {
    // A new branch's place was checked in the rehearsal (a failure left the row needing attention).
    // A place typed over in the review has not been, so it gets the same check an update gets —
    // once per distinct place — and a pair that still fails is skipped with the sentence why.
    if (ctx.placeEdited.has(row.rowNumber)) {
      const district = (row.district ?? '').trim();
      const refusal = await ctx.checkGeography(state, district, geographyCity(row.city, district));
      if (refusal) return { refused: refusal };
    }
    if (row.latitude === undefined || row.longitude === undefined) {
      return { refused: `"${row.name}" could not be placed on the map.` };
    }
    const district = upper(row.district) || 'UNKNOWN';
    const geoSource = row.geoSource || 'none';
    const accuracy = row.geoAccuracyMeters ?? 500_000;
    plan.create = {
      solId: row.solId.trim(),
      name: row.name,
      address: row.address || `${row.name}, ${district}, ${state}`,
      state,
      district,
      // The sheet's own town when it has one; otherwise the district, as the importer always did.
      city: row.city || district,
      pincode: pincode || pincodeFor(null, row.address),
      branchType: METRO_DISTRICTS.has(district) ? 'METRO' : 'URBAN',
      latitude: row.latitude,
      longitude: row.longitude,
      location: POINT(row.latitude, row.longitude),
      geoSource,
      geoAccuracyMeters: accuracy,
      geoMatchedName: geoSource === 'manual' ? 'Placed by hand' : null,
      geoResolvedAt: new Date(),
      organizationId: target.organizationId,
      clientId: target.clientId,
      zoneId: target.clientId ? await ctx.zoneFor(state) : null,
      region: resolveRegion(state),
      territory: `${district} Area`,
      managerName: fits(row.managerName, 200),
      phone: fits(row.phone, 20),
      email: fits(row.email, 255),
      // Risk is the project's priority, set once at creation; complexity and hours follow Packets.
      riskCategory: ctx.riskCategory,
      riskScore: riskScoreFromCategory(ctx.riskCategory),
      complexity: complexityFromPackets(packets),
      estimatedDurationHours: hours ?? 6.0,
      createdBy: userId,
      updatedBy: userId,
    };
    if (needsBetterFix(geoSource, accuracy)) plan.imprecise = impreciseReason(row.name, geoSource, accuracy);
  } else {
    const patch: BranchPatch = {};
    if (row.name && row.name !== existing.name) patch.name = row.name;
    if (row.address && row.address.trim() !== (existing.address ?? '').trim()) patch.address = row.address;
    if (state && upper(state) !== upper(existing.state)) patch.state = state;
    if (row.district && upper(row.district) !== upper(existing.district)) patch.district = row.district;
    if (pincode && pincode !== existing.pincode) patch.pincode = pincode;
    // Region follows the state, canonicalised; and a branch from before canonicalisation is repaired.
    const region = patch.state ? landing : existing.region ?? resolveRegion(existing.state);
    if (region && region !== existing.region) patch.region = region;

    // A new coordinate is written when it differs — and never over a hand-placed pin, unless it is
    // itself one (the rule `resolveCoordinates` keeps for every edit).
    if (row.latitude !== undefined && row.longitude !== undefined) {
      const differs = Number(existing.latitude) !== row.latitude || Number(existing.longitude) !== row.longitude;
      const allowed = row.geoSource === 'manual' || existing.geoSource !== 'manual';
      if (differs && allowed) {
        Object.assign(patch, {
          latitude: row.latitude,
          longitude: row.longitude,
          location: POINT(row.latitude, row.longitude),
          geoSource: row.geoSource ?? 'none',
          geoAccuracyMeters: row.geoAccuracyMeters ?? 500_000,
          geoMatchedName: row.geoSource === 'manual' ? 'Placed by hand' : null,
          geoResolvedAt: new Date(),
        });
        if (needsBetterFix(patch.geoSource!, patch.geoAccuracyMeters!)) {
          plan.imprecise = impreciseReason(row.name, patch.geoSource!, patch.geoAccuracyMeters!);
        }
      }
    }
    // The packet-derived fields follow the packets. Risk is never re-derived: it lives on the branch,
    // is shared by every project that audits it, and may have been raised by hand.
    if (hours !== null) {
      if (Number(existing.estimatedDurationHours) !== hours) patch.estimatedDurationHours = hours;
      const complexity = complexityFromPackets(packets);
      if (existing.complexity !== complexity) patch.complexity = complexity;
    }
    // The same geography check an edit gets, asked once per distinct place.
    if (patch.state !== undefined || patch.district !== undefined) {
      const refusal = await ctx.checkGeography(patch.state ?? existing.state ?? '', patch.district ?? existing.district ?? '', existing.city ?? '');
      if (refusal) return { refused: refusal };
    }
    plan.existing = { branchId: existing.id, zoneId: existing.zoneId, patch, restore: existing.isActive === false };
  }

  if (target.projectId) {
    const branchId = plan.existing?.branchId;
    const link = branchId ? ctx.linkByBranchId.get(branchId) : undefined;
    if (!link) {
      plan.link = { create: true, packetCount: packets, openAssessment: !branchId || !ctx.assessed.has(branchId) };
    } else if (packets !== null && link.packetCount !== packets) {
      plan.link = { create: false, linkId: link.id, packetCount: packets, openAssessment: false };
    }
  }

  return plan;
}

function fits(value: string | undefined, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function impreciseReason(name: string, geoSource: string, accuracyMeters: number): string {
  return geoSource === 'none'
    ? `"${name}" could not be located from its address yet — placed on a fallback point for now; a precise lookup is queued and runs in the background.`
    : `"${name}" placed to about ${Math.round(accuracyMeters / 1000)} km for now (${geoSource}); a precise lookup is queued and runs in the background.`;
}

/** Does this plan write anything? An unchanged, active, already-linked branch does not. */
export function planWrites(plan: PlannedRow): boolean {
  if (plan.create || plan.link) return true;
  return !!plan.existing && (plan.existing.restore || Object.keys(plan.existing.patch).length > 0);
}

/**
 * Write a chunk in one transaction; if it fails, write its rows one at a time so the bad row is
 * named and the rest land. Rows that write nothing are answered without a round trip.
 */
async function writeIsolating(
  chunk: PlannedRow[],
  input: CommitInput,
  store: CommitStore,
  skipped: BranchImportRowNote[],
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const writing: PlannedRow[] = [];
  for (const plan of chunk) {
    if (planWrites(plan)) writing.push(plan);
    else result.set(plan.rowNumber, plan.existing!.branchId);
  }
  if (writing.length === 0) return result;
  const base = { target: input.target, userId: input.userId, jobId: input.jobId };
  try {
    for (const [row, id] of await store.writeChunk({ ...base, rows: writing })) result.set(row, id);
    return result;
  } catch {
    for (const plan of writing) {
      try {
        for (const [row, id] of await store.writeChunk({ ...base, rows: [plan] })) result.set(row, id);
      } catch (err) {
        skipped.push({ row: plan.rowNumber, solId: plan.solId, reason: rowFailure(err, plan) });
      }
    }
    return result;
  }
}

/** What the person reads when the database refused one row. Never SQL, never a constraint name. */
export function rowFailure(err: unknown, plan: Pick<PlannedRow, 'solId'>): string {
  const code = (err as { code?: string; driverError?: { code?: string } })?.code
    ?? (err as { driverError?: { code?: string } })?.driverError?.code;
  if (code === '23505') {
    return `SOL ID ${plan.solId} was saved for this client by someone else while this import ran — run the import again to update it.`;
  }
  if (code === '22001') return 'A value in this row is too long to be stored.';
  if (code && /^\d{2}[0-9A-Z]{3}$/.test(code)) return 'The database refused this row. Check its values and import it again.';
  const message = (err as Error)?.message;
  return message && message.length < 300 && !/\b(INSERT|UPDATE|SELECT|constraint|relation)\b/i.test(message)
    ? message
    : 'This row could not be saved.';
}

function tally(
  plan: PlannedRow,
  branchId: string,
  counts: BranchImportCommitCounts,
  revived: BranchImportRowNote[],
  imprecise: BranchImportRowNote[],
  impreciseBranchIds: string[],
): void {
  if (plan.create) counts.created++;
  else if (plan.existing) {
    if (Object.keys(plan.existing.patch).length > 0) counts.updated++;
    else counts.unchanged++;
    if (plan.existing.restore) {
      counts.revived++;
      revived.push({ row: plan.rowNumber, solId: plan.solId, reason: `"${plan.name}" was archived and has been restored, because this file still lists it.` });
    }
  }
  if (plan.link?.create) counts.linked++;
  if (plan.imprecise) {
    imprecise.push({ row: plan.rowNumber, solId: plan.solId, reason: plan.imprecise });
    impreciseBranchIds.push(branchId);
  }
}
