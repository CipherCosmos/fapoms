import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import {
  AssayerLifecycleStatus, DocumentVerification, EmpanelmentStatus, businessTodayDateKey, PLACEHOLDER_PIN_METRES, hasLeftWorkforce,
  DOCUMENT_REJECTION_LABELS, DocumentRejectionReason, ONBOARDING_DOCUMENT_LABELS, OnboardingDocument,
  normalisePhone,
} from '@fapoms/shared';
import { isAddressUsable } from '../geo/indian-address';
import { AssayerEntity } from './assayer.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';

/**
 * The standing data-integrity scan over the appraiser roster.
 *
 * The roster arrived from years of hand-kept spreadsheets, and some of what it says cannot be
 * true: a leaving date in the year 5481, a date of birth that makes somebody two years old, a
 * resignation with no date, one PAN on two records. None of that is repairable by code — which
 * of two dates is wrong, or whose PAN it really is, only a person with the paper file can say —
 * so nothing here writes to an appraiser row, ever. Each defect becomes one row in
 * `assayer_import_issues`, the queue the HR review panel already reads, where it waits for a
 * decision and closes itself the moment the record is corrected.
 *
 * Why that queue and not a new table: it is the only defect surface that reaches a human (the
 * panel, the list/resolve endpoints), its semantics already match (kept until decided, resolved
 * never deleted, refuses a resolution with no written account), and one queue per concern is the
 * house rule. The cost is spreadsheet-shaped column names, which the key below repurposes.
 *
 * ## The key — how a finding stays the same finding across runs
 *
 * The table is UNIQUE on (source_sheet, source_row, source_column) — the constraint lives in
 * migration 1792400000000-OneIssuePerCell, not on the entity, which is why every write here is
 * an explicit lookup-then-write rather than an upsert helper. The scan maps onto it:
 *
 *   - `source_sheet`  = 'Data integrity', a constant no real sheet uses (live sheets are
 *                       'Assayers', 'Corrected') — it is also the auto-close scope, so importer
 *                       rows can never be touched by this service.
 *   - `source_column` = '<check title> · <appraiser code>' (title alone for the two aggregate
 *                       checks). Titles are identity: reword one and every open finding of that
 *                       check is orphaned and re-raised. They are pinned at ≤ 45 characters so
 *                       the column (45 + 3 + a ≤ 50-char code = 98) can never overflow
 *                       varchar(120) and be truncated into a collision — the spec asserts it.
 *   - `source_row`    = the generation: 0 normally, +1 only when a HUMAN-resolved finding's
 *                       facts change afterwards (see the write algorithm on `writeFinding`).
 *   - `raw_value`     = the offending values themselves — two appraiser codes for a duplicate,
 *                       never the shared PAN/Aadhaar/account (this queue is rendered on screen
 *                       and grouped by that text; the importer set that policy first).
 *
 * ## Zero false positives — the boundaries, measured against the live roster
 *
 * Every threshold below was checked against the production database before it was chosen. When
 * it was, the roster still held its imported corruption: zero joining or exit dates fell between
 * today and today + 5 years, because every future date in the table was year 3009 or later, so
 * the five-year window could not clip a scheduled joiner or a notice period; and a corrupt date
 * (year 4032) was reported once as a corrupt date, never a second time as an impossible age or
 * half of a lifecycle contradiction.
 *
 * `scripts/repair-corrupt-dates.js` has since blanked all 159 of those values, so the roster now
 * holds no date outside 1900 … today + 2 and checks 1 and 2's inputs are all real dates. The
 * window is kept at five years anyway: it is the bound that made the checks safe against the
 * data as imported, and the next import can reintroduce exactly what it removed.
 */

/**
 * Check titles. IDENTITY — a finding is keyed on its title, so rewording one orphans every
 * open row of that check and raises the whole check again as "new". Add, never rename.
 * Held to ≤ 45 characters so `source_column` (title + ' · ' + code) fits varchar(120).
 */
export const CHECK_TITLES = {
  corruptDate: 'Date that is not a real date',
  joinedAfterLeft: 'Joined after they left',
  leftNoDate: 'Left with no leaving date',
  leavingButActive: 'Leaving date but still active',
  leftButEmpanelled: 'Left but still empanelled',
  noRegion: 'No region on the record',
  impossibleAge: 'Date of birth gives an impossible age',
  noDob: 'No date of birth',
  duplicatePan: 'Duplicate PAN',
  duplicateAadhaar: 'Duplicate Aadhaar',
  duplicateBank: 'Duplicate bank account',
  duplicatePhone: 'Duplicate phone',
  duplicateEmail: 'Duplicate email',
  noCoordinates: 'No home location on the map',
  placeholderPin: 'Home pin is a placeholder, not a home',
  blankAddress: 'No home address on the record',
  unusableAddress: 'Home address has no place a map can find',
  identityRejected: 'Identity document sent back, not replaced',
  noPhotograph: 'No photograph on the record',
  noPhone: 'No phone number on the record',
  claimedNoScan: 'Ticked as received, but no scan was kept',
  docsNeverVerified: 'Documents received but never verified',
} as const;

/** The sheet name that scopes every row this service writes — and the only sheet it closes. */
export const DATA_INTEGRITY_SHEET = 'Data integrity';

/**
 * The auto-close account. `resolved_by` stays NULL and `updated_by` says SYSTEM (the actor
 * convention the billing reconcile sweep uses), so a machine's closure can never be mistaken
 * for a person's decision — and `writeFinding` reopens over it if the defect ever returns.
 */
/**
 * States the fact, not a cause the scan cannot know.
 *
 * This read "No longer true — the record was corrected." A finding stops being claimed for two
 * different reasons, and only one of them is a correction: the data was fixed, OR the check itself
 * stopped asking about that record. The second is not hypothetical — narrowing the three
 * "go and fill this in" checks to people still on the roster closed 34 findings in one tick, every
 * one of them stamped with a correction that nobody had made. An auto-close is already the one
 * place a machine writes into a queue of human decisions; it must not put a false account of
 * events on the record while doing it.
 */
export const AUTO_CLOSE_RESOLUTION =
  'Closed automatically — this no longer shows up in the check. Either the record was corrected, '
  + 'or it is no longer something this check asks about.';

const SYSTEM_ACTOR = 'SYSTEM';

// `PLACEHOLDER_PIN_METRES` is imported from `@fapoms/shared` rather than declared here: the same
// threshold decides whether this scan raises "Home pin is a placeholder, not a home" AND whether
// `missingAssayerRecordFields` counts Map location as a gap. Two copies would let a record be
// complete on the roster and defective in this queue at the same time.

/**
 * Importer columns that already queue the same real-world defect this scan would find.
 * A pair the importer has queued — resolved or not — is one clerk decision; writing it again
 * under a second key doubles the work and splits the paper trail. The scan still keeps its own
 * duplicate checks because the importer only sees duplicates *within one file*: a duplicate
 * made by hand-editing two records, or across two imports, is invisible to it.
 */
const IMPORTER_DUPLICATE_COLUMNS = ['Duplicate PAN', 'Duplicate phone', 'Duplicate email'] as const;

/** The importer's key for "exit date on an Active row" (roster-import.service.ts ~764-771). */
const IMPORTER_EXIT_DATE_COLUMN = 'Exit Date';

interface DuplicateKind {
  title: string;
  word: string;
  value: (p: Pick<AssayerEntity, 'panNumber' | 'aadhaarNumber' | 'bankAccountNumber' | 'phone' | 'email'>) => string | null;
  importerColumn: string | null;
  note: string;
}

interface Finding {
  title: string;
  /** Appraiser code for per-person findings; null for the two aggregate checks. */
  suffix: string | null;
  rawValue: string;
  reason: string;
  assayerId: string | null;
  sourceAssayerCode: string | null;
}

export interface DataIntegrityScanSummary {
  /** Findings computed this run (suppressed ones excluded — they are the importer's rows). */
  findings: number;
  /** Brand-new rows written at generation 0. */
  inserted: number;
  /** New generations cut because a resolved finding's facts changed afterwards. */
  reopened: number;
  /** Open rows whose raw_value/reason were refreshed in place. */
  updated: number;
  /** Open rows already saying exactly this — nothing written. */
  unchanged: number;
  /** Findings a human already resolved on the same facts — left resolved. */
  skippedResolved: number;
  /** Findings the importer already queues — never written at all. */
  suppressed: number;
  /** Open rows on this sheet whose defect is gone from the live data — closed by SYSTEM. */
  autoClosed: number;
}

// ── Dates ─────────────────────────────────────────────────────────────────────
// Postgres hydrates `date` columns as 'YYYY-MM-DD' strings through TypeORM; fixtures and other
// drivers hand over Date objects. Both shapes must read identically, and comparison has to
// survive the very values this scan exists to find — year 5481 sorts fine as a string, but a
// five-digit year ('10000-01-01') would not, so everything compares as a number, never as text.

type Dateish = Date | string | null | undefined;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Normalise to 'YYYY-MM-DD' (year kept at whatever width it really has), or null. */
function isoDay(value: Dateish): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // LOCAL components, never toISOString(): the `pg` driver hands a DATE column back as a
    // Date at local midnight, and toISOString() re-reads that in UTC — in IST (+05:30) every
    // such date came out one day early ('5301-01-01' reported as "misread as 5300-12-31").
    // The local fields are the fields the driver set, so they are right in every timezone.
    const y = String(value.getFullYear()).padStart(4, '0');
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const m = /^(\d{4,7})-(\d{2})-(\d{2})/.exec(String(value).trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ── Grouping appraiser codes ──────────────────────────────────────────────────
// Union-find over the importer's duplicate pairs, so "are these two already connected?" can be
// asked without caring how either side chose to partition the group. Groups here are two or three
// codes; the path compression is for tidiness, not speed.

/** The representative of `code`'s group, compressing the path it walked to get there. */
function find(parent: Map<string, string>, code: string): string {
  let root = code;
  for (let next = parent.get(root); next != null && next !== root; next = parent.get(root)) root = next;
  for (let walk = code; walk !== root;) {
    const next = parent.get(walk) ?? root;
    parent.set(walk, root);
    walk = next;
  }
  return root;
}

/** Put both codes in one group. */
function union(parent: Map<string, string>, a: string, b: string): void {
  const rootA = find(parent, a);
  const rootB = find(parent, b);
  // Both codes must be present as keys even when they are already joined, or `find` on a code
  // that only ever appeared as a root would report a group this map does not actually know.
  if (!parent.has(a)) parent.set(a, rootA);
  if (!parent.has(b)) parent.set(b, rootB);
  if (rootA !== rootB) parent.set(rootA, rootB);
}

/** yyyymmdd as a number, so year 10000 cannot lexicographically sort before year 2000. */
function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return y * 10000 + m * 100 + d;
}

/** '2024-06-10' → '10 Jun 2024'. Corrupt values fall back to the raw text, which is the point. */
function humanDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return m >= 1 && m <= 12 ? `${d} ${MONTHS[m - 1]} ${y}` : iso;
}

const EARLIEST_REAL_DATE = 19000101; // 1900-01-01 — nobody on a working roster predates it.

/**
 * Every column a check actually reads. The full entity carries ~80 columns, three of them
 * (`panNumber`, `aadhaarNumber`, `bankAccountNumber`) behind the AES-GCM `encryptedColumn`
 * transformer that decrypts on every row it touches — loading the other ~75 unused columns for
 * 1,163 rows on every 15-minute tick, and now on every incremental rescan too, buys nothing.
 * `select` still goes through the repository (not raw SQL), so the transformer runs exactly as
 * it does today; only the column list narrows. Add a field here the moment a check starts
 * reading it, or that check silently sees `undefined`.
 */
const PERSON_SELECT_COLUMNS = [
  'id', 'assayerCode', 'displayName', 'lifecycleStatus', 'unavailableReason',
  'dateOfBirth', 'joiningDate', 'exitDate', 'terminationDate',
  'region', 'panNumber', 'aadhaarNumber', 'bankAccountNumber', 'phone', 'email',
  'latitude', 'longitude', 'geoAccuracyMeters', 'address',
] as const satisfies ReadonlyArray<keyof AssayerEntity>;

@Injectable()
export class DataIntegrityService {
  private readonly logger = new Logger(DataIntegrityService.name);

  constructor(
    @InjectRepository(AssayerEntity) private readonly assayers: Repository<AssayerEntity>,
    @InjectRepository(AssayerDocumentEntity) private readonly documents: Repository<AssayerDocumentEntity>,
    @InjectRepository(AssayerClientEmpanelmentEntity) private readonly empanelments: Repository<AssayerClientEmpanelmentEntity>,
    @InjectRepository(AssayerImportIssueEntity) private readonly issues: Repository<AssayerImportIssueEntity>,
  ) {}

  /**
   * One full pass: compute every finding from the live tables, write them under stable keys,
   * close what is no longer true. Idempotent by construction — two consecutive scans over
   * unchanged data insert zero rows (the spec pins it) — so it is safe on every 15-minute tick.
   */
  async scan(): Promise<DataIntegrityScanSummary> {
    const summary: DataIntegrityScanSummary = {
      findings: 0, inserted: 0, reopened: 0, updated: 0,
      unchanged: 0, skippedResolved: 0, suppressed: 0, autoClosed: 0,
    };

    /**
     * Everyone, through the repository — NOT through SQL. `pan_number`, `aadhaar_number` and
     * `bank_account_number` carry the AES-256-GCM `encryptedColumn` transformer with a random
     * IV per value: the moment PII_ENCRYPTION_KEY is set, identical PANs differ on disk and a
     * SQL `GROUP BY pan_number` silently returns ZERO duplicates — a false negative on the
     * highest-stakes check here. `find()` decrypts on read; 1,163 rows cost nothing.
     */
    /**
     * Every row, not only `isActive`. A soft-deleted or ARCHIVED appraiser used to fall out of all
     * eleven checks at once — and then `autoClose` saw their open findings unclaimed and stamped
     * them "No longer true — the record was corrected", which is a false statement about data
     * nobody touched. Three of these checks are ABOUT people who have left, which is exactly where
     * archiving lives, so filtering them out was also narrowing the checks against their own
     * titles. All 1,163 rows are active today, so this changes no current count.
     */
    const people = await this.assayers.find({ select: PERSON_SELECT_COLUMNS as unknown as (keyof AssayerEntity)[] });

    // The business day, not the database session's UTC day — between midnight and 05:30 IST
    // the two disagree, and "a date of birth in the future" must not flicker with the clock.
    const today = businessTodayDateKey();
    const todayNum = dayNumber(today);
    // Five years out. Measured: zero joining/exit dates sit between today and today + 5 years
    // (every future date in the table is year 3009+), so this cannot clip a scheduled joiner.
    const futureLimitNum = todayNum + 5 * 10000;

    const backup = await this.loadRepairBackup();
    const findings: Finding[] = [
      ...this.corruptDates(people, todayNum, futureLimitNum),
      ...this.joinedAfterLeft(people, futureLimitNum),
      ...this.leftWithNoDate(people, backup),
      ...(await this.leavingDateButActive(people)),
      ...(await this.leftButStillEmpanelled(people)),
      ...this.noRegion(people),
      ...this.impossibleAge(people, todayNum),
      ...this.noDateOfBirth(people, backup),
      ...(await this.duplicates(people, summary)),
      ...this.noHomeCoordinate(people),
      ...this.placeholderPin(people),
      ...this.blankAddress(people),
      ...this.unusableAddress(people),
      ...(await this.identityRejected(people)),
      ...this.noPhotograph(people),
      ...this.noPhone(people),
      ...(await this.documentsNeverVerified()),
      ...(await this.claimedWithoutScan()),
    ];
    summary.findings = findings.length;

    const claimed = new Set(findings.map((f) => this.columnFor(f)));
    await this.writeFindings(findings, summary);
    await this.autoClose(claimed, summary, null);
    return summary;
  }

  /**
   * The incremental path. Runs after a single assayer is created/edited/imported — one person's
   * worth of per-row checks, plus that person's identifiers compared against the roster for the
   * duplicate checks, instead of recomputing all ~19 checks over all ~1,163 rows. Every check
   * used here is the SAME function `scan()` calls (just over a one-person array, or in
   * `duplicatesForPerson`'s case, the same group-building logic `duplicates` uses) — this method
   * owns no business logic of its own, only which slice of the roster it hands to them.
   *
   * Deliberately excludes the three aggregate checks (`noHomeCoordinate`, `claimedWithoutScan`,
   * `documentsNeverVerified`): their answer is a fact about the whole population, not this person,
   * so nothing about editing one record can change them correctly — only the 15-minute full sweep,
   * the unchanged backstop, may write those rows.
   *
   * `autoClose` here is scoped to this person's own findings only (`sourceAssayerCode`) so an
   * incremental run can never touch — or wrongly close — anyone else's open row.
   */
  async incrementalScan(assayerId: string): Promise<DataIntegrityScanSummary> {
    const summary: DataIntegrityScanSummary = {
      findings: 0, inserted: 0, reopened: 0, updated: 0,
      unchanged: 0, skippedResolved: 0, suppressed: 0, autoClosed: 0,
    };

    const person = await this.assayers.findOne({
      where: { id: assayerId },
      select: PERSON_SELECT_COLUMNS as unknown as (keyof AssayerEntity)[],
    });
    // Deleted between the event firing and the debounce elapsing: nothing to check against —
    // the 15-minute sweep is the backstop that reconciles everything else about them.
    if (!person) return summary;

    const today = businessTodayDateKey();
    const todayNum = dayNumber(today);
    const futureLimitNum = todayNum + 5 * 10000;
    const backup = await this.loadRepairBackup(person.assayerCode);

    const findings: Finding[] = [
      ...this.corruptDates([person], todayNum, futureLimitNum),
      ...this.joinedAfterLeft([person], futureLimitNum),
      ...this.leftWithNoDate([person], backup),
      ...(await this.leavingDateButActive([person])),
      ...(await this.leftButStillEmpanelled([person])),
      ...this.noRegion([person]),
      ...this.impossibleAge([person], todayNum),
      ...this.noDateOfBirth([person], backup),
      ...(await this.duplicatesForPerson(person, summary)),
      ...this.placeholderPin([person]),
      ...this.blankAddress([person]),
      ...this.unusableAddress([person]),
      ...(await this.identityRejected([person])),
      ...this.noPhone([person]),
    ];
    summary.findings = findings.length;

    const claimed = new Set(findings.map((f) => this.columnFor(f)));
    await this.writeFindings(findings, summary);
    await this.autoClose(claimed, summary, person.assayerCode);
    return summary;
  }

  private columnFor(finding: Finding): string {
    return finding.suffix ? `${finding.title} · ${finding.suffix}` : finding.title;
  }

  /**
   * The write algorithm. For the latest generation at (sheet, column):
   *
   *   - no row                              → insert at generation 0;
   *   - latest open                         → refresh raw_value/reason in place (counts and
   *     dates stay current; one defect never has two open rows);
   *   - latest resolved BY A PERSON, same raw_value → skip — somebody decided, and re-reading
   *     the same facts is not new information;
   *   - latest resolved, raw_value changed  → insert at generation + 1: the data moved after
   *     the decision, so it deserves a fresh look, and the old decision stays on the record.
   *
   * One refinement over the naive rule: a row the SYSTEM auto-closed ("no longer true") whose
   * defect is back reopens even when raw_value is identical. Auto-close is a statement of fact,
   * not a decision — skip it and a defect that was fixed and then reintroduced (a leaving date
   * cleared, set, cleared again) would be invisible forever behind a closure nobody made.
   */
  /**
   * The write algorithm, applied to a whole batch of findings in a FIXED number of queries —
   * one read plus at most two writes — instead of one `findOne` + one `save` PER finding. That
   * used to be 2 queries × every finding computed (7,719 calls on the dev DB for 133 findings,
   * because every check recomputes every finding on every 15-minute tick even when nothing
   * changed); the query count below is the same whether this batch holds 0 findings or 10,000.
   *
   * Same decision rules as before, just evaluated in memory against one bulk read:
   *   - no row                              → insert at generation 0;
   *   - latest open                         → refresh raw_value/reason in place;
   *   - latest resolved BY A PERSON, same raw_value → skip;
   *   - latest resolved, raw_value changed, or SYSTEM auto-closed → insert at generation + 1.
   */
  private async writeFindings(findings: Finding[], summary: DataIntegrityScanSummary): Promise<void> {
    if (findings.length === 0) return;

    const columns = [...new Set(findings.map((f) => this.columnFor(f)))];
    // DISTINCT ON picks the highest source_row per column in one query — the in-memory
    // equivalent of the old per-column `findOne(..., order: { sourceRow: 'DESC' })`.
    const latestRows: Array<{
      id: string; source_column: string; source_row: number; raw_value: string; reason: string;
      assayer_id: string | null; source_assayer_code: string | null;
      resolved_at: Date | null; resolved_by: string | null; resolution: string | null;
    }> = await this.issues.manager.query(
      'SELECT DISTINCT ON (source_column) id, source_column, source_row, raw_value, reason, '
      + 'assayer_id, source_assayer_code, resolved_at, resolved_by, resolution '
      + 'FROM assayer_import_issues WHERE source_sheet = $1 AND source_column = ANY($2::varchar[]) '
      + 'ORDER BY source_column, source_row DESC',
      [DATA_INTEGRITY_SHEET, columns],
    );
    const latestByColumn = new Map(latestRows.map((r) => [r.source_column, r]));

    const toInsert: Array<{ sourceColumn: string; sourceRow: number; finding: Finding }> = [];
    const toUpdate: Array<{ id: string; finding: Finding }> = [];

    for (const finding of findings) {
      const sourceColumn = this.columnFor(finding);
      const latest = latestByColumn.get(sourceColumn);

      if (!latest) {
        toInsert.push({ sourceColumn, sourceRow: 0, finding });
        summary.inserted += 1;
        continue;
      }

      if (!latest.resolved_at) {
        if (
          latest.raw_value === finding.rawValue
          && latest.reason === finding.reason
          && latest.assayer_id === finding.assayerId
        ) { summary.unchanged += 1; continue; }
        toUpdate.push({ id: latest.id, finding });
        summary.updated += 1;
        continue;
      }

      const wasAutoClosed = latest.resolved_by == null && latest.resolution === AUTO_CLOSE_RESOLUTION;
      if (!wasAutoClosed && latest.raw_value === finding.rawValue) { summary.skippedResolved += 1; continue; }

      toInsert.push({ sourceColumn, sourceRow: latest.source_row + 1, finding });
      summary.reopened += 1;
    }

    if (toInsert.length > 0) {
      await this.issues.insert(toInsert.map(({ sourceColumn, sourceRow, finding }) => ({
        sourceSheet: DATA_INTEGRITY_SHEET,
        sourceRow,
        sourceColumn,
        rawValue: finding.rawValue,
        reason: finding.reason,
        assayerId: finding.assayerId,
        sourceAssayerCode: finding.sourceAssayerCode,
        createdBy: SYSTEM_ACTOR,
        updatedBy: SYSTEM_ACTOR,
      })));
    }

    if (toUpdate.length > 0) {
      // One UPDATE ... FROM (VALUES ...) covers every row in the batch — TypeORM's `save()` on
      // an array of entities-with-ids still issues one UPDATE per row, which is exactly the
      // per-finding query count this method exists to remove.
      const valueRows: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      for (const { id, finding } of toUpdate) {
        valueRows.push(`($${i++}::uuid, $${i++}, $${i++}, $${i++}::uuid, $${i++})`);
        params.push(id, finding.rawValue, finding.reason, finding.assayerId, finding.sourceAssayerCode);
      }
      await this.issues.manager.query(
        'UPDATE assayer_import_issues AS t SET '
        + 'raw_value = v.raw_value, reason = v.reason, assayer_id = v.assayer_id, '
        + "source_assayer_code = v.source_assayer_code, updated_by = 'SYSTEM', updated_at = now() "
        + `FROM (VALUES ${valueRows.join(', ')}) AS v(id, raw_value, reason, assayer_id, source_assayer_code) `
        + 'WHERE t.id = v.id',
        params,
      );
    }
  }

  /**
   * An open finding whose defect is gone from the live data is a false positive — the exact
   * thing this scan is forbidden to leave standing. The importer never needs this because its
   * findings are about spreadsheet cells, which never change; these are about live records,
   * which get corrected. Scoped hard to this scan's own sheet: importer rows are untouched.
   * This closes a report, not the data — no appraiser row is written.
   */
  /**
   * `scopeToAssayerCode` narrows this to one person's own rows for the incremental path — so
   * editing one record can never close somebody else's open finding, or one of the two
   * population-wide aggregate rows, which carry no `sourceAssayerCode` at all and so never match
   * a scope. `null` (the full sweep) closes across the whole "Data integrity" sheet, as before.
   *
   * The close itself is one UPDATE covering every row this call closes, not one `save()` per
   * row — the query count no longer grows with how many findings got auto-closed.
   */
  private async autoClose(
    claimed: Set<string>,
    summary: DataIntegrityScanSummary,
    scopeToAssayerCode: string | null,
  ): Promise<void> {
    const open = await this.issues.find({
      where: {
        sourceSheet: DATA_INTEGRITY_SHEET,
        resolvedAt: IsNull(),
        ...(scopeToAssayerCode ? { sourceAssayerCode: scopeToAssayerCode } : {}),
      },
    });
    const toClose = open.filter((row) => !claimed.has(row.sourceColumn)).map((row) => row.id);
    if (toClose.length === 0) return;

    await this.issues.createQueryBuilder()
      .update(AssayerImportIssueEntity)
      .set({
        resolvedAt: () => 'now()',
        resolvedBy: null,
        resolution: AUTO_CLOSE_RESOLUTION,
        updatedBy: SYSTEM_ACTOR,
      })
      .whereInIds(toClose)
      .execute();
    summary.autoClosed += toClose.length;
  }

  // ── The checks ──────────────────────────────────────────────────────────────

  /**
   * Check 1 — a date no calendar ever held. Before 1900, a joining/leaving/termination date
   * more than five years out, or a birth date in the future. These are `new Date("4032")`-style
   * misreads of spreadsheet cells; reported once, here, and deliberately NOT fed into the age or
   * sequence checks — comparing against year 6333 is not a lifecycle contradiction, it is a
   * corrupt cell. Fix the date and the next scan raises whatever comparison then genuinely fails.
   *
   * This check found 159 of them on the imported roster: 75 birth dates spanning years 0138–9952,
   * 58 joining dates (1275–6333) and 26 leaving dates (5087–6362). All 159 were blanked by
   * `scripts/repair-corrupt-dates.js`, which kept the originals in `_fix_backup_corrupt_dates`
   * rather than guess a replacement, so the check now yields zero and stands as a guard: the
   * importer's `readDate` is fixed, but a future import from a different source is not covered by
   * that fix, and a blank date is the only outcome anyone here is allowed to produce.
   *
   * Termination date is included alongside joining/exit (the plan named only those two) because
   * `leftWithNoDate` reads termination as a leaving date: a corrupt one (year 5481) would count
   * as "has a leaving date" there while no check reported the corruption itself. No termination
   * date has ever been corrupt, because the column is empty on every row of the roster, so this
   * arm is a guard, not a finding generator, and always was.
   */
  private corruptDates(people: AssayerEntity[], todayNum: number, futureLimitNum: number): Finding[] {
    const findings: Finding[] = [];
    for (const p of people) {
      const bad: string[] = [];
      const dob = isoDay(p.dateOfBirth);
      if (dob != null) {
        const n = dayNumber(dob);
        if (n < EARLIEST_REAL_DATE) bad.push(`date of birth ${dob}`);
        else if (n > todayNum) bad.push(`date of birth ${dob}`);
      }
      for (const [label, value] of [
        ['joining date', p.joiningDate], ['leaving date', p.exitDate], ['termination date', p.terminationDate],
      ] as const) {
        const day = isoDay(value);
        if (day == null) continue;
        const n = dayNumber(day);
        if (n < EARLIEST_REAL_DATE || n > futureLimitNum) bad.push(`${label} ${day}`);
      }
      if (bad.length === 0) continue;
      findings.push({
        title: CHECK_TITLES.corruptDate,
        suffix: p.assayerCode,
        rawValue: bad.join('; '),
        reason: `${p.assayerCode} (${p.displayName}): the ${bad.join(' and the ')} cannot be a real date — `
          + 'the spreadsheet cell was almost certainly mistyped or misread when it was brought in. '
          + 'Look the true date up in their papers and correct the record.',
        assayerId: p.id,
        sourceAssayerCode: p.assayerCode,
      });
    }
    return findings;
  }

  /**
   * Check 2 — joining date after the leaving date. Only when BOTH dates are plausible
   * (1900 … today + 5y): one corrupt cell already has its own finding above, and sequencing
   * garbage is not a contradiction. Live: 7 people, all RESIGNED/INACTIVE/TERMINATED.
   */
  private joinedAfterLeft(people: AssayerEntity[], futureLimitNum: number): Finding[] {
    const findings: Finding[] = [];
    for (const p of people) {
      const joined = isoDay(p.joiningDate);
      const left = isoDay(p.exitDate);
      if (joined == null || left == null) continue;
      const j = dayNumber(joined);
      const x = dayNumber(left);
      if (j < EARLIEST_REAL_DATE || j > futureLimitNum) continue;
      if (x < EARLIEST_REAL_DATE || x > futureLimitNum) continue;
      if (j <= x) continue;
      findings.push({
        title: CHECK_TITLES.joinedAfterLeft,
        suffix: p.assayerCode,
        rawValue: `joined ${humanDay(joined)}, left ${humanDay(left)}`,
        reason: `${p.assayerCode} (${p.displayName}) joined on ${humanDay(joined)} but the record says they `
          + `left on ${humanDay(left)}. One of the two dates is wrong and the record cannot tell which — `
          + 'check the joining letter.',
        assayerId: p.id,
        sourceAssayerCode: p.assayerCode,
      });
    }
    return findings;
  }

  /**
   * Check 3 — someone who has left, with no leaving date anywhere (exit and termination both
   * blank). Live: 25, of whom 20 had a corrupt exit date (years 5087–6362) that the data repair
   * correctly blanked rather than guessed — the backup clause tells the clerk that story so
   * they know the date exists on paper somewhere.
   *
   * Those figures track `hasLeft`, which admits four kinds of departure, so they are deliberately
   * wider than the same-shaped numbers on `AssayerService.reconcileDepartureDates` (24 / 19 /
   * 5295–6362). Those cover RESIGNED and TERMINATED alone, which is the only population that
   * method stamps. Both are true of their own scope; neither is a correction of the other. The
   * single person between them is AS0055, recorded as deceased, whose misread exit year 5087 is
   * also what widens the range at the bottom end.
   */
  private leftWithNoDate(people: AssayerEntity[], backup: RepairBackup): Finding[] {
    const findings: Finding[] = [];
    for (const p of people) {
      if (!this.hasLeft(p)) continue;
      if (isoDay(p.exitDate) != null || isoDay(p.terminationDate) != null) continue;
      const misread = backup.get(p.assayerCode)?.exit;
      findings.push({
        title: CHECK_TITLES.leftNoDate,
        suffix: p.assayerCode,
        rawValue: 'no leaving date',
        reason: `${p.assayerCode} (${p.displayName}) is marked ${this.leftWord(p)} but the record holds no `
          + 'leaving date, so nothing can say when they stopped working here. '
          + this.whereTheLeavingDateLives(p)
          + (misread
            ? ` The roster did hold one, but it was misread as ${misread} and the data repair cleared it `
              + 'rather than guess — the paper file has the real one.'
            : ''),
        assayerId: p.id,
        sourceAssayerCode: p.assayerCode,
      });
    }
    return findings;
  }

  /**
   * Check 4 — a leaving date on a record still marked Active. The importer already queues this
   * exact contradiction as an 'Exit Date' issue when it comes from a sheet (live: AS0633 and
   * AD0123, both queued) — those are skipped so one contradiction is one queue entry. The check
   * stays because the same contradiction can be made by hand after import, with no sheet row
   * behind it.
   */
  private async leavingDateButActive(people: AssayerEntity[]): Promise<Finding[]> {
    const affected = people.filter(
      (p) => p.lifecycleStatus === AssayerLifecycleStatus.ACTIVE && isoDay(p.exitDate) != null,
    );
    if (affected.length === 0) return [];

    const importerRows = await this.issues.find({
      where: { sourceColumn: IMPORTER_EXIT_DATE_COLUMN },
    });
    const alreadyQueued = new Set<string>();
    for (const row of importerRows) {
      if (row.assayerId) alreadyQueued.add(row.assayerId);
      if (row.sourceAssayerCode) alreadyQueued.add(row.sourceAssayerCode);
    }

    const findings: Finding[] = [];
    for (const p of affected) {
      if (alreadyQueued.has(p.id) || alreadyQueued.has(p.assayerCode)) continue;
      const left = isoDay(p.exitDate)!;
      findings.push({
        title: CHECK_TITLES.leavingButActive,
        suffix: p.assayerCode,
        rawValue: `leaving date ${humanDay(left)} on an Active record`,
        reason: `${p.assayerCode} (${p.displayName}) has a leaving date of ${humanDay(left)} yet is marked `
          + 'Active. One of the two is stale — settle whether they still work here, then clear the date '
          + 'or correct the status.',
        assayerId: p.id,
        sourceAssayerCode: p.assayerCode,
      });
    }
    return findings;
  }

  /**
   * Check 5 — resigned or terminated, yet still actively empanelled with a client, i.e. still
   * on the list of people we may send into that client's vaults. Live: zero (already repaired);
   * the check stands guard because the two facts are written by different screens.
   */
  private async leftButStillEmpanelled(people: AssayerEntity[]): Promise<Finding[]> {
    const left = people.filter((p) => this.hasLeft(p));
    if (left.length === 0) return [];
    const byId = new Map(left.map((p) => [p.id, p]));

    const rows = await this.empanelments.find({
      // ACTIVE *and* RECOMMENDED, matching what the planner's per-client gate actually admits
      // (`QUALIFYING_STANDINGS`) and what `closeClientEmpanelmentsOnDeparture` already closes on
      // departure. Checking only ACTIVE made this narrower than its own title — a departed person
      // left on RECOMMENDED is still someone the planner would send into that client's vaults.
      where: {
        assayerId: In([...byId.keys()]),
        status: In([EmpanelmentStatus.ACTIVE, EmpanelmentStatus.RECOMMENDED]),
        isActive: true,
      },
      relations: ['client'],
    });
    const clientsByAssayer = new Map<string, string[]>();
    for (const row of rows) {
      const name = row.client?.name ?? 'a client';
      (clientsByAssayer.get(row.assayerId) ?? clientsByAssayer.set(row.assayerId, []).get(row.assayerId)!)
        .push(name);
    }

    const findings: Finding[] = [];
    for (const [assayerId, clientNames] of clientsByAssayer) {
      const p = byId.get(assayerId)!;
      clientNames.sort();
      findings.push({
        title: CHECK_TITLES.leftButEmpanelled,
        suffix: p.assayerCode,
        rawValue: `still empanelled with ${clientNames.join(', ')}`,
        reason: `${p.assayerCode} (${p.displayName}) is marked ${this.leftWord(p)} but is still recorded as `
          + `actively empanelled with ${clientNames.join(', ')} — on paper they may still be sent to that `
          + "client's branches. End the empanelment, or correct the status if they are in fact still working.",
        assayerId: p.id,
        sourceAssayerCode: p.assayerCode,
      });
    }
    return findings;
  }

  /** Check 6 — no region. Desks are scoped by region, so this person is on nobody's desk. */
  private noRegion(people: AssayerEntity[]): Finding[] {
    return people
      .filter((p) => p.region == null || String(p.region).trim() === '')
      .map((p) => ({
        title: CHECK_TITLES.noRegion,
        suffix: p.assayerCode,
        rawValue: 'no region recorded',
        reason: `${p.assayerCode} (${p.displayName}) has no region on the record. Desks are scoped by `
          + "region, so no territorial desk sees this person until it is set — they can be invisible to "
          + 'the very team meant to plan them. Set the region on their record.',
        assayerId: p.id,
        sourceAssayerCode: p.assayerCode,
      }));
  }

  /**
   * Check 7 — a real calendar date of birth that gives an impossible working age: under 18 or
   * over 90. Runs ONLY on plausible dates (1900 … today) so the year-4032 record is reported
   * once, as a corrupt date, never twice. Live: 6 under, 0 over.
   */
  private impossibleAge(people: AssayerEntity[], todayNum: number): Finding[] {
    const findings: Finding[] = [];
    for (const p of people) {
      const dob = isoDay(p.dateOfBirth);
      if (dob == null) continue;
      const n = dayNumber(dob);
      if (n < EARLIEST_REAL_DATE || n > todayNum) continue; // corrupt — check 1's finding
      const age = Math.floor(todayNum / 10000) - Math.floor(n / 10000)
        - (todayNum % 10000 < n % 10000 ? 1 : 0);
      if (age >= 18 && age <= 90) continue;
      const problem = age < 18
        ? `${age} — too young to be a working appraiser. The year was probably mistyped`
        : `${age} — not a plausible age for a working appraiser. The year was probably mistyped`;
      findings.push({
        title: CHECK_TITLES.impossibleAge,
        suffix: p.assayerCode,
        rawValue: `born ${humanDay(dob)} — age ${age}`,
        reason: `${p.assayerCode} (${p.displayName})'s date of birth ${humanDay(dob)} makes them `
          + `${problem}; check their identity documents and correct it.`,
        assayerId: p.id,
        sourceAssayerCode: p.assayerCode,
      });
    }
    return findings;
  }

  /**
   * Check 8 — no date of birth at all, among the people somebody can still be asked about.
   *
   * Two populations live here and they are easy to confuse, so both are named. What this check
   * yields, counted through its own `stillOnTheRoster` filter: 67 findings — 52 had a corrupt
   * roster value the repair blanked (named via the backup clause), the other 15 never had one.
   * Every row with a null date of birth, departed people included, is 101 (75 / 26). That wider
   * figure is a fact about the table, not about this check — it is the one this comment used to
   * give, stated as the yield, which is the confusion worth not repeating.
   *
   * Per-person rows, because each needs its own document looked up.
   */
  private noDateOfBirth(people: AssayerEntity[], backup: RepairBackup): Finding[] {
    return people
      .filter((p) => this.stillOnTheRoster(p) && isoDay(p.dateOfBirth) == null)
      .map((p) => {
        const misread = backup.get(p.assayerCode)?.dob;
        return {
          title: CHECK_TITLES.noDob,
          suffix: p.assayerCode,
          rawValue: 'no date of birth',
          reason: `${p.assayerCode} (${p.displayName}) has no date of birth on the record. Their PAN or `
            + 'Aadhaar copy shows it — enter it from there.'
            + (misread
              ? ` The roster did hold one, but it was misread as ${misread} and the data repair cleared `
                + 'it rather than guess.'
              : ''),
          assayerId: p.id,
          sourceAssayerCode: p.assayerCode,
        };
      });
  }

  /**
   * Checks 9a-9e — one identity value on two records. Computed here in application code over
   * repository-loaded rows; see the comment on `scan` for why SQL can never do this once the
   * encryption key is set. `raw_value` carries the two appraiser codes ONLY — never the shared
   * PAN, Aadhaar, account or phone itself: the queue is rendered on screen and grouped by that
   * text, and the importer set that leak policy first (roster-import.service.ts ~433-436).
   *
   * Within a group sharing one value the lowest code is the holder and each later code pairs with
   * it, so the pair vocabulary reads the same as the importer's ('AD0121 and AS0107'). The key
   * suffix is the SECOND code of the pair: unique per pair by construction, and short enough that
   * `source_column` can never overflow (a two-code suffix could reach 125 chars and be truncated
   * into a collision).
   *
   * Suppression compares GROUPS, not pair strings — see `importerDuplicateGroups`. This comment
   * used to say the two pairings "mirror the importer exactly"; they do for a collision between
   * two people, which is all the live roster has, and they diverge for three.
   */
  /**
   * The importer's duplicate pairs, read as connected groups of appraiser codes, one set per
   * importer column.
   *
   * Suppression used to compare the pair STRING, on the stated belief that both sides pair people
   * up the same way. They only do for a collision between two people. The importer takes the
   * first code it meets IN FILE ORDER as the holder and pairs every later code with that one;
   * this scan has no file order to consult, so it takes the lowest code. On a three-way collision
   * the two partition the same group differently — a file ordered C, B, A leaves the importer
   * holding {'B and C', 'A and C'} while the scan produces {'A and B', 'A and C'} — so one scan
   * row matches nothing, and the queue ends up with three rows for one three-way collision, the
   * extra one restating facts already queued under a different pairing.
   *
   * Asking whether the two codes are already connected removes the disagreement entirely: however
   * each side chose to partition a group, the question that matters is the same one — has the
   * importer already told somebody these two share this value?
   *
   * The live roster has no three-way collision on PAN, phone or email, so this changes no current
   * row. It is the re-import of a file that has one that this is for.
   */
  private importerDuplicateGroups(rows: AssayerImportIssueEntity[]): Map<string, Map<string, string>> {
    const byColumn = new Map<string, Map<string, string>>();
    for (const row of rows) {
      // 'AD0121 and AS0107' — the only shape either side writes. Anything else is not a pair
      // this can reason about, and guessing at it would be worse than leaving the row visible.
      const codes = String(row.rawValue ?? '').split(' and ').map((c) => c.trim()).filter(Boolean);
      if (codes.length !== 2) continue;
      const parent = byColumn.get(row.sourceColumn) ?? byColumn.set(row.sourceColumn, new Map()).get(row.sourceColumn)!;
      union(parent, codes[0], codes[1]);
    }
    return byColumn;
  }

  /** Has the importer already put these two codes in one group for this column? */
  private importerAlreadySaid(
    groups: Map<string, Map<string, string>>,
    column: string,
    a: string,
    b: string,
  ): boolean {
    const parent = groups.get(column);
    // A code the importer never named roots to itself, so an unknown pair can never match.
    return parent != null && find(parent, a) === find(parent, b);
  }

  /**
   * The five duplicate checks' definitions. Pulled out to its own method so the full sweep
   * (`duplicates`, over everyone) and the incremental path (`duplicatesForPerson`, over one
   * person's identifiers against the roster) read the same title/wording/importer-suppression
   * rule from one place — a discrepancy here would mean the same collision reads differently
   * depending only on which of the two paths happened to notice it first.
   */
  private duplicateKinds(): DuplicateKind[] {
    return [
      {
        title: CHECK_TITLES.duplicatePan, word: 'PAN', importerColumn: 'Duplicate PAN',
        value: (p) => p.panNumber,
        note: 'That is usually one person registered under two codes — compare both records and retire '
          + "one. Nothing was merged: a merge that guesses wrong destroys a real person's history.",
      },
      {
        title: CHECK_TITLES.duplicateAadhaar, word: 'Aadhaar number', importerColumn: null,
        value: (p) => p.aadhaarNumber,
        note: 'An Aadhaar belongs to exactly one person, so this is almost certainly one person under '
          + 'two codes — compare both records and retire one. Nothing was merged automatically.',
      },
      {
        title: CHECK_TITLES.duplicateBank, word: 'bank account', importerColumn: null,
        value: (p) => p.bankAccountNumber,
        note: 'Two records paying into one account is either one person under two codes or a mistake in '
          + 'the account number — and either way, payouts are going to the wrong place for somebody. '
          + 'Compare both records before the next payout.',
      },
      {
        title: CHECK_TITLES.duplicatePhone, word: 'phone', importerColumn: 'Duplicate phone',
        value: (p) => p.phone,
        note: 'That is usually one person registered under two codes — compare both records and retire '
          + 'one. Nothing was merged: two people really can share a phone, and a merge that guesses '
          + "wrong destroys a real person's history.",
      },
      {
        title: CHECK_TITLES.duplicateEmail, word: 'email', importerColumn: 'Duplicate email',
        value: (p) => p.email,
        note: 'That is usually one person registered under two codes — compare both records and retire '
          + 'one. Nothing was merged: a family can share an address, and a merge that guesses wrong '
          + "destroys a real person's history.",
      },
    ];
  }

  /**
   * One group of ≥2 people sharing one identity value, turned into the finding(s) about it. The
   * shared core of both duplicate paths — see `duplicateKinds`'s comment for why it must be one
   * function, not two copies that could drift.
   */
  private findingsForDuplicateGroup(
    kind: DuplicateKind,
    members: Array<Pick<AssayerEntity, 'id' | 'assayerCode'>>,
    importerGroups: Map<string, Map<string, string>>,
    summary: DataIntegrityScanSummary,
  ): Finding[] {
    if (members.length < 2) return [];
    const sorted = [...members].sort((a, b) => a.assayerCode.localeCompare(b.assayerCode));
    const holder = sorted[0];
    const findings: Finding[] = [];
    for (const other of sorted.slice(1)) {
      const pair = `${holder.assayerCode} and ${other.assayerCode}`;
      if (kind.importerColumn
        && this.importerAlreadySaid(importerGroups, kind.importerColumn, holder.assayerCode, other.assayerCode)) {
        summary.suppressed += 1;
        continue;
      }
      findings.push({
        title: kind.title,
        suffix: other.assayerCode,
        rawValue: pair,
        reason: `${holder.assayerCode} carries the same ${kind.word} as ${other.assayerCode}. ${kind.note}`,
        assayerId: other.id,
        sourceAssayerCode: other.assayerCode,
      });
    }
    return findings;
  }

  /** The importer's duplicate-pair rows, resolved or not (see `duplicateKinds`'s callers). */
  private async loadImporterDuplicateGroups(): Promise<Map<string, Map<string, string>>> {
    const importerRows = await this.issues.find({
      where: { sourceColumn: In([...IMPORTER_DUPLICATE_COLUMNS]) },
    });
    return this.importerDuplicateGroups(importerRows);
  }

  private async duplicates(people: AssayerEntity[], summary: DataIntegrityScanSummary): Promise<Finding[]> {
    const importerGroups = await this.loadImporterDuplicateGroups();
    const findings: Finding[] = [];
    for (const kind of this.duplicateKinds()) {
      const groups = new Map<string, AssayerEntity[]>();
      for (const p of people) {
        const value = kind.value(p);
        if (value == null) continue;
        const key = String(value).trim().toLowerCase();
        if (key === '') continue;
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
      }
      for (const members of groups.values()) {
        findings.push(...this.findingsForDuplicateGroup(kind, members, importerGroups, summary));
      }
    }
    return findings;
  }

  /**
   * The incremental half of the duplicate checks: this one person's identifiers against the
   * roster, not a full recompute of every group. Encryption is exactly why this cannot be a
   * `WHERE panNumber = $1` — see the comment on `scan()` — so it still reads every row, but only
   * the five narrow identifier columns rather than the ~80-column full entity `scan()` needs,
   * and it is only paid on the debounced rescan of an edited record, not on every 15-minute tick.
   */
  private async duplicatesForPerson(
    person: Pick<AssayerEntity, 'id' | 'assayerCode' | 'panNumber' | 'aadhaarNumber' | 'bankAccountNumber' | 'phone' | 'email'>,
    summary: DataIntegrityScanSummary,
  ): Promise<Finding[]> {
    const roster = await this.assayers.find({
      select: ['id', 'assayerCode', 'panNumber', 'aadhaarNumber', 'bankAccountNumber', 'phone', 'email'],
    });
    const importerGroups = await this.loadImporterDuplicateGroups();

    const findings: Finding[] = [];
    for (const kind of this.duplicateKinds()) {
      const myValue = kind.value(person);
      if (myValue == null) continue;
      const key = String(myValue).trim().toLowerCase();
      if (key === '') continue;
      const members = roster.filter((p) => {
        const v = kind.value(p);
        return v != null && String(v).trim().toLowerCase() === key;
      });
      findings.push(...this.findingsForDuplicateGroup(kind, members, importerGroups, summary));
    }
    return findings;
  }

  /**
   * Phone matches for one candidate number, across the WHOLE roster — the mechanism behind
   * `GET /assayers/identifier-check`, which the registration wizard calls on every field blur,
   * before a record is ever saved.
   *
   * Deliberately narrower than `duplicatesForPerson` above: `phone` is a plain column, never
   * behind `encryptedColumn`, so this selects only the two phone columns instead of the five
   * identifier columns that check pays for — cheap enough to call on every blur, not only on a
   * debounced rescan of one already-saved record.
   *
   * Compared through `normalisePhone` on BOTH sides rather than a literal string match:
   * `AssayerService.normaliseIdentityFields` now stores phones as `+91XXXXXXXXXX`, but rows
   * written before that normalisation existed can still hold "+91 98765-00011" or a bare 10
   * digits, and `=` would miss every one of those against a freshly normalised candidate.
   *
   * PAN and Aadhaar are NOT covered here, and this is the one mechanism this service exposes for
   * a live per-field check. Both live behind `encryptedColumn`, so an exact match across
   * encryption can only be found by decrypting every row on the roster — exactly what
   * `duplicatesForPerson` above already pays for, but only on a debounced rescan of ONE saved
   * record. Paying that cost again, for every blur of a wizard field, over the whole roster, is a
   * different and heavier trade than a live check should make silently.
   * `AssayerController.checkIdentifiers` returns an empty match set for those two keys instead of
   * guessing at a cheaper, partial answer.
   */
  async findPhoneMatches(
    phone: string,
    excludeId?: string,
  ): Promise<Array<{ id: string; assayerCode: string; displayName: string; lifecycleStatus: AssayerLifecycleStatus }>> {
    const target = normalisePhone(phone);
    if (!target) return [];

    const roster = await this.assayers.find({
      // Live rows only: a soft-deleted person is not "already on the roster", and telling a
      // clerk a number belongs to somebody who was removed sends them chasing a ghost.
      where: { isActive: true },
      select: ['id', 'assayerCode', 'displayName', 'lifecycleStatus', 'phone', 'alternatePhone'],
    });

    return roster
      .filter((p) => p.id !== excludeId
        && (normalisePhone(p.phone) === target || normalisePhone(p.alternatePhone) === target))
      .map((p) => ({
        id: p.id, assayerCode: p.assayerCode, displayName: p.displayName, lifecycleStatus: p.lifecycleStatus,
      }));
  }

  /**
   * Evaluates identifier collisions across the live roster for phone, PAN, and Aadhaar.
   *
   * PAN and Aadhaar are stored encrypted with AES-256-GCM behind TypeORM's entity transformer.
   * Safe comparison is performed in-memory without exposing decrypted values in API responses.
   */
  async findIdentifierMatches(criteria: {
    phone?: string;
    panNumber?: string;
    aadhaarNumber?: string;
    excludeId?: string;
  }): Promise<Array<{
    id: string;
    assayerCode: string;
    displayName: string;
    lifecycleStatus: AssayerLifecycleStatus;
    matchedOn: 'phone' | 'panNumber' | 'aadhaarNumber';
  }>> {
    const targetPhone = criteria.phone ? normalisePhone(criteria.phone) : null;
    const targetPan = criteria.panNumber ? criteria.panNumber.trim().toUpperCase() : null;
    const targetAadhaar = criteria.aadhaarNumber ? criteria.aadhaarNumber.replace(/\s+/g, '') : null;

    if (!targetPhone && !targetPan && !targetAadhaar) return [];

    const selectFields: Array<keyof AssayerEntity> = ['id', 'assayerCode', 'displayName', 'lifecycleStatus'];
    if (targetPhone) selectFields.push('phone', 'alternatePhone');
    if (targetPan) selectFields.push('panNumber');
    if (targetAadhaar) selectFields.push('aadhaarNumber');

    const roster = await this.assayers.find({
      where: { isActive: true },
      select: selectFields,
    });

    const matches: Array<{
      id: string;
      assayerCode: string;
      displayName: string;
      lifecycleStatus: AssayerLifecycleStatus;
      matchedOn: 'phone' | 'panNumber' | 'aadhaarNumber';
    }> = [];

    for (const p of roster) {
      if (p.id === criteria.excludeId) continue;

      if (
        targetPhone &&
        (normalisePhone(p.phone) === targetPhone || normalisePhone(p.alternatePhone) === targetPhone)
      ) {
        matches.push({
          id: p.id,
          assayerCode: p.assayerCode,
          displayName: p.displayName,
          lifecycleStatus: p.lifecycleStatus,
          matchedOn: 'phone',
        });
        continue;
      }

      if (targetPan && p.panNumber && p.panNumber.trim().toUpperCase() === targetPan) {
        matches.push({
          id: p.id,
          assayerCode: p.assayerCode,
          displayName: p.displayName,
          lifecycleStatus: p.lifecycleStatus,
          matchedOn: 'panNumber',
        });
        continue;
      }

      if (
        targetAadhaar &&
        p.aadhaarNumber &&
        p.aadhaarNumber.replace(/\s+/g, '') === targetAadhaar
      ) {
        matches.push({
          id: p.id,
          assayerCode: p.assayerCode,
          displayName: p.displayName,
          lifecycleStatus: p.lifecycleStatus,
          matchedOn: 'aadhaarNumber',
        });
      }
    }

    return matches;
  }

  /**
   * Check 10 — aggregate: people with no home coordinate. One row, not N: the answer is the
   * same for everyone in the class ("wait for the address lookup, or set the pin"), so N rows
   * would be N copies of one decision. The count lives in the reason and is refreshed in place
   * while the row is open; `raw_value` stays constant so a falling counter cannot cut a new
   * generation on every tick over a human's resolution.
   */
  private noHomeCoordinate(people: AssayerEntity[]): Finding[] {
    const missing = people.filter((p) => p.latitude == null || p.longitude == null);
    if (missing.length === 0) return [];
    return [{
      title: CHECK_TITLES.noCoordinates,
      suffix: null,
      rawValue: 'no home coordinate',
      reason: `${missing.length} of ${people.length} appraisers have no home location on the map, so the `
        + 'distance rules — how far they live from a branch, what travel costs — cannot run for them. '
        + 'Most get placed by the automatic address lookup within a day; anyone still listed after that '
        + 'needs their pin set by hand on their record.',
      assayerId: null,
      sourceAssayerCode: null,
    }];
  }

  /**
   * Check 12 — a pin that exists but does not mean anything.
   *
   * `noHomeCoordinate` above tests only for NULL, and that let the worse case through: 9 people
   * carry a coordinate whose stated accuracy is 100 km or 500 km — a district, state or country
   * centroid the geocoder fell back to when it could not resolve the address (`geo_source` is
   * literally `'none'`). Four of them are lifecycle ACTIVE. Nothing downstream tells those apart
   * from a real pin: the conflict-of-interest floor measures against them, travel is costed from
   * them, and the planning map draws a confident dot on them. A wrong pin is worse than an absent
   * one, because the absent one at least fails visibly.
   *
   * Per-person, not aggregate: each needs a different address looked at by whoever knows that
   * person — N decisions, not one.
   */
  private placeholderPin(people: AssayerEntity[]): Finding[] {
    return people
      .filter((p) => this.stillOnTheRoster(p) && p.latitude != null && p.longitude != null
        && Number(p.geoAccuracyMeters ?? 0) >= PLACEHOLDER_PIN_METRES)
      .map((p) => {
        const km = Math.round(Number(p.geoAccuracyMeters) / 1000);
        return {
          title: CHECK_TITLES.placeholderPin,
          suffix: p.assayerCode,
          // The accuracy, not the coordinate pair: a centroid means nothing to a clerk.
          rawValue: `accurate to about ${km} km`,
          reason: `${p.displayName ?? p.assayerCode} has a map pin that is only accurate to about ${km} km `
            + '— their address could not be found, so the system fell back to the middle of a district or '
            + 'state. Distance rules and travel costs are being worked out from that point as though it '
            + 'were their home. Open their record and set the pin, or correct the address so it can be '
            + 'looked up again.',
          assayerId: p.id,
          sourceAssayerCode: p.assayerCode,
        };
      });
  }

  /**
   * Check 15 — aggregate: ticked as received on the old sheet, with no scan behind it.
   *
   * 10,977 of the 10,978 "received" documents hold an empty `file_paths`. The roster import
   * recorded what the spreadsheet CLAIMED, not evidence — so the record asserts a document
   * arrived and there is nothing to show an auditor. That is a different problem from "never
   * verified" and needs its own row, because it survives verification being switched on: you
   * cannot verify a document you do not have.
   *
   * Deliberately NOT auto-closing on the first re-uploaded scan. The sibling check
   * `documentsNeverVerified` is written as "not ONE has ever been verified", so verifying a
   * single document flips it false and closes it — correct there, because the fact it reports is
   * "this process has never been operated". Here the fact is a backlog, so it is reported as a
   * remaining count and stays open until the last one is cleared.
   */
  private async claimedWithoutScan(): Promise<Finding[]> {
    const rows: Array<{ docs: number; people: number }> = await this.issues.manager.query(
      'SELECT COUNT(*)::int AS docs, COUNT(DISTINCT assayer_id)::int AS people '
      + 'FROM assayer_documents '
      + "WHERE (soft_copy_received = true OR hard_copy_received = true) "
      + "AND jsonb_array_length(coalesce(file_paths, '[]'::jsonb)) = 0",
    );
    const docs = Number(rows[0]?.docs ?? 0);
    if (docs === 0) return [];
    const people = Number(rows[0]?.people ?? 0);
    return [{
      title: CHECK_TITLES.claimedNoScan,
      suffix: null,
      rawValue: 'claimed on the old sheet, no file kept',
      reason: `${docs.toLocaleString('en-IN')} documents across ${people.toLocaleString('en-IN')} people are `
        + 'ticked as received but have no scan attached. The tick came from the old spreadsheet, which '
        + 'recorded what somebody said had arrived, not the document itself — so if an auditor asks to see '
        + 'one, there is nothing to show. Collect the scans as each person is next dealt with; this count '
        + 'falls as they are uploaded.',
      assayerId: null,
      sourceAssayerCode: null,
    }];
  }

  /**
   * Check 13 — no home address at all, among the people somebody can still be asked about.
   *
   * 4 findings through this check's own filter; 11 records carry a blank address in all, the
   * other 7 belonging to people who have left. The address is what the geocoder reads, so a blank
   * one means the pin can never be resolved — these are the residue that the automatic lookup
   * will never clear, and they were invisible: `noHomeCoordinate` counts them among "wait for the
   * lookup", which for them will never finish.
   */
  private blankAddress(people: AssayerEntity[]): Finding[] {
    return people
      .filter((p) => this.stillOnTheRoster(p) && String(p.address ?? '').trim() === '')
      .map((p) => ({
        title: CHECK_TITLES.blankAddress,
        suffix: p.assayerCode,
        rawValue: 'address is empty',
        reason: `${p.displayName ?? p.assayerCode} has no home address on their record, so their map pin `
          + 'can never be worked out automatically — the address lookup has nothing to read. Add the '
          + 'address on their record.',
        assayerId: p.id,
        sourceAssayerCode: p.assayerCode,
      }));
  }

  /**
   * Check 12b — an address is written down, but there is no place in it.
   *
   * `blankAddress` catches an empty cell. This catches the one that looks filled in and is not:
   * a relative's name and a door number ("S/O Ramesh Kumar, H.No-110"), or a landmark and nothing
   * else. `placeCandidates` parses an address into the things a map could be asked about — a road,
   * a colony, a village — and when it finds none, no geocoder will ever place this person, however
   * good the geocoder or the map becomes. Retrying it nightly is wasted work; a person has to add
   * the missing part.
   *
   * That is the whole distinction this check draws, and why it is separate from `placeholderPin`:
   * a placeholder pin means "we tried and the map does not hold it", and it may improve on its own
   * as OSM fills in. This means "there is nothing here to try", and it never improves by itself.
   *
   * Per-person, because each needs a different address looked at by whoever knows that person.
   */
  private unusableAddress(people: AssayerEntity[]): Finding[] {
    return people
      .filter((p) => this.stillOnTheRoster(p)
        && String(p.address ?? '').trim() !== ''
        && !isAddressUsable(p.address))
      .map((p) => ({
        title: CHECK_TITLES.unusableAddress,
        suffix: p.assayerCode,
        // The address itself, trimmed — the clerk has to see what is actually in the cell to know
        // what is missing from it.
        rawValue: String(p.address).trim().slice(0, 120),
        reason: `${p.displayName ?? p.assayerCode} has something in the address field, but nothing in it `
          + 'names a place — no road, no colony, no village, only things like a relative\'s name, a door '
          + 'number or a landmark. The address lookup has nothing to search for, so this person can never '
          + 'be put on the map automatically and the distance and travel rules cannot run for them. Add '
          + 'the locality or road to their address.',
        assayerId: p.id,
        sourceAssayerCode: p.assayerCode,
      }));
  }

  /**
   * Check 12c — a scan was sent back and nothing has replaced it.
   *
   * This is the one finding with a person waiting on the other end of it. A rejected identity
   * document means somebody looked at a photograph of a card and could not accept it, and until a
   * replacement arrives that appraiser cannot be activated. The appraiser is told on their phone;
   * this row is so the desk knows too, because a rejection that only the rejected person can see is
   * a queue of one.
   *
   * Per person, and only while nothing newer has arrived: `attachFile` clears the rejection the
   * moment a replacement is uploaded, so this closes itself without anybody working it.
   */
  private async identityRejected(people: AssayerEntity[]): Promise<Finding[]> {
    const ids = people.filter((p) => this.stillOnTheRoster(p)).map((p) => p.id);
    if (ids.length === 0) return [];

    const rows = await this.documents.find({
      where: { assayerId: In(ids), isActive: true, verificationStatus: DocumentVerification.REJECTED },
    });
    const byPerson = new Map(people.map((p) => [p.id, p]));

    return rows.flatMap((row) => {
      const person = byPerson.get(row.assayerId);
      if (!person) return [];
      const label = ONBOARDING_DOCUMENT_LABELS[row.requirement as OnboardingDocument] ?? row.requirement;
      const why = row.rejectionReason
        ? DOCUMENT_REJECTION_LABELS[row.rejectionReason as DocumentRejectionReason] ?? row.rejectionReason
        : 'no reason was recorded';
      return [{
        title: CHECK_TITLES.identityRejected,
        suffix: `${person.assayerCode} · ${row.requirement}`,
        rawValue: why,
        reason: `${person.displayName ?? person.assayerCode}'s ${label} was sent back — ${why.toLowerCase()} `
          + '— and no replacement has arrived. They have been told on their phone; this is here so the '
          + 'desk can chase it, because until it is replaced they cannot be activated.',
        assayerId: person.id,
        sourceAssayerCode: person.assayerCode,
      }];
    });
  }

  /**
   * Check 12d — aggregate: nobody has a photograph.
   *
   * Field staff are dispatched to bank branches by people who have never met them, and the record
   * has had somewhere to keep a face for as long as it has existed — 0 of 1,163 hold one, because
   * the only route to it was an onboarding checklist nobody has been through.
   *
   * One row, not N: the answer is the same for everybody in the class ("ask them to send one from
   * the app"), so a row per person would be a thousand copies of one decision, burying the findings
   * that each need a different human to look at a different record.
   */
  private noPhotograph(people: AssayerEntity[]): Finding[] {
    const without = people.filter((p) => this.stillOnTheRoster(p)
      && String((p as any).photograph ?? '').trim() === '');
    if (without.length === 0) return [];
    return [{
      title: CHECK_TITLES.noPhotograph,
      suffix: null,
      rawValue: 'no photograph',
      reason: `${without.length} of ${people.length} appraisers have no photograph on their record, so `
        + 'a branch expecting one of them has no way to know who turned up, and nobody dispatching '
        + 'them has ever seen their face. They can send one themselves from the app in a few '
        + 'seconds — it is the first item on their paperwork list.',
      assayerId: null,
      sourceAssayerCode: null,
    }];
  }

  /**
   * Check 14 — no phone number, among the people somebody can still be asked about.
   *
   * 7 findings through this check's own filter, 3 of them active; 13 records have no phone in
   * all, the other 6 belonging to people who have left. A roster arriving without a phone column
   * is expected and does not block admission — but an ACTIVE appraiser nobody can ring cannot be
   * offered work by phone, and that is a gap somebody has to close rather than discover on the
   * day.
   */
  private noPhone(people: AssayerEntity[]): Finding[] {
    return people
      .filter((p) => this.stillOnTheRoster(p) && String(p.phone ?? '').trim() === '')
      .map((p) => ({
        title: CHECK_TITLES.noPhone,
        suffix: p.assayerCode,
        rawValue: 'no phone number',
        reason: `${p.displayName ?? p.assayerCode} has no phone number, so nobody can ring them about a job`
          + `${p.lifecycleStatus === 'ACTIVE' ? ' — and they are active, so work can be offered to them today' : ''}.`
          + ' Add one on their record.',
        assayerId: p.id,
        sourceAssayerCode: p.assayerCode,
      }));
  }

  /**
   * Check 11 — aggregate: documents recorded as received while not one has EVER been verified
   * against its original. Its population is every document ticked received, scan kept or not;
   * check 15 counts the subset with no file, which is a different question.
   *
   * Live: 10,977 documents across 1,141 people, zero verified — the verification process has
   * simply never been operated, which is one fact, so one row. The moment a single document is
   * verified the condition is false and the row auto-closes; from then on the unverified
   * remainder is a workload, not a data defect.
   *
   * That count matches check 15's today only because not one of the 11,160 document rows has a
   * file attached, so its subset is the whole set. The two separate the moment one scan is
   * uploaded against a received document — and they did separate briefly, while a test record
   * carrying a scan existed, which is how this comment was caught quoting check 15's pair as its
   * own. The coincidence is not a licence to copy one into the other: measure each from its own
   * query before editing either.
   */
  private async documentsNeverVerified(): Promise<Finding[]> {
    const [received, verified] = await Promise.all([
      this.documents.count({ where: [{ softCopyReceived: true }, { hardCopyReceived: true }] }),
      this.documents.count({ where: { verificationStatus: DocumentVerification.VERIFIED } }),
    ]);
    if (received === 0 || verified > 0) return [];
    // Distinct people via SQL — no encrypted column is involved, and 11k rows are not worth
    // hauling into memory every 15 minutes for one COUNT(DISTINCT).
    const rows: Array<{ people: number }> = await this.issues.manager.query(
      'SELECT COUNT(DISTINCT assayer_id)::int AS people FROM assayer_documents '
      + 'WHERE soft_copy_received = true OR hard_copy_received = true',
    );
    const holders = Number(rows[0]?.people ?? 0);
    return [{
      title: CHECK_TITLES.docsNeverVerified,
      suffix: null,
      rawValue: 'received, never checked against an original',
      reason: `${received.toLocaleString('en-IN')} documents across ${holders.toLocaleString('en-IN')} people `
        + 'are recorded as received, and not one has ever been verified against its original. Worse, '
        + '"received" here does not even mean a scan was kept: almost every one of these was ticked on '
        + 'the old spreadsheet with no file attached, so there is nothing on screen to check against. '
        + 'Begin with PAN and Aadhaar for the people who '
        + 'enter vaults — each record has a verify action on its documents tab.',
      assayerId: null,
      sourceAssayerCode: null,
    }];
  }

  // ── Support ────────────────────────────────────────────────────────────────

  /**
   * Has this person left, by any of the ways this system records leaving?
   *
   * RESIGNED and TERMINATED are the obvious two. The third is not a lifecycle value at all: the
   * roster importer maps a Status cell containing "expired" to INACTIVE plus
   * `unavailableReason = DECEASED` (roster-import.service.ts ~813). Four such people exist, and
   * AS0055 has no leaving date of any kind — invisible to a check whose title says it finds
   * exactly that. ARCHIVED counts too: archiving is a departure that has been filed away.
   */
  /**
   * Is this a person somebody can still be asked to complete a record for?
   *
   * The three "go and fill this in" checks — no date of birth, no address, no phone — are only
   * work if the person is still on the roster. Measured on the live queue, 34 of the 101 no-DOB
   * findings named TERMINATED or RESIGNED people, each instructing a clerk to "enter it from their
   * PAN copy" for somebody who left the company. Those rows cannot be actioned and cannot be
   * dismissed, so they sit in the queue forever and bury the 67 that are real. A queue whose
   * stated value is "every entry needs a human decision" must not be a third filler.
   *
   * 101 − 34 = 67, and the queue agrees: `No date of birth` stands at 67 open against 34
   * auto-closed by this narrowing. The two numbers have to be read as one subtraction — quoting
   * the closed count beside a remainder that does not complete it is how a wrong figure survived
   * here before.
   *
   * The lifecycle CONTRADICTION checks (joined-after-left, left-with-no-date, left-but-empanelled)
   * deliberately do NOT use this — they are about departed people by definition.
   */
  private stillOnTheRoster(p: AssayerEntity): boolean {
    return !this.hasLeft(p);
  }

  /**
   * Delegated to `@fapoms/shared`, where the roster and the HR console read the same rule.
   *
   * This was one of three hand-written copies. The deceased arm reached this one and the SQL in
   * `hr-workforce.service.ts` and never reached the web app's, so a man recorded as having died
   * stayed on the roster's worklists asking a clerk to chase his bank details. Two copies being
   * right is what made it invisible.
   */
  private hasLeft(p: AssayerEntity): boolean {
    return hasLeftWorkforce(p);
  }

  /**
   * How to describe this person's departure in a sentence a clerk reads.
   *
   * `hasLeft` admits four ways of having gone, so a two-way TERMINATED/else split labelled the
   * other two wrong: an archived record and a person recorded as deceased both came out as
   * "is marked resigned". Telling HR that a dead colleague resigned is worse than saying nothing,
   * and it sent the clerk looking for a resignation letter that does not exist.
   */
  private leftWord(p: AssayerEntity): string {
    if (p.lifecycleStatus === AssayerLifecycleStatus.TERMINATED) return 'terminated';
    if (p.lifecycleStatus === AssayerLifecycleStatus.ARCHIVED) return 'archived';
    if (p.lifecycleStatus === AssayerLifecycleStatus.INACTIVE) return 'no longer with us';
    return 'resigned';
  }

  /**
   * Where the clerk should go looking for the missing date — which depends on how the person
   * left. There is no resignation letter for someone who died, and sending a clerk to find one
   * is both a dead end and a careless thing to put on their screen.
   */
  private whereTheLeavingDateLives(p: AssayerEntity): string {
    if (p.lifecycleStatus === AssayerLifecycleStatus.INACTIVE) {
      return 'Enter their last working day from whatever the branch recorded at the time.';
    }
    if (p.lifecycleStatus === AssayerLifecycleStatus.ARCHIVED) {
      return 'Enter their last working day from the file kept when the record was archived.';
    }
    return 'Find the date in the resignation or termination letter and enter it.';
  }

  /**
   * What the one-off date repair blanked, keyed by appraiser code — so "no leaving date" can
   * add "it was misread as 5481-01-01; the paper file has the real one". Read behind a
   * `to_regclass` guard: `_fix_backup_corrupt_dates` is a repair artifact, and production
   * service code must not hard-depend on it — if it is ever dropped, the findings stand and
   * only this clause quietly disappears.
   *
   * `onlyAssayerCode` narrows the second query to one row for the incremental path — the full
   * sweep still reads the whole (small, one-off) table.
   */
  private async loadRepairBackup(onlyAssayerCode?: string): Promise<RepairBackup> {
    const backup: RepairBackup = new Map();
    try {
      const guard: Array<{ t: string | null }> = await this.issues.manager.query(
        "SELECT to_regclass('public._fix_backup_corrupt_dates')::text AS t",
      );
      if (!guard[0]?.t) return backup;
      const rows: Array<{ assayer_code: string; old_date_of_birth: unknown; old_exit_date: unknown }> =
        await this.issues.manager.query(
          'SELECT assayer_code, old_date_of_birth, old_exit_date FROM _fix_backup_corrupt_dates'
          + (onlyAssayerCode ? ' WHERE assayer_code = $1' : ''),
          onlyAssayerCode ? [onlyAssayerCode] : [],
        );
      for (const row of rows) {
        backup.set(row.assayer_code, {
          dob: isoDay(row.old_date_of_birth as Dateish) ?? undefined,
          exit: isoDay(row.old_exit_date as Dateish) ?? undefined,
        });
      }
    } catch (error) {
      // The clause is a courtesy; the findings must not fail with it.
      this.logger.warn(`Could not read the date-repair backup table: ${(error as Error).message}`);
    }
    return backup;
  }
}

type RepairBackup = Map<string, { dob?: string; exit?: string }>;
