import {
  BadRequestException, Injectable, Logger } from '@nestjs/common'; import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work'; import { isUniqueViolation } from '../../infrastructure/database/unique-violation'; import { GeoPrecisionService } from '../geo/geo-precision.service'; import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service'; import { lookupIfsc } from '../geo/ifsc-lookup.helper'; import * as xlsx from 'xlsx'; import {   AssayerLifecycleStatus, Region, resolveRegion, readAvailability, readYesNo, readCibilBand, readBackgroundCheck, readEmpanelment, readPhoneNumbers, blankToNull, vocabularyKey, readHardCopyLocation, pincodeFromAddress, stateFromAddressAndPincode, canonicalStateName, canonicalState, readWorkingBanks, OnboardingDocument, ONBOARDING_DOCUMENT_COLUMNS, ONBOARDING_DOCUMENT_LABELS, EmpanelmentStatus, AssayerUnavailableReason, BackgroundCheckVerdict, CibilBand, PAN_PATTERN, AADHAAR_PATTERN, IFSC_PATTERN, isValidAadhaar, isPlaceholderAadhaar, looksMasked, canTransitionAssayerLifecycle, EventCategory,
} from '@fapoms/shared';
import {
  rowReader, parseSheet, describeMissingColumn, normaliseHeader, BLANK_HEADER, ParsedSheet,
} from '../../core/excel/sheet-reader';
import { AssayerEntity } from './assayer.entity';
import { AssayerService } from './assayer.service';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';
import { ClientEntity } from '../client/client.entity';
import { AuditService } from '../../core/audit/audit.service';

export interface RosterImportSummary {
  rowsRead: number;
  created: number;
  updated: number;
  skipped: number;
  references: number;
  onboardingDocuments: number;
  backgroundChecks: number;
  empanelments: number;
  issues: number;
  /**
   * Problems with the import as a whole rather than with a row.
   *
   * A missing client is one fact, not 697 of them: the first version recorded an issue per row
   * for the same absent bank and produced a review queue nobody could read. Anything that is
   * true of the run rather than of a person belongs here.
   */
  notes: string[];
  /** Set when the run was a rehearsal — nothing was written. */
  dryRun: boolean;
}

/**
 * The columns that identify a roster sheet, used to pick it out of a multi-sheet workbook.
 *
 * Scored, not required: a file missing one of these is still read as the roster if it is the best
 * candidate in the book. The hard requirement is an appraiser code, checked separately, because
 * that is the one column without which a row cannot become a person.
 */
const ROSTER_SIGNATURE_COLUMNS = [
  'Appraiser code', 'Appraiser Name', 'Residence Address', 'District', 'State',
];

/**
 * Every spelling of the one column a row cannot be placed without.
 *
 * One list, read by the prefetch and by the row loop, because those two must agree: the prefetch
 * decides who is already on the roster and the loop decides whether to insert, so a column the
 * prefetch cannot see but the loop can is a row that gets inserted on top of a person who is
 * already there. `normaliseHeader` folds the case, so `Appraiser Code` and `Appraiser code` are
 * one entry here even though the file writes both.
 */
const CODE_COLUMNS = ['Appraiser code', 'Assayer code'] as const;

/**
 * The same column's spellings again, for the "this is not a roster" message.
 *
 * Longer than `CODE_COLUMNS` on purpose: this list is printed back to the operator as "Looked
 * for: …", and the capitalisations they actually type belong in that sentence even though
 * `normaliseHeader` makes them one key for matching.
 */
const CODE_ALIASES = ['Appraiser code', 'Assayer code', 'Appraiser Code', 'Assayer Code'];

/**
 * What a date on this sheet is FOR, which is what decides how far ahead it may plausibly sit.
 * See `isPlausibleHumanDate` — a joining or exit date may be years ahead, a birth date may not
 * be ahead at all, and one window for both was letting future birth dates through.
 */
type DateKind = 'birth' | 'employment';

/**
 * Matches the data-integrity scan's own future window, so the two cannot disagree about the same
 * value. Narrower here meant the importer refused a date the scan considered entirely plausible.
 */
const FUTURE_EMPLOYMENT_YEARS = 5;

/**
 * A date cell Excel never formatted as a date arrives as its underlying day count.
 *
 * Excel stores dates as days since 1899-12-30 (that epoch, and not the 31st, absorbs the
 * fictitious 29 February 1900 the format has carried since Lotus). A cell holding a real date
 * reaches the reader as a `Date` — but only when the sheet marked the cell as a date. Where the
 * column was left as General or Number, the same value arrives as the bare integer, and
 * `new Date("44200")` reads a bare number as a YEAR, so it became the year 44200 and was refused
 * as "not a real date for a person". On the live 1,155-person roster that silently discarded
 * **159 dates**: 75 dates of birth, 58 joining dates and 26 exit dates.
 *
 * Five digits, deliberately, and nothing shorter. A four-digit number in a date column is far
 * more likely a year ("1974") or a code, and as a serial it would mean 1902-1927 — a range no
 * living employee's birth or joining date occupies, so reading it as a date could only ever be
 * wrong. Every one of the 159 real values was five digits, spanning 22859 (25 Jul 1962, a date of
 * birth) to 46362 (3 Nov 2026, an exit date).
 *
 * The result is not trusted on its own: it goes back through `isPlausibleHumanDate` with every
 * other shape, so a five-digit code that is not a date lands outside the window and still becomes
 * a review item rather than a confident wrong answer.
 */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const excelSerialToDate = (serial: number): Date | null => {
  const utc = new Date(EXCEL_EPOCH_UTC + Math.floor(serial) * 86400000);
  if (Number.isNaN(utc.getTime())) return null;
  // Rebuilt from the UTC fields as a LOCAL midnight — the rest of this file compares dates by
  // local calendar fields (see `dayNumber`), and a UTC midnight is the previous day in IST.
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
};

/**
 * yyyymmdd from the LOCAL fields, never `toISOString()`: this deployment runs in IST, where
 * converting a local midnight back to UTC lands on the previous day and would make "is this in
 * the future" flip for every date between midnight and 05:30.
 */
const dayNumber = (d: Date): number =>
  d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

/** 'YYYY-MM-DD' from the same local fields, for a message a person reads. */
const isoOf = (d: Date): string => `${String(d.getFullYear()).padStart(4, '0')}`
  + `-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Bring the appraiser roster spreadsheet in.
 *
 * The file is the workforce master kept by hand for years, and the reading of its vocabulary
 * lives in `@fapoms/shared` — see `readAvailability` and its neighbours for why one column
 * needed three fields. This service is the other half: matching rows to people, spreading them
 * across the tables that now hold them, and recording what it could not read.
 *
 * Three rules it holds throughout.
 *
 * **The assayer code is the identity.** 1,155 codes, no duplicates, and every code used by the
 * client sheets exists in the roster — so it is a real key and re-running the import updates
 * rather than duplicating. A row without one cannot be placed and is recorded as an issue.
 *
 * **Nothing is guessed.** A cell the vocabulary cannot read is written to
 * `assayer_import_issues` with its original text and the row it came from. The row still
 * imports: refusing it would lose a real appraiser over one bad cell, and inventing a value
 * would write a fact nobody asserted into a record that decides who enters a bank vault.
 *
 * **A rehearsal is possible.** `dryRun` performs the entire import inside a transaction it then
 * rolls back, because the first thing anybody sensibly wants to know about an import of 1,155
 * people is what it is going to do. It writes what a real run writes — an earlier version
 * counted instead of writing and reported a clean rehearsal for an import that then failed on
 * its first insert, which is a rehearsal of the reader rather than of the import.
 */
@Injectable()
export class RosterImportService {
  private readonly logger = new Logger(RosterImportService.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly geoPrecision: GeoPrecisionService,
    private readonly platformSettings: PlatformSettingsService,
    // Optional so the many existing unit specs that construct this service with three mocked
    // collaborators keep compiling; DI always supplies the real one. Every call site guards
    // with `?.` for the same reason.
    private readonly auditService?: AuditService,
    /**
     * Runs a legal lifecycle move through `bulkTransitionLifecycle` after the row is saved, so
     * a sheet-implied departure gets the same departure-date reconciliation, empanelment
     * close-out and audit trail an HR-initiated transition gets — not just a status column
     * flip. Optional for the same reason as `auditService`: existing specs construct this
     * service without it, and every call site guards with `?.`.
     */
    private readonly assayerService?: AssayerService,
  ) {}

  /**
   * What this workbook is and how big it is — read from the file, and nothing else.
   *
   * For the caller that only needs to say "this roster has 1,155 rows, it is running in the
   * background" and to refuse an unreadable or wrong file on the spot. That caller used to get
   * those two facts by running a full `dryRun`, which is not a parse: a rehearsal performs the
   * *entire* import inside a transaction and rolls it back — about ten writes per row, so some
   * eleven thousand sequential statements for the real roster, on the request thread, holding a
   * pool connection and taking row locks on `assayers` the whole time. Then the queued worker did
   * all of it again for real. This does the parsing, which is the part that answers the question.
   *
   * Opens no transaction and issues no query.
   *
   * The rehearsal an operator explicitly asks for is a different thing and stays as it is: it
   * writes exactly what a real run writes and rolls it back, because "what will this do to my
   * data" cannot be answered by reading the file.
   *
   * @throws BadRequestException when the workbook has no readable sheet, or no appraiser-code
   *   column — the same messages, from the same guard, that `importAssayerSheet` refuses with.
   */
  inspectSheet(
    file: Buffer,
    sheetName?: string,
  ): { sheetName: string; rowsRead: number; headers: string[] } {
    const { parsed } = this.resolveRosterSheet(file, sheetName);
    return { sheetName: parsed.sheetName, rowsRead: parsed.rows.length, headers: parsed.headers };
  }

  /**
   * Find the roster wherever it is, rather than demanding a sheet called "Assayers".
   *
   * This read `workbook.Sheets['Assayers']` and threw a bare `Error` when there wasn't one — a
   * **500**, so the operator got "Internal server error" and the sentence naming the sheets that
   * *were* in their file went to the server log. The real client workbook does not have a sheet
   * by that name: the branch list comes first and the roster sheet is called `Assayer ` — with a
   * trailing space. So the everyday file failed with an unreadable error.
   *
   * `parseSheet` scores every sheet against the columns a roster carries and also finds a header
   * row that is not row 1 (a client file with a merged title above the table). It is the same
   * reader the deleted `/assayers/upload` importer used, which is where this problem had already
   * been solved once. An explicit `sheetName` still wins, for a caller that knows better.
   *
   * One implementation, called by both the import and the parse-only inspection. Two copies of a
   * file-recognition guard drift, and the way they drift is that the cheap pre-flight accepts a
   * workbook the import then refuses — after the operator has been told it was queued.
   */
  private resolveRosterSheet(
    file: Buffer,
    sheetName?: string,
  ): { sheet: xlsx.WorkSheet; parsed: ParsedSheet } {
    const workbook = xlsx.read(file, { type: 'buffer', cellDates: true });

    const parsed: ParsedSheet = sheetName && workbook.Sheets[sheetName]
      ? {
          sheetName,
          headerRow: 1,
          headers: Object.keys(
            (xlsx.utils.sheet_to_json<Record<string, any>>(workbook.Sheets[sheetName])[0] ?? {}),
          ),
          rows: xlsx.utils.sheet_to_json<Record<string, any>>(workbook.Sheets[sheetName], { defval: null }),
        }
      : parseSheet(file, ROSTER_SIGNATURE_COLUMNS);

    const sheet = workbook.Sheets[parsed.sheetName];
    if (!sheet) {
      throw new BadRequestException(
        `This workbook has no readable sheet. Sheets found: ${workbook.SheetNames.join(', ') || '(none)'}.`,
      );
    }

    /**
     * There is no appraiser-code *column*, so this is not a roster.
     *
     * Refused as a 400 carrying the headers the file actually has — and, when the file is
     * recognisably one of the other importers' templates, the screen it belongs on. A branch list
     * read as a roster creates people named after branches, which is why this guard is worth more
     * than the rows it costs.
     *
     * Judged on the header, not on whether any row has a value under it. A roster whose rows are
     * all missing their code is a roster with bad rows — each one is reported individually, with
     * its row number — whereas a file with no such column at all is the wrong file. Testing the
     * values conflates the two, and refuses a one-row sheet whose single code is blank.
     */
    const wanted = new Set(CODE_ALIASES.map(normaliseHeader));
    if (!parsed.headers.some((h) => wanted.has(normaliseHeader(h)))) {
      throw new BadRequestException(
        describeMissingColumn('Appraiser code', CODE_ALIASES, parsed, 'assayer-roster'),
      );
    }

    return { sheet, parsed };
  }

  async importAssayerSheet(
    file: Buffer,
    actorId: string,
    options: { dryRun?: boolean; sheetName?: string; overwrite?: boolean; fileName?: string } = {},
  ): Promise<RosterImportSummary> {
    const dryRun = options.dryRun ?? false;
    // Default OFF: a sheet value that disagrees with what is already on file is filed as a
    // review issue rather than applied. See `resolveOverwritableField`.
    const overwrite = options.overwrite ?? false;

    const { sheet, parsed } = this.resolveRosterSheet(file, options.sheetName);
    const sheetName = parsed.sheetName;
    const rows: Record<string, any>[] = parsed.rows;

    // Whether this file carries an availability/status column at all. `read()` cannot tell "no
    // such column" apart from "this row's cell in it is blank" — both come back as `''` — so the
    // "blank cell on a new row needs review" rule below has to be decided from the header list,
    // not from a single row's read. A file that never had the column (a partial PAN-only
    // correction sheet, say) is not the same problem as a roster that has the column and left
    // one row empty.
    const hasAvailabilityColumn = parsed.headers.some((h) => {
      const key = normaliseHeader(h ?? '');
      return key === normaliseHeader('Active / Inactive') || key === normaliseHeader('Active/Inactive')
        || key === normaliseHeader('Status');
    });

    /**
     * Every column heading this import actually looks at, recorded as it reads.
     *
     * A heading the importer does not recognise is silently dropped, and the summary still reports
     * success — proved on the live stack: a sheet headed `Aadhaar Number` (the importer reads
     * `Aadhar Card Number`) imported all six rows, reported "created 6, skipped 0", and discarded
     * every Aadhaar number without a word. On a 1,155-person roster that is 578 government IDs
     * gone, with nothing on screen to suggest it. Recorded from the real `read(...)` call sites
     * rather than a hand-kept list, so the two can never disagree.
     */
    const askedFor = new Set<string>();

    /**
     * Hyperlink cells hold their URL in the cell's link attribute, not its text —
     * `sheet_to_json` returns "Vijay Varma, Amravati - Google Drive" where the actual Drive
     * URL lives in `.l.Target`. For the one column that IS a link, walk the sheet directly
     * and put the target where the reader will find it; the display text is not the fact.
     */
    try {
      const range = xlsx.utils.decode_range(sheet['!ref'] ?? 'A1');
      // The header is wherever the reader found it, not necessarily the first row of the range —
      // a client file with a merged title above the table puts it lower down.
      const headerRowIndex = range.s.r + (parsed.headerRow - 1);
      for (let c = range.s.c; c <= range.e.c; c++) {
        const header = String(sheet[xlsx.utils.encode_cell({ c, r: headerRowIndex })]?.v ?? '').trim().toLowerCase();
        if (header !== 'link for document' && header !== 'link for documents') continue;
        for (let r = headerRowIndex + 1; r <= range.e.r; r++) {
          const target = (sheet[xlsx.utils.encode_cell({ c, r })] as any)?.l?.Target;
          const rowObj = rows[r - headerRowIndex - 1];
          if (target && rowObj) rowObj['Link for Document'] = target;
        }
      }
    } catch { /* a malformed range only costs the links, never the import */ }

    const summary: RosterImportSummary = {
      rowsRead: rows.length, created: 0, updated: 0, skipped: 0,
      references: 0, onboardingDocuments: 0, backgroundChecks: 0, empanelments: 0,
      issues: 0, notes: [], dryRun,
    };

    /** Everyone a real run saved — handed to the geo precision queue after the commit. */
    const importedIds: string[] = [];

    /**
     * Legal lifecycle moves the sheet implies for existing records, run through
     * `bulkTransitionLifecycle` after this transaction commits — see the constructor's
     * `assayerService` docblock for why that has to happen outside this transaction rather
     * than as a plain field write here.
     */
    const pendingTransitions: { id: string; to: AssayerLifecycleStatus }[] = [];

    // Whether a bank named in the roster but unknown to this system becomes a client stub on
    // the spot. Default ON: "create the client yourself and re-import" turned out to mean the
    // per-bank data was simply lost until someone did, and the roster names ~20 lenders.
    const autoCreateClients =
      (await this.platformSettings.get<boolean>('roster.autoCreateClients').catch(() => true)) !== false;

    /**
     * The same PAN, phone or email under two different appraiser codes is almost always one
     * person who was registered twice (the file really has these: an AS-series and an AD-series
     * code sharing all three). Noted for a human — never auto-merged: two brothers can share a
     * phone, and a merge that guesses wrong destroys a real person's history.
     */
    const identitySeen: Record<string, Map<string, string>> = {
      PAN: new Map(), phone: new Map(), email: new Map(),
    };
    const duplicatePairs = new Map<string, Set<string>>();

    /**
     * Every row's appraiser code, read once, before anything touches the database.
     *
     * Read here and nowhere else so the prefetch below and the loop can never disagree about
     * what a row's code is: a prefetch that reads `Assayer code` while the loop reads
     * `Appraiser code` looks like a cache miss and inserts a second record for somebody who is
     * already there.
     */
    // `askedFor` here too, not just in the row loop: the appraiser-code aliases are read only
    // in this pre-pass, so leaving it out made the importer's own key column report itself as
    // unrecognised — a false positive on the one column that is never optional.
    const rowCodes = rows.map((row) => blankToNull(rowReader(row, askedFor)(...CODE_COLUMNS)));

    await this.uow.run(async (manager) => {
      // A full 1,155-row commit does ~10 writes per row inside this single transaction, and under
      // concurrent load a contested-row insert can cross the global 30s statement_timeout and be
      // cancelled ("canceling statement due to statement timeout" → a 500 the operator sees as a
      // failed import, even though the rehearsal passed). Lift the per-statement cap for THIS
      // transaction only: SET LOCAL is scoped to the transaction and reverts on commit/rollback,
      // so the interactive 30s default still guards every other query. Bounded generously (5 min)
      // rather than disabled, so a genuinely stuck statement still fails eventually.
      await manager.query("SET LOCAL statement_timeout = '300s'");

      // Resolved once, inside the transaction so it reads the same snapshot the import writes
      // against: a lookup per row over 1,155 rows would be 1,155 queries for two answers.
      const clients = await this.buildClientResolver(manager, autoCreateClients, actorId);

      /**
       * Everyone in this file who is already on the roster, in one query instead of one per row.
       *
       * This was a `findOne` per row inside the loop: the real 1,155-row roster asked the
       * database 1,155 times for an answer a single `IN (…)` gives, and every one of those was a
       * round trip the operator waited through. Same read, same key, one query.
       *
       * **No `isActive` filter**, deliberately, and the same decision the branch importer
       * records: the per-row `findOne` had none either, and the assayer code is the identity
       * (see this class's doc comment) — re-importing the roster is meant to update the person
       * it names *even when their record has been deactivated*. Filtering would hide the
       * deactivated record here, the insert below would then mint a second one under the same
       * code, and the unique index would refuse it — so a deactivated appraiser would break the
       * import of everyone after them.
       *
       * The map is kept current as rows land, because a file that names the same code twice must
       * update that person twice, exactly as the per-row read did — the second read saw the row
       * the first had just inserted, and a map that never learns would try to insert them again.
       *
       * Written through the manager's query builder rather than `find({ assayerCode: In(codes) })`
       * because `In` would mean importing TypeORM into this service, and
       * `persistence-boundary.spec.ts` records this file as deliberately free of that — it reaches
       * every table through the transaction manager it is handed. Same `IN (…)`, one query.
       */
      const codesInFile = [...new Set(rowCodes.filter((c): c is string => !!c))];
      /**
       * The organisation every row of this import belongs to, resolved from the person who
       * started it.
       *
       * NOT from the ambient request context, and that is the point. A roster import is queued:
       * `RosterImportWorker` runs it in a Bull job, where there is no request and no principal to
       * read a tenant off. `TenantContext` says exactly this — "Background work that touches
       * tenant-owned data must carry the organisation id explicitly in its job payload and pass it
       * down" — and `actorId` is what this job carries, so the organisation is looked up from the
       * actor once per import rather than guessed per row.
       *
       * Without it, every imported assayer would be written with a null organisation. Nothing
       * would error: the rows would save, the summary would report success, and they would be
       * invisible to every scoped read from that moment on — the roster would simply not grow.
       * That is the failure mode this whole change has to avoid, and the import is the path that
       * created 1,155 of the 1,172 people on this system.
       */
      const actorOrgRows: Array<{ organization_id: string | null }> = await manager.query(
        'SELECT organization_id FROM users WHERE id = $1',
        [actorId],
      );
      const owningOrganizationId = actorOrgRows?.[0]?.organization_id ?? null;

      const existingByCode = new Map<string, AssayerEntity>();
      if (codesInFile.length) {
        const qb = manager
          .createQueryBuilder(AssayerEntity, 'assayer')
          .where('assayer.assayerCode IN (:...codes)', { codes: codesInFile });
        // Matched within the importer's own organisation. A code that exists but belongs to
        // somebody else is not "this person, update them" — it is a collision, and it is handled
        // as one further down: the insert hits the database-wide UNIQUE constraint on
        // `assayer_code` and the row is filed as a review issue instead of quietly overwriting
        // another organisation's appraiser with a stranger's details.
        if (owningOrganizationId) {
          qb.andWhere('assayer.organizationId = :__importOrgId', { __importOrgId: owningOrganizationId });
        }
        const found: AssayerEntity[] = await qb.getMany();
        for (const person of found) existingByCode.set(person.assayerCode, person);
      }

      for (const [index, row] of rows.entries()) {
        // +2: one for the header, one because a spreadsheet's first data row is row 2 to the
        // person who will go and look at it.
        const sourceRow = index + 2;
        const read = rowReader(row, askedFor);
        const issues: Partial<AssayerImportIssueEntity>[] = [];

        /**
         * Data in a column with no header is invisible to a reader that goes by header names —
         * and the real file HAS such cells: a nameless column far to the right carries staff
         * judgments like "He will not do audits properly". Silently losing those is worse than
         * refusing them; each becomes a review issue naming the cell, so somebody titles the
         * column and re-imports.
         */
        for (const [k, v] of Object.entries(row)) {
          if (k.startsWith('__EMPTY') && blankToNull(v)) {
            issues.push({
              sourceSheet: sheetName, sourceRow, sourceColumn: `(unheadered column ${k.replace('__EMPTY', '').replace('_', '') || '1'})`,
              rawValue: String(v).slice(0, 500),
              reason: 'Data in a column with no header — give the column a title so this can be read in.',
            });
          }
        }

        const code = rowCodes[index];
        if (!code) {
          issues.push({
            sourceSheet: sheetName, sourceRow, sourceColumn: 'Appraiser code',
            rawValue: String(row['Appraiser code'] ?? ''),
            reason: 'No appraiser code, so this row cannot be matched to a person.',
          });
          summary.skipped++;
          summary.issues += issues.length;
          await this.saveIssues(manager, issues, null, null);
          continue;
        }

        const existing = existingByCode.get(code) ?? null;
        // Stamped on creation, never on update: an existing row keeps the organisation it already
        // has, so an import run by one organisation cannot re-home another's records.
        const assayer = existing
          ?? manager.create(AssayerEntity, { assayerCode: code, organizationId: owningOrganizationId });
        const isNew = !existing;

        this.applyIdentity(assayer, read, sourceRow, sheetName, issues, overwrite);
        await this.applyContact(assayer, read, sourceRow, sheetName, code, issues, overwrite);
        this.applyEmployment(
          assayer, read, sourceRow, sheetName, code, issues, isNew, overwrite, hasAvailabilityColumn,
          pendingTransitions,
        );

        this.fillRequiredBlanks(assayer);

        // A rehearsal writes exactly what a real run writes; the rollback at the end is the only
        // difference. The first version skipped the writes and counted instead, and reported a
        // clean 1,155-row rehearsal for an import that then failed on the first insert — the
        // rehearsal was checking the reader, not the import.
        assayer.updatedBy = actorId;
        if (isNew) assayer.createdBy = actorId;

        if (isNew) {
          const landed = await this.insertContestedRow(manager, assayer);
          if (!landed) {
            /**
             * Somebody else inserted this appraiser code between the prefetch and this insert.
             *
             * One row's collision, reported as one row. Before this the unique index threw
             * straight out of the loop, so a second operator importing the same workbook at the
             * same moment — or a queued job re-run after a restart — killed the whole import and
             * rolled back every person who had already landed. The winner's record is real; this
             * row has nothing left to insert, and re-running the import brings its details in as
             * an update.
             */
            issues.push({
              sourceSheet: sheetName, sourceRow, sourceColumn: 'Appraiser code', rawValue: code,
              reason: 'Another import created this appraiser code while this one was running, so this '
                + 'row was not applied. Run the import again to bring its details in as an update.',
            });
            summary.skipped++;
            summary.issues += issues.length;
            await this.saveIssues(manager, issues, null, code);
            continue;
          }
        } else {
          await manager.save(AssayerEntity, assayer);
        }

        // Kept current so a file naming the same code twice updates that person the second time
        // rather than inserting them again — what the per-row read did, since it saw the row this
        // transaction had just written.
        existingByCode.set(code, assayer);
        if (isNew) summary.created++;
        else summary.updated++;

        const assayerId = assayer.id;
        importedIds.push(assayerId);
        summary.references += await this.applyReferences(manager, assayerId, read);
        summary.onboardingDocuments += await this.applyOnboardingDocuments(manager, assayerId, read);
        summary.backgroundChecks += await this.applyBackgroundCheck(
          manager, assayerId, read, sourceRow, sheetName, code, issues,
        );
        summary.empanelments += await this.applyEmpanelments(
          manager, assayerId, read, clients, sourceRow, sheetName, code, issues,
        );
        summary.empanelments += await this.applyWorkingBanks(manager, assayerId, read, clients);

        /**
         * A collision goes into the review queue, not only into the summary's notes.
         *
         * The notes were the whole of it, and that is where the finding died. For a real import —
         * which is queued — the notes exist only as the background job's return value: rendered
         * once into a banner, on a page the operator is explicitly told they can leave, and kept
         * for 24 hours. The rehearsal does show notes in the confirm dialog, but truncated to the
         * first four, behind the client-stub and ambiguous-bank notes that the real roster's ~20
         * lenders generate. So the one finding that requires two records to be compared by hand
         * was the one most likely never to be read, and there was nothing to re-open, search, or
         * close once it scrolled away. `assayer_import_issues` is the queue that survives the
         * page, and `saveIssues` keeps one entry per finding however often the file is imported.
         *
         * `sourceColumn` says "Duplicate PAN" rather than "PAN Number" because `saveIssues`
         * dedupes on (sheet, row, column): a row can carry both an unreadable-cell issue and a
         * collision on the same column — an email cell holding two addresses whose first one is
         * also somebody else's — and one must not silently overwrite the other.
         *
         * `rawValue` carries the two appraiser codes, never the shared PAN, phone or email
         * itself. Which two records to compare is the fact a person needs; the identity number is
         * not, and this queue is rendered on screen and grouped by that text.
         */
        for (const [kind, value] of [
          ['PAN', assayer.panNumber], ['phone', assayer.phone], ['email', assayer.email],
        ] as const) {
          if (!value) continue;
          const key = String(value).toLowerCase();
          const holder = identitySeen[kind].get(key);
          if (holder && holder !== code) {
            const pair = [holder, code].sort().join(' and ');
            (duplicatePairs.get(pair) ?? duplicatePairs.set(pair, new Set()).get(pair)!).add(kind);
            issues.push({
              sourceSheet: sheetName, sourceRow, sourceColumn: `Duplicate ${kind}`, rawValue: pair,
              reason: `${holder} carries the same ${kind} as ${code}. That is usually one person `
                + 'registered under two codes — compare both records and retire one. Nothing was '
                + 'merged: two people really can share a phone, and a merge that guesses wrong '
                + "destroys a real person's history.",
            });
          } else if (!holder) {
            identitySeen[kind].set(key, code);
          }
        }

        summary.issues += issues.length;
        if (issues.length) await this.saveIssues(manager, issues, assayerId, code);
      }

      for (const [pair, kinds] of duplicatePairs) {
        summary.notes.push(
          `${pair} share the same ${[...kinds].join(', ')} — likely one person registered under two codes. `
          + `Review both records and retire one; nothing was merged automatically.`,
        );
      }

      clients.flushNotes(summary, dryRun);

      /**
       * Name the columns nobody read, so a renamed heading cannot cost a field in silence.
       *
       * Only columns that actually carry data are reported: a spreadsheet's trailing empty
       * columns are normal and naming them would bury the one that matters. And the column is
       * NAMED, never fuzzy-matched into a field — guessing is how the wrong column lands in the
       * right-looking place.
       */
      for (const header of parsed.headers) {
        if (!header || BLANK_HEADER.test(header)) continue;
        if (askedFor.has(normaliseHeader(header))) continue;
        const carrying = rows.filter((r) => String(r?.[header] ?? '').trim() !== '').length;
        if (carrying === 0) continue;
        summary.notes.push(
          `Column "${header}" was not recognised, so ${carrying} row(s) of data in it were not imported. `
          + `If that column holds something this system stores, rename its heading to the one the `
          + `template uses and import again — nothing was guessed.`,
        );
      }

      if (dryRun) {
        // Everything above ran against the real tables; rolling back is what makes it a
        // rehearsal rather than a promise.
        throw new DryRunComplete();
      }
    }).catch((err) => {
      if (!(err instanceof DryRunComplete)) throw err;
    });

    /**
     * Run the transitions queued above through `bulkTransitionLifecycle`, grouped by target
     * status so a sheet reporting the same move for many rows makes one call per status rather
     * than one per person. Each id was already checked reachable by `canTransitionAssayerLifecycle`
     * before being queued, so a skip or failure here means something changed between that check
     * and this call (e.g. another transition landed on the same person in between) — rare enough
     * that it is logged rather than re-filed as a per-row issue, since the row context (sheet,
     * column, raw cell value) that `saveIssues` keys on is gone by this point in the run.
     * A rehearsal never reaches here: `dryRun` throws `DryRunComplete` before this line, so the
     * queued moves were checked for reachability but never actually run.
     */
    if (!dryRun && pendingTransitions.length > 0 && this.assayerService) {
      const idsByTarget = new Map<AssayerLifecycleStatus, string[]>();
      for (const { id, to } of pendingTransitions) {
        const ids = idsByTarget.get(to) ?? [];
        ids.push(id);
        idsByTarget.set(to, ids);
      }
      for (const [to, ids] of idsByTarget) {
        const result = await this.assayerService.bulkTransitionLifecycle(
          ids, to, actorId,
          `Roster import from ${options.fileName ?? 'an uploaded file'}: the sheet reports a move to ${to}.`,
        );
        // Not added to `summary.updated`: every id here is an existing row already counted
        // there when its own save landed (line ~470) — this only reports transitions that
        // did not land as this run expected.
        for (const { id, current, reason } of result.skipped) {
          this.logger.warn(`Roster import: queued transition of ${id} to ${to} was skipped after the row saved (${current}, ${reason}).`);
        }
        for (const { id, reason } of result.failed) {
          this.logger.warn(`Roster import: queued transition of ${id} to ${to} failed after the row saved: ${reason}`);
        }
      }
    }

    // Freshly imported people get coordinates now, not at the 03:30 nightly sweep — the same
    // hand-off the branch importer makes. The worker's own query skips rows already precise and
    // never touches manual pins, so enqueueing everyone saved is safe. Fire-and-forget: if the
    // queue is down the nightly sweep still catches them. A rehearsal rolled its rows back, so
    // it hands off nothing.
    if (!dryRun && importedIds.length > 0) {
      void this.geoPrecision.enqueueBackfill('assayer', importedIds, 'roster import');
    }

    // One row per real run, not per person — the per-row facts already land as their own
    // events (or issues) as they happen; this is the run-level record HR asks for later:
    // who ran which file, when, and what it did in aggregate. A rehearsal writes nothing, so
    // it gets no row either.
    if (!dryRun) {
      await this.auditService?.recordEventSafe({
        category: EventCategory.OPERATIONAL,
        eventType: 'ROSTER_IMPORT_APPLIED',
        entityType: 'ASSAYER_ROSTER_IMPORT',
        entityId: sheetName,
        userId: actorId,
        remarks: `Roster import from ${options.fileName ?? 'an uploaded file'}: `
          + `${summary.created} created, ${summary.updated} updated, ${summary.skipped} skipped, `
          + `${summary.issues} issue(s) filed.`,
        metadata: {
          fileName: options.fileName ?? null,
          sheetName,
          rowsRead: summary.rowsRead,
          created: summary.created,
          updated: summary.updated,
          skipped: summary.skipped,
          issues: summary.issues,
          references: summary.references,
          onboardingDocuments: summary.onboardingDocuments,
          backgroundChecks: summary.backgroundChecks,
          empanelments: summary.empanelments,
        },
      });
    }

    this.logger.log(
      `Roster import${dryRun ? ' (rehearsal)' : ''}: ${summary.rowsRead} rows, `
      + `${summary.created} created, ${summary.updated} updated, ${summary.skipped} skipped, `
      + `${summary.issues} needing review.`,
    );
    return summary;
  }

  /**
   * Insert an appraiser the prefetch said was absent, surviving the case where they were not.
   *
   * Reading and then inserting is not one act: a second import of the same workbook — two
   * operators, or a queued job re-run — reads the same gap and both aim at it. `assayer_code` is
   * UNIQUE, so the data stays correct either way; what was wrong is that the loser threw out of
   * the row loop and took the whole import down with it, rolling back the hundreds of people who
   * had already landed. `false` here means "somebody else got there first", and the caller
   * reports that row.
   *
   * **The savepoint is the part that actually makes this recoverable.** The whole import is one
   * transaction, and a Postgres error aborts it: without the savepoint, catching 23505 would only
   * change which error killed the import, because the very next statement fails with 25P02
   * (`current transaction is aborted`). Rolling back to the savepoint restores a usable
   * transaction and the loop carries on.
   *
   * Taken only around an insert, and only for a row the prefetch says is new — so a re-import of
   * the maintained 1,155-person roster, where every code already exists, takes none at all.
   *
   * Matched on SQLSTATE alone rather than by constraint name: the uniqueness comes from
   * `@Column({ unique: true })` on `assayerCode`, so the index carries a TypeORM-generated `UQ_`
   * hash that no caller can name. `assayer_code` is the only unique column this importer writes,
   * which is what makes the bare code unambiguous here.
   */
  private async insertContestedRow(manager: any, assayer: AssayerEntity): Promise<boolean> {
    await manager.query('SAVEPOINT roster_row');
    try {
      await manager.save(AssayerEntity, assayer);
    } catch (err) {
      await manager.query('ROLLBACK TO SAVEPOINT roster_row');
      if (isUniqueViolation(err)) return false;
      throw err;
    }
    await manager.query('RELEASE SAVEPOINT roster_row');
    return true;
  }

  // ── The person ───────────────────────────────────────────────────────────

  /**
   * The columns the assayers table refuses to be null, for rows the sheet leaves blank.
   *
   * These are NOT NULL because the create-an-assayer form asks for them, and a roster row
   * missing an address is a real appraiser with an incomplete record rather than a bad row.
   * Blank is the honest value: `missingAssayerRecordFields` counts whitespace as missing, so the
   * record lands in the same incomplete-file list HR already works through. Refusing the row
   * would lose the person; inventing an address would put a fiction on a KYC record.
   */
  private fillRequiredBlanks(a: AssayerEntity): void {
    a.displayName = a.displayName || a.assayerCode;
    a.firstName = a.firstName || '';
    a.lastName = a.lastName || '';
    a.address = a.address || '';
    a.city = a.city || '';
    a.district = a.district || '';
    a.state = a.state || '';
  }

  private applyIdentity(
    a: AssayerEntity, read: ReturnType<typeof rowReader>,
    sourceRow: number, sheet: string, issues: Partial<AssayerImportIssueEntity>[],
    overwrite: boolean,
  ): void {
    const fullName = blankToNull(read('Appraiser Name', 'Assayer Name', 'Name'));
    if (fullName) {
      a.displayName = fullName;
      const parts = fullName.split(/\s+/).filter(Boolean);
      // The sheet holds one name field. Splitting on the last word is how the existing
      // assayer importer does it, and keeping the whole string in `displayName` means nothing
      // is lost to a bad split.
      a.firstName = a.firstName || (parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0]) || fullName;
      a.lastName = a.lastName || (parts.length > 1 ? parts[parts.length - 1] : parts[0]) || fullName;
    }
    /**
     * Identity numbers are format-checked before they are stored. On the real roster the
     * Aadhaar column doubles as a status note — 129 cells hold the word "Inactive" — and the
     * first version of this importer stored those words verbatim, encrypted, as Aadhaar
     * numbers. A wrong shape goes to review, never into an identity field.
     *
     * The shapes themselves live in `@fapoms/shared` now, because these same rules gate
     * `POST/PUT /assayers`: an importer and an API that disagree about what a PAN looks like
     * would let the form store what the import refuses.
     */
    a.panNumber = this.resolveOverwritableField(
      a.panNumber,
      this.readShaped(read('PAN Number'), PAN_PATTERN,
        'Not a PAN (expected five letters, four digits, one letter).',
        { issues, sourceRow, sheet, column: 'PAN Number' }),
      overwrite,
      { issues, sourceRow, sheet, column: 'PAN Number', label: 'PAN' },
    );
    {
      /**
       * Aadhaar in three steps: shape (report-don't-throw, as every cell here), then the
       * all-same-digit placeholder, then the Verhoeff checksum every genuine Aadhaar carries.
       * Twelve digits that fail the checksum are a mistyped or invented number — under the
       * length-only rule they were stored as identities and surfaced years later as KYC records
       * matching nobody. Now the row goes to review while the person is still imported; an
       * existing stored value is kept, exactly as for an unreadable cell.
       *
       * The placeholder branch exists because `999999999999` PASSES Verhoeff (see
       * `isPlaceholderAadhaar`), so the single likeliest junk value in this column would
       * otherwise be reported as a checksum failure and send the clerk to re-read a card
       * against a number where no digit is wrong. It is a blank field, not a typo, and the
       * reason has to say so or the trip to the filing cabinet is wasted.
       */
      const shaped = this.readShaped(read('Aadhar Card Number', 'Aadhaar Card Number'), AADHAAR_PATTERN,
        'Not an Aadhaar number (expected 12 digits).',
        { issues, sourceRow, sheet, column: 'Aadhar Card Number' });
      if (shaped !== null && !isValidAadhaar(shaped)) {
        issues.push({
          sourceSheet: sheet, sourceRow, sourceColumn: 'Aadhar Card Number', rawValue: shaped,
          reason: isPlaceholderAadhaar(shaped)
            ? 'Twelve identical digits — that looks like a placeholder rather than a real Aadhaar number. The number was never filled in, so it has to be found from the card, not corrected.'
            : 'Twelve digits, but not a real Aadhaar number — the checksum fails, so a digit is mistyped or swapped. Please re-read it from the card.',
        });
        a.aadhaarNumber = a.aadhaarNumber ?? null;
      } else {
        a.aadhaarNumber = shaped ?? a.aadhaarNumber ?? null;
      }
    }
    a.dateOfBirth = this.readDate(read('D.O.B', 'DOB', 'Date of Birth'),
      { issues, sourceRow, sheet, column: 'D.O.B' }, 'birth') ?? a.dateOfBirth ?? null;
    a.qualification = blankToNull(read('Qualification')) ?? a.qualification ?? null;
    a.vstsCode = blankToNull(read('VSTS CODE', 'VSTS ID')) ?? a.vstsCode ?? null;
    {
      // Only a real URL is a documents link. When the hyperlink target was stripped (a
      // re-saved file, a pasted-as-text cell), the remaining display text is a caption, not
      // an address — storing it would render a link that navigates nowhere.
      const rawLink = blankToNull(read('Link for Document', 'Link for Documents'));
      if (rawLink && /^https?:\/\//i.test(rawLink)) a.documentsLink = rawLink;
      a.documentsLink = a.documentsLink ?? null;
    }
  }

  /**
   * A cell that must match a shape or go to review. "N.A" and its variants are simply blank —
   * the roster's way of writing nothing — and raise no issue.
   */
  private readShaped(
    raw: unknown, shape: RegExp, reason: string,
    ctx: { issues: Partial<AssayerImportIssueEntity>[]; sourceRow: number; sheet: string; column: string },
  ): string | null {
    const s = blankToNull(raw);
    if (!s || /^n\.?a\.?$/i.test(s) || s === '-') return null;
    const compact = s.replace(/\s+/g, '');
    if (shape.test(compact)) return compact.toUpperCase();
    ctx.issues.push({
      sourceSheet: ctx.sheet, sourceRow: ctx.sourceRow, sourceColumn: ctx.column, rawValue: s.slice(0, 100),
      reason,
    });
    return null;
  }

  /**
   * "Sheet wins" made opt-in for the fields a re-imported, HR-edited export could plausibly
   * clobber: PAN, phone, address, bank/IFSC, joining/exit dates, notes.
   *
   * The default before this was "every readable non-blank cell overwrites the stored value",
   * which is right for filling a blank but wrong for a field somebody corrected on the record
   * since the last export — the roster is frequently exported, hand-edited and re-imported, and
   * a stale sheet value would silently erase the correction. Filling a blank is always safe (the
   * record had nothing to lose) and always happens; overwriting a value that is actually
   * DIFFERENT from what is on file only happens when the caller opted in via `overwrite`, and
   * otherwise becomes a review issue naming both values so a person decides which is current.
   */
  private resolveOverwritableField<T>(
    current: T | null, incoming: T | null, overwrite: boolean,
    ctx: { issues: Partial<AssayerImportIssueEntity>[]; sourceRow: number; sheet: string; column: string; label: string },
    equal: (a: T, b: T) => boolean = (a, b) => a === b,
  ): T | null {
    if (incoming === null || incoming === undefined) return current ?? null;
    if (current === null || current === undefined) return incoming;
    if (equal(current, incoming)) return current;
    if (overwrite) return incoming;
    ctx.issues.push({
      sourceSheet: ctx.sheet, sourceRow: ctx.sourceRow, sourceColumn: ctx.column,
      rawValue: String(incoming).slice(0, 200),
      reason: `Sheet differs from record: ${ctx.label} on file is "${String(current)}", the sheet `
        + `says "${String(incoming)}". Left as it was — re-import with "overwrite" on to replace it.`,
    });
    return current;
  }

  /** Case/spelling-tolerant equality for two state names, used only to decide whether to file a review issue — never to choose which one is stored. */
  private statesAgree(x: string, y: string): boolean {
    const norm = (v: string) => canonicalStateName(v) ?? v.trim().toUpperCase();
    return norm(x) === norm(y);
  }

  /**
   * Loose equality for two bank names, used only to decide whether an IFSC-derived name is
   * worth preferring over a typed one — not a general fuzzy matcher. Tolerates case and the
   * common "Bank" / "Bank Ltd" / "Bank Limited" suffix noise a lookup and a typed cell disagree
   * on even when they name the same institution.
   */
  private bankNamesAgree(x: string, y: string): boolean {
    const norm = (v: string) => v
      .toUpperCase()
      .replace(/[.,]/g, '')
      .replace(/\bLIMITED\b/g, 'LTD')
      .replace(/\bLTD\b/g, '')
      .replace(/\bBANK\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const nx = norm(x);
    const ny = norm(y);
    if (!nx || !ny) return nx === ny;
    return nx === ny || nx.includes(ny) || ny.includes(nx);
  }

  private async applyContact(
    a: AssayerEntity, read: ReturnType<typeof rowReader>,
    sourceRow: number, sheet: string, code: string, issues: Partial<AssayerImportIssueEntity>[],
    overwrite: boolean,
  ): Promise<void> {
    // The two phone columns hold up to three numbers between them, several per cell.
    const phones = readPhoneNumbers(read('Phone Number 1'), read('Phone Number 2'));
    if (phones.length) {
      a.phone = this.resolveOverwritableField(
        a.phone, phones[0], overwrite,
        { issues, sourceRow, sheet, column: 'Phone Number 1 / 2', label: 'Phone' },
      );
      a.alternatePhone = phones[1] ?? a.alternatePhone ?? null;
    } else {
      const raw = `${read('Phone Number 1')} ${read('Phone Number 2')}`.trim();
      if (raw) {
        issues.push({
          sourceSheet: sheet, sourceRow, sourceColumn: 'Phone Number 1 / 2', rawValue: raw,
          reason: 'No ten-digit Indian mobile number could be read from either phone column.',
        });
      }
    }

    /**
     * Email cells on the real file hold two addresses ("a@x / b@y") or typos ("!"; ","). The
     * first valid address is kept — losing the second is the note-to-review's job to fix —
     * and a cell with no readable address at all goes to review.
     *
     * Gated through `resolveOverwritableField`, like every other contact field here (phone,
     * address). It used not to be: this unconditionally wrote `a.email = firstValid...`, so a
     * re-imported roster silently replaced a correction made on the live record — even with
     * "Sheet wins conflicts" left OFF, the setting whose own description promises exactly the
     * opposite ("a disagreeing value is left alone and filed for review"). Proved live: two
     * rows for the same appraiser code, differing only in email, PAN and phone — PAN and phone
     * both correctly stayed put with a "Sheet differs from record" issue filed; email silently
     * took the second row's value with no issue at all. Filling a still-blank email (the
     * ordinary case for a new person) is unaffected — `resolveOverwritableField` always accepts
     * an incoming value when nothing is on file yet.
     */
    {
      const rawEmail = blankToNull(read('Email ID', 'Email'));
      if (rawEmail) {
        const firstValid = rawEmail.split(/[\s/,;]+/).find((t) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) ?? null;
        if (firstValid) {
          const cleaned = firstValid.toLowerCase();
          if (firstValid.length < rawEmail.replace(/\s+/g, '').length) {
            issues.push({
              sourceSheet: sheet, sourceRow, sourceColumn: 'Email ID', rawValue: rawEmail.slice(0, 150),
              reason: `The cell holds more than one address; "${cleaned}" was kept.`,
            });
          }
          a.email = this.resolveOverwritableField(
            a.email, cleaned, overwrite,
            { issues, sourceRow, sheet, column: 'Email ID', label: 'Email' },
          );
        } else {
          issues.push({
            sourceSheet: sheet, sourceRow, sourceColumn: 'Email ID', rawValue: rawEmail.slice(0, 150),
            reason: 'Not a readable email address.',
          });
        }
      }
      a.email = a.email ?? null;
    }
    a.address = this.resolveOverwritableField(
      a.address, blankToNull(read('Residence Address', 'Address')), overwrite,
      { issues, sourceRow, sheet, column: 'Residence Address', label: 'Address' },
    ) ?? '';
    a.city = blankToNull(read('Location', 'City')) ?? a.city ?? null;
    a.district = blankToNull(read('District')) ?? a.district ?? null;

    /**
     * State canonicalisation, run only on a value the sheet actually supplies this row — the
     * `?? a.state` fallback for a blank cell has nothing new to canonicalise, and running it
     * anyway would launder an already-stored raw value on every unrelated re-import.
     *
     * `canonicalStateName` is the thorough canonicaliser, and the one built to refuse a guess
     * (it returns null on anything it does not recognise). `canonicalState` is the cruder,
     * comparison-only normaliser `pincode.ts`'s `stateForms` also chains in: for input outside
     * its small alias table it does not signal "unrecognised" the way its name suggests — it
     * just echoes back the same upper-cased, punctuation-stripped string it would produce for
     * anything. So a `canonicalState` result only counts as a second opinion here when it
     * differs from that echo; when it doesn't, both canonicalisers agree they don't know this
     * one, and the raw text is kept with a review issue rather than silently dropped or
     * laundered into a fake canonical form.
     */
    const rawState = blankToNull(read('State'));
    if (rawState) {
      const echo = rawState.toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();
      const viaSecondary = canonicalState(rawState);
      // `canonicalState`'s own alias table stores its answers ALL CAPS ("ANDHRA PRADESH"), unlike
      // `canonicalStateName`'s title case ("Kerala") — title-cased here so the two paths agree on
      // how a canonical value looks in this column, not just on which value it is.
      const viaSecondaryHit = viaSecondary !== 'UNKNOWN' && viaSecondary !== echo
        ? viaSecondary.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
        : null;
      const canonical = canonicalStateName(rawState) ?? viaSecondaryHit;
      if (canonical) {
        a.state = canonical;
      } else {
        a.state = rawState;
        issues.push({
          sourceSheet: sheet, sourceRow, sourceColumn: 'State', rawValue: rawState,
          reason: 'Could not recognize this as a state — stored as written; please confirm.',
        });
      }
    } else {
      a.state = a.state ?? null;
    }

    /**
     * The pincode the file writes at the end of the address rather than in a column.
     *
     * 1,111 of 1,163 rows carry one there and the sheet has no pincode column at all, so this
     * is the only place it exists. Checked against the state before it is taken — a pincode
     * from the wrong postal circle is worse than a blank one, because it is the strongest
     * signal the geocoder has.
     */
    if (!a.pincode) {
      const reading = pincodeFromAddress(a.address, a.state);
      if (reading.pincode) a.pincode = reading.pincode;
      else if (reading.reason && /postal circle|not a civilian/.test(reading.reason)) {
        issues.push({
          sourceSheet: sheet, sourceRow, sourceColumn: 'Residence Address', rawValue: a.address ?? '',
          reason: reading.reason,
        });
      }
    }

    /**
     * A second, independent check on the same state value: does it agree with what the pincode's
     * own postal circle says the address names? `stateFromAddressAndPincode` only answers when
     * the address text unambiguously names exactly one state from the pincode's circle — anything
     * less (none named, or two candidates) returns null, so this never invents a disagreement out
     * of a coincidence. Filed as a review issue only — the sheet's own state column is not
     * overwritten by this check, since it may equally be the pincode that is wrong.
     */
    if (a.pincode && a.state) {
      const suggested = stateFromAddressAndPincode(a.address, a.pincode);
      if (suggested && !this.statesAgree(suggested, a.state)) {
        issues.push({
          sourceSheet: sheet, sourceRow, sourceColumn: 'State', rawValue: a.state,
          reason: `The address and pincode point to ${suggested}, but the State column says `
            + `"${a.state}". Left as the sheet had it — please confirm which is correct.`,
        });
      }
    }

    // `west` and `West` are one region — `resolveRegion` is the canonical reading, and it is
    // why the sheet's 7 distinct zone values become 4.
    const zone = blankToNull(read('Zone'));
    if (zone) {
      const region = resolveRegion(zone);
      if (region) a.region = region as Region;
      else {
        issues.push({
          sourceSheet: sheet, sourceRow, sourceColumn: 'Zone', rawValue: zone,
          reason: 'Not a region this system recognises.',
        });
      }
    }

    /**
     * No usable Zone: fall back to the region the state implies, the way `create()` does.
     *
     * `region` is what `findAll` scopes every roster read by, so a null one makes the person
     * invisible to a region-scoped desk — absent from the roster, the map and the capacity
     * tile — while their own record looks complete. A blank spreadsheet column should not
     * decide that; the state already says where they are.
     */
    a.region ??= (resolveRegion(a.state ?? '') as Region) ?? null;

    /**
     * The IFSC shape is checked up front, before the bank name is resolved, because a
     * shaped-valid code is what makes an IFSC-lookup cross-check possible below — the code
     * itself is still written to `a.ifscCode` in the same place as before, at the end of this
     * method.
     */
    const rawIfsc = this.readShaped(read('IFSC Code'), IFSC_PATTERN,
      'Not an IFSC code (expected 4 letters, a zero, then 6 characters) — payments to this account would fail.',
      { issues, sourceRow, sheet, column: 'IFSC Code' });
    const rawBankName = blankToNull(read('Bank Name'));
    let incomingBankName = rawBankName;

    /**
     * An IFSC code fixes a bank uniquely; a typed name does not (typos, abbreviations, an old
     * name after a merger — "AXIS" vs "Axis Bank Ltd" on this same sheet). When both are present,
     * prefer the code's answer over a disagreeing typed one and say so, so HR can see what was
     * overridden and why rather than finding a changed bank name with no explanation.
     *
     * A short timeout of our own wraps the call rather than trusting `lookupIfsc`'s own (8s):
     * that is fine for one form field, but this runs once per row of a thousand-row import, and
     * a network hiccup must not turn a bulk import into a multi-hour one. Swallowed identically
     * either way — network down, unknown code, or timeout all fall back to the sheet's own value
     * exactly as before this change, never blocking or skipping the row.
     */
    if (rawIfsc && rawBankName) {
      const resolved = await Promise.race([
        lookupIfsc(rawIfsc).catch(() => null),
        new Promise<null>((resolve) => { setTimeout(() => resolve(null), 3000); }),
      ]);
      if (resolved?.bankName && !this.bankNamesAgree(resolved.bankName, rawBankName)) {
        incomingBankName = resolved.bankName;
        issues.push({
          sourceSheet: sheet, sourceRow, sourceColumn: 'Bank Name', rawValue: rawBankName,
          reason: `The IFSC code resolves to "${resolved.bankName}", which differs from the `
            + `sheet's "${rawBankName}" — the IFSC-derived name was used instead.`,
        });
      }
    }

    a.bankName = this.resolveOverwritableField(
      a.bankName, incomingBankName, overwrite,
      { issues, sourceRow, sheet, column: 'Bank Name', label: 'Bank Name' },
    );
    /**
     * The one identity column with no shape to check, so the mask check has to be explicit.
     *
     * PAN and IFSC go through `readShaped`, whose pattern happens to reject an asterisk, so a
     * masked value in either column is refused as a side effect of validating the format. A bank
     * account has no format — digits of any length — so nothing stopped `***********0252` being
     * written here, encrypted, with the real number gone and no copy anywhere.
     *
     * That is not hypothetical on this data. The API masks these columns on read, HR exports the
     * roster, edits it and re-imports it, and the exported cell holds exactly what the screen
     * showed. `assertNoMaskedPii` guards the two API write paths and cannot help here: the
     * importer never calls `create` or `update`, it mutates the entity and persists it directly.
     *
     * Reported as an issue rather than thrown, like every other bad cell on this sheet — one
     * unusable value must not abandon the other 1,162 rows — and the old value is kept rather
     * than overwritten, because a masked cell carries no information to replace it with.
     */
    const rawAccount = blankToNull(read('A/c Number', 'Account Number'));
    if (rawAccount !== null && looksMasked(rawAccount)) {
      issues.push({
        sourceSheet: sheet, sourceRow, sourceColumn: 'A/c Number',
        rawValue: rawAccount,
        reason: 'This is the masked version shown on screen, not the real account number, so it '
          + 'has been left as it was rather than overwriting the real one. Reveal the field on the '
          + 'record and copy the full number if it needs changing.',
      });
    } else {
      a.bankAccountNumber = this.resolveOverwritableField(
        a.bankAccountNumber, rawAccount, overwrite,
        { issues, sourceRow, sheet, column: 'A/c Number', label: 'Bank Account' },
      );
    }
    a.ifscCode = this.resolveOverwritableField(
      a.ifscCode, rawIfsc, overwrite,
      { issues, sourceRow, sheet, column: 'IFSC Code', label: 'IFSC Code' },
    );
  }

  private applyEmployment(
    a: AssayerEntity, read: ReturnType<typeof rowReader>,
    sourceRow: number, sheet: string, code: string, issues: Partial<AssayerImportIssueEntity>[],
    isNew: boolean, overwrite: boolean, hasAvailabilityColumn: boolean,
    pendingTransitions: { id: string; to: AssayerLifecycleStatus }[],
  ): void {
    /**
     * Same calendar day for two values that are supposed to both be `Date`s, but only one of
     * them reliably is.
     *
     * `incoming` always is: it comes straight out of `readDate`. `current` — `a.joiningDate` /
     * `a.exitDate` off an EXISTING row the prefetch loaded — is not: `joining_date`/`exit_date`
     * are Postgres `date` columns with no transformer (`assayer.entity.ts`), and node-postgres
     * hands a plain `date` column back as a string ("2024-04-01"), never a `Date`, unlike a
     * `timestamptz` column. Calling `.getTime()` on it unconditionally crashed — not just this
     * row, the whole transaction it sat inside, since nothing here catches it — the moment a
     * re-imported sheet supplied a joining or exit date for anyone who already had one on file.
     * Confirmed live: a second import of a file already imported once threw
     * `TypeError: x.getTime is not a function` out of `sameDay`, 500'd the whole request, and
     * rolled back every row in the batch, not only the one that hit it. A brand-new row never
     * reached this at all — `resolveOverwritableField` returns from its own null-check on
     * `current` before ever calling `equal` — which is exactly why this went unnoticed: nothing
     * about a first import, real or rehearsed, exercises it. A second import of the same roster
     * is the ordinary case this importer exists for ("re-running the import updates rather than
     * duplicating" — this class's own doc comment), so this was reachable on nearly every row of
     * nearly every re-import, not an edge case.
     *
     * Compared as a calendar-date STRING, not by `.getTime()` — an earlier fix that coerced the
     * string side with `new Date(v)` stopped the crash but broke equality itself: a bare
     * `"2024-04-01"` parses as UTC midnight, while `readDate`'s incoming `Date` is built with
     * local fields (`new Date(yr, month - 1, day)`), and this deployment runs in IST — so the
     * two timestamps disagreed by the zone offset on every row, and a re-import of an EXACTLY
     * unchanged joining date filed a false "Sheet differs from record" every single time.
     * Extracting `YYYY-MM-DD` sidesteps both problems at once: `isoOf` (this file's own helper,
     * already used to keep every other date message in local terms) reads a real `Date`, and a
     * Postgres `date` column's string form already IS `YYYY-MM-DD` with no time or zone in it to
     * misread — no `Date` construction, no offset, on either side.
     *
     * Typed `(x: Date, y: Date)` still, deliberately — not `Date | string` — so
     * `resolveOverwritableField<T>` keeps inferring `T = Date` at both call sites below and
     * `a.joiningDate`/`a.exitDate` (declared `Date | null` on the entity) still type-check.
     */
    const sameDay = (x: Date, y: Date) => {
      const calendarKey = (v: Date): string => {
        if (v instanceof Date) return isoOf(v);
        const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
        return match ? match[1] : String(v);
      };
      return calendarKey(x) === calendarKey(y);
    };
    a.joiningDate = this.resolveOverwritableField(
      a.joiningDate,
      this.readDate(read('Joining Date'), { issues, sourceRow, sheet, column: 'Joining Date' }),
      overwrite,
      { issues, sourceRow, sheet, column: 'Joining Date', label: 'Joining Date' },
      sameDay,
    );
    a.exitDate = this.resolveOverwritableField(
      a.exitDate,
      this.readDate(read('Exit Date'), { issues, sourceRow, sheet, column: 'Exit Date' }),
      overwrite,
      { issues, sourceRow, sheet, column: 'Exit Date', label: 'Exit Date' },
      sameDay,
    );
    a.hrOwnerName = blankToNull(read('HR NAME', 'HR Name')) ?? a.hrOwnerName ?? null;
    a.notes = this.resolveOverwritableField(
      a.notes, blankToNull(read('Remarks')), overwrite,
      { issues, sourceRow, sheet, column: 'Remarks', label: 'Notes' },
    );

    const experience = blankToNull(read('Total Expierence', 'Total Experience'));
    if (experience) {
      // "20 Years" — the number is what the recommendation engine scores on.
      const years = Number(String(experience).replace(/[^\d.]/g, ''));
      if (Number.isFinite(years) && years >= 0 && years < 80) a.experienceYears = Math.round(years);
    }

    // One cell, three facts. See `readAvailability`.
    const availability = readAvailability(read('Active / Inactive', 'Active/Inactive'));
    if (availability.engagement) a.engagementType = availability.engagement;
    if (availability.reason) a.unavailableReason = availability.reason;
    if (availability.workDoneBySomeoneElse) a.workDoneBySomeoneElse = true;
    for (const fragment of availability.unreadable) {
      issues.push({
        sourceSheet: sheet, sourceRow, sourceColumn: 'Active / Inactive', rawValue: fragment,
        reason: 'Part of the availability cell could not be read as a status, a reason or an engagement type.',
      });
    }

    /**
     * The lifecycle status, from two columns that disagree in shape.
     *
     * "Status" carries the definite outcomes — terminated, resigned, deceased — and outranks
     * the availability column when it says one of them, because "Inactive / Not Interested"
     * and "Resigned in Sumeru" on the same row are the same event described twice, and the
     * second is the more precise.
     *
     * This used to write straight onto `a.lifecycleStatus`, bypassing the state machine that
     * gates every other lifecycle move in the product — HR's `PUT` for the same transition goes
     * through `doTransitionLifecycle`, closes empanelments on departure, reconciles departure
     * dates and leaves a workflow history row; the importer did none of that and could also
     * force a transition the state machine would refuse outright (e.g. jumping a still-INVITED
     * row straight to TERMINATED). The desired value is computed here as before; when it is
     * reachable from where the record currently stands, the move is queued in
     * `pendingTransitions` and run through `bulkTransitionLifecycle` once this row is saved (see
     * the caller after the transaction commits), so a sheet-implied departure gets the same
     * reconciliation and audit trail an HR-initiated one gets. `a.lifecycleStatus` is left
     * untouched here on purpose — writing it directly would flip the column without any of
     * that, which is the exact bug this replaces. When the move is not reachable, the row keeps
     * its current status and the disagreement is filed as a review issue instead.
     */
    const currentStatus = a.lifecycleStatus;
    let desiredStatus: AssayerLifecycleStatus | null = null;
    // What the row's status will actually become once this transaction commits and any queued
    // transition runs — `a.lifecycleStatus` itself is not updated for an existing row (see
    // above), so the exit-date contradiction check below needs this, not the stored field.
    let queuedStatus: AssayerLifecycleStatus = a.lifecycleStatus;
    const outcome = vocabularyKey(read('Status'));
    if (outcome.includes('terminated')) desiredStatus = AssayerLifecycleStatus.TERMINATED;
    else if (outcome.includes('resigned')) desiredStatus = AssayerLifecycleStatus.RESIGNED;
    else if (outcome.includes('expired')) {
      desiredStatus = AssayerLifecycleStatus.INACTIVE;
      a.unavailableReason = AssayerUnavailableReason.DECEASED;
    } else if (availability.available === true) desiredStatus = AssayerLifecycleStatus.ACTIVE;
    else if (availability.onHold) desiredStatus = AssayerLifecycleStatus.SUSPENDED;
    else if (availability.available === false) desiredStatus = AssayerLifecycleStatus.INACTIVE;
    // else: nothing readable in either column — see the isNew branch below for what that means
    // for a brand new row; for an existing one it is not a reason to change their status.

    if (desiredStatus === null) {
      /**
       * A blank or wholly-unreadable availability cell used to leave a new row silently sitting
       * at the entity default (INVITED) with nothing on file to say the cell was ever looked at
       * — indistinguishable from a person genuinely just invited. HR working the review queue
       * needs to see this row, not the roster's normal "everything read fine" silence.
       */
      if (isNew && hasAvailabilityColumn) {
        issues.push({
          sourceSheet: sheet, sourceRow, sourceColumn: 'Active / Inactive',
          rawValue: String(read('Active / Inactive', 'Active/Inactive') ?? ''),
          reason: 'No usable status could be read from the availability or Status columns for a '
            + 'new appraiser, so they were left at INVITED for manual review rather than assumed.',
        });
      }
    } else if (isNew) {
      // A brand new row is being CREATED at this status, not transitioned into it — there is no
      // prior state for the state machine to validate a move from. The roster's own onboarding
      // pipeline (INVITED -> DOCUMENT_VERIFICATION -> ... -> ACTIVE) is a workflow for people
      // entering it through this system; someone the sheet reports as already active in the
      // business they were hired into is not re-run through it on the way in.
      a.lifecycleStatus = desiredStatus;
      queuedStatus = desiredStatus;
    } else if (desiredStatus !== currentStatus) {
      /**
       * An EXISTING record moving status is a real transition. `a.id` is guaranteed set here —
       * this branch only runs for `!isNew` rows, which came from `existingByCode` — so the move
       * can be queued now and run through `bulkTransitionLifecycle` once this row's own save
       * commits, the same helper HR's own transition endpoint uses.
       */
      if (canTransitionAssayerLifecycle(currentStatus, desiredStatus)) {
        pendingTransitions.push({ id: a.id, to: desiredStatus });
        queuedStatus = desiredStatus;
      } else {
        issues.push({
          sourceSheet: sheet, sourceRow, sourceColumn: 'Status',
          rawValue: String(read('Status') ?? ''),
          reason: `The sheet implies a move to ${desiredStatus}, but ${currentStatus} cannot move `
            + `there directly — the record was left at ${currentStatus} for a manual transition.`,
        });
      }
    }

    // An exit date on someone the same sheet marks Active is a contradiction only a person can
    // settle — either the exit is stale or the availability is (both occur on the real file).
    // The availability wins for the stored status; the disagreement goes to review. Checked
    // against `queuedStatus`, not `a.lifecycleStatus`: for an existing row moving to ACTIVE via
    // a queued transition, the stored field will not read ACTIVE until after this save commits.
    if (a.exitDate && queuedStatus === AssayerLifecycleStatus.ACTIVE) {
      issues.push({
        sourceSheet: sheet, sourceRow, sourceColumn: 'Exit Date',
        rawValue: String(read('Exit Date') ?? ''),
        reason: 'Has an exit date but the sheet marks them Active — settle which is true.',
      });
    }
  }

  // ── The related rows ─────────────────────────────────────────────────────

  private async applyReferences(
    manager: any, assayerId: string, read: ReturnType<typeof rowReader>,
  ): Promise<number> {
    // `xlsx` suffixes repeated headers, which is what makes the two "Contact" columns
    // addressable at all.
    // `Contact` / `Contact_1` are how xlsx suffixes the client file's two identically-headed
    // "Contact" columns; `Reference 1/2 Contact` are the clean, unambiguous headers the published
    // template ships in their place. Both are read so either file imports.
    const pairs = [
      { name: read('Refference 1 Name', 'Reference 1 Name'), phone: read('Contact', 'Reference 1 Contact') },
      { name: read('Refference 2 Name', 'Reference 2 Name'), phone: read('Contact_1', 'Reference 2 Contact') },
    ];

    let written = 0;
    for (const pair of pairs) {
      const fullName = blankToNull(pair.name);
      if (!fullName) continue;
      written++;

      const phone = readPhoneNumbers(pair.phone)[0] ?? null;
      // Matched on the name so a re-run updates the same reference rather than adding a third.
      const existing = await manager.findOne(AssayerReferenceEntity, { where: { assayerId, fullName } });
      await manager.save(AssayerReferenceEntity, {
        ...(existing ?? {}), assayerId, fullName, phone,
      });
    }
    return written;
  }

  private async applyOnboardingDocuments(
    manager: any, assayerId: string, read: ReturnType<typeof rowReader>,
  ): Promise<number> {
    let written = 0;
    for (const [requirement, column] of Object.entries(ONBOARDING_DOCUMENT_COLUMNS)) {
      // Requirements that came from the identity register have no column in this file. An empty
      // alias would normalise to the same key as the sheet's 28 blank-headed columns and read
      // whichever one landed there first, so it is refused here rather than left to the lookup.
      if (!column) continue;
      // The client file uses the (mis)spelled column heading; the published template uses the
      // clean document label. Read both so either file's cell is found — an added alias never
      // shadows the original, which is tried first.
      const raw = read(column, ONBOARDING_DOCUMENT_LABELS[requirement as OnboardingDocument]);
      const received = readYesNo(raw);
      if (received === null) continue;
      written++;

      const existing = await manager.findOne(AssayerDocumentEntity, {
        where: { assayerId, requirement: requirement as OnboardingDocument },
      });
      await manager.save(AssayerDocumentEntity, {
        ...(existing ?? {}),
        assayerId,
        requirement: requirement as OnboardingDocument,
        softCopyReceived: received,
      });
    }

    // The NDA is the one document whose hard copy the roster tracks separately, because the
    // signed original is what an audit asks for and it is usually still in the post.
    const ndaHard = blankToNull(read('NDA Hard copy status'));
    if (ndaHard) {
      const existing = await manager.findOne(AssayerDocumentEntity, {
        where: { assayerId, requirement: OnboardingDocument.NDA },
      });
      await manager.save(AssayerDocumentEntity, {
        ...(existing ?? {}),
        assayerId,
        requirement: OnboardingDocument.NDA,
        hardCopyReceived: readYesNo(ndaHard),
        // "Sent to Bangalore office" is a place, not a status. Read to the canonical office name
        // rather than kept as written: the file spells that one place five different ways, and
        // storing each of them is what made "which originals are in Bangalore?" unanswerable.
        hardCopyLocation: readHardCopyLocation(ndaHard),
      });
    }

    // The roster tracks one courier: the signed ethical-conduct letter on its way in — the
    // column sits directly beside "Letter for Commitment on Ethical Conduct" and reads like
    // "23-03-2026 / India Post / RX123…". Free text, stored verbatim as the courier reference
    // on that document's row; the document entity had the field, the importer just never
    // filled it.
    const courier = blankToNull(read('Courier Date / Tracking number', 'Courier Date/Tracking number'));
    if (courier) {
      const existing = await manager.findOne(AssayerDocumentEntity, {
        where: { assayerId, requirement: OnboardingDocument.ETHICAL_CONDUCT_LETTER },
      });
      await manager.save(AssayerDocumentEntity, {
        ...(existing ?? {}),
        assayerId,
        requirement: OnboardingDocument.ETHICAL_CONDUCT_LETTER,
        courierReference: courier.slice(0, 200),
      });
      written++;
    }
    return written;
  }

  private async applyBackgroundCheck(
    manager: any, assayerId: string, read: ReturnType<typeof rowReader>,
    sourceRow: number, sheet: string, code: string,
    issues: Partial<AssayerImportIssueEntity>[],
  ): Promise<number> {
    const rawVerdict = blankToNull(read('Background Verification Done'));
    const rawCibil = blankToNull(read('CIBIL Status'));
    const rawScore = blankToNull(read('Cibil Score'));
    /**
     * Read here rather than where it is used, because `read` is also what tells the unrecognised-
     * column report that this heading is one the importer knows.
     *
     * The call sat below the early return, so on a file where NOT ONE row carries background data
     * the heading was never asked for, and the report would name "CIBIL date" as a column nobody
     * read and say its values were not imported — a false alarm about data that in fact had
     * nothing to attach itself to. The report exists to make silent column loss loud; inventing
     * losses is the one way it can lose an operator's trust.
     */
    const rawCheckedOn = read('CIBIL  date', 'CIBIL date');
    if (!rawVerdict && !rawCibil && !rawScore) return 0;

    const { verdict, risk } = readBackgroundCheck(rawVerdict);
    const band = readCibilBand(rawCibil);

    if (rawVerdict && !verdict) {
      issues.push({
        sourceSheet: sheet, sourceRow, sourceColumn: 'Background Verification Done', rawValue: rawVerdict,
        reason: 'Not a background-check outcome. This column sometimes holds the availability vocabulary instead.',
      });
    }
    if (rawCibil && !band) {
      issues.push({
        sourceSheet: sheet, sourceRow, sourceColumn: 'CIBIL Status', rawValue: rawCibil,
        reason: 'Not a credit band this system recognises.',
      });
    }

    /**
     * The cell often holds TWO readings — "784 / 775", one per bureau pull. Stripping the
     * non-digits fused them into 784775, which is how impossible six-digit CIBIL scores ended
     * up on real profiles (a score lives in 300–900). Read each number separately and keep the
     * first that is actually a CIBIL score; a cell with no plausible reading records none.
     */
    const score = (String(rawScore ?? '').match(/\d+/g) ?? [])
      .map(Number)
      .find((n) => n >= 300 && n <= 900) ?? NaN;
    const hasScore = Number.isFinite(score);

    // Nothing in any of the three columns could be read, so there is nothing to record. Writing
    // the row anyway would assert "we checked and found nothing" on the strength of a cell that
    // holds the availability vocabulary by mistake — the issue above already keeps that cell.
    if (!verdict && !band && !hasScore) return 0;

    /**
     * One check per assayer from this import; a later check adds a row rather than replacing.
     *
     * The row this updates must be the NEWEST one, and the sheet must never overwrite a check
     * recorded after it. Without the ordering this took an arbitrary row, and without the
     * freshness guard a re-import could replace an adverse finding entered in the vetting
     * screen last week with the spreadsheet's older "Clear" — silently rewriting the grounds
     * on which somebody is admitted to a bank vault. A stale sheet now files an issue instead.
     */
    const sheetCheckedOn = this.readDate(rawCheckedOn);
    const existing = await manager.findOne(AssayerBackgroundCheckEntity, {
      where: { assayerId },
      order: { checkedOn: 'DESC', createdAt: 'DESC' },
    });
    if (existing?.checkedOn && sheetCheckedOn && new Date(existing.checkedOn) > new Date(sheetCheckedOn)) {
      issues.push({
        sourceSheet: sheet, sourceRow, sourceColumn: 'CIBIL  date', rawValue: String(sheetCheckedOn),
        reason: `A background check dated ${new Date(existing.checkedOn).toISOString().slice(0, 10)} is already on file — `
          + 'this older row from the sheet was not applied. Record a new check in the vetting screen instead.',
      });
      return 0;
    }

    await manager.save(AssayerBackgroundCheckEntity, {
      ...(existing ?? {}),
      assayerId,
      verdict: verdict ?? BackgroundCheckVerdict.NOT_CHECKED,
      riskGrade: risk,
      cibilScore: hasScore ? score : null,
      cibilBand: band ?? CibilBand.NOT_CHECKED,
      checkedOn: sheetCheckedOn,
      // Findings only where a check actually happened. 170 rows say "Inactive" or "work not
      // asigned" in this column, which explains why no check was run — so NOT_CHECKED is the
      // right verdict, but copying that text into findings printed "Findings: Inactive" on the
      // record and read as something a background check had turned up.
      findings: verdict && verdict !== BackgroundCheckVerdict.NOT_CHECKED ? rawVerdict : null,
    });
    return 1;
  }

  private async applyEmpanelments(
    manager: any, assayerId: string, read: ReturnType<typeof rowReader>,
    clients: Awaited<ReturnType<RosterImportService['buildClientResolver']>>,
    sourceRow: number, sheet: string, code: string,
    issues: Partial<AssayerImportIssueEntity>[],
  ): Promise<number> {
    // The roster carries one client's standing as columns. Others live only in free text, and
    // are not guessed at here — this reads what is actually structured.
    const raw = blankToNull(read('ICICI Status'));
    // Asked for above the early return for the same reason as `CIBIL date` in the check above:
    // `read` is what registers a heading as recognised, and a file with no ICICI standings would
    // otherwise have this column reported as dropped data.
    const rawDocsRequired = blankToNull(read('ICICI Documents required'));
    if (!raw) return 0;

    const clientId = await clients.resolve('ICICI');
    if (!clientId) return 0;

    const status = readEmpanelment(raw);
    if (!status) {
      issues.push({
        sourceSheet: sheet, sourceRow, sourceColumn: 'ICICI Status', rawValue: raw,
        reason: 'Not an empanelment standing this system recognises.',
      });
      return 0;
    }

    const existing = await manager.findOne(AssayerClientEmpanelmentEntity, { where: { assayerId, clientId } });
    await manager.save(AssayerClientEmpanelmentEntity, {
      ...(existing ?? {}),
      assayerId, clientId, status,
      // The words after the slash are why, and they matter when somebody is put forward again.
      statusReason: raw,
      documentsOutstanding: rawDocsRequired,
    });
    return 1;
  }

  /**
   * The rest of the banks: the "Project Name" column.
   *
   * ICICI's standing arrives as its own structured columns (above); every OTHER institution
   * the appraiser works for is recorded only here, as a slash-separated list — "AXIS / AU
   * FINANCE / IDFC". On the real roster that is ~20 lenders across 706 people, and the
   * importer used to drop every one of them, which is why the empanelment table knew about a
   * single bank while planning was being asked to staff a dozen.
   *
   * A listed bank means "actively doing this lender's audits", so the row is written ACTIVE.
   * Create-only: a standing ops has since set through the vetting screen is a decision, and a
   * re-imported spreadsheet must not overwrite a decision (the ICICI path predates this rule
   * and keeps its own semantics). A bank named in the sheet but absent from the clients list
   * is counted once for the summary — the same "697 appraisers reference ICICI which isn't a
   * client yet" mechanism — so ops adds the client and re-imports rather than losing the fact.
   */
  private async applyWorkingBanks(
    manager: any, assayerId: string, read: ReturnType<typeof rowReader>,
    clients: Awaited<ReturnType<RosterImportService['buildClientResolver']>>,
  ): Promise<number> {
    const banks = readWorkingBanks(read('Project Name'));
    let written = 0;
    for (const bank of banks) {
      const clientId = await clients.resolve(bank);
      if (!clientId) continue;
      const existing = await manager.findOne(AssayerClientEmpanelmentEntity, { where: { assayerId, clientId } });
      if (existing) continue;
      await manager.save(AssayerClientEmpanelmentEntity, {
        assayerId, clientId,
        status: EmpanelmentStatus.ACTIVE,
        statusReason: `Working per roster (Project Name: ${bank})`,
      });
      written += 1;
    }
    return written;
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────

  /**
   * One entry per unreadable cell, however many times the file is imported.
   *
   * A cell is identified by where it is — sheet, row, column — because that is what "the same
   * problem" means here. Without this, re-importing the corrected file doubled the review queue:
   * 24 entries became 48, and the second pass of a fix appeared as new work.
   *
   * A resolved entry stays resolved. Somebody looked at that cell and decided; re-reading the
   * same unreadable text is not new information, and reopening it would mean the queue could
   * never be finished while the file still needs importing.
   */
  private async saveIssues(
    manager: any, issues: Partial<AssayerImportIssueEntity>[],
    assayerId: string | null, code: string | null,
  ): Promise<void> {
    for (const issue of issues) {
      const existing = await manager.findOne(AssayerImportIssueEntity, {
        where: {
          sourceSheet: issue.sourceSheet,
          sourceRow: issue.sourceRow,
          sourceColumn: issue.sourceColumn,
        },
      });
      if (existing) {
        if (existing.resolvedAt) continue;
        existing.rawValue = issue.rawValue!;
        existing.reason = issue.reason!;
        existing.assayerId = assayerId;
        existing.sourceAssayerCode = code;
        await manager.save(AssayerImportIssueEntity, existing);
        continue;
      }
      await manager.save(AssayerImportIssueEntity, { ...issue, assayerId, sourceAssayerCode: code });
    }
  }

  /** Clients by a loosened name, so "ICICI Bank Ltd" answers to "ICICI". */
  /**
   * The one place a roster bank name becomes a client id — matching in confidence tiers, and
   * (policy-controlled) creating a minimal client stub when no tier matches.
   *
   * The tiers, strictest first:
   *   1. exact key — vocabularyKey("ICICI BANK LTD") === vocabularyKey(cell);
   *   2. first word — "icici bank ltd" answers to "icici" (the roster names banks casually);
   *   3. word containment — every word of the shorter name appears in the longer ("AU FINANCE"
   *      ↔ "AU Small Finance Bank"). One candidate = a match; TWO OR MORE candidate clients is
   *      an ambiguity, and an ambiguity creates NOTHING — the summary names it and a person
   *      decides. This roster is years of hand-typed data; guessing a merge here is how two
   *      banks' empanelments end up under one client.
   *
   * A created stub carries only what the sheet knows — canonical name, an allocated CL-code,
   * ACTIVE lifecycle, and a `rosterImportStub` marker in planningPreferences — and the summary
   * tells the operator to complete it. Rates and planning preferences stay unset, and pricing
   * fails loudly rather than silently defaulting, so a stub cannot quietly bill.
   */
  private async buildClientResolver(manager: any, autoCreate: boolean, actorId: string) {
    const rows: ClientEntity[] = await manager.find(ClientEntity, {
      select: { id: true, name: true, displayName: true } as any,
    });
    const byKey = new Map<string, string>();
    const entries: Array<{ id: string; key: string; label: string }> = [];
    // A first word claimed by TWO different clients ("Godrej Housing" and "Godrej Capital")
    // is no shortcut at all — it comes out of the direct map so the containment tier sees
    // both candidates and reports the ambiguity, instead of silently picking whichever
    // client happened to load first.
    const contested = new Set<string>();
    const register = (id: string, label: string) => {
      const key = vocabularyKey(label);
      if (!key) return;
      entries.push({ id, key, label });
      if (!byKey.has(key)) byKey.set(key, id);
      const first = key.split(' ')[0];
      if (!first || contested.has(first)) return;
      const holder = byKey.get(first);
      if (holder === undefined) byKey.set(first, id);
      else if (holder !== id) {
        byKey.delete(first);
        contested.add(first);
      }
    };
    for (const c of rows) {
      for (const label of [c.name, (c as any).displayName].filter(Boolean)) register(c.id, label);
    }

    const created = new Map<string, { id: string; code: string; linked: number }>();
    const ambiguous = new Map<string, { labels: string[]; count: number }>();
    const missing = new Map<string, number>();

    const nextClientCode = async (): Promise<string> => {
      // Includes rows this very transaction created, so a run minting several stubs stays
      // sequential; withDeleted so a removed client's code is never reissued.
      const all: Array<{ clientCode?: string }> = await manager.find(ClientEntity, {
        select: { clientCode: true } as any, withDeleted: true,
      });
      const highest = all.reduce((max, r) => {
        const m = /^CL-(\d+)$/.exec(r.clientCode ?? '');
        return m ? Math.max(max, Number(m[1])) : max;
      }, 0);
      return `CL-${String(highest + 1).padStart(4, '0')}`;
    };

    const resolve = async (bankRaw: string): Promise<string | null> => {
      const key = vocabularyKey(bankRaw);
      if (!key) return null;

      const direct = byKey.get(key) ?? byKey.get(key.split(' ')[0]);
      if (direct) {
        const mine = created.get(bankRaw);
        if (mine && mine.id === direct) mine.linked += 1;
        return direct;
      }

      const words = key.split(' ');
      const candidates = new Map<string, string>();
      for (const e of entries) {
        const ew = e.key.split(' ');
        const [shorter, longer] = words.length <= ew.length ? [words, ew] : [ew, words];
        // A one- or two-letter "name" ("L") would contain-match half the directory; the
        // containment tier only speaks when the shorter name has some substance.
        if (shorter.join('').length < 3) continue;
        if (shorter.every((w) => longer.includes(w))) candidates.set(e.id, e.label);
      }
      if (candidates.size === 1) {
        const id = [...candidates.keys()][0];
        byKey.set(key, id); // later rows take the direct tier
        return id;
      }
      if (candidates.size > 1) {
        const cur = ambiguous.get(bankRaw) ?? { labels: [...new Set(candidates.values())], count: 0 };
        cur.count += 1;
        ambiguous.set(bankRaw, cur);
        return null;
      }

      if (!autoCreate) {
        missing.set(bankRaw, (missing.get(bankRaw) ?? 0) + 1);
        return null;
      }

      const code = await nextClientCode();
      const saved = await manager.save(ClientEntity, manager.create(ClientEntity, {
        clientCode: code,
        name: bankRaw,
        displayName: bankRaw
          .toLowerCase()
          .replace(/(^|[^a-z])([a-z])/g, (_m: string, pre: string, ch: string) => pre + ch.toUpperCase()),
        lifecycleStatus: 'ACTIVE',
        planningPreferences: { rosterImportStub: true, createdBy: actorId },
      }));
      register(saved.id, bankRaw);
      created.set(bankRaw, { id: saved.id, code, linked: 1 });
      return saved.id;
    };

    const flushNotes = (summary: RosterImportSummary, dryRun: boolean) => {
      for (const [name, c] of created) {
        summary.notes.push(dryRun
          ? `Would create client "${name}" with minimal details and link ${c.linked} appraisers (happens on the real run).`
          : `Created client "${name}" (${c.code}) with minimal details — ${c.linked} appraisers linked from the roster. `
            + `Open Clients → ${name} and complete its details (rates, planning preferences) before billing against it.`);
      }
      for (const [name, a] of ambiguous) {
        summary.notes.push(
          `"${name}" (named by ${a.count} appraisers) matches more than one existing client — ${a.labels.join(', ')}. `
          + `Nothing was created or linked; rename one so they are distinct, or align the roster, and re-import.`,
        );
      }
      for (const [name, count] of missing) {
        summary.notes.push(
          `${count} appraisers carry a standing with "${name}", which is not a client in this system yet `
          + `(automatic creation is off). Create the client and run the import again to bring those in.`,
        );
      }
    };

    return { resolve, flushNotes };
  }

  /** The sheet mixes real dates with `dd-mm-yyyy` text and placeholders. */
  private readDate(
    raw: unknown,
    ctx?: { issues: Partial<AssayerImportIssueEntity>[]; sourceRow: number; sheet: string; column: string },
    kind: DateKind = 'employment',
  ): Date | null {
    // Excel marks a cell as text with a leading apostrophe; the roster has dates written that
    // way ("'11-01-1997"), and trailing punctuation ("27-04-2026.").
    const s = raw instanceof Date ? raw : (blankToNull(raw)?.replace(/^'/, '').replace(/[.\s]+$/, '') ?? null);
    if (s == null) return null;

    const parsed = this.parseDateShape(s);
    const shown = s instanceof Date ? s.toISOString().slice(0, 10) : String(s).slice(0, 100);

    if (parsed == null) {
      // A silent null here loses a fact forever ("sanjayk" sits in a DOB cell on the real file);
      // a cell that claims to be a date but is not one is a review item.
      ctx?.issues.push({
        sourceSheet: ctx.sheet, sourceRow: ctx.sourceRow, sourceColumn: ctx.column, rawValue: shown,
        reason: 'Could not be read as a date.',
      });
      return null;
    }

    /**
     * Every shape is bounded, not just the last-resort one.
     *
     * The bound was written for `new Date("5484")` and applied only there, which left the two
     * shapes above it — `01-01-5484` and `02-Nov-5484` — to return year 5484 unchecked. The
     * comment on this rule already said "its RESULT is bounded", so the gap read as covered. Real
     * corruption arrived as bare numbers, so nothing slipped through in the roster we have; a
     * differently-broken sheet is exactly what a re-import is allowed to contain, and the check
     * costs nothing on the shapes that were already fine.
     */
    if (this.isPlausibleHumanDate(parsed, kind)) return parsed;
    ctx?.issues.push({
      sourceSheet: ctx.sheet, sourceRow: ctx.sourceRow, sourceColumn: ctx.column,
      rawValue: shown,
      // Two different faults, and the message has to name the right one. A birth date of next
      // Tuesday is a plausible date in the wrong place; year 9952 is a number that was never a
      // date at all, and telling the operator it is "in the future" would send them looking for a
      // typo in a cell whose whole content is wrong. So the gentler wording is used only where the
      // value would otherwise have passed — inside the window an employment date may occupy.
      reason: kind === 'birth' && this.isPlausibleHumanDate(parsed, 'employment')
        ? `Read as ${isoOf(parsed)}, which is in the future — nobody is born on a date that has `
          + 'not happened yet, so this cell is not a date of birth. Left blank; correct it on the '
          + 'source sheet and re-import.'
        : `Read as ${parsed.getFullYear()}, which is not a real date for a person — the cell is `
          + 'probably not a date at all. Left blank; correct it on the source sheet and re-import.',
    });
    return null;
  }

  /** Every date shape the roster is written in, or null when none of them fits. */
  private parseDateShape(s: Date | string): Date | null {
    if (s instanceof Date) return Number.isNaN(s.getTime()) ? null : s;

    const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
    if (dmy) {
      // Day-first: an Indian roster writing 03-01-1974 means the 3rd of January. Two-digit
      // years ("31-10-23") are this century — the company did not exist in 1923.
      const yr = Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]);
      const d = new Date(yr, Number(dmy[2]) - 1, Number(dmy[1]));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    // "02-Nov-2022" / "02 Nov 22" — the month written as a word.
    const dMonY = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s'](?:')?(\d{2,4})$/.exec(s);
    if (dMonY) {
      const yr = Number(dMonY[3].length === 2 ? `20${dMonY[3]}` : dMonY[3]);
      const d = new Date(`${dMonY[2]} ${dMonY[1]}, ${yr}`);
      if (!Number.isNaN(d.getTime())) return d;
    }
    // A bare five-digit number: an Excel day serial from a cell that was never formatted as a
    // date. Must be tried BEFORE the `new Date(s)` fallback below, which would read it as a year.
    if (/^\d{5}(?:\.\d+)?$/.test(s)) {
      const serial = excelSerialToDate(Number(s));
      if (serial) return serial;
    }
    /**
     * The last resort, and the one that did real damage.
     *
     * `new Date(s)` accepts a bare number as a **year**: `new Date("5484")` is 1 January 5484. A
     * roster cell holding a plain number — a fee, an employee number, a code typed into the wrong
     * column — therefore became a confident, valid-looking date in the fifth millennium, and
     * nothing downstream questioned it. On the real 1,155-person file that produced **75 dates of
     * birth** ranging from year 0138 to 9952, **58 joining dates** and **26 exit dates**, every one
     * of them on `01-01`, which is the signature of exactly this parse.
     *
     * They were worse than missing values: `qualification-score.service` reads `joiningDate` for
     * tenure, so someone who "joined in 6333" scored on a negative career length, and no screen
     * showed anything wrong.
     *
     * The parse is kept, because it reads shapes the two regexes above do not, and its result is
     * bounded by the caller along with every other shape's.
     */
    const parsed = new Date(s);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  /**
   * Could a person's date of birth, joining or exit realistically be this?
   *
   * Deliberately generous rather than tuned: the job is to catch a parse that produced year 6333,
   * not to police data entry. The lower bound of 1900 admits the oldest plausible date of birth.
   * Checked against every date in the live table: no legitimate value falls outside this, so the
   * rule refuses nothing real.
   *
   * The upper bound depends on what the date is FOR, which is why the caller says.
   *
   * An employment date may sit up to five years ahead: a notice period served well in advance is
   * real, and so is a fixed-term engagement with a known end date. Five and not two, because the
   * data-integrity scan already treats anything within five years as perfectly plausible — while
   * this said two, a date the scan would never have questioned was refused at the door, and the
   * operator got an issue telling them a real date was "not a real date for a person". Two rules
   * over one value must not disagree.
   *
   * A birth date gets no future allowance at all. Nobody is born tomorrow; a birth date even a
   * day ahead is a misread cell every single time, and the generous employment window was quietly
   * admitting two years of them.
   */
  private isPlausibleHumanDate(d: Date, kind: DateKind): boolean {
    if (d.getFullYear() < 1900) return false;
    if (kind === 'birth') return dayNumber(d) <= dayNumber(new Date());
    return d.getFullYear() <= new Date().getFullYear() + FUTURE_EMPLOYMENT_YEARS;
  }
}

/** Thrown to roll a rehearsal back. Never escapes `importAssayerSheet`. */
class DryRunComplete extends Error {}
