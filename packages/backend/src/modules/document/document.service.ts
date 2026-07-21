import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentEntity } from './document.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory, DocumentStatus, DocumentType } from '@fapoms/shared';

export interface CreateDocumentDto {
  projectBranchId: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType?: string;
  type: DocumentType;
}

@Injectable()
export class DocumentService {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(ProjectBranchEntity)
    private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreateDocumentDto, userId: string): Promise<DocumentEntity> {
    const projectBranch = await this.projectBranchRepository.findOne({
      where: { id: dto.projectBranchId, isActive: true },
    });

    if (!projectBranch) {
      throw new NotFoundException(`ProjectBranch ${dto.projectBranchId} not found.`);
    }

    const doc = this.documentRepository.create({
      projectBranchId: projectBranch.id,
      fileName: dto.fileName,
      filePath: dto.filePath,
      fileSize: dto.fileSize,
      mimeType: dto.mimeType ?? null,
      type: dto.type,
      status: DocumentStatus.UPLOADED,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.documentRepository.save(doc);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'DOCUMENT_UPLOADED',
      entityType: 'DOCUMENT',
      entityId: saved.id,
      userId,
      remarks: `Uploaded document ${dto.fileName} for branch link.`,
    });

    return saved;
  }

  async findOne(id: string): Promise<DocumentEntity> {
    const doc = await this.documentRepository.findOne({
      where: { id, isActive: true },
      relations: ['projectBranch', 'projectBranch.branch'],
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found.`);
    }
    return doc;
  }

  async updateStatus(id: string, status: DocumentStatus, userId: string): Promise<DocumentEntity> {
    const doc = await this.findOne(id);
    const prevStatus = doc.status;
    doc.status = status;
    doc.updatedBy = userId;

    const saved = await this.documentRepository.save(doc);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: `DOCUMENT_${status}`,
      entityType: 'DOCUMENT',
      entityId: saved.id,
      previousState: prevStatus,
      newState: status,
      userId,
      remarks: `Transitioned document ${doc.fileName} to ${status}.`,
    });

    return saved;
  }

  async findByProjectBranch(projectBranchId: string): Promise<DocumentEntity[]> {
    return this.documentRepository.find({
      where: { projectBranchId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }
}
