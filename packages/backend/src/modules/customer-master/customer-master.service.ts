import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CustomerMasterVersionEntity } from './customer-master-version.entity';
import { CustomerRecordEntity } from './customer-record.entity';
import { BranchEntity } from '../branch/branch.entity';
import { CustomerMasterStatus, EventCategory } from '@fapoms/shared';
import { AuditService } from '../../core/audit/audit.service';
import * as xlsx from 'xlsx';

export interface CustomerMasterReconciliationReportDto {
  versionId: string;
  projectId: string;
  versionNumber: number;
  totalRowsProcessed: number;
  uniqueAccountsCount: number;
  duplicateAccountsCount: number;
  unmappedBranchCodesCount: number;
  status: CustomerMasterStatus;
  recommendation: string;
}

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

    let totalRows = rows.length;
    let duplicateAccounts = 0;
    let unmappedBranchCodes = 0;
    const accountSet = new Set<string>();

    const recordEntities: Partial<CustomerRecordEntity>[] = [];

    // Pre-fetch all branch codes for DB validation check
    const dbBranches = await this.branchRepository.find({ select: ['id', 'branchCode'] });
    const branchMap = new Map<string, string>();
    dbBranches.forEach((b) => branchMap.set(b.branchCode.trim().toUpperCase(), b.id));

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
      const branchCode = String(row['Branch Code'] || row.BRANCH_CODE || row.BranchCode || '').trim().toUpperCase();
      const name = String(row['Customer Name'] || row.CUSTOMER_NAME || row.Name || 'Unknown Customer').trim();
      const packets = parseInt(String(row.Packets || row.PACKET_COUNT || 1), 10) || 1;

      if (!acc) continue;

      if (accountSet.has(acc)) {
        duplicateAccounts++;
      } else {
        accountSet.add(acc);
      }

      const branchId = branchMap.get(branchCode) || null;
      if (!branchId && branchCode) {
        unmappedBranchCodes++;
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

    const isBlocked = duplicateAccounts > 50 || unmappedBranchCodes > 10;
    const status = isBlocked ? CustomerMasterStatus.REJECTED : CustomerMasterStatus.RECONCILED;

    return this.dataSource.transaction(async (manager) => {
      const versionEntity = manager.create(CustomerMasterVersionEntity, {
        projectId,
        versionNumber: nextVersionNumber,
        fileName,
        filePath,
        totalRows,
        uniqueAccounts: accountSet.size,
        duplicateAccounts,
        status,
        createdBy: userId,
        updatedBy: userId,
      });

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
      });

      return {
        versionId: savedVersion.id,
        projectId,
        versionNumber: nextVersionNumber,
        totalRowsProcessed: totalRows,
        uniqueAccountsCount: accountSet.size,
        duplicateAccountsCount: duplicateAccounts,
        unmappedBranchCodesCount: unmappedBranchCodes,
        status,
        recommendation: isBlocked
          ? 'Reconciliation Rejected: Exceeds duplicate account or unmapped branch threshold.'
          : 'Reconciliation Passed: Version created and records mapped cleanly.',
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
      });

      return saved;
    });
  }

  async findByProject(projectId: string): Promise<CustomerMasterVersionEntity[]> {
    return this.versionRepository.find({
      where: { projectId, isActive: true },
      order: { versionNumber: 'DESC' },
    });
  }

  async findRecords(versionId: string, page = 1, limit = 50): Promise<{ records: CustomerRecordEntity[]; total: number }> {
    const [records, total] = await this.recordRepository.findAndCount({
      where: { customerMasterVersionId: versionId, isActive: true },
      relations: ['branch'],
      take: limit,
      skip: (page - 1) * limit,
    });
    return { records, total };
  }
}
