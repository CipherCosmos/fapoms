import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CustomerMasterVersionEntity } from './customer-master-version.entity';
import { CustomerRecordEntity } from './customer-record.entity';
import { BranchEntity } from '../branch/branch.entity';
import { CustomerMasterStatus, EventCategory } from '@fapoms/shared';
import { AuditService } from '../../core/audit/audit.service';
import * as xlsx from 'xlsx';

/** One account row from the upload that could not be tied to a branch. */
export interface UnmatchedAccountDto {
  accountNumber: string;
  solId: string | null;
  /** Plain-language why-it-didn't-match, ready to show a non-technical operator. */
  reason: string;
}

export interface CustomerMasterReconciliationReportDto {
  versionId: string;
  projectId: string;
  versionNumber: number;
  totalRowsProcessed: number;
  uniqueAccountsCount: number;
  duplicateAccountsCount: number;
  unmappedBranchCodesCount: number;
  status: CustomerMasterStatus;
  /** True when the version was created and its records saved; false when the thresholds rejected it. */
  accepted: boolean;
  /** Why the batch was rejected, in plain language — null when it was accepted. */
  blockReason: string | null;
  /** How many account rows matched no branch at all (blank code or unknown code). */
  unmatchedCount: number;
  /** The unmatched rows themselves, capped so a huge bad file cannot bloat the response. */
  unmatchedAccounts: UnmatchedAccountDto[];
  /** Distinct branches present in the file — the branches to be audited that day. */
  coveredBranchCount: number;
  auditDate: string | null;
  recommendation: string;
}

/** Reject the batch above these — the same numbers as before, named so the reason can quote them. */
const DUPLICATE_ACCOUNT_LIMIT = 50;
const UNMAPPED_BRANCH_CODE_LIMIT = 10;
/** Never return more than this many unmatched sample rows; the true total rides on `unmatchedCount`. */
const UNMATCHED_SAMPLE_LIMIT = 100;

@Injectable()
export class CustomerMasterService {
  constructor(
    @InjectRepository(CustomerMasterVersionEntity)
    private readonly versionRepository: Repository<CustomerMasterVersionEntity>,
    @InjectRepository(CustomerRecordEntity)
    private readonly recordRepository: Repository<CustomerRecordEntity>,
    @InjectRepository(BranchEntity)
    private readonly branchRepository: Repository<BranchEntity>,
    private readonly auditService: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  async uploadAndReconcile(
    projectId: string,
    fileName: string,
    filePath: string,
    fileBuffer: Buffer,
    userId: string,
    auditDate?: string,
  ): Promise<CustomerMasterReconciliationReportDto> {
    const existingVersions = await this.versionRepository.find({
      where: { projectId, isActive: true },
      order: { versionNumber: 'DESC' },
    });

    const nextVersionNumber = existingVersions.length > 0 ? existingVersions[0].versionNumber + 1 : 1;
    const previousVersion = existingVersions.length > 0 ? existingVersions[0] : null;

    const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const rows: any[] = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const totalRows = rows.length;
    let duplicateAccounts = 0;
    let unmappedBranchCodes = 0;
    // Every row that could not be tied to a branch — not just the unknown-code case counted above,
    // but blank-code rows too, since both mean "this account has no branch". The desk needs the
    // rows themselves, not only a number, to fix or knowingly ignore them.
    let unmatchedCount = 0;
    const unmatchedAccounts: UnmatchedAccountDto[] = [];
    const accountSet = new Set<string>();

    const recordEntities: Partial<CustomerRecordEntity>[] = [];

    // Pre-fetch all branch SOL IDs for DB validation check
    const dbBranches = await this.branchRepository.find({ select: ['id', 'solId'] });
    const branchMap = new Map<string, string>();
    dbBranches.forEach((b) => branchMap.set(b.solId.trim().toUpperCase(), b.id));

    // HIGH-01 Remediation: Extract account numbers and query previous records in 1000-item chunks instead of full in-memory dump
    const accountNumbersFromRows = rows
      .map((r) => String(r['Account Number'] || r.ACCOUNT_NO || r.AccountNo || '').trim())
      .filter((acc) => acc.length > 0);

    const prevRecordMap = new Map<string, string>();
    if (previousVersion && accountNumbersFromRows.length > 0) {
      const chunkSize = 1000;
      for (let i = 0; i < accountNumbersFromRows.length; i += chunkSize) {
        const chunk = accountNumbersFromRows.slice(i, i + chunkSize);
        const prevRecords = await this.recordRepository.createQueryBuilder('cr')
          .select(['cr.id', 'cr.accountNumber'])
          .where('cr.customerMasterVersionId = :versionId', { versionId: previousVersion.id })
          .andWhere('cr.accountNumber IN (:...chunk)', { chunk })
          .getMany();
        prevRecords.forEach((pr) => prevRecordMap.set(pr.accountNumber, pr.id));
      }
    }

    for (const row of rows) {
      const acc = String(row['Account Number'] || row.ACCOUNT_NO || row.AccountNo || '').trim();
      const solId = String(row['SOL ID'] || row.SOL_ID || row.SolId || row['Branch Code'] || row.BRANCH_CODE || row.BranchCode || '').trim().toUpperCase();
      const name = String(row['Customer Name'] || row.CUSTOMER_NAME || row.Name || 'Unknown Customer').trim();
      const packets = parseInt(String(row.Packets || row.PACKET_COUNT || 1), 10) || 1;

      if (!acc) continue;

      if (accountSet.has(acc)) {
        duplicateAccounts++;
      } else {
        accountSet.add(acc);
      }

      const branchId = branchMap.get(solId) || null;
      if (!branchId && solId) {
        unmappedBranchCodes++;
      }
      if (!branchId) {
        unmatchedCount++;
        if (unmatchedAccounts.length < UNMATCHED_SAMPLE_LIMIT) {
          unmatchedAccounts.push({
            accountNumber: acc,
            solId: solId || null,
            reason: solId
              ? `SOL ID "${solId}" is not in the system`
              : 'No SOL ID in the row',
          });
        }
      }

      const previousRecordId = prevRecordMap.get(acc) || null;

      recordEntities.push({
        branchId,
        accountNumber: acc,
        customerName: name,
        packetCount: packets,
        previousRecordId,
        rawData: row,
      });
    }

    // The distinct branches present in the file are the branches being audited that
    // day. Reporting this back is what lets ops confirm the batch matches the
    // schedule before anything is generated from it.
    const coveredBranchIds = new Set(recordEntities.map((r) => r.branchId).filter(Boolean) as string[]);

    // Why it was rejected, in the operator's words and quoting the numbers — a flat "rejected"
    // toast left the desk with no idea which threshold tripped or by how much.
    const blockReasons: string[] = [];
    if (duplicateAccounts > DUPLICATE_ACCOUNT_LIMIT) {
      blockReasons.push(`${duplicateAccounts} duplicate account rows (limit ${DUPLICATE_ACCOUNT_LIMIT})`);
    }
    if (unmappedBranchCodes > UNMAPPED_BRANCH_CODE_LIMIT) {
      blockReasons.push(`${unmappedBranchCodes} unknown branch codes (limit ${UNMAPPED_BRANCH_CODE_LIMIT})`);
    }
    const isBlocked = blockReasons.length > 0;
    const blockReason = isBlocked ? `Too many exceptions to accept automatically: ${blockReasons.join('; ')}.` : null;
    const status = isBlocked ? CustomerMasterStatus.REJECTED : CustomerMasterStatus.RECONCILED;

    return this.dataSource.transaction(async (manager) => {
      const versionEntity = manager.create(CustomerMasterVersionEntity, {
        projectId,
        versionNumber: nextVersionNumber,
        fileName,
        filePath,
        auditDate: auditDate ?? null,
        totalRows,
        uniqueAccounts: accountSet.size,
        duplicateAccounts,
        status,
        createdBy: userId,
        updatedBy: userId,
      });

      if (status === CustomerMasterStatus.RECONCILED) {
        await manager.createQueryBuilder()
          .update(CustomerMasterVersionEntity)
          .set({ isActive: false, updatedBy: userId })
          .where('projectId = :projectId AND isActive = true', { projectId })
          .execute();
      }

      const savedVersion = await manager.save(versionEntity);

      // CRIT-01 Remediation: Batch insert records using QueryBuilder in chunks of 1000 to prevent stack/parameter limits
      if (!isBlocked && recordEntities.length > 0) {
        const batchSize = 1000;
        for (let i = 0; i < recordEntities.length; i += batchSize) {
          const batch = recordEntities.slice(i, i + batchSize).map((r) => ({
            ...r,
            customerMasterVersionId: savedVersion.id,
            createdBy: userId,
            updatedBy: userId,
          }));
          await manager.createQueryBuilder()
            .insert()
            .into(CustomerRecordEntity)
            .values(batch as any)
            .execute();
        }
      }

      await this.auditService.recordEvent({
        category: EventCategory.OPERATIONAL,
        eventType: 'CUSTOMER_MASTER_UPLOADED',
        entityType: 'CUSTOMER_MASTER_VERSION',
        entityId: savedVersion.id,
        userId,
        remarks: `Uploaded Customer Master v${nextVersionNumber}. Total: ${totalRows}, Unique: ${accountSet.size}, Status: ${status}`,
      }, { manager });

      return {
        versionId: savedVersion.id,
        projectId,
        versionNumber: nextVersionNumber,
        totalRowsProcessed: totalRows,
        uniqueAccountsCount: accountSet.size,
        duplicateAccountsCount: duplicateAccounts,
        unmappedBranchCodesCount: unmappedBranchCodes,
        status,
        accepted: !isBlocked,
        blockReason,
        unmatchedCount,
        unmatchedAccounts,
        coveredBranchCount: coveredBranchIds.size,
        auditDate: auditDate ?? null,
        recommendation: isBlocked
          ? `Reconciliation rejected. ${blockReason}`
          : unmatchedCount > 0
            ? `Reconciliation passed with ${unmatchedCount} account row(s) that matched no branch — review before generating.`
            : 'Reconciliation passed: version created and records mapped cleanly.',
      };
    });
  }

  async approveVersion(versionId: string, userId: string): Promise<CustomerMasterVersionEntity> {
    const version = await this.versionRepository.findOne({ where: { id: versionId, isActive: true } });
    if (!version) throw new NotFoundException(`CustomerMasterVersion ${versionId} not found.`);

    if (version.status !== CustomerMasterStatus.RECONCILED) {
      throw new BadRequestException(`Cannot approve version in status ${version.status}.`);
    }

    return this.dataSource.transaction(async (manager) => {
      // Archive / Supersede any prior APPROVED versions for this project
      await manager.update(
        CustomerMasterVersionEntity,
        { projectId: version.projectId, status: CustomerMasterStatus.APPROVED },
        { status: CustomerMasterStatus.SUPERSEDED, updatedBy: userId },
      );

      version.status = CustomerMasterStatus.APPROVED;
      version.approvedBy = userId;
      version.approvedAt = new Date();
      version.updatedBy = userId;

      const saved = await manager.save(version);

      await this.auditService.recordEvent({
        category: EventCategory.OPERATIONAL,
        eventType: 'CUSTOMER_MASTER_APPROVED',
        entityType: 'CUSTOMER_MASTER_VERSION',
        entityId: saved.id,
        userId,
        remarks: `Approved Customer Master Version v${version.versionNumber} for project ${version.projectId}.`,
      }, { manager });

      return saved;
    });
  }

  /**
   * A single day's run, end to end.
   *
   * The client's batch for an audit date lists the branches to be audited that day.
   * This resolves each of those branches to its generated audit PDF and reports
   * where that PDF has reached — so one view answers "the batch had ten branches;
   * how many are generated, sent, returned, and processed?".
   *
   * That question was previously unanswerable: batches were unreachable entirely,
   * and the PDFs they produce were uploaded one at a time with no record of which
   * run they belonged to.
   */
  async dailyRun(projectId: string, auditDate: string): Promise<any> {
    const version = await this.versionRepository.findOne({
      where: { projectId, auditDate, isActive: true },
      order: { versionNumber: 'DESC' },
    });

    // Branches scheduled for this date, from the plan — independent of whether the
    // client's data has arrived. Comparing the two is the point: a branch scheduled
    // but absent from the batch means the client under-delivered.
    const scheduled = await this.dataSource.query(
      `SELECT pb.id AS project_branch_id, b.id AS branch_id, b.name AS branch_name, b.sol_id
         FROM project_branches pb
         JOIN branches b ON b.id = pb.branch_id
        WHERE pb.project_id = $1 AND pb.is_active = true AND pb.scheduled_date = $2
        ORDER BY b.name`,
      [projectId, auditDate],
    );

    // Branches actually present in the client's file.
    const inBatch: Array<{ branch_id: string; record_count: string; packet_total: string }> = version
      ? await this.dataSource.query(
          `SELECT branch_id, COUNT(*) AS record_count, COALESCE(SUM(packet_count), 0) AS packet_total
             FROM customer_records
            WHERE customer_master_version_id = $1 AND branch_id IS NOT NULL AND is_active = true
            GROUP BY branch_id`,
          [version.id],
        )
      : [];
    const batchByBranch = new Map(inBatch.map((r) => [r.branch_id, r]));

    // The audit packet produced for each branch, and where it has got to.
    const pdfs = await this.dataSource.query(
      `SELECT a.branch_id, d.id, d.file_name, d.status, d.dispatched_at, d.received_at,
              d.sent_to_external_ocr_at, d.customer_master_version_id
         FROM documents d
         JOIN assessments a ON a.id = d.assessment_id
        WHERE a.project_id = $1 AND d.type = 'PRE_FIELD_AUDIT_PDF' AND d.is_active = true`,
      [projectId],
    );
    const pdfByBranch = new Map<string, any>();
    for (const p of pdfs) {
      // Prefer the PDF explicitly produced from this batch; fall back to any packet
      // for the branch so runs predating the link still display.
      const existing = pdfByBranch.get(p.branch_id);
      if (!existing || p.customer_master_version_id === version?.id) pdfByBranch.set(p.branch_id, p);
    }

    const branches = scheduled.map((s: any) => {
      const batch = batchByBranch.get(s.branch_id);
      const pdf = pdfByBranch.get(s.branch_id);
      return {
        projectBranchId: s.project_branch_id,
        branchId: s.branch_id,
        branchName: s.branch_name,
        solId: s.sol_id,
        inBatch: !!batch,
        customerCount: batch ? Number(batch.record_count) : 0,
        packetCount: batch ? Number(batch.packet_total) : 0,
        pdf: pdf
          ? {
              id: pdf.id,
              fileName: pdf.file_name,
              status: pdf.status,
              dispatchedAt: pdf.dispatched_at,
              receivedAt: pdf.received_at,
              sentToExternalOcrAt: pdf.sent_to_external_ocr_at,
              fromThisBatch: pdf.customer_master_version_id === version?.id,
            }
          : null,
        // The single most useful field: what is the next thing a human must do.
        nextAction: !batch
          ? 'AWAITING_CLIENT_DATA'
          : !pdf
            ? 'GENERATE_PDF'
            : pdf.status === 'UPLOADED'
              ? 'DISPATCH'
              : pdf.status === 'DISPATCHED'
                ? 'AWAITING_ASSAYER_RETURN'
                : pdf.status === 'RECEIVED'
                  ? 'SEND_TO_OCR'
                  : 'IN_PROGRESS',
      };
    });

    // Branches the client sent data for that are not scheduled for this date — a
    // real mismatch worth surfacing rather than silently ignoring.
    const scheduledIds = new Set(scheduled.map((s: any) => s.branch_id));
    const unexpected = inBatch.filter((r) => !scheduledIds.has(r.branch_id)).length;

    return {
      projectId,
      auditDate,
      batch: version
        ? {
            id: version.id,
            versionNumber: version.versionNumber,
            fileName: version.fileName,
            status: version.status,
            totalRows: version.totalRows,
            uniqueAccounts: version.uniqueAccounts,
            duplicateAccounts: version.duplicateAccounts,
            uploadedAt: version.createdAt,
            approvedAt: version.approvedAt,
          }
        : null,
      summary: {
        scheduledBranches: branches.length,
        inBatch: branches.filter((b: any) => b.inBatch).length,
        awaitingClientData: branches.filter((b: any) => b.nextAction === 'AWAITING_CLIENT_DATA').length,
        toGenerate: branches.filter((b: any) => b.nextAction === 'GENERATE_PDF').length,
        toDispatch: branches.filter((b: any) => b.nextAction === 'DISPATCH').length,
        awaitingReturn: branches.filter((b: any) => b.nextAction === 'AWAITING_ASSAYER_RETURN').length,
        toSendToOcr: branches.filter((b: any) => b.nextAction === 'SEND_TO_OCR').length,
        unexpectedBranchesInBatch: unexpected,
      },
      branches,
    };
  }

  async findByProject(projectId: string): Promise<CustomerMasterVersionEntity[]> {
    return this.versionRepository.find({
      where: { projectId, isActive: true },
      order: { versionNumber: 'DESC' },
    });
  }

  async findRecords(versionId: string, page = 1, limit = 50, branchId?: string): Promise<{ records: CustomerRecordEntity[]; total: number }> {
    const where: any = { customerMasterVersionId: versionId, isActive: true };
    if (branchId) {
      where.branchId = branchId;
    }
    const [records, total] = await this.recordRepository.findAndCount({
      where,
      relations: ['branch'],
      take: limit,
      skip: (page - 1) * limit,
    });
    return { records, total };
  }

  async findRecordsByVersionAndBranch(versionId: string, branchId: string): Promise<CustomerRecordEntity[]> {
    return this.recordRepository.find({
      where: { customerMasterVersionId: versionId, branchId, isActive: true },
      relations: ['branch'],
    });
  }
}
