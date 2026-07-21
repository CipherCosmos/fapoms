import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommunicationEntity } from './communication.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory, CommunicationType } from '@fapoms/shared';

export interface CreateCommunicationDto {
  assignmentId: string;
  type: CommunicationType;
  content: string;
  recipientRef?: string;
}

@Injectable()
export class CommunicationService {
  constructor(
    @InjectRepository(CommunicationEntity)
    private readonly communicationRepository: Repository<CommunicationEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreateCommunicationDto, userId: string): Promise<CommunicationEntity> {
    const assignment = await this.assignmentRepository.findOne({
      where: { id: dto.assignmentId, isActive: true },
    });

    if (!assignment) {
      throw new NotFoundException(`Assignment ${dto.assignmentId} not found.`);
    }

    const comm = this.communicationRepository.create({
      assignmentId: assignment.id,
      type: dto.type,
      content: dto.content,
      initiatedBy: userId,
      recipientRef: dto.recipientRef ?? null,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.communicationRepository.save(comm);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'COMMUNICATION_LOGGED',
      entityType: 'COMMUNICATION',
      entityId: saved.id,
      userId,
      remarks: `Logged ${dto.type} communication for assignment ${assignment.assignmentNumber}.`,
    });

    return saved;
  }

  async findByAssignment(assignmentId: string): Promise<CommunicationEntity[]> {
    return this.communicationRepository.find({
      where: { assignmentId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }
}
