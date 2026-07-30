import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ValidationQueryEntity } from './validation-query.entity';
import { ValidationCaseEntity } from '../validation/validation-case.entity';
import { ValidationQueryStatus, EventCategory } from '@fapoms/shared';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

import { AssignmentEntity } from '../assignment/assignment.entity';

import { NotificationService } from '../notifications/notification.service';
import { PushNotificationService } from '../notifications/push-notification.service';

export interface CreateValidationQueryDto {
  validationCaseId: string;
  assayerId?: string;
  queryText: string;
  targetField?: string;
  slaHours?: number;
  attachments?: { url: string; fileName: string; fileType: string; uploadedBy: string; timestamp: string }[];
}

@Injectable()
export class ValidationQueryService {
  constructor(
    @InjectRepository(ValidationQueryEntity)
    private readonly queryRepository: Repository<ValidationQueryEntity>,
    @InjectRepository(ValidationCaseEntity)
    private readonly validationCaseRepository: Repository<ValidationCaseEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly notificationService: NotificationService,
    private readonly pushNotificationService: PushNotificationService,
  ) {}

  async createQuery(dto: CreateValidationQueryDto, userId: string): Promise<ValidationQueryEntity> {
    const valCase = await this.validationCaseRepository.findOne({ where: { id: dto.validationCaseId, isActive: true } });
    if (!valCase) throw new NotFoundException(`ValidationCase ${dto.validationCaseId} not found.`);

    let resolvedAssayerId = dto.assayerId;
    if (!resolvedAssayerId || resolvedAssayerId === '00000000-0000-0000-0000-000000000000') {
      const assignment = await this.assignmentRepository.findOne({
        where: { projectBranchId: valCase.projectBranchId, isActive: true },
        order: { createdAt: 'DESC' },
      });
      if (assignment?.assayerId) {
        resolvedAssayerId = assignment.assayerId;
      }
    }

    if (!resolvedAssayerId) {
      throw new BadRequestException(`No active assayer assigned to project branch for validation case ${dto.validationCaseId}.`);
    }

    const slaHours = dto.slaHours || 4;
    const slaDueDate = new Date();
    slaDueDate.setHours(slaDueDate.getHours() + slaHours);

    const rawAttachments = (dto.attachments || []).flat(Infinity).filter((a: any) => a && a.url);

    const query = this.queryRepository.create({
      validationCaseId: dto.validationCaseId,
      assayerId: resolvedAssayerId,
      queryText: dto.queryText,
      targetField: dto.targetField ?? null,
      attachments: rawAttachments.length > 0 ? rawAttachments : null,
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

    // Create persistent text & push notification for the Assayer
    try {
      await this.notificationService.create({
        userId: resolvedAssayerId,
        title: '❓ New Clarification Query Raised',
        message: `Data Entry Team: "${dto.queryText.slice(0, 100)}${dto.queryText.length > 100 ? '...' : ''}"`,
      }, userId);

      await this.pushNotificationService.sendToUser(
        resolvedAssayerId,
        '❓ New Clarification Query Raised',
        `Data Entry Team: "${dto.queryText.slice(0, 80)}"`,
        { queryId: saved.id, validationCaseId: saved.validationCaseId },
      );
    } catch (err) {
      console.error('Failed to create/send notification for raised query:', err);
    }

    try {
      this.eventPublisher.publish('query:raised', {
        eventType: 'query:raised',
        queryId: saved.id,
        validationCaseId: saved.validationCaseId,
        assayerId: resolvedAssayerId,
        validatorId: (valCase as any).reviewerId || userId,
        organizationId: (valCase as any).organizationId,
        queryText: dto.queryText,
        targetField: dto.targetField,
        attachments: dto.attachments,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish query:raised event:', err);
    }

    return saved;
  }

  async respondToQuery(queryId: string, assayerResponse: string, userId: string, attachments?: any[]): Promise<ValidationQueryEntity> {
    const query = await this.queryRepository.findOne({ where: { id: queryId, isActive: true } });
    if (!query) throw new NotFoundException(`ValidationQuery ${queryId} not found.`);

    if (query.status !== ValidationQueryStatus.OPEN && query.status !== ValidationQueryStatus.RESPONDED) {
      throw new BadRequestException(`Cannot respond to query in status ${query.status}.`);
    }

    // Append new response as a timestamped chat message if text exists, preserving conversation history
    if (assayerResponse && assayerResponse.trim().length > 0) {
      const timestamp = new Date().toISOString();
      const newMessage = `[${timestamp}] ${assayerResponse.trim()}`;
      query.assayerResponse = query.assayerResponse
        ? `${query.assayerResponse}\n${newMessage}`
        : newMessage;
    }
    query.respondedAt = new Date();
    query.status = ValidationQueryStatus.RESPONDED;
    if (attachments && attachments.length > 0) {
      const existing = (Array.isArray(query.attachments) ? query.attachments : []).flat(Infinity).filter((a: any) => a && a.url);
      const incoming = attachments.flat(Infinity).filter((a: any) => a && a.url);
      query.attachments = [...existing, ...incoming];
      console.log(`[respondToQuery] Saved ${incoming.length} attachments for query ${queryId}`);
    } else {
      console.log(`[respondToQuery] No attachments received for query ${queryId} (attachments=${JSON.stringify(attachments)})`);
    }
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

    try {
      this.eventPublisher.publish('query:responded', {
        eventType: 'query:responded',
        queryId: saved.id,
        validationCaseId: saved.validationCaseId,
        assayerId: query.assayerId,
        validatorId: (query as any).validatorId || userId,
        assayerResponse,
        attachments: saved.attachments,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish query:responded event:', err);
    }

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

    try {
      this.eventPublisher.publish('query:responded', {
        eventType: 'query:responded',
        queryId: saved.id,
        validationCaseId: saved.validationCaseId,
        assayerId: query.assayerId,
        validatorId: userId,
        status: saved.status,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish query:responded event:', err);
    }

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
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assayerId);
    if (!assayerId || !isUuid) {
      return this.queryRepository.find({
        where: { isActive: true },
        order: { createdAt: 'DESC' },
      });
    }
    return this.queryRepository.find({
      where: { assayerId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }
}
