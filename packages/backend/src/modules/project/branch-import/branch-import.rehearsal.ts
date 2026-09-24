/**
 * FAPOMS — the branch-import REHEARSAL: read the file, understand every row, write nothing.
 *
 * This is the old synchronous "reconcile" preview, moved into a background job and made fast.
 *
 * ## Where the time went, and what changed
 *
 * The preview asked the outside world a question per row, in order: an IFSC lookup for EVERY row
 * (whenever the sheet lacked a pincode column, or had an IFSC column at all — even with the state,
 * district and address all present), then India Post, then the geocoder. On 5,000 rows that is
 * tens of minutes, most of it the same question asked again.
 *
 * Now:
 *  - A row is matched against the branch master first, from one query for the whole file; a known
 *    branch fills its own gaps and usually needs nothing from outside.
 *  - The IFSC directory is asked only for a row still missing its state, district or address — the
 *    only thing its answer is used for (the bank-mismatch checks that matter are made offline).
 *  - India Post is asked only for a row still missing its state or district, once per distinct
 *    pincode. The geocoder is asked once per distinct place (see `geocodeKey`).
 *  - Each of those runs a few at a time (`LOOKUP_CONCURRENCY`) rather than one after another.
 *
 * What the preview decided is otherwise unchanged — the same hydration from the master, the same
 * five bank-mismatch angles, the same readiness rule (now shared with the review screen).
 *
 * Two things are new, both from the queued importer the preview never learned from: a SOL ID
 * repeated in the file is set aside and named (it used to be two review rows racing for one
 * branch), and row numbers count the header row where the sheet really has it.
 */

import {
  branchReviewMissingFields,
  branchReviewStatus,
  INDIAN_PINCODE,
  resolveRegion,
  summariseBranchReview,
  type BranchGeographyProblem,
  type BranchImportRowNote,
  type BranchReviewReport,
  type BranchReviewRow,
  type ClientMismatchWarning,
} from '@fapoms/shared';
import type { ParsedSheet } from '../../../core/excel/sheet-reader';
import { parseLocationInput } from '../../geo/coordinate-resolution';
import { inferIfscFromSolId, resolveBankCode, type IfscLookupResult } from '../../geo/ifsc-lookup.helper';
import type { PincodeLookupResult } from '../../geo/pincode-lookup.helper';
import {
  isBlankBranchRow,
  readBranchRow,
  sheetRowNumber,
  unrecognisedColumnNotes,
  type BranchSheetRow,
} from './branch-sheet';
import { lookupEachOnce } from './lookup-pool';
import {
  LOOKUP_CONCURRENCY,
  type BranchImportHooks,
  type BranchImportLookups,
  type BranchImportTarget,
  type GeoFix,
  type GeocodeRequest,
  type MasterBranch,
  type OtherClientBranch,
} from './branch-import.types';

/** The reads the rehearsal makes — two queries for the whole file, and the geography check. */
export interface RehearsalReads {
  /** This client's branches with these SOL IDs, archived ones included. */
  masterBySol(solIds: string[]): Promise<MasterBranch[]>;
  /** Other clients' branches with these SOL IDs. */
  otherClientsBySol(solIds: string[]): Promise<OtherClientBranch[]>;
  /**
   * Throws (with a sentence) when the state/district/city cannot be verified — `BranchService`'s
   * rule, the same one the commit asks of a known branch whose state or district changes.
   */
  validateGeography(state: string, district: string, city: string): Promise<void>;
}

export interface RehearsalOutcome {
  report: BranchReviewReport;
  /** Every region the rows would write into or already sit in — checked against the requester. */
  regions: Set<string>;
  /** How many distinct questions each directory was asked. */
  lookups: { ifsc: number; pincode: number; geocode: number; geography: number };
}

interface Draft {
  rowNumber: number;
  raw: BranchSheetRow;
  solId: string;
  name: string;
  district: string;
  state: string;
  address: string;
  pincode: string;
  existing?: MasterBranch;
  latitude?: number;
  longitude?: number;
  geoSource?: string;
  geoAccuracyMeters?: number;
  /** The sheet gave a coordinate (a maps link or a lat/lng pair). */
  sheetPlaced: boolean;
  /** A known branch whose address, district or state this file changes. */
  moved: boolean;
  mismatch?: ClientMismatchWarning;
  geographyProblem?: BranchGeographyProblem;
  warnings: string[];
  ifscCode: string | null;
  ifsc?: IfscLookupResult | null;
  suggested?: BranchReviewRow['suggestedDetails'];
}

const upper = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();
const sameText = (a: string | null | undefined, b: string | null | undefined) => upper(a) === upper(b);

/** The pincode the geocoder should use: the column's, else one written inside the address. */
export function pincodeFor(pincode: string | null | undefined, address: string | null | undefined): string | null {
  const own = (pincode ?? '').trim();
  if (INDIAN_PINCODE.test(own)) return own;
  return (address ?? '').match(/\b[1-9]\d{5}\b/)?.[0] ?? null;
}

/**
 * The city a new branch's geography is checked with: the sheet's own town, else the district —
 * the city the commit creates it with (`city: row.city || district`).
 */
export function geographyCity(city: string | null | undefined, district: string): string {
  return (city ?? '').trim() || upper(district);
}

/**
 * Two rows that would get the same answer from the geocoder are one question.
 *
 * In bulk the geocoder takes only its fast tiers. Without a Google key those answer from the
 * pincode, then the district, then the state — the street address is not consulted — so every
 * branch in one pincode of one district is a single lookup. With a key the address matters, and is
 * part of the question.
 */
export function geocodeKey(request: GeocodeRequest, usesAddress: boolean): string {
  const parts = usesAddress
    ? [request.address, request.name, request.district, request.state, request.pincode ?? '']
    : [request.pincode ?? '', request.district, request.state];
  return parts.map((p) => upper(p).replace(/\s+/g, ' ')).join('|');
}

export async function rehearseBranchImport(
  sheet: ParsedSheet,
  target: BranchImportTarget,
  reads: RehearsalReads,
  lookups: BranchImportLookups,
  hooks: BranchImportHooks,
): Promise<RehearsalOutcome> {
  const askedFor = new Set<string>();
  const skipped: BranchImportRowNote[] = [];
  const firstRowForSol = new Map<string, number>();
  const candidates: Array<{ rowNumber: number; raw: BranchSheetRow }> = [];

  // ── Pass 1: the file alone. Pure, milliseconds even for thousands of rows. ─────────────────
  await hooks.progress(0, sheet.rows.length, 'Reading the file');
  for (let index = 0; index < sheet.rows.length; index++) {
    const raw = readBranchRow(sheet.rows[index], askedFor);
    if (isBlankBranchRow(raw)) continue;
    const rowNumber = sheetRowNumber(sheet, index);
    const solKey = upper(raw.solId);
    if (solKey) {
      const first = firstRowForSol.get(solKey);
      if (first !== undefined) {
        // Same SOL ID twice in one file: keep the first, name the collision. Two review rows for one
        // branch would otherwise both be written, the later over the earlier.
        skipped.push({ row: rowNumber, solId: raw.solId, reason: `Duplicate of row ${first} (SOL ID ${raw.solId}) — the first row was kept.` });
        continue;
      }
      firstRowForSol.set(solKey, rowNumber);
    }
    candidates.push({ rowNumber, raw });
  }
  const notes = unrecognisedColumnNotes(sheet, askedFor);
  const total = candidates.length;

  // ── Pass 2: the branch master, in two queries for the whole file. ───────────────────────────
  await hooks.throwIfCancelled();
  await hooks.progress(0, total, `Matching ${total.toLocaleString('en-IN')} rows against the branch master`);
  const sols = candidates.map((c) => c.raw.solId).filter(Boolean);
  const [master, others] = sols.length
    ? await Promise.all([reads.masterBySol(sols), reads.otherClientsBySol(sols)])
    : [[], []];
  const masterBySol = new Map<string, MasterBranch>();
  for (const b of master) if (b.solId) masterBySol.set(upper(b.solId), b);
  const othersBySol = new Map<string, OtherClientBranch[]>();
  for (const b of others) {
    if (!b.solId || (target.clientId && b.clientId === target.clientId)) continue;
    const k = upper(b.solId);
    othersBySol.set(k, [...(othersBySol.get(k) ?? []), b]);
  }

  const drafts: Draft[] = candidates.map(({ rowNumber, raw }) => draftFrom(rowNumber, raw, masterBySol.get(upper(raw.solId)), target));
  await hooks.progress(total, total);

  // ── Pass 3: the IFSC directory, only where a row still lacks what it would supply. ──────────
  await hooks.throwIfCancelled();
  const needIfsc = drafts.filter((d) => d.ifscCode && (!d.state || !d.district || !d.address));
  const ifscCodes = new Set(needIfsc.map((d) => d.ifscCode!));
  let ifscAnswers = new Map<string, IfscLookupResult | null>();
  if (ifscCodes.size > 0) {
    const stage = `Looking up ${ifscCodes.size.toLocaleString('en-IN')} bank branches`;
    await hooks.progress(0, ifscCodes.size, stage);
    ifscAnswers = await lookupEachOnce(ifscCodes, (code) => lookups.ifsc(target.clientName, code), {
      concurrency: LOOKUP_CONCURRENCY.ifsc,
      checkpoint: () => hooks.throwIfCancelled(),
      onAnswered: (n, of) => hooks.progress(n, of, stage),
    });
  }
  for (const d of needIfsc) applyIfsc(d, ifscAnswers.get(d.ifscCode!) ?? null, target);
  for (const d of drafts) applyOfflineMismatchChecks(d, target, othersBySol);

  // ── Pass 4: India Post, only where the state or district is still unknown. ─────────────────
  await hooks.throwIfCancelled();
  const needPin = drafts.filter((d) => (!d.state || !d.district) && INDIAN_PINCODE.test(d.pincode.trim()));
  const pins = new Set(needPin.map((d) => d.pincode.trim()));
  let pinAnswers = new Map<string, PincodeLookupResult | null>();
  if (pins.size > 0) {
    const stage = `Checking ${pins.size.toLocaleString('en-IN')} pincodes`;
    await hooks.progress(0, pins.size, stage);
    pinAnswers = await lookupEachOnce(pins, (pin) => lookups.pincode(pin), {
      concurrency: LOOKUP_CONCURRENCY.pincode,
      checkpoint: () => hooks.throwIfCancelled(),
      onAnswered: (n, of) => hooks.progress(n, of, stage),
    });
  }
  for (const d of needPin) {
    const place = pinAnswers.get(d.pincode.trim());
    if (!place) continue;
    d.suggested = { ...(d.suggested ?? {}) };
    if (!d.suggested.state) d.suggested.state = place.state;
    if (!d.suggested.district) d.suggested.district = place.district;
    if (!d.state) d.state = place.state;
    if (!d.district) d.district = place.district;
  }

  // ── Pass 4½: the geography check, for a NEW branch, once per distinct place. ────────────────
  // A known branch whose state or district moves is checked at commit (it may be only a patch); a
  // new branch is checked here, while the person can still correct it. A place that fails leaves
  // the row needing attention with the reason, until its state or district is typed over — and
  // the commit checks the new pair again, so a correction that is still wrong is skipped, named.
  await hooks.throwIfCancelled();
  const needPlaceCheck = new Map<Draft, { key: string; state: string; district: string; city: string }>();
  for (const d of drafts) {
    if (d.existing || !d.state.trim()) continue;
    const state = d.state.trim();
    const district = d.district.trim();
    const city = geographyCity(d.raw.city, district);
    needPlaceCheck.set(d, { key: [state, district, city].map(upper).join('|'), state, district, city });
  }
  const placesByKey = new Map<string, { state: string; district: string; city: string }>();
  for (const place of needPlaceCheck.values()) if (!placesByKey.has(place.key)) placesByKey.set(place.key, place);
  let placeVerdicts = new Map<string, string | null>();
  if (placesByKey.size > 0) {
    const stage = `Checking ${placesByKey.size.toLocaleString('en-IN')} places`;
    await hooks.progress(0, placesByKey.size, stage);
    placeVerdicts = await lookupEachOnce(placesByKey.keys(), async (key) => {
      const { state, district, city } = placesByKey.get(key)!;
      try {
        await reads.validateGeography(state, district, city);
        return null;
      } catch (err) {
        return (err as Error)?.message || 'The state and district could not be verified.';
      }
    }, {
      concurrency: LOOKUP_CONCURRENCY.geography,
      checkpoint: () => hooks.throwIfCancelled(),
      onAnswered: (n, of) => hooks.progress(n, of, stage),
    });
  }
  for (const [d, { key, state, district }] of needPlaceCheck) {
    const reason = placeVerdicts.get(key);
    if (!reason) continue;
    d.geographyProblem = { state, district, reason };
    d.warnings.push(`${reason} Correct the state or district here, or this row will be skipped.`);
  }

  // ── Pass 5: the geocoder, once per distinct place. ─────────────────────────────────────────
  await hooks.throwIfCancelled();
  const needGeo = new Map<Draft, { key: string; request: GeocodeRequest }>();
  for (const d of drafts) {
    if (!d.state) continue;
    const unplaced = d.latitude === undefined || d.longitude === undefined;
    // A known branch this file moves is placed again — unless someone pinned it by hand, which no
    // file overrides (the same rule `resolveCoordinates` keeps for an edit).
    const replace = d.moved && !d.sheetPlaced && d.existing?.geoSource !== 'manual';
    if (!unplaced && !replace) continue;
    const request: GeocodeRequest = {
      address: d.address || `${d.name}, ${d.district}, ${d.state}`,
      name: d.name,
      district: d.district,
      state: d.state,
      pincode: pincodeFor(d.pincode, d.address),
    };
    needGeo.set(d, { key: geocodeKey(request, lookups.geocodeUsesAddress), request });
  }
  const requestsByKey = new Map<string, GeocodeRequest>();
  for (const { key, request } of needGeo.values()) if (!requestsByKey.has(key)) requestsByKey.set(key, request);
  let geoAnswers = new Map<string, GeoFix | null>();
  if (requestsByKey.size > 0) {
    const stage = `Locating ${requestsByKey.size.toLocaleString('en-IN')} addresses`;
    await hooks.progress(0, requestsByKey.size, stage);
    geoAnswers = await lookupEachOnce(requestsByKey.keys(), (key) => lookups.geocode(requestsByKey.get(key)!), {
      concurrency: LOOKUP_CONCURRENCY.geocode,
      checkpoint: () => hooks.throwIfCancelled(),
      onAnswered: (n, of) => hooks.progress(n, of, stage),
    });
  }
  for (const [d, { key }] of needGeo) {
    const fix = geoAnswers.get(key);
    if (!fix) continue;
    d.latitude = fix.lat;
    d.longitude = fix.lng;
    d.geoSource = fix.geoSource;
    d.geoAccuracyMeters = fix.geoAccuracyMeters;
  }

  // ── The review. ────────────────────────────────────────────────────────────────────────────
  await hooks.progress(total, total, 'Preparing the review');
  const regions = new Set<string>();
  const rows = drafts.map((d) => {
    const region = resolveRegion(d.state);
    if (region) regions.add(region);
    if (d.existing?.region) regions.add(d.existing.region);
    return toReviewRow(d);
  });

  return {
    report: { version: 1, summary: summariseBranchReview(rows), rows, skipped, notes },
    regions,
    lookups: { ifsc: ifscCodes.size, pincode: pins.size, geocode: requestsByKey.size, geography: placesByKey.size },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

function draftFrom(rowNumber: number, raw: BranchSheetRow, existing: MasterBranch | undefined, target: BranchImportTarget): Draft {
  const d: Draft = {
    rowNumber,
    raw,
    solId: raw.solId,
    name: raw.name,
    district: raw.district,
    state: raw.state,
    address: raw.address,
    pincode: raw.pincode,
    existing,
    sheetPlaced: false,
    moved: false,
    warnings: [],
    ifscCode: raw.ifsc || (raw.solId ? inferIfscFromSolId(target.clientName, raw.solId) : null),
  };

  // A known branch fills the gaps a sparse correction sheet leaves.
  if (existing) {
    d.moved =
      (!!raw.address && raw.address.trim() !== (existing.address ?? '').trim()) ||
      (!!raw.district && !sameText(raw.district, existing.district)) ||
      (!!raw.state && !sameText(raw.state, existing.state));
    if (!d.name && existing.name) d.name = existing.name;
    if (!d.state && existing.state) d.state = existing.state;
    if (!d.district && existing.district) d.district = existing.district;
    if (!d.address && existing.address) d.address = existing.address;
    if (!d.pincode && existing.pincode) d.pincode = existing.pincode;
    if (existing.latitude !== null && existing.longitude !== null && existing.latitude !== undefined && existing.longitude !== undefined) {
      d.latitude = Number(existing.latitude);
      d.longitude = Number(existing.longitude);
      d.geoSource = existing.geoSource || 'manual';
      d.geoAccuracyMeters = existing.geoAccuracyMeters ?? 10;
    }
  }

  // A coordinate the sheet itself carries: a maps link / DMS pair counts as placed by hand, a bare
  // Latitude/Longitude pair as a geocoder-grade fix. A bare pair never overrides a hand-placed pin.
  const link = raw.location ? parseLocationInput(raw.location) : null;
  if (link) {
    Object.assign(d, { latitude: link.lat, longitude: link.lng, geoSource: 'manual', geoAccuracyMeters: 5, sheetPlaced: true });
  } else {
    const lat = parseFloat(raw.latitude);
    const lng = parseFloat(raw.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      if (existing?.geoSource === 'manual') {
        d.warnings.push('The sheet\'s Latitude/Longitude were not used: this branch was pinned by hand.');
      } else {
        Object.assign(d, { latitude: lat, longitude: lng, geoSource: 'geocoder', geoAccuracyMeters: 60, sheetPlaced: true });
      }
    }
  }

  // Angle A: the row names another bank outright.
  if (raw.bank && target.bankCode) {
    const rowBank = resolveBankCode(raw.bank);
    if (rowBank && rowBank !== target.bankCode) {
      flag(d, {
        detectedBank: raw.bank,
        detectedBankCode: rowBank,
        expectedBank: target.clientName,
        expectedBankCode: target.bankCode,
        reason: `Row specifies bank '${raw.bank}' (${rowBank}), which does not match target client '${target.clientName}' (${target.bankCode}).`,
        severity: 'critical',
      });
    }
  }
  // Angle B: the IFSC's own bank prefix.
  if (!d.mismatch && raw.ifsc && target.bankCode) {
    const clean = raw.ifsc.trim().toUpperCase();
    if (/^[A-Z]{4}/.test(clean) && clean.substring(0, 4) !== target.bankCode) {
      const code = clean.substring(0, 4);
      flag(d, {
        detectedBank: code,
        detectedBankCode: code,
        expectedBank: target.clientName,
        expectedBankCode: target.bankCode,
        reason: `IFSC '${clean}' bank code '${code}' does not match target client '${target.clientName}' (${target.bankCode}).`,
        severity: 'critical',
      });
    }
  }
  return d;
}

function flag(d: Draft, mismatch: ClientMismatchWarning, record = true): void {
  d.mismatch = mismatch;
  if (record) d.warnings.push(mismatch.reason);
}

function applyIfsc(d: Draft, found: IfscLookupResult | null, target: BranchImportTarget): void {
  d.ifsc = found;
  if (!found) return;
  d.suggested = {
    district: found.district ?? undefined,
    state: found.state ?? undefined,
    address: found.address ?? undefined,
    pincode: found.pincode ?? undefined,
    phone: found.phone ?? undefined,
    bank: found.bankName,
    branch: found.branchName,
  };
  // Angle C: the directory says this branch is another bank's.
  if (!d.mismatch && found.bankCode && target.bankCode && found.bankCode !== target.bankCode) {
    flag(d, {
      detectedBank: found.bankName,
      detectedBankCode: found.bankCode,
      expectedBank: target.clientName,
      expectedBankCode: target.bankCode,
      reason: `IFSC directory confirmed this branch is '${found.bankName}' (${found.bankCode}), not '${target.clientName}' (${target.bankCode}).`,
      severity: 'critical',
    });
  }
  // Never fill a row from a directory that says it is another bank's branch.
  if (d.mismatch?.severity === 'critical') return;
  if (!d.state && found.state) d.state = found.state;
  if (!d.district && found.district) d.district = found.district;
  if (!d.address && found.address) d.address = found.address;
  if (!d.pincode && found.pincode) d.pincode = found.pincode;
}

function applyOfflineMismatchChecks(d: Draft, target: BranchImportTarget, othersBySol: Map<string, OtherClientBranch[]>): void {
  // Angle D: the branch's own name mentions another bank.
  if (!d.mismatch && d.name && target.bankCode) {
    const named = resolveBankCode(d.name);
    if (named && named !== target.bankCode) {
      flag(d, {
        detectedBank: d.name,
        detectedBankCode: named,
        expectedBank: target.clientName,
        expectedBankCode: target.bankCode,
        reason: `Branch name '${d.name}' refers to another bank (${named}) instead of '${target.clientName}' (${target.bankCode}).`,
        severity: 'critical',
      });
    }
  }
  // Angle E: another client already holds this SOL ID.
  const other = othersBySol.get(upper(d.solId))?.[0];
  if (other) {
    const otherName = other.clientName || 'another client';
    const message = `SOL ID '${d.solId}' is already registered in master DB under client '${otherName}' (Branch: '${other.name}').`;
    d.warnings.push(message);
    const otherBank = resolveBankCode(otherName);
    if (!d.mismatch && otherBank && target.bankCode && otherBank !== target.bankCode) {
      flag(d, {
        detectedBank: otherName,
        detectedBankCode: otherBank,
        expectedBank: target.clientName,
        expectedBankCode: target.bankCode,
        otherClientName: otherName,
        otherClientId: other.clientId || undefined,
        reason: message,
        severity: 'warning',
      }, false);
    }
  }
}

function toReviewRow(d: Draft): BranchReviewRow {
  const packets = parseInt(d.raw.packets, 10);
  if (d.pincode && !INDIAN_PINCODE.test(d.pincode.trim())) {
    // Said now, while it can be corrected; the commit refuses the row otherwise (see planRow).
    d.warnings.push(`"${d.pincode}" is not a valid pincode — expected 6 digits. Correct it here, or this row will be skipped.`);
  }
  const row: BranchReviewRow = {
    rowNumber: d.rowNumber,
    solId: d.solId,
    name: d.name,
    address: d.address || undefined,
    district: d.district || undefined,
    state: d.state || undefined,
    pincode: d.pincode || undefined,
    city: d.raw.city || undefined,
    packetCount: Number.isFinite(packets) && packets > 0 ? packets : undefined,
    managerName: d.raw.managerName || undefined,
    phone: d.raw.phone || d.ifsc?.phone || undefined,
    email: d.raw.email || undefined,
    latitude: d.latitude,
    longitude: d.longitude,
    geoSource: d.geoSource,
    geoAccuracyMeters: d.geoAccuracyMeters,
    existsInMaster: !!d.existing,
    masterBranchId: d.existing?.id,
    isArchivedInMaster: d.existing ? !d.existing.isActive : undefined,
    status: 'needs_details',
    missingFields: [],
    suggestedDetails: d.suggested,
    clientMismatch: d.mismatch,
    geographyProblem: d.geographyProblem,
    warnings: d.warnings.length ? d.warnings : undefined,
  };
  row.missingFields = branchReviewMissingFields(row);
  row.status = branchReviewStatus(row);
  return row;
}
