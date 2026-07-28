import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ValidationQueryEntity } from './validation-query.entity';
import { ValidationCaseEntity } from '../validation/validation-case.entity';
import { ValidationQueryStatus, EventCategory } from '@fapoms/shared';
import { AuditService } from '../../core/audit/audit.service';

export interface CreateValidationQueryDto {
  validationCaseId: string;
  assayerId: string;
  queryText: string;
  targetField?: string;
  slaHours?: number;
}

@Injectable()
export class ValidationQueryService {
  constructor(
    @InjectRepository(ValidationQueryEntity)
    private readonly queryRepository: Repository<ValidationQueryEntity>,
    @InjectRepository(ValidationCaseEntity)
    private readonly validationCaseRepository: Repository<ValidationCaseEntity>,
    private readonly auditService: AuditService,
  ) {}

  async createQuery(dto: CreateValidationQueryDto, userId: string): Promise<ValidationQueryEntity> {
    const valCase = await this.validationCaseRepository.findOne({ where: { id: dto.validationCaseId, isActive: true } });
    if (!valCase) throw new NotFoundException(`ValidationCase ${dto.validationCaseId} not found.`);

    const slaHours = dto.slaHours || 4;
    const slaDueDate = new Date();
    slaDueDate.setHours(slaDueDate.getHours() + slaHours);

    const query = this.queryRepository.create({
      validationCaseId: dto.validationCaseId,
      assayerId: dto.assayerId,
      queryText: dto.queryText,
      targetField: dto.targetField ?? null,
      status: ValidationQueryStatus.OPEN,
      slaDueDate,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.queryRepository.save(query);

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'VALIDATION_QUERY_RAISED',
      entityType: 'VALIDATION_QUERY',
      entityId: saved.id,
      userId,
      remarks: `Raised query to assayer ${dto.assayerId}: "${dto.queryText}"`,
    });

    return saved;
  }

  async respondToQuery(queryId: string, assayerResponse: string, userId: string): Promise<ValidationQueryEntity> {
    const query = await this.queryRepository.findOne({ where: { id: queryId, isActive: true } });
    if (!query) throw new NotFoundException(`ValidationQuery ${queryId} not found.`);

    if (query.status !== ValidationQueryStatus.OPEN) {
      throw new BadRequestException(`Cannot respond to query in status ${query.status}.`);
    }

    query.assayerResponse = assayerResponse;
    query.respondedAt = new Date();
    query.status = ValidationQueryStatus.RESPONDED;
    query.updatedBy = userId;

    const saved = await this.queryRepository.save(query);

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'VALIDATION_QUERY_RESPONDED',
      entityType: 'VALIDATION_QUERY',
      entityId: saved.id,
      userId,
      remarks: `Assayer responded to query ${queryId}: "${assayerResponse}"`,
    });

    return saved;
  }

  async resolveQuery(queryId: string, userId: string): Promise<ValidationQueryEntity> {
    const query = await this.queryRepository.findOne({ where: { id: queryId, isActive: true } });
    if (!query) throw new NotFoundException(`ValidationQuery ${queryId} not found.`);

    query.status = ValidationQueryStatus.RESOLVED;
    query.updatedBy = userId;

    const saved = await this.queryRepository.save(query);

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'VALIDATION_QUERY_RESOLVED',
      entityType: 'VALIDATION_QUERY',
      entityId: saved.id,
      userId,
      remarks: `Validator marked query ${queryId} as RESOLVED.`,
    });

    return saved;
  }

  async countOpenQueries(validationCaseId: string): Promise<number> {
    return this.queryRepository.count({
      where: {
        validationCaseId,
        status: ValidationQueryStatus.OPEN,
        isActive: true,
      },
    });
  }

  async findByValidationCase(validationCaseId: string): Promise<ValidationQueryEntity[]> {
    return this.queryRepository.find({
      where: { validationCaseId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  async findByAssayer(assayerId: string): Promise<ValidationQueryEntity[]> {
    return this.queryRepository.find({
      where: { assayerId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }
}
