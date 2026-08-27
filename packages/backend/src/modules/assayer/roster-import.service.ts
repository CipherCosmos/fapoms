import { Injectable, Logger } from '@nestjs/common';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import * as xlsx from 'xlsx';
import {
  AssayerLifecycleStatus, Region, resolveRegion,
  readAvailability, readYesNo, readCibilBand, readBackgroundCheck, readEmpanelment,
  readPhoneNumbers, blankToNull, vocabularyKey,
  OnboardingDocument, ONBOARDING_DOCUMENT_COLUMNS, EmpanelmentStatus,
  AssayerUnavailableReason, BackgroundCheckVerdict, CibilBand,
} from '@fapoms/shared';
import { rowReader } from '../../core/excel/sheet-reader';
import { AssayerEntity } from './assayer.entity';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerOnboardingDocumentEntity } from './assayer-onboarding-document.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';
import { ClientEntity } from '../client/client.entity';

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

  constructor(private readonly uow: UnitOfWork) {}

  async importAssayerSheet(
    file: Buffer,
    actorId: string,
    options: { dryRun?: boolean; sheetName?: string } = {},
  ): Promise<RosterImportSummary> {
    const dryRun = options.dryRun ?? false;
    const sheetName = options.sheetName ?? 'Assayers';

    const workbook = xlsx.read(file, { type: 'buffer', cellDates: true });
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      throw new Error(`The workbook has no sheet named "${sheetName}". Found: ${workbook.SheetNames.join(', ')}.`);
    }
    const rows: Record<string, any>[] = xlsx.utils.sheet_to_json(sheet, { defval: null });

    const summary: RosterImportSummary = {
      rowsRead: rows.length, created: 0, updated: 0, skipped: 0,
      references: 0, onboardingDocuments: 0, backgroundChecks: 0, empanelments: 0,
      issues: 0, notes: [], dryRun,
    };

    /** Clients the roster refers to that this system does not have. Counted, reported once. */
    const missingClients = new Map<string, number>();

    await this.uow.run(async (manager) => {
      // Resolved once, inside the transaction so it reads the same snapshot the import writes
      // against: a lookup per row over 1,155 rows would be 1,155 queries for two answers.
      const clientsByName = await this.clientsByLooseName(manager);
      for (const [index, row] of rows.entries()) {
        // +2: one for the header, one because a spreadsheet's first data row is row 2 to the
        // person who will go and look at it.
        const sourceRow = index + 2;
        const read = rowReader(row);
        const issues: Partial<AssayerImportIssueEntity>[] = [];

        const code = blankToNull(read('Appraiser code', 'Assayer code', 'Appraiser Code'));
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

        const existing = await manager.findOne(AssayerEntity, { where: { assayerCode: code } });
        const assayer = existing ?? manager.create(AssayerEntity, { assayerCode: code });
        const isNew = !existing;

        this.applyIdentity(assayer, read);
        this.applyContact(assayer, read, sourceRow, sheetName, code, issues);
        this.applyEmployment(assayer, read, sourceRow, sheetName, code, issues);

        this.fillRequiredBlanks(assayer);

        // A rehearsal writes exactly what a real run writes; the rollback at the end is the only
        // difference. The first version skipped the writes and counted instead, and reported a
        // clean 1,155-row rehearsal for an import that then failed on the first insert — the
        // rehearsal was checking the reader, not the import.
        assayer.updatedBy = actorId;
        if (isNew) assayer.createdBy = actorId;
        await manager.save(AssayerEntity, assayer);
        isNew ? summary.created++ : summary.updated++;

        const assayerId = assayer.id;
        summary.references += await this.applyReferences(manager, assayerId, read);
        summary.onboardingDocuments += await this.applyOnboardingDocuments(manager, assayerId, read);
        summary.backgroundChecks += await this.applyBackgroundCheck(
          manager, assayerId, read, sourceRow, sheetName, code, issues,
        );
        summary.empanelments += await this.applyEmpanelments(
          manager, assayerId, read, clientsByName, missingClients, sourceRow, sheetName, code, issues,
        );

        summary.issues += issues.length;
        if (issues.length) await this.saveIssues(manager, issues, assayerId, code);
      }

      for (const [name, count] of missingClients) {
        summary.notes.push(
          `${count} appraisers carry a standing with "${name}", which is not a client in this `
          + `system yet. Create the client and run the import again to bring those in.`,
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

    this.logger.log(
      `Roster import${dryRun ? ' (rehearsal)' : ''}: ${summary.rowsRead} rows, `
      + `${summary.created} created, ${summary.updated} updated, ${summary.skipped} skipped, `
      + `${summary.issues} needing review.`,
    );
    return summary;
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

  private applyIdentity(a: AssayerEntity, read: ReturnType<typeof rowReader>): void {
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
    a.panNumber = blankToNull(read('PAN Number')) ?? a.panNumber ?? null;
    a.aadhaarNumber = blankToNull(read('Aadhar Card Number', 'Aadhaar Card Number')) ?? a.aadhaarNumber ?? null;
    a.dateOfBirth = this.readDate(read('D.O.B', 'DOB', 'Date of Birth')) ?? a.dateOfBirth ?? null;
    a.qualification = blankToNull(read('Qualification')) ?? a.qualification ?? null;
    a.vstsCode = blankToNull(read('VSTS CODE', 'VSTS ID')) ?? a.vstsCode ?? null;
  }

  private applyContact(
    a: AssayerEntity, read: ReturnType<typeof rowReader>,
    sourceRow: number, sheet: string, code: string, issues: Partial<AssayerImportIssueEntity>[],
  ): void {
    // The two phone columns hold up to three numbers between them, several per cell.
    const phones = readPhoneNumbers(read('Phone Number 1'), read('Phone Number 2'));
    if (phones.length) {
      a.phone = phones[0];
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

    a.email = blankToNull(read('Email ID', 'Email')) ?? a.email ?? null;
    a.address = blankToNull(read('Residence Address', 'Address')) ?? a.address ?? null;
    a.city = blankToNull(read('Location', 'City')) ?? a.city ?? null;
    a.district = blankToNull(read('District')) ?? a.district ?? null;
    a.state = blankToNull(read('State')) ?? a.state ?? null;

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

    a.bankName = blankToNull(read('Bank Name')) ?? a.bankName ?? null;
    a.bankAccountNumber = blankToNull(read('A/c Number', 'Account Number')) ?? a.bankAccountNumber ?? null;
    a.ifscCode = blankToNull(read('IFSC Code')) ?? a.ifscCode ?? null;
  }

  private applyEmployment(
    a: AssayerEntity, read: ReturnType<typeof rowReader>,
    sourceRow: number, sheet: string, code: string, issues: Partial<AssayerImportIssueEntity>[],
  ): void {
    a.joiningDate = this.readDate(read('Joining Date')) ?? a.joiningDate ?? null;
    a.exitDate = this.readDate(read('Exit Date')) ?? a.exitDate ?? null;
    a.hrOwnerName = blankToNull(read('HR NAME', 'HR Name')) ?? a.hrOwnerName ?? null;
    a.notes = blankToNull(read('Remarks')) ?? a.notes ?? null;

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
     */
    const outcome = vocabularyKey(read('Status'));
    if (outcome.includes('terminated')) a.lifecycleStatus = AssayerLifecycleStatus.TERMINATED;
    else if (outcome.includes('resigned')) a.lifecycleStatus = AssayerLifecycleStatus.RESIGNED;
    else if (outcome.includes('expired')) {
      a.lifecycleStatus = AssayerLifecycleStatus.INACTIVE;
      a.unavailableReason = AssayerUnavailableReason.DECEASED;
    } else if (availability.available === true) a.lifecycleStatus = AssayerLifecycleStatus.ACTIVE;
    else if (availability.onHold) a.lifecycleStatus = AssayerLifecycleStatus.SUSPENDED;
    else if (availability.available === false) a.lifecycleStatus = AssayerLifecycleStatus.INACTIVE;
    // else: left as it was. An unknown availability is not a reason to change somebody's status.
  }

  // ── The related rows ─────────────────────────────────────────────────────

  private async applyReferences(
    manager: any, assayerId: string, read: ReturnType<typeof rowReader>,
  ): Promise<number> {
    // `xlsx` suffixes repeated headers, which is what makes the two "Contact" columns
    // addressable at all.
    const pairs = [
      { name: read('Refference 1 Name', 'Reference 1 Name'), phone: read('Contact') },
      { name: read('Refference 2 Name', 'Reference 2 Name'), phone: read('Contact_1') },
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
      const raw = read(column);
      const received = readYesNo(raw);
      if (received === null) continue;
      written++;

      const existing = await manager.findOne(AssayerOnboardingDocumentEntity, {
        where: { assayerId, requirement: requirement as OnboardingDocument },
      });
      await manager.save(AssayerOnboardingDocumentEntity, {
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
      const existing = await manager.findOne(AssayerOnboardingDocumentEntity, {
        where: { assayerId, requirement: OnboardingDocument.NDA },
      });
      await manager.save(AssayerOnboardingDocumentEntity, {
        ...(existing ?? {}),
        assayerId,
        requirement: OnboardingDocument.NDA,
        hardCopyReceived: readYesNo(ndaHard),
        // "Sent to Bangalore office" is a place, not a status — kept as written.
        hardCopyLocation: readYesNo(ndaHard) === null ? ndaHard : null,
      });
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

    const score = Number(String(rawScore ?? '').replace(/[^\d]/g, ''));
    const hasScore = Number.isFinite(score) && score > 0;

    // Nothing in any of the three columns could be read, so there is nothing to record. Writing
    // the row anyway would assert "we checked and found nothing" on the strength of a cell that
    // holds the availability vocabulary by mistake — the issue above already keeps that cell.
    if (!verdict && !band && !hasScore) return 0;
    // One check per assayer from this import; a later check adds a row rather than replacing.
    const existing = await manager.findOne(AssayerBackgroundCheckEntity, { where: { assayerId } });
    await manager.save(AssayerBackgroundCheckEntity, {
      ...(existing ?? {}),
      assayerId,
      verdict: verdict ?? BackgroundCheckVerdict.NOT_CHECKED,
      riskGrade: risk,
      cibilScore: hasScore ? score : null,
      cibilBand: band ?? CibilBand.NOT_CHECKED,
      checkedOn: this.readDate(read('CIBIL  date', 'CIBIL date')),
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
    clientsByName: Map<string, string>, missingClients: Map<string, number>,
    sourceRow: number, sheet: string, code: string,
    issues: Partial<AssayerImportIssueEntity>[],
  ): Promise<number> {
    // The roster carries one client's standing as columns. Others live only in free text, and
    // are not guessed at here — this reads what is actually structured.
    const raw = blankToNull(read('ICICI Status'));
    if (!raw) return 0;

    const clientId = clientsByName.get(vocabularyKey('ICICI'));
    if (!clientId) {
      // Counted for the summary, not written per row: one absent client is one fact, and the
      // first version of this produced 697 identical review items out of 1,155 rows.
      missingClients.set('ICICI', (missingClients.get('ICICI') ?? 0) + 1);
      return 0;
    }

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
      documentsOutstanding: blankToNull(read('ICICI Documents required')),
    });
    return 1;
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
  private async clientsByLooseName(manager: any): Promise<Map<string, string>> {
    const rows: ClientEntity[] = await manager.find(ClientEntity, {
      select: { id: true, name: true, displayName: true } as any,
    });
    const map = new Map<string, string>();
    for (const c of rows) {
      for (const label of [c.name, (c as any).displayName].filter(Boolean)) {
        const key = vocabularyKey(label);
        map.set(key, c.id);
        // "icici bank ltd" also answers to "icici" — the roster names banks casually.
        const first = key.split(' ')[0];
        if (first && !map.has(first)) map.set(first, c.id);
      }
    }
    return map;
  }

  /** The sheet mixes real dates with `dd-mm-yyyy` text and placeholders. */
  private readDate(raw: unknown): Date | null {
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
    const s = blankToNull(raw);
    if (!s) return null;

    const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
    if (dmy) {
      // Day-first: an Indian roster writing 03-01-1974 means the 3rd of January.
      const d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const parsed = new Date(s);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}

/** Thrown to roll a rehearsal back. Never escapes `importAssayerSheet`. */
class DryRunComplete extends Error {}
