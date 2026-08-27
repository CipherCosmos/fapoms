import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import {
  EmpanelmentStatus, BackgroundCheckVerdict, RiskGrade, CibilBand,
  OnboardingDocument, ONBOARDING_DOCUMENT_COLUMNS, ONBOARDING_DOCUMENT_LABELS,
  DocumentVerification, isIdentityDocument,
} from '@fapoms/shared';
import { AssayerEntity } from './assayer.entity';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';

/**
 * The workforce records the roster spreadsheet was holding sideways.
 *
 * Four of these were columns before they were tables — two reference pairs, a column per client,
 * four columns holding one background check, and fifteen yes/no columns for paperwork. The fifth
 * holds what the import could not read. What they have in common is that each is a *repeating*
 * fact about one person, and the reason to give them a service of their own rather than folding
 * them into `AssayerService` is that they are read together and almost always by the same
 * question: may we send this person out, and to whom.
 *
 * Two rules the writes hold.
 *
 * **A standing is per client, and there is one of it.** The unique constraint says so; this
 * upserts rather than inserting, because two rows would be two answers to "may we send them" with
 * nothing to say which counts.
 *
 * **A background check is history, not a field.** Each check is a new row and the current verdict
 * is the latest one. These are the grounds on which somebody is admitted to a bank vault, and
 * "cleared in 2022, civil case in 2026" is a sentence the column version could not say.
 */
/**
 * Identity documents whose number is already a column on the person.
 *
 * A PAN number is a fact about somebody, not about the card: payroll reads `pan_number`,
 * `ASSAYER_RECORD_FIELDS` counts it as a critical gap, and the mobile app shows it. The card is
 * the document that evidences it, which is what the document record tracks — whether a copy
 * arrived, whether anybody checked it against the original.
 *
 * So the number is stored once, on the person, and surfaced in both places. Writing it through
 * the document record writes the column; reading the document record reads the column back.
 * Storing it twice would mean the record and the document could disagree about somebody's PAN,
 * with nothing to say which was right.
 *
 * Documents with no column of their own — passport, driving licence, voter ID — keep their
 * number on the document record, where it is the only copy.
 */
const NUMBER_LIVES_ON_THE_PERSON: Partial<Record<OnboardingDocument, 'panNumber' | 'aadhaarNumber'>> = {
  [OnboardingDocument.PAN_CARD]: 'panNumber',
  [OnboardingDocument.AADHAAR_FRONT]: 'aadhaarNumber',
  [OnboardingDocument.AADHAAR_BACK]: 'aadhaarNumber',
};

@Injectable()
export class RosterRecordsService {
  constructor(
    @InjectRepository(AssayerEntity) private readonly assayers: Repository<AssayerEntity>,
    @InjectRepository(AssayerReferenceEntity) private readonly references: Repository<AssayerReferenceEntity>,
    @InjectRepository(AssayerClientEmpanelmentEntity) private readonly empanelments: Repository<AssayerClientEmpanelmentEntity>,
    @InjectRepository(AssayerBackgroundCheckEntity) private readonly checks: Repository<AssayerBackgroundCheckEntity>,
    @InjectRepository(AssayerDocumentEntity) private readonly onboarding: Repository<AssayerDocumentEntity>,
    @InjectRepository(AssayerImportIssueEntity) private readonly issues: Repository<AssayerImportIssueEntity>,
  ) {}

  /** Everything the roster knows about one person beyond their own row, in one round trip. */
  async dossier(assayerId: string) {
    const assayer = await this.assayers.findOne({ where: { id: assayerId } });
    if (!assayer) throw new NotFoundException('No such assayer.');

    const [references, empanelments, checks, onboarding, openIssues] = await Promise.all([
      this.references.find({ where: { assayerId, isActive: true }, order: { createdAt: 'ASC' } }),
      this.empanelments.find({ where: { assayerId, isActive: true }, relations: ['client'], order: { createdAt: 'ASC' } }),
      // Newest first: the current standing is the top row, and the rest is why.
      this.checks.find({ where: { assayerId, isActive: true }, order: { checkedOn: 'DESC', createdAt: 'DESC' } }),
      this.onboarding.find({ where: { assayerId, isActive: true } }),
      this.issues.find({ where: { assayerId, resolvedAt: IsNull() }, order: { createdAt: 'ASC' } }),
    ]);

    return {
      references,
      empanelments: empanelments.map((e) => ({
        ...e,
        client: e.client ? { id: e.client.id, name: e.client.name, clientCode: e.client.clientCode } : null,
      })),
      backgroundChecks: checks,
      currentCheck: checks[0] ?? null,
      onboarding: this.paperworkChecklist(onboarding, assayer),
      openIssues,
    };
  }

  /**
   * The paperwork answer for one person, as the checklist it is.
   *
   * A missing row and a row saying "not received" mean the same thing to whoever is chasing it,
   * so every requirement appears whether or not the import found it. Listing only what exists
   * would show a person with nothing on file as having nothing outstanding.
   */
  private paperworkChecklist(rows: AssayerDocumentEntity[], assayer: AssayerEntity) {
    const byRequirement = new Map(rows.map((r) => [r.requirement, r]));
    return Object.keys(ONBOARDING_DOCUMENT_COLUMNS).map((key) => {
      const requirement = key as OnboardingDocument;
      const row = byRequirement.get(requirement);
      return {
        requirement,
        label: ONBOARDING_DOCUMENT_LABELS[requirement],
        // Which half of the list this belongs to. The screen shows a number, an expiry and a
        // verification for identity documents and nothing of the sort for a code-of-conduct
        // letter, and this is what tells it apart.
        identity: isIdentityDocument(requirement),
        id: row?.id ?? null,
        softCopyReceived: row?.softCopyReceived ?? null,
        hardCopyReceived: row?.hardCopyReceived ?? null,
        hardCopyLocation: row?.hardCopyLocation ?? null,
        courierReference: row?.courierReference ?? null,
        receivedAt: row?.receivedAt ?? null,
        // Read back from the person where that is where it lives — see
        // NUMBER_LIVES_ON_THE_PERSON. One value, two places to see it, no way for them to differ.
        documentNumber: NUMBER_LIVES_ON_THE_PERSON[requirement]
          ? (assayer[NUMBER_LIVES_ON_THE_PERSON[requirement]!] ?? null)
          : (row?.documentNumber ?? null),
        expiryDate: row?.expiryDate ?? null,
        verificationStatus: row?.verificationStatus ?? null,
        verifiedAt: row?.verifiedAt ?? null,
        filePaths: row?.filePaths ?? [],
        remarks: row?.remarks ?? null,
      };
    });
  }

  // ── References ────────────────────────────────────────────────────────

  async saveReference(
    assayerId: string,
    dto: Partial<AssayerReferenceEntity> & { fullName: string },
    actorId: string,
    id?: string,
  ) {
    const row = id
      ? await this.references.findOne({ where: { id, assayerId } })
      : this.references.create({ assayerId });
    if (!row) throw new NotFoundException('No such reference.');

    Object.assign(row, {
      fullName: dto.fullName?.trim(),
      phone: dto.phone ?? row.phone ?? null,
      relationship: dto.relationship ?? row.relationship ?? null,
      remarks: dto.remarks ?? row.remarks ?? null,
      updatedBy: actorId,
    });
    if (!row.fullName) throw new BadRequestException('A reference needs a name.');
    if (!id) row.createdBy = actorId;
    return this.references.save(row);
  }

  /** Marking a reference checked is who-and-when, not a free field, so it is its own action. */
  async markReferenceChecked(id: string, actorId: string, remarks?: string) {
    const row = await this.references.findOne({ where: { id } });
    if (!row) throw new NotFoundException('No such reference.');
    row.checkedAt = new Date();
    row.checkedBy = actorId;
    if (remarks) row.remarks = remarks;
    row.updatedBy = actorId;
    return this.references.save(row);
  }

  async removeReference(id: string, actorId: string) {
    const row = await this.references.findOne({ where: { id } });
    if (!row) throw new NotFoundException('No such reference.');
    row.isActive = false;
    row.updatedBy = actorId;
    await this.references.save(row);
  }

  // ── Client standing ───────────────────────────────────────────────────

  async setEmpanelment(
    assayerId: string,
    clientId: string,
    dto: { status: EmpanelmentStatus; statusReason?: string; documentsOutstanding?: string;
           clientReferenceCode?: string; decidedAt?: string; remarks?: string },
    actorId: string,
  ) {
    // Upsert: the unique constraint permits exactly one standing per pair, and this is the
    // decision about it rather than another opinion alongside it.
    const existing = await this.empanelments.findOne({ where: { assayerId, clientId } });
    const row = existing ?? this.empanelments.create({ assayerId, clientId, createdBy: actorId });

    row.status = dto.status;
    row.statusReason = dto.statusReason ?? null;
    row.documentsOutstanding = dto.documentsOutstanding ?? null;
    row.clientReferenceCode = dto.clientReferenceCode ?? row.clientReferenceCode ?? null;
    row.decidedAt = dto.decidedAt ? new Date(dto.decidedAt) : new Date();
    row.remarks = dto.remarks ?? null;
    row.isActive = true;
    row.updatedBy = actorId;
    return this.empanelments.save(row);
  }

  async removeEmpanelment(id: string, actorId: string) {
    const row = await this.empanelments.findOne({ where: { id } });
    if (!row) throw new NotFoundException('No such standing.');
    row.isActive = false;
    row.updatedBy = actorId;
    await this.empanelments.save(row);
  }

  // ── Background and credit checks ──────────────────────────────────────

  async recordBackgroundCheck(
    assayerId: string,
    dto: { verdict: BackgroundCheckVerdict; riskGrade?: RiskGrade; cibilScore?: number;
           cibilBand?: CibilBand; checkedOn?: string; checkedByName?: string; findings?: string },
    actorId: string,
  ) {
    // Always a new row. Overwriting the last check would lose the fact that the picture changed,
    // which is the only reason to look at a second one.
    const row = this.checks.create({
      assayerId,
      verdict: dto.verdict,
      riskGrade: dto.riskGrade ?? null,
      cibilScore: dto.cibilScore ?? null,
      cibilBand: dto.cibilBand ?? null,
      checkedOn: dto.checkedOn ? new Date(dto.checkedOn) : new Date(),
      checkedByName: dto.checkedByName ?? null,
      findings: dto.findings ?? null,
      createdBy: actorId,
      updatedBy: actorId,
    });
    return this.checks.save(row);
  }

  // ── Onboarding paperwork ──────────────────────────────────────────────

  async setDocument(
    assayerId: string,
    requirement: OnboardingDocument,
    dto: { softCopyReceived?: boolean | null; hardCopyReceived?: boolean | null;
           hardCopyLocation?: string; courierReference?: string; receivedAt?: string; remarks?: string;
           documentNumber?: string; expiryDate?: string | null },
    actorId: string,
  ) {
    if (!ONBOARDING_DOCUMENT_COLUMNS[requirement]) {
      throw new BadRequestException(`"${requirement}" is not a paperwork requirement this system knows.`);
    }
    const existing = await this.onboarding.findOne({ where: { assayerId, requirement } });
    const row = existing ?? this.onboarding.create({ assayerId, requirement, createdBy: actorId });

    if (dto.softCopyReceived !== undefined) row.softCopyReceived = dto.softCopyReceived;
    if (dto.hardCopyReceived !== undefined) row.hardCopyReceived = dto.hardCopyReceived;
    if (dto.hardCopyLocation !== undefined) row.hardCopyLocation = dto.hardCopyLocation || null;
    if (dto.courierReference !== undefined) row.courierReference = dto.courierReference || null;
    if (dto.receivedAt !== undefined) row.receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : null;
    if (dto.remarks !== undefined) row.remarks = dto.remarks || null;

    // A number and an expiry belong to an identity document and to nothing else. Accepting them
    // on a joining form would put a field on screen that can never be filled in correctly.
    if (dto.documentNumber !== undefined || dto.expiryDate !== undefined) {
      if (!isIdentityDocument(requirement)) {
        throw new BadRequestException(
          `${ONBOARDING_DOCUMENT_LABELS[requirement]} is not an identity document, so it carries `
          + 'no number or expiry date.',
        );
      }
      const column = NUMBER_LIVES_ON_THE_PERSON[requirement];
      if (dto.documentNumber !== undefined) {
        if (column) {
          const person = await this.assayers.findOne({ where: { id: assayerId } });
          if (person) {
            person[column] = dto.documentNumber || null;
            person.updatedBy = actorId;
            await this.assayers.save(person);
          }
        } else {
          row.documentNumber = dto.documentNumber || null;
        }
      }
      if (dto.expiryDate !== undefined) row.expiryDate = dto.expiryDate ? new Date(dto.expiryDate) : null;
      // Changing what the document says undoes any verification of it: somebody checked the old
      // number against the original, and that is no longer the number on the record.
      if (row.verificationStatus === DocumentVerification.VERIFIED) {
        row.verificationStatus = DocumentVerification.PENDING;
        row.verifiedAt = null;
        row.verifiedBy = null;
      }
    }

    row.isActive = true;
    row.updatedBy = actorId;
    return this.onboarding.save(row);
  }

  /**
   * Attach a scan to a document, and say the copy arrived.
   *
   * The record could say a soft copy had been received and hold nothing to show for it, which is
   * the difference between a filing system and a note about one. An audit asks to see the
   * document, not to be told somebody once saw it.
   *
   * Recording the file also sets `softCopyReceived`, because a scan on the record *is* the soft
   * copy: leaving a clerk to tick a box next to a file they just uploaded is asking them to
   * state something the system can see for itself.
   */
  async attachFile(assayerId: string, requirement: OnboardingDocument, key: string, actorId: string) {
    const existing = await this.onboarding.findOne({ where: { assayerId, requirement } });
    const row = existing ?? this.onboarding.create({ assayerId, requirement, createdBy: actorId });
    row.filePaths = [...(row.filePaths ?? []), key];
    if (row.softCopyReceived !== true) row.softCopyReceived = true;
    row.isActive = true;
    row.updatedBy = actorId;
    const saved = await this.onboarding.save(row);

    /**
     * A photograph is also a fact about the person, not only a document in their file.
     *
     * `assayers.photograph` is what a header or a list can show without loading the whole
     * dossier, so the most recent one is copied there — the same arrangement as a PAN number,
     * which lives on the person while the card that evidences it lives here. Copied rather than
     * duplicated: this is the only writer, and the document record stays the history.
     */
    if (requirement === OnboardingDocument.PHOTOGRAPH) {
      await this.assayers.update({ id: assayerId }, { photograph: key, updatedBy: actorId });
    }
    return saved;
  }

  /** The stored key at one position, or null — the caller decides what a miss means. */
  async fileKey(documentId: string, index: number): Promise<{ key: string; requirement: string } | null> {
    const row = await this.onboarding.findOne({ where: { id: documentId } });
    const key = row?.filePaths?.[index];
    return key ? { key, requirement: row!.requirement } : null;
  }

  /**
   * Detach a scan.
   *
   * The stored object is deleted by the caller, which owns the storage engine. This only forgets
   * the reference — and does *not* clear `softCopyReceived`, because somebody may have removed a
   * bad scan of a document that did genuinely arrive, and quietly retracting that is a second
   * decision nobody made.
   */
  async detachFile(documentId: string, index: number, actorId: string): Promise<string | null> {
    const row = await this.onboarding.findOne({ where: { id: documentId } });
    if (!row) throw new NotFoundException('No such document.');
    const key = row.filePaths?.[index];
    if (!key) return null;
    row.filePaths = row.filePaths.filter((_, i) => i !== index);
    row.updatedBy = actorId;
    await this.onboarding.save(row);

    // The header must not go on pointing at a file that is gone. Falls back to whatever else is
    // still attached rather than blanking a record that still has a photograph in it.
    if (row.requirement === OnboardingDocument.PHOTOGRAPH) {
      await this.assayers.update(
        { id: row.assayerId },
        { photograph: row.filePaths[row.filePaths.length - 1] ?? null, updatedBy: actorId },
      );
    }
    return key;
  }

  /**
   * Record that somebody checked an identity document against the original.
   *
   * Only identity documents are verified. The rest of the list is paperwork that either arrived
   * or did not, and a code-of-conduct letter reading "Pending verification" for ever is an alarm
   * nobody can clear — which is why the register this replaced had every row start there.
   */
  async verifyDocument(
    id: string,
    verdict: DocumentVerification,
    actorId: string,
    remarks?: string,
  ) {
    const row = await this.onboarding.findOne({ where: { id } });
    if (!row) throw new NotFoundException('No such document.');
    if (!isIdentityDocument(row.requirement)) {
      throw new BadRequestException(
        `${ONBOARDING_DOCUMENT_LABELS[row.requirement]} is not an identity document. `
        + 'Record whether it arrived instead.',
      );
    }
    if (verdict !== DocumentVerification.PENDING && !row.documentNumber) {
      throw new BadRequestException(
        'There is no document number on this record, so there is nothing to have checked against '
        + 'the original.',
      );
    }
    row.verificationStatus = verdict;
    row.verifiedAt = verdict === DocumentVerification.PENDING ? null : new Date();
    row.verifiedBy = verdict === DocumentVerification.PENDING ? null : actorId;
    if (remarks !== undefined) row.remarks = remarks || null;
    row.updatedBy = actorId;
    return this.onboarding.save(row);
  }

  // ── The import review queue ───────────────────────────────────────────

  /**
   * What the import could not read, oldest first.
   *
   * Open by default: a resolved issue is a decision somebody already made, and showing it
   * alongside the outstanding ones is how a review queue stops being read.
   */
  async listIssues(options: { includeResolved?: boolean; limit?: number } = {}) {
    const limit = Math.min(options.limit ?? 200, 500);
    const qb = this.issues.createQueryBuilder('issue')
      .leftJoin('issue.assayer', 'assayer')
      .addSelect(['assayer.id', 'assayer.assayerCode', 'assayer.firstName', 'assayer.lastName'])
      .orderBy('issue.createdAt', 'ASC')
      .take(limit);
    if (!options.includeResolved) qb.where('issue.resolvedAt IS NULL');

    const [rows, openCount] = await Promise.all([
      qb.getMany(),
      this.issues.count({ where: { resolvedAt: IsNull() } }),
    ]);
    return { rows, openCount };
  }

  async resolveIssue(id: string, resolution: string, actorId: string) {
    const row = await this.issues.findOne({ where: { id } });
    if (!row) throw new NotFoundException('No such import issue.');
    const stated = (resolution ?? '').trim();
    if (!stated) {
      // The queue exists because nothing was guessed. Closing an entry with no account of what
      // was decided puts the guess back, just without a record of it.
      throw new BadRequestException('Say what was decided about this cell before closing it.');
    }
    row.resolvedAt = new Date();
    row.resolvedBy = actorId;
    row.resolution = stated;
    row.updatedBy = actorId;
    return this.issues.save(row);
  }
}
