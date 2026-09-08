import { Injectable, NotFoundException, BadRequestException, ConflictException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, SelectQueryBuilder } from 'typeorm';
import type { GlobalScope } from '../../infrastructure/scope/global-scope';
import {
  EmpanelmentStatus, BackgroundCheckVerdict, RiskGrade, CibilBand, OnboardingDocument, ONBOARDING_DOCUMENT_COLUMNS, ONBOARDING_DOCUMENT_LABELS, DocumentVerification, isIdentityDocument, maskTail, looksMasked, isValidPan, isValidAadhaar, isPlaceholderAadhaar,
  DocumentRejectionReason, DOCUMENT_PRINTED_FIELDS, PRINTED_FIELD_LABELS,
  DOCUMENTS_PRINTING_A_NAME, IDENTITY_NAME_PRECEDENCE, IDENTITY_GATE_DOCUMENTS,
  DOCUMENT_REJECTION_GUIDANCE,
  compareNames, type NameMatchGrade,
} from '@fapoms/shared';
import { AssayerEntity } from './assayer.entity';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerDocumentVersionEntity } from './assayer-document-version.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';
import { ASSAYER_ERROR_CODES, EventCategory } from '@fapoms/shared';
import { withCode } from '../../infrastructure/http/api-error';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { AuditService } from '../../core/audit/audit.service';

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
    @Optional() @InjectRepository(AssayerDocumentVersionEntity) private readonly docVersions?: Repository<AssayerDocumentVersionEntity>,
    // Optional so existing specs that build this service through Nest's DI without an audit
    // collaborator still resolve; DI always supplies the real one. The `?` alone only helps
    // TypeScript — `@Optional()` is what stops Nest throwing when no provider is registered.
    // Every call site guards with `?.`.
    @Optional() private readonly auditService?: AuditService,
    /**
     * Optional for the same reason the audit collaborator is: specs build this service directly,
     * and a document that cannot be announced must still be able to be rejected.
     */
    @Optional() private readonly notifications?: NotificationDispatchService,
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
        // Masked on the way out, wherever it lives. The dossier is the screen a clerk works the
        // paperwork from, and it needs the last four digits to tell one card from another —
        // never the whole number, which is what `GET /assayers/:id/sensitive/:field` is for and
        // records a reader for. A number that is absent stays null: "no PAN on file" is the
        // thing the checklist exists to show, and a row of stars would hide it.
        documentNumber: maskTail(
          NUMBER_LIVES_ON_THE_PERSON[requirement]
            ? (assayer[NUMBER_LIVES_ON_THE_PERSON[requirement]!] ?? null)
            : (row?.documentNumber ?? null),
        ) || null,
        expiryDate: row?.expiryDate ?? null,
        verificationStatus: row?.verificationStatus ?? null,
        verifiedAt: row?.verifiedAt ?? null,
        /**
         * What the card says, unmasked, unlike the number above.
         *
         * The number is masked because the screen only needs enough of it to tell one card from
         * another, and the whole value has its own audited route. A name is not that kind of
         * secret — it is the thing the reviewer is comparing, so showing four characters of it
         * would defeat the entire purpose of having written it down.
         */
        holderName: row?.holderName ?? null,
        holderDateOfBirth: row?.holderDateOfBirth ?? null,
        holderGender: row?.holderGender ?? null,
        holderGuardianName: row?.holderGuardianName ?? null,
        holderAddress: row?.holderAddress ?? null,
        /** Which fields this card prints, so the form asks for those and no others. */
        prints: DOCUMENT_PRINTED_FIELDS[requirement] ?? null,
        nameMatchGrade: row?.nameMatchGrade ?? null,
        nameMatchNote: row?.nameMatchNote ?? null,
        rejectionReason: row?.rejectionReason ?? null,
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
    const previousStatus = existing?.status ?? null;
    const row = existing ?? this.empanelments.create({ assayerId, clientId, createdBy: actorId });

    row.status = dto.status;
    row.statusReason = dto.statusReason ?? null;
    row.documentsOutstanding = dto.documentsOutstanding ?? null;
    row.clientReferenceCode = dto.clientReferenceCode ?? row.clientReferenceCode ?? null;
    row.decidedAt = dto.decidedAt ? new Date(dto.decidedAt) : new Date();
    row.remarks = dto.remarks ?? null;
    row.isActive = true;
    row.updatedBy = actorId;
    const saved = await this.empanelments.save(row);
    // Whether this bank will send someone work is a decision, and "who set this and when" has
    // to be answerable the same way a lifecycle move is — there was previously no trail at all.
    await this.auditService?.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'EMPANELMENT_SET',
      entityType: 'ASSAYER',
      entityId: assayerId,
      previousState: previousStatus ?? undefined,
      newState: saved.status,
      userId: actorId,
      remarks: `Client empanelment set to ${saved.status}${dto.statusReason ? `: ${dto.statusReason}` : ''}`,
      metadata: { clientId, previousValue: { status: previousStatus }, newValue: { status: saved.status, statusReason: saved.statusReason } },
    });
    return saved;
  }

  async removeEmpanelment(id: string, actorId: string) {
    const row = await this.empanelments.findOne({ where: { id } });
    if (!row) throw new NotFoundException('No such standing.');
    const previousStatus = row.status;
    row.isActive = false;
    row.updatedBy = actorId;
    await this.empanelments.save(row);
    await this.auditService?.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'EMPANELMENT_WITHDRAWN',
      entityType: 'ASSAYER',
      entityId: row.assayerId,
      previousState: previousStatus,
      userId: actorId,
      remarks: `Client empanelment withdrawn (was ${previousStatus})`,
      metadata: { clientId: row.clientId, previousValue: { status: previousStatus, isActive: true }, newValue: { isActive: false } },
    });
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
    const saved = await this.checks.save(row);
    // A background/credit check is the grounds for admitting someone to a bank vault, and it had
    // no trail at all — only the row itself, with no record of who recorded it.
    await this.auditService?.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'BACKGROUND_CHECK_RECORDED',
      entityType: 'ASSAYER',
      entityId: assayerId,
      newState: saved.verdict,
      userId: actorId,
      remarks: `Background check recorded: ${saved.verdict}${saved.riskGrade ? ` (${saved.riskGrade})` : ''}`,
      metadata: { newValue: { verdict: saved.verdict, riskGrade: saved.riskGrade, cibilBand: saved.cibilBand, cibilScore: saved.cibilScore } },
    });
    return saved;
  }

  // ── Onboarding paperwork ──────────────────────────────────────────────

  /**
   * Is this a requirement the checklist knows?
   *
   * Membership, NOT truthiness. `ONBOARDING_DOCUMENT_COLUMNS` maps each requirement to the
   * spreadsheet column it was read from, and three of them — driving licence, voter ID, passport —
   * map to `''` because the roster file has no column for them; they came from the identity
   * register. `setDocument` tested the mapped VALUE, so those three read as unknown and every
   * `PUT` against them was refused. A clerk could upload a passport scan through `attachFile`,
   * which accepted it, and then record nothing whatsoever about the document they had just filed.
   *
   * `attachFile` had the opposite fault: no check at all, so any string at all created a document
   * row. That is how a typo or a renamed enum value grows a parallel set of rows that no
   * checklist counts and no queue ever shows. Both go through this now.
   */
  private assertKnownRequirement(requirement: OnboardingDocument): void {
    if (!Object.prototype.hasOwnProperty.call(ONBOARDING_DOCUMENT_COLUMNS, requirement)) {
      throw withCode(
        new BadRequestException(`"${requirement}" is not a paperwork requirement this system knows.`),
        ASSAYER_ERROR_CODES.DOCUMENT_REQUIREMENT_UNKNOWN,
      );
    }
  }

  async setDocument(
    assayerId: string,
    requirement: OnboardingDocument,
    dto: { softCopyReceived?: boolean | null; hardCopyReceived?: boolean | null;
           hardCopyLocation?: string; courierReference?: string; receivedAt?: string; remarks?: string;
           documentNumber?: string; expiryDate?: string | null },
    actorId: string,
  ) {
    let withdrewVerification = false;
    this.assertKnownRequirement(requirement);
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
    // The document screen reads its number from `dossier()`, which now masks it, so the same
    // round trip the profile form has is open here — and this one writes THROUGH to
    // `assayers.pan_number` for the three requirements in NUMBER_LIVES_ON_THE_PERSON. Saving the
    // asterisks would replace the person's real PAN from the paperwork screen, one step further
    // from anywhere anybody would think to look for it. Same rule and same way out as
    // `assertNoMaskedPii` in AssayerService.
    if (typeof dto.documentNumber === 'string' && looksMasked(dto.documentNumber)) {
      throw withCode(
        new BadRequestException(
          'The document number you sent is the masked version shown on screen, not the real number, '
          + 'and saving it would overwrite the real one. Reveal the field first, then edit it.',
        ),
        ASSAYER_ERROR_CODES.MASKED_VALUE_REJECTED,
      );
    }

    if (dto.documentNumber !== undefined || dto.expiryDate !== undefined) {
      if (!isIdentityDocument(requirement)) {
        throw new BadRequestException(
          `${ONBOARDING_DOCUMENT_LABELS[requirement]} is not an identity document, so it carries `
          + 'no number or expiry date.',
        );
      }
      const column = NUMBER_LIVES_ON_THE_PERSON[requirement];
      if (dto.documentNumber !== undefined) {
        /**
         * The same format rule the create and update DTOs apply, enforced here because only this
         * layer knows which document is being recorded.
         *
         * `@IsPanFormat()` and `@IsAadhaarNumber()` sit on the assayer DTOs, but which of them
         * applies depends on the `:requirement` route parameter, which class-validator cannot
         * see — so this route reached `assayers.pan_number` and `assayers.aadhaar_number` with no
         * format check at all while its two siblings refused a malformed value. The point of
         * `@fapoms/shared/identity-validation` is that every path to these columns asks the same
         * question; this was the path that did not.
         *
         * Verhoeff matters here rather than being pedantry: a mistyped Aadhaar that passes
         * `\d{12}` is indistinguishable from a real one later, and this number is what a human is
         * meant to check the scan against.
         */
        const shaped = (dto.documentNumber ?? '').trim().toUpperCase();
        if (shaped) {
          if (column === 'panNumber' && !isValidPan(shaped)) {
            throw withCode(
              new BadRequestException(
                'That is not a valid PAN. It should be ten characters, like ABCDE1234F.',
              ),
              ASSAYER_ERROR_CODES.DOCUMENT_NUMBER_INVALID,
            );
          }
          if (column === 'aadhaarNumber' && !isValidAadhaar(shaped)) {
            throw withCode(
              new BadRequestException(
                isPlaceholderAadhaar(shaped)
                  ? 'That Aadhaar number is a placeholder, not a real one. Leave it blank rather '
                    + 'than recording a stand-in.'
                  : 'That is not a valid Aadhaar number. It should be twelve digits, and the check '
                    + 'digit did not match — please re-read it from the document.',
              ),
              ASSAYER_ERROR_CODES.DOCUMENT_NUMBER_INVALID,
            );
          }
        }
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
      withdrewVerification = this.undoVerification(row, 'the document details changed');
    }

    row.isActive = true;
    row.updatedBy = actorId;
    const saved = await this.onboarding.save(row);
    // Only when something was actually withdrawn: the name of record follows the verifications, so
    // an ordinary clerical edit has no bearing on it and should not pay for a re-derivation.
    if (withdrewVerification) await this.deriveLegalName(assayerId, actorId);
    return saved;
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
  async attachFile(
    assayerId: string,
    requirement: OnboardingDocument,
    key: string,
    actorId: string,
    metadata?: {
      checksum?: string;
      contentSha256?: string;
      storageObjectId?: string;
      fileSize?: number;
      mimeType?: string;
    },
  ) {
    this.assertKnownRequirement(requirement);
    let existing = await this.onboarding.findOne({ where: { assayerId, requirement } });
    let row = existing ?? this.onboarding.create({ assayerId, requirement, createdBy: actorId, filePaths: [] });
    if (!row.id) {
      row = await this.onboarding.save(row);
    }

    // Determine next version number for this document
    let nextVersion = 1;
    if (this.docVersions && row.id) {
      const latest = await this.docVersions.findOne({
        where: { documentId: row.id },
        order: { version: 'DESC' },
      });
      if (latest) {
        nextVersion = latest.version + 1;
      }
    }

    let newVersionRecord: AssayerDocumentVersionEntity | null = null;
    if (this.docVersions && row.id) {
      const sha256 = metadata?.contentSha256 ?? metadata?.checksum ?? null;
      newVersionRecord = this.docVersions.create({
        documentId: row.id,
        assayerId,
        requirement,
        version: nextVersion,
        filePath: key,
        fileChecksum: sha256,
        contentSha256: sha256,
        storageObjectId: metadata?.storageObjectId ?? key,
        fileSize: metadata?.fileSize ?? null,
        mimeType: metadata?.mimeType ?? null,
        uploadedBy: actorId,
        verificationStatus: DocumentVerification.PENDING,
        verifiedAt: null,
        verifiedBy: null,
        rejectionReason: null,
        supersededByVersionId: null,
        supersededAt: null,
      });
      newVersionRecord = await this.docVersions.save(newVersionRecord);

      // If there was a previous version, link supersession relationship
      if (row.currentVersionId) {
        await this.docVersions.update(
          { id: row.currentVersionId },
          {
            supersededByVersionId: newVersionRecord.id,
            supersededAt: new Date(),
          },
        );
      }
      row.currentVersionId = newVersionRecord.id;
    }

    /**
     * A photograph is replaced; a document accumulates.
     *
     * Every other requirement keeps its history — an earlier Aadhaar scan is evidence of what was
     * checked and when, and a re-upload is a second page or a better picture of the same card. A
     * face is not evidence of anything except what somebody looked like, and appending would grow
     * the array without bound every time a person retakes their photo while
     * `assayers.photograph` silently followed the last one anyway.
     */
    row.filePaths = requirement === OnboardingDocument.PHOTOGRAPH
      ? [key]
      : [...(row.filePaths ?? []), key];
    if (row.softCopyReceived !== true) row.softCopyReceived = true;

    /**
     * A new scan on a verified document undoes the verification on the active row.
     *
     * The previous version (v1) retains its historical verification record in
     * `assayer_document_versions`, while the current state becomes v2 pending review.
     * v2 does NOT implicitly inherit v1 approval.
     */
    const withdrawn = this.undoVerification(row, 'a new scan was uploaded');
    // A rejection is answered by the new scan, so it stops being the current state of this row.
    if (row.verificationStatus === DocumentVerification.REJECTED) {
      row.verificationStatus = DocumentVerification.PENDING;
      row.rejectionReason = null;
    }
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

    if (withdrawn) await this.deriveLegalName(assayerId, actorId);

    /**
     * Recording that a scan arrived left no trail at all, unlike verifying it.
     *
     * Only for the documents that establish who somebody is — writing an audit row for each of the
     * twelve clerical requirements would add eleven thousand entries of "the NDA arrived" and teach
     * every reader to scroll past the trail.
     */
    if (isIdentityDocument(requirement) || requirement === OnboardingDocument.PHOTOGRAPH) {
      await this.auditService?.recordEventSafe({
        category: EventCategory.OPERATIONAL,
        eventType: 'IDENTITY_DOCUMENT_FILE_ATTACHED',
        entityType: 'ASSAYER',
        entityId: assayerId,
        userId: actorId,
        remarks: `A scan of ${ONBOARDING_DOCUMENT_LABELS[requirement]} (v${nextVersion}) was uploaded.`,
        // The key, never the image, and never the number the image shows.
        metadata: {
          requirement,
          version: nextVersion,
          versionId: newVersionRecord?.id ?? null,
          fileCount: row.filePaths.length,
          withdrewVerification: withdrawn,
        },
      });
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
  /**
   * What a reviewer is attesting to, beyond the verdict itself.
   *
   * Optional as a whole so every existing caller still compiles, and checked field by field
   * against what the card in question actually prints.
   */
  /**
   * Undo a verification whose evidence no longer stands, wherever that happens.
   *
   * One place, because the ways a verification stops being true are not obvious and were not all
   * covered: the number changing was, but a new scan landing on a verified row was not, and neither
   * was the *other* side of the comparison moving — somebody could verify a document against one
   * name and then rename the record, leaving an attestation that no longer says anything.
   *
   * Deliberately not triggered by the clock. A passport passing its expiry must not flip a stored
   * column: that would be a write nobody made, and expiry is already derived where it is read.
   */
  private undoVerification(row: AssayerDocumentEntity, because: string): boolean {
    if (row.verificationStatus !== DocumentVerification.VERIFIED) return false;
    row.verificationStatus = DocumentVerification.PENDING;
    row.verifiedAt = null;
    row.verifiedBy = null;
    row.nameMatchGrade = null;
    row.nameMatchNote = null;
    row.remarks = [row.remarks, `Verification withdrawn — ${because}.`].filter(Boolean).join(' ');
    return true;
  }

  /**
   * The person's name changed, so every verification that was checked against it is stale.
   *
   * Called from `AssayerService.update`. Without it the guard on the name comparison is defeated by
   * doing the two steps in order: verify a genuine document under the name it matches, then edit
   * the record to any other name. The attestation would survive, still saying VERIFIED, having
   * compared a name that is no longer there.
   */
  async revalidateAfterNameChange(assayerId: string, actorId: string): Promise<number> {
    const rows = await this.onboarding.find({
      where: { assayerId, isActive: true, verificationStatus: DocumentVerification.VERIFIED },
    });
    const affected = rows.filter((row) =>
      DOCUMENTS_PRINTING_A_NAME.includes(row.requirement as OnboardingDocument));
    for (const row of affected) {
      this.undoVerification(row, 'the name on the record was changed');
      row.updatedBy = actorId;
      await this.onboarding.save(row);
      await this.auditService?.recordEventSafe({
        category: EventCategory.OPERATIONAL,
        eventType: 'IDENTITY_DOCUMENT_VERIFICATION_INVALIDATED',
        entityType: 'ASSAYER',
        entityId: assayerId,
        userId: actorId,
        remarks: `${ONBOARDING_DOCUMENT_LABELS[row.requirement]} needs checking again — the name on `
          + 'the record was changed after it was verified.',
        metadata: { requirement: row.requirement, cause: 'NAME_CHANGED' },
      });
    }
    if (affected.length > 0) await this.deriveLegalName(assayerId, actorId);
    return affected.length;
  }

  /**
   * Invalidate document verification for a specific field change (PAN, Aadhaar, Bank Details).
   * Ensures surgical field-specific re-verification without resetting unrelated evidence.
   */
  async invalidateDocumentForFieldChange(
    assayerId: string,
    requirement: OnboardingDocument,
    reason: string,
    actorId: string,
  ): Promise<boolean> {
    const row = await this.onboarding.findOne({
      where: { assayerId, requirement, isActive: true },
    });
    if (!row || row.verificationStatus !== DocumentVerification.VERIFIED) return false;

    this.undoVerification(row, reason);
    row.updatedBy = actorId;
    await this.onboarding.save(row);

    // If versioning entity is active, mark version pending as well
    if (this.docVersions && row.currentVersionId) {
      await this.docVersions.update(
        { id: row.currentVersionId },
        { verificationStatus: DocumentVerification.PENDING, verifiedAt: null, verifiedBy: null },
      );
    }

    await this.auditService?.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'DOCUMENT_VERIFICATION_INVALIDATED',
      entityType: 'ASSAYER',
      entityId: assayerId,
      userId: actorId,
      remarks: `${ONBOARDING_DOCUMENT_LABELS[requirement]} verification invalidated: ${reason}. Re-verification required.`,
      metadata: { requirement, reason },
    });

    if (requirement === OnboardingDocument.BANK_PASSBOOK) {
      await this.assayers.update({ id: assayerId }, { identityVerifiedAt: null });
    }

    return true;
  }

  /**
   * Has this person's identity actually been established, and if not, what is missing?
   *
   * One home for the question, because it is asked from three places that must not be able to
   * disagree: the activation gate, the workforce review queue, and the roster's own filter. It is
   * deliberately expressed in documents rather than in a flag on the person — a flag would have to
   * be maintained, and the thing it would be maintained from is right here.
   *
   * "Verified" means a scan exists AND somebody attested to it. Neither half is enough on its own:
   * the roster import wrote 11,160 rows saying a document arrived with no file behind any of them,
   * so a count of rows would report this estate as fully documented.
   */
  async identityStanding(assayerId: string): Promise<{
    verified: OnboardingDocument[];
    missing: OnboardingDocument[];
    rejected: OnboardingDocument[];
    ok: boolean;
  }> {
    const rows = await this.onboarding.find({ where: { assayerId, isActive: true } });
    const byRequirement = new Map(rows.map((r) => [r.requirement as OnboardingDocument, r]));

    const verified: OnboardingDocument[] = [];
    const missing: OnboardingDocument[] = [];
    const rejected: OnboardingDocument[] = [];

    for (const requirement of IDENTITY_GATE_DOCUMENTS) {
      const row = byRequirement.get(requirement);
      const hasEvidence = (row?.filePaths ?? []).length > 0;
      if (row?.verificationStatus === DocumentVerification.VERIFIED && hasEvidence) {
        verified.push(requirement);
      } else if (row?.verificationStatus === DocumentVerification.REJECTED) {
        rejected.push(requirement);
      } else {
        missing.push(requirement);
      }
    }

    return { verified, missing, rejected, ok: missing.length === 0 && rejected.length === 0 };
  }

  /**
   * The name of record, taken from whichever identity document established it.
   *
   * One writer, so `assayers.legal_name` can always be traced back to a card somebody checked. It
   * re-derives rather than accumulating: when a verification is undone the name has to fall back
   * to the next document that still holds one, and when none does it has to disappear — a legal
   * name outliving the evidence for it is exactly the sort of confident, unfounded fact this whole
   * exercise exists to remove.
   *
   * `displayName` is untouched. That is what the organisation calls this person; this is what a
   * bank's branch would find on their Aadhaar, and the two are allowed to differ until somebody
   * reconciles them deliberately.
   */
  private async deriveLegalName(assayerId: string, actorId: string): Promise<void> {
    const rows = await this.onboarding.find({ where: { assayerId, isActive: true } });
    const verified = new Map(
      rows
        .filter((r) => r.verificationStatus === DocumentVerification.VERIFIED && r.holderName)
        .map((r) => [r.requirement as OnboardingDocument, r]),
    );

    const source = IDENTITY_NAME_PRECEDENCE.find((requirement) => verified.has(requirement));
    const row = source ? verified.get(source)! : null;

    await this.assayers.update({ id: assayerId }, {
      legalName: row?.holderName ?? null,
      legalNameSource: source ?? null,
      // Null again when the last verification is undone: "identity was established" must not
      // survive the evidence being withdrawn.
      identityVerifiedAt: row ? (row.verifiedAt ?? new Date()) : null,
      updatedBy: actorId,
    } as any);
  }

  async verifyDocument(
    id: string,
    verdict: DocumentVerification,
    actorId: string,
    remarks?: string,
    attested?: {
      holderName?: string | null;
      holderDateOfBirth?: string | null;
      holderGender?: string | null;
      holderGuardianName?: string | null;
      holderAddress?: string | null;
      rejectionReason?: DocumentRejectionReason | null;
      /** The reviewer has seen that the name does not agree, and says why they accepted it. */
      nameMismatchNote?: string | null;
      /** Explicit version to bind verification to */
      targetVersionId?: string | null;
      /** Optimistic concurrency version check */
      expectedDocVersion?: number;
      /** Exact content SHA-256 hash reviewer attested against */
      expectedContentHash?: string | null;
    },
  ) {
    const row = await this.onboarding.findOne({ where: { id } });
    if (!row) throw new NotFoundException('No such document.');

    // Row-level optimistic concurrency check
    if (attested?.expectedDocVersion !== undefined && (row as any).version !== attested.expectedDocVersion) {
      throw new ConflictException(
        `DOCUMENT_VERSION_STALE: Expected document version ${attested.expectedDocVersion} but found ${(row as any).version}. The document was modified concurrently.`,
      );
    }

    if (!isIdentityDocument(row.requirement)) {
      throw new BadRequestException(
        `${ONBOARDING_DOCUMENT_LABELS[row.requirement]} is not an identity document. `
        + 'Record whether it arrived instead.',
      );
    }

    // Bind verification to specific document version
    const targetVersionId = attested?.targetVersionId ?? row.currentVersionId;
    let targetVersionRecord: AssayerDocumentVersionEntity | null = null;
    if (this.docVersions && targetVersionId) {
      targetVersionRecord = await this.docVersions.findOne({ where: { id: targetVersionId } });
      if (!targetVersionRecord) {
        throw new NotFoundException(`Document version ${targetVersionId} not found.`);
      }

      if (targetVersionRecord.supersededByVersionId || (row.currentVersionId && row.currentVersionId !== targetVersionId)) {
        throw new ConflictException(
          `CANNOT_VERIFY_SUPERSEDED_VERSION: Document version v${targetVersionRecord.version} has been superseded by a newer upload. Only the current version can be verified.`,
        );
      }

      // Invariant: Verification must bind to exact document version AND content hash
      const versionHash = targetVersionRecord.contentSha256 ?? targetVersionRecord.fileChecksum;
      if (attested?.expectedContentHash && versionHash && versionHash !== attested.expectedContentHash) {
        throw new ConflictException(
          `CONTENT_HASH_MISMATCH: Document content hash has changed (${versionHash} vs expected ${attested.expectedContentHash}). Verification cannot silently apply to a different content hash.`,
        );
      }

      if (
        targetVersionRecord.verificationStatus !== DocumentVerification.PENDING &&
        targetVersionRecord.verificationStatus !== verdict
      ) {
        throw new ConflictException(
          `DOCUMENT_ALREADY_REVIEWED: This document version has already been marked ${targetVersionRecord.verificationStatus} by another reviewer.`,
        );
      }
    }
    /**
     * The number is read from wherever it actually lives, which for the three that matter most is
     * NOT this row.
     *
     * `setDocument` stores a PAN or Aadhaar on the PERSON (`NUMBER_LIVES_ON_THE_PERSON`) so one
     * value cannot disagree with itself, and the dossier already reads it back that way. This
     * check did not: it tested `row.documentNumber`, which stays NULL for exactly PAN_CARD,
     * AADHAAR_FRONT and AADHAAR_BACK — so the three identity documents every bank actually asks
     * for could never be marked verified. Entering the number, uploading the scan and pressing
     * verify returned "there is no document number on this record" every time, with the number
     * plainly visible on the same screen. That blocks the DOCUMENT_VERIFICATION stage, and with
     * it activation, for every appraiser.
     */
    const numberOnPerson = NUMBER_LIVES_ON_THE_PERSON[row.requirement];
    let effectiveNumber: string | null = row.documentNumber ?? null;
    if (numberOnPerson) {
      const person = await this.assayers.findOne({ where: { id: row.assayerId } });
      effectiveNumber = (person?.[numberOnPerson] as string | null) ?? null;
    }
    /**
     * A number is needed to ATTEST, not to refuse.
     *
     * This read `verdict !== PENDING`, which caught REJECTED too — and made the commonest rejection
     * of all impossible to record. You reject an illegible scan precisely *because* you could not
     * read the number off it; demanding the number first is asking the reviewer for the thing they
     * are telling you they could not get.
     */
    if (verdict === DocumentVerification.VERIFIED && !effectiveNumber) {
      throw new BadRequestException(
        'There is no document number on this record, so there is nothing to have checked against '
        + 'the original.',
      );
    }

    /**
     * And there has to be a document to have checked.
     *
     * The roster import wrote 11,160 rows that say a document was received and hold no file —
     * `DataIntegrityService` reports them as "ticked as received, but no scan was kept". Without
     * this line every one of them could be marked verified in a single click, and the record would
     * then assert that somebody checked a scan that does not exist. That is a worse lie than the
     * tick, because a verification carries a name and a timestamp.
     */
    if (verdict === DocumentVerification.VERIFIED && (row.filePaths ?? []).length === 0) {
      throw new BadRequestException(
        `There is no scan of this ${ONBOARDING_DOCUMENT_LABELS[row.requirement]} on file, so there `
        + 'is nothing to have checked against the original. Upload the document first.',
      );
    }
    /**
     * A rejection has to say why, because the sentence has somewhere to go.
     *
     * It reaches the appraiser's phone in their own language and tells them whether to photograph
     * the same card again or find a different one. "Sent back" on its own is a dead end for the
     * person who has to act on it, and the database CHECK refuses it too.
     */
    if (verdict === DocumentVerification.REJECTED && !attested?.rejectionReason) {
      throw new BadRequestException(
        'Say why the document was sent back. The reason is shown to the appraiser, and it is what '
        + 'tells them whether to photograph the same card again or send a different one.',
      );
    }

    let nameMatch: NameMatchGrade | null = null;

    if (verdict === DocumentVerification.VERIFIED) {
      /**
       * The reviewer types what the card says, and only what the card actually carries.
       *
       * Asking for a field the document does not print — an address on the Aadhaar *front*, which
       * is the photo side — teaches people that the form asks for things that are not there, and a
       * form that does that gets ignored wholesale.
       */
      const prints = DOCUMENT_PRINTED_FIELDS[row.requirement as OnboardingDocument];
      if (prints) {
        const supplied: Record<string, unknown> = {
          name: attested?.holderName ?? row.holderName,
          dateOfBirth: attested?.holderDateOfBirth ?? row.holderDateOfBirth,
          gender: attested?.holderGender ?? row.holderGender,
          guardianName: attested?.holderGuardianName ?? row.holderGuardianName,
          address: attested?.holderAddress ?? row.holderAddress,
        };
        const missing = (Object.keys(prints) as Array<keyof typeof prints>)
          .filter((field) => prints[field] && !String(supplied[field] ?? '').trim())
          .map((field) => PRINTED_FIELD_LABELS[field]);
        if (missing.length > 0) {
          throw new BadRequestException(
            `Before this ${ONBOARDING_DOCUMENT_LABELS[row.requirement]} can be marked verified, `
            + `record what it says: ${missing.join(', ')}. That is what the record is checked `
            + 'against — a verification that compares nothing attests to nothing.',
          );
        }
      }

      if (attested?.holderName !== undefined) row.holderName = attested.holderName || null;
      if (attested?.holderDateOfBirth !== undefined) {
        row.holderDateOfBirth = attested.holderDateOfBirth ? new Date(attested.holderDateOfBirth) : null;
      }
      if (attested?.holderGender !== undefined) row.holderGender = attested.holderGender || null;
      if (attested?.holderGuardianName !== undefined) row.holderGuardianName = attested.holderGuardianName || null;
      if (attested?.holderAddress !== undefined) row.holderAddress = attested.holderAddress || null;

      /**
       * Does the name on the card agree with the name on the record?
       *
       * A MISMATCH is refused rather than warned about, but it is not a wall: the reviewer may go
       * ahead by saying why, and that sentence is stored beside the grade as evidence that a human
       * saw the disagreement. The roster's names are the unreliable side of this comparison — they
       * were hand-typed over years and split on the last space — so refusing outright would stop a
       * legitimate estate rather than catching a fraudulent one.
       */
      if (DOCUMENTS_PRINTING_A_NAME.includes(row.requirement as OnboardingDocument)) {
        const person = await this.assayers.findOne({ where: { id: row.assayerId } });
        nameMatch = compareNames(person?.displayName, row.holderName).grade;
        const note = String(attested?.nameMismatchNote ?? '').trim();
        if (nameMatch === 'MISMATCH' && note.length < 10) {
          throw new BadRequestException(
            `The name on this document ("${row.holderName}") does not match the name on the record `
            + `("${person?.displayName ?? '—'}"). If it is the same person, say why in a sentence `
            + 'and it will be recorded with the verification. If it is not, send the document back.',
          );
        }
        row.nameMatchGrade = nameMatch;
        row.nameMatchNote = note || null;
      }
    }

    if (this.docVersions && targetVersionRecord) {
      targetVersionRecord.verificationStatus = verdict;
      targetVersionRecord.verifiedAt = verdict === DocumentVerification.PENDING ? null : new Date();
      targetVersionRecord.verifiedBy = verdict === DocumentVerification.PENDING ? null : actorId;
      targetVersionRecord.rejectionReason = verdict === DocumentVerification.REJECTED
        ? (attested?.rejectionReason ?? null)
        : null;
      await this.docVersions.save(targetVersionRecord);
    }

    const previousStatus = row.verificationStatus;
    row.verificationStatus = verdict;
    row.verifiedAt = verdict === DocumentVerification.PENDING ? null : new Date();
    row.verifiedBy = verdict === DocumentVerification.PENDING ? null : actorId;
    // Carried only on a rejection: a reason left behind on a later verification would describe a
    // decision that has been reversed.
    row.rejectionReason = verdict === DocumentVerification.REJECTED
      ? (attested?.rejectionReason ?? null)
      : null;
    if (remarks !== undefined) row.remarks = remarks || null;
    row.updatedBy = actorId;
    const saved = await this.onboarding.save(row);

    // The name of record follows the documents, so it has to be re-derived whenever one of them
    // changes verdict — in either direction.
    await this.deriveLegalName(row.assayerId, actorId);

    /**
     * Tell the person whose document it is.
     *
     * A rejection that only the office can see is a queue of one: the appraiser carries on
     * believing their paperwork is in, and the desk waits for a replacement nobody has asked for.
     * The body is the guidance sentence — what to DO — rather than the reviewer's label, which
     * states a finding: "photograph it again in better light" instead of "too blurred".
     *
     * Nothing on a VERIFIED verdict. Telling somebody their PAN was accepted is noise, and a
     * channel that carries noise stops being read before it carries something that matters.
     */
    if (verdict === DocumentVerification.REJECTED) {
      const reason = attested?.rejectionReason;
      this.notifications?.emitSafe({
        type: 'ASSAYER_IDENTITY_DOCUMENT_REJECTED',
        entityType: 'ASSAYER',
        entityId: saved.assayerId,
        actorUserId: actorId,
        assayerId: saved.assayerId,
        // Keyed on the verdict's moment, so a second rejection of a replacement is its own message
        // rather than being swallowed as a duplicate of the first.
        dedupeKey: `IDENTITY_REJECTED:${saved.id}:${saved.verifiedAt?.toISOString() ?? ''}`,
        payload: {
          documentName: ONBOARDING_DOCUMENT_LABELS[saved.requirement],
          guidance: reason
            ? DOCUMENT_REJECTION_GUIDANCE[reason]
            : 'The office could not accept this. Please take a clear photo of the whole document and send it again.',
        },
      });
    }
    // Verify/reject/reset (PENDING is a reset) on an identity document had no trail — the only
    // evidence was the row's current state, with no record of who checked it or when it changed.
    await this.auditService?.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'IDENTITY_DOCUMENT_VERIFICATION_CHANGED',
      entityType: 'ASSAYER',
      entityId: saved.assayerId,
      previousState: previousStatus ?? undefined,
      newState: verdict,
      userId: actorId,
      remarks: `${ONBOARDING_DOCUMENT_LABELS[saved.requirement]} verification set to ${verdict}`,
      metadata: {
        requirement: saved.requirement,
        previousValue: { verificationStatus: previousStatus },
        newValue: { verificationStatus: verdict },
      },
    });
    return saved;
  }

  // ── The import review queue ───────────────────────────────────────────

  /**
   * The review queue — what the import could not read and what the data-integrity scan found —
   * newest first.
   *
   * Newest first and a 500 default, where this used to be oldest-first with a default of 200:
   * that combination silently hid 83 of the 283 open findings from the panel (`openCount` said
   * 283; the body could only ever show the oldest 200), and every row the standing scanner adds
   * sorts LAST under `ASC` — the freshest defect would have been the least visible. The 500
   * ceiling stands so one request cannot balloon; the panel says "showing X of Y" when it is hit.
   *
   * Open by default: a resolved issue is a decision somebody already made, and showing it
   * alongside the outstanding ones is how a review queue stops being read.
   *
   * Region-scoped like the roster it is drawn from: `AssayerController.findAll` honours
   * `scope.regions`, and this queue did not, so a region-scoped desk saw import issues for every
   * territory, not their own. Scoped by the ISSUE'S OWN assayer — the `issue.assayer` join this
   * already carries for the row's display columns — rather than by anything on the issue itself,
   * since an issue has no region of its own. An issue with no assayer attached (`assayerId` is
   * nullable: the commonest case is an unmatched source code, which is exactly the row most worth
   * surfacing — see the entity's own comment) has no region to test either way, so it is ORed
   * into every scope rather than silently dropped out of all of them the moment any scope narrows.
   */
  async listIssues(options: {
    includeResolved?: boolean;
    limit?: number;
    scope?: Partial<GlobalScope>;
  } = {}) {
    const limit = Math.min(options.limit ?? 500, 500);
    const regions = options.scope?.regions;

    const applyRegionScope = (qb: SelectQueryBuilder<AssayerImportIssueEntity>) => {
      if (regions?.length) {
        qb.andWhere('(assayer.region IN (:...regions) OR issue.assayerId IS NULL)', { regions });
      }
      return qb;
    };

    const rowsQb = this.issues.createQueryBuilder('issue')
      .leftJoin('issue.assayer', 'assayer')
      .addSelect(['assayer.id', 'assayer.assayerCode', 'assayer.firstName', 'assayer.lastName', 'assayer.region'])
      .orderBy('issue.createdAt', 'DESC')
      .take(limit);
    if (!options.includeResolved) rowsQb.where('issue.resolvedAt IS NULL');
    // Appended after the conditional `.where()` above, never before: TypeORM's `.where()` resets
    // whatever conditions already exist on the builder, so an `.andWhere()` call ahead of it would
    // be silently discarded rather than combined.
    applyRegionScope(rowsQb);

    // A genuinely separate query, not `rows.length`: the count means "how many are open" whether
    // or not this call is also showing resolved ones, and it carries no `.take()` ceiling of its
    // own — the row list can be capped at 500 while the count still reports the true total.
    const countQb = this.issues.createQueryBuilder('issue')
      .leftJoin('issue.assayer', 'assayer')
      .where('issue.resolvedAt IS NULL');
    applyRegionScope(countQb);

    const [rows, openCount] = await Promise.all([rowsQb.getMany(), countQb.getCount()]);
    return { rows, openCount };
  }

  /**
   * Files a district-vs-pincode disagreement as a review-queue row, for a record the API just
   * wrote — not a spreadsheet import. `AssayerService.create`/`update` used to 400 on this
   * mismatch outright, which directly contradicted the registration wizard's own promise that
   * such a record "will be saved as entered". The record is now saved exactly as the clerk typed
   * it; this is the queue entry that says so, in the same table and under the same operating
   * rule every other row here already follows — nothing guessed or changed automatically, every
   * one waits for a person to decide.
   *
   * `source_sheet`/`source_row`/`source_column` exist for a spreadsheet cell — see the entity's
   * own comment — and there is no sheet or row behind a live API write, so `sourceSheet` carries
   * a constant that names the KIND of issue instead of a real sheet, `sourceRow` is `0` (never a
   * value `roster-import.service.ts` produces — its rows start at 2), and `sourceColumn` names
   * the field in question. `resolveIssue`/`listIssues` read this row exactly like an importer one;
   * neither cares where a row came from.
   */
  async recordDistrictPincodeMismatch(
    assayerId: string,
    info: { enteredDistrict: string; authorityDistrict: string; authorityState: string; pincode: string },
    actorId: string,
  ): Promise<AssayerImportIssueEntity> {
    const row = this.issues.create({
      assayerId,
      sourceAssayerCode: null,
      sourceSheet: 'DISTRICT_PINCODE_MISMATCH',
      sourceRow: 0,
      sourceColumn: 'District',
      rawValue: info.enteredDistrict,
      reason: `Pincode ${info.pincode} is in ${info.authorityDistrict} district (${info.authorityState}), but ` +
        `the record says "${info.enteredDistrict}". Saved as entered — confirm which is right.`,
      createdBy: actorId,
      updatedBy: actorId,
    });
    return this.issues.save(row);
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

  /**
   * Close a group of issues under one account of what was decided.
   *
   * One import problem produces one issue per affected row — a mis-spelled state column across a
   * 68-person branch is 68 entries and ONE decision. Closing them through the per-row route meant
   * 68 requests, and a failure partway through left the group half closed with nothing in the
   * queue to say where it stopped.
   *
   * Every id gets an outcome and the request never fails as a whole. An id that is unknown or
   * already resolved is reported against itself and the remaining rows still close: somebody else
   * having touched one row of a group is not a reason to abandon the other sixty-seven, and it is
   * the commonest way two people working the same queue collide.
   *
   * Sequential rather than `Promise.all`: these are writes to one table and the batch is bounded
   * at 500 by the request DTO, so there is nothing to win by making the database do them at once
   * beyond a lock contention this does not need.
   */
  async resolveIssues(ids: string[], resolution: string, actorId: string) {
    const stated = (resolution ?? '').trim();
    if (!stated) {
      throw new BadRequestException('Say what was decided about these cells before closing them.');
    }

    // Duplicates in the payload would otherwise produce two outcomes for one id, the second of
    // them a spurious "already resolved" caused by the first.
    const unique = [...new Set(ids ?? [])];
    const results: Array<{ id: string; resolved: boolean; reason?: string }> = [];

    for (const id of unique) {
      const row = await this.issues.findOne({ where: { id } });
      if (!row) {
        results.push({ id, resolved: false, reason: 'No such import issue.' });
        continue;
      }
      if (row.resolvedAt) {
        results.push({ id, resolved: false, reason: 'Already closed by somebody else.' });
        continue;
      }
      row.resolvedAt = new Date();
      row.resolvedBy = actorId;
      row.resolution = stated;
      row.updatedBy = actorId;
      await this.issues.save(row);
      results.push({ id, resolved: true });
    }

    return {
      results,
      resolved: results.filter((r) => r.resolved).length,
      failed: results.filter((r) => !r.resolved).length,
      // What the queue should show next, read after the writes — so a panel that refreshes from
      // this response cannot briefly display a count the batch has already changed.
      openCount: await this.issues.count({ where: { resolvedAt: IsNull() } }),
    };
  }
}
