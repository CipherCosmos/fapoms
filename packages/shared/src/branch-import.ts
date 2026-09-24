/**
 * FAPOMS — a branch list uploaded, rehearsed, reviewed by a person, then committed.
 *
 * ## The flow, and why it has two jobs
 *
 * A client's branch list (5,000 rows is ordinary) is uploaded once and becomes a background job of
 * kind `BRANCH_IMPORT`. The first run is a REHEARSAL: it reads the file, matches every row against
 * the branch master, fills gaps from the bank directories, places each new branch on the map and
 * writes nothing. It ends waiting for review, with the whole review — every row and what the server
 * made of it — stored on the server as that job's result file.
 *
 * The operator reviews it (fixes a state, pins a branch, removes the rows that belong to another
 * bank) and presses Commit. What travels back is NOT the rows: it is their DECISIONS — which rows
 * were removed, which fields they typed over, and whether to commit everything valid or only the
 * exactly-located rows. The commit job applies those decisions to the rehearsal the SERVER stored,
 * so a browser can correct a pincode but cannot invent a coordinate, a geo source or a region.
 *
 * Both sides read the rules below — which fields a person may edit, what makes a row ready — from
 * this one file, so the screen and the server can never disagree about which rows a commit writes.
 */

/** Warnings about a row that looks like it belongs to another bank. */
export interface ClientMismatchWarning {
  detectedBank?: string;
  detectedBankCode?: string;
  expectedBank: string;
  expectedBankCode?: string;
  reason: string;
  otherClientName?: string;
  otherClientId?: string;
  /** `critical` rows are never committed; `warning` rows are, with the warning shown. */
  severity: 'critical' | 'warning';
}

export type BranchReviewStatus = 'ready' | 'coarse' | 'needs_details';

/** One spreadsheet row, as the rehearsal understood it. */
export interface BranchReviewRow {
  /** The row's number in the spreadsheet as the person sees it (header row counted). */
  rowNumber: number;
  solId: string;
  name: string;
  address?: string;
  district?: string;
  state?: string;
  pincode?: string;
  /** The sheet's own town, when it has a column for one. */
  city?: string;
  packetCount?: number;
  /** Contact details the sheet (or the bank directory) carried. Not editable in the review. */
  managerName?: string;
  phone?: string;
  email?: string;
  latitude?: number;
  longitude?: number;
  geoSource?: string;
  geoAccuracyMeters?: number;
  existsInMaster: boolean;
  masterBranchId?: string;
  isArchivedInMaster?: boolean;
  status: BranchReviewStatus;
  missingFields: string[];
  suggestedDetails?: {
    district?: string;
    state?: string;
    address?: string;
    pincode?: string;
    phone?: string;
    bank?: string;
    branch?: string;
  };
  clientMismatch?: ClientMismatchWarning;
  /**
   * A NEW branch whose state and district the rehearsal could not verify against the geography
   * reference (the check an edit gets). The row needs attention until the person types a different
   * state or district; the commit checks whatever they typed again.
   */
  geographyProblem?: BranchGeographyProblem;
  warnings?: string[];
}

/** The state and district that failed the geography check, and the sentence it failed with. */
export interface BranchGeographyProblem {
  state: string;
  district: string;
  reason: string;
}

export interface BranchReviewSummary {
  totalRows: number;
  existingInMaster: number;
  newBranches: number;
  readyCount: number;
  coarseCount: number;
  needsDetailsCount: number;
  clientMismatchCount: number;
}

/** A row the rehearsal set aside before review — a repeated SOL ID, most often. */
export interface BranchImportRowNote {
  row: number;
  solId?: string;
  reason: string;
}

/** The whole rehearsal, stored as the rehearsal job's result file (`branch-review.json`). */
export interface BranchReviewReport {
  version: 1;
  summary: BranchReviewSummary;
  rows: BranchReviewRow[];
  /** Rows left out of the review, with why (e.g. "Duplicate of row 12"). */
  skipped: BranchImportRowNote[];
  /** Facts about the file rather than a row — chiefly a column heading nobody read. */
  notes: string[];
}

/** The fields a person may type over in the review. Everything else is the server's. */
export const BRANCH_REVIEW_EDITABLE_FIELDS = ['solId', 'name', 'state', 'district', 'address', 'pincode'] as const;
export type BranchReviewEditableField = (typeof BRANCH_REVIEW_EDITABLE_FIELDS)[number];

/**
 * What a person changed on one row. `latitude`/`longitude` only ever come from placing a pin by
 * hand, so the server records them as a manual pin — never as whatever geo source a caller names.
 */
export type BranchRowEdit = Partial<Record<BranchReviewEditableField, string>> & {
  latitude?: number;
  longitude?: number;
};

export type BranchCommitMode = 'all_valid' | 'ready_only';

/** What the review screen sends with Commit. */
export interface BranchImportDecisions {
  /** `all_valid`: every row that is not missing details; `ready_only`: only exactly located rows. */
  mode: BranchCommitMode;
  /** Rows the person removed from the upload, by `rowNumber`. */
  excluded: number[];
  /** What they changed, by `rowNumber` (as a string key, because JSON). */
  edits: Record<string, BranchRowEdit>;
}

/** The limits a stored field has. An edit longer than this is refused for that row, with a reason. */
export const BRANCH_REVIEW_FIELD_MAX: Record<BranchReviewEditableField, number> = {
  solId: 50,
  name: 255,
  state: 100,
  district: 100,
  address: 2000,
  pincode: 6,
};

/** Six digits, not starting with 0 — the Indian format. Blank is allowed (the address may carry one). */
export const INDIAN_PINCODE = /^[1-9][0-9]{5}$/;

/** The accuracy (metres) at or under which a placed branch counts as exactly located. */
export const BRANCH_READY_ACCURACY_METERS = 250;

/** Required fields a row is still missing. */
export function branchReviewMissingFields(row: Pick<BranchReviewRow, 'solId' | 'name' | 'state' | 'district' | 'address'>): string[] {
  const missing: string[] = [];
  if (!row.solId) missing.push('solId');
  if (!row.name) missing.push('name');
  if (!row.state) missing.push('state');
  if (!row.district) missing.push('district');
  if (!row.address) missing.push('address');
  return missing;
}

/**
 * Whether a row still carries the state and district the geography check refused. Changing either
 * clears it here; the commit checks the new pair itself.
 */
export function branchGeographyUnresolved(row: Pick<BranchReviewRow, 'state' | 'district' | 'geographyProblem'>): boolean {
  const p = row.geographyProblem;
  if (!p) return false;
  const norm = (v: string | null | undefined) => (v ?? '').trim().toUpperCase();
  return norm(row.state) === norm(p.state) && norm(row.district) === norm(p.district);
}

/**
 * The one rule for a row's readiness.
 *
 *  - needs_details: no SOL ID, no name or no state (unplannable), a critical bank mismatch, or a
 *                   state/district the geography check refused and nobody has corrected.
 *  - ready:         placed by hand, or placed to within 250 m.
 *  - coarse:        everything else — it imports, and a precise lookup follows in the background.
 */
export function branchReviewStatus(
  row: Pick<BranchReviewRow, 'solId' | 'name' | 'state' | 'district' | 'geoSource' | 'geoAccuracyMeters' | 'clientMismatch' | 'geographyProblem'>,
): BranchReviewStatus {
  if (!row.solId || !row.name || !row.state || row.clientMismatch?.severity === 'critical') return 'needs_details';
  if (branchGeographyUnresolved(row)) return 'needs_details';
  if (row.geoSource === 'manual') return 'ready';
  if (row.geoAccuracyMeters !== undefined && row.geoAccuracyMeters !== null && row.geoAccuracyMeters <= BRANCH_READY_ACCURACY_METERS) {
    return 'ready';
  }
  return 'coarse';
}

/** The row with its `missingFields` and `status` recomputed from what it now says. */
export function withBranchReviewStatus<T extends BranchReviewRow>(row: T): T {
  return { ...row, missingFields: branchReviewMissingFields(row), status: branchReviewStatus(row) };
}

export function summariseBranchReview(rows: BranchReviewRow[]): BranchReviewSummary {
  let existingInMaster = 0;
  let readyCount = 0;
  let coarseCount = 0;
  let needsDetailsCount = 0;
  let clientMismatchCount = 0;
  for (const r of rows) {
    if (r.existsInMaster) existingInMaster++;
    if (r.status === 'ready') readyCount++;
    else if (r.status === 'coarse') coarseCount++;
    else needsDetailsCount++;
    if (r.clientMismatch) clientMismatchCount++;
  }
  return {
    totalRows: rows.length,
    existingInMaster,
    newBranches: rows.length - existingInMaster,
    readyCount,
    coarseCount,
    needsDetailsCount,
    clientMismatchCount,
  };
}

/** Whether a row would be written by a commit in this mode (after its edits are applied). */
export function isBranchRowCommittable(row: BranchReviewRow, mode: BranchCommitMode): boolean {
  if (row.clientMismatch?.severity === 'critical') return false;
  return mode === 'ready_only' ? row.status === 'ready' : row.status !== 'needs_details';
}

export interface AppliedBranchDecisions {
  /** The rows to write, edits applied and status recomputed, in file order. */
  rows: BranchReviewRow[];
  /** Rows the person removed. */
  removed: BranchImportRowNote[];
  /** Rows not written, and why (still missing details, another bank, an edit that was refused). */
  left: BranchImportRowNote[];
  /** Row numbers whose address, district, state or pincode was edited (their placement is stale). */
  movedByEdit: Set<number>;
}

/**
 * Apply a review's decisions to the rows the SERVER stored. Used by the commit job; the review
 * screen uses the same function to say how many rows a commit will write.
 *
 * Only the editable fields and a hand-placed pin are taken from an edit; anything else a caller
 * puts in it is ignored. `isPlausibleCoordinate` is the server's own test of a pin (it knows where
 * India is); an implausible pin is refused for that row rather than written.
 */
export function applyBranchDecisions(
  stored: BranchReviewRow[],
  decisions: BranchImportDecisions,
  isPlausibleCoordinate: (lat: number, lng: number) => boolean = () => true,
): AppliedBranchDecisions {
  const excluded = new Set(decisions.excluded ?? []);
  const rows: BranchReviewRow[] = [];
  const removed: BranchImportRowNote[] = [];
  const left: BranchImportRowNote[] = [];
  const movedByEdit = new Set<number>();

  for (const original of stored) {
    if (excluded.has(original.rowNumber)) {
      removed.push({ row: original.rowNumber, solId: original.solId, reason: 'Removed from the upload in the review.' });
      continue;
    }
    const edit = decisions.edits?.[String(original.rowNumber)];
    let row: BranchReviewRow = { ...original };
    let refused: string | null = null;

    if (edit && typeof edit === 'object') {
      for (const field of BRANCH_REVIEW_EDITABLE_FIELDS) {
        const value = edit[field];
        if (value === undefined) continue;
        if (typeof value !== 'string') { refused = `The ${field} typed in the review was not text.`; break; }
        const trimmed = value.trim();
        if (trimmed.length > BRANCH_REVIEW_FIELD_MAX[field]) {
          refused = `The ${field} typed in the review is longer than ${BRANCH_REVIEW_FIELD_MAX[field]} characters.`;
          break;
        }
        if (field === 'pincode' && trimmed && !INDIAN_PINCODE.test(trimmed)) {
          refused = `"${trimmed}" is not a valid pincode — expected 6 digits.`;
          break;
        }
        if ((row[field] ?? '') !== trimmed) {
          (row as unknown as Record<string, unknown>)[field] = trimmed || undefined;
          if (field === 'address' || field === 'district' || field === 'state' || field === 'pincode') {
            movedByEdit.add(original.rowNumber);
          }
        }
      }
      if (!refused && (edit.latitude !== undefined || edit.longitude !== undefined)) {
        const lat = Number(edit.latitude);
        const lng = Number(edit.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !isPlausibleCoordinate(lat, lng)) {
          refused = 'The pin placed in the review is not a location in India.';
        } else {
          row = { ...row, latitude: lat, longitude: lng, geoSource: 'manual', geoAccuracyMeters: 5 };
          movedByEdit.delete(original.rowNumber);
        }
      }
    }

    if (refused) {
      left.push({ row: original.rowNumber, solId: row.solId || original.solId, reason: refused });
      continue;
    }

    row = withBranchReviewStatus(row);
    if (!isBranchRowCommittable(row, decisions.mode)) {
      left.push({
        row: row.rowNumber,
        solId: row.solId,
        reason: row.clientMismatch?.severity === 'critical'
          ? `Not written: ${row.clientMismatch.reason}`
          : row.status === 'needs_details' && row.missingFields.length === 0 && branchGeographyUnresolved(row)
            ? `Not written: ${row.geographyProblem!.reason}`
          : row.status === 'needs_details'
            ? `Not written: still missing ${row.missingFields.join(', ') || 'details'}.`
            : 'Not written: only exactly located branches were committed.',
      });
      continue;
    }
    rows.push(row);
  }
  return { rows, removed, left, movedByEdit };
}

/**
 * What the review screen sends: the difference between the rows the server stored and the rows on
 * screen. Rows are matched by `rowNumber`; a row missing from `edited` was removed.
 */
export function diffBranchDecisions(
  original: BranchReviewRow[],
  edited: BranchReviewRow[],
  mode: BranchCommitMode,
): BranchImportDecisions {
  const byRow = new Map(edited.map((r) => [r.rowNumber, r]));
  const excluded: number[] = [];
  const edits: Record<string, BranchRowEdit> = {};
  for (const before of original) {
    const after = byRow.get(before.rowNumber);
    if (!after) {
      excluded.push(before.rowNumber);
      continue;
    }
    const edit: BranchRowEdit = {};
    for (const field of BRANCH_REVIEW_EDITABLE_FIELDS) {
      const was = (before[field] ?? '').toString();
      const now = (after[field] ?? '').toString();
      if (was !== now) edit[field] = now;
    }
    if (after.geoSource === 'manual' && (after.latitude !== before.latitude || after.longitude !== before.longitude || before.geoSource !== 'manual')) {
      if (after.latitude !== undefined && after.longitude !== undefined) {
        edit.latitude = after.latitude;
        edit.longitude = after.longitude;
      }
    }
    if (Object.keys(edit).length > 0) edits[String(before.rowNumber)] = edit;
  }
  return { mode, excluded, edits };
}

/** What a committed branch import did — the counts on its result. */
export interface BranchImportCommitCounts {
  created: number;
  updated: number;
  unchanged: number;
  revived: number;
  linked: number;
  skipped: number;
  imprecise: number;
}

/** What the rehearsal's (small) result carries besides its sentence and counts. */
export interface BranchImportRehearsalDetails {
  phase: 'rehearse';
  summary: BranchReviewSummary;
  skippedBeforeReview: number;
  notes: string[];
}

/** What the commit's (small) result carries. Full lists are in its report file. */
export interface BranchImportCommitDetails {
  phase: 'commit';
  /** The first few rows not written, with why. The whole list is in the report file. */
  skipped: BranchImportRowNote[];
  imprecise: BranchImportRowNote[];
  revived: BranchImportRowNote[];
}
